/* Course-level schedule builder and solver frontend glue */
const Scheduler = {
    _lastSearchGroups: [],

    init() {
        document.getElementById('btn-solve').addEventListener('click', () => this.solve());
        document.getElementById('btn-search-schedule-courses').addEventListener('click', () => this.searchFromInput());
        document.getElementById('schedule-course-input').addEventListener('keydown', event => {
            if (event.key === 'Enter') this.searchFromInput();
        });
        State.on('courses-changed', () => {
            this.clearResults();
            this.renderCourseSearchResults();
        });
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

    async searchCourseGroups(query) {
        const normalized = this.normalizeCourseCode(query);
        let criteria;
        if (/^[A-Z]{2,4}\s+\d{3}[A-Z]?$/.test(normalized)) {
            criteria = [{ field: 'alias', value: normalized }];
        } else if (/^[A-Z]{2,4}$/.test(normalized)) {
            criteria = [{ field: 'subject', value: normalized }];
        } else if (/^\d+$/.test(normalized)) {
            throw new Error('Include the subject code, such as CSCE 145.');
        } else if (normalized.length >= 3) {
            criteria = [{ field: 'keyword', value: String(query).trim() }];
        } else {
            throw new Error('Enter a subject, course code, or keyword.');
        }

        const result = await API.searchCourses(State.term, criteria);
        const groups = {};
        (result.results || []).forEach(section => {
            if (!section.code) return;
            if (!groups[section.code]) {
                groups[section.code] = {
                    code: section.code,
                    title: section.title || section.code,
                    sections: [],
                };
            }
            groups[section.code].sections.push(section);
        });
        return Object.values(groups).slice(0, 30);
    },

    async searchFromInput() {
        const input = document.getElementById('schedule-course-input');
        const button = document.getElementById('btn-search-schedule-courses');
        button.disabled = true;
        this.setCourseStatus('Searching courses');
        const results = document.getElementById('schedule-search-results');
        results.innerHTML = '<p class="loading">Searching courses</p>';
        try {
            this._lastSearchGroups = await this.searchCourseGroups(input.value);
            if (this._lastSearchGroups.length === 0) {
                this.setCourseStatus('No courses found in the selected term.', 'error');
            } else {
                this.setCourseStatus(`${this._lastSearchGroups.length} course${this._lastSearchGroups.length === 1 ? '' : 's'} found.`);
            }
            this.renderCourseSearchResults();
        } catch (error) {
            this.setCourseStatus(error.message, 'error');
            results.innerHTML = `<p class="hint">${error.message}</p>`;
        } finally {
            button.disabled = false;
        }
    },

    renderCourseSearchResults() {
        const container = document.getElementById('schedule-search-results');
        if (!container) return;
        if (this._lastSearchGroups.length === 0) {
            if (!container.querySelector('.loading')) {
                container.innerHTML = '<p class="hint">Search by subject, course code, or keyword.</p>';
            }
            return;
        }

        container.innerHTML = '';
        this._lastSearchGroups.forEach(group => {
            const openCount = (group.sections || []).filter(section => this.isOpenSection(section)).length;
            const selected = State.isCourseSelected(group.code);
            const course = document.createElement('div');
            course.className = `schedule-search-course${selected ? ' selected' : ''}`;
            course.innerHTML = `
                <div class="schedule-search-course-copy">
                    <strong>${group.code}</strong>
                    <span>${group.title}</span>
                    <small>${openCount} open section${openCount === 1 ? '' : 's'}</small>
                </div>
                <button class="btn-course-add ${selected ? 'added' : ''}" data-code="${group.code}">${selected ? 'ADDED' : 'ADD COURSE'}</button>
            `;
            course.querySelector('.btn-course-add').addEventListener('click', async () => {
                if (State.isCourseSelected(group.code)) State.removeCourse(group.code);
                else await this.addCourseGroup(group);
            });
            container.appendChild(course);
        });
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
