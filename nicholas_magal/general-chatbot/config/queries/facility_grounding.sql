-- @param query STRING
-- @param resultLimit INT
WITH terms AS (
  SELECT explode(
    filter(
      split(regexp_replace(lower(:query), '[^a-z0-9]+', ' '), ' '),
      term -> length(term) >= 3
    )
  ) AS term
),
specialty_base AS (
  SELECT
    facility_id,
    concat_ws(', ', slice(sort_array(collect_set(specialty_display_name)), 1, 8)) AS specialties,
    max(confidence_score) AS specialty_confidence,
    sum(evidence_count) AS specialty_evidence_count,
    max(CASE WHEN is_center_of_excellence THEN 1 ELSE 0 END) AS has_center_of_excellence,
    max(CASE WHEN has_inpatient_support THEN 1 ELSE 0 END) AS has_inpatient_support,
    max(CASE WHEN has_outpatient_support THEN 1 ELSE 0 END) AS has_outpatient_support
  FROM medallion_architecture.gold.gold_facility_specialty
  GROUP BY facility_id
),
specialty_matches AS (
  SELECT
    fs.facility_id,
    count(t.term) AS specialty_match_count
  FROM medallion_architecture.gold.gold_facility_specialty fs
  LEFT JOIN terms t
    ON lower(concat_ws(' ', fs.specialty_display_name, fs.specialty_code, fs.specialty_group)) LIKE concat('%', t.term, '%')
  GROUP BY fs.facility_id
),
procedure_base AS (
  SELECT
    facility_id,
    concat_ws(', ', slice(sort_array(collect_set(procedure_display_name)), 1, 8)) AS procedures,
    max(confidence_score) AS procedure_confidence,
    max(CASE WHEN requires_special_equipment THEN 1 ELSE 0 END) AS requires_special_equipment
  FROM medallion_architecture.gold.gold_facility_procedure
  GROUP BY facility_id
),
procedure_matches AS (
  SELECT
    fp.facility_id,
    count(t.term) AS procedure_match_count
  FROM medallion_architecture.gold.gold_facility_procedure fp
  LEFT JOIN terms t
    ON lower(concat_ws(' ', fp.procedure_display_name, fp.procedure_code, fp.procedure_group, fp.specialty_code, fp.care_setting, fp.evidence_text_short)) LIKE concat('%', t.term, '%')
  GROUP BY fp.facility_id
),
contact AS (
  SELECT
    facility_id,
    concat_ws(', ', slice(sort_array(collect_set(contact_value)), 1, 4)) AS contacts,
    max(confidence_score) AS contact_confidence
  FROM medallion_architecture.gold.gold_facility_contact
  WHERE is_primary = true OR is_official = true
  GROUP BY facility_id
),
facility_matches AS (
  SELECT
    f.facility_id,
    count(t.term) AS facility_match_count
  FROM medallion_architecture.gold.gold_facility f
  LEFT JOIN medallion_architecture.gold.gold_facility_location l
    ON f.facility_id = l.facility_id
    AND l.is_primary_location = true
  LEFT JOIN contact c
    ON f.facility_id = c.facility_id
  LEFT JOIN terms t
    ON lower(concat_ws(' ', f.canonical_name, f.facility_type, f.operator_type, f.description_summary, l.city, l.state_region, l.postal_code, l.address_full, c.contacts)) LIKE concat('%', t.term, '%')
  GROUP BY f.facility_id
),
facility_base AS (
  SELECT
    f.facility_id,
    f.canonical_name,
    f.facility_type,
    f.operator_type,
    f.description_summary,
    f.status,
    f.gold_confidence_score,
    l.city,
    l.state_region,
    l.postal_code,
    l.address_full,
    c.contacts,
    sb.specialties,
    pb.procedures,
    coalesce(sb.specialty_confidence, 0.0) AS specialty_confidence,
    coalesce(pb.procedure_confidence, 0.0) AS procedure_confidence,
    coalesce(c.contact_confidence, 0.0) AS contact_confidence,
    coalesce(sb.specialty_evidence_count, 0) AS specialty_evidence_count,
    coalesce(sb.has_center_of_excellence, 0) AS has_center_of_excellence,
    coalesce(sb.has_inpatient_support, 0) AS has_inpatient_support,
    coalesce(sb.has_outpatient_support, 0) AS has_outpatient_support,
    coalesce(pb.requires_special_equipment, 0) AS requires_special_equipment,
    coalesce(fm.facility_match_count, 0) AS facility_match_count,
    coalesce(sm.specialty_match_count, 0) AS specialty_match_count,
    coalesce(pm.procedure_match_count, 0) AS procedure_match_count
  FROM medallion_architecture.gold.gold_facility f
  LEFT JOIN medallion_architecture.gold.gold_facility_location l
    ON f.facility_id = l.facility_id
    AND l.is_primary_location = true
  LEFT JOIN contact c
    ON f.facility_id = c.facility_id
  LEFT JOIN specialty_base sb
    ON f.facility_id = sb.facility_id
  LEFT JOIN specialty_matches sm
    ON f.facility_id = sm.facility_id
  LEFT JOIN procedure_base pb
    ON f.facility_id = pb.facility_id
  LEFT JOIN procedure_matches pm
    ON f.facility_id = pm.facility_id
  LEFT JOIN facility_matches fm
    ON f.facility_id = fm.facility_id
  WHERE f.canonical_name IS NOT NULL
    AND f.status = 'Active'
),
ranked AS (
  SELECT
    *,
    (
      facility_match_count * 3
      + specialty_match_count * 5
      + procedure_match_count * 5
      + gold_confidence_score
      + specialty_confidence
      + procedure_confidence
      + contact_confidence
    ) AS match_score
  FROM facility_base
)
SELECT
  facility_id,
  canonical_name,
  facility_type,
  operator_type,
  city,
  state_region,
  postal_code,
  address_full,
  contacts,
  specialties,
  procedures,
  gold_confidence_score,
  specialty_confidence,
  procedure_confidence,
  specialty_evidence_count,
  has_center_of_excellence,
  has_inpatient_support,
  has_outpatient_support,
  requires_special_equipment,
  match_score
FROM ranked
WHERE match_score > 0
ORDER BY match_score DESC, gold_confidence_score DESC, canonical_name ASC
LIMIT :resultLimit
