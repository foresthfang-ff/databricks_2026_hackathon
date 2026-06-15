#!/usr/bin/env python3
"""Create the empty India Post PIN code directory silver table."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_PROFILE = "dbc-23f8f625-632f"
DEFAULT_MODEL_PATH = Path("data/data_model_india_post_pincode_directory.yaml")
DEFAULT_CATALOG = "medallion_architecture"
DEFAULT_SCHEMA = "silver"
DEFAULT_TABLE = "india_post_pincode_directory"

TYPE_OVERRIDES = {
    "latitude": "DOUBLE",
    "longitude": "DOUBLE",
    # Keep PIN codes as strings so leading zeroes, if any, are preserved.
    "pincode": "STRING",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create medallion_architecture.silver.india_post_pincode_directory "
            "from the YAML data model and apply column comments."
        )
    )
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--model-path", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--catalog", default=DEFAULT_CATALOG)
    parser.add_argument("--schema", default=DEFAULT_SCHEMA)
    parser.add_argument("--table", default=DEFAULT_TABLE)
    parser.add_argument(
        "--warehouse-id",
        help="SQL warehouse ID to use. If omitted, the first available warehouse is used.",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace the table if it already exists. This drops existing data.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print SQL without executing it.",
    )
    return parser.parse_args()


def parse_column_descriptions(model_path: Path) -> dict[str, str]:
    """Parse the repo's simple data dictionary YAML without extra dependencies."""
    if not model_path.exists():
        raise FileNotFoundError(f"YAML model not found: {model_path}")

    column_pattern = re.compile(r"^  ([A-Za-z_][A-Za-z0-9_]*):\s*$")
    description_pattern = re.compile(r"^    description:\s*[>|]?\s*$")

    columns: dict[str, str] = {}
    current_column: str | None = None
    collecting_description = False
    description_lines: list[str] = []

    def flush_description() -> None:
        nonlocal description_lines
        if current_column and description_lines:
            columns[current_column] = " ".join(
                line.strip() for line in description_lines if line.strip()
            )
        description_lines = []

    for raw_line in model_path.read_text(encoding="utf-8").splitlines():
        column_match = column_pattern.match(raw_line)
        if column_match:
            flush_description()
            current_column = column_match.group(1)
            collecting_description = False
            continue

        if current_column and description_pattern.match(raw_line):
            collecting_description = True
            description_lines = []
            continue

        if collecting_description:
            if raw_line.startswith("      ") or not raw_line.strip():
                description_lines.append(raw_line)
                continue
            flush_description()
            collecting_description = False

    flush_description()

    if not columns:
        raise ValueError(f"No columns found in YAML model: {model_path}")
    return columns


def quote_identifier(identifier: str) -> str:
    return f"`{identifier.replace('`', '``')}`"


def quote_name(*parts: str) -> str:
    return ".".join(quote_identifier(part) for part in parts)


def quote_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def column_type(column: str) -> str:
    return TYPE_OVERRIDES.get(column, "STRING")


def build_sql(args: argparse.Namespace, columns: dict[str, str]) -> list[str]:
    schema_name = quote_name(args.catalog, args.schema)
    table_name = quote_name(args.catalog, args.schema, args.table)
    create_mode = "CREATE OR REPLACE TABLE" if args.replace else "CREATE TABLE IF NOT EXISTS"

    column_defs = []
    for name, description in columns.items():
        column_defs.append(
            f"  {quote_identifier(name)} {column_type(name)} COMMENT {quote_string(description)}"
        )

    statements = [
        f"CREATE SCHEMA IF NOT EXISTS {schema_name}",
        (
            f"{create_mode} {table_name} (\n"
            + ",\n".join(column_defs)
            + "\n)\n"
            + "USING DELTA\n"
            + f"COMMENT {quote_string('Empty silver table for the India Post PIN Code Directory.')}"
        ),
    ]

    # Keep comments synchronized when the table already exists.
    for name, description in columns.items():
        statements.append(
            f"ALTER TABLE {table_name} ALTER COLUMN {quote_identifier(name)} "
            f"COMMENT {quote_string(description)}"
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
    columns = parse_column_descriptions(args.model_path)
    statements = build_sql(args, columns)

    if args.dry_run:
        print(";\n\n".join(statements) + ";")
        return 0

    current_user = run_databricks_cli(args.profile, "current-user", "me")
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

    full_table_name = f"{args.catalog}.{args.schema}.{args.table}"
    print(f"Created empty table and applied comments: {full_table_name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
