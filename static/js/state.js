/* Central state management with localStorage persistence */
const State = {
    term: '202608',
    selectedCourses: {},     // { courseCode: {code, title, sections} }
    selectedSections: {},    // { courseCode: sectionObj }
    sectionLocks: {},        // { courseCode: crn }
    searchResults: [],       // raw API results
    courseGroups: [],         // grouped by course code
    blockedTimes: [],        // [{day, start, end}]
    preferredInstructors: {},  // {name: weight}
    avoidedInstructors: {},    // {name: weight}
    completedCourses: [],
    completedDetails: [],    // [{code, grade, credits, semester}]
    manualCompletedDetails: [],
    transcriptAttempts: [],
    preferredStart: 800,
    preferredEnd: 2100,
    avoidedDays: [],
    avoidedTimeBlocks: [],
    minimumWalkingBuffer: 1,
    timePreferencesRequired: false,
    walkingBufferRequired: false,
    avoidedDaysRequired: false,
    gapWeight: 2,
    compactWeight: 3,
    consecWeight: 2,
    solverResults: [],
    activeSolverSchedule: null,
    savedPlans: {},
    currentPlan: 'Plan A',

    // Profile state
    profile: {
        major: null,           // major map ID
        majorData: null,       // loaded major map object
        concentration: 'general',
        startTerm: '202608',
        planMode: 'full_time',
        customCredits: { min: 12, max: 18, target: 15 },
        includeSummer: false,
    },

    // Degree plan state
    degreePlan: {
        completedSemesters: [],  // [{term, label, courses: [{code, title, credits}], total_credits, type: 'completed'|'current'}]
        completedCollapsed: false,
        semesters: [],
        warnings: [],
        totalRemaining: 0,
        completedCredits: 0,
        estimatedGraduation: '',
        categories: {},
        pins: {},             // {courseCode: termCode}
    },

    _listeners: {},

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
    },

    emit(event, data) {
        (this._listeners[event] || []).forEach(fn => fn(data));
    },

    addSection(section) {
        const code = section.code;
        this.selectedSections[code] = section;
        this.emit('sections-changed', this.selectedSections);
    },

    removeSection(code) {
        delete this.selectedSections[code];
        this.emit('sections-changed', this.selectedSections);
    },

    toggleSection(section) {
        const code = section.code;
        if (this.selectedSections[code] && this.selectedSections[code].crn === section.crn) {
            this.removeSection(code);
        } else {
            this.addSection(section);
        }
    },

    isSelected(crn) {
        return Object.values(this.selectedSections).some(s => s.crn === crn);
    },

    addCourse(group) {
        if (!group || !group.code) return;
        this.selectedCourses[group.code] = JSON.parse(JSON.stringify({
            code: group.code,
            title: group.title || group.code,
            credits: group.credits,
            sections: group.sections || [],
        }));
        this.emit('courses-changed', this.selectedCourses);
    },

    removeCourse(code) {
        delete this.selectedCourses[code];
        delete this.sectionLocks[code];
        if (this.selectedSections[code]) {
            delete this.selectedSections[code];
            this.emit('sections-changed', this.selectedSections);
        }
        this.emit('courses-changed', this.selectedCourses);
        this.emit('section-locks-changed', this.sectionLocks);
    },

    toggleCourse(group) {
        if (this.selectedCourses[group.code]) this.removeCourse(group.code);
        else this.addCourse(group);
    },

    isCourseSelected(code) {
        return Boolean(this.selectedCourses[code]);
    },

    setSectionLock(code, crn) {
        if (crn) this.sectionLocks[code] = String(crn);
        else delete this.sectionLocks[code];
        this.emit('section-locks-changed', this.sectionLocks);
    },

    getPreferences() {
        return {
            blocked_times: this.blockedTimes,
            preferred_instructors: this.preferredInstructors,
            avoided_instructors: this.avoidedInstructors,
            preferred_start: this.preferredStart,
            preferred_end: this.preferredEnd,
            avoided_days: [...this.avoidedDays],
            avoided_time_blocks: this.avoidedTimeBlocks.map(block => ({ ...block })),
            minimum_walking_buffer_minutes: Math.max(1, Number(this.minimumWalkingBuffer) || 1),
            time_preferences_required: Boolean(this.timePreferencesRequired),
            walking_buffer_required: Boolean(this.walkingBufferRequired),
            avoided_days_required: Boolean(this.avoidedDaysRequired),
            gap_penalty_weight: this.gapWeight,
            day_compactness_weight: this.compactWeight,
            consecutive_penalty_weight: this.consecWeight,
        };
    },

    _normalizeCourseCode(value) {
        const match = String(value || '').trim().toUpperCase().match(/^([A-Z]{2,5})\s*([0-9]{3}[A-Z]?)$/);
        return match ? `${match[1]} ${match[2]}` : '';
    },

    _safeString(value, maxLength = 240) {
        if (value === null || value === undefined) return null;
        const text = String(value).replace(/\s+/g, ' ').trim();
        return text ? text.slice(0, maxLength) : null;
    },

    _finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    },

    _normalizeManualDetail(record) {
        const code = this._normalizeCourseCode(record?.code || record?.course);
        if (!code) return null;
        return {
            code,
            title: this._safeString(record?.title),
            grade: this._safeString(record?.grade || record?.normalized_grade, 24),
            credits: this._finiteNumber(record?.credits ?? record?.credit_hours),
            semester: this._safeString(record?.semester || record?.term, 80),
            status: 'completed',
            counts_as_completed: true,
            source: 'manual',
        };
    },

    _normalizeTranscriptAttempt(record, level = null) {
        const code = this._normalizeCourseCode(record?.code || record?.course);
        if (!code) return null;
        const [subject, courseNumber] = code.split(' ');
        const normalizedLevel = this._safeString(record?.level || level, 24);
        const normalized = {
            attempt_id: this._safeString(record?.attempt_id, 320),
            code,
            subject,
            course_number: courseNumber,
            title: this._safeString(record?.title),
            term: this._safeString(record?.term || record?.semester, 80),
            level: normalizedLevel,
            raw_grade: this._safeString(record?.raw_grade || record?.grade, 24),
            normalized_grade: this._safeString(record?.normalized_grade || record?.grade, 24),
            credit_hours: this._finiteNumber(record?.credit_hours ?? record?.credits),
            attempted_credits: this._finiteNumber(record?.attempted_credits),
            earned_credits: this._finiteNumber(record?.earned_credits),
            quality_points: this._finiteNumber(record?.quality_points),
            source: this._safeString(record?.source, 32) || 'unknown',
            transfer_institution: this._safeString(record?.transfer_institution),
            repeat: {
                indicator: this._safeString(record?.repeat?.indicator, 12),
                repeated: Boolean(record?.repeat?.repeated),
                excluded: Boolean(record?.repeat?.excluded),
            },
            status: this._safeString(record?.status, 32) || 'unknown',
            counts_as_completed: record?.counts_as_completed === true
                ? true
                : record?.counts_as_completed === false ? false : null,
            confidence: {
                score: this._finiteNumber(record?.confidence?.score),
                level: this._safeString(record?.confidence?.level, 16),
            },
            needs_review: Boolean(record?.needs_review),
            imported_level: normalizedLevel,
        };
        normalized.import_key = this._transcriptAttemptKey(normalized);
        return normalized;
    },

    _transcriptAttemptKey(record) {
        return [
            record?.level || record?.imported_level || '',
            record?.source || '',
            record?.term || '',
            record?.code || '',
            record?.attempt_id || '',
            record?.normalized_grade || record?.raw_grade || '',
            record?.credit_hours ?? '',
            record?.quality_points ?? '',
            record?.repeat?.indicator || '',
        ].map(value => encodeURIComponent(String(value))).join('|');
    },

    _legacyManualDetails(completedCourses = [], completedDetails = []) {
        const byCode = new Map();
        (completedDetails || []).forEach(record => {
            const normalized = this._normalizeManualDetail(record);
            if (normalized) byCode.set(normalized.code, normalized);
        });
        (completedCourses || []).forEach(code => {
            const normalizedCode = this._normalizeCourseCode(code);
            if (normalizedCode && !byCode.has(normalizedCode)) {
                byCode.set(normalizedCode, this._normalizeManualDetail({ code: normalizedCode }));
            }
        });
        return [...byCode.values()].filter(Boolean);
    },

    rebuildCompletedCourseState() {
        const completedByCode = new Map();
        this.manualCompletedDetails = (this.manualCompletedDetails || [])
            .map(record => this._normalizeManualDetail(record))
            .filter(Boolean);
        this.transcriptAttempts = (this.transcriptAttempts || [])
            .map(record => this._normalizeTranscriptAttempt(record, record?.imported_level))
            .filter(Boolean);

        for (const record of this.manualCompletedDetails) {
            if (record.counts_as_completed !== true) continue;
            completedByCode.set(record.code, { ...record });
        }
        for (const attempt of this.transcriptAttempts) {
            if (attempt.counts_as_completed !== true) continue;
            completedByCode.set(attempt.code, {
                code: attempt.code,
                title: attempt.title,
                grade: attempt.normalized_grade || attempt.raw_grade,
                credits: attempt.earned_credits ?? attempt.credit_hours,
                semester: attempt.term,
                status: attempt.status,
                counts_as_completed: true,
                source: attempt.source,
                transcript_attempt_key: attempt.import_key,
            });
        }
        this.completedCourses = [...completedByCode.keys()].sort();
        this.completedDetails = [...completedByCode.values()];
        return this.completedCourses;
    },

    addManualCompletedRecords(records) {
        const existing = new Map((this.manualCompletedDetails || [])
            .map(record => this._normalizeManualDetail(record))
            .filter(Boolean)
            .map(record => [record.code, record]));
        (records || []).forEach(record => {
            const normalized = this._normalizeManualDetail(record);
            if (normalized) existing.set(normalized.code, normalized);
        });
        this.manualCompletedDetails = [...existing.values()];
        this.rebuildCompletedCourseState();
        this.emit('transcript-updated', { source: 'manual' });
        this.emit('profile-updated');
    },

    replaceCompletedWithManualRecords(records) {
        this.transcriptAttempts = [];
        this.manualCompletedDetails = (records || [])
            .map(record => this._normalizeManualDetail(record))
            .filter(Boolean);
        this.rebuildCompletedCourseState();
        this.emit('transcript-updated', { source: 'manual', mode: 'replace' });
        this.emit('profile-updated');
    },

    removeCompletedCourse(code) {
        const normalizedCode = this._normalizeCourseCode(code);
        if (!normalizedCode) return;
        this.manualCompletedDetails = (this.manualCompletedDetails || [])
            .filter(record => this._normalizeCourseCode(record.code) !== normalizedCode);
        this.transcriptAttempts = (this.transcriptAttempts || [])
            .filter(record => this._normalizeCourseCode(record.code) !== normalizedCode);
        this.rebuildCompletedCourseState();
        this.emit('transcript-updated', { source: 'profile', removed: normalizedCode });
        this.emit('profile-updated');
    },

    transcriptSnapshot() {
        return {
            transcriptAttempts: JSON.parse(JSON.stringify(this.transcriptAttempts || [])),
            manualCompletedDetails: JSON.parse(JSON.stringify(this.manualCompletedDetails || [])),
        };
    },

    restoreTranscriptSnapshot(snapshot) {
        this.transcriptAttempts = (snapshot?.transcriptAttempts || [])
            .map(record => this._normalizeTranscriptAttempt(record, record?.imported_level))
            .filter(Boolean);
        this.manualCompletedDetails = (snapshot?.manualCompletedDetails || [])
            .map(record => this._normalizeManualDetail(record))
            .filter(Boolean);
        this.rebuildCompletedCourseState();
        this.emit('transcript-updated', { source: 'undo' });
        this.emit('profile-updated');
    },

    applyTranscriptAttempts(records, { mode = 'merge', level = null } = {}) {
        const snapshot = this.transcriptSnapshot();
        const incoming = (records || [])
            .map(record => this._normalizeTranscriptAttempt(record, level))
            .filter(Boolean);
        const existing = mode === 'replace' ? [] : this.transcriptAttempts || [];
        if (mode === 'replace') this.manualCompletedDetails = [];
        const byKey = new Map(existing.map(record => {
            const normalized = this._normalizeTranscriptAttempt(record, record?.imported_level);
            return [normalized.import_key, normalized];
        }));
        let added = 0;
        incoming.forEach(record => {
            if (!byKey.has(record.import_key)) added += 1;
            byKey.set(record.import_key, record);
        });
        this.transcriptAttempts = [...byKey.values()];
        this.rebuildCompletedCourseState();
        this.emit('transcript-updated', {
            source: 'pdf',
            mode,
            level,
            added,
            total: this.transcriptAttempts.length,
        });
        this.emit('profile-updated');
        return {
            snapshot,
            added,
            duplicates: incoming.length - added,
            attempts: this.transcriptAttempts.length,
            completedCourses: this.completedCourses.length,
        };
    },

    savePlan() {
        this.savedPlans[this.currentPlan] = {
            term: this.term,
            courses: JSON.parse(JSON.stringify(this.selectedCourses)),
            sections: JSON.parse(JSON.stringify(this.selectedSections)),
            sectionLocks: { ...this.sectionLocks },
            blockedTimes: [...this.blockedTimes],
            preferredInstructors: { ...this.preferredInstructors },
            avoidedInstructors: { ...this.avoidedInstructors },
            preferredStart: this.preferredStart,
            preferredEnd: this.preferredEnd,
            avoidedDays: [...this.avoidedDays],
            avoidedTimeBlocks: this.avoidedTimeBlocks.map(block => ({ ...block })),
            minimumWalkingBuffer: this.minimumWalkingBuffer,
            timePreferencesRequired: this.timePreferencesRequired,
            walkingBufferRequired: this.walkingBufferRequired,
            avoidedDaysRequired: this.avoidedDaysRequired,
            completedCourses: [...this.completedCourses],
            completedDetails: JSON.parse(JSON.stringify(this.completedDetails)),
            manualCompletedDetails: JSON.parse(JSON.stringify(this.manualCompletedDetails)),
            transcriptAttempts: JSON.parse(JSON.stringify(this.transcriptAttempts)),
            profile: JSON.parse(JSON.stringify(this.profile)),
            degreePlan: JSON.parse(JSON.stringify(this.degreePlan)),
        };
        this._persist();
    },

    loadPlan(name) {
        const plan = this.savedPlans[name];
        if (!plan) return false;
        this.currentPlan = name;
        this.term = plan.term || this.term;
        this.selectedSections = JSON.parse(JSON.stringify(plan.sections || {}));
        this.selectedCourses = JSON.parse(JSON.stringify(plan.courses || {}));
        this.sectionLocks = { ...(plan.sectionLocks || {}) };
        if (Object.keys(this.selectedCourses).length === 0) {
            Object.entries(this.selectedSections).forEach(([code, section]) => {
                this.selectedCourses[code] = {
                    code,
                    title: section.title || code,
                    sections: [section],
                };
            });
        }
        this.blockedTimes = plan.blockedTimes || [];
        this.preferredInstructors = plan.preferredInstructors || {};
        this.avoidedInstructors = plan.avoidedInstructors || {};
        this.preferredStart = plan.preferredStart ?? this.preferredStart;
        this.preferredEnd = plan.preferredEnd ?? this.preferredEnd;
        this.avoidedDays = plan.avoidedDays || [];
        this.avoidedTimeBlocks = (plan.avoidedTimeBlocks || []).map(block => ({ ...block }));
        this.minimumWalkingBuffer = Math.max(1, Number(plan.minimumWalkingBuffer) || 1);
        this.timePreferencesRequired = Boolean(plan.timePreferencesRequired);
        this.walkingBufferRequired = Boolean(plan.walkingBufferRequired);
        this.avoidedDaysRequired = Boolean(plan.avoidedDaysRequired);
        this.transcriptAttempts = (plan.transcriptAttempts || [])
            .map(record => this._normalizeTranscriptAttempt(record, record?.imported_level))
            .filter(Boolean);
        this.manualCompletedDetails = plan.manualCompletedDetails
            ? plan.manualCompletedDetails.map(record => this._normalizeManualDetail(record)).filter(Boolean)
            : this._legacyManualDetails(plan.completedCourses, plan.completedDetails);
        this.rebuildCompletedCourseState();
        if (plan.profile) {
            this.profile = JSON.parse(JSON.stringify(plan.profile));
        }
        if (plan.degreePlan) {
            this.degreePlan = JSON.parse(JSON.stringify(plan.degreePlan));
        }
        const termSelect = typeof document !== 'undefined'
            ? document.getElementById('term-select')
            : null;
        if (termSelect) termSelect.value = this.term;
        this.emit('sections-changed', this.selectedSections);
        this.emit('courses-changed', this.selectedCourses);
        this.emit('section-locks-changed', this.sectionLocks);
        this.emit('preferences-changed');
        this.emit('transcript-updated', { source: 'plan-load' });
        this.emit('profile-updated');
        this.emit('degree-plan-updated');
        return true;
    },

    deletePlan(name) {
        delete this.savedPlans[name];
        this._persist();
    },

    listPlans() {
        return Object.keys(this.savedPlans);
    },

    _persist() {
        try {
            localStorage.setItem('uosc-scheduler-plans', JSON.stringify(this.savedPlans));
        } catch (e) { /* ignore */ }
    },

    _restore() {
        try {
            const data = localStorage.getItem('uosc-scheduler-plans');
            if (data) this.savedPlans = JSON.parse(data);
        } catch (e) { /* ignore */ }
    },

    exportToJSON() {
        return JSON.stringify({
            version: 5,
            term: this.term,
            selectedCourses: this.selectedCourses,
            selectedSections: this.selectedSections,
            sectionLocks: this.sectionLocks,
            blockedTimes: this.blockedTimes,
            preferredInstructors: this.preferredInstructors,
            avoidedInstructors: this.avoidedInstructors,
            preferredStart: this.preferredStart,
            preferredEnd: this.preferredEnd,
            avoidedDays: this.avoidedDays,
            minimumWalkingBuffer: this.minimumWalkingBuffer,
            completedCourses: this.completedCourses,
            completedDetails: this.completedDetails,
            manualCompletedDetails: this.manualCompletedDetails,
            transcriptAttempts: this.transcriptAttempts,
            profile: this.profile,
            degreePlan: this.degreePlan,
        }, null, 2);
    },

    importFromJSON(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            if (data.term) this.term = data.term;
            if (data.selectedSections) this.selectedSections = data.selectedSections;
            this.selectedCourses = data.selectedCourses || {};
            this.sectionLocks = data.sectionLocks || {};
            if (Object.keys(this.selectedCourses).length === 0) {
                Object.entries(this.selectedSections).forEach(([code, section]) => {
                    this.selectedCourses[code] = {
                        code,
                        title: section.title || code,
                        sections: [section],
                    };
                });
            }
            if (data.blockedTimes) this.blockedTimes = data.blockedTimes;
            if (data.preferredInstructors) this.preferredInstructors = data.preferredInstructors;
            if (data.avoidedInstructors) this.avoidedInstructors = data.avoidedInstructors;
            if (data.preferredStart !== undefined) this.preferredStart = data.preferredStart;
            if (data.preferredEnd !== undefined) this.preferredEnd = data.preferredEnd;
            if (data.avoidedDays) this.avoidedDays = data.avoidedDays;
            if (data.minimumWalkingBuffer !== undefined) {
                this.minimumWalkingBuffer = Math.max(1, Number(data.minimumWalkingBuffer) || 1);
            }
            this.transcriptAttempts = (data.transcriptAttempts || [])
                .map(record => this._normalizeTranscriptAttempt(record, record?.imported_level))
                .filter(Boolean);
            this.manualCompletedDetails = data.manualCompletedDetails
                ? data.manualCompletedDetails.map(record => this._normalizeManualDetail(record)).filter(Boolean)
                : this._legacyManualDetails(data.completedCourses, data.completedDetails);
            this.rebuildCompletedCourseState();
            if (data.profile) this.profile = data.profile;
            if (data.degreePlan) this.degreePlan = data.degreePlan;
            this.emit('sections-changed', this.selectedSections);
            this.emit('courses-changed', this.selectedCourses);
            this.emit('section-locks-changed', this.sectionLocks);
            this.emit('preferences-changed');
            this.emit('transcript-updated', { source: 'json-import' });
            this.emit('profile-updated');
            this.emit('degree-plan-updated');
            return true;
        } catch (e) {
            return false;
        }
    },

    applySolverSchedule(schedule) {
        this.selectedSections = {};
        for (const [code, sec] of Object.entries(schedule.sections)) {
            sec._parsed_times = sec._parsed_times || [];
            this.selectedSections[code] = sec;
        }
        this.activeSolverSchedule = schedule;
        this.emit('sections-changed', this.selectedSections);
    },
};

// Restore on load
State._restore();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = State;
}
