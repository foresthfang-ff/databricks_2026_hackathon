# Golden Table Design for Healthcare Facility Routing

## 1. Purpose

This golden table design turns the current silver-level facility dataset into a cleaner, trusted, and query-ready data model for healthcare facility recommendation and routing.

The end goal is to answer questions such as:

- Which facility can handle this patient need?
- Is the facility reachable and contactable?
- What services, procedures, equipment, and capabilities does the facility have?
- How confident are we in the answer?
- What should the coordinator verify next?

The design is organized into four major segments:

1. **Facility Identity & Location**
2. **Clinical Capability**
3. **Access, Contact & Operational Readiness**
4. **Evidence, Quality & Routing Intelligence**

---

# Segment 1: Facility Identity & Location

This segment answers: **What is this facility, and where is it located?**

It creates the trusted facility master record and resolves duplicate or conflicting facility records from multiple sources.

---

## 1.1 `gold_facility`

### Purpose

The main master table for each unique healthcare facility. One row represents one canonical facility.

### Grain

One row per unique facility.

### Recommended Columns

| Column | Description |
|---|---|
| `facility_id` | Stable internal golden facility ID. |
| `canonical_name` | Cleaned and standardized facility name. |
| `alternate_names` | Other names found across sources. |
| `organization_type` | Hospital, clinic, diagnostic center, medical college, chain, etc. |
| `facility_type` | Normalized facility type, such as multi-specialty hospital, specialty hospital, clinic, lab, eye hospital, dental clinic. |
| `operator_type` | Public, private, charitable, trust, government, corporate, NGO, academic, etc. |
| `is_public` | Boolean flag for public/government facility. |
| `is_private` | Boolean flag for private facility. |
| `is_academic` | Boolean flag for teaching hospital or medical college affiliation. |
| `description_summary` | Short cleaned facility description. |
| `status` | Active, inactive, closed, unknown, duplicate, needs review. |
| `gold_confidence_score` | Overall confidence in the golden identity record. |
| `last_verified_at` | Most recent date this facility identity was verified. |
| `data_quality_flags` | Array of issues such as duplicate candidate, missing address, conflicting type, weak source. |

### Source Columns Used

- `unique_id`
- `cluster_id`
- `name`
- `organization_type`
- `facility_type_id`
- `operator_type_id`
- `affiliation_type_ids`
- `description`
- `source_types`
- `source_ids`
- `source_content_id`

### Notes

This table should not keep every raw value. It should keep the best resolved value and push raw evidence into the evidence table.

---

## 1.2 `gold_facility_location`

### Purpose

Stores trusted physical location information for each facility.

A facility may have more than one location, especially hospital chains, branch clinics, labs, or multi-campus organizations.

### Grain

One row per facility location.

### Recommended Columns

| Column | Description |
|---|---|
| `location_id` | Stable internal location ID. |
| `facility_id` | Foreign key to `gold_facility`. |
| `address_full` | Best full address string. |
| `address_line_1` | Street or building-level address. |
| `address_line_2` | Additional address details. |
| `city` | City or locality. |
| `district` | District, county, or equivalent. |
| `state_region` | State, province, or region. |
| `postal_code` | Postal or ZIP code. |
| `country` | Country. |
| `latitude` | Best latitude. |
| `longitude` | Best longitude. |
| `geo_confidence_score` | Confidence in coordinates and address match. |
| `is_primary_location` | Whether this is the primary facility location. |
| `location_quality_flags` | Missing coordinates, conflicting coordinates, partial address, city mismatch, etc. |
| `last_verified_at` | Most recent verification date for this location. |

### Source Columns Used

- `address`
- `street`
- `city`
- `region`
- `postal_code`
- `country`
- `countries`
- `coordinates`
- `latitude`
- `longitude`
- `area`
- `source_urls`

### Notes

Latitude and longitude should be validated against address fields. If coordinates and address point to different cities or regions, the record should be flagged for review.

---

# Segment 2: Clinical Capability

This segment answers: **What care can this facility provide?**

It separates specialties, procedures, equipment, and capability flags so that patient-routing logic can match medical needs to the right facility.

---

## 2.1 `gold_facility_specialty`

### Purpose

Stores normalized specialties offered by each facility.

### Grain

One row per facility per normalized specialty.

### Recommended Columns

| Column | Description |
|---|---|
| `facility_id` | Foreign key to `gold_facility`. |
| `specialty_code` | Standardized specialty code. |
| `specialty_display_name` | User-facing specialty name. |
| `specialty_group` | Broader group such as cardiology, oncology, pediatrics, orthopedics, diagnostics. |
| `is_center_of_excellence` | Whether the facility is known for this specialty. |
| `has_inpatient_support` | Whether inpatient care is available for the specialty. |
| `has_outpatient_support` | Whether outpatient/OPD care is available for the specialty. |
| `confidence_score` | Confidence that the facility truly offers this specialty. |
| `evidence_count` | Number of supporting evidence items. |
| `last_seen_at` | Most recent date this specialty was observed. |

### Source Columns Used

- `specialties`
- `description`
- `capability`
- `source_urls`
- `recency_of_page_update`

### Notes

Raw specialty values should be mapped to a controlled taxonomy. For example, “Heart Care,” “Cardiac Sciences,” and “Cardiology” should map to a common cardiology specialty code.

---

## 2.2 `gold_facility_procedure`

### Purpose

Stores procedures, treatments, surgeries, and diagnostic services that the facility can perform.

### Grain

One row per facility per normalized procedure.

### Recommended Columns

| Column | Description |
|---|---|
| `facility_id` | Foreign key to `gold_facility`. |
| `procedure_code` | Standardized procedure code. |
| `procedure_display_name` | User-facing procedure or treatment name. |
| `procedure_group` | Broader group such as surgery, imaging, fertility, dialysis, chemotherapy, cardiac intervention. |
| `specialty_code` | Related specialty code. |
| `care_setting` | OPD, inpatient, emergency, surgery, diagnostic, telemedicine, unknown. |
| `requires_special_equipment` | Boolean flag indicating whether equipment validation is needed. |
| `confidence_score` | Confidence that the facility performs this procedure. |
| `evidence_text_short` | Short text snippet summarizing supporting evidence. |
| `verification_status` | Verified, inferred, needs review, contradicted. |
| `last_seen_at` | Most recent date this procedure was observed. |

### Source Columns Used

- `procedure`
- `specialties`
- `equipment`
- `capability`
- `description`
- `source_urls`
- `recency_of_page_update`

### Notes

Procedure data should be treated as more sensitive than specialty data. A facility may list cardiology as a specialty, but that does not necessarily mean it performs angioplasty, bypass surgery, or electrophysiology procedures. Procedures should have direct evidence where possible.

---

## 2.3 `gold_facility_equipment`

### Purpose

Stores medical equipment and infrastructure signals available at the facility.

### Grain

One row per facility per normalized equipment item.

### Recommended Columns

| Column | Description |
|---|---|
| `facility_id` | Foreign key to `gold_facility`. |
| `equipment_code` | Standardized equipment code. |
| `equipment_display_name` | User-facing equipment name. |
| `equipment_group` | Imaging, emergency, ICU, lab, surgery, fertility, dialysis, radiotherapy, etc. |
| `supports_procedure_code` | Procedure that the equipment supports, if applicable. |
| `confidence_score` | Confidence that the equipment exists at the facility. |
| `evidence_count` | Number of supporting evidence items. |
| `last_seen_at` | Most recent date this equipment was observed. |

### Source Columns Used

- `equipment`
- `capability`
- `description`
- `source_urls`
- `recency_of_page_update`

### Notes

Equipment can help validate procedures. For example, a claim of radiotherapy is stronger if the facility also has evidence for LINAC or radiation oncology infrastructure.

---

## 2.4 `taxonomy_specialty`

### Purpose

Reference table for normalizing raw specialty strings.

### Grain

One row per standardized specialty.

### Recommended Columns

| Column | Description |
|---|---|
| `specialty_code` | Stable specialty code. |
| `specialty_display_name` | Standard user-facing name. |
| `specialty_group` | Higher-level group. |
| `raw_aliases` | Known raw names and synonyms. |
| `patient_friendly_label` | Plain-language label for question flow. |
| `active_flag` | Whether this specialty is active in the taxonomy. |

---

## 2.5 `taxonomy_procedure`

### Purpose

Reference table for normalizing raw procedure and treatment strings.

### Grain

One row per standardized procedure.

### Recommended Columns

| Column | Description |
|---|---|
| `procedure_code` | Stable procedure code. |
| `procedure_display_name` | Standard procedure name. |
| `procedure_group` | Higher-level procedure group. |
| `specialty_code` | Related specialty. |
| `raw_aliases` | Known raw names and synonyms. |
| `patient_friendly_label` | Plain-language label for question flow. |
| `requires_equipment_code` | Equipment usually required for this procedure. |
| `active_flag` | Whether this procedure is active in the taxonomy. |

---

# Segment 3: Access, Contact & Operational Readiness

This segment answers: **Can the patient actually use this facility, and how should they contact it?**

It covers phones, websites, emails, access flags, capacity, emergency readiness, and practical routing constraints.

---

## 3.1 `gold_facility_contact`

### Purpose

Stores trusted contact methods for each facility.

### Grain

One row per facility per contact method.

### Recommended Columns

| Column | Description |
|---|---|
| `contact_id` | Stable internal contact ID. |
| `facility_id` | Foreign key to `gold_facility`. |
| `contact_type` | Phone, emergency phone, appointment phone, email, website, booking URL, WhatsApp, etc. |
| `contact_value` | Cleaned contact value. |
| `is_official` | Whether the contact came from an official source. |
| `is_primary` | Best contact to show first. |
| `department` | Department if contact is specific to emergency, OPD, billing, international desk, etc. |
| `source_rank` | Trust rank of the source. |
| `confidence_score` | Confidence in the contact value. |
| `last_seen_at` | Most recent date this contact was observed. |
| `contact_quality_flags` | Duplicate, invalid format, likely aggregator number, outdated, department unknown, etc. |

### Source Columns Used

- `phone_numbers`
- `official_phone`
- `email`
- `websites`
- `official_website`
- `facebook_link`
- `source_urls`

### Notes

`official_phone` and `official_website` should generally outrank generic arrays such as `phone_numbers` and `websites`. Raw arrays should be deduplicated and validated.

---

## 3.2 `gold_facility_access`

### Purpose

Stores access and operational-readiness attributes used for routing and filtering.

### Grain

One row per facility.

### Recommended Columns

| Column | Description |
|---|---|
| `facility_id` | Foreign key to `gold_facility`. |
| `has_24_7_emergency` | Whether emergency care appears available 24/7. |
| `has_ambulance` | Whether ambulance service is available. |
| `has_icu` | Whether ICU or critical care is available. |
| `has_blood_bank` | Whether blood bank support is available. |
| `has_operation_theatre` | Whether surgery infrastructure is available. |
| `has_inpatient` | Whether inpatient admission is available. |
| `has_outpatient` | Whether OPD/outpatient care is available. |
| `bed_capacity` | Number of beds, if available. |
| `doctor_count` | Number of doctors, if available. |
| `accepts_volunteers` | Volunteer acceptance flag, if relevant. |
| `accepts_insurance` | Whether insurance is accepted. |
| `insurance_networks` | Known insurance or cashless networks. |
| `accepts_international_patients` | Whether international patient support exists. |
| `has_telemedicine` | Whether telemedicine is available. |
| `has_online_booking` | Whether online booking is available. |
| `accessibility_features` | Wheelchair access, accessible parking, etc. |
| `cashless_available` | Whether cashless payment appears available. |
| `confidence_score` | Confidence in operational-readiness attributes. |
| `last_verified_at` | Most recent verification date. |

### Source Columns Used

- `capacity`
- `number_doctors`
- `accepts_volunteers`
- `capability`
- `equipment`
- `procedure`
- `description`
- `websites`
- `official_website`
- `source_urls`

### Notes

Emergency-related fields should not be inferred too aggressively. For example, a facility being a hospital does not automatically mean it has 24/7 emergency, ICU, ambulance, or blood bank support.

---

# Segment 4: Evidence, Quality & Routing Intelligence

This segment answers: **Why do we believe this, how confident are we, and how should the system rank facilities?**

It preserves provenance, supports auditability, and enables patient-question-to-facility matching.

---

## 4.1 `facility_evidence`

### Purpose

Stores raw and normalized evidence behind each golden attribute.

This table allows users and data teams to trace a golden value back to its source.

### Grain

One row per facility per attribute per evidence item.

### Recommended Columns

| Column | Description |
|---|---|
| `evidence_id` | Stable evidence ID. |
| `facility_id` | Foreign key to `gold_facility`. |
| `attribute_name` | Attribute supported by this evidence, such as specialty, phone, address, procedure, equipment. |
| `raw_value` | Raw extracted value. |
| `normalized_value` | Normalized value used in gold table, if applicable. |
| `source_url` | URL where evidence was found. |
| `source_type` | Official website, government source, directory, aggregator, social, journal, etc. |
| `source_table` | Silver source table name. |
| `source_content_id` | Source content identifier. |
| `extraction_method` | Scrape, LLM extraction, regex, manual, API, vendor feed, etc. |
| `evidence_date` | Date evidence was published or updated, if known. |
| `ingested_at` | Date evidence entered the silver layer. |
| `confidence_score` | Confidence in this evidence item. |
| `is_used_in_gold` | Whether this evidence was selected for the golden value. |
| `rejection_reason` | Why evidence was not used, if rejected. |

### Source Columns Used

- `source_types`
- `source_ids`
- `source_content_id`
- `source_urls`
- `source`
- `silver_ingested_at`
- `silver_source_table`
- `recency_of_page_update`
- All raw attribute fields used to populate gold tables.

### Notes

This is one of the most important tables. It prevents the gold layer from becoming a black box and allows debugging when facility recommendations look wrong.

---

## 4.2 `gold_facility_routing`

### Purpose

A flattened, query-optimized table used by applications, search, recommendation, and coordinator workflows.

This table should be built from the other gold tables and should not be the only source of truth.

### Grain

One row per facility.

### Recommended Columns

| Column | Description |
|---|---|
| `facility_id` | Foreign key to `gold_facility`. |
| `canonical_name` | Facility display name. |
| `facility_type` | Normalized facility type. |
| `operator_type` | Public/private/government/etc. |
| `address_full` | Primary address. |
| `city` | City. |
| `state_region` | State or region. |
| `country` | Country. |
| `latitude` | Primary latitude. |
| `longitude` | Primary longitude. |
| `primary_phone` | Best phone number to call. |
| `primary_email` | Best email. |
| `primary_website` | Best website. |
| `specialty_codes` | Array of normalized specialty codes. |
| `procedure_codes` | Array of normalized procedure codes. |
| `equipment_codes` | Array of normalized equipment codes. |
| `capability_tags` | Routing tags such as emergency, ICU, dialysis, cancer care, maternity, fertility, imaging. |
| `has_emergency` | Emergency availability flag. |
| `has_icu` | ICU availability flag. |
| `has_inpatient` | Inpatient availability flag. |
| `has_outpatient` | OPD availability flag. |
| `bed_capacity` | Bed count. |
| `doctor_count` | Doctor count. |
| `routing_confidence_score` | Overall score for routing usefulness. |
| `clinical_capability_score` | Confidence in clinical capabilities. |
| `contact_confidence_score` | Confidence in contact information. |
| `location_confidence_score` | Confidence in location information. |
| `freshness_score` | Freshness score based on source recency. |
| `quality_flags` | Important flags to show to data or operations teams. |
| `last_verified_at` | Most recent verification date. |
| `evidence_summary` | Short summary of strongest evidence. |

### Notes

This table is useful for product and analytics because it avoids complex joins at serving time. However, it should be rebuilt from normalized gold tables, not manually edited.

---

## 4.3 `routing_question_map`

### Purpose

Maps patient or coordinator question-flow options to the specialties, procedures, equipment, and access flags needed to recommend facilities.

### Grain

One row per routing question option or intent.

### Recommended Columns

| Column | Description |
|---|---|
| `question_option_id` | Stable ID for question option. |
| `question_option_label` | User-facing option, such as Cancer care, Dialysis, Pregnancy emergency. |
| `intent_group` | Emergency, specialty care, diagnostic test, surgery, routine consult, etc. |
| `specialty_codes` | Specialties required or preferred. |
| `procedure_codes` | Procedures required or preferred. |
| `equipment_codes` | Equipment required or preferred. |
| `required_flags` | Required access flags such as ICU, emergency, blood bank, inpatient. |
| `optional_boost_flags` | Nice-to-have flags used for ranking. |
| `triage_warning_text` | Warning or escalation message if the condition may be urgent. |
| `ranking_profile` | Which ranking formula to use, such as emergency, specialty, diagnostic, routine. |

### Example Mappings

| Patient Need | Specialty Match | Procedure Match | Equipment Match | Required / Boost Flags |
|---|---|---|---|---|
| Cancer care | Oncology | Chemotherapy, radiotherapy, cancer surgery | PET CT, LINAC, oncology lab | Inpatient, ICU, multidisciplinary care |
| Dialysis | Nephrology | Hemodialysis, peritoneal dialysis | Dialysis machine | Emergency support, inpatient |
| Pregnancy emergency | Obstetrics, gynecology | Emergency obstetric care, C-section | Operation theatre, blood bank | 24/7 emergency, ICU, neonatal support |
| Heart attack symptoms | Cardiology, emergency medicine | Angioplasty, cardiac intervention | Cath lab | 24/7 emergency, ICU, ambulance |
| IVF / fertility | Reproductive medicine | IVF, IUI, ICSI | IVF lab | Appointment booking, outpatient |
| MRI scan | Radiology | MRI | MRI machine | Diagnostic center or hospital, appointment availability |

---

## 4.4 `data_quality_issue`

### Purpose

Tracks specific data quality problems that need review, remediation, or manual verification.

### Grain

One row per facility per issue.

### Recommended Columns

| Column | Description |
|---|---|
| `issue_id` | Stable issue ID. |
| `facility_id` | Foreign key to `gold_facility`. |
| `table_name` | Gold table where issue appears. |
| `field_name` | Field affected. |
| `issue_type` | Missing value, duplicate, conflict, stale value, weak source, invalid format, low confidence. |
| `issue_description` | Human-readable issue details. |
| `severity` | Low, medium, high, critical. |
| `recommended_action` | Verify website, call facility, check government registry, review duplicate cluster, etc. |
| `status` | Open, in review, resolved, ignored. |
| `created_at` | Issue creation timestamp. |
| `resolved_at` | Issue resolution timestamp. |

### Notes

This table helps operationalize data quality instead of hiding problems inside one generic confidence score.

---

# Recommended MVP Build

For the first version, prioritize the tables that most directly support facility routing:

1. `gold_facility`
2. `gold_facility_location`
3. `gold_facility_contact`
4. `gold_facility_specialty`
5. `gold_facility_procedure`
6. `gold_facility_equipment`
7. `gold_facility_access`
8. `facility_evidence`
9. `gold_facility_routing`
10. `routing_question_map`

The taxonomy tables can be started early, but they may evolve as more raw values are reviewed.

---

# Suggested Routing Score

A general-purpose routing score can combine clinical match, distance, equipment, access, confidence, and freshness.

```text
routing_score =
    0.30 * specialty_match
  + 0.25 * procedure_match
  + 0.15 * distance_score
  + 0.10 * equipment_match
  + 0.10 * access_match
  + 0.05 * source_confidence
  + 0.05 * freshness_score
```

For emergency use cases, distance and emergency readiness should matter more:

```text
emergency_score =
    0.35 * distance_score
  + 0.25 * has_24_7_emergency
  + 0.15 * icu_or_critical_care
  + 0.10 * ambulance_or_contact_available
  + 0.10 * facility_type_hospital
  + 0.05 * confidence
```

---

# Source Trust Ranking

Recommended source trust ranking:

| Source Type | Suggested Trust Score |
|---|---:|
| Official facility website | 1.00 |
| Government registry | 0.95 |
| Accreditation body / insurance network | 0.85 |
| Academic or journal source | 0.80 |
| Major healthcare directory | 0.65 |
| Aggregator profile | 0.55 |
| Social media page | 0.40 |
| Blog or low-trust source | 0.30 |

Suggested field confidence formula:

```text
field_confidence = source_trust * freshness_factor * corroboration_factor * extraction_confidence
```

---

# Data Cleaning Rules

## Identity

- Use `cluster_id` and `unique_id` to identify possible duplicates.
- Normalize facility names by removing extra punctuation, inconsistent capitalization, and generic suffix noise.
- Preserve alternate names in `alternate_names`.
- Flag likely duplicates instead of deleting them immediately.

## Contacts

- Deduplicate phone numbers, emails, and websites.
- Normalize phone numbers into international format where possible.
- Prefer `official_phone` over generic `phone_numbers`.
- Prefer `official_website` over generic `websites`.
- Flag numbers that appear across unrelated facilities.

## Location

- Validate latitude and longitude against address, city, state, and country.
- Flag coordinates that fall outside the expected region.
- Store multiple branches separately when one organization has several locations.

## Clinical Capability

- Normalize raw specialties, procedures, and equipment to taxonomy codes.
- Separate specialty evidence from procedure evidence.
- Avoid inferring advanced procedures from broad specialties unless supporting evidence exists.
- Use equipment as supporting evidence for procedures.

## Evidence

- Keep raw values in `facility_evidence`.
- Track whether each evidence item was used in the gold layer.
- Record rejection reasons for noisy, stale, conflicting, or weak evidence.

---

# Recommended Patient / Coordinator Question Flow

The routing product should collect enough information to match the patient need safely and usefully.

## Step 1: Urgency Check

Ask whether the condition is an emergency or life-threatening.

Examples:

- Severe chest pain
- Difficulty breathing
- Stroke symptoms
- Heavy bleeding
- Pregnancy emergency
- Loss of consciousness
- Severe trauma

If yes, prioritize nearby emergency facilities and display local emergency guidance.

## Step 2: Location

Collect patient location:

- Current city or area
- Willingness to travel
- Maximum distance or travel time

## Step 3: Care Need

Ask for the type of care:

- Emergency care
- Cancer care
- Heart care
- Pregnancy or maternity
- Child care
- Kidney care or dialysis
- Bone, joint, or spine care
- Eye care
- ENT
- Dental
- Fertility or IVF
- Diagnostic imaging
- General consultation

## Step 4: Specific Procedure or Diagnosis

Collect more specific information if available:

- MRI
- Dialysis
- Chemotherapy
- Angioplasty
- IVF
- Cataract surgery
- C-section
- Knee replacement

## Step 5: Care Setting

Ask what kind of visit is needed:

- Outpatient consultation
- Diagnostic test
- Admission
- Surgery
- Emergency
- Follow-up
- Telemedicine

## Step 6: Constraints

Collect practical constraints:

- Public or private preference
- Insurance or cashless requirement
- Budget sensitivity
- Adult or pediatric care
- Language preference
- Female doctor preference
- Accessibility needs
- International patient support

## Step 7: Ranking and Explanation

Return recommended facilities with:

- Facility name
- Distance or location
- Relevant specialties
- Relevant procedures
- Key equipment or capability
- Contact information
- Confidence score
- Missing information or verification warning
- Suggested next action

---

# Final Recommended Architecture

```text
Silver Facility Data
        |
        v
Cleaning + Normalization + Entity Resolution
        |
        v
--------------------------------------------------
Segment 1: Facility Identity & Location
  - gold_facility
  - gold_facility_location

Segment 2: Clinical Capability
  - gold_facility_specialty
  - gold_facility_procedure
  - gold_facility_equipment
  - taxonomy_specialty
  - taxonomy_procedure

Segment 3: Access, Contact & Operational Readiness
  - gold_facility_contact
  - gold_facility_access

Segment 4: Evidence, Quality & Routing Intelligence
  - facility_evidence
  - data_quality_issue
  - routing_question_map
  - gold_facility_routing
--------------------------------------------------
        |
        v
Patient / Coordinator Search, Routing, and Recommendation
```

---

# Summary

The recommended design separates the golden healthcare facility model into four clear segments:

1. **Facility Identity & Location** establishes who and where the facility is.
2. **Clinical Capability** defines what care the facility can provide.
3. **Access, Contact & Operational Readiness** determines whether the patient can actually use the facility.
4. **Evidence, Quality & Routing Intelligence** explains why the system trusts the data and how facilities should be ranked.

This structure keeps the gold layer clean, auditable, and practical for real patient-routing workflows.
