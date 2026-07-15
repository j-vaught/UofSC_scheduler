/* Historical course and professor grade summaries. */
const Grades = {
    _courseCache: {},
    _professorCache: {},

    async loadForCourse(code) {
        const container = document.getElementById('grades-container');
        if (!container) return;
        container.innerHTML = '<p class="loading">Loading historical grades</p>';
        try {
            let data = this._courseCache[code];
            if (!data) {
                const response = await fetch('/api/course-grades', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code }),
                });
                if (response.status === 404) {
                    container.innerHTML = '<p class="hint">No Columbia grade history is available for this course.</p>';
                    return;
                }
                if (!response.ok) throw new Error(`Grade lookup failed (${response.status})`);
                data = await response.json();
                this._courseCache[code] = data;
            }
            this.renderCourse(container, data);
        } catch (error) {
            container.innerHTML = '<p class="hint">Historical grade data is temporarily unavailable.</p>';
        }
    },

    formatGpa(value) {
        return value === null || value === undefined ? 'N/A' : Number(value).toFixed(2);
    },

    distributionRows(counts) {
        const total = Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        return Object.entries(counts || {}).map(([grade, count]) => {
            const percent = total ? (Number(count) / total * 100).toFixed(1) : '0.0';
            return `<tr><td>${this.escape(grade)}</td><td>${Number(count).toLocaleString()}</td><td>${percent}%</td></tr>`;
        }).join('');
    },

    renderCourse(container, data) {
        const instructors = (data.instructors || []).map(instructor => `
            <tr>
                <td><button type="button" data-professor-id="${this.escape(instructor.id)}">${this.escape(instructor.name)}</button></td>
                <td>${instructor.sections}</td>
                <td>${Number(instructor.graded_students || 0).toLocaleString()}</td>
                <td>${this.formatGpa(instructor.average_gpa)}</td>
                <td>${instructor.team_taught_sections || 0}</td>
            </tr>
        `).join('');
        container.innerHTML = `
            <div class="grade-summary">
                <div class="grade-summary-grid">
                    <div class="grade-stat"><strong>${this.formatGpa(data.average_gpa)}</strong><span>Historical GPA</span></div>
                    <div class="grade-stat"><strong>${Number(data.graded_students || 0).toLocaleString()}</strong><span>GPA-counted grades</span></div>
                    <div class="grade-stat"><strong>${data.sections || 0}</strong><span>Historical sections</span></div>
                </div>
            </div>
            <div class="grade-table-wrap">
                <table class="grade-table grade-distribution">
                    <thead><tr><th>Grade</th><th>Count</th><th>Share</th></tr></thead>
                    <tbody>${this.distributionRows(data.grade_counts)}</tbody>
                </table>
            </div>
            <h4 style="margin-top:12px">Professor history for ${this.escape(data.code)}</h4>
            <div class="grade-table-wrap">
                <table class="grade-table">
                    <thead><tr><th>Professor</th><th>Sections</th><th>Grades</th><th>GPA</th><th>Team taught</th></tr></thead>
                    <tbody>${instructors || '<tr><td colspan="5">No matched professor records.</td></tr>'}</tbody>
                </table>
            </div>
            <p class="grade-note">GPA uses A, B+, B, C+, C, D+, D, F, and FN grades. Other outcomes are excluded. Section-level results cannot separate individual contributions in team-taught classes.</p>
        `;
        container.querySelectorAll('[data-professor-id]').forEach(button => {
            button.addEventListener('click', () => this.showProfessor(button.dataset.professorId));
        });
    },

    async showProfessor(professorId) {
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
            const modal = document.getElementById('modal-content');
            document.getElementById('modal')?.classList.remove('course-quick-modal');
            modal.innerHTML = this.professorMarkup(data);
            document.getElementById('modal-overlay').classList.remove('hidden');
        } catch (error) {
            const container = document.getElementById('grades-container');
            if (container) container.insertAdjacentHTML('beforeend', '<p class="hint">Professor details are temporarily unavailable.</p>');
        }
    },

    professorMarkup(data) {
        const courses = (data.courses || []).map(course => `
            <tr><td>${this.escape(course.code)}</td><td>${course.sections}</td><td>${Number(course.graded_students || 0).toLocaleString()}</td><td>${this.formatGpa(course.average_gpa)}</td></tr>
        `).join('');
        const years = (data.years || []).map(year => `
            <tr><td>${year.academic_year - 1}-${String(year.academic_year).slice(-2)}</td><td>${year.sections}</td><td>${year.distinct_courses}</td><td>${Number(year.graded_students || 0).toLocaleString()}</td><td>${this.formatGpa(year.average_gpa)}</td></tr>
        `).join('');
        return `
            <div class="professor-detail">
                <h3>${this.escape(data.name)}</h3>
                <div class="grade-summary-grid">
                    <div class="grade-stat"><strong>${this.formatGpa(data.average_gpa)}</strong><span>Historical GPA</span></div>
                    <div class="grade-stat"><strong>${data.typical_sections_per_year}</strong><span>Typical sections per active year (${data.typical_courses_per_year} distinct courses)</span></div>
                    <div class="grade-stat"><strong>${this.escape(data.experience_label)}</strong><span>Observed teaching span</span></div>
                </div>
                <p class="grade-note">Teaching experience is bounded by available records. “&gt;=” means the professor appears in the earliest available semester and may have taught longer.</p>
                <h4>Course breakdown</h4>
                <div class="grade-table-wrap"><table class="grade-table"><thead><tr><th>Course</th><th>Sections</th><th>Grades</th><th>GPA</th></tr></thead><tbody>${courses}</tbody></table></div>
                <h4>Yearly breakdown</h4>
                <div class="grade-table-wrap"><table class="grade-table"><thead><tr><th>Academic year</th><th>Sections</th><th>Courses</th><th>Grades</th><th>GPA</th></tr></thead><tbody>${years}</tbody></table></div>
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
