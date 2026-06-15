WITH facility_ids AS (
  SELECT facility_id
  FROM medallion_architecture.gold.gold_facility_contact
  UNION
  SELECT facility_id
  FROM medallion_architecture.gold.gold_facility_location
  UNION
  SELECT facility_id
  FROM medallion_architecture.gold.gold_facility_specialty
  UNION
  SELECT unique_id AS facility_id
  FROM medallion_architecture.silver.silver_facility_equipment_evidence
),
contact AS (
  SELECT
    facility_id,
    MAX(COALESCE(confidence_score, 0.0)) AS contact_confidence_score,
    MAX(CASE WHEN LOWER(contact_type) IN ('phone', 'official_phone', 'website', 'official_website') THEN 1 ELSE 0 END) AS has_contact
  FROM medallion_architecture.gold.gold_facility_contact
  GROUP BY facility_id
),
location AS (
  SELECT
    facility_id,
    MAX(COALESCE(geo_confidence_score, 0.0)) AS location_confidence_score
  FROM medallion_architecture.gold.gold_facility_location
  GROUP BY facility_id
),
specialty AS (
  SELECT
    facility_id,
    MAX(COALESCE(confidence_score, 0.0)) AS specialty_confidence_score,
    SUM(COALESCE(evidence_count, 0)) AS specialty_evidence_count
  FROM medallion_architecture.gold.gold_facility_specialty
  GROUP BY facility_id
),
equipment AS (
  SELECT
    unique_id AS facility_id,
    MAX(COALESCE(silver_quality_score, 0.0)) AS equipment_confidence_score,
    COUNT(*) AS equipment_evidence_count
  FROM medallion_architecture.silver.silver_facility_equipment_evidence
  GROUP BY unique_id
),
scored AS (
  SELECT
    ids.facility_id,
    ROUND(
      100.0 * (
        COALESCE(specialty.specialty_confidence_score, 0.0) * 0.45
        + COALESCE(equipment.equipment_confidence_score, 0.0) * 0.35
        + COALESCE(contact.contact_confidence_score, 0.0) * 0.10
        + COALESCE(location.location_confidence_score, 0.0) * 0.10
      ),
      1
    ) AS evidence_score,
    GREATEST(
      COALESCE(specialty.specialty_confidence_score, 0.0),
      COALESCE(equipment.equipment_confidence_score, 0.0),
      COALESCE(contact.contact_confidence_score, 0.0),
      COALESCE(location.location_confidence_score, 0.0)
    ) AS max_confidence_score,
    COALESCE(specialty.specialty_evidence_count, 0) + COALESCE(equipment.equipment_evidence_count, 0) AS total_evidence_count,
    COALESCE(contact.has_contact, 0) AS has_contact
  FROM facility_ids ids
  LEFT JOIN contact ON contact.facility_id = ids.facility_id
  LEFT JOIN location ON location.facility_id = ids.facility_id
  LEFT JOIN specialty ON specialty.facility_id = ids.facility_id
  LEFT JOIN equipment ON equipment.facility_id = ids.facility_id
)
SELECT
  COUNT(*) AS facility_count,
  COUNT_IF(max_confidence_score >= 0.90 AND total_evidence_count >= 5) AS high_confidence_count,
  COUNT_IF(has_contact = 1) AS contactable_count,
  0 AS district_context_count,
  ROUND(AVG(evidence_score), 1) AS average_evidence_score
FROM scored;
