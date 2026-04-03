# UofSC Data Sources for Course Scheduling Tool

## 1. FOSE API — `classes.sc.edu`

**Base URL:** `https://classes.sc.edu/api/?page=fose`
**Auth:** None required
**Method:** POST with `Content-Type: application/json`
**Range:** Fall 2023 – Fall 2026

### Endpoints

#### Search (`route=search`)
```
POST https://classes.sc.edu/api/?page=fose&route=search
Body: {"other":{"srcdb":"202501"},"criteria":[{"field":"subject","value":"CSCE"}]}
```

**Response fields:** `key`, `code`, `title`, `crn`, `section`, `schd`, `stat`, `isCancelled`, `meets`, `meetingTimes`, `instr` (last name only, slash-separated for multiple), `start_date`, `end_date`, `inst_mthd`, `srcdb`

**Search criteria fields:** `subject`, `keyword`, `instructor`, `schd`, `stat`, `camp`, `hours`, `overlap`, `alias`

#### Details (`route=details`)
```
POST https://classes.sc.edu/api/?page=fose&route=details
Body: {"group":"code:CSCE 145","key":"crn:40367","srcdb":"202501","matched":"crn:40367"}
```

**Additional fields:** `description` (HTML), `hours_html`, `sched_type`, `campus`, `seats` (HTML), `registration_restrictions`, `course_attr`, `course_coreqs`, `section_coreqs`, `clssnotes`, `meeting_html`, `allInGroup`, `xlist`

### Term Codes
Pattern: `YYYYMM` — `01` = Spring, `05` = Summer, `08` = Fall
Special: `999999` = All terms combined

---

## 2. Banner 9 SSB API — `banner.onecarolina.sc.edu`

**Base URL:** `https://banner.onecarolina.sc.edu/StudentRegistrationSsb/ssb`
**Auth:** None for read-only (requires JSESSIONID session cookie)
**Range:** Fall 2013 – Fall 2026 (40 terms)

### Session Setup (required before searching)
```
GET  .../classSearch/classSearch          # Get initial session cookie
POST .../term/search?mode=search          # Set term
     Body: term=202501&studyPath=&studyPathText=&startDatepicker=&endDatepicker=&mepCode=COL
```

### Lookup Endpoints (GET)

| Endpoint | Parameters | Returns |
|----------|-----------|---------|
| `classSearch/getTerms` | `searchTerm`, `offset`, `max`, `mepCode` | `[{code, description}]` |
| `classSearch/get_subject` | `term`, `searchTerm`, `offset`, `max` | `[{code, description}]` |
| `classSearch/get_college` | `term`, `searchTerm`, `offset`, `max` | `[{code, description}]` |
| `classSearch/get_attribute` | `term`, `searchTerm`, `offset`, `max` | `[{code, description}]` |
| `classSearch/get_campus` | `term` | Campus objects |
| `classSearch/get_partOfTerm` | `term` | Part of term objects |
| `classSearch/get_instructionalMethod` | `term` | Instructional method objects |

### Section Search (GET, requires session)
```
GET .../searchResults/searchResults?txt_subject=CSCE&txt_term=202501&pageOffset=0&pageMaxSize=50
```

**Parameters:** `txt_term`, `txt_subject`, `txt_courseNumber`, `txt_instructor`, `txt_college`, `txt_division`, `txt_attribute`, `txt_keywordall`, `txt_courseTitle`, `pageOffset`, `pageMaxSize`, `sortColumn`, `sortDirection`

**Response fields per section:**
- **Course:** `courseReferenceNumber` (CRN), `courseNumber`, `subject`, `courseTitle`, `sequenceNumber`
- **Enrollment:** `maximumEnrollment`, `enrollment`, `seatsAvailable`, `waitCapacity`, `waitCount`, `waitAvailable`
- **Cross-listing:** `crossList`, `crossListCapacity`, `crossListCount`, `crossListAvailable`
- **Credits:** `creditHours`, `creditHourHigh`, `creditHourLow`
- **Status:** `openSection`, `isSectionLinked`, `linkIdentifier`
- **Other:** `instructionalMethod`, `instructionalMethodDescription`, `campusDescription`, `scheduleTypeDescription`

**Note:** `faculty` array comes back empty in search results — must use `getFacultyMeetingTimes` per section.

### Detail Endpoints (GET, requires term + CRN)

| Endpoint | Returns | Format |
|----------|---------|--------|
| `searchResults/getFacultyMeetingTimes` | Faculty + meeting times | **JSON** |
| `searchResults/getClassDetails` | Full class details | HTML |
| `searchResults/getCourseDescription` | Course description | HTML |
| `searchResults/getEnrollmentInfo` | Seats/enrollment | HTML |
| `searchResults/getSectionPrerequisites` | Prerequisites | HTML |
| `searchResults/getCorequisites` | Corequisites | HTML |
| `searchResults/getRestrictions` | Registration restrictions | HTML |
| `searchResults/getSectionAttributes` | Section attributes | HTML |
| `searchResults/getSectionBookstoreDetails` | Textbook info | HTML |
| `searchResults/getXlistSections` | Cross-listed sections | HTML |
| `searchResults/getFees` | Course fees | HTML |

### getFacultyMeetingTimes Response
```
GET .../searchResults/getFacultyMeetingTimes?term=202501&courseReferenceNumber=40367
```

Returns `fmt` array with:
- **Faculty:** `displayName` ("Shepherd, Jeremiah"), `emailAddress`, `bannerId`, `primaryIndicator`
- **Meeting times:** `beginTime`, `endTime`, `building`, `buildingDescription`, `room`, `monday`–`sunday` booleans, `startDate`, `endDate`, `meetingScheduleType`, `hoursWeek`

---

## 3. Grade Spread Files — Registrar

**URL:** https://sc.edu/about/offices_and_divisions/registrar/toolbox/grade_processing/grade_spreads/
**Format:** Excel (.xlsx), one file per semester
**Range:** Summer 2017 – Fall 2025 (25 files in `/Users/user/Desktop/uofsc_grade_data/`)
**Granularity:** One row per course section

### Columns (34 total)
| Column | Description |
|--------|-------------|
| `SUBJECT` | Department code (CSCE, EMCH, etc.) |
| `COURSE_NUMBER` | Course number |
| `COURSE_SECTION_NUMBER` | Section (001, H01, J60, etc.) |
| `TITLE` | Course title |
| `CAMPUS` | COL, AIK, BFT, LAN, SAL, SMT, UNI, UPS |
| `AUDIT` | Audit count |
| `A`, `B+`, `B`, `C+`, `C`, `D+`, `D`, `F` | Letter grade counts |
| `A_GF` through `F_GF` | Grade forgiveness counts |
| `FN` | Failure for non-attendance |
| `Incomplete`, `IP`, `No Grade`, `NR` | Other statuses |
| `S`, `U` | Satisfactory/Unsatisfactory |
| `T` | Transfer |
| `W`, `WF` | Withdrew, Withdrew Failing |
| `Num Grades Posted` | Total |

### Key Notes
- **No instructor names** in grade spreads — must cross-reference with Banner API
- Some values stored as strings (`'0'`) — handle during ingestion
- `_GF` columns = grade forgiveness flags
- `J60`, `J50` sections = online/distance sections (typically no grade data)

### File Name Pattern
```
YYYYMM_grade_spread_report[_2].xlsx
```
Older files (pre-2021): `YYYYMM_grade_spread.xlsx`

---

## 4. Cross-Referencing Strategy

**Join keys:** `SUBJECT` + `COURSE_NUMBER` + `COURSE_SECTION_NUMBER` (grade spread) ↔ `subject` + `courseNumber` + `sequenceNumber` (Banner)

**Banner provides:** Full instructor name (`displayName`), email, meeting times, building/room
**Grade spreads provide:** Grade distribution counts per section

### Coverage Overlap
| Source | Range |
|--------|-------|
| Grade spreads | Summer 2017 – Fall 2025 |
| Banner API | Fall 2013 – Fall 2026 |
| **Full overlap** | **Summer 2017 – Fall 2025** |
| FOSE API | Fall 2023 – Fall 2026 (redundant) |

### Disambiguation
- Banner `instr` field (FOSE) = last name only — ambiguous for common names
- Banner `getFacultyMeetingTimes` = full name + email — use for reliable matching
- Match by **email** first (most reliable), fall back to **displayName**

---

## 5. Related GitHub Projects

| Repo | Description |
|------|-------------|
| [SCCapstone/Cockys-Way](https://github.com/SCCapstone/Cockys-Way) | UofSC project using `classes.sc.edu` FOSE API |
| [sssunnyyyss/BetterAtlas](https://github.com/sssunnyyyss/BetterAtlas) | FOSE API documentation (Emory's instance) |
| [Xevion/Banner](https://github.com/Xevion/Banner) | Best Banner 9 SSB API docs with sample JSON |
| [VJL0/betterssb](https://github.com/VJL0/betterssb) | Comprehensive Banner 9 endpoint catalog |
| [icssc/AntAlmanac](https://github.com/icssc/AntAlmanac) | UCI scheduler — closest feature parity reference |
| [jhuopensource/semesterly](https://github.com/jhuopensource/semesterly) | Multi-university scheduler with per-school parsers |

---

## 6. Rate Limiting Notes

- Banner API will refuse connections after sustained rapid requests
- Use `time.sleep(0.2)` between requests minimum
- Create fresh `requests.Session()` per term to avoid stale sessions
- FOSE API appears more tolerant but still be respectful
