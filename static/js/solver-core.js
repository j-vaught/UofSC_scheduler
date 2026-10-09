/* Browser-native semester schedule solver. Kept dependency-free for Web Worker use. */
const SolverCore = (() => {
    const DEFAULT_TIMEOUT_MS = 5000;

    /*
     * Shared meeting-time parsing lives in meeting-times.js. The solver is also
     * loaded standalone -- importScripts()'d into a Web Worker that pulls in
     * only this file, and constructed in bare test sandboxes -- so that global
     * is not always present. It is used when present, and the identical logic
     * is kept inline as the fallback. Do not remove the fallback: the worker,
     * which is the solver's real home, runs it.
     */
    const Meeting = (typeof globalThis === 'object' && globalThis.MeetingTimes) || null;

    function integerValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    }

    function finiteNumber(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string' && value.trim() === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function hhmmToMinutes(value) {
        if (Meeting) return Meeting.hhmmToMinutes(value);
        const parsed = integerValue(value);
        if (parsed === null) throw new TypeError(`Invalid HHMM value: ${value}`);
        return Math.trunc(parsed / 100) * 60 + (parsed % 100);
    }

    function parseMeetingTimes(meetingTimes) {
        if (Meeting) return Meeting.parseHHMM(meetingTimes);
        if (!meetingTimes) return [];
        let raw;
        try {
            raw = typeof meetingTimes === 'string' ? JSON.parse(meetingTimes) : meetingTimes;
        } catch (error) {
            return [];
        }
        if (!Array.isArray(raw)) return [];
        const meetings = [];
        for (const meeting of raw) {
            const day = integerValue(meeting?.meet_day);
            const start = integerValue(meeting?.start_time);
            const end = integerValue(meeting?.end_time);
            // Discard the whole array on any bad entry -- deliberate, not a
            // convenience. A schedule must never be built from a section whose
            // meeting times were only half understood.
            if (day === null || start === null || end === null) return [];
            meetings.push({ day, start, end });
        }
        return meetings;
    }

    function attachWalkingLocations(meetings, locations) {
        for (const meeting of meetings) {
            const meetingStart = hhmmToMinutes(meeting.start);
            for (const location of Array.isArray(locations) ? locations : []) {
                const day = integerValue(location?.day);
                const start = integerValue(location?.start);
                const latitude = finiteNumber(location?.latitude);
                const longitude = finiteNumber(location?.longitude);
                if (day === null || start === null
                    || latitude === null || longitude === null) continue;
                if (day !== meeting.day || Math.abs(start - meetingStart) > 5) continue;
                meeting.latitude = latitude;
                meeting.longitude = longitude;
                break;
            }
        }
        return meetings;
    }

    function estimatedWalkMinutes(first, second) {
        const required = ['latitude', 'longitude'];
        if (!required.every(key => Object.hasOwn(first, key) && Object.hasOwn(second, key))) {
            return null;
        }
        const lat1 = Number(first.latitude) * Math.PI / 180;
        const lat2 = Number(second.latitude) * Math.PI / 180;
        const deltaLat = lat2 - lat1;
        const deltaLon = (Number(second.longitude) - Number(first.longitude)) * Math.PI / 180;
        if (![lat1, lat2, deltaLat, deltaLon].every(Number.isFinite)) return null;
        const haversine = Math.sin(deltaLat / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
        const distanceMeters = 6371000 * 2 * Math.asin(Math.sqrt(haversine));
        if (distanceMeters < 15) return 0;
        return Math.max(1, Math.ceil((distanceMeters * 1.25) / 80));
    }

    function isAsynchronous(section) {
        const text = ['meets', 'inst_mthd', 'instructionalMethod', 'instructional_method']
            .map(field => String(section?.[field] ?? ''))
            .join(' ')
            .toLowerCase();
        return ['asynchronous', 'does not meet', 'online', 'distance', 'web', 'dweb', 'b3web']
            .some(marker => text.includes(marker));
    }

    function sectionCredits(section) {
        for (const field of ['hours', 'credits', 'creditHours', 'credit_hours']) {
            const value = section?.[field];
            if (value === null || value === undefined || value === '') continue;
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            const direct = finiteNumber(value);
            if (direct !== null) return direct;
            const values = String(value).replaceAll('-', ' ').split(/\s+/)
                .filter(Boolean)
                .map(Number)
                .filter(Number.isFinite);
            if (values.length > 0) return Math.max(...values);
        }
        return 3;
    }

    function timesOverlap(firstTimes, secondTimes) {
        for (const first of firstTimes) {
            for (const second of secondTimes) {
                if (first.day === second.day
                    && first.start < second.end
                    && second.start < first.end) return true;
            }
        }
        return false;
    }

    function blockedConflict(sectionTimes, blockedTimes) {
        for (const sectionTime of sectionTimes) {
            for (const blocked of blockedTimes) {
                if (sectionTime.day === blocked.day
                    && sectionTime.start < blocked.end
                    && blocked.start < sectionTime.end) return true;
            }
        }
        return false;
    }

    function isConsistent(section, assignment, blockedTimes) {
        if (blockedConflict(section._parsed_times, blockedTimes)) return false;
        return Object.values(assignment)
            .every(assigned => !timesOverlap(section._parsed_times, assigned._parsed_times));
    }

    function normalizedIntegerSet(values) {
        const result = new Set();
        for (const value of Array.isArray(values) ? values : []) {
            const parsed = integerValue(value);
            if (parsed !== null) result.add(parsed);
        }
        return result;
    }

    function requiredPreferencesSatisfied(assignment, preferences = {}) {
        const meetings = Object.values(assignment)
            .flatMap(section => section._parsed_times);

        if (preferences.time_preferences_required) {
            const requiredStart = hhmmToMinutes(preferences.preferred_start ?? 800);
            const requiredEnd = hhmmToMinutes(preferences.preferred_end ?? 2100);
            if (meetings.some(meeting => hhmmToMinutes(meeting.start) < requiredStart
                || hhmmToMinutes(meeting.end) > requiredEnd)) return false;
            if (blockedConflict(meetings, preferences.avoided_time_blocks || [])) return false;
        }

        if (preferences.avoided_days_required) {
            const avoidedDays = normalizedIntegerSet(preferences.avoided_days);
            if (meetings.some(meeting => avoidedDays.has(meeting.day))) return false;
        }

        if (preferences.walking_buffer_required) {
            const configured = integerValue(preferences.minimum_walking_buffer_minutes);
            const requiredBuffer = Math.max(1, configured === null ? 1 : configured);
            const dayMeetings = new Map();
            for (const meeting of meetings) {
                if (!dayMeetings.has(meeting.day)) dayMeetings.set(meeting.day, []);
                dayMeetings.get(meeting.day).push(meeting);
            }
            for (const daySchedule of dayMeetings.values()) {
                const ordered = [...daySchedule].sort((a, b) => a.start - b.start);
                for (let index = 1; index < ordered.length; index += 1) {
                    const first = ordered[index - 1];
                    const second = ordered[index];
                    const gap = hhmmToMinutes(second.start) - hhmmToMinutes(first.end);
                    const walk = estimatedWalkMinutes(first, second) || 0;
                    if (gap - walk < requiredBuffer) return false;
                }
            }
        }

        return true;
    }

    function scoreSchedule(assignment, preferences = {}) {
        let score = 0;
        const allMeetings = [];

        for (const section of Object.values(assignment)) {
            const instructor = (section.instructor || section.instr) || '';
            if (Object.hasOwn(preferences.preferred_instructors || {}, instructor)) {
                score += preferences.preferred_instructors[instructor] * 10;
            }
            if (Object.hasOwn(preferences.avoided_instructors || {}, instructor)) {
                score -= preferences.avoided_instructors[instructor] * 10;
            }
            allMeetings.push(...section._parsed_times);
        }

        if (allMeetings.length === 0) return score;

        const preferredStart = hhmmToMinutes(preferences.preferred_start ?? 800);
        const preferredEnd = hhmmToMinutes(preferences.preferred_end ?? 2100);
        for (const meeting of allMeetings) {
            const start = hhmmToMinutes(meeting.start);
            const end = hhmmToMinutes(meeting.end);
            if (start < preferredStart) score -= 5 * (preferredStart - start) / 60;
            if (end > preferredEnd) score -= 5 * (end - preferredEnd) / 60;

            for (const block of preferences.avoided_time_blocks || []) {
                const blockDay = integerValue(block?.day);
                const blockStartValue = integerValue(block?.start);
                const blockEndValue = integerValue(block?.end);
                if (blockDay === null || blockStartValue === null || blockEndValue === null
                    || blockDay !== meeting.day) continue;
                const blockStart = hhmmToMinutes(blockStartValue);
                const blockEnd = hhmmToMinutes(blockEndValue);
                const overlap = Math.max(0, Math.min(end, blockEnd) - Math.max(start, blockStart));
                score -= 8 * overlap / 30;
            }
        }

        const gapWeight = preferences.gap_penalty_weight ?? 2;
        const compactWeight = preferences.day_compactness_weight ?? 3;
        const consecutiveWeight = preferences.consecutive_penalty_weight ?? 2;
        const configuredBuffer = integerValue(preferences.minimum_walking_buffer_minutes);
        const preferredRemainingTime = Math.max(1, configuredBuffer === null ? 1 : configuredBuffer);
        const activeDays = new Set();
        const dayMeetings = new Map();
        const routeTransitions = [];

        for (const meeting of allMeetings) {
            activeDays.add(meeting.day);
            if (!dayMeetings.has(meeting.day)) dayMeetings.set(meeting.day, []);
            dayMeetings.get(meeting.day).push(meeting);
        }

        score -= compactWeight * activeDays.size;
        const avoidedDays = normalizedIntegerSet(preferences.avoided_days);
        score -= 12 * [...activeDays].filter(day => avoidedDays.has(day)).length;

        for (const meetings of dayMeetings.values()) {
            const ordered = [...meetings].sort((a, b) => a.start - b.start);
            for (let index = 1; index < ordered.length; index += 1) {
                const first = ordered[index - 1];
                const second = ordered[index];
                const gap = hhmmToMinutes(second.start) - hhmmToMinutes(first.end);
                const walk = estimatedWalkMinutes(first, second);
                if (walk !== null) routeTransitions.push({ travel: walk, remaining: gap - walk });
                if (gap > 30) score -= gapWeight * (gap / 60);
                else if (gap >= 0 && gap < 15) score -= consecutiveWeight;
            }
        }

        if (routeTransitions.length > 0) {
            const longestRoute = Math.max(...routeTransitions.map(transition => transition.travel));
            const smallestBuffer = Math.min(...routeTransitions.map(transition => transition.remaining));
            score -= longestRoute * 0.5;
            if (smallestBuffer <= preferredRemainingTime) {
                score -= 30 + 5 * (preferredRemainingTime - smallestBuffer);
            }
        }

        return score;
    }

    function cloneWithoutInternalFields(section) {
        const result = {};
        for (const [key, value] of Object.entries(section)) {
            if (key.startsWith('_')) continue;
            if (Array.isArray(value)) {
                result[key] = value.map(item => (
                    item && typeof item === 'object' ? { ...item } : item
                ));
            } else if (value && typeof value === 'object') {
                result[key] = { ...value };
            } else {
                result[key] = value;
            }
        }
        return result;
    }

    function roundHalfEven(value, digits = 0) {
        if (!Number.isFinite(value)) return value;
        const scale = 10 ** digits;
        const scaled = value * scale;
        const floor = Math.floor(scaled);
        const fraction = scaled - floor;
        const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
        if (Math.abs(fraction - 0.5) <= tolerance) {
            return (floor % 2 === 0 ? floor : floor + 1) / scale;
        }
        return Math.round(scaled) / scale;
    }

    const VERSION = 'sessions-1';
    const CACHE_LIMIT_BYTES = 32 * 1024 * 1024;
    const now = () => typeof performance === 'object' && performance.now
        ? performance.now() : Date.now();

    function onlineSection(section) {
        return /^J/i.test(String(section.section || '').trim())
            || /online|web|remote|distance|asynchronous|does not meet/i.test(
                ['inst_mthd', 'instructionalMethod', 'instructional_method', 'meets']
                    .map(field => String(section[field] || '')).join(' '),
            );
    }

    function assignmentFor(session, chosen) {
        const assignment = {};
        chosen.forEach((sectionIndex, courseIndex) => {
            if (sectionIndex !== null) assignment[session.courses[courseIndex].code]
                = session.courses[courseIndex].sections[sectionIndex];
        });
        return assignment;
    }

    function identityFor(session, refs) {
        // The encoding is reversible and does not introduce hash collisions.
        return JSON.stringify([String(session.params.term || ''), refs.map(([courseIndex, sectionIndex]) => [
            String(session.courses[courseIndex].code),
            String(session.courses[courseIndex].sections[sectionIndex].crn ?? sectionIndex),
        ]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))]);
    }

    function basicMetrics(assignment) {
        const days = new Set();
        const meetings = new Map();
        let earliest = null;
        let online = 0;
        let knownCampusMeetings = 0;
        let unknownCampusMeetings = 0;
        for (const section of Object.values(assignment)) {
            const isOnline = onlineSection(section);
            if (isOnline) online++;
            for (const meeting of section._parsed_times) {
                if (!isOnline) {
                    days.add(meeting.day);
                    if (Number.isFinite(meeting.latitude) && Number.isFinite(meeting.longitude)) knownCampusMeetings++;
                    else unknownCampusMeetings++;
                }
                const start = hhmmToMinutes(meeting.start);
                if (earliest === null || start < earliest) earliest = start;
                if (!meetings.has(meeting.day)) meetings.set(meeting.day, []);
                meetings.get(meeting.day).push(meeting);
            }
        }
        let gaps = 0;
        for (const day of meetings.values()) {
            day.sort((a, b) => a.start - b.start);
            for (let index = 1; index < day.length; index++) {
                gaps += Math.max(0, hhmmToMinutes(day[index].start) - hhmmToMinutes(day[index - 1].end));
            }
        }
        return { campusDays: days.size,
            campusDaysCompleteness: !unknownCampusMeetings ? 'complete' : knownCampusMeetings ? 'partial' : 'missing',
            gaps, laterStart: earliest, online };
    }

    function makeFrame(domains, chosen, credits) {
        return { domains, chosen, credits, course: null, next: 0, pending: null };
    }

    function createSession(params = {}, checkpoint = null) {
        const preferences = params.preferences || {};
        let sectionId = 0;
        const courses = (Array.isArray(params.courses) ? params.courses : []).map(course => ({
            ...course,
            sections: (Array.isArray(course.sections) ? course.sections : []).map(section => {
                const parsed = attachWalkingLocations(parseMeetingTimes(section.meetingTimes || ''), section._walking_locations || []);
                return { ...section, _id: sectionId++, _parsed_times: parsed,
                    _is_async: !parsed.length && isAsynchronous(section), _credits: sectionCredits(section) };
            }),
        }));
        const maxCredits = finiteNumber(preferences.max_credits);
        const domains = courses.map(course => {
            const seen = new Set();
            return course.sections.flatMap((section, index) => {
            const lock = params.section_locks?.[course.code] || preferences.section_locks?.[course.code];
            if (lock && String(section.crn) !== String(lock)) return [];
            if (!section._parsed_times.length && !section._is_async) return [];
            if (blockedConflict(section._parsed_times, preferences.blocked_times || [])) return [];
            // Walking is higher order. It is checked only at a full assignment,
            // because adding an intervening class can repair a previous transition.
            const unaryPreferences = { ...preferences, walking_buffer_required: false };
            if (!requiredPreferencesSatisfied({ [course.code]: section }, unaryPreferences)) return [];
            if (maxCredits !== null && section._credits > maxCredits) return [];
            const identity = String(section.crn ?? index);
            if (seen.has(identity)) return [];
            seen.add(identity);
            return [index];
            });
        });
        // Sharing a possible day/time envelope establishes a constraint edge.
        // Conservative edges affect ordering only and never remove a section.
        const envelopes = courses.map((course, index) => {
            const result = new Map();
            domains[index].forEach(sectionIndex => course.sections[sectionIndex]._parsed_times.forEach(meeting => {
                const existing = result.get(meeting.day);
                result.set(meeting.day, existing
                    ? { start: Math.min(existing.start, meeting.start), end: Math.max(existing.end, meeting.end) }
                    : { start: meeting.start, end: meeting.end });
            }));
            return result;
        });
        const neighbors = courses.map(() => []);
        for (let left = 0; left < courses.length; left++) {
            for (let right = left + 1; right < courses.length; right++) {
                if ([...envelopes[left]].some(([day, range]) => {
                    const other = envelopes[right].get(day);
                    return other && range.start < other.end && other.start < range.end;
                })) {
                    neighbors[left].push(right);
                    neighbors[right].push(left);
                }
            }
        }
        const session = { params, courses, preferences, maxCredits, neighbors, sectionCount: sectionId,
            cache: new Map(), cacheBytes: 0, total_found: 0, visited: 0, complete: domains.some(domain => !domain.length),
            stack: [], session_id: params.session_id || 'local', input_revision: params.input_revision || '' };
        if (checkpoint) {
            if (checkpoint.version !== VERSION || checkpoint.session_id !== session.session_id
                || checkpoint.input_revision !== session.input_revision) throw new Error('Saved solver session does not match these inputs');
            if (!Array.isArray(checkpoint.stack) || !Number.isSafeInteger(checkpoint.total_found)
                || checkpoint.total_found < 0 || !Number.isSafeInteger(checkpoint.visited)
                || checkpoint.visited < 0) throw new Error('Invalid solver checkpoint');
            session.stack = JSON.parse(JSON.stringify(checkpoint.stack));
            session.total_found = checkpoint.total_found;
            session.visited = checkpoint.visited;
            session.complete = Boolean(checkpoint.complete);
        } else if (!session.complete) {
            session.stack.push(makeFrame(domains, courses.map(() => null), 0));
        }
        return session;
    }

    function getCheckpoint(session) {
        return { version: VERSION, session_id: session.session_id, input_revision: session.input_revision,
            total_found: session.total_found, visited: session.visited, complete: session.complete,
            stack: JSON.parse(JSON.stringify(session.stack)) };
    }

    function compatible(session, left, right) {
        const first = Math.min(left._id, right._id);
        const second = Math.max(left._id, right._id);
        const key = first * session.sectionCount + second;
        const chunkIndex = Math.floor(key / 4096);
        const offset = key % 4096;
        let chunk = Number.isSafeInteger(key) ? session.cache.get(chunkIndex) : null;
        const stored = chunk ? (chunk[offset >> 2] >> ((offset & 3) * 2)) & 3 : 0;
        if (stored) return stored === 1;
        const result = !timesOverlap(left._parsed_times, right._parsed_times);
        // The payload is compact (two bits per pair), with a conservative charge
        // for each map entry. Once full, compatibility is computed on demand.
        if (!chunk && Number.isSafeInteger(key) && session.cacheBytes + 1280 <= CACHE_LIMIT_BYTES) {
            chunk = new Uint8Array(1024);
            session.cache.set(chunkIndex, chunk);
            session.cacheBytes += 1280;
        }
        if (chunk) chunk[offset >> 2] |= (result ? 1 : 2) << ((offset & 3) * 2);
        return result;
    }

    function selectCourse(session, frame) {
        let selected = null;
        let degree = -1;
        frame.domains.forEach((domain, index) => {
            if (domain === null) return;
            const currentDegree = session.neighbors[index].filter(neighbor => frame.domains[neighbor] !== null).length;
            if (selected === null || domain.length < frame.domains[selected].length
                || (domain.length === frame.domains[selected].length && (currentDegree > degree
                    || (currentDegree === degree && String(session.courses[index].code)
                        .localeCompare(String(session.courses[selected].code)) < 0)))) {
                selected = index;
                degree = currentDegree;
            }
        });
        return selected;
    }

    function step(session, { budgetMs = 50, maxResults = 250 } = {}) {
        const started = now();
        const deadline = started + Math.min(50, Math.max(0.1, Number(budgetMs) || 50));
        const limit = Math.max(1, Math.min(250, Math.trunc(maxResults) || 250));
        const results = [];
        while (!session.complete && results.length < limit && now() < deadline) {
            const frame = session.stack[session.stack.length - 1];
            if (!frame) { session.complete = true; break; }
            if (frame.pending) {
                const pending = frame.pending;
                if (pending.course >= session.courses.length) {
                    const child = makeFrame(pending.domains, [...frame.chosen], pending.credits);
                    child.chosen[frame.course] = pending.section;
                    frame.pending = null;
                    session.stack.push(child);
                    continue;
                }
                const domain = frame.domains[pending.course];
                if (domain === null || pending.course === frame.course) {
                    pending.domains[pending.course] = null;
                    pending.course++;
                    pending.sectionCursor = 0;
                    continue;
                }
                if (pending.sectionCursor >= domain.length) {
                    if (!pending.domains[pending.course].length) {
                        frame.pending = null;
                        continue;
                    }
                    pending.course++;
                    pending.sectionCursor = 0;
                    continue;
                }
                const candidate = domain[pending.sectionCursor++];
                const first = session.courses[frame.course].sections[pending.section];
                const second = session.courses[pending.course].sections[candidate];
                if ((session.maxCredits === null || pending.credits + second._credits <= session.maxCredits)
                    && compatible(session, first, second)) pending.domains[pending.course].push(candidate);
                continue;
            }
            if (frame.course === null) {
                frame.course = selectCourse(session, frame);
                if (frame.course === null) {
                    const assignment = assignmentFor(session, frame.chosen);
                    session.stack.pop();
                    if (requiredPreferencesSatisfied(assignment, session.preferences)) {
                        const refs = frame.chosen.map((sectionIndex, courseIndex) => [courseIndex, sectionIndex]);
                        session.total_found++;
                        results.push({ id: identityFor(session, refs), ordinal: session.total_found, refs,
                            score: scoreSchedule(assignment, session.preferences), metrics: basicMetrics(assignment) });
                    }
                    continue;
                }
            }
            if (frame.next >= frame.domains[frame.course].length) {
                session.stack.pop();
                continue;
            }
            const sectionIndex = frame.domains[frame.course][frame.next++];
            session.visited++;
            const credits = frame.credits + session.courses[frame.course].sections[sectionIndex]._credits;
            if (session.maxCredits !== null && credits > session.maxCredits) continue;
            frame.pending = { section: sectionIndex, credits, course: 0, sectionCursor: 0,
                domains: frame.domains.map(domain => domain === null ? null : []) };
        }
        if (!session.stack.length) session.complete = true;
        return { results, checkpoint: getCheckpoint(session), complete: session.complete,
            total_found: session.total_found, visited: session.visited, active_ms: now() - started };
    }

    function materializeResult(params, result) {
        return { ...result, sections: Object.fromEntries(result.refs.map(([courseIndex, sectionIndex]) => [
            params.courses[courseIndex].code, cloneWithoutInternalFields(params.courses[courseIndex].sections[sectionIndex]),
        ])) };
    }

    function solve(params = {}) {
        const session = createSession(params);
        const maxResults = Math.max(0, integerValue(params.max_results) ?? 10);
        const duration = Math.max(0, finiteNumber(params.timeout_ms) ?? DEFAULT_TIMEOUT_MS);
        const deadline = now() + duration;
        const retained = [];
        while (!session.complete && now() < deadline) {
            const batch = step(session, { budgetMs: Math.min(50, deadline - now()), maxResults: 250 });
            for (const result of batch.results) {
                retained.push(result);
                retained.sort((a, b) => b.score - a.score || a.ordinal - b.ordinal);
                if (retained.length > maxResults) retained.pop();
            }
        }
        return { total_found: session.total_found, search_complete: session.complete,
            returned: retained.length, schedules: retained.map(result => {
                const schedule = materializeResult(params, result);
                schedule.score = roundHalfEven(schedule.score, 2);
                return schedule;
            }) };
    }

    return {
        VERSION,
        CACHE_LIMIT_BYTES,
        createSession,
        getCheckpoint,
        step,
        materializeResult,
        onlineSection,
        hhmmToMinutes,
        parseMeetingTimes,
        attachWalkingLocations,
        estimatedWalkMinutes,
        isAsynchronous,
        sectionCredits,
        timesOverlap,
        blockedConflict,
        requiredPreferencesSatisfied,
        scoreSchedule,
        solve,
    };
})();

if (typeof module === 'object' && module.exports) module.exports = SolverCore;
if (typeof globalThis === 'object') globalThis.SolverCore = SolverCore;
