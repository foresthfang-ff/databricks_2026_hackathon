#!/usr/bin/env python3
"""Create the gold facility procedure table from silver facilities."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time


DEFAULT_PROFILE = "dbc-23f8f625-632f"
DEFAULT_CATALOG = "medallion_architecture"
DEFAULT_SOURCE_SCHEMA = "silver"
DEFAULT_SOURCE_TABLE = "facilities"
DEFAULT_TARGET_SCHEMA = "gold"
DEFAULT_TARGET_TABLE = "gold_facility_procedure"

COLUMN_COMMENTS = {
    "facility_id": "Foreign key to gold_facility. Derived from silver.facilities.unique_id.",
    "procedure_code": "Standardized normalized procedure, treatment, surgery, or diagnostic code.",
    "procedure_display_name": "User-facing procedure or treatment name.",
    "procedure_group": (
        "Broader group such as surgery, imaging, fertility, dialysis, chemotherapy, "
        "cardiac intervention, telemedicine, emergency, or other."
    ),
    "specialty_code": "Related specialty code inferred from direct procedure text and specialty context.",
    "care_setting": "Care setting: OPD, inpatient, emergency, surgery, diagnostic, telemedicine, or unknown.",
    "requires_special_equipment": "Boolean flag indicating whether equipment validation is needed.",
    "confidence_score": "Confidence that the facility performs this procedure.",
    "evidence_text_short": "Short text snippet summarizing supporting direct procedure evidence.",
    "verification_status": "Verified, inferred, needs review, or contradicted.",
    "last_seen_at": "Most recent date this procedure was observed.",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create medallion_architecture.gold.gold_facility_procedure from "
            "medallion_architecture.silver.facilities."
        )
    )
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--catalog", default=DEFAULT_CATALOG)
    parser.add_argument("--source-schema", default=DEFAULT_SOURCE_SCHEMA)
    parser.add_argument("--source-table", default=DEFAULT_SOURCE_TABLE)
    parser.add_argument("--target-schema", default=DEFAULT_TARGET_SCHEMA)
    parser.add_argument("--target-table", default=DEFAULT_TARGET_TABLE)
    parser.add_argument(
        "--warehouse-id",
        help="SQL warehouse ID to use. If omitted, the first available warehouse is used.",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace the target table if it already exists. This refreshes derived data.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print SQL without executing it.",
    )
    return parser.parse_args()


def quote_identifier(identifier: str) -> str:
    return f"`{identifier.replace('`', '``')}`"


def quote_name(*parts: str) -> str:
    return ".".join(quote_identifier(part) for part in parts)


def quote_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def build_create_table_sql(args: argparse.Namespace) -> str:
    source_table = quote_name(args.catalog, args.source_schema, args.source_table)
    target_table = quote_name(args.catalog, args.target_schema, args.target_table)
    create_mode = "CREATE OR REPLACE TABLE" if args.replace else "CREATE TABLE IF NOT EXISTS"

    return f"""
{create_mode} {target_table}
USING DELTA
COMMENT {quote_string('Gold table of normalized procedures performed by each facility.')}
AS
WITH source AS (
  SELECT
    unique_id AS facility_id,
    procedure,
    specialties,
    equipment,
    capability,
    description,
    source_urls,
    recency_of_page_update,
    silver_ingested_at
  FROM {source_table}
  WHERE unique_id IS NOT NULL
    AND procedure IS NOT NULL
    AND length(trim(procedure)) > 0
),
procedure_items AS (
  SELECT
    facility_id,
    trim(raw_procedure) AS raw_procedure,
    specialties,
    equipment,
    capability,
    description,
    source_urls,
    recency_of_page_update,
    silver_ingested_at
  FROM source
  LATERAL VIEW explode(
    coalesce(
      from_json(procedure, 'ARRAY<STRING>'),
      split(
        regexp_replace(regexp_replace(procedure, '^\\\\[|\\\\]$', ''), '["'']', ''),
        '\\\\s*,\\\\s*'
      )
    )
  ) exploded AS raw_procedure
),
normalized AS (
  SELECT
    facility_id,
    raw_procedure,
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(raw_procedure, '([a-z0-9])([A-Z])', '$1_$2'),
          '[^A-Za-z0-9]+',
          '_'
        ),
        '^_+|_+$',
        ''
      )
    ) AS procedure_code,
    lower(
      concat_ws(
        ' ',
        raw_procedure,
        coalesce(specialties, ''),
        coalesce(equipment, ''),
        coalesce(capability, ''),
        coalesce(description, '')
      )
    ) AS context_text,
    lower(coalesce(source_urls, '')) AS source_urls_text,
    recency_of_page_update,
    silver_ingested_at
  FROM procedure_items
  WHERE raw_procedure IS NOT NULL
    AND length(trim(raw_procedure)) > 0
),
enriched AS (
  SELECT
    facility_id,
    procedure_code,
    initcap(replace(procedure_code, '_', ' ')) AS procedure_display_name,
    raw_procedure,
    CASE
      WHEN procedure_code RLIKE 'angioplast|angiograph|catheter|cath_lab|tavi|valve|pacemaker|stent|coronary|echo|ecg|ekg|electrophysiology' THEN 'cardiac_intervention'
      WHEN procedure_code RLIKE 'dialysis|hemodialysis|haemodialysis|renal_replacement' THEN 'dialysis'
      WHEN procedure_code RLIKE 'chemo|radiation|radiotherapy|immunotherapy|oncolog|cancer|tumou?r' THEN 'chemotherapy'
      WHEN procedure_code RLIKE 'ivf|icsi|iui|fertility|embryo|egg_|blastocyst|reproductive|insemination' THEN 'fertility'
      WHEN procedure_code RLIKE 'mri|ct_|ct$|scan|x_ray|xray|ultrasound|doppler|pet_ct|mammography|radiograph|imaging|endoscopy|bronchoscopy|colonoscopy|diagnostic|biopsy|fnac|laboratory|culture|test' THEN 'imaging'
      WHEN procedure_code RLIKE 'surgery|surgical|replacement|repair|transplant|laparoscop|arthroscop|appendectomy|colectomy|hysterectomy|myomectomy|lobectomy|tracheostomy|hernia|reconstruction|implant|operation' THEN 'surgery'
      WHEN procedure_code RLIKE 'emergency|trauma|critical|resuscitation' THEN 'emergency'
      WHEN procedure_code RLIKE 'telemedicine|online|virtual|remote' THEN 'telemedicine'
      ELSE 'other'
    END AS procedure_group,
    CASE
      WHEN procedure_code RLIKE 'cardio|heart|angioplast|angiograph|coronary|cath|tavi|valve|pacemaker|stent|echo|ecg|ekg' THEN 'cardiology'
      WHEN procedure_code RLIKE 'oncolog|cancer|chemo|radiation|radiotherapy|tumou?r' THEN 'medical_oncology'
      WHEN procedure_code RLIKE 'pediatric|paediatric|neonat|childhood|new_born|newborn' THEN 'pediatrics'
      WHEN procedure_code RLIKE 'orthopedic|orthopaedic|knee|hip|joint|spine|fracture|arthroscop|shoulder|bone' THEN 'orthopedic_surgery'
      WHEN procedure_code RLIKE 'mri|ct_|ct$|scan|x_ray|xray|ultrasound|doppler|pet_ct|mammography|radiograph|imaging' THEN 'radiology'
      WHEN procedure_code RLIKE 'pathology|laboratory|culture|histopathology|microbiology|test' THEN 'pathology'
      WHEN procedure_code RLIKE 'ivf|icsi|iui|fertility|embryo|egg_|blastocyst|reproductive|gynecolog|obstetric|hysterectomy|myomectomy|pregnancy' THEN 'gynecology_and_obstetrics'
      WHEN procedure_code RLIKE 'dialysis|kidney|renal|nephro' THEN 'nephrology'
      WHEN procedure_code RLIKE 'urolog|prostate|urinary|cystoscopy|urethrotomy|bladder' THEN 'urology'
      WHEN procedure_code RLIKE 'dental|root_canal|orthodont|implant|tooth|teeth' THEN 'dentistry'
      WHEN procedure_code RLIKE 'ent|otolaryngology|cochlear|hearing' THEN 'otolaryngology'
      WHEN procedure_code RLIKE 'eye|ophthalm|cataract|retina' THEN 'ophthalmology'
      WHEN procedure_code RLIKE 'bronchoscopy|thoracoscopy|lung|pulmonary|sleep_stud|pft' THEN 'pulmonology'
      WHEN procedure_code RLIKE 'neuro|brain|epilepsy' THEN 'neurology'
      ELSE 'unknown'
    END AS specialty_code,
    CASE
      WHEN procedure_code RLIKE 'telemedicine|online|virtual|remote' OR context_text RLIKE 'telemedicine|online consultation|virtual consultation|remote consultation' THEN 'telemedicine'
      WHEN procedure_code RLIKE 'emergency|trauma|resuscitation' OR context_text RLIKE 'emergency|trauma|24x7|24/7|accident' THEN 'emergency'
      WHEN procedure_code RLIKE 'mri|ct_|ct$|scan|x_ray|xray|ultrasound|doppler|pet_ct|mammography|radiograph|imaging|diagnostic|biopsy|fnac|laboratory|culture|test|endoscopy|bronchoscopy|colonoscopy' THEN 'diagnostic'
      WHEN procedure_code RLIKE 'surgery|surgical|replacement|repair|transplant|laparoscop|arthroscop|appendectomy|colectomy|hysterectomy|myomectomy|lobectomy|tracheostomy|hernia|reconstruction|implant|operation' THEN 'surgery'
      WHEN context_text RLIKE 'inpatient|in-patient|admission|ward|icu|nicu|picu|ccu|bed' THEN 'inpatient'
      WHEN context_text RLIKE 'outpatient|out-patient|opd|clinic|consultation|appointment|day care|day-care|ambulatory' THEN 'OPD'
      ELSE 'unknown'
    END AS care_setting,
    CASE
      WHEN procedure_code RLIKE 'mri|ct_|ct$|scan|x_ray|xray|ultrasound|doppler|pet_ct|mammography|radiograph|imaging|dialysis|cath|angioplast|angiograph|tavi|pacemaker|stent|radiation|radiotherapy|ivf|icsi|iui|embryo|laparoscop|arthroscop|robotic|laser|endoscopy|bronchoscopy|thoracoscopy|colonoscopy|cochlear|ventilator|biopsy|fnac'
        OR context_text RLIKE 'equipment|machine|scanner|cath lab|operation theatre|operating theatre|modular ot|dialysis unit|linear accelerator|pet-ct|mri|ct scanner|x-ray|ultrasound|endoscope|bronchoscope|microscope|laser|robotic'
      THEN true
      ELSE false
    END AS requires_special_equipment,
    CASE
      WHEN context_text RLIKE 'no longer|not available|not offered|does not offer|unavailable|suspended|closed|discontinued' THEN 'contradicted'
      WHEN length(procedure_code) < 4
        OR procedure_code RLIKE '^(procedure|procedures|treatment|treatments|surgery|surgeries|medical_and_surgical_therapeutic_procedures)$'
      THEN 'needs review'
      WHEN source_urls_text RLIKE 'https?://'
        AND context_text NOT RLIKE 'no longer|not available|not offered|does not offer|unavailable|suspended|closed|discontinued'
      THEN 'verified'
      ELSE 'inferred'
    END AS verification_status,
    recency_of_page_update,
    silver_ingested_at
  FROM normalized
  WHERE procedure_code IS NOT NULL
    AND length(procedure_code) > 0
),
rolled_up AS (
  SELECT
    facility_id,
    procedure_code,
    max(procedure_display_name) AS procedure_display_name,
    max(procedure_group) AS procedure_group,
    max(specialty_code) AS specialty_code,
    max(care_setting) AS care_setting,
    max(CASE WHEN requires_special_equipment THEN 1 ELSE 0 END) = 1 AS requires_special_equipment,
    count(*) AS evidence_count,
    substring(min(raw_procedure), 1, 280) AS evidence_text_short,
    CASE
      WHEN max(CASE WHEN verification_status = 'contradicted' THEN 1 ELSE 0 END) = 1 THEN 'contradicted'
      WHEN max(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END) = 1 THEN 'verified'
      WHEN max(CASE WHEN verification_status = 'needs review' THEN 1 ELSE 0 END) = 1 THEN 'needs review'
      ELSE 'inferred'
    END AS verification_status,
    coalesce(
      greatest(max(recency_of_page_update), to_date(max(silver_ingested_at))),
      max(recency_of_page_update),
      to_date(max(silver_ingested_at))
    ) AS last_seen_at
  FROM enriched
  GROUP BY facility_id, procedure_code
)
SELECT
  facility_id,
  procedure_code,
  procedure_display_name,
  procedure_group,
  specialty_code,
  care_setting,
  requires_special_equipment,
  cast(
    CASE
      WHEN verification_status = 'contradicted' THEN 0.05
      WHEN verification_status = 'needs review' THEN least(0.55, 0.30 + least(evidence_count, 3) * 0.05)
      ELSE least(
        0.97,
        0.45
          + least(evidence_count, 5) * 0.07
          + CASE WHEN verification_status = 'verified' THEN 0.18 ELSE 0.00 END
          + CASE WHEN procedure_group <> 'other' THEN 0.08 ELSE 0.00 END
          + CASE WHEN care_setting <> 'unknown' THEN 0.06 ELSE 0.00 END
          + CASE WHEN requires_special_equipment THEN 0.04 ELSE 0.00 END
          + CASE WHEN last_seen_at >= date_sub(current_date(), 540) THEN 0.06 ELSE 0.00 END
      )
    END AS DOUBLE
  ) AS confidence_score,
  evidence_text_short,
  verification_status,
  last_seen_at
FROM rolled_up
""".strip()


def build_sql(args: argparse.Namespace) -> list[str]:
    schema_name = quote_name(args.catalog, args.target_schema)
    target_table = quote_name(args.catalog, args.target_schema, args.target_table)

    statements = [
        f"CREATE SCHEMA IF NOT EXISTS {schema_name}",
        build_create_table_sql(args),
    ]

    for column, comment in COLUMN_COMMENTS.items():
        statements.append(
            f"ALTER TABLE {target_table} ALTER COLUMN {quote_identifier(column)} "
            f"COMMENT {quote_string(comment)}"
        )

    return statements


def run_databricks_cli(profile: str, *args: str, json_body: dict | None = None) -> dict | list:
    command = ["databricks", "-p", profile, "-o", "json", *args]
    if json_body is not None:
        command.extend(["--json", json.dumps(json_body)])

    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            "Databricks CLI command failed:\n"
            f"{' '.join(command[:-1] if json_body is not None else command)}\n"
            f"{result.stderr.strip() or result.stdout.strip()}"
        )

    output = result.stdout.strip()
    return json.loads(output) if output else {}


def pick_warehouse_id(profile: str) -> str:
    warehouses = run_databricks_cli(profile, "warehouses", "list")
    if not warehouses:
        raise RuntimeError("No Databricks SQL warehouses are available in this workspace.")

    running = [warehouse for warehouse in warehouses if warehouse.get("state") == "RUNNING"]
    selected = running[0] if running else warehouses[0]

    warehouse_id = selected.get("id")
    if not warehouse_id:
        raise RuntimeError("Selected SQL warehouse does not have an ID.")
    return warehouse_id


def execute_statement(profile: str, warehouse_id: str, statement: str) -> None:
    response = run_databricks_cli(
        profile,
        "api",
        "post",
        "/api/2.0/sql/statements",
        json_body={
            "statement": statement,
            "warehouse_id": warehouse_id,
            "wait_timeout": "30s",
            "on_wait_timeout": "CONTINUE",
        },
    )

    statement_id = response.get("statement_id")
    status = response.get("status") or {}
    while status.get("state") in {"PENDING", "RUNNING"}:
        if not statement_id:
            raise RuntimeError(f"Statement did not return a statement_id: {response}")
        time.sleep(2)
        response = run_databricks_cli(
            profile,
            "api",
            "get",
            f"/api/2.0/sql/statements/{statement_id}",
        )
        status = response.get("status") or {}

    state = status.get("state")
    if state != "SUCCEEDED":
        error = status.get("error") or {}
        message = error.get("message", "")
        raise RuntimeError(f"SQL statement failed with state {state}: {message}\n{statement}")


def main() -> int:
    args = parse_args()
    statements = build_sql(args)

    if args.dry_run:
        print(";\n\n".join(statements) + ";")
        return 0

    try:
        current_user = run_databricks_cli(args.profile, "current-user", "me")
    except RuntimeError as error:
        print(f"Warning: could not verify Databricks current user: {error}", file=sys.stderr)
    else:
        user_name = (
            current_user.get("userName")
            or current_user.get("displayName")
            or current_user.get("id")
        )
        print(f"Authenticated to Databricks profile {args.profile} as {user_name}")

    warehouse_id = args.warehouse_id or pick_warehouse_id(args.profile)
    print(f"Using SQL warehouse {warehouse_id}")

    for statement in statements:
        first_line = statement.splitlines()[0]
        print(f"Executing: {first_line}")
        execute_statement(args.profile, warehouse_id, statement)

    full_table_name = f"{args.catalog}.{args.target_schema}.{args.target_table}"
    print(f"Created gold table and applied comments: {full_table_name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
