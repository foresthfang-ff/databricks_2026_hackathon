Response received in 9.3 Seconds
# Dataset Join Relationships

The three datasets are connected through geographic hierarchy relationships:

`Facility → Pincode → District → State`

This allows facility-level healthcare data to be linked with:
- postal infrastructure
- district-level public health indicators
- regional healthcare accessibility analysis

---

# 1. Facilities ↔ India Post Pincode Directory

## Join Type
Direct Join

## Join Key

```sql
facilities.address_zipOrPostcode = india_post_pincode_directory.pincode

Copy
Match Quality
Match Rate: 97.3%
Joinable Records: 9,568
Total Facilities with Valid Pincodes: 9,830
Quality: Excellent
Most facilities with valid pincodes successfully map to the postal directory.

SQL Example
FROM facilities f
INNER JOIN india_post_pincode_directory p
  ON CAST(f.address_zipOrPostcode AS BIGINT) = p.pincode

Copy
2. India Post Pincode Directory ↔ NFHS-5 Health Indicators
Join Type
District-Level Geographic Join

Join Key
district + state
p.district = n.district_name
p.statename = n.state_ut

Copy
Match Quality
Match Rate: 71.8%
Joinable District-State Pairs: 542
Total District-State Pairs: 755
Quality: Good
Some districts require normalization due to:

naming differences
whitespace inconsistencies
alternate spellings
SQL Example
FROM india_post_pincode_directory p
INNER JOIN nfhs_5_district_health_indicators n
  ON UPPER(TRIM(p.district)) = UPPER(TRIM(n.district_name))
  AND UPPER(TRIM(p.statename)) = UPPER(TRIM(n.state_ut))

Copy
3. Facilities ↔ NFHS-5 Indicators
Join Type
Two-Step Join via Pincode

Join Path
Facilities
    ↓
Pincode Directory
    ↓
NFHS District Indicators

Copy
Match Quality
Match Rate: 72.6%
Joinable Facility Districts: 423
Total Facility Districts: 583
Quality: Good
This relationship enables:

healthcare infrastructure analysis
district-level risk comparison
care gap identification
SQL Example
FROM facilities f

INNER JOIN india_post_pincode_directory p
  ON CAST(f.address_zipOrPostcode AS BIGINT) = p.pincode

INNER JOIN nfhs_5_district_health_indicators n
  ON UPPER(TRIM(p.district)) = UPPER(TRIM(n.district_name))
  AND UPPER(TRIM(p.statename)) = UPPER(TRIM(n.state_ut))

Copy
Join Relationship Summary
Join Path	Join Key	Joinable Records	Total Records	Match Rate
Facilities → Pincode	pincode	9,568	9,830	97.3%
Pincode → NFHS	district + state	542	755	71.8%
Facilities → NFHS	pincode → district + state	423	583	72.6%
Example Three-Way Join Results
Facility	District	Health Indicator
Fortis Hospital Anandapur (Kolkata, 700027)	Kolkata	97.5% institutional birth rate
RAM Hospital (Kanpur, 209217)	Kanpur Nagar	86.6% institutional birth rate
Amrita Hospital (Kochi, 682041)	Ernakulam	99.1% institutional birth rate
Data Cleaning Requirements
Before joining the datasets:

Normalize Text Fields
Use:

UPPER(TRIM())
This helps resolve:

case differences
trailing spaces
inconsistent formatting
Validate Pincodes
Pincodes are stored as strings in the facilities table.

Convert using:

CAST(address_zipOrPostcode AS BIGINT)

Copy
Validate using:

RLIKE '^[0-9]+$'
Filter Invalid Values
Remove:

NULL values
string 'null'
malformed pincodes
Example:

WHERE address_zipOrPostcode IS NOT NULL
AND LOWER(address_zipOrPostcode) != 'null'

Copy
Coverage Limitations
Facilities Without Valid Pincodes
Approximately 3% of facilities:

have missing pincodes
contain invalid postal codes
cannot be geographically linked
District Matching Gaps
Approximately 28% of district mappings fail due to:

naming inconsistencies
NFHS district coverage limitations
alternate district spellings
Dataset Coverage Difference
Dataset	Unique Districts
NFHS-5	706
Pincode Directory	755
Use Cases
Facility Mapping
Link healthcare facilities with:

postal infrastructure
district hierarchy
geographic coordinates
Health Outcomes Analysis
Correlate:

facility availability
facility density
healthcare capabilities
with:

district health indicators
maternal health
chronic disease prevalence
Service Gap Identification
Identify districts with:

poor health outcomes
low trusted facility coverage
potential healthcare deserts
This is especially useful for:

referral planning
infrastructure investment
public health strategy
