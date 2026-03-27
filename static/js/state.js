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
    preferredStart: 800,
    preferredEnd: 2100,
    gapWeight: 2,
    compactWeight: 3,
    consecWeight: 2,
    solverResults: [],
    activeSolverSchedule: null,
    savedPlans: {},
    currentPlan: 'Plan A',
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
        document.getElementById('term-select').value = this.term;
        this.emit('sections-changed', this.selectedSections);
        this.emit('preferences-changed');
        return true;
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
