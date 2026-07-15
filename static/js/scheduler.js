/* Course-level schedule builder and solver frontend glue */
const Scheduler = {
    _lastSearchGroups: [],
    _preferredWorkspaceHeight: 620,
    _quickViewRequestId: 0,

    init() {
        document.getElementById('btn-solve').addEventListener('click', () => this.solve());
        document.getElementById('btn-schedule-preferences').addEventListener('click', () => this.openSchedulePreferences());
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
        State.on('preferences-changed', () => this.clearResults());
        this.renderCourseSearchResults();
        this.initCourseDivider();
        this.initVerticalResizer();
        this.initScheduleScrollPreview();
    },

    formatPreferenceTime(value) {
        const numeric = Number(value);
        const hours = Math.floor(numeric / 100);
        const minutes = numeric % 100;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    },

    parsePreferenceTime(value) {
        const [hours, minutes] = String(value || '').split(':').map(Number);
        return hours * 100 + minutes;
    },

    openSchedulePreferences() {
        const overlay = document.getElementById('modal-overlay');
        const modal = document.getElementById('modal');
        const content = document.getElementById('modal-content');
        if (!overlay || !modal || !content) return;
        modal.classList.remove('course-quick-modal');

        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
        const avoidedDays = new Set((State.avoidedDays || []).map(Number));
        const dayOptions = dayNames.map((name, day) => `
            <label>
                <input type="checkbox" name="schedule-avoid-day" value="${day}"${avoidedDays.has(day) ? ' checked' : ''}>
                ${name.slice(0, 3).toUpperCase()}
            </label>
        `).join('');

        content.innerHTML = `
            <section class="schedule-preferences-dialog" aria-labelledby="schedule-preferences-title">
                <h2 id="schedule-preferences-title">Schedule Preferences</h2>
                <div class="schedule-preference-grid">
                    <fieldset class="schedule-preference-times">
                        <legend>Class times to avoid when possible</legend>
                        <div class="schedule-time-options">
                            <label for="schedule-preferred-start">
                                <span>Before</span>
                                <input id="schedule-preferred-start" type="time" value="${this.formatPreferenceTime(State.preferredStart)}">
                            </label>
                            <label for="schedule-preferred-end">
                                <span>Ending after</span>
                                <input id="schedule-preferred-end" type="time" value="${this.formatPreferenceTime(State.preferredEnd)}">
                            </label>
                        </div>
                    </fieldset>
                    <fieldset class="schedule-preference-walking">
                        <legend>Minimum time between classes</legend>
                        <label for="schedule-minimum-walking-buffer">
                            <span>Extra time after walking between classes</span>
                            <input id="schedule-minimum-walking-buffer" type="number" min="1" max="120" step="1" value="${Math.max(1, Number(State.minimumWalkingBuffer) || 1)}">
                        </label>
                        <small>Choose 10 to arrive at least ten minutes early.</small>
                    </fieldset>
                    <fieldset class="schedule-preference-days">
                        <legend>Days to avoid when possible</legend>
                        <div class="schedule-day-options">${dayOptions}</div>
                    </fieldset>
                </div>
                <p id="schedule-preferences-error" class="schedule-preferences-error" role="alert"></p>
                <div class="schedule-preference-actions">
                    <button id="btn-save-schedule-preferences" type="button" class="btn-garnet">SAVE PREFERENCES</button>
                </div>
            </section>
        `;
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'schedule-preferences-title');
        overlay.classList.remove('hidden');

        const saveButton = document.getElementById('btn-save-schedule-preferences');
        saveButton.addEventListener('click', () => this.saveSchedulePreferences());
        saveButton.focus();
    },

    saveSchedulePreferences() {
        const start = this.parsePreferenceTime(document.getElementById('schedule-preferred-start').value);
        const end = this.parsePreferenceTime(document.getElementById('schedule-preferred-end').value);
        const error = document.getElementById('schedule-preferences-error');
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
            error.textContent = 'The preferred end time must be later than the preferred start time.';
            return false;
        }

        const minimumWalkingBuffer = Number(document.getElementById('schedule-minimum-walking-buffer').value);
        State.minimumWalkingBuffer = Math.max(1, Math.min(120, Number.isFinite(minimumWalkingBuffer) ? Math.round(minimumWalkingBuffer) : 1));
        State.preferredStart = start;
        State.preferredEnd = end;
        State.avoidedDays = Array.from(document.querySelectorAll('input[name="schedule-avoid-day"]:checked'))
            .map(input => Number(input.value));
        document.getElementById('modal-overlay').classList.add('hidden');
        State.emit('preferences-changed');
        return true;
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

    parseCreditHours(value) {
        const matches = String(value ?? '').match(/\d+(?:\.\d+)?/g) || [];
        if (matches.length === 0) return null;
        return Math.max(...matches.map(Number));
    },

    async hydrateCourseCredits(group) {
        let credits = this.parseCreditHours(group.credits);
        if (credits === null) {
            credits = this.parseCreditHours((group.sections || []).find(section => section.hours)?.hours);
        }
        const firstCrn = (group.sections || []).find(section => section.crn)?.crn;
        if (credits === null && firstCrn && API.getDetails) {
            try {
                const details = await API.getDetails(firstCrn, State.term);
                credits = this.parseCreditHours(details.hours_html);
            } catch (error) {
                credits = null;
            }
        }
        if (credits !== null) {
            group.credits = credits;
            (group.sections || []).forEach(section => {
                if (!section.hours) section.hours = credits;
            });
        }
        return group;
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
            await this.hydrateCourseCredits(liveGroup);
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
        await this.hydrateCourseCredits(group);
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
            const query = document.getElementById('schedule-course-input')?.value.trim();
            container.innerHTML = `<p class="hint schedule-results-empty">${query ? 'No courses found for this search.' : 'Search for a course to see results.'}</p>`;
            return;
        }

        container.innerHTML = '';
        this._lastSearchGroups.forEach(group => {
            const availability = this.scheduleCourseAvailability(group);
            const selected = State.isCourseSelected(group.code);
            const course = document.createElement('div');
            course.className = `schedule-search-course${selected ? ' selected' : ''}`;
            course.innerHTML = `
                <div class="schedule-search-course-copy" role="button" tabindex="0" aria-label="View details for ${this.escapeHtml(group.code)}">
                    <strong>${group.code}</strong>
                    <span>${group.title}</span>
                    <small class="schedule-course-availability ${availability.kind}">${availability.text}</small>
                </div>
                <button class="btn-course-add schedule-course-add ${selected ? 'btn-danger added' : 'btn-green'}" data-code="${group.code}">${selected ? 'REMOVE' : 'ADD'}</button>
            `;
            const courseCopy = course.querySelector('.schedule-search-course-copy');
            courseCopy.addEventListener('click', () => this.openCourseQuickView(group));
            courseCopy.addEventListener('keydown', event => {
                if (!['Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                this.openCourseQuickView(group);
            });
            course.querySelector('.btn-course-add').addEventListener('click', async () => {
                if (State.isCourseSelected(group.code)) State.removeCourse(group.code);
                else await this.addCourseGroup(group);
            });
            container.appendChild(course);
        });
    },

    escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    },

    stripHtml(value) {
        const element = document.createElement('div');
        element.innerHTML = String(value || '');
        return (element.textContent || '').replace(/\s+/g, ' ').trim();
    },

    normalizeInstructorName(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    },

    currentInstructorCrns(group) {
        const seen = {};
        return (group.sections || []).filter(section => {
            const instructor = String(section.instr || '').trim().toLowerCase();
            if (!section.crn || !instructor || ['staff', 'undecided', 'tba'].includes(instructor)) return false;
            seen[instructor] = (seen[instructor] || 0) + 1;
            if (seen[instructor] > 2) return false;
            return true;
        }).map(section => String(section.crn)).slice(0, 12);
    },

    currentInstructorSummaries(group, gradeData = {}, facultyData = []) {
        const instructors = {};
        const uniqueFaculty = Object.values((facultyData || []).reduce((records, member) => {
            const key = this.normalizeInstructorName(member.email || member.name);
            if (key && !records[key]) records[key] = member;
            return records;
        }, {}));
        (group.sections || []).filter(section => section.crn && !section._isCatalog).forEach(section => {
            const liveFaculty = (facultyData || []).filter(member => String(member.crn) === String(section.crn));
            const identities = liveFaculty.length > 0
                ? liveFaculty
                : String(section.instr || '').split(/;|\s+\/\s+|\s+and\s+/i).map(rawName => {
                    const name = rawName.trim();
                    const normalized = this.normalizeInstructorName(name);
                    const matches = uniqueFaculty.filter(member => {
                        const candidate = this.normalizeInstructorName(member.name);
                        return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
                    });
                    return matches.length === 1 ? matches[0] : { name, email: '' };
                });
            identities.forEach(identity => {
                const name = String(identity.name || '').trim();
                if (!name || ['staff', 'undecided', 'tba'].includes(name.toLowerCase())) return;
                const key = this.normalizeInstructorName(identity.email || name);
                if (!instructors[key]) {
                    instructors[key] = {
                        name,
                        displayName: name,
                        email: String(identity.email || '').trim().toLowerCase(),
                        sections: 0,
                        open: 0,
                        grade: null,
                    };
                }
                instructors[key].sections += 1;
                if (this.isOpenSection(section)) instructors[key].open += 1;
            });
        });
        const historical = gradeData.instructors || [];
        Object.values(instructors).forEach(summary => {
            const normalized = this.normalizeInstructorName(summary.name);
            summary.grade = historical.find(record => {
                const candidate = this.normalizeInstructorName(record.name);
                return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
            }) || null;
            summary.displayName = summary.name.includes(',')
                ? summary.name
                : summary.grade?.name || summary.name;
            if (!summary.email && summary.grade?.email) summary.email = summary.grade.email;
        });
        return Object.values(instructors)
            .sort((a, b) => b.open - a.open || b.sections - a.sections || a.displayName.localeCompare(b.displayName));
    },

    instructorCardsMarkup(instructors) {
        return instructors.map(instructor => {
            const grade = instructor.grade;
            const gpa = Number(grade?.average_gpa);
            const gpaPosition = Number.isFinite(gpa) ? Math.max(0, Math.min(100, gpa / 4 * 100)) : 0;
            return `
                <article class="quick-instructor-card">
                    <div class="quick-instructor-heading">
                        <strong>${this.escapeHtml(instructor.displayName || instructor.name)}</strong>
                        <span>${instructor.open} open / ${instructor.sections} section${instructor.sections === 1 ? '' : 's'}</span>
                    </div>
                    ${instructor.email ? `<a class="quick-instructor-email" href="mailto:${this.escapeHtml(instructor.email)}">${this.escapeHtml(instructor.email)}</a>` : '<span class="quick-instructor-email unavailable">Email unavailable</span>'}
                    ${Number.isFinite(gpa) ? `
                        <div class="quick-gpa-track" aria-label="Historical course GPA ${gpa.toFixed(2)} out of 4">
                            <span style="width:${gpaPosition}%"></span>
                        </div>
                        <small>${gpa.toFixed(2)} historical course GPA · ${Number(grade.graded_students || 0).toLocaleString()} grades</small>
                    ` : '<small>No matched grade history for this course.</small>'}
                </article>
            `;
        }).join('');
    },

    updateQuickFaculty(group, gradeData = {}, facultyData = []) {
        const count = document.getElementById('quick-instructor-count');
        const grid = document.getElementById('quick-instructor-grid');
        const more = document.getElementById('quick-instructor-more');
        if (!count || !grid || !more) return;
        const instructors = this.currentInstructorSummaries(group, gradeData, facultyData);
        const visible = instructors.slice(0, 4);
        count.textContent = `${instructors.length} listed this term`;
        grid.innerHTML = this.instructorCardsMarkup(visible)
            || '<p class="quick-empty">Instructor assignments have not been posted.</p>';
        const remaining = instructors.length - visible.length;
        more.textContent = remaining > 0
            ? `${remaining} additional instructor${remaining === 1 ? '' : 's'} available in Browse.`
            : '';
    },

    gradeBuckets(gradeData = {}) {
        const counts = gradeData.grade_counts || {};
        const buckets = [
            { label: 'A', count: Number(counts.A) || 0, className: 'grade-a' },
            { label: 'B', count: (Number(counts['B+']) || 0) + (Number(counts.B) || 0), className: 'grade-b' },
            { label: 'C', count: (Number(counts['C+']) || 0) + (Number(counts.C) || 0), className: 'grade-c' },
            { label: 'D / F', count: ['D+', 'D', 'F', 'FN'].reduce((sum, grade) => sum + (Number(counts[grade]) || 0), 0), className: 'grade-df' },
        ];
        const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
        return buckets.map(bucket => ({
            ...bucket,
            percent: total ? Math.round(bucket.count / total * 100) : 0,
        }));
    },

    renderCourseQuickView(group, details = {}, gradeData = {}, offering = {}, detailsPending = false) {
        const content = document.getElementById('modal-content');
        if (!content) return;
        const liveSections = (group.sections || []).filter(section => section.crn && !section._isCatalog);
        const openSections = liveSections.filter(section => this.isOpenSection(section)).length;
        const availabilityPercent = liveSections.length ? Math.round(openSections / liveSections.length * 100) : 0;
        const availability = this.scheduleCourseAvailability(group);
        const credits = this.parseCreditHours(details.hours_html || group.credits || liveSections[0]?.hours);
        const description = this.stripHtml(details.description || '').slice(0, 280);
        const prerequisite = this.stripHtml(details.prereq || details.prerequisite || '');
        const buckets = this.gradeBuckets(gradeData);
        const instructors = this.currentInstructorSummaries(group, gradeData);
        const visibleInstructors = instructors.slice(0, 4);
        const courseGpa = Number(gradeData.average_gpa);
        const hasGrades = Number.isFinite(courseGpa) && Number(gradeData.graded_students) > 0;
        const hasOffering = Number.isFinite(Number(offering.frequency))
            && Number(offering.total_terms_checked) > 0;
        const frequency = hasOffering
            ? Math.max(0, Math.min(100, Math.round(Number(offering.frequency) * 100)))
            : 0;
        const offeringCount = offering.total_terms_checked
            ? `${offering.times_offered} of ${offering.total_terms_checked} recent terms${offering.last_offered_label ? ` · Last offered ${offering.last_offered_label}` : ''}`
            : '';

        const gradeStrip = buckets.map(bucket => bucket.percent > 0
            ? `<span class="quick-grade-segment ${bucket.className}" style="width:${bucket.percent}%" title="${bucket.label}: ${bucket.percent}%"></span>`
            : '').join('');
        const gradeLegend = buckets.map(bucket => `
            <span><i class="${bucket.className}"></i><strong>${bucket.percent}%</strong> ${bucket.label}</span>
        `).join('');
        const instructorCards = this.instructorCardsMarkup(visibleInstructors);

        content.innerHTML = `
            <section class="course-quick-view" aria-labelledby="course-quick-title">
                <header class="course-quick-header">
                    <div>
                        <span class="course-quick-kicker">QUICK COURSE DETAILS</span>
                        <h2 id="course-quick-title">${this.escapeHtml(group.code)}</h2>
                        <p id="course-quick-name">${this.escapeHtml(details.title || group.title)}</p>
                    </div>
                    <div class="course-quick-credits"><strong id="course-quick-credit-value">${credits ?? '—'}</strong><span>CREDITS</span></div>
                </header>

                <div class="course-quick-overview">
                    <section class="quick-availability-card">
                        <div class="quick-section-heading">
                            <h3>This term</h3>
                            <span class="schedule-course-availability ${availability.kind}">${availability.text}</span>
                        </div>
                        <div class="quick-availability-track" aria-label="${availabilityPercent}% of sections open">
                            <span style="width:${availabilityPercent}%"></span>
                        </div>
                        <small>${openSections} open · ${Math.max(0, liveSections.length - openSections)} full</small>
                    </section>
                    <section class="quick-offering-card">
                        <div id="quick-frequency-ring" class="quick-frequency-ring" style="--frequency:${frequency * 3.6}deg"><strong>${hasOffering ? `${frequency}%` : '…'}</strong></div>
                        <div><h3>How often it runs</h3><p id="quick-offering-label">${this.escapeHtml(hasOffering ? `Offered in ${frequency}% of recent terms` : 'Checking offering history')}</p><small id="quick-offering-count">${this.escapeHtml(offeringCount)}</small></div>
                    </section>
                </div>

                <section id="course-quick-summary" class="course-quick-summary${description || prerequisite ? '' : ' quick-summary-loading'}">
                    ${description || prerequisite ? `
                        ${description ? `<p>${this.escapeHtml(description)}${this.stripHtml(details.description || '').length > 280 ? '…' : ''}</p>` : ''}
                        <div class="quick-prerequisite"><strong>PREREQUISITES</strong><span>${this.escapeHtml(prerequisite || 'None listed')}</span></div>
                    ` : `<p>${detailsPending ? 'Loading description and prerequisites' : 'Course description and prerequisites are unavailable.'}</p>`}
                </section>

                <section class="course-quick-section">
                    <div class="quick-section-heading"><h3>Current instructors</h3><span id="quick-instructor-count">${instructors.length} listed this term</span></div>
                    <div id="quick-instructor-grid" class="quick-instructor-grid">${instructorCards || '<p class="quick-empty">Instructor assignments have not been posted.</p>'}</div>
                    <small id="quick-instructor-more" class="quick-more-note">${instructors.length > visibleInstructors.length ? `${instructors.length - visibleInstructors.length} additional instructor${instructors.length - visibleInstructors.length === 1 ? '' : 's'} available in Browse.` : ''}</small>
                </section>

                <section class="course-quick-section quick-grade-section">
                    <div class="quick-section-heading"><h3>Historical grades</h3>${hasGrades ? `<span>${courseGpa.toFixed(2)} GPA · ${Number(gradeData.graded_students).toLocaleString()} grades</span>` : ''}</div>
                    ${hasGrades ? `<div class="quick-grade-strip" aria-label="Historical grade distribution">${gradeStrip}</div><div class="quick-grade-legend">${gradeLegend}</div>` : '<p class="quick-empty">No historical grade data is available.</p>'}
                </section>

                <footer class="course-quick-actions">
                    <button id="btn-quick-course-toggle" class="${State.isCourseSelected(group.code) ? 'btn-danger' : 'btn-green'}">${State.isCourseSelected(group.code) ? 'REMOVE' : 'ADD TO SCHEDULE'}</button>
                    <button id="btn-quick-view-browse" class="btn-secondary">VIEW FULL DETAILS IN BROWSE</button>
                </footer>
            </section>
        `;

        document.getElementById('btn-quick-course-toggle')?.addEventListener('click', async event => {
            if (State.isCourseSelected(group.code)) State.removeCourse(group.code);
            else await this.addCourseGroup(group);
            event.currentTarget.textContent = State.isCourseSelected(group.code) ? 'REMOVE' : 'ADD TO SCHEDULE';
            event.currentTarget.className = State.isCourseSelected(group.code) ? 'btn-danger' : 'btn-green';
        });
        document.getElementById('btn-quick-view-browse')?.addEventListener('click', () => this.openCourseInBrowse(group));
    },

    updateQuickDetails(details = {}, group = {}, unavailable = false) {
        const name = document.getElementById('course-quick-name');
        const creditValue = document.getElementById('course-quick-credit-value');
        const summary = document.getElementById('course-quick-summary');
        if (!name || !creditValue || !summary) return;
        const liveSections = (group.sections || []).filter(section => section.crn && !section._isCatalog);
        const credits = this.parseCreditHours(details.hours_html || group.credits || liveSections[0]?.hours);
        const fullDescription = this.stripHtml(details.description || '');
        const description = fullDescription.slice(0, 280);
        const prerequisite = this.stripHtml(details.prereq || details.prerequisite || '');
        name.textContent = details.title || group.title || group.code || '';
        creditValue.textContent = credits ?? '—';
        summary.classList.remove('quick-summary-loading');
        if (description || prerequisite) {
            summary.innerHTML = `
                ${description ? `<p>${this.escapeHtml(description)}${fullDescription.length > 280 ? '…' : ''}</p>` : ''}
                <div class="quick-prerequisite"><strong>PREREQUISITES</strong><span>${this.escapeHtml(prerequisite || 'None listed')}</span></div>
            `;
        } else {
            summary.innerHTML = `<p>${unavailable ? 'Course description and prerequisites are unavailable.' : 'No description or prerequisites are listed.'}</p>`;
        }
    },

    updateQuickOffering(offering = {}) {
        const ring = document.getElementById('quick-frequency-ring');
        const label = document.getElementById('quick-offering-label');
        const count = document.getElementById('quick-offering-count');
        if (!ring || !label || !count) return;
        const hasOffering = Number.isFinite(Number(offering.frequency))
            && Number(offering.total_terms_checked) > 0;
        const frequency = hasOffering
            ? Math.max(0, Math.min(100, Math.round(Number(offering.frequency) * 100)))
            : 0;
        ring.style.setProperty('--frequency', `${frequency * 3.6}deg`);
        ring.querySelector('strong').textContent = hasOffering ? `${frequency}%` : '—';
        label.textContent = hasOffering
            ? `Offered in ${frequency}% of recent terms`
            : 'Offering history unavailable';
        const countParts = offering.total_terms_checked
            ? [`${offering.times_offered} of ${offering.total_terms_checked} recent terms`]
            : [];
        if (offering.last_offered_label) countParts.push(`Last offered ${offering.last_offered_label}`);
        count.textContent = countParts.join(' · ');
    },

    async openCourseQuickView(group) {
        const overlay = document.getElementById('modal-overlay');
        const modal = document.getElementById('modal');
        const content = document.getElementById('modal-content');
        if (!overlay || !modal || !content) return;
        modal.classList.add('course-quick-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'course-quick-title');
        content.innerHTML = '<div class="course-quick-loading"><span></span><p>Loading course details</p></div>';
        overlay.classList.remove('hidden');
        const requestId = ++this._quickViewRequestId;

        const detailsPromise = typeof Search !== 'undefined' && Search.fetchBulletinDetailsForCourse
            ? Search.fetchBulletinDetailsForCourse(group.code)
            : Promise.resolve({});
        const facultyCrns = this.currentInstructorCrns(group);
        const facultyPromise = facultyCrns.length > 0
            ? API.getFaculty(State.term, facultyCrns)
            : Promise.resolve({ faculty: [] });
        const offeringPromise = API.getOfferingAnalysis(group.code, State.term);
        const gradesResult = await Promise.allSettled([API.getCourseGrades(group.code)]);
        if (requestId !== this._quickViewRequestId || overlay.classList.contains('hidden')) return;
        this.renderCourseQuickView(
            group,
            {},
            gradesResult[0].status === 'fulfilled' && !gradesResult[0].value?.error ? gradesResult[0].value : {},
            {},
            true,
        );
        document.getElementById('modal-close')?.focus();
        const gradeData = gradesResult[0].status === 'fulfilled' && !gradesResult[0].value?.error
            ? gradesResult[0].value
            : {};
        facultyPromise
            .then(result => {
                if (requestId === this._quickViewRequestId) this.updateQuickFaculty(group, gradeData, result.faculty || []);
            })
            .catch(() => {});
        detailsPromise
            .then(details => {
                if (requestId === this._quickViewRequestId) this.updateQuickDetails(details || {}, group);
            })
            .catch(() => {
                if (requestId === this._quickViewRequestId) this.updateQuickDetails({}, group, true);
            });
        offeringPromise
            .then(offering => {
                if (requestId === this._quickViewRequestId && !offering?.error) this.updateQuickOffering(offering);
            })
            .catch(() => {
                if (requestId === this._quickViewRequestId) this.updateQuickOffering({});
            });
    },

    openCourseInBrowse(group) {
        document.getElementById('modal-overlay')?.classList.add('hidden');
        document.getElementById('modal')?.classList.remove('course-quick-modal');
        if (typeof Tabs !== 'undefined') Tabs.switchTo('semester');
        const input = document.getElementById('keyword-input');
        if (input) input.value = group.code;
        if (typeof Search === 'undefined') return;
        Search.renderResults(group.sections || [], (group.sections || []).length, {}, false, null);
        document.querySelector(`#search-results .course-group[data-course-code="${group.code}"] .course-header`)?.click();
    },

    scheduleCourseAvailability(group) {
        const liveSections = (group.sections || []).filter(section => section.crn && !section._isCatalog);
        if (liveSections.length === 0) return { kind: 'unavailable', text: 'Not offered' };
        const openCount = liveSections.filter(section => this.isOpenSection(section)).length;
        if (openCount > 0) {
            return { kind: 'open', text: `${openCount} of ${liveSections.length} open` };
        }
        return { kind: 'full', text: `All ${liveSections.length} are full` };
    },

    clearResults() {
        State.solverResults = [];
        const container = document.getElementById('solver-container');
        if (container) {
            container.innerHTML = '<p class="hint">Generate schedules to compare section combinations for these courses.</p>';
        }
    },

    fitCoursePanelSizes(resultsHeight, availableHeight) {
        const available = Math.max(0, Math.round(availableHeight));
        const minimumResults = Math.min(72, available);
        const minimumSelected = Math.min(190, Math.max(0, available - minimumResults));
        const maximumResults = Math.max(minimumResults, available - minimumSelected);
        const results = Math.max(minimumResults, Math.min(maximumResults, Math.round(resultsHeight)));
        return { results, selected: Math.max(0, available - results) };
    },

    setCoursePanelSizes(resultsHeight) {
        const sidebar = document.getElementById('schedule-sidebar');
        const search = sidebar?.querySelector('.schedule-search-section');
        const divider = document.getElementById('schedule-course-divider');
        if (!sidebar || !search || !divider) return;
        const available = sidebar.clientHeight
            - search.getBoundingClientRect().height
            - divider.getBoundingClientRect().height;
        if (available <= 0) {
            sidebar.style.setProperty('--schedule-results-height', `${Math.max(72, Math.round(resultsHeight))}px`);
            return;
        }
        const { results } = this.fitCoursePanelSizes(resultsHeight, available);
        sidebar.style.setProperty('--schedule-results-height', `${results}px`);
        divider.setAttribute('aria-valuemin', '72');
        divider.setAttribute('aria-valuemax', String(Math.max(72, Math.round(available - 190))));
        divider.setAttribute('aria-valuenow', String(results));
    },

    initCourseDivider() {
        const divider = document.getElementById('schedule-course-divider');
        const sidebar = document.getElementById('schedule-sidebar');
        const results = document.getElementById('schedule-search-results');
        if (!divider || !sidebar || !results) return;

        let storedHeight = 170;
        try {
            const stored = JSON.parse(localStorage.getItem('uofsc-course-divider-v1') || 'null');
            storedHeight = Number(stored?.resultsHeight) || storedHeight;
        } catch (error) {
            storedHeight = 170;
        }
        sidebar.style.setProperty('--schedule-results-height', `${storedHeight}px`);

        let startY = 0;
        let startHeight = 0;
        const move = event => this.setCoursePanelSizes(startHeight + event.clientY - startY);
        const stop = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', stop);
            divider.classList.remove('active');
            document.body.classList.remove('resizing-course-divider');
            localStorage.setItem('uofsc-course-divider-v1', JSON.stringify({
                resultsHeight: results.getBoundingClientRect().height,
            }));
        };

        divider.addEventListener('pointerdown', event => {
            startY = event.clientY;
            startHeight = results.getBoundingClientRect().height;
            divider.classList.add('active');
            document.body.classList.add('resizing-course-divider');
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', stop);
            event.preventDefault();
        });
        divider.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            const delta = event.key === 'ArrowDown' ? 24 : -24;
            this.setCoursePanelSizes(results.getBoundingClientRect().height + delta);
            event.preventDefault();
        });
        window.addEventListener('resize', () => {
            if (sidebar.clientHeight > 0) this.setCoursePanelSizes(results.getBoundingClientRect().height);
        });
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
        this._preferredWorkspaceHeight = this.initialPanelHeight(
            stored?.workspace,
            workspace.getBoundingClientRect().height,
        );
        this.setVerticalSizes(this._preferredWorkspaceHeight);

        document.addEventListener('tab-changed', event => {
            if (event.detail?.tab === 'schedule') {
                this.setVerticalSizes(this._preferredWorkspaceHeight);
            }
        });

        let startY = 0;
        let startWorkspace = 0;
        const resize = clientY => {
            const delta = clientY - startY;
            this.setVerticalSizes(startWorkspace + delta);
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
            handle.classList.add('active');
            document.body.classList.add('resizing-schedule');
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', stop);
            event.preventDefault();
        });
        handle.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            const workspaceHeight = workspace.getBoundingClientRect().height;
            const delta = event.key === 'ArrowDown' ? 30 : -30;
            this.setVerticalSizes(workspaceHeight + delta);
            this.saveVerticalSizes();
            event.preventDefault();
        });
        this._verticalResizeHandler = () => {
            this.setVerticalSizes(workspace.getBoundingClientRect().height);
        };
        window.addEventListener('resize', this._verticalResizeHandler);
    },

    fitPanelSizes(workspaceHeight, availableHeight) {
        const total = Math.max(0, Math.round(availableHeight));
        const preferredMapMinimum = 260;
        const mapMinimum = Math.min(preferredMapMinimum, Math.max(0, total - 200));
        const workspaceMinimum = Math.min(420, Math.max(0, total - mapMinimum));
        const workspaceMaximum = Math.max(workspaceMinimum, total - mapMinimum);
        const workspace = Math.max(
            workspaceMinimum,
            Math.min(workspaceMaximum, Math.round(workspaceHeight)),
        );
        return { workspace, map: Math.max(0, total - workspace) };
    },

    initialPanelHeight(storedHeight, measuredHeight) {
        const stored = Number(storedHeight);
        if (Number.isFinite(stored) && stored > 0) return stored;
        const measured = Number(measuredHeight);
        if (Number.isFinite(measured) && measured > 0) return measured;
        return 620;
    },

    availablePanelHeight(content, handle) {
        const contentStyle = window.getComputedStyle(content);
        const handleStyle = window.getComputedStyle(handle);
        const padding = parseFloat(contentStyle.paddingTop) + parseFloat(contentStyle.paddingBottom);
        const gap = parseFloat(contentStyle.rowGap || contentStyle.gap) || 0;
        const handleHeight = handle.getBoundingClientRect().height
            + parseFloat(handleStyle.marginTop)
            + parseFloat(handleStyle.marginBottom);
        return Math.max(0, content.clientHeight - padding - (gap * 2) - handleHeight);
    },

    setVerticalSizes(workspaceHeight) {
        const content = document.getElementById('schedule-content');
        const handle = document.getElementById('schedule-vertical-resizer');
        if (!content || !handle) return;
        const available = this.availablePanelHeight(content, handle);
        if (available <= 0) return;
        const { workspace } = this.fitPanelSizes(workspaceHeight, available);
        this._preferredWorkspaceHeight = workspace;
        content.style.setProperty('--schedule-workspace-height', `${workspace}px`);
        if (typeof WalkingMap !== 'undefined' && WalkingMap._map) {
            requestAnimationFrame(() => WalkingMap._map.invalidateSize());
        }
    },

    saveVerticalSizes() {
        const workspace = document.querySelector('.schedule-workspace')?.getBoundingClientRect().height;
        if (!workspace) return;
        localStorage.setItem('uofsc-schedule-split-v1', JSON.stringify({ workspace }));
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

    async addWalkingLocations(courses) {
        if (typeof WalkingMap === 'undefined') return;

        const sections = courses.flatMap(course => course.sections || []);
        await WalkingMap.hydrateSectionDetails(sections);
        sections.forEach(section => {
            const details = WalkingMap.sectionDetails.get(String(section.crn)) || [];
            section._walking_locations = WalkingMap.parseMeetingTimes(section.meetingTimes)
                .map(meeting => {
                    const detail = details.find(item => item.days.includes(meeting.day)
                        && item.start !== null && Math.abs(item.start - meeting.start) <= 5)
                        || details.find(item => item.days.includes(meeting.day));
                    if (!detail || detail.building?.kind !== 'known') return null;
                    return {
                        day: meeting.day,
                        start: meeting.start,
                        latitude: Number(detail.building.lat),
                        longitude: Number(detail.building.lon),
                    };
                })
                .filter(Boolean);
        });
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
                sections: (group.sections || []).filter(section => {
                    const locked = lockedCrn && String(section.crn) === String(lockedCrn);
                    return this.isSchedulableSection(section)
                        && (lockedCrn ? locked : this.isOpenSection(section));
                }),
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
            await this.addWalkingLocations(courses);
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
                `<div class="sched-course"><strong>${code} ${section.section || ''}</strong><span>${(section.instr && section.instr !== 'Staff' ? section.instr : 'Undecided')}</span><span>${section.meets || 'TBA'}</span>${this.isOpenSection(section) ? '' : '<span class="sched-course-full">FULL — planning only</span>'}</div>`,
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

    initScheduleScrollPreview() {
        const container = document.getElementById('solver-container');
        if (!container || container.dataset.scrollPreviewBound === 'true') return;
        container.dataset.scrollPreviewBound = 'true';

        let pointer = null;
        let previewFrame = null;
        const rememberPointer = event => {
            pointer = { x: event.clientX, y: event.clientY };
        };
        container.addEventListener('pointerenter', rememberPointer);
        container.addEventListener('pointermove', rememberPointer);
        container.addEventListener('pointerleave', () => {
            pointer = null;
            container.querySelectorAll('.schedule-card').forEach(card => card.classList.remove('selected'));
            this.clearSchedulePreview();
        });
        container.addEventListener('scroll', () => {
            if (!pointer || previewFrame !== null) return;
            previewFrame = requestAnimationFrame(() => {
                previewFrame = null;
                this.previewScheduleAtPoint(container, pointer.x, pointer.y);
            });
        }, { passive: true });
    },

    previewScheduleAtPoint(container, clientX, clientY) {
        const target = document.elementFromPoint(clientX, clientY);
        const card = target?.closest?.('.schedule-card');
        if (!card || !container.contains(card)) return null;
        const index = Number(card.dataset.idx);
        if (!Number.isInteger(index) || this.isAppliedSchedule(State.solverResults[index])) return null;
        container.querySelectorAll('.schedule-card').forEach(item => item.classList.remove('selected'));
        card.classList.add('selected');
        this.previewSchedule(index);
        return index;
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
