/* Selected courses for the schedule workspace. */
const ScheduleSidebar = {
    render() {
        const list = document.getElementById('selected-courses-list');
        const creditsEl = document.getElementById('selected-credits');
        const countEl = document.getElementById('schedule-selected-count');
        if (!list) return;

        const courses = State.selectedCourses;
        const codes = Object.keys(courses);
        if (countEl) countEl.textContent = codes.length > 0 ? `(${codes.length} selected)` : '';

        if (codes.length === 0) {
            list.innerHTML = '<p class="hint">Add courses from the Search tab. You do not need to choose a section.</p>';
            if (creditsEl) creditsEl.textContent = '';
            return;
        }

        let html = '';
        let totalCredits = 0;

        codes.forEach(code => {
            const course = courses[code];
            const title = course.title || code;
            const openSections = (course.sections || []).filter(section => !section.stat || section.stat === 'A');
            const applied = State.selectedSections[code];
            const lockedCrn = State.sectionLocks[code] || '';
            const lockedSection = (course.sections || []).find(section =>
                String(section.crn) === String(lockedCrn),
            );
            const lockedSectionIsFull = Boolean(
                lockedSection && lockedSection.stat && lockedSection.stat !== 'A',
            );
            const defaultSectionLabel = applied?.section
                ? `Section ${applied.section} selected`
                : `${openSections.length} open section${openSections.length === 1 ? '' : 's'}`;
            const sortedSections = [...(course.sections || [])].sort((left, right) => {
                const leftOpen = !left.stat || left.stat === 'A';
                const rightOpen = !right.stat || right.stat === 'A';
                if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
                return String(left.section || '').localeCompare(
                    String(right.section || ''),
                    undefined,
                    { numeric: true, sensitivity: 'base' },
                );
            });
            const sectionOptions = sortedSections.map(section => {
                const instructor = (section.instructor || section.instr) && (section.instructor || section.instr) !== 'Staff' ? (section.instructor || section.instr) : 'Undecided';
                const availability = !section.stat || section.stat === 'A' ? '' : ' — FULL';
                const selected = String(section.crn) === String(lockedCrn) ? ' selected' : '';
                return `<option value="${section.crn}"${selected}>Section ${section.section || '?'} — ${instructor} — ${section.meets || 'TBA'}${availability}</option>`;
            }).join('');

            html += `
                <div class="selected-course-item">
                    <div class="selected-course-header">
                        <button type="button" class="selected-course-open" data-code="${code}" title="View details for ${code}"><strong>${code}</strong></button>
                        <button type="button" class="btn-remove" data-code="${code}" title="Remove ${code} from your courses" aria-label="Remove ${code} from your courses"><span class="ui-icon icon-close" aria-hidden="true"></span></button>
                    </div>
                    <div class="selected-course-detail">${title}</div>
                    <label class="section-lock-label" for="section-lock-${code.replace(/\s+/g, '-')}">Section preference</label>
                    <div class="section-lock-control">
                        <select class="section-lock-select" id="section-lock-${code.replace(/\s+/g, '-')}" data-code="${code}">
                            <option value="">${defaultSectionLabel}</option>
                            ${sectionOptions}
                        </select>
                        <span class="section-lock-arrow" aria-hidden="true">▼</span>
                    </div>
                    ${lockedCrn ? `<button type="button" class="btn-clear-section" data-code="${code}">CLEAR SECTION</button>` : ''}
                    ${lockedSectionIsFull
                        ? '<div class="section-lock-warning">Full section selected. Planning only; enrollment requires an opening or override.</div>'
                        : ''}
                </div>
            `;
            const creditValues = String(
                course.credits ?? (course.sections || [])[0]?.hours ?? 3,
            ).match(/\d+(?:\.\d+)?/g) || ['3'];
            totalCredits += Math.max(...creditValues.map(Number));
        });

        list.innerHTML = html;
        if (creditsEl) creditsEl.textContent = `${totalCredits} credits`;

        list.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                State.removeCourse(btn.dataset.code);
            });
        });
        list.querySelectorAll('.selected-course-open').forEach(button => {
            button.addEventListener('click', () => {
                const course = State.selectedCourses[button.dataset.code];
                if (!course || typeof Scheduler === 'undefined') return;
                const crn = State.sectionLocks[button.dataset.code] || State.selectedSections[button.dataset.code]?.crn;
                const section = (course.sections || []).find(candidate => String(candidate.crn) === String(crn));
                Scheduler.openCourseQuickView(course, section || null);
            });
        });
        list.querySelectorAll('.btn-clear-section').forEach(button => {
            button.addEventListener('click', () => State.setSectionLock(button.dataset.code, ''));
        });
        list.querySelectorAll('.section-lock-select').forEach(select => {
            select.addEventListener('change', () => {
                State.setSectionLock(select.dataset.code, select.value);
            });
        });
    },
};

if (typeof module === 'object' && module.exports) module.exports = ScheduleSidebar;
if (typeof globalThis === 'object') globalThis.ScheduleSidebar = ScheduleSidebar;
