/* Course-level schedule builder and solver frontend glue */
const Scheduler = {
    init() {
        document.getElementById('btn-solve').addEventListener('click', () => this.solve());
        document.getElementById('btn-add-schedule-course').addEventListener('click', () => this.addCourseFromInput());
        document.getElementById('schedule-course-input').addEventListener('keydown', event => {
            if (event.key === 'Enter') this.addCourseFromInput();
        });
        State.on('courses-changed', () => this.clearResults());
    },

    normalizeCourseCode(value) {
        return String(value || '')
            .trim()
            .toUpperCase()
            .replace(/([A-Z]{2,4})\s*-?\s*(\d{3}[A-Z]?)/, '$1 $2');
    },

    setCourseStatus(message, kind = '') {
        const status = document.getElementById('schedule-course-status');
        if (!status) return;
        status.textContent = message;
        status.className = `schedule-course-status ${kind}`.trim();
    },

    async lookupCourseGroup(courseCode) {
        const code = this.normalizeCourseCode(courseCode);
        const match = code.match(/^([A-Z]{2,4})\s+(\d{3}[A-Z]?)$/);
        if (!match) throw new Error('Use a course code such as CSCE 145.');

        const result = await API.searchCourses(State.term, [
            { field: 'subject', value: match[1] },
        ]);
        const sections = (result.results || []).filter(section =>
            this.normalizeCourseCode(section.code) === code,
        );
        if (sections.length === 0) {
            throw new Error(`${code} has no sections in the selected term.`);
        }
        return {
            code,
            title: sections[0].title || code,
            sections,
        };
    },

    async addCourseGroup(group) {
        try {
            let liveGroup = group;
            const sections = group?.sections || [];
            if (sections.length === 0 || sections.every(section => section._isCatalog || !section.crn)) {
                liveGroup = await this.lookupCourseGroup(group.code);
            }
            State.addCourse(liveGroup);
            this.setCourseStatus(`${liveGroup.code} added. The solver will choose its section.`, 'success');
            return liveGroup;
        } catch (error) {
            this.setCourseStatus(error.message, 'error');
            throw error;
        }
    },

    async addCourseByCode(courseCode) {
        const group = await this.lookupCourseGroup(courseCode);
        State.addCourse(group);
        return group;
    },

    async addCourseFromInput() {
        const input = document.getElementById('schedule-course-input');
        const button = document.getElementById('btn-add-schedule-course');
        const courseCode = input.value;
        button.disabled = true;
        this.setCourseStatus('Finding open sections');
        try {
            const group = await this.addCourseByCode(courseCode);
            input.value = '';
            this.setCourseStatus(`${group.code} added. The solver will choose its section.`, 'success');
        } catch (error) {
            this.setCourseStatus(error.message, 'error');
        } finally {
            button.disabled = false;
        }
    },

    clearResults() {
        State.solverResults = [];
        const container = document.getElementById('solver-container');
        if (container) {
            container.innerHTML = '<p class="hint">Generate schedules to compare section combinations for these courses.</p>';
        }
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

    isOpenSection(section) {
        return !section.stat || section.stat === 'A';
    },

    async solve() {
        const courseGroups = Object.values(State.selectedCourses || {});
        if (courseGroups.length === 0) {
            alert('Add the courses you want to schedule first.');
            return;
        }

        if (typeof Tabs !== 'undefined') Tabs.switchTo('schedule');

        const container = document.getElementById('solver-container');
        container.innerHTML = '<p class="loading">Generating schedule options</p>';

        const courses = courseGroups.map(group => ({
            code: group.code,
            sections: (group.sections || []).filter(section =>
                this.isOpenSection(section) && this.isSchedulableSection(section),
            ),
        }));

        const unschedulable = courses.filter(course => course.sections.length === 0);
        if (unschedulable.length > 0) {
            const codes = unschedulable.map(course => course.code).join(', ');
            container.innerHTML = `<p class="hint">No open scheduled or asynchronous sections were found for ${codes} in this term.</p>`;
            return;
        }

        const preferences = State.getPreferences();
        const configuredMax = State.profile?.customCredits?.max;
        preferences.max_credits = Number.isFinite(Number(configuredMax)) ? Number(configuredMax) : 18;

        try {
            const result = await API.solve(courses, preferences);
            State.solverResults = result.schedules || [];
            this.renderResults(result, container);
        } catch (error) {
            container.innerHTML = `<p class="hint">Solver error: ${error.message}</p>`;
        }
    },

    renderResults(result, container) {
        const { total_found, returned, schedules } = result;
        if (!schedules || schedules.length === 0) {
            container.innerHTML = '<p class="hint">No conflict-free schedules found. Remove a course or adjust your preferences.</p>';
            return;
        }

        let html = `<p class="solver-summary">Found ${total_found} valid schedules. Showing the top ${returned}.</p>`;
        schedules.forEach((schedule, index) => {
            const courseList = Object.entries(schedule.sections).map(([code, section]) =>
                `<div class="sched-course"><strong>${code} ${section.section || ''}</strong><span>${(section.instr && section.instr !== 'Staff' ? section.instr : 'Undecided')}</span><span>${section.meets || 'TBA'}</span></div>`,
            ).join('');
            html += `
                <article class="schedule-card" data-idx="${index}" tabindex="0">
                    <div class="schedule-card-header">
                        <span class="score">Option ${index + 1}</span>
                        <button class="btn-apply" data-idx="${index}">APPLY</button>
                    </div>
                    <div class="sched-courses">${courseList}</div>
                </article>
            `;
        });
        container.innerHTML = html;

        container.querySelectorAll('.btn-apply').forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                this.applySchedule(Number(button.dataset.idx));
            });
        });
        container.querySelectorAll('.schedule-card').forEach(card => {
            const preview = () => {
                this.previewSchedule(Number(card.dataset.idx));
                container.querySelectorAll('.schedule-card').forEach(item => item.classList.remove('selected'));
                card.classList.add('selected');
            };
            card.addEventListener('click', preview);
            card.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') preview();
            });
        });
    },

    previewSchedule(index) {
        const schedule = State.solverResults[index];
        if (!schedule || typeof Calendar === 'undefined' || typeof Calendar.render !== 'function') return;
        const selectedSections = State.selectedSections;
        State.selectedSections = { ...schedule.sections };
        Calendar.render();
        State.selectedSections = selectedSections;
    },

    applySchedule(index) {
        const schedule = State.solverResults[index];
        if (!schedule) return;
        State.applySolverSchedule(schedule);
    },
};
