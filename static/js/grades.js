/* Historical course and professor grade summaries. */
const Grades = {
    _courseCache: {},
    _professorCache: {},
    _courseLoadId: 0,
    _professorLoadId: 0,
    _professorLookupId: 0,

    async courseData(code) {
        if (this._courseCache[code]) return this._courseCache[code];
        const response = await fetch('/api/course-grades', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        if (!response.ok) throw new Error(`Grade lookup failed (${response.status})`);
        const data = await response.json();
        this._courseCache[code] = data;
        return data;
    },

    async loadForCourse(code) {
        const container = document.getElementById('grades-container');
        if (!container) return;
        const loadId = ++this._courseLoadId;
        container.innerHTML = '<p class="loading">Loading historical grades</p>';
        try {
            const data = await this.courseData(code);
            if (loadId !== this._courseLoadId || Search?._detailGroup?.code !== code) return;
            this.renderCourse(container, data);
        } catch (error) {
            if (loadId !== this._courseLoadId) return;
            container.innerHTML = '<p class="hint">No Columbia grade history is available for this course.</p>';
        }
    },

    formatGpa(value) {
        return value === null || value === undefined ? 'N/A' : Number(value).toFixed(2);
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

    currentInstructorRecords(data) {
        const group = Search?._detailGroup || { sections: [] };
        if (typeof Scheduler !== 'undefined' && Scheduler.currentInstructorSummaries) {
            return Scheduler.currentInstructorSummaries(group, data, Search?._detailFaculty || []);
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

    renderCourse(container, data) {
        const viewedInstructor = Search?.currentDetailSection?.()?.instr || '';
        const normalizedViewed = this.normalizeName(viewedInstructor);
        const instructors = this.currentInstructorRecords(data).sort((a, b) => {
            const aCurrent = this.normalizeName(a.displayName || a.name) === normalizedViewed ? 1 : 0;
            const bCurrent = this.normalizeName(b.displayName || b.name) === normalizedViewed ? 1 : 0;
            return bCurrent - aCurrent || Number(b.open || 0) - Number(a.open || 0);
        });
        const instructorCards = instructors.map((instructor, index) => {
            const grade = instructor.grade;
            const displayName = instructor.displayName || instructor.name;
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
        const markup = `
            <div class="professor-detail">
                <header class="professor-detail-header"><div><span>Instructor profile</span><h2>${this.escape(name)}</h2></div></header>
                <p class="professor-loading loading" role="status">Loading instructor profile</p>
            </div>
        `;
        if (window.AppModal) AppModal.open(markup, { className: 'professor-profile-modal', label: `Loading instructor ${name}` });
    },

    showUnmatchedProfessor(name, email = '') {
        const markup = `
            <div class="professor-detail">
                <header class="professor-detail-header"><div><span>Instructor</span><h2>${this.escape(name)}</h2>${email ? `<a href="mailto:${this.escape(email)}">${this.escape(email)}</a>` : ''}</div></header>
                <p class="hint">A unique historical grade record could not be matched to this instructor.</p>
            </div>
        `;
        if (window.AppModal) AppModal.open(markup, { className: 'professor-profile-modal', label: `Instructor ${name}` });
    },

    async showProfessor(professorId, context = {}) {
        const loadId = ++this._professorLoadId;
        const detailToken = context.detailToken ?? Search?._detailToken;
        const detailCode = context.detailCode ?? Search?._detailGroup?.code ?? context.currentCourse;
        this.openProfessorLoading(context.displayName || 'Instructor');
        const modalVersion = window.AppModal?.version || 0;
        try {
            let data = this._professorCache[professorId];
            if (!data) {
                const response = await fetch('/api/professor-grades', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: professorId }),
                });
                if (!response.ok) throw new Error('Professor lookup failed');
                data = await response.json();
                this._professorCache[professorId] = data;
            }
            if (loadId !== this._professorLoadId
                || (window.AppModal?.version || 0) !== modalVersion
                || !this.professorDetailContextIsCurrent(detailToken, detailCode)) return;
            const markup = this.professorMarkup(data, context);
            if (window.AppModal) AppModal.open(markup, { className: 'professor-profile-modal', label: `Professor ${data.name}` });
        } catch (error) {
            if (loadId !== this._professorLoadId || (window.AppModal?.version || 0) !== modalVersion) return;
            const markup = `
                <div class="professor-detail">
                    <header class="professor-detail-header"><div><span>Instructor profile</span><h2>${this.escape(context.displayName || 'Instructor')}</h2></div></header>
                    <p class="hint">Instructor details are temporarily unavailable.</p>
                </div>
            `;
            if (window.AppModal) AppModal.open(markup, { className: 'professor-profile-modal', label: 'Instructor details unavailable' });
        }
    },

    professorMarkup(data, context = {}) {
        const courses = (data.courses || []).map(course => {
            const width = Math.max(0, Math.min(100, Number(course.average_gpa || 0) / 4 * 100));
            return `
                <div class="professor-course-row${context.currentCourse === course.code ? ' current' : ''}">
                    <strong>${this.escape(course.code)}</strong>
                    <span>${course.sections} sections · ${Number(course.graded_students || 0).toLocaleString()} grades</span>
                    <em>${this.formatGpa(course.average_gpa)} GPA</em>
                    <i><b style="width:${width}%"></b></i>
                </div>
            `;
        }).join('');
        const years = data.years || [];
        const yearly = years.map(year => {
            const width = Math.max(0, Math.min(100, Number(year.average_gpa || 0) / 4 * 100));
            return `<span title="${year.academic_year - 1}-${String(year.academic_year).slice(-2)}: ${this.formatGpa(year.average_gpa)} GPA"><i style="height:${width}%"></i><small>${String(year.academic_year).slice(-2)}</small></span>`;
        }).join('');
        const reviewQuery = encodeURIComponent(`${data.name} University of South Carolina professor`);
        return `
            <div class="professor-detail">
                <header class="professor-detail-header">
                    <div><span>Instructor profile</span><h2>${this.escape(data.name)}</h2>${context.email ? `<a href="mailto:${this.escape(context.email)}">${this.escape(context.email)}</a>` : ''}</div>
                    <a class="professor-review-link" href="https://www.ratemyprofessors.com/search/professors?q=${reviewQuery}" target="_blank" rel="noopener noreferrer">SEARCH REVIEWS</a>
                </header>
                <div class="grade-summary-grid professor-summary-grid">
                    <div class="grade-stat"><strong>${this.formatGpa(data.average_gpa)}</strong><span>Historical GPA</span></div>
                    <div class="grade-stat"><strong>${data.typical_sections_per_year ?? '—'}</strong><span>Typical sections per active year</span></div>
                    <div class="grade-stat"><strong>${this.escape(data.experience_label || `${data.observed_teaching_semesters || '—'} semesters`)}</strong><span>Semesters observed</span></div>
                </div>
                ${this.gradeStrip(data.grade_counts)}
                <section class="professor-section"><div class="course-detail-card-heading"><h3>Courses taught</h3><span>${Number(data.graded_students || 0).toLocaleString()} counted grades overall</span></div><div class="professor-course-list">${courses || '<p class="hint">No course history available.</p>'}</div></section>
                ${yearly ? `<section class="professor-section"><div class="course-detail-card-heading"><h3>GPA by academic year</h3><span>Each bar is scaled from 0 to 4.0.</span></div><div class="professor-year-chart">${yearly}</div></section>` : ''}
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
