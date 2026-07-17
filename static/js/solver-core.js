/* Browser-native semester schedule solver. Kept dependency-free for Web Worker use. */
const SolverCore = (() => {
    const DEFAULT_TIMEOUT_MS = 5000;

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
        const parsed = integerValue(value);
        if (parsed === null) throw new TypeError(`Invalid HHMM value: ${value}`);
        return Math.trunc(parsed / 100) * 60 + (parsed % 100);
    }

    function parseMeetingTimes(meetingTimes) {
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
            const instructor = section.instr || '';
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

    function solve(params = {}) {
        const courses = Array.isArray(params.courses) ? params.courses : [];
        const preferences = params.preferences || {};
        const configuredMaxResults = integerValue(params.max_results);
        const maxResults = configuredMaxResults === null ? 10 : Math.max(0, configuredMaxResults);
        const blockedTimes = Array.isArray(preferences.blocked_times)
            ? preferences.blocked_times : [];
        const parsedMaxCredits = preferences.max_credits === null
            || preferences.max_credits === undefined
            ? null : Number(preferences.max_credits);
        const maxCredits = Number.isFinite(parsedMaxCredits) ? parsedMaxCredits : null;

        const preparedCourses = courses.map((course, originalIndex) => ({
            ...course,
            _original_index: originalIndex,
            sections: (Array.isArray(course.sections) ? course.sections : []).map(section => {
                const parsedTimes = attachWalkingLocations(
                    parseMeetingTimes(section.meetingTimes || ''),
                    section._walking_locations || [],
                );
                return {
                    ...section,
                    _parsed_times: parsedTimes,
                    _is_async: parsedTimes.length === 0 && isAsynchronous(section),
                    _credits: sectionCredits(section),
                };
            }),
        }));
        const sortedCourses = [...preparedCourses].sort((first, second) => (
            first.sections.length - second.sections.length
            || first._original_index - second._original_index
        ));

        const solutions = [];
        const target = maxResults * 3;
        const deadline = Date.now() + DEFAULT_TIMEOUT_MS;

        function backtrack(index, assignment, assignedCredits) {
            if (Date.now() > deadline) return true;
            if (index === sortedCourses.length) {
                if (requiredPreferencesSatisfied(assignment, preferences)) {
                    solutions.push({ ...assignment });
                }
                return solutions.length >= target;
            }

            const course = sortedCourses[index];
            for (const section of course.sections) {
                if (section._parsed_times.length === 0 && !section._is_async) continue;
                const nextCredits = assignedCredits + section._credits;
                if (maxCredits !== null && nextCredits > maxCredits) continue;
                if (!isConsistent(section, assignment, blockedTimes)) continue;
                assignment[course.code] = section;
                if (backtrack(index + 1, assignment, nextCredits)) return true;
                delete assignment[course.code];
            }
            return false;
        }

        backtrack(0, {}, 0);
        const schedules = solutions.map((solution, originalIndex) => ({
            sections: Object.fromEntries(Object.entries(solution)
                .map(([code, section]) => [code, cloneWithoutInternalFields(section)])),
            score: roundHalfEven(scoreSchedule(solution, preferences), 2),
            _original_index: originalIndex,
        }));
        schedules.sort((first, second) => second.score - first.score
            || first._original_index - second._original_index);
        schedules.forEach(schedule => { delete schedule._original_index; });

        return {
            total_found: solutions.length,
            returned: Math.min(maxResults, schedules.length),
            schedules: schedules.slice(0, maxResults),
        };
    }

    return {
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
