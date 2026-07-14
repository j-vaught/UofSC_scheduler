/* Solver frontend glue */
const Scheduler = {
    _courseGroupCache: {},
    _cacheTerm: null,

    init() {
        document.getElementById('btn-solve').addEventListener('click', () => this.solve());
        this._cacheTerm = State.term;
        State.on('sections-changed', () => this.captureSelectedCourseGroups());
        this.captureSelectedCourseGroups();
    },

    captureSelectedCourseGroups() {
        if (this._cacheTerm !== State.term) {
            this._courseGroupCache = {};
            this._cacheTerm = State.term;
        }

        const selectedCodes = new Set(Object.keys(State.selectedSections || {}));
        Object.keys(this._courseGroupCache).forEach(code => {
            if (!selectedCodes.has(code)) delete this._courseGroupCache[code];
        });

        const visibleGroups = new Map((State.courseGroups || []).map(group => [group.code, group]));
        selectedCodes.forEach(code => {
            if (visibleGroups.has(code)) {
                const group = visibleGroups.get(code);
                const sections = [...(group.sections || [])];
                const selected = State.selectedSections[code];
                if (selected && !sections.some(section => section.crn === selected.crn)) {
                    sections.push(selected);
                }
                this._courseGroupCache[code] = {
                    ...group,
                    sections,
                };
            } else if (!this._courseGroupCache[code]) {
                this._courseGroupCache[code] = {
                    code,
                    title: State.selectedSections[code].title || code,
                    sections: [State.selectedSections[code]],
                };
            }
        });
    },

    isSchedulableSection(section) {
        if (section.meetingTimes) return true;
        const description = [
            section.meets,
            section.inst_mthd,
            section.instructionalMethod,
            section.instructional_method,
        ].filter(Boolean).join(' ').toLowerCase();
        return ['asynchronous', 'does not meet', 'online', 'distance', 'web', 'dweb', 'b3web']
            .some(marker => description.includes(marker));
    },

    async solve() {
        this.captureSelectedCourseGroups();
        const courseGroups = Object.keys(State.selectedSections || {})
            .map(code => this._courseGroupCache[code])
            .filter(Boolean);
        if (!courseGroups || courseGroups.length === 0) {
            alert('Add the courses you want to schedule first, then click Solve.');
            return;
        }

        // Ensure we're on the Schedule tab
        if (typeof Tabs !== 'undefined') Tabs.switchTo('schedule');

        const container = document.getElementById('solver-container');
        container.innerHTML = '<p class="loading">Generating optimal schedules</p>';

        // Build course list for solver
        const courses = courseGroups.map(g => ({
            code: g.code,
            sections: g.sections.filter(s => this.isSchedulableSection(s)),
        }));

        const unschedulable = courses.filter(course => course.sections.length === 0);
        if (unschedulable.length > 0) {
            const codes = unschedulable.map(course => course.code).join(', ');
            container.innerHTML = `<p class="hint">No scheduled or asynchronous sections were found for ${codes}. Search that course in the selected term and choose a section before solving.</p>`;
            return;
        }

        const preferences = State.getPreferences();
        const configuredMax = State.profile?.customCredits?.max;
        preferences.max_credits = Number.isFinite(Number(configuredMax)) ? Number(configuredMax) : 18;

        try {
            const result = await API.solve(courses, preferences);
            State.solverResults = result.schedules || [];
            this.renderResults(result, container);
        } catch (err) {
            container.innerHTML = `<p class="hint">Solver error: ${err.message}</p>`;
        }
    },

    renderResults(result, container) {
        const { total_found, returned, schedules } = result;

        if (!schedules || schedules.length === 0) {
            container.innerHTML = '<p class="hint">No conflict-free schedules found. Try removing some courses or adjusting preferences.</p>';
            return;
        }

        let html = `<p style="font-size:0.8rem;color:#888;margin-bottom:8px">Found ${total_found} valid schedules, showing top ${returned}</p>`;

        schedules.forEach((sched, idx) => {
            const courses = Object.entries(sched.sections);
            const courseList = courses.map(([code, sec]) =>
                `${code} (${sec.section || '?'}) - ${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')} ${sec.meets || ''}`
            ).join('<br>');

            html += `
                <div class="schedule-card" data-idx="${idx}">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                        <span class="score">Schedule #${idx + 1} &mdash; Score: ${sched.score}</span>
                        <button class="btn-apply" data-idx="${idx}" style="font-size:0.75rem">Apply</button>
                    </div>
                    <div class="sched-courses">${courseList}</div>
                </div>
            `;
        });

        container.innerHTML = html;

        // Bind apply buttons
        container.querySelectorAll('.btn-apply').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx);
                this.applySchedule(idx);
            });
        });

        // Bind card clicks for preview
        container.querySelectorAll('.schedule-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = parseInt(card.dataset.idx);
                this.previewSchedule(idx);

                container.querySelectorAll('.schedule-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
            });
        });
    },

    previewSchedule(idx) {
        const sched = State.solverResults[idx];
        if (!sched) return;
        if (typeof Calendar === 'undefined' || typeof Calendar.render !== 'function') return;

        const selectedSections = State.selectedSections;
        State.selectedSections = { ...sched.sections };
        Calendar.render();
        State.selectedSections = selectedSections;
    },

    applySchedule(idx) {
        const sched = State.solverResults[idx];
        if (!sched) return;
        State.applySolverSchedule(sched);
    },
};
