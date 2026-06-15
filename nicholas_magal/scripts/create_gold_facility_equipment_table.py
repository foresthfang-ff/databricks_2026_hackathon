#!/usr/bin/env python3
"""Create the gold facility equipment table from silver facilities."""

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
DEFAULT_TARGET_TABLE = "gold_facility_equipment"

COLUMN_COMMENTS = {
    "facility_id": "Foreign key to gold_facility. Derived from silver.facilities.unique_id.",
    "equipment_code": "Standardized normalized equipment or infrastructure code.",
    "equipment_display_name": "User-facing equipment or infrastructure name.",
    "equipment_group": (
        "Broader group such as imaging, emergency, ICU, lab, surgery, fertility, "
        "dialysis, radiotherapy, cardiac, telemedicine, or other."
    ),
    "supports_procedure_code": "Procedure code that this equipment commonly supports, if applicable.",
    "confidence_score": "Confidence that the equipment exists at the facility.",
    "evidence_count": "Number of supporting equipment evidence items.",
    "last_seen_at": "Most recent date this equipment was observed.",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create medallion_architecture.gold.gold_facility_equipment from "
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
COMMENT {quote_string('Gold table of normalized medical equipment and infrastructure at each facility.')}
AS
WITH source AS (
  SELECT
    unique_id AS facility_id,
    equipment,
    capability,
    description,
    source_urls,
    recency_of_page_update,
    silver_ingested_at
  FROM {source_table}
  WHERE unique_id IS NOT NULL
    AND (
      (equipment IS NOT NULL AND length(trim(equipment)) > 0)
      OR (capability IS NOT NULL AND length(trim(capability)) > 0)
      OR (description IS NOT NULL AND length(trim(description)) > 0)
    )
),
direct_equipment_items AS (
  SELECT
    facility_id,
    trim(raw_equipment) AS raw_equipment,
    'direct_equipment' AS evidence_type,
    lower(
      concat_ws(
        ' ',
        raw_equipment,
        coalesce(capability, ''),
        coalesce(description, '')
      )
    ) AS context_text,
    lower(coalesce(source_urls, '')) AS source_urls_text,
    recency_of_page_update,
    silver_ingested_at
  FROM source
  LATERAL VIEW explode(
    coalesce(
      from_json(equipment, 'ARRAY<STRING>'),
      split(
        regexp_replace(regexp_replace(equipment, '^\\\\[|\\\\]$', ''), '["'']', ''),
        '\\\\s*,\\\\s*'
      )
    )
  ) exploded AS raw_equipment
  WHERE equipment IS NOT NULL
    AND length(trim(equipment)) > 0
),
context_equipment_items AS (
  SELECT
    facility_id,
    equipment_code AS raw_equipment,
    'context_signal' AS evidence_type,
    context_text,
    source_urls_text,
    recency_of_page_update,
    silver_ingested_at
  FROM (
    SELECT
      facility_id,
      lower(concat_ws(' ', coalesce(equipment, ''), coalesce(capability, ''), coalesce(description, ''))) AS context_text,
      lower(coalesce(source_urls, '')) AS source_urls_text,
      recency_of_page_update,
      silver_ingested_at
    FROM source
  ) context
  LATERAL VIEW explode(array(
    CASE WHEN context_text RLIKE '(^|[^a-z0-9])(mri|magnetic resonance)([^a-z0-9]|$)' THEN 'mri' END,
    CASE WHEN context_text RLIKE '(^|[^a-z0-9])(ct|computed tomography|cat scan)([^a-z0-9]|$)' THEN 'ct_scanner' END,
    CASE WHEN context_text RLIKE 'pet[- ]?ct|positron emission' THEN 'pet_ct' END,
    CASE WHEN context_text RLIKE 'x[- ]?ray|radiograph' THEN 'x_ray' END,
    CASE WHEN context_text RLIKE 'ultrasound|sonograph|doppler' THEN 'ultrasound' END,
    CASE WHEN context_text RLIKE 'mammograph' THEN 'mammography' END,
    CASE WHEN context_text RLIKE 'cath[ -]?lab|catheterization lab|catheterisation lab' THEN 'cath_lab' END,
    CASE WHEN context_text RLIKE 'linear accelerator|linac|brachytherapy|radiotherapy|radiation oncology' THEN 'radiotherapy_equipment' END,
    CASE WHEN context_text RLIKE 'dialysis|hemodialysis|haemodialysis' THEN 'dialysis_unit' END,
    CASE WHEN context_text RLIKE 'ivf|icsi|iui|embryology|blastocyst|fertility lab' THEN 'fertility_lab' END,
    CASE WHEN context_text RLIKE 'operation theatre|operating theatre|modular ot|surgical suite|operating room' THEN 'operation_theatre' END,
    CASE WHEN context_text RLIKE 'icu|intensive care|critical care|ccu|nicu|picu' THEN 'icu' END,
    CASE WHEN context_text RLIKE 'ventilator|mechanical ventilation' THEN 'ventilator' END,
    CASE WHEN context_text RLIKE 'emergency|trauma|ambulance|resuscitation' THEN 'emergency_infrastructure' END,
    CASE WHEN context_text RLIKE 'laboratory|pathology|microbiology|histopathology|blood bank|biochemistry' THEN 'laboratory' END,
    CASE WHEN context_text RLIKE 'endoscopy|bronchoscopy|colonoscopy|arthroscopy|laparoscopy' THEN 'endoscopy_suite' END,
    CASE WHEN context_text RLIKE 'robotic surgery|robotic system|da vinci' THEN 'robotic_surgery_system' END,
    CASE WHEN context_text RLIKE 'telemedicine|virtual consultation|remote consultation' THEN 'telemedicine_platform' END
  )) exploded AS equipment_code
  WHERE equipment_code IS NOT NULL
),
equipment_items AS (
  SELECT * FROM direct_equipment_items
  UNION ALL
  SELECT * FROM context_equipment_items
),
normalized AS (
  SELECT
    facility_id,
    raw_equipment,
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(raw_equipment, '([a-z0-9])([A-Z])', '$1_$2'),
          '[^A-Za-z0-9]+',
          '_'
        ),
        '^_+|_+$',
        ''
      )
    ) AS equipment_code,
    evidence_type,
    context_text,
    source_urls_text,
    recency_of_page_update,
    silver_ingested_at
  FROM equipment_items
  WHERE raw_equipment IS NOT NULL
    AND length(trim(raw_equipment)) > 0
),
canonical AS (
  SELECT
    facility_id,
    CASE
      WHEN equipment_code RLIKE '^(mri|magnetic_resonance.*)$' THEN 'mri'
      WHEN equipment_code RLIKE '^(ct|ct_scan|computed_tomography|cat_scan|ct_scanner)$' THEN 'ct_scanner'
      WHEN equipment_code RLIKE 'pet_ct|petct|positron_emission' THEN 'pet_ct'
      WHEN equipment_code RLIKE 'x_ray|xray|radiograph' THEN 'x_ray'
      WHEN equipment_code RLIKE 'ultrasound|sonograph|doppler' THEN 'ultrasound'
      WHEN equipment_code RLIKE 'mammograph' THEN 'mammography'
      WHEN equipment_code RLIKE 'cath_lab|catheterization_lab|catheterisation_lab' THEN 'cath_lab'
      WHEN equipment_code RLIKE 'linear_accelerator|linac|brachytherapy|radiotherapy|radiation_oncology' THEN 'radiotherapy_equipment'
      WHEN equipment_code RLIKE 'dialysis|hemodialysis|haemodialysis' THEN 'dialysis_unit'
      WHEN equipment_code RLIKE 'ivf|icsi|iui|embryology|blastocyst|fertility_lab' THEN 'fertility_lab'
      WHEN equipment_code RLIKE 'operation_theatre|operating_theatre|modular_ot|surgical_suite|operating_room' THEN 'operation_theatre'
      WHEN equipment_code RLIKE 'icu|intensive_care|critical_care|ccu|nicu|picu' THEN 'icu'
      WHEN equipment_code RLIKE 'ventilator|mechanical_ventilation' THEN 'ventilator'
      WHEN equipment_code RLIKE 'emergency|trauma|ambulance|resuscitation' THEN 'emergency_infrastructure'
      WHEN equipment_code RLIKE 'laboratory|pathology|microbiology|histopathology|blood_bank|biochemistry' THEN 'laboratory'
      WHEN equipment_code RLIKE 'endoscopy|bronchoscopy|colonoscopy|arthroscopy|laparoscopy' THEN 'endoscopy_suite'
      WHEN equipment_code RLIKE 'robotic_surgery|robotic_system|da_vinci' THEN 'robotic_surgery_system'
      WHEN equipment_code RLIKE 'telemedicine|virtual_consultation|remote_consultation' THEN 'telemedicine_platform'
      ELSE equipment_code
    END AS equipment_code,
    evidence_type,
    context_text,
    source_urls_text,
    recency_of_page_update,
    silver_ingested_at
  FROM normalized
  WHERE equipment_code IS NOT NULL
    AND length(equipment_code) > 0
    AND equipment_code NOT RLIKE '^(equipment|equipments|facility|facilities|infrastructure|services|available|yes|no|na|n_a)$'
),
enriched AS (
  SELECT
    facility_id,
    equipment_code,
    initcap(replace(equipment_code, '_', ' ')) AS equipment_display_name,
    CASE
      WHEN equipment_code RLIKE 'mri|ct_scanner|pet_ct|x_ray|ultrasound|mammography' THEN 'imaging'
      WHEN equipment_code RLIKE 'emergency|trauma|ambulance|resuscitation' THEN 'emergency'
      WHEN equipment_code RLIKE 'icu|ventilator|critical_care|ccu|nicu|picu' THEN 'ICU'
      WHEN equipment_code RLIKE 'laboratory|pathology|microbiology|histopathology|blood_bank|biochemistry' THEN 'lab'
      WHEN equipment_code RLIKE 'operation_theatre|endoscopy_suite|robotic_surgery|laparoscopy|arthroscopy' THEN 'surgery'
      WHEN equipment_code RLIKE 'fertility|ivf|icsi|iui|embryology' THEN 'fertility'
      WHEN equipment_code RLIKE 'dialysis|hemodialysis|haemodialysis' THEN 'dialysis'
      WHEN equipment_code RLIKE 'radiotherapy|linear_accelerator|linac|brachytherapy' THEN 'radiotherapy'
      WHEN equipment_code RLIKE 'cath_lab|cardiac|ecg|ekg|echo|tmt' THEN 'cardiac'
      WHEN equipment_code RLIKE 'telemedicine|virtual|remote' THEN 'telemedicine'
      ELSE 'other'
    END AS equipment_group,
    CASE
      WHEN equipment_code = 'mri' THEN 'mri_scan'
      WHEN equipment_code = 'ct_scanner' THEN 'ct_scan'
      WHEN equipment_code = 'pet_ct' THEN 'pet_ct_scan'
      WHEN equipment_code = 'x_ray' THEN 'x_ray'
      WHEN equipment_code = 'ultrasound' THEN 'ultrasound'
      WHEN equipment_code = 'mammography' THEN 'mammography'
      WHEN equipment_code = 'cath_lab' THEN 'cardiac_catheterization'
      WHEN equipment_code = 'radiotherapy_equipment' THEN 'radiotherapy'
      WHEN equipment_code = 'dialysis_unit' THEN 'dialysis'
      WHEN equipment_code = 'fertility_lab' THEN 'ivf'
      WHEN equipment_code = 'operation_theatre' THEN 'surgery'
      WHEN equipment_code = 'icu' THEN 'critical_care'
      WHEN equipment_code = 'ventilator' THEN 'mechanical_ventilation'
      WHEN equipment_code = 'emergency_infrastructure' THEN 'emergency_care'
      WHEN equipment_code = 'laboratory' THEN 'laboratory_testing'
      WHEN equipment_code = 'endoscopy_suite' THEN 'endoscopy'
      WHEN equipment_code = 'robotic_surgery_system' THEN 'robotic_surgery'
      WHEN equipment_code = 'telemedicine_platform' THEN 'telemedicine'
      ELSE NULL
    END AS supports_procedure_code,
    CASE
      WHEN context_text RLIKE 'no longer|not available|unavailable|suspended|closed|discontinued|removed|not functional|non functional' THEN 'contradicted'
      WHEN evidence_type = 'direct_equipment' AND source_urls_text RLIKE 'https?://' THEN 'verified'
      WHEN evidence_type = 'direct_equipment' THEN 'direct'
      WHEN source_urls_text RLIKE 'https?://' THEN 'inferred_verified'
      ELSE 'inferred'
    END AS verification_status,
    evidence_type,
    recency_of_page_update,
    silver_ingested_at
  FROM canonical
),
rolled_up AS (
  SELECT
    facility_id,
    equipment_code,
    max(equipment_display_name) AS equipment_display_name,
    max(equipment_group) AS equipment_group,
    max(supports_procedure_code) AS supports_procedure_code,
    count(*) AS evidence_count,
    CASE
      WHEN max(CASE WHEN verification_status = 'contradicted' THEN 1 ELSE 0 END) = 1 THEN 'contradicted'
      WHEN max(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END) = 1 THEN 'verified'
      WHEN max(CASE WHEN verification_status = 'direct' THEN 1 ELSE 0 END) = 1 THEN 'direct'
      WHEN max(CASE WHEN verification_status = 'inferred_verified' THEN 1 ELSE 0 END) = 1 THEN 'inferred_verified'
      ELSE 'inferred'
    END AS verification_status,
    max(CASE WHEN evidence_type = 'direct_equipment' THEN 1 ELSE 0 END) = 1 AS has_direct_equipment_evidence,
    coalesce(
      greatest(max(recency_of_page_update), to_date(max(silver_ingested_at))),
      max(recency_of_page_update),
      to_date(max(silver_ingested_at))
    ) AS last_seen_at
  FROM enriched
  GROUP BY facility_id, equipment_code
)
SELECT
  facility_id,
  equipment_code,
  equipment_display_name,
  equipment_group,
  supports_procedure_code,
  cast(
    CASE
      WHEN verification_status = 'contradicted' THEN 0.05
      ELSE least(
        0.98,
        0.35
          + least(evidence_count, 5) * 0.08
          + CASE WHEN has_direct_equipment_evidence THEN 0.16 ELSE 0.00 END
          + CASE WHEN verification_status IN ('verified', 'inferred_verified') THEN 0.16 ELSE 0.00 END
          + CASE WHEN equipment_group <> 'other' THEN 0.08 ELSE 0.00 END
          + CASE WHEN supports_procedure_code IS NOT NULL THEN 0.05 ELSE 0.00 END
          + CASE WHEN last_seen_at >= date_sub(current_date(), 540) THEN 0.06 ELSE 0.00 END
      )
    END AS DOUBLE
  ) AS confidence_score,
  cast(evidence_count AS INT) AS evidence_count,
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
