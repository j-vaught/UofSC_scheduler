/*
 * Course search within the schedule tab, instructors, and quick view.
 *
 * One part of the scheduler feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initCoursesPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SchedulerParts) root.SchedulerParts = {};
    root.SchedulerParts.createCoursesPart = api.createCoursesPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createCoursesPart(deps) {
        return {
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
            if (credits === null && firstCrn && deps.api.getDetails) {
                try {
                    const details = await deps.api.getDetails(firstCrn, deps.state.term);
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

            const result = await deps.api.searchCourses(deps.state.term, [
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
                deps.state.addCourse(liveGroup);
                const exactSection = liveGroup._exactCrn
                    ? (liveGroup.sections || []).find(section => String(section.crn) === String(liveGroup._exactCrn))
                    : null;
                if (exactSection) {
                    deps.state.setSectionLock(liveGroup.code, exactSection.crn);
                    this.setCourseStatus(
                        `${liveGroup.code} Section ${exactSection.section || exactSection.crn} added from CRN ${exactSection.crn}.`,
                        'success',
                    );
                } else {
                    this.setCourseStatus(`${liveGroup.code} added. The solver will choose its section.`, 'success');
                }
                return liveGroup;
            } catch (error) {
                this.setCourseStatus(error.message, 'error');
                throw error;
            }
        },

        async addCourseByCode(courseCode) {
            const group = await this.lookupCourseGroup(courseCode);
            await this.hydrateCourseCredits(group);
            deps.state.addCourse(group);
            return group;
        },

        async searchCourseGroups(query) {
            const result = await deps.search.searchLiveCourses(query);
            const groups = {};
            (result.results || []).forEach(section => {
                if (!section.code) return;
                if (!groups[section.code]) {
                    groups[section.code] = {
                        code: section.code,
                        title: section.title || section.code,
                        sections: [],
                        _exactCrn: result.queryType === 'crn' ? result.crn : null,
                    };
                }
                groups[section.code].sections.push(section);
            });
            return Object.values(groups);
        },

        async searchFromInput() {
            const requestId = ++this._courseSearchRequestId;
            const input = document.getElementById('schedule-course-input');
            const button = document.getElementById('btn-search-schedule-courses');
            button.disabled = true;
            this.setCourseStatus('Searching courses');
            const results = document.getElementById('schedule-search-results');
            results.innerHTML = '<p class="loading">Searching courses</p>';
            try {
                const groups = await this.searchCourseGroups(input.value);
                if (requestId !== this._courseSearchRequestId) return;
                this._lastSearchGroups = groups;
                this._searchVisibleCount = this._searchPageSize;
                if (this._lastSearchGroups.length === 0) {
                    this.setCourseStatus('No direct matches in the selected term. Try the Search tab for broader results.', 'error');
                } else {
                    this.setCourseStatus(`${this._lastSearchGroups.length} course${this._lastSearchGroups.length === 1 ? '' : 's'} found.`);
                }
                this.renderCourseSearchResults();
            } catch (error) {
                if (requestId !== this._courseSearchRequestId) return;
                this.setCourseStatus(error.message, 'error');
                results.innerHTML = `<p class="hint">${error.message}</p>`;
            } finally {
                if (requestId === this._courseSearchRequestId) button.disabled = false;
            }
        },

        renderCourseSearchResults() {
            const container = document.getElementById('schedule-search-results');
            if (!container) return;
            if (this._lastSearchGroups.length === 0) {
                const query = document.getElementById('schedule-course-input')?.value.trim();
                const message = query
                    ? 'No direct matches. Try the Search tab for broader results.'
                    : 'Search here by course, CRN, range, or keyword. Use the Search tab for the full search experience.';
                container.innerHTML = `<p class="hint schedule-results-empty">${message}</p>`;
                return;
            }

            container.innerHTML = '';
            this._lastSearchGroups.slice(0, this._searchVisibleCount).forEach(group => {
                const availability = this.scheduleCourseAvailability(group);
                const selected = deps.state.isCourseSelected(group.code);
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
                    if (deps.state.isCourseSelected(group.code)) deps.state.removeCourse(group.code);
                    else await this.addCourseGroup(group);
                });
                container.appendChild(course);
            });
            if (this._searchVisibleCount < this._lastSearchGroups.length) {
                const remaining = this._lastSearchGroups.length - this._searchVisibleCount;
                const increment = Math.min(this._searchPageSize, remaining);
                const showMore = document.createElement('button');
                showMore.type = 'button';
                showMore.className = 'btn-show-more schedule-search-show-more';
                showMore.textContent = `SHOW ${increment} MORE`;
                showMore.addEventListener('click', () => {
                    this._searchVisibleCount += this._searchPageSize;
                    this.renderCourseSearchResults();
                });
                container.appendChild(showMore);
            }
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

        instructorSurname(value) {
            const raw = String(value || '').trim();
            if (!raw) return '';
            if (raw.includes(',')) return raw.slice(0, raw.indexOf(',')).trim();
            return raw.split(/\s+/).at(-1) || '';
        },

        matchingInstructorRecords(records, name) {
            const normalized = this.normalizeInstructorName(name);
            if (!normalized) return [];
            const candidates = records || [];
            const exact = candidates.filter(record => this.normalizeInstructorName(record.name) === normalized);
            if (exact.length) return exact;
            const queryTokens = normalized.split(' ').filter(Boolean);
            if (queryTokens.length === 1) {
                return candidates.filter(record => (
                    this.normalizeInstructorName(this.instructorSurname(record.name)) === normalized
                ));
            }
            const querySet = new Set(queryTokens);
            return candidates.filter(record => {
                const candidateTokens = this.normalizeInstructorName(record.name).split(' ').filter(Boolean);
                const candidateSet = new Set(candidateTokens);
                const sameTokens = candidateTokens.length === queryTokens.length
                    && queryTokens.every(token => candidateSet.has(token));
                if (sameTokens) return true;
                return queryTokens.every(token => candidateSet.has(token))
                    || candidateTokens.every(token => querySet.has(token));
            });
        },

        currentInstructorCrns(group) {
            const groups = new Map();
            (group.sections || []).forEach(section => {
                const instructor = String((section.instructor || section.instr) || '').trim().toLowerCase();
                if (!section.crn || !instructor || ['staff', 'undecided', 'tba'].includes(instructor)) return;
                if (!groups.has(instructor)) groups.set(instructor, []);
                groups.get(instructor).push(String(section.crn));
            });
            const crns = [];
            let added = true;
            while (crns.length < 12 && added) {
                added = false;
                for (const groupCrns of groups.values()) {
                    const crn = groupCrns.shift();
                    if (!crn) continue;
                    crns.push(crn);
                    added = true;
                    if (crns.length === 12) break;
                }
            }
            return crns;
        },

        currentInstructorSummaries(group, gradeData = {}, facultyData = []) {
            const instructors = {};
            const historical = gradeData.instructors || [];
            const facultyKey = member => {
                const professorId = String(member?.professor_id || '').trim();
                if (professorId) return `id:${professorId}`;
                const name = this.normalizeInstructorName(member?.name);
                return name ? `name:${name}` : '';
            };
            const facultyByKey = (facultyData || []).reduce((records, member) => {
                const key = facultyKey(member);
                if (!key) return records;
                const existing = records[key] || {};
                records[key] = {
                    ...existing,
                    ...member,
                    name: member.name || existing.name || '',
                    email: String(member.email || existing.email || '').trim().toLowerCase(),
                    professor_id: member.professor_id || existing.professor_id || '',
                };
                return records;
            }, {});
            const uniqueFaculty = Object.values(facultyByKey);
            const matchingNames = (records, name) => this.matchingInstructorRecords(records, name);
            const resolveFaculty = name => {
                const normalized = this.normalizeInstructorName(name);
                if (!normalized) return null;
                const exact = uniqueFaculty.filter(member => this.normalizeInstructorName(member.name) === normalized);
                if (exact.length === 1) return exact[0];
                if (exact.length > 1) return null;
                const partial = matchingNames(uniqueFaculty, name);
                const historicalMatches = matchingNames(historical, name);
                return partial.length === 1 && historicalMatches.length === 1 ? partial[0] : null;
            };
            (group.sections || []).filter(section => section.crn && !section._isCatalog).forEach(section => {
                const liveFaculty = Object.values((facultyData || [])
                    .filter(member => String(member.crn) === String(section.crn))
                    .reduce((records, member) => {
                        const key = facultyKey(member);
                        if (key) records[key] = facultyByKey[key] || member;
                        return records;
                    }, {}));
                const identities = liveFaculty.length > 0
                    ? liveFaculty
                    : String((section.instructor || section.instr) || '').split(/;|\s+\/\s+|\s+and\s+/i).map(rawName => {
                        const name = rawName.trim();
                        return resolveFaculty(name) || { name, email: '' };
                    });
                identities.forEach(identity => {
                    const name = String(identity.name || '').trim();
                    if (!name || ['staff', 'undecided', 'tba'].includes(name.toLowerCase())) return;
                    const professorId = String(identity.professor_id || '').trim();
                    const key = professorId
                        ? `id:${professorId}`
                        : `name:${this.normalizeInstructorName(name)}`;
                    if (!instructors[key]) {
                        instructors[key] = {
                            name,
                            displayName: name,
                            email: String(identity.email || '').trim().toLowerCase(),
                            professorId,
                            sections: 0,
                            open: 0,
                            grade: null,
                            matchStatus: 'unmatched',
                        };
                    } else if (!instructors[key].email && identity.email) {
                        instructors[key].email = String(identity.email).trim().toLowerCase();
                    }
                    instructors[key].sections += 1;
                    if (this.isOpenSection(section)) instructors[key].open += 1;
                });
            });
            Object.values(instructors).forEach(summary => {
                const idMatches = summary.professorId
                    ? historical.filter(record => String(record.id || '') === summary.professorId)
                    : [];
                const nameMatches = summary.professorId ? [] : matchingNames(historical, summary.name);
                const matches = summary.professorId ? idMatches : nameMatches;
                summary.grade = matches.length === 1 ? matches[0] : null;
                summary.matchStatus = summary.grade ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched';
                summary.displayName = summary.name.includes(',')
                    ? summary.name
                    : summary.grade?.name || summary.name;
                if (!summary.email && summary.grade?.email) summary.email = summary.grade.email;
            });
            return Object.values(instructors)
                .sort((a, b) => b.open - a.open || b.sections - a.sections || a.displayName.localeCompare(b.displayName));
        },

        instructorCardsMarkup(instructors) {
            return instructors.map((instructor, index) => {
                const grade = instructor.grade;
                const gpa = Number(grade?.average_gpa);
                const gpaPosition = Number.isFinite(gpa) ? Math.max(0, Math.min(100, gpa / 4 * 100)) : 0;
                return `
                    <article class="quick-instructor-card">
                        <div class="quick-instructor-heading">
                            <a href="#" data-quick-instructor-index="${index}" title="View this instructor's full profile in Search"><strong>${this.escapeHtml(instructor.displayName || instructor.name)}</strong></a>
                            <span>${instructor.open} open / ${instructor.sections} section${instructor.sections === 1 ? '' : 's'}</span>
                        </div>
                        ${instructor.email ? `<a class="quick-instructor-email" href="mailto:${this.escapeHtml(instructor.email)}">${this.escapeHtml(instructor.email)}</a>` : '<span class="quick-instructor-email unavailable">Email unavailable</span>'}
                        ${Number.isFinite(gpa) ? `
                            <div class="quick-gpa-track" aria-label="Historical course GPA ${gpa.toFixed(2)} out of 4">
                                <span style="width:${gpaPosition}%"></span>
                            </div>
                            <small>${gpa.toFixed(2)} historical course GPA · ${Number(grade.graded_students || 0).toLocaleString()} grades</small>
                        ` : `<small>${instructor.matchStatus === 'ambiguous' ? 'Multiple historical records share this name.' : 'No matched grade history for this course.'}</small>`}
                    </article>
                `;
            }).join('');
        },

        bindQuickInstructorActions(container, instructors, group, selectedSection = null) {
            if (!container) return;
            container.querySelectorAll('[data-quick-instructor-index]').forEach(link => {
                link.addEventListener('click', event => {
                    event.preventDefault();
                    const instructor = instructors[Number(link.dataset.quickInstructorIndex)];
                    if (!instructor) return;
                    this.openProfessorInBrowse(group, selectedSection?.crn || '', instructor);
                });
            });
        },

        updateQuickFaculty(group, gradeData = {}, facultyData = [], selectedSection = null) {
            const count = document.getElementById('quick-instructor-count');
            const grid = document.getElementById('quick-instructor-grid');
            const more = document.getElementById('quick-instructor-more');
            if (!count || !grid || !more) return;
            const instructors = this.currentInstructorSummaries(group, gradeData, facultyData);
            const visible = instructors.slice(0, 4);
            count.textContent = `${instructors.length} listed this term`;
            grid.innerHTML = this.instructorCardsMarkup(visible)
                || '<p class="quick-empty">Instructor assignments have not been posted.</p>';
            this.bindQuickInstructorActions(grid, visible, group, selectedSection);
            const remaining = instructors.length - visible.length;
            more.textContent = remaining > 0
                ? `${remaining} additional instructor${remaining === 1 ? '' : 's'} available in deps.search.`
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

        renderCourseQuickView(group, details = {}, gradeData = {}, offering = {}, detailsPending = false, selectedSection = null) {
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
                            ${selectedSection ? `<p class="course-quick-section-context">Section ${this.escapeHtml(selectedSection.section || '?')} · CRN ${this.escapeHtml(selectedSection.crn || '—')}</p>` : ''}
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
                        <small id="quick-instructor-more" class="quick-more-note">${instructors.length > visibleInstructors.length ? `${instructors.length - visibleInstructors.length} additional instructor${instructors.length - visibleInstructors.length === 1 ? '' : 's'} available in deps.search.` : ''}</small>
                    </section>

                    <section class="course-quick-section quick-grade-section">
                        <div class="quick-section-heading"><h3>Historical grades</h3>${hasGrades ? `<span>${courseGpa.toFixed(2)} GPA · ${Number(gradeData.graded_students).toLocaleString()} grades</span>` : ''}</div>
                        ${hasGrades ? `<div class="quick-grade-strip" aria-label="Historical grade distribution">${gradeStrip}</div><div class="quick-grade-legend">${gradeLegend}</div>` : `<p class="quick-empty">${detailsPending ? 'Loading historical grade data' : 'No historical grade data is available.'}</p>`}
                    </section>

                    <footer class="course-quick-actions">
                        <button id="btn-quick-course-toggle" class="${deps.state.isCourseSelected(group.code) ? 'btn-danger' : 'btn-green'}">${deps.state.isCourseSelected(group.code) ? 'REMOVE' : 'ADD TO SCHEDULE'}</button>
                        <button id="btn-quick-view-browse" class="btn-secondary">${selectedSection ? `VIEW DETAILS FOR SECTION ${this.escapeHtml(selectedSection.section || '?')}` : 'VIEW FULL COURSE DETAILS'}</button>
                    </footer>
                </section>
            `;

            this.bindQuickInstructorActions(
                document.getElementById('quick-instructor-grid'),
                visibleInstructors,
                group,
                selectedSection,
            );

            document.getElementById('btn-quick-course-toggle')?.addEventListener('click', async event => {
                const button = event.currentTarget;
                if (deps.state.isCourseSelected(group.code)) deps.state.removeCourse(group.code);
                else await this.addCourseGroup(group);
                button.textContent = deps.state.isCourseSelected(group.code) ? 'REMOVE' : 'ADD TO SCHEDULE';
                button.className = deps.state.isCourseSelected(group.code) ? 'btn-danger' : 'btn-green';
            });
            document.getElementById('btn-quick-view-browse')?.addEventListener('click', () => this.openCourseInBrowse(group, selectedSection?.crn || ''));
        },

        updateQuickGrades(gradeData = {}) {
            const section = document.querySelector('.course-quick-view .quick-grade-section');
            if (!section) return;
            const courseGpa = Number(gradeData.average_gpa);
            const hasGrades = Number.isFinite(courseGpa) && Number(gradeData.graded_students) > 0;
            if (!hasGrades) {
                section.innerHTML = '<div class="quick-section-heading"><h3>Historical grades</h3></div><p class="quick-empty">No historical grade data is available.</p>';
                return;
            }
            const buckets = this.gradeBuckets(gradeData);
            const gradeStrip = buckets.map(bucket => bucket.percent > 0
                ? `<span class="quick-grade-segment ${bucket.className}" style="width:${bucket.percent}%" title="${bucket.label}: ${bucket.percent}%"></span>`
                : '').join('');
            const gradeLegend = buckets.map(bucket => `
                <span><i class="${bucket.className}"></i><strong>${bucket.percent}%</strong> ${bucket.label}</span>
            `).join('');
            section.innerHTML = `
                <div class="quick-section-heading"><h3>Historical grades</h3><span>${courseGpa.toFixed(2)} GPA · ${Number(gradeData.graded_students).toLocaleString()} grades</span></div>
                <div class="quick-grade-strip" aria-label="Historical grade distribution">${gradeStrip}</div>
                <div class="quick-grade-legend">${gradeLegend}</div>
            `;
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

        async openCourseQuickView(group, selectedSection = null) {
            const overlay = document.getElementById('modal-overlay');
            const modal = document.getElementById('modal');
            const content = document.getElementById('modal-content');
            if (!overlay || !modal || !content) return;
            const loadingMarkup = '<div class="course-quick-loading"><span></span><p>Loading course details</p></div>';
            if (window.AppModal) {
                AppModal.open(loadingMarkup, { className: 'course-quick-modal', label: `Course details for ${group.code}` });
            } else {
                modal.classList.remove('registration-info-modal', 'schedule-preferences-modal');
                modal.classList.add('course-quick-modal');
                content.innerHTML = loadingMarkup;
                overlay.classList.remove('hidden');
            }
            const requestId = ++this._quickViewRequestId;

            const detailsPromise = deps.search && deps.search.fetchBulletinDetailsForCourse
                ? deps.search.fetchBulletinDetailsForCourse(group.code)
                : Promise.resolve({});
            const facultyCrns = this.currentInstructorCrns(group);
            const facultyPromise = facultyCrns.length > 0
                ? deps.api.getFaculty(deps.state.term, facultyCrns)
                : Promise.resolve({ faculty: [] });
            const offeringPromise = deps.api.getOfferingAnalysis(group.code, deps.state.term);
            const gradesPromise = deps.api.getCourseGrades(group.code);
            this.renderCourseQuickView(
                group,
                {},
                {},
                {},
                true,
                selectedSection,
            );
            document.getElementById('modal-close')?.focus();
            let gradeData = {};
            let facultyData = [];
            const updateFaculty = () => {
                if (requestId === this._quickViewRequestId) {
                    this.updateQuickFaculty(group, gradeData, facultyData, selectedSection);
                }
            };
            gradesPromise
                .then(result => {
                    if (requestId !== this._quickViewRequestId) return;
                    gradeData = result?.error ? {} : result || {};
                    this.updateQuickGrades(gradeData);
                    updateFaculty();
                })
                .catch(() => {
                    if (requestId === this._quickViewRequestId) this.updateQuickGrades({});
                });
            facultyPromise
                .then(result => {
                    facultyData = result.faculty || [];
                    updateFaculty();
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

        courseGroupForSection(section) {
            if (!section?.code) return null;
            const stored = deps.state.selectedCourses?.[section.code];
            if (!stored) {
                return { code: section.code, title: section.title || section.code, sections: [section] };
            }
            const hasSection = (stored.sections || []).some(candidate => String(candidate.crn) === String(section.crn));
            return hasSection ? stored : { ...stored, sections: [...(stored.sections || []), section] };
        },

        openSectionQuickView(section) {
            const group = this.courseGroupForSection(section);
            if (group) this.openCourseQuickView(group, section);
        },

        async openCourseInBrowse(group, sectionCrn = '') {
            if (window.AppModal) AppModal.close();
            else document.getElementById('modal-overlay')?.classList.add('hidden');
            if (deps.tabs) deps.tabs.switchTo('semester');
            if (!deps.search) return;
            await deps.search.openCourseFromExternal(group, sectionCrn);
        },

        async openProfessorInBrowse(group, sectionCrn = '', instructor = {}) {
            await this.openCourseInBrowse(group, sectionCrn);
            if (!deps.grades || !deps.grades.showProfessorForCourseName) return;
            const displayName = instructor.displayName || instructor.name || 'Instructor';
            const professorId = instructor.professorId || instructor.grade?.id || '';
            await deps.grades.showProfessorForCourseName(
                group.code,
                displayName,
                instructor.email || '',
                professorId,
            );
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

        };
    }

    return { createCoursesPart };
}));
