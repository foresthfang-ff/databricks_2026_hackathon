#!/usr/bin/env python3
"""Create the gold facility specialty table from silver facilities."""

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
DEFAULT_TARGET_TABLE = "gold_facility_specialty"

COLUMN_COMMENTS = {
    "facility_id": "Foreign key to gold_facility. Derived from silver.facilities.unique_id.",
    "specialty_code": "Standardized normalized specialty code.",
    "specialty_display_name": "User-facing specialty name.",
    "specialty_group": (
        "Broader clinical group such as cardiology, oncology, pediatrics, "
        "orthopedics, diagnostics, surgery, or other."
    ),
    "is_center_of_excellence": "Whether the facility is known for this specialty.",
    "has_inpatient_support": "Whether inpatient care is available for the specialty.",
    "has_outpatient_support": "Whether outpatient or OPD care is available for the specialty.",
    "confidence_score": "Confidence that the facility truly offers this specialty.",
    "evidence_count": "Number of supporting specialty evidence items.",
    "last_seen_at": "Most recent date this specialty was observed.",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create medallion_architecture.gold.gold_facility_specialty from "
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
COMMENT {quote_string('Gold table of normalized specialties offered by each facility.')}
AS
WITH source AS (
  SELECT
    unique_id AS facility_id,
    specialties,
    description,
    procedure,
    equipment,
    capability,
    recency_of_page_update,
    silver_ingested_at
  FROM {source_table}
  WHERE unique_id IS NOT NULL
    AND specialties IS NOT NULL
    AND length(trim(specialties)) > 0
),
specialty_items AS (
  SELECT
    facility_id,
    trim(raw_specialty) AS raw_specialty,
    concat_ws(
      ' ',
      coalesce(description, ''),
      coalesce(procedure, ''),
      coalesce(equipment, ''),
      coalesce(capability, '')
    ) AS evidence_text,
    recency_of_page_update,
    silver_ingested_at
  FROM source
  LATERAL VIEW explode(
    coalesce(
      from_json(specialties, 'ARRAY<STRING>'),
      split(
        regexp_replace(regexp_replace(specialties, '^\\\\[|\\\\]$', ''), '["'']', ''),
        '\\\\s*,\\\\s*'
      )
    )
  ) exploded AS raw_specialty
),
normalized AS (
  SELECT
    facility_id,
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(raw_specialty, '([a-z0-9])([A-Z])', '$1_$2'),
          '[^A-Za-z0-9]+',
          '_'
        ),
        '^_+|_+$',
        ''
      )
    ) AS specialty_code,
    lower(evidence_text) AS evidence_text,
    recency_of_page_update,
    silver_ingested_at
  FROM specialty_items
  WHERE raw_specialty IS NOT NULL
    AND length(trim(raw_specialty)) > 0
),
enriched AS (
  SELECT
    facility_id,
    specialty_code,
    initcap(replace(specialty_code, '_', ' ')) AS specialty_display_name,
    CASE
      WHEN specialty_code RLIKE 'cardio|heart|vascular' THEN 'cardiology'
      WHEN specialty_code RLIKE 'oncolog|cancer|hematology' THEN 'oncology'
      WHEN specialty_code RLIKE 'pediatric|paediatric|neonat|adolescent|maternal_and_child' THEN 'pediatrics'
      WHEN specialty_code RLIKE 'orthopedic|orthopaedic|joint|spine|sports_medicine|podiatr' THEN 'orthopedics'
      WHEN specialty_code RLIKE 'radiology|pathology|nuclear_medicine|imaging|diagnostic|laboratory' THEN 'diagnostics'
      WHEN specialty_code RLIKE 'surgery|surgical|transplant|urology|otolaryngology|ophthalmology' THEN 'surgery'
      WHEN specialty_code RLIKE 'gynecology|obstetrics|fertility|reproductive|maternal_fetal' THEN 'women_health'
      WHEN specialty_code RLIKE 'emergency|critical_care|intensive_care|anesthesia' THEN 'emergency_critical_care'
      WHEN specialty_code RLIKE 'psychiatry|psychology|behavioral|mental' THEN 'mental_health'
      WHEN specialty_code RLIKE 'rehabilitation|physical_medicine|pain_medicine' THEN 'rehabilitation'
      WHEN specialty_code RLIKE 'dentistry|dental|orthodontics|endodontics|prosthodontics' THEN 'dental'
      ELSE 'other'
    END AS specialty_group,
    CASE
      WHEN evidence_text RLIKE 'center of excellence|centre of excellence|centre for excellence'
        OR evidence_text RLIKE 'speciali[sz]ed center|speciali[sz]ed centre'
        OR evidence_text RLIKE 'super[- ]speciality|super[- ]specialty'
      THEN true
      ELSE false
    END AS is_center_of_excellence,
    CASE
      WHEN evidence_text RLIKE 'inpatient|in-patient|admission|indoor admission|hospitali[sz]ation'
        OR evidence_text RLIKE 'bed|ward|icu|nicu|picu|ccu|operation theatre|operating theatre'
      THEN true
      ELSE false
    END AS has_inpatient_support,
    CASE
      WHEN evidence_text RLIKE 'outpatient|out-patient|opd|clinic|consultation|appointment'
        OR evidence_text RLIKE 'day care|day-care|ambulatory'
      THEN true
      ELSE false
    END AS has_outpatient_support,
    recency_of_page_update,
    silver_ingested_at
  FROM normalized
  WHERE specialty_code IS NOT NULL
    AND length(specialty_code) > 0
),
rolled_up AS (
  SELECT
    facility_id,
    specialty_code,
    max(specialty_display_name) AS specialty_display_name,
    max(specialty_group) AS specialty_group,
    max(CASE WHEN is_center_of_excellence THEN 1 ELSE 0 END) = 1 AS is_center_of_excellence,
    max(CASE WHEN has_inpatient_support THEN 1 ELSE 0 END) = 1 AS has_inpatient_support,
    max(CASE WHEN has_outpatient_support THEN 1 ELSE 0 END) = 1 AS has_outpatient_support,
    count(*) AS evidence_count,
    coalesce(
      greatest(max(recency_of_page_update), to_date(max(silver_ingested_at))),
      max(recency_of_page_update),
      to_date(max(silver_ingested_at))
    ) AS last_seen_at
  FROM enriched
  GROUP BY facility_id, specialty_code
)
SELECT
  facility_id,
  specialty_code,
  specialty_display_name,
  specialty_group,
  is_center_of_excellence,
  has_inpatient_support,
  has_outpatient_support,
  cast(
    least(
      0.99,
      0.50
        + least(evidence_count, 5) * 0.08
        + CASE WHEN has_inpatient_support THEN 0.08 ELSE 0.00 END
        + CASE WHEN has_outpatient_support THEN 0.08 ELSE 0.00 END
        + CASE WHEN is_center_of_excellence THEN 0.10 ELSE 0.00 END
        + CASE WHEN last_seen_at >= date_sub(current_date(), 540) THEN 0.06 ELSE 0.00 END
    ) AS DOUBLE
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
