/* Historical course and professor grade summaries. */
const Grades = {
    _courseCache: {},
    _professorCache: {},
    _courseLoadId: 0,
    _professorLoadId: 0,
    _professorLookupId: 0,
    _courseFacultyCache: {},

    async courseData(code) {
        if (this._courseCache[code]) return this._courseCache[code];
        const data = await API.getCourseGrades(code);
        if (!data) throw new Error('Historical grades are unavailable for this course');
        this._courseCache[code] = data;
        return data;
    },

    courseFacultyKey(code, group = Search?._detailGroup || { sections: [] }) {
        const term = Search?._detailTerm || globalThis.State?.term || '';
        const crns = typeof Scheduler !== 'undefined'
            ? Scheduler.currentInstructorCrns(group).slice().sort()
            : [];
        return `${term}:${code}:${crns.join(',')}`;
    },

    currentFacultyForCourse(code) {
        const group = Search?._detailGroup || { sections: [] };
        if (typeof Scheduler === 'undefined' || typeof API === 'undefined') return Promise.resolve([]);
        const crns = Scheduler.currentInstructorCrns(group);
        const key = this.courseFacultyKey(code, group);
        const cached = this._courseFacultyCache[key];
        if (cached) return Promise.resolve(cached);
        if (!crns.length) {
            this._courseFacultyCache[key] = [];
            return Promise.resolve([]);
        }
        const request = API.getFaculty(Search?._detailTerm || State.term, crns)
            .then(data => data.faculty || [])
            .catch(() => [])
            .then(faculty => {
                this._courseFacultyCache[key] = faculty;
                return faculty;
            });
        this._courseFacultyCache[key] = request;
        return request;
    },

    refreshCourseFaculty(code) {
        return this.currentFacultyForCourse(code).then(faculty => {
            const data = this._courseCache[code];
            const container = document.getElementById('grades-container');
            if (data && container && Search?._detailGroup?.code === code) {
                this.renderCourse(container, data, faculty);
            }
            return faculty;
        });
    },

    courseFacultyRecords(code) {
        const cached = this._courseFacultyCache[this.courseFacultyKey(code)];
        if (Array.isArray(cached)) return cached;
        return Search?._detailFaculty || [];
    },

    async loadForCourse(code) {
        const container = document.getElementById('grades-container');
        if (!container) return;
        const loadId = ++this._courseLoadId;
        container.innerHTML = '<p class="loading">Loading historical grades</p>';
        const facultyKey = this.courseFacultyKey(code);
        const facultyPromise = this.currentFacultyForCourse(code);
        try {
            const data = await this.courseData(code);
            if (loadId !== this._courseLoadId || Search?._detailGroup?.code !== code) return;
            this.renderCourse(container, data, this.courseFacultyRecords(code));
            facultyPromise.then(faculty => {
                if (loadId !== this._courseLoadId
                    || Search?._detailGroup?.code !== code
                    || this.courseFacultyKey(code) !== facultyKey) return;
                this.renderCourse(container, data, faculty);
            });
        } catch (error) {
            if (loadId !== this._courseLoadId) return;
            container.innerHTML = '<p class="hint">No Columbia grade history is available for this course.</p>';
        }
    },

    formatGpa(value) {
        return value === null || value === undefined ? 'N/A' : Number(value).toFixed(2);
    },

    displayProfessorName(value) {
        const raw = String(value || '').trim();
        const comma = raw.indexOf(',');
        if (comma < 0) return raw;
        const last = raw.slice(0, comma).trim();
        const first = raw.slice(comma + 1).trim();
        return `${first} ${last}`.replace(/\s+/g, ' ').trim();
    },

    rateMyProfessorsUrl(value) {
        const query = encodeURIComponent(this.displayProfessorName(value)).replace(/%20/g, '+');
        return `https://www.ratemyprofessors.com/search/professors/1309?q=${query}`;
    },

    professorGpaKind(value) {
        const gpa = Number(value);
        if (!Number.isFinite(gpa)) return 'unknown';
        if (gpa >= 3.5) return 'high';
        if (gpa >= 3.0) return 'strong';
        if (gpa >= 2.5) return 'middle';
        return 'low';
    },

    gradeBuckets(counts = {}) {
        const number = grade => Number(counts[grade] || 0);
        const buckets = [
            { key: 'a', label: 'A', count: number('A') },
            { key: 'b', label: 'B range', count: number('B+') + number('B') },
            { key: 'c', label: 'C range', count: number('C+') + number('C') },
            { key: 'df', label: 'D / F', count: number('D+') + number('D') + number('F') + number('FN') },
        ];
        const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
        return buckets.map(bucket => ({ ...bucket, percent: total ? bucket.count / total * 100 : 0 }));
    },

    gradeStrip(counts) {
        const buckets = this.gradeBuckets(counts);
        return `
            <div class="grade-visual" aria-label="Historical grade distribution">
                <div class="grade-visual-strip">${buckets.map(bucket => `<i class="grade-${bucket.key}" style="width:${bucket.percent.toFixed(2)}%" title="${bucket.label}: ${bucket.percent.toFixed(1)}%"></i>`).join('')}</div>
                <div class="grade-visual-legend">${buckets.map(bucket => `<span><i class="grade-${bucket.key}"></i><strong>${bucket.percent.toFixed(0)}%</strong> ${bucket.label}</span>`).join('')}</div>
            </div>
        `;
    },

    normalizeName(value) {
        return String(value || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
    },

    currentInstructorRecords(data, facultyData = null) {
        const group = Search?._detailGroup || { sections: [] };
        if (typeof Scheduler !== 'undefined' && Scheduler.currentInstructorSummaries) {
            return Scheduler.currentInstructorSummaries(
                group,
                data,
                facultyData === null ? this.courseFacultyRecords(group.code || '') : facultyData,
            );
        }
        const historical = data.instructors || [];
        const currentNames = [...new Set((group.sections || [])
            .filter(section => section.crn && !section._isCatalog)
            .map(section => String(section.instr || '').trim())
            .filter(name => name && !['staff', 'undecided', 'tba'].includes(name.toLowerCase())))];
        return currentNames.map(name => {
            const normalized = this.normalizeName(name);
            const grade = historical.find(record => this.normalizeName(record.name) === normalized) || null;
            return { name, displayName: grade?.name || name, email: '', sections: 0, open: 0, grade };
        });
    },

    renderCourse(container, data, facultyData = null) {
        const viewedInstructor = Search?.currentDetailSection?.()?.instr || '';
        const normalizedViewed = this.normalizeName(viewedInstructor);
        const instructors = this.currentInstructorRecords(data, facultyData).sort((a, b) => {
            const aCurrent = this.normalizeName(a.displayName || a.name) === normalizedViewed ? 1 : 0;
            const bCurrent = this.normalizeName(b.displayName || b.name) === normalizedViewed ? 1 : 0;
            return bCurrent - aCurrent || Number(b.open || 0) - Number(a.open || 0);
        });
        const instructorCards = instructors.map((instructor, index) => {
            const grade = instructor.grade;
            const displayName = this.displayProfessorName(instructor.displayName || instructor.name);
            const current = normalizedViewed && this.normalizeName(displayName) === normalizedViewed;
            const gpa = Number(grade?.average_gpa);
            const width = Number.isFinite(gpa) ? Math.max(0, Math.min(100, gpa / 4 * 100)) : 0;
            const sectionText = `${instructor.open || 0} open / ${instructor.sections || 0} ${Number(instructor.sections || 0) === 1 ? 'section' : 'sections'}`;
            return `
                <button type="button" class="grade-instructor-card${current ? ' current' : ''}" data-current-instructor-index="${index}">
                    <span class="grade-instructor-heading"><strong>${this.escape(displayName)}</strong>${current ? '<em>Selected section</em>' : ''}</span>
                    ${instructor.email ? `<span class="grade-instructor-email">${this.escape(instructor.email)}</span>` : ''}
                    <span class="grade-instructor-meta">${grade ? `${this.formatGpa(grade.average_gpa)} historical course GPA · ${Number(grade.graded_students || 0).toLocaleString()} grades` : 'No matched grade history for this course'}</span>
                    ${grade ? `<span class="grade-instructor-scale"><i style="width:${width}%"></i></span>` : ''}
                    <small>${sectionText}</small>
                </button>
            `;
        }).join('');
        const gradeOrder = ['A', 'B+', 'B', 'C+', 'C', 'D+', 'D', 'F', 'FN'];
        const gradePoints = gradeOrder.map(grade => {
            const count = Number(data.grade_counts?.[grade] || 0);
            const total = Number(data.graded_students || 0);
            return { grade, count, percent: total ? count / total * 100 : 0 };
        });
        const maxPercent = Math.max(1, ...gradePoints.map(point => point.percent));
        const exactGrades = gradePoints.map(point => {
            const height = Math.max(2, point.percent / maxPercent * 100);
            const title = `${point.grade}: ${point.count.toLocaleString()} grades, ${point.percent.toFixed(1)}%`;
            return `<span class="grade-distribution-column" title="${this.escape(title)}" tabindex="0"><span class="grade-distribution-bar-wrap"><i style="height:${height.toFixed(2)}%"></i></span><strong>${this.escape(point.grade)}</strong><em>${point.count.toLocaleString()}</em><small>${point.percent.toFixed(1)}%</small></span>`;
        }).join('');

        container.innerHTML = `
            <div class="grade-detail-heading"><div><h2>Historical grades</h2><p>Course-wide results from available Columbia records.</p></div></div>
            <div class="grade-summary-grid">
                <div class="grade-stat"><strong>${this.formatGpa(data.average_gpa)}</strong><span>Historical GPA</span></div>
                <div class="grade-stat"><strong>${Number(data.graded_students || 0).toLocaleString()}</strong><span>Counted grades</span></div>
                <div class="grade-stat"><strong>${Number(data.sections || 0).toLocaleString()}</strong><span>Historical sections</span></div>
            </div>
            ${this.gradeStrip(data.grade_counts)}
            <details class="grade-exact-disclosure"><summary>View exact grade counts</summary><div class="grade-distribution-plot" aria-label="Exact historical grade distribution">${exactGrades}</div></details>
            <section class="grade-instructors">
                <div class="course-detail-card-heading"><h2>Current instructors</h2><span>Offering this course this term. Select one for their full history.</span></div>
                <div class="grade-instructor-grid">${instructorCards || '<p class="hint">Instructor assignments have not been posted.</p>'}</div>
            </section>
            <p class="grade-note">GPA includes A, B+, B, C+, C, D+, D, F, and FN. Other outcomes are excluded. Team-taught sections cannot separate individual contributions.</p>
        `;
        container.querySelectorAll('[data-current-instructor-index]').forEach(button => {
            button.addEventListener('click', () => {
                const instructor = instructors[Number(button.dataset.currentInstructorIndex)];
                if (instructor?.grade?.id) {
                    this.showProfessor(instructor.grade.id, {
                        displayName: instructor.displayName || instructor.name,
                        email: instructor.email,
                        currentCourse: Search?._detailGroup?.code || '',
                    });
                } else if (instructor) {
                    this.showUnmatchedProfessor(instructor.displayName || instructor.name, instructor.email);
                }
            });
        });
    },

    async showProfessorForCourseName(code, name, email = '') {
        const lookupId = ++this._professorLookupId;
        const detailToken = Search?._detailToken;
        const detailCode = Search?._detailGroup?.code || code;
        this.openProfessorLoading(name);
        const modalVersion = window.AppModal?.version || 0;
        try {
            const data = await this.courseData(code);
            if (lookupId !== this._professorLookupId
                || (window.AppModal?.version || 0) !== modalVersion
                || !this.professorDetailContextIsCurrent(detailToken, detailCode)) return;
            const normalized = this.normalizeName(name);
            const matches = (data.instructors || []).filter(instructor => this.normalizeName(instructor.name) === normalized);
            if (matches.length === 1) {
                this.showProfessor(matches[0].id, {
                    displayName: name,
                    email,
                    currentCourse: code,
                    detailToken,
                    detailCode,
                    loadingOpen: true,
                });
                return;
            }
            this.showUnmatchedProfessor(name, email);
        } catch (error) {
            if (lookupId !== this._professorLookupId
                || (window.AppModal?.version || 0) !== modalVersion
                || !this.professorDetailContextIsCurrent(detailToken, detailCode)) return;
            this.showUnmatchedProfessor(name, email);
        }
    },

    professorDetailContextIsCurrent(token, code) {
        if (token === null || token === undefined || !code || typeof Search === 'undefined') return true;
        return Search._detailToken === token
            && Search._browseState === 'detail'
            && Search._detailGroup?.code === code;
    },

    openProfessorLoading(name = 'Instructor') {
        const displayName = this.displayProfessorName(name);
        const markup = `
            <div class="professor-detail">
                <header class="professor-detail-header"><div><span>Instructor profile</span><h2>${this.escape(displayName)}</h2></div></header>
                <p class="professor-loading loading" role="status">Loading instructor profile</p>
            </div>
        `;
        if (window.AppModal) AppModal.open(markup, { className: 'professor-profile-modal', label: `Loading instructor ${displayName}` });
    },

    showUnmatchedProfessor(name, email = '') {
        const displayName = this.displayProfessorName(name);
        const markup = `
            <div class="professor-detail">
                <header class="professor-detail-header"><div><span>Instructor</span><h2>${this.escape(displayName)}</h2>${email ? `<a href="mailto:${this.escape(email)}">${this.escape(email)}</a>` : ''}</div></header>
                <p class="hint">A unique historical grade record could not be matched to this instructor.</p>
            </div>
        `;
        if (window.AppModal) AppModal.update(markup, { className: 'professor-profile-modal', label: `Instructor ${displayName}` });
    },

    async showProfessor(professorId, context = {}) {
        const loadId = ++this._professorLoadId;
        const detailToken = context.detailToken ?? Search?._detailToken;
        const detailCode = context.detailCode ?? Search?._detailGroup?.code ?? context.currentCourse;
        if (!context.loadingOpen) this.openProfessorLoading(context.displayName || 'Instructor');
        const modalVersion = window.AppModal?.version || 0;
        try {
            let data = this._professorCache[professorId];
            if (!data) {
                data = await API.getProfessorGrades(professorId);
                if (!data) {
                    if (loadId !== this._professorLoadId
                        || (window.AppModal?.version || 0) !== modalVersion
                        || !this.professorDetailContextIsCurrent(detailToken, detailCode)) return;
                    this.showUnmatchedProfessor(context.displayName || 'Instructor', context.email || '');
                    return;
                }
                this._professorCache[professorId] = data;
            }
            if (loadId !== this._professorLoadId
                || (window.AppModal?.version || 0) !== modalVersion
                || !this.professorDetailContextIsCurrent(detailToken, detailCode)) return;
            const markup = this.professorMarkup(data, context);
            if (window.AppModal) AppModal.update(markup, { className: 'professor-profile-modal', label: `Professor ${this.displayProfessorName(data.name)}` });
        } catch (error) {
            if (loadId !== this._professorLoadId || (window.AppModal?.version || 0) !== modalVersion) return;
            if (error?.code === 'STATIC_PROFESSOR_NOT_FOUND') {
                this.showUnmatchedProfessor(context.displayName || 'Instructor', context.email || '');
                return;
            }
            const markup = `
                <div class="professor-detail">
                    <header class="professor-detail-header"><div><span>Instructor profile</span><h2>${this.escape(context.displayName || 'Instructor')}</h2></div></header>
                    <p class="hint">Instructor details are temporarily unavailable.</p>
                </div>
            `;
            if (window.AppModal) AppModal.update(markup, { className: 'professor-profile-modal', label: 'Instructor details unavailable' });
        }
    },

    professorYearMarkup(years = []) {
        const points = years
            .map(year => ({ year: Number(year.academic_year), gpa: Number(year.average_gpa) }))
            .filter(point => Number.isFinite(point.year) && Number.isFinite(point.gpa))
            .sort((left, right) => left.year - right.year);
        if (!points.length) return '';
        const firstYear = points[0].year;
        const lastYear = points[points.length - 1].year;
        const yearSpan = lastYear - firstYear;
        const plotTop = 6;
        const plotHeight = 88;
        const positionGpa = gpa => plotTop + (4 - Math.max(0, Math.min(4, gpa))) / 4 * plotHeight;
        const positioned = points.map(point => ({
            ...point,
            x: yearSpan === 0 ? 50 : 5 + (point.year - firstYear) * 90 / yearSpan,
            y: positionGpa(point.gpa),
        }));
        const axisValues = [4, 3, 2, 1, 0];
        const axis = axisValues
            .map(value => `<span style="top:${positionGpa(value)}%">${value.toFixed(1)}</span>`).join('');
        const gridLines = axisValues
            .map(value => `<line class="professor-year-gridline" x1="0" y1="${positionGpa(value)}" x2="100" y2="${positionGpa(value)}" vector-effect="non-scaling-stroke"></line>`).join('');
        const linePoints = positioned.map(point => `${point.x},${point.y}`).join(' ');
        const line = positioned.length > 1
            ? `<polyline class="professor-year-line" points="${linePoints}" vector-effect="non-scaling-stroke"></polyline>`
            : '';
        const markers = positioned.map(point => `<span class="professor-year-point" role="img" tabindex="0" style="left:${point.x}%;top:${point.y}%" title="${point.year}: ${this.formatGpa(point.gpa)} GPA" aria-label="${point.year}, ${this.formatGpa(point.gpa)} GPA"><span>${point.year} · ${this.formatGpa(point.gpa)} GPA</span></span>`).join('');
        const middleLabelIndex = Math.floor((positioned.length - 1) / 2);
        const labels = positioned.map((point, index) => {
            const compactVisible = index === 0
                || index === positioned.length - 1
                || index === middleLabelIndex;
            return `<span class="professor-year-label${compactVisible ? ' compact-visible' : ''}" style="left:${point.x}%">${point.year}</span>`;
        }).join('');
        return `
            <div class="professor-year-plot" role="group" aria-label="Historical GPA by academic year">
                <div class="professor-year-axis" aria-hidden="true">${axis}</div>
                <svg class="professor-year-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                    ${gridLines}${line}
                </svg>
                ${markers}
            </div>
            <div class="professor-year-labels">${labels}</div>
        `;
    },

    professorMarkup(data, context = {}) {
        const courses = [...(data.courses || [])]
            .sort((left, right) => String(left.code || '').localeCompare(String(right.code || ''), undefined, { numeric: true }))
            .map(course => {
            const gpa = this.formatGpa(course.average_gpa);
            return `
                <div class="professor-course-row${context.currentCourse === course.code ? ' current' : ''}">
                    <i class="professor-course-gpa-dot ${this.professorGpaKind(course.average_gpa)}" aria-hidden="true"></i>
                    <strong>${this.escape(course.code)}</strong>
                    <em>${gpa} GPA</em>
                </div>
            `;
        }).join('');
        const yearly = this.professorYearMarkup(data.years || []);
        const displayName = this.displayProfessorName(data.name);
        const reviewUrl = this.rateMyProfessorsUrl(data.name);
        return `
            <div class="professor-detail">
                <header class="professor-detail-header">
                    <div><span>Instructor profile</span><h2>${this.escape(displayName)}</h2>${context.email ? `<a href="mailto:${this.escape(context.email)}">${this.escape(context.email)}</a>` : ''}</div>
                    <a class="professor-review-link" href="${reviewUrl}" target="_blank" rel="noopener noreferrer">SEARCH REVIEWS</a>
                </header>
                <div class="professor-profile-summary">
                    <div class="professor-primary-gpa"><span>Overall historical GPA</span><strong>${this.formatGpa(data.average_gpa)}</strong><small>${Number(data.graded_students || 0).toLocaleString()} counted grades</small></div>
                    <div class="professor-profile-fact"><strong>${data.typical_sections_per_year ?? '—'}</strong><span>Typical sections per active year</span></div>
                    <div class="professor-profile-fact"><strong>${this.escape(data.experience_label || `${data.observed_teaching_semesters || '—'} semesters`)}</strong><span>Teaching span in available records</span></div>
                </div>
                <section class="professor-section"><div class="course-detail-card-heading"><h3>Courses taught</h3><span>Alphabetical by course code</span></div><div class="professor-course-list">${courses || '<p class="hint">No course history available.</p>'}</div></section>
                ${yearly ? `<section class="professor-section"><div class="course-detail-card-heading"><h3>GPA by year</h3><span>Hover or focus a point for the exact value.</span></div>${yearly}</section>` : ''}
                <p class="grade-note">Observed teaching history is limited to available records. “&gt;=” means the instructor appears in the earliest available semester and may have taught longer.</p>
            </div>
        `;
    },

    escape(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    },
};
