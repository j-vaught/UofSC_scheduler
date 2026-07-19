/* Guided degree-planning workflow and official-map preview. */
const DegreeWizard = {
    currentStep: 1,

    init() {
        this.bindNavigation();
        this.bindCourseworkActions();
        this.bindStrategy();
        State.on('profile-updated', () => this.refreshProgram());
        State.on('transcript-updated', () => this.renderCourseworkReview());
        State.on('degree-plan-updated', () => this.showStep(4));
        this.refreshProgram();
        this.renderCourseworkReview();
        if (State.degreePlan.semesters.length) this.showStep(4, false);
    },

    bindNavigation() {
        document.querySelectorAll('[data-degree-next]').forEach(button => {
            button.addEventListener('click', () => this.showStep(Number(button.dataset.degreeNext)));
        });
        document.querySelectorAll('[data-degree-back]').forEach(button => {
            button.addEventListener('click', () => this.showStep(Number(button.dataset.degreeBack)));
        });
        document.querySelectorAll('[data-degree-step-target]').forEach(button => {
            button.addEventListener('click', () => this.showStep(Number(button.dataset.degreeStepTarget)));
        });
    },

    showStep(step, focus = true) {
        if (step > 1 && !State.profile.majorData) return;
        this.currentStep = step;
        document.querySelectorAll('[data-degree-step]').forEach(section => {
            const active = Number(section.dataset.degreeStep) === step;
            section.hidden = !active;
            section.classList.toggle('active', active);
        });
        document.querySelectorAll('[data-degree-step-target]').forEach(button => {
            const target = Number(button.dataset.degreeStepTarget);
            button.disabled = target > Math.max(step, State.degreePlan.semesters.length ? 4 : 3)
                || (target > 1 && !State.profile.majorData);
            button.classList.toggle('active', target === step);
            button.classList.toggle('complete', target < step);
        });
        if (step === 2) this.renderCourseworkReview();
        if (focus) document.querySelector(`[data-degree-step="${step}"]`)?.scrollIntoView({ block: 'start' });
    },

    refreshProgram() {
        const data = State.profile.majorData;
        const next = document.querySelector('[data-degree-next="2"]');
        if (next) next.disabled = !data;
        this.renderMajorMap(data);
    },

    renderMajorMap(data) {
        const container = document.getElementById('major-map-preview');
        if (!container) return;
        if (!data) {
            container.innerHTML = '<div class="degree-empty-state"><strong>Your major map will appear here.</strong><span>Choose a program and catalog year to review its recommended sequence.</span></div>';
            return;
        }
        const semesters = Array.isArray(data.semester_plan) ? data.semester_plan : [];
        const sourceUrl = typeof Profile !== 'undefined' ? Profile.sourceUrl(data) : '';
        const officialTotal = Number(data.total_credits_required) || 120;
        const semesterCards = semesters.map(semester => {
            const rows = (semester.requirements || []).map(requirement => {
                const title = requirement.course_codes?.length
                    ? requirement.course_codes.join(' + ')
                    : requirement.title || 'Degree requirement';
                return `<li><span>${this.escape(title)}</span><strong>${Number(requirement.credit_hours) || 0}</strong></li>`;
            }).join('');
            return `<section class="major-map-semester"><header><strong>${this.escape(semester.label || `Semester ${semester.number}`)}</strong><span>${Number(semester.planned_credit_hours) || ''} cr</span></header><ul>${rows}</ul></section>`;
        }).join('');
        container.innerHTML = `
            <div class="major-map-preview-header">
                <div><span class="degree-eyebrow">IMPORTED MAJOR MAP</span><strong>${this.escape(data.major || '')}</strong><small>${officialTotal} credits required</small></div>
                ${sourceUrl ? `<a href="${this.escape(sourceUrl)}" target="_blank" rel="noopener noreferrer">VIEW PDF</a>` : ''}
            </div>
            <div class="major-map-semesters">${semesterCards || '<p>No semester sequence was found in this map.</p>'}</div>
            <p class="major-map-total-note">The official ${officialTotal}-credit total is authoritative. Choice rows and notes are not counted twice.</p>`;
    },

    bindCourseworkActions() {
        document.getElementById('btn-no-completed-courses')?.addEventListener('click', event => {
            State.replaceCompletedWithManualRecords([]);
            event.currentTarget.classList.add('selected');
            event.currentTarget.textContent = 'NEW STUDENT — NO PRIOR COURSES';
        });
        document.getElementById('btn-add-substitution')?.addEventListener('click', () => {
            const input = document.getElementById('degree-substitution-input');
            const code = State._normalizeCourseCode(input?.value);
            if (!code) {
                input?.setCustomValidity('Enter a course code such as MATH 141.');
                input?.reportValidity();
                return;
            }
            input.setCustomValidity('');
            const mapCourse = State.profile.majorData?.required_courses?.find(course => course.code === code);
            State.addManualCompletedRecords([{ code, title: mapCourse?.title || 'Approved substitution', credits: mapCourse?.credits || 3, semester: 'Approved substitution' }]);
            input.value = '';
        });
    },

    renderCourseworkReview() {
        const container = document.getElementById('degree-coursework-review');
        const count = document.getElementById('degree-coursework-count');
        if (!container || !count) return;
        const details = [...(State.completedDetails || [])];
        count.textContent = details.length ? `${details.length} completed ${details.length === 1 ? 'course' : 'courses'}` : 'No courses added';
        if (!details.length) {
            container.innerHTML = '<div class="degree-empty-state"><strong>No prior courses.</strong><span>Your plan will begin from the first semester of the selected map.</span></div>';
            return;
        }
        const grouped = new Map();
        details.forEach(course => {
            const term = course.semester || 'Prior or assumed credit';
            if (!grouped.has(term)) grouped.set(term, []);
            grouped.get(term).push(course);
        });
        container.innerHTML = [...grouped.entries()].map(([term, courses]) => `
            <section class="coursework-term">
                <header><strong>${this.escape(term)}</strong><span>${courses.reduce((sum, course) => sum + (Number(course.credits) || 0), 0)} credits</span></header>
                <div>${courses.map(course => `<article><strong>${this.escape(course.code)}</strong><span>${this.escape(course.title || '')}</span><small>${Number(course.credits) || 0} cr${course.grade ? ` · ${this.escape(course.grade)}` : ''}</small></article>`).join('')}</div>
            </section>`).join('');
    },

    bindStrategy() {
        document.querySelectorAll('input[name="degree-strategy"]').forEach(input => {
            input.addEventListener('change', () => {
                State.profile.degreeStrategy = input.value;
            });
        });
        const summer = document.getElementById('degree-include-summer');
        if (summer) {
            summer.checked = Boolean(State.profile.includeSummer);
            summer.addEventListener('change', () => {
                State.profile.includeSummer = summer.checked;
            });
        }
    },

    escape(value) {
        const span = document.createElement('span');
        span.textContent = String(value ?? '');
        return span.innerHTML;
    },
};

if (typeof globalThis !== 'undefined') globalThis.DegreeWizard = DegreeWizard;
if (typeof module !== 'undefined' && module.exports) module.exports = DegreeWizard;
