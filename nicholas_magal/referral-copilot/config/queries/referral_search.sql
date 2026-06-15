-- @param careNeed STRING
-- @param location STRING
-- @param confidenceWeight INT
-- @param accessWeight INT
-- @param needWeight INT
-- @param limit INT
WITH inputs AS (
  SELECT
    LOWER(TRIM(:careNeed)) AS care_need,
    LOWER(TRIM(:location)) AS location_query,
    FILTER(
      SPLIT(REGEXP_REPLACE(LOWER(TRIM(:careNeed)), '[^a-z0-9 ]', ' '), '\\s+'),
      token -> LENGTH(token) >= 3
        AND NOT ARRAY_CONTAINS(
          ARRAY('the', 'and', 'for', 'with', 'patient', 'patients', 'need', 'needs', 'needed', 'require', 'requires', 'required'),
          token
        )
    ) AS care_tokens
),
facility_ids AS (
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
facility_names AS (
  SELECT
    unique_id AS facility_id,
    MAX_BY(COALESCE(canonical_name, name), silver_quality_score) AS name
  FROM medallion_architecture.silver.silver_facility_equipment_evidence
  WHERE COALESCE(canonical_name, name) IS NOT NULL
  GROUP BY unique_id
),
location AS (
  SELECT
    facility_id,
    MAX_BY(address_full, IF(is_primary_location, 1.0, 0.0) + COALESCE(geo_confidence_score, 0.0)) AS address_full,
    MAX_BY(city, IF(is_primary_location, 1.0, 0.0) + COALESCE(geo_confidence_score, 0.0)) AS city,
    MAX_BY(district, IF(is_primary_location, 1.0, 0.0) + COALESCE(geo_confidence_score, 0.0)) AS district_name,
    MAX_BY(state_region, IF(is_primary_location, 1.0, 0.0) + COALESCE(geo_confidence_score, 0.0)) AS state_name,
    MAX_BY(postal_code, IF(is_primary_location, 1.0, 0.0) + COALESCE(geo_confidence_score, 0.0)) AS postal_code,
    MAX_BY(latitude, IF(is_primary_location, 1.0, 0.0) + COALESCE(geo_confidence_score, 0.0)) AS latitude,
    MAX_BY(longitude, IF(is_primary_location, 1.0, 0.0) + COALESCE(geo_confidence_score, 0.0)) AS longitude,
    MAX(COALESCE(geo_confidence_score, 0.0)) AS location_confidence_score,
    MAX(last_verified_at) AS location_last_verified_at,
    ARRAY_JOIN(SORT_ARRAY(ARRAY_DISTINCT(FLATTEN(COLLECT_LIST(location_quality_flags)))), ', ') AS location_quality_flags
  FROM medallion_architecture.gold.gold_facility_location
  GROUP BY facility_id
),
contact AS (
  SELECT
    facility_id,
    COALESCE(
      MAX_BY(
        CASE WHEN LOWER(contact_type) IN ('phone', 'official_phone') THEN contact_value END,
        IF(is_primary, 2.0, 0.0) + IF(is_official, 1.0, 0.0) + COALESCE(confidence_score, 0.0)
      ),
      MAX(CASE WHEN LOWER(contact_type) IN ('phone', 'official_phone') THEN contact_value END)
    ) AS official_phone,
    COALESCE(
      MAX_BY(
        CASE WHEN LOWER(contact_type) IN ('website', 'official_website') THEN contact_value END,
        IF(is_primary, 2.0, 0.0) + IF(is_official, 1.0, 0.0) + COALESCE(confidence_score, 0.0)
      ),
      MAX(CASE WHEN LOWER(contact_type) IN ('website', 'official_website') THEN contact_value END)
    ) AS official_website,
    MAX(COALESCE(confidence_score, 0.0)) AS contact_confidence_score,
    MAX(last_seen_at) AS contact_last_seen_at,
    ARRAY_JOIN(SORT_ARRAY(ARRAY_DISTINCT(FLATTEN(COLLECT_LIST(contact_quality_flags)))), ', ') AS contact_quality_flags
  FROM medallion_architecture.gold.gold_facility_contact
  GROUP BY facility_id
),
specialty AS (
  SELECT
    facility_id,
    ARRAY_JOIN(SLICE(SORT_ARRAY(COLLECT_SET(specialty_display_name)), 1, 20), ', ') AS evidence_specialties,
    ARRAY_JOIN(SLICE(SORT_ARRAY(COLLECT_SET(specialty_group)), 1, 12), ', ') AS specialty_groups,
    MAX(COALESCE(confidence_score, 0.0)) AS specialty_confidence_score,
    SUM(COALESCE(evidence_count, 0)) AS specialty_evidence_count,
    MAX(CASE WHEN is_center_of_excellence THEN 1 ELSE 0 END) AS center_of_excellence_count,
    MAX(CASE WHEN has_inpatient_support THEN 1 ELSE 0 END) AS inpatient_support_count,
    MAX(CASE WHEN has_outpatient_support THEN 1 ELSE 0 END) AS outpatient_support_count,
    MAX(last_seen_at) AS specialty_last_seen_at
  FROM medallion_architecture.gold.gold_facility_specialty
  GROUP BY facility_id
),
equipment AS (
  SELECT
    unique_id AS facility_id,
    ARRAY_JOIN(SLICE(SORT_ARRAY(COLLECT_SET(equipment_name)), 1, 30), ', ') AS evidence_equipment,
    ARRAY_JOIN(SLICE(SORT_ARRAY(COLLECT_SET(canonical_name)), 1, 5), ', ') AS equipment_facility_names,
    MAX(COALESCE(silver_quality_score, 0.0)) AS equipment_confidence_score,
    COUNT(*) AS equipment_evidence_count,
    ARRAY_JOIN(SLICE(SORT_ARRAY(COLLECT_SET(CAST(source_urls_norm AS STRING))), 1, 8), ', ') AS equipment_source_urls,
    MAX(silver_processed_at) AS equipment_last_seen_at
  FROM medallion_architecture.silver.silver_facility_equipment_evidence
  GROUP BY unique_id
),
facility_evidence AS (
  SELECT
    ids.facility_id,
    names.name,
    loc.city,
    loc.district_name,
    loc.state_name,
    loc.postal_code,
    loc.latitude,
    loc.longitude,
    contact.official_phone,
    contact.official_website,
    specialty.evidence_specialties,
    equipment.evidence_equipment,
    CONCAT_WS(
      ' | ',
      CASE WHEN specialty.evidence_specialties IS NOT NULL THEN CONCAT('Specialties: ', specialty.evidence_specialties) END,
      CASE WHEN specialty.specialty_groups IS NOT NULL THEN CONCAT('Specialty groups: ', specialty.specialty_groups) END,
      CASE WHEN equipment.evidence_equipment IS NOT NULL THEN CONCAT('Equipment: ', equipment.evidence_equipment) END,
      CASE WHEN loc.address_full IS NOT NULL THEN CONCAT('Location: ', loc.address_full) END,
      CASE WHEN contact.official_phone IS NOT NULL THEN CONCAT('Phone: ', contact.official_phone) END,
      CASE WHEN contact.official_website IS NOT NULL THEN CONCAT('Website: ', contact.official_website) END
    ) AS evidence_description,
    CONCAT_WS(
      ' | ',
      CASE WHEN specialty.center_of_excellence_count > 0 THEN 'Specialty center of excellence flag present' END,
      CASE WHEN specialty.inpatient_support_count > 0 THEN 'Inpatient specialty support flag present' END,
      CASE WHEN specialty.outpatient_support_count > 0 THEN 'Outpatient specialty support flag present' END,
      CASE WHEN equipment.equipment_evidence_count > 0 THEN CONCAT(equipment.equipment_evidence_count, ' equipment evidence rows') END,
      CASE WHEN specialty.specialty_evidence_count > 0 THEN CONCAT(specialty.specialty_evidence_count, ' specialty evidence rows') END
    ) AS evidence_capabilities,
    CONCAT_WS(
      ' | ',
      equipment.equipment_source_urls,
      CASE WHEN loc.location_quality_flags IS NOT NULL THEN CONCAT('location flags: ', loc.location_quality_flags) END,
      CASE WHEN contact.contact_quality_flags IS NOT NULL THEN CONCAT('contact flags: ', contact.contact_quality_flags) END
    ) AS evidence_source_urls,
    ROUND(
      100.0 * (
        COALESCE(specialty.specialty_confidence_score, 0.0) * 0.45
        + COALESCE(equipment.equipment_confidence_score, 0.0) * 0.35
        + COALESCE(contact.contact_confidence_score, 0.0) * 0.10
        + COALESCE(loc.location_confidence_score, 0.0) * 0.10
      ),
      1
    ) AS evidence_score,
    GREATEST(
      COALESCE(specialty.specialty_confidence_score, 0.0),
      COALESCE(equipment.equipment_confidence_score, 0.0),
      COALESCE(contact.contact_confidence_score, 0.0),
      COALESCE(loc.location_confidence_score, 0.0)
    ) AS max_confidence_score,
    COALESCE(specialty.specialty_evidence_count, 0) + COALESCE(equipment.equipment_evidence_count, 0) AS total_evidence_count,
    GREATEST(
      CAST(specialty.specialty_last_seen_at AS TIMESTAMP),
      equipment.equipment_last_seen_at,
      contact.contact_last_seen_at,
      loc.location_last_verified_at
    ) AS page_update_date
  FROM facility_ids ids
  LEFT JOIN facility_names names ON names.facility_id = ids.facility_id
  LEFT JOIN location loc ON loc.facility_id = ids.facility_id
  LEFT JOIN contact ON contact.facility_id = ids.facility_id
  LEFT JOIN specialty ON specialty.facility_id = ids.facility_id
  LEFT JOIN equipment ON equipment.facility_id = ids.facility_id
),
evidence AS (
  SELECT
    f.*,
    i.*,
    LOWER(CONCAT_WS(
      ' ',
      f.name,
      f.city,
      f.district_name,
      f.state_name,
      f.postal_code,
      f.evidence_description,
      f.evidence_specialties,
      f.evidence_equipment,
      f.evidence_capabilities
    )) AS evidence_search_text
  FROM facility_evidence f
  CROSS JOIN inputs i
),
matches AS (
  SELECT
    *,
    SIZE(FILTER(care_tokens, token -> evidence_search_text LIKE CONCAT('%', token, '%'))) AS matched_token_count,
    evidence_search_text LIKE CONCAT('%', care_need, '%') AS exact_phrase_match
  FROM evidence
),
scored AS (
  SELECT
    *,
    CASE
      WHEN SIZE(care_tokens) = 0 THEN 0
      ELSE ROUND(
        85.0 * matched_token_count / SIZE(care_tokens)
        + CASE WHEN exact_phrase_match THEN 15 ELSE 0 END,
        1
      )
    END AS capability_match_score,
    CASE
      WHEN location_query = '' THEN 50
      WHEN LOWER(COALESCE(postal_code, '')) = location_query THEN 100
      WHEN LOWER(COALESCE(city, '')) = location_query THEN 90
      WHEN LOWER(COALESCE(district_name, '')) = location_query THEN 85
      WHEN LOWER(COALESCE(state_name, '')) = location_query THEN 70
      WHEN LOWER(CONCAT_WS(' ', city, district_name, state_name, postal_code))
        LIKE CONCAT('%', location_query, '%') THEN 60
      ELSE 0
    END AS location_match_score
  FROM matches
),
ranked AS (
  SELECT
    *,
    ROUND(
      capability_match_score * 0.50
      + evidence_score * (:confidenceWeight / 100.0) * 0.35
      + location_match_score * (:accessWeight / 100.0) * 0.15
      + 0 * (:needWeight / 100.0),
      1
    ) AS referral_score
  FROM scored
  WHERE matched_token_count >= CASE
      WHEN SIZE(care_tokens) <= 2 THEN 1
      ELSE CEIL(SIZE(care_tokens) * 0.5)
    END
    AND (:location = '' OR location_match_score > 0)
)
SELECT
  facility_id,
  COALESCE(name, facility_id) AS name,
  CAST(NULL AS STRING) AS facility_type,
  CAST(NULL AS STRING) AS operator_type,
  city,
  district_name,
  state_name,
  postal_code,
  latitude,
  longitude,
  CAST(official_phone AS STRING) AS official_phone,
  CAST(official_website AS STRING) AS official_website,
  evidence_score,
  CASE
    WHEN max_confidence_score >= 0.90 AND total_evidence_count >= 5 THEN 'High'
    WHEN max_confidence_score >= 0.75 OR total_evidence_count >= 2 THEN 'Medium'
    ELSE 'Low'
  END AS evidence_confidence,
  CASE
    WHEN official_phone IS NOT NULL OR official_website IS NOT NULL THEN 'Contactable'
    ELSE 'Needs contact verification'
  END AS record_quality,
  capability_match_score,
  location_match_score,
  referral_score,
  CAST(NULL AS DOUBLE) AS district_need_score,
  false AS district_context_available,
  CAST(evidence_description AS STRING) AS evidence_description,
  CAST(evidence_specialties AS STRING) AS evidence_specialties,
  CAST(NULL AS STRING) AS evidence_procedures,
  CAST(evidence_equipment AS STRING) AS evidence_equipment,
  CAST(evidence_capabilities AS STRING) AS evidence_capabilities,
  CAST(evidence_source_urls AS STRING) AS evidence_source_urls,
  page_update_date
FROM ranked
ORDER BY referral_score DESC, evidence_score DESC, name
LIMIT :limit;
