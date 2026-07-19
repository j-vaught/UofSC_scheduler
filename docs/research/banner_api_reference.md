# Banner Self-Service Registration API Reference

**Base URL:** `https://banner.onecarolina.sc.edu/StudentRegistrationSsb`

**Authentication:** Session-based (cookies). You must be logged in via CAS/SSO. All requests require a valid session cookie.

**Common Parameters:**
- `term` — Term code (e.g., `202601` = Summer 2026)
- `uniqueSessionId` — Session identifier tied to your registration session (e.g., `tcc5m1775006210928`)
- `courseReferenceNumber` — CRN, the unique section identifier (e.g., `57235`)
- `_` — Cache-busting timestamp (milliseconds)

---

## 1. Session / Registration Setup

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ssb/classRegistration/classRegistration` | Main registration page (HTML) |
| GET | `/ssb/classRegistration/getRegistrationEvents?termFilter=` | Get available registration terms/events |
| GET | `/ssb/classRegistration/renderMySchedule` | Load the "Schedule and Options" tab |
| GET | `/ssb/classRegistration/reset?selectedTab=true&sortColumn=...&sortDirection=...&uniqueSessionId=...` | Reset registration view |
| GET | `/ssb/userPreference/fetchUsageTracking` | Fetch user preferences/tracking |
| GET | `/ssb/selfServiceMenu/data` | Get self-service menu structure |

---

## 2. Lookup / Dropdown Endpoints (GET)

All follow the same parameter pattern:
```
?searchTerm=&term={term}&offset=1&max=10&uniqueSessionId={sessionId}&_={timestamp}
```

| Endpoint | Returns |
|----------|---------|
| `/ssb/classSearch/get_campus` | List of campuses (e.g., COL = USC Columbia) |
| `/ssb/classSearch/get_subject` | List of subjects (e.g., EMCH, CSCE, MATH) |
| `/ssb/classSearch/get_instructionalMethod` | Instructional methods (e.g., Face to Face, Online) |
| `/ssb/classSearch/get_level` | Course levels (e.g., Graduate, Undergraduate) |
| `/ssb/classSearch/get_partOfTerm` | Parts of term (e.g., Full Term, First Half) |
| `/ssb/classSearch/get_attribute` | Course attributes (e.g., Honors, Writing Intensive) |

**Notes:**
- `searchTerm` can filter results (type-ahead search)
- `offset` and `max` support pagination
- These return JSON arrays of `{code, description}` objects

---

## 3. Class Search (GET)

**Endpoint:** `/ssb/searchResults/searchResults`

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `txt_campus` | string | Campus code (e.g., `COL`) |
| `txt_subject` | string | Subject code (e.g., `EMCH`) |
| `txt_courseNumber` | string | Course number filter (supports `%` wildcard, e.g., `5%%` for 500-level) |
| `txt_term` | string | Term code (e.g., `202601`) |
| `startDatepicker` | string | Start date filter (optional) |
| `endDatepicker` | string | End date filter (optional) |
| `uniqueSessionId` | string | Session ID |
| `pageOffset` | int | Pagination offset (starts at 0) |
| `pageMaxSize` | int | Results per page (default 10) |
| `sortColumn` | string | Sort field (e.g., `subjectDescription`, `courseTitle`) |
| `sortDirection` | string | `asc` or `desc` |

**Response:** JSON with search results including CRNs, titles, instructors, meeting times, enrollment counts.

---

## 4. Section Detail Endpoints (POST)

All take form-encoded body with `term` and `courseReferenceNumber`.

| Endpoint | Returns |
|----------|---------|
| `/ssb/searchResults/getClassDetails` | Full section details (times, instructor, campus, etc.) |
| `/ssb/searchResults/getSectionPrerequisites` | Prerequisite requirements |
| `/ssb/searchResults/getEnrollmentInfo` | Enrollment counts (seats remaining, waitlist) |
| `/ssb/searchResults/getRestrictions` | Section restrictions (major, level, etc.) |
| `/ssb/searchResults/getCourseDescription` | Course catalog description |
| `/ssb/searchResults/getSectionAttributes` | Section attributes |
| `/ssb/searchResults/getSectionBookstoreDetails` | Textbook/bookstore info |

---

## 5. Faculty / Meeting Times (GET)

**Endpoint:** `/ssb/searchResults/getFacultyMeetingTimes`

| Parameter | Description |
|-----------|-------------|
| `term` | Term code |
| `courseReferenceNumber` | CRN |

**Response:** JSON with instructor info and meeting day/time/location details.

---

## 6. Form State Management (POST)

| Endpoint | Description |
|----------|-------------|
| `/ssb/classSearch/resetDataForm` | Reset the search form server-side state |

---

## 7. Registration Actions (inferred from UI, NOT triggered during exploration)

These endpoints exist but were not directly captured to avoid modifying your registration:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ssb/classRegistration/addRegistrationItem` | Add a CRN to your registration (likely params: `term`, `courseReferenceNumber`) |
| POST | `/ssb/classRegistration/dropRegistrationItem` | Drop a CRN from registration |
| POST | `/ssb/classRegistration/submitRegistration` | Submit/save registration changes |

---

## 8. Term Selection

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ssb/term/search` | Search available terms |
| POST | `/ssb/registration/registerPostSignIn` | Set term after sign-in |

---

## Workflow for Building a Scheduling Tool

1. **Authenticate** via CAS/SSO to get session cookies
2. **Select a term** using `getRegistrationEvents` or `term/search`
3. **Search for classes** using `searchResults/searchResults` with filters
4. **Get section details** using the POST detail endpoints (prerequisites, enrollment, times, etc.)
5. **Build schedule combinations** client-side using meeting time data
6. **Add sections** via `addRegistrationItem` with selected CRNs
7. **Submit** via `submitRegistration`

---

## Term Code Format

`YYYYMM` where:
- `01` = Spring (January)
- `05` = Summer (May)
- `06` = Summer I
- `07` = Summer II
- `08` = Fall (August)

Example: `202601` = Spring 2026, `202508` = Fall 2025
