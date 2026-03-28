/* Central state management with localStorage persistence */
const State = {
    term: '202608',
    selectedSections: {},    // { courseCode: sectionObj }
    searchResults: [],       // raw API results
    courseGroups: [],         // grouped by course code
    blockedTimes: [],        // [{day, start, end}]
    preferredInstructors: {},  // {name: weight}
    avoidedInstructors: {},    // {name: weight}
    completedCourses: [],
    completedDetails: [],    // [{code, grade, credits, semester}]
    preferredStart: 800,
    preferredEnd: 2100,
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

    getPreferences() {
        return {
            blocked_times: this.blockedTimes,
            preferred_instructors: this.preferredInstructors,
            avoided_instructors: this.avoidedInstructors,
            preferred_start: this.preferredStart,
            preferred_end: this.preferredEnd,
            gap_penalty_weight: this.gapWeight,
            day_compactness_weight: this.compactWeight,
            consecutive_penalty_weight: this.consecWeight,
        };
    },

    savePlan() {
        this.savedPlans[this.currentPlan] = {
            term: this.term,
            sections: JSON.parse(JSON.stringify(this.selectedSections)),
            blockedTimes: [...this.blockedTimes],
            preferredInstructors: { ...this.preferredInstructors },
            avoidedInstructors: { ...this.avoidedInstructors },
            completedCourses: [...this.completedCourses],
            completedDetails: JSON.parse(JSON.stringify(this.completedDetails)),
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
        this.blockedTimes = plan.blockedTimes || [];
        this.preferredInstructors = plan.preferredInstructors || {};
        this.avoidedInstructors = plan.avoidedInstructors || {};
        this.completedCourses = plan.completedCourses || [];
        this.completedDetails = plan.completedDetails || [];
        if (plan.profile) {
            this.profile = JSON.parse(JSON.stringify(plan.profile));
        }
        if (plan.degreePlan) {
            this.degreePlan = JSON.parse(JSON.stringify(plan.degreePlan));
        }
        const termSelect = document.getElementById('term-select');
        if (termSelect) termSelect.value = this.term;
        this.emit('sections-changed', this.selectedSections);
        this.emit('preferences-changed');
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
            version: 2,
            term: this.term,
            selectedSections: this.selectedSections,
            blockedTimes: this.blockedTimes,
            preferredInstructors: this.preferredInstructors,
            avoidedInstructors: this.avoidedInstructors,
            completedCourses: this.completedCourses,
            completedDetails: this.completedDetails,
            profile: this.profile,
            degreePlan: this.degreePlan,
        }, null, 2);
    },

    importFromJSON(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            if (data.term) this.term = data.term;
            if (data.selectedSections) this.selectedSections = data.selectedSections;
            if (data.blockedTimes) this.blockedTimes = data.blockedTimes;
            if (data.preferredInstructors) this.preferredInstructors = data.preferredInstructors;
            if (data.avoidedInstructors) this.avoidedInstructors = data.avoidedInstructors;
            if (data.completedCourses) this.completedCourses = data.completedCourses;
            if (data.completedDetails) this.completedDetails = data.completedDetails;
            if (data.profile) this.profile = data.profile;
            if (data.degreePlan) this.degreePlan = data.degreePlan;
            this.emit('sections-changed', this.selectedSections);
            this.emit('preferences-changed');
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
