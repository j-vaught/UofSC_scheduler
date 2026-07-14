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
        State.on('section-locks-changed', () => this.clearResults());
        State.on('sections-changed', () => this.refreshAppliedResultState());
        this.initVerticalResizer();
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
                container.innerHTML = '';
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

    initVerticalResizer() {
        const handle = document.getElementById('schedule-vertical-resizer');
        const content = document.getElementById('schedule-content');
        const workspace = content?.querySelector('.schedule-workspace');
        if (!handle || !content || !workspace) return;

        let stored = null;
        try {
            stored = JSON.parse(localStorage.getItem('uofsc-schedule-split-v1') || 'null');
        } catch (error) {
            stored = null;
        }
        if (stored?.workspace && stored?.map) this.setVerticalSizes(stored.workspace, stored.map);

        let startY = 0;
        let startWorkspace = 0;
        let startMap = 0;
        const resize = clientY => {
            const delta = clientY - startY;
            this.setVerticalSizes(startWorkspace + delta, startMap - delta);
        };
        const stop = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', stop);
            handle.classList.remove('active');
            document.body.classList.remove('resizing-schedule');
            this.saveVerticalSizes();
        };
        const move = event => resize(event.clientY);

        handle.addEventListener('pointerdown', event => {
            startY = event.clientY;
            startWorkspace = workspace.getBoundingClientRect().height;
            startMap = document.querySelector('.walking-map-canvas')?.getBoundingClientRect().height || 380;
            handle.classList.add('active');
            document.body.classList.add('resizing-schedule');
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', stop);
            event.preventDefault();
        });
        handle.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            const workspaceHeight = workspace.getBoundingClientRect().height;
            const mapHeight = document.querySelector('.walking-map-canvas')?.getBoundingClientRect().height || 380;
            const delta = event.key === 'ArrowDown' ? 30 : -30;
            this.setVerticalSizes(workspaceHeight + delta, mapHeight - delta);
            this.saveVerticalSizes();
            event.preventDefault();
        });
    },

    setVerticalSizes(workspaceHeight, mapHeight) {
        const content = document.getElementById('schedule-content');
        if (!content) return;
        const workspace = Math.max(420, Math.min(900, Math.round(workspaceHeight)));
        const map = Math.max(260, Math.min(800, Math.round(mapHeight)));
        content.style.setProperty('--schedule-workspace-height', `${workspace}px`);
        content.style.setProperty('--walking-map-height', `${map}px`);
        if (typeof WalkingMap !== 'undefined' && WalkingMap._map) {
            requestAnimationFrame(() => WalkingMap._map.invalidateSize());
        }
    },

    saveVerticalSizes() {
        const workspace = document.querySelector('.schedule-workspace')?.getBoundingClientRect().height;
        const map = document.querySelector('.walking-map-canvas')?.getBoundingClientRect().height;
        if (!workspace || !map) return;
        localStorage.setItem('uofsc-schedule-split-v1', JSON.stringify({ workspace, map }));
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

    async solve(maxResults = 10) {
        const courseGroups = Object.values(State.selectedCourses || {});
        if (courseGroups.length === 0) {
            alert('Add the courses you want to schedule first.');
            return;
        }

        if (typeof Tabs !== 'undefined') Tabs.switchTo('schedule');

        const container = document.getElementById('solver-container');
        container.innerHTML = '<p class="loading">Generating schedule options</p>';

        const courses = courseGroups.map(group => {
            const lockedCrn = State.sectionLocks?.[group.code];
            return {
                code: group.code,
                sections: (group.sections || []).filter(section =>
                    this.isOpenSection(section) &&
                    this.isSchedulableSection(section) &&
                    (!lockedCrn || String(section.crn) === String(lockedCrn)),
                ),
            };
        });

        const unschedulable = courses.filter(course => course.sections.length === 0);
        if (unschedulable.length > 0) {
            const codes = unschedulable.map(course => course.code).join(', ');
            const locked = unschedulable.filter(course => State.sectionLocks?.[course.code]).map(course => course.code);
            container.innerHTML = locked.length > 0
                ? `<p class="solver-error">The locked section for ${locked.join(', ')} is not available for scheduling. Choose another section or allow all open sections.</p>`
                : `<p class="hint">No open scheduled or asynchronous sections were found for ${codes} in this term.</p>`;
            return;
        }

        const preferences = State.getPreferences();
        const configuredMax = State.profile?.customCredits?.max;
        preferences.max_credits = Number.isFinite(Number(configuredMax)) ? Number(configuredMax) : 18;

        try {
            const resultLimit = Math.max(10, Number(maxResults) || 10);
            const result = await API.solve(courses, preferences, resultLimit);
            State.solverResults = result.schedules || [];
            this.renderResults(result, container);
        } catch (error) {
            container.innerHTML = `<p class="hint">Solver error: ${error.message}</p>`;
        }
    },

    renderResults(result, container) {
        const { total_found, returned, schedules } = result;
        if (!schedules || schedules.length === 0) {
            const hasLocks = Object.keys(State.sectionLocks || {}).length > 0;
            container.innerHTML = hasLocks
                ? '<p class="solver-error">No conflict-free schedule works with the locked sections. Change a section preference or remove a course.</p>'
                : '<p class="hint">No conflict-free schedules found. Remove a course or adjust your preferences.</p>';
            return;
        }

        let html = `<p class="solver-summary">Ranked ${total_found} valid schedules. Showing the top ${returned}.</p>`;
        schedules.forEach((schedule, index) => {
            const applied = this.isAppliedSchedule(schedule);
            const courseList = Object.entries(schedule.sections).map(([code, section]) =>
                `<div class="sched-course"><strong>${code} ${section.section || ''}</strong><span>${(section.instr && section.instr !== 'Staff' ? section.instr : 'Undecided')}</span><span>${section.meets || 'TBA'}</span></div>`,
            ).join('');
            html += `
                <article class="schedule-card${applied ? ' applied' : ''}" data-idx="${index}" tabindex="${applied ? '-1' : '0'}" aria-disabled="${applied}">
                    <div class="schedule-card-header">
                        <span class="score">Option ${index + 1}</span>
                        <button class="btn-apply" data-idx="${index}"${applied ? ' disabled' : ''}>${applied ? 'APPLIED' : 'APPLY'}</button>
                    </div>
                    <div class="sched-courses">${courseList}</div>
                </article>
            `;
        });
        if (total_found > returned) {
            html += `<button class="btn-show-more" type="button" data-next-limit="${returned + 10}">SHOW 10 MORE</button>`;
        }
        container.innerHTML = html;

        container.querySelectorAll('.btn-apply').forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                this.applySchedule(Number(button.dataset.idx));
            });
        });
        container.querySelectorAll('.schedule-card').forEach(card => {
            this.bindScheduleCardPreview(card, container);
        });
        const showMore = container.querySelector('.btn-show-more');
        if (showMore) {
            showMore.addEventListener('click', () => {
                this.solve(Number(showMore.dataset.nextLimit));
            });
        }
    },

    bindScheduleCardPreview(card, container) {
        const preview = () => {
            if (this.isAppliedSchedule(State.solverResults[Number(card.dataset.idx)])) return;
            this.previewSchedule(Number(card.dataset.idx));
            container.querySelectorAll('.schedule-card').forEach(item => item.classList.remove('selected'));
            card.classList.add('selected');
        };
        const clearPreview = () => {
            this.clearSchedulePreview();
            card.classList.remove('selected');
        };
        const apply = () => {
            if (this.isAppliedSchedule(State.solverResults[Number(card.dataset.idx)])) return;
            card.classList.remove('selected');
            this.applySchedule(Number(card.dataset.idx));
        };
        card.addEventListener('mouseenter', preview);
        card.addEventListener('mouseleave', clearPreview);
        card.addEventListener('focusin', preview);
        card.addEventListener('focusout', clearPreview);
        card.addEventListener('click', apply);
        card.addEventListener('keydown', event => {
            if (event.target !== card) return;
            if (event.key === 'Enter' || event.key === ' ') {
                apply();
                event.preventDefault();
            }
        });
    },

    previewSchedule(index) {
        const schedule = State.solverResults[index];
        if (!schedule || typeof Calendar === 'undefined' || typeof Calendar.render !== 'function') return;
        const selectedSections = State.selectedSections;
        State.selectedSections = { ...schedule.sections };
        Calendar.render({ preview: true });
        State.selectedSections = selectedSections;
    },

    clearSchedulePreview() {
        if (typeof Calendar === 'undefined' || typeof Calendar.render !== 'function') return;
        Calendar.render();
    },

    applySchedule(index) {
        const schedule = State.solverResults[index];
        if (!schedule) return;
        State.applySolverSchedule(schedule);
        this.refreshAppliedResultState();
    },

    isAppliedSchedule(schedule) {
        const entries = Object.entries(schedule?.sections || {});
        const applied = State.selectedSections || {};
        if (entries.length === 0 || entries.length !== Object.keys(applied).length) return false;
        return entries.every(([code, section]) => String(applied[code]?.crn) === String(section.crn));
    },

    refreshAppliedResultState() {
        const container = document.getElementById('solver-container');
        if (!container || !State.solverResults?.length) return;
        container.querySelectorAll('.schedule-card').forEach(card => {
            const applied = this.isAppliedSchedule(State.solverResults[Number(card.dataset.idx)]);
            card.classList.toggle('applied', applied);
            card.setAttribute('aria-disabled', String(applied));
            card.tabIndex = applied ? -1 : 0;
            const button = card.querySelector('.btn-apply');
            if (button) {
                button.disabled = applied;
                button.textContent = applied ? 'APPLIED' : 'APPLY';
            }
        });
    },
};
