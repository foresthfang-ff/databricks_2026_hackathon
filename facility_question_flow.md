# Facility Routing Question Flow

## 1. Purpose

This question flow is designed to help a patient, care coordinator, or internal routing application identify the most appropriate healthcare facility based on urgency, location, clinical need, procedure need, access requirements, and data confidence.

The flow is intended to work with the proposed golden facility design, especially these tables:

- `gold_facility`
- `gold_facility_location`
- `gold_facility_contact`
- `gold_facility_specialty`
- `gold_facility_procedure`
- `gold_facility_equipment`
- `gold_facility_access`
- `facility_evidence`
- `routing_question_map`

The goal is not only to return a facility list, but to explain **why** a facility was recommended and what the next best action should be.

---

## 2. Routing Principles

The question flow should prioritize the following in order:

1. **Safety and urgency**
2. **Geographic feasibility**
3. **Clinical capability match**
4. **Procedure and equipment availability**
5. **Access constraints**
6. **Contactability and verification confidence**
7. **Freshness and source trust**

For emergency or high-risk symptoms, the system should route to emergency-capable facilities first rather than optimizing for specialty depth.

---

## 3. Four Main Question Segments

The flow is organized into four major segments:

1. **Urgency and Safety**
2. **Location and Access**
3. **Clinical Need and Capability**
4. **Preference, Constraint, and Final Ranking**

Each segment should collect only the minimum information needed to route safely and accurately.

---

# Segment 1: Urgency and Safety

## 1.1 Objective

Identify whether the patient needs immediate emergency care before asking detailed specialty or preference questions.

## 1.2 Primary Question

**Is this an emergency or life-threatening situation?**

### Suggested Answer Options

- Yes, emergency symptoms are present
- Not sure
- No, this is not an emergency

## 1.3 Emergency Symptom Examples

The UI or routing assistant may show examples such as:

- Chest pain or possible heart attack
- Stroke symptoms
- Severe breathing difficulty
- Major accident or trauma
- Severe bleeding
- Loss of consciousness
- Severe allergic reaction
- Pregnancy emergency
- Severe abdominal pain
- High fever in infant or child
- Suicidal or self-harm risk

## 1.4 Routing Logic

If the answer is **Yes** or **Not sure**, prioritize facilities with:

- Emergency department capability
- 24/7 availability
- ICU or critical care capability
- Ambulance or emergency contact availability
- Short distance from patient location
- Verified phone or official website

## 1.5 Required Golden Fields

From `gold_facility_access`:

- `has_24_7_emergency`
- `has_ambulance`
- `has_icu`
- `has_inpatient`
- `bed_capacity`
- `access_confidence_score`

From `gold_facility_location`:

- `latitude`
- `longitude`
- `address_full`
- `geo_confidence_score`

From `gold_facility_contact`:

- `primary_phone`
- `emergency_phone`
- `official_website`
- `contact_confidence_score`

From `gold_facility`:

- `facility_type`
- `status`
- `gold_confidence_score`

## 1.6 Emergency Ranking Formula

```text
emergency_score =
    0.35 * distance_score
  + 0.25 * emergency_capability_score
  + 0.15 * icu_or_critical_care_score
  + 0.10 * contactability_score
  + 0.10 * facility_type_score
  + 0.05 * confidence_score
```

## 1.7 Recommended Output

For emergency cases, return:

- Nearest emergency-capable facilities
- Emergency phone or main phone
- Address and distance
- Confidence indicators
- Clear warning to contact local emergency services immediately when appropriate

Example output structure:

```text
Recommended emergency-capable facilities near you:

1. Facility Name
   - Distance: X km
   - Emergency capability: Verified / Likely / Unknown
   - ICU: Yes / No / Unknown
   - Phone: xxx
   - Address: xxx
   - Why recommended: nearest facility with emergency and ICU indicators
```

---

# Segment 2: Location and Access

## 2.1 Objective

Understand where the patient is and what practical access constraints affect routing.

## 2.2 Primary Questions

### Question 1

**Where is the patient located?**

### Suggested Inputs

- Current location
- City
- State or region
- Country
- Postal or ZIP code
- Address or landmark

### Question 2

**How far is the patient willing or able to travel?**

### Suggested Answer Options

- Within 5 km
- Within 10 km
- Within 25 km
- Within 50 km
- Anywhere in the city
- Anywhere in the state or region
- No distance preference

### Question 3

**Does the patient need a specific type of facility access?**

### Suggested Answer Options

- Emergency department
- Outpatient consultation only
- Inpatient admission
- Surgery capability
- Diagnostic testing only
- Telemedicine or online consultation
- Home care or remote care
- No preference

## 2.3 Required Golden Fields

From `gold_facility_location`:

- `address_full`
- `city`
- `state_region`
- `country`
- `postal_code`
- `latitude`
- `longitude`
- `geo_confidence_score`
- `is_primary_location`

From `gold_facility_access`:

- `has_emergency`
- `has_24_7_emergency`
- `has_inpatient`
- `has_outpatient`
- `has_surgery`
- `has_diagnostic_services`
- `has_telemedicine`
- `accessibility_features`
- `access_confidence_score`

From `gold_facility_contact`:

- `primary_phone`
- `official_website`
- `appointment_url`
- `contact_confidence_score`

## 2.4 Location Quality Logic

Location should be scored based on:

- Presence of latitude and longitude
- Valid city/state/country
- Postal code available and preserved as string
- Address completeness
- Match between coordinates and address fields
- Source trust and recency

## 2.5 Location Quality Flags

Suggested flags:

- `missing_coordinates`
- `missing_city`
- `missing_country`
- `missing_postal_code`
- `postal_code_suspicious_format`
- `low_geo_confidence`
- `multiple_possible_locations`
- `address_coordinate_mismatch`

## 2.6 Recommended Output

For non-emergency cases, display location-aware results like:

```text
Recommended facilities near [location]:

1. Facility Name
   - Distance: X km
   - City: xxx
   - Facility type: Hospital / Clinic / Diagnostic Center
   - Contact: xxx
   - Location confidence: High / Medium / Low
```

---

# Segment 3: Clinical Need and Capability

## 3.1 Objective

Map the patient need to the correct specialty, procedure, equipment, and capability requirements.

## 3.2 Primary Question

**What type of care does the patient need?**

## 3.3 Suggested High-Level Care Categories

- Emergency care
- General consultation
- Heart or cardiology care
- Cancer or oncology care
- Pregnancy or maternity care
- Child or pediatric care
- Kidney, dialysis, or transplant care
- Bone, joint, spine, or orthopedic care
- Neurology or brain-related care
- Eye care
- ENT care
- Dental care
- Fertility or IVF care
- Diagnostic imaging
- Laboratory testing
- Surgery
- Rehabilitation or physiotherapy
- Mental health care
- Not sure

## 3.4 Follow-Up Question

**Do you know the specific diagnosis, treatment, procedure, or test needed?**

### Suggested Inputs

- Free-text diagnosis
- Procedure name
- Test name
- Specialty name
- Doctor recommendation
- Upload or paste referral text in a later phase

## 3.5 Care Setting Question

**What type of visit is needed?**

### Suggested Answer Options

- Outpatient consultation
- Diagnostic test
- Procedure
- Surgery
- Inpatient admission
- Emergency visit
- Follow-up visit
- Second opinion
- Not sure

## 3.6 Required Golden Fields

From `gold_facility_specialty`:

- `specialty_code`
- `specialty_display_name`
- `specialty_group`
- `is_center_of_excellence`
- `has_inpatient_support`
- `has_outpatient_support`
- `specialty_confidence_score`
- `evidence_count`

From `gold_facility_procedure`:

- `procedure_code`
- `procedure_display_name`
- `procedure_group`
- `specialty_code`
- `care_setting`
- `requires_special_equipment`
- `procedure_confidence_score`
- `verification_status`

From `gold_facility_equipment`:

- `equipment_code`
- `equipment_display_name`
- `equipment_group`
- `supports_procedure_code`
- `equipment_confidence_score`
- `evidence_count`

From `gold_facility_access`:

- `has_inpatient`
- `has_outpatient`
- `has_surgery`
- `has_icu`
- `bed_capacity`
- `doctor_count`

## 3.7 Care Category Mapping Examples

| User Selection | Specialty Match | Procedure Match | Equipment Match | Required Access Flags |
|---|---|---|---|---|
| Cancer care | Oncology | Chemotherapy, radiotherapy, biopsy | PET CT, LINAC, MRI, CT | inpatient/outpatient, surgery optional |
| Heart care | Cardiology | Angioplasty, bypass surgery, ECG, echo | Cath lab, ECG, echo, ICU | emergency, ICU, surgery optional |
| Pregnancy care | Obstetrics, gynecology | Delivery, C-section, prenatal care | Ultrasound, NICU optional | inpatient, emergency obstetric care |
| Dialysis care | Nephrology | Hemodialysis, peritoneal dialysis | Dialysis machine | outpatient/inpatient |
| Orthopedic care | Orthopedics | Joint replacement, fracture care, spine surgery | X-ray, MRI, operating room | surgery, inpatient optional |
| Diagnostic imaging | Radiology | MRI, CT, X-ray, ultrasound | MRI, CT, X-ray, ultrasound | diagnostic services |
| IVF care | Fertility, reproductive medicine | IVF, IUI, ICSI | IVF lab | outpatient |

## 3.8 Capability Matching Logic

A facility should score higher when it has:

- Direct specialty match
- Direct procedure match
- Required equipment match
- Appropriate care setting
- Higher evidence count
- Higher source trust
- Recent verification
- Supporting access capability, such as ICU for complex procedures

## 3.9 Clinical Capability Score

```text
clinical_capability_score =
    0.30 * specialty_match_score
  + 0.25 * procedure_match_score
  + 0.15 * equipment_match_score
  + 0.10 * care_setting_match_score
  + 0.10 * evidence_strength_score
  + 0.10 * freshness_score
```

---

# Segment 4: Preference, Constraint, and Final Ranking

## 4.1 Objective

Apply patient-specific constraints after safety, location, and clinical capability have been considered.

## 4.2 Primary Questions

### Question 1

**Do you have a preferred facility type?**

### Suggested Answer Options

- Hospital
- Clinic
- Specialty center
- Diagnostic center
- Government/public facility
- Private facility
- Academic or teaching hospital
- No preference

### Question 2

**Do you have payment or insurance requirements?**

### Suggested Answer Options

- Insurance accepted
- Cashless facility preferred
- Public or lower-cost option preferred
- Private facility preferred
- International patient support needed
- No preference

### Question 3

**Are there any accessibility or language needs?**

### Suggested Answer Options

- Wheelchair access
- Female doctor preferred
- Pediatric care required
- Language support needed
- Telemedicine preferred
- No preference

### Question 4

**How should the results be sorted?**

### Suggested Answer Options

- Best overall match
- Closest first
- Highest clinical capability
- Most verified data
- Public facilities first
- Private facilities first

## 4.3 Required Golden Fields

From `gold_facility`:

- `facility_type`
- `operator_type`
- `is_academic`
- `is_public`
- `is_private`
- `gold_confidence_score`
- `status`

From `gold_facility_access`:

- `accepts_insurance`
- `insurance_networks`
- `cashless_available`
- `accepts_international_patients`
- `accessibility_features`
- `has_telemedicine`
- `has_online_booking`

From `gold_facility_contact`:

- `primary_phone`
- `appointment_url`
- `official_website`
- `contact_confidence_score`

From `facility_evidence`:

- `attribute_name`
- `source_url`
- `source_type`
- `evidence_date`
- `confidence_score`
- `is_used_in_gold`

## 4.4 Overall Ranking Formula

```text
routing_score =
    0.30 * clinical_capability_score
  + 0.20 * distance_score
  + 0.15 * access_match_score
  + 0.10 * contactability_score
  + 0.10 * source_confidence_score
  + 0.10 * freshness_score
  + 0.05 * preference_match_score
```

For emergency cases, use the emergency ranking formula instead of the general routing formula.

## 4.5 Final Output Structure

Recommended facility cards should include:

- Facility name
- Facility type
- Distance and location
- Matched specialty
- Matched procedure or capability
- Key equipment, if relevant
- Access notes
- Phone or website
- Data confidence
- Why this facility was recommended
- Any caution flags

Example:

```text
1. Facility Name
   - Match: Strong oncology and chemotherapy match
   - Distance: 8.2 km
   - Facility type: Private hospital
   - Relevant capabilities: Oncology, chemotherapy, PET CT
   - Contact: xxx
   - Confidence: High
   - Why recommended: specialty, procedure, and equipment all match the request
   - Review note: insurance acceptance not verified
```

---

## 5. Routing Question Map Table Design

The `routing_question_map` table connects user-facing answers to normalized facility capability fields.

## 5.1 Suggested Columns

| Column | Description |
|---|---|
| `question_segment` | Segment name, such as urgency, location, clinical_need, preference |
| `question_id` | Stable ID for the question |
| `question_text` | User-facing question text |
| `answer_option_id` | Stable ID for the answer option |
| `answer_option_text` | User-facing answer text |
| `specialty_codes` | Array of normalized specialty codes associated with the answer |
| `procedure_codes` | Array of normalized procedure codes associated with the answer |
| `equipment_codes` | Array of normalized equipment codes associated with the answer |
| `required_access_flags` | Array of required or preferred access flags |
| `facility_type_preferences` | Array of preferred facility types |
| `operator_type_preferences` | Array of preferred operator types |
| `urgency_level` | emergency, urgent, routine, unknown |
| `care_setting` | emergency, outpatient, inpatient, surgery, diagnostic, telemedicine |
| `ranking_weight_override` | Optional JSON object for custom scoring weights |
| `is_hard_filter` | Whether the answer should strictly filter results |
| `is_active` | Whether this mapping is currently active |
| `created_at` | Creation timestamp |
| `updated_at` | Last update timestamp |

## 5.2 Example Rows

| Question | Answer Option | Specialty Codes | Procedure Codes | Equipment Codes | Required Flags |
|---|---|---|---|---|---|
| What type of care is needed? | Cancer care | oncology | chemotherapy, radiotherapy, biopsy | PET_CT, LINAC, MRI | has_outpatient, has_inpatient |
| What type of care is needed? | Heart care | cardiology | angioplasty, ECG, echo | cath_lab, ECG, echo | has_emergency, has_icu |
| What type of care is needed? | Dialysis | nephrology | hemodialysis | dialysis_machine | has_outpatient |
| What type of care is needed? | Pregnancy care | obstetrics, gynecology | delivery, c_section, prenatal_care | ultrasound, NICU | has_inpatient, has_emergency |
| What type of care is needed? | Diagnostic imaging | radiology | MRI, CT, X-ray, ultrasound | MRI, CT, X-ray, ultrasound | has_diagnostic_services |
| What type of care is needed? | IVF care | fertility, reproductive_medicine | IVF, IUI, ICSI | IVF_lab | has_outpatient |

---

## 6. Data Quality and Confidence Handling

## 6.1 Confidence Buckets

| Bucket | Suggested Range | Meaning |
|---|---:|---|
| High | 0.80 - 1.00 | Strong source and corroboration |
| Medium | 0.55 - 0.79 | Useful but should be reviewed if critical |
| Low | 0.30 - 0.54 | Weak evidence or stale data |
| Unknown | below 0.30 or null | Not enough evidence |

## 6.2 Important Quality Flags

Suggested facility-level flags:

- `missing_primary_phone`
- `missing_official_website`
- `missing_coordinates`
- `low_location_confidence`
- `low_contact_confidence`
- `low_clinical_confidence`
- `specialty_from_weak_source_only`
- `procedure_from_weak_source_only`
- `stale_source_data`
- `conflicting_source_values`
- `possible_duplicate_facility`

## 6.3 How to Display Confidence

The UI or output should avoid overstating uncertain information.

Recommended labels:

- **Verified**: high confidence from official or corroborated sources
- **Likely**: medium confidence from multiple or reasonable sources
- **Needs review**: low confidence, stale, or conflicting evidence
- **Unknown**: no reliable evidence available

---

## 7. Recommended End-to-End Flow

```text
Start
  |
  |-- Q1: Is this an emergency or possibly life-threatening?
  |       |-- Yes / Not sure -> Emergency routing
  |       |-- No -> Continue
  |
  |-- Q2: Where is the patient located?
  |
  |-- Q3: How far can the patient travel?
  |
  |-- Q4: What type of care is needed?
  |
  |-- Q5: Is there a specific diagnosis, procedure, or test?
  |
  |-- Q6: What care setting is needed?
  |
  |-- Q7: Any facility, insurance, accessibility, or language preferences?
  |
  |-- Rank facilities
  |
  |-- Return recommended facilities with explanation and confidence
End
```

---

## 8. MVP Implementation Recommendation

For the first version, keep the question flow simple:

1. Emergency or not
2. Patient location
3. Care category
4. Specific procedure or test, if known
5. Care setting
6. Distance preference
7. Facility/payment preference

The MVP can use the following fields from `gold_facility_routing` or the equivalent wide table:

- `facility_id`
- `canonical_name`
- `facility_type`
- `operator_type`
- `address_full`
- `city`
- `state_region`
- `country`
- `postal_code`
- `latitude`
- `longitude`
- `primary_phone`
- `primary_website`
- `specialty_codes`
- `procedure_codes`
- `equipment_codes`
- `capability_tags`
- `has_emergency`
- `has_icu`
- `has_inpatient`
- `has_outpatient`
- `clinical_capability_score`
- `contact_confidence_score`
- `location_confidence_score`
- `freshness_score`
- `routing_confidence_score`
- `quality_flags`

---

## 9. Future Enhancements

Potential next-phase improvements:

- Natural-language symptom or referral parsing
- Procedure synonym matching
- Specialty taxonomy expansion
- Insurance network matching
- Real-time appointment availability
- Real-time distance and travel time
- Multilingual question flow
- Facility verification workflow
- Doctor-level routing
- Patient outcome feedback loop

---

## 10. Key Design Decision

The question flow should not directly query messy raw fields. It should query normalized gold fields and use evidence/confidence tables to explain uncertainty.

The raw and silver layers are useful for extraction and cleaning, but the routing experience should depend on gold-level entities, normalized capabilities, and confidence-aware ranking.
