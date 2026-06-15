Response received in 12.6 Seconds
For Track 3, keep the Gold layer extremely focused on:

fast retrieval
ranking
explainability
UI simplicity
You do NOT want a huge analytics table.

Final Recommended Gold Table

Table name: gold_referral_facilities

Granularity: ONE ROW = ONE FACILITY + ONE CAPABILITY

Example: If a hospital supports:

ICU
emergency
oncology
Then create 3 rows.

This is the correct design for search + ranking.

Final Gold Layer Columns

Identity

facility_id                STRING
facility_name              STRING
organization_type          STRING

Copy
Location

city                       STRING
district                   STRING
state                      STRING
pincode                    BIGINT
latitude                   DOUBLE
longitude                  DOUBLE
full_address               STRING

Copy
Capability Search

capability                 STRING
matched_keywords           ARRAY<STRING>

Copy
Trust & Ranking

trust_score                INT
trust_label                STRING
metadata_completeness      DOUBLE

Copy
Evidence

recommendation_reason      STRING
suspicious_flags           ARRAY<STRING>

Copy
Facility Metadata

website                    STRING
phone                      STRING
email                      STRING
number_doctors             STRING
capacity                   STRING

Copy
Raw Supporting Evidence

specialties                STRING
equipment                  STRING
description                STRING

Copy
Optional NFHS Context (VERY GOOD FOR DEMO)

district_health_risk       DOUBLE

Copy
This lets you say: “Recommended facilities in high-risk districts.”

Very strong demo enhancement.

Final Schema Summary

facility_id
facility_name
organization_type

city
district
state
pincode
latitude
longitude
full_address

capability
matched_keywords

trust_score
trust_label
metadata_completeness

recommendation_reason
suspicious_flags

website
phone
email
number_doctors
capacity

specialties
equipment
description

district_health_risk

Copy
How To Create the Gold Table

STEP 1 — Clean Facilities Table

CREATE OR REPLACE TEMP VIEW facilities_clean AS
SELECT
    unique_id AS facility_id,
    name AS facility_name,
    organization_type,

    LOWER(TRIM(address_city)) AS city,
    LOWER(TRIM(address_stateOrRegion)) AS state,

    CASE
        WHEN address_zipOrPostcode RLIKE '^[0-9]+$'
        THEN CAST(address_zipOrPostcode AS BIGINT)
        ELSE NULL
    END AS pincode,

    CONCAT_WS(
        ', ',
        address_line1,
        address_line2,
        address_line3
    ) AS full_address,

    latitude,
    longitude,

    specialties,
    equipment,
    description,
    capability,

    officialWebsite AS website,
    officialPhone AS phone,
    email,

    numberDoctors AS number_doctors,
    capacity,

    LOWER(CONCAT_WS(
        ' ',
        specialties,
        equipment,
        description,
        capability
    )) AS combined_text

FROM facilities;

Copy

Copy
STEP 2 — Join District Using Pincode

CREATE OR REPLACE TEMP VIEW facilities_geo AS
SELECT
    f.*,
    LOWER(TRIM(p.district)) AS district
FROM facilities_clean f
LEFT JOIN india_post_pincode_directory p
ON f.pincode = p.pincode;

Copy
STEP 3 — Optional NFHS Risk Aggregation

Create a simple district risk score.

Example:

anemia
low institutional births
You can simplify heavily.

CREATE OR REPLACE TEMP VIEW district_risk AS
SELECT
    LOWER(TRIM(district_name)) AS district,
    LOWER(TRIM(state_ut)) AS state,

    (
        COALESCE(
            CAST(`women age 15-49 years who are anaemic (%)` AS DOUBLE),
            0
        )
    ) AS district_health_risk

FROM nfhs_5_district_health_indicators;

Copy
If column names are messy: skip this section.

Not mandatory.

STEP 4 — Main PySpark Gold Table Creation

This is the important part.

from pyspark.sql import Row

CAPABILITYS = {
    "icu": ["icu", "critical care", "intensive care"],
    "emergency": ["emergency", "trauma", "urgent care"],
    "oncology": ["oncology", "cancer"],
    "nicu": ["nicu", "neonatal"],
    "dialysis": ["dialysis", "nephrology"],
    "maternity": ["maternity", "obstetrics", "delivery"]
}

df = spark.table("facilities_geo")

rows = []

for row in df.collect():

    text = row["combined_text"] or ""

    for capability, keywords in CAPABILITYS.items():

        matches = [k for k in keywords if k in text]

        if len(matches) > 0:

            score = 0

            # capability evidence
            score += len(matches) * 3

            # metadata quality
            if row["website"]:
                score += 2

            if row["phone"]:
                score += 1

            if row["latitude"] is not None:
                score += 1

            if row["number_doctors"]:
                score += 1

            if row["description"]:
                score += 1

            # metadata completeness
            filled_fields = 0

            fields = [
                row["website"],
                row["phone"],
                row["email"],
                row["description"],
                row["specialties"],
                row["equipment"],
                row["number_doctors"]
            ]

            filled_fields = sum([1 for f in fields if f])

            metadata_completeness = round(
                filled_fields / len(fields),
                2
            )

            # suspicious flags
            flags = []

            if not row["website"]:
                flags.append("Missing website")

            if not row["number_doctors"]:
                flags.append("Missing doctor count")

            if not row["description"]:
                flags.append("Sparse description")

            # trust label
            if score >= 10:
                trust_label = "Strong Evidence"
            elif score >= 6:
                trust_label = "Partial Evidence"
            else:
                trust_label = "Weak/Suspicious"

            recommendation_reason = (
                f"{capability.upper()} capability supported by "
                f"{', '.join(matches)}."
            )

            rows.append(Row(

                facility_id=row["facility_id"],
                facility_name=row["facility_name"],
                organization_type=row["organization_type"],

                city=row["city"],
                district=row["district"],
                state=row["state"],
                pincode=row["pincode"],

                latitude=row["latitude"],
                longitude=row["longitude"],
                full_address=row["full_address"],

                capability=capability,
                matched_keywords=matches,

                trust_score=score,
                trust_label=trust_label,
                metadata_completeness=metadata_completeness,

                recommendation_reason=recommendation_reason,
                suspicious_flags=flags,

                website=row["website"],
                phone=row["phone"],
                email=row["email"],

                number_doctors=row["number_doctors"],
                capacity=row["capacity"],

                specialties=row["specialties"],
                equipment=row["equipment"],
                description=row["description"]
            ))

gold_df = spark.createDataFrame(rows)

Copy

Copy
STEP 5 — Save Gold Table

gold_df.write.mode("overwrite").saveAsTable(
    "gold_referral_facilities"
)

Copy
STEP 6 — Example Query for App

SELECT
    facility_name,
    city,
    state,
    capability,
    trust_score,
    trust_label,
    recommendation_reason,
    suspicious_flags,
    website
FROM gold_referral_facilities
WHERE capability = 'dialysis'
AND city = 'jaipur'
ORDER BY trust_score DESC
LIMIT 10;
