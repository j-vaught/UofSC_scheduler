/*
 * Drag and drop, and validating a planned move.
 *
 * One part of the degree-plan feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function initMovesPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.DegreePlanParts) root.DegreePlanParts = {};
    root.DegreePlanParts.createMovesPart = api.createMovesPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createMovesPart(deps) {
        return {
        bindDragDrop() {
            const container = document.getElementById('semester-columns');
            if (!container) return;

            container.addEventListener('dragstart', (e) => {
                const card = e.target.closest(`.${this.CARD_DOM.CARD_CLASS}`);
                if (!card) { e.preventDefault(); return; }
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    code: card.dataset[this.CARD_DOM.CODE_ATTR],
                    fromTerm: card.dataset[this.CARD_DOM.SEMESTER_ATTR],
                    fromSection: card.dataset[this.CARD_DOM.SECTION_ATTR] || this.CARD_DOM.SECTION_PLANNED,
                }));
                card.classList.add('dragging');
            });

            container.addEventListener('dragend', (e) => {
                const card = e.target.closest(`.${this.CARD_DOM.CARD_CLASS}`);
                if (card) card.classList.remove('dragging');
            });

            container.addEventListener('dragover', (e) => {
                const zone = e.target.closest(`.${this.CARD_DOM.COURSES_CONTAINER_CLASS}`);
                if (zone) {
                    e.preventDefault();
                    zone.classList.add('drag-over');
                }
            });

            container.addEventListener('dragleave', (e) => {
                const zone = e.target.closest(`.${this.CARD_DOM.COURSES_CONTAINER_CLASS}`);
                if (zone) zone.classList.remove('drag-over');
            });

            container.addEventListener('drop', (e) => {
                e.preventDefault();
                const zone = e.target.closest(`.${this.CARD_DOM.COURSES_CONTAINER_CLASS}`);
                if (!zone) return;
                zone.classList.remove('drag-over');

                try {
                    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                    const toTerm = zone.dataset[this.CARD_DOM.TERM_ATTR];
                    const toSection = zone.dataset[this.CARD_DOM.SECTION_ATTR] || this.CARD_DOM.SECTION_PLANNED;

                    if (data.fromTerm === toTerm) return;

                    // Enforce drag rules:
                    // completed/current -> completed/current: OK
                    // completed/current -> planned: NOT allowed (use delete instead)
                    // planned -> planned: OK
                    // planned -> completed/current: NOT allowed
                    if (data.fromSection === this.CARD_DOM.SECTION_COMPLETED && toSection === this.CARD_DOM.SECTION_PLANNED) return;
                    if (data.fromSection === this.CARD_DOM.SECTION_PLANNED && toSection === this.CARD_DOM.SECTION_COMPLETED) return;

                    this.moveCourse(data.code, data.fromTerm, toTerm, data.fromSection, toSection);
                } catch (err) {
                    console.error('Drop error:', err);
                }
            });
        },

        linkedCourseCodesForMove(code, fromSem) {
            const majorCourses = deps.profile().majorData?.required_courses || [];
            const definition = majorCourses.find(item => item.code === code) || {};
            const linked = new Set(definition.corequisites || []);
            DegreePlannerRuntime.corequisiteGroupsForCourse(definition).forEach(group => {
                const candidates = group.courses || [];
                if (group.type === 'or') {
                    const selected = candidates.find(linkedCode => (
                        fromSem.courses.some(item => item.code === linkedCode)
                    ));
                    if (selected) linked.add(selected);
                } else candidates.forEach(linkedCode => linked.add(linkedCode));
            });
            if (/\d{3}L$/.test(code)) linked.add(code.slice(0, -1));
            else if (/\d{3}$/.test(code)) linked.add(`${code}L`);
            majorCourses.forEach(item => {
                if ((item.corequisites || []).includes(code)) linked.add(item.code);
                if (DegreePlannerRuntime.corequisiteGroupsForCourse(item)
                    .some(group => (group.courses || []).includes(code))) linked.add(item.code);
            });
            return new Set([code, ...[...linked].filter(linkedCode => (
                fromSem.courses.some(item => item.code === linkedCode)
            ))]);
        },

        validatePlannedMove(code, fromTerm, toTerm) {
            const semesters = deps.plan().semesters || [];
            const fromSem = semesters.find(semester => semester.term === fromTerm);
            const toSem = semesters.find(semester => semester.term === toTerm);
            if (!fromSem || !toSem) return { valid: false, reason: 'missing_semester' };
            const definitions = deps.profile().majorData?.required_courses || [];
            const definitionsByCode = new Map(definitions.map(course => [course.code, course]));
            const movedCodes = this.linkedCourseCodesForMove(code, fromSem);
            const termByCode = new Map();
            semesters.forEach(semester => {
                semester.courses.forEach(course => termByCode.set(course.code, String(semester.term)));
            });
            movedCodes.forEach(movedCode => termByCode.set(movedCode, String(toTerm)));

            const affected = new Set(movedCodes);
            definitions.forEach(definition => {
                const groups = DegreePlannerRuntime.requirementGroupsForCourse(definition);
                if (groups.some(group => (group.courses || []).some(required => movedCodes.has(required)))) {
                    affected.add(definition.code);
                }
            });

            for (const affectedCode of affected) {
                const definition = definitionsByCode.get(affectedCode) || {};
                const targetTerm = termByCode.get(affectedCode);
                if (!targetTerm) continue;
                const priorTerms = new Set(deps.completedCourses() || []);
                termByCode.forEach((term, plannedCode) => {
                    if (term < targetTerm) priorTerms.add(plannedCode);
                });
                const groups = DegreePlannerRuntime.requirementGroupsForCourse(definition);
                const requirementStatus = DegreePlannerRuntime.evaluateRequirementGroups(groups, priorTerms);
                if (!requirementStatus.eligible) {
                    return {
                        valid: false,
                        reason: affectedCode === code ? 'prerequisite' : 'dependent',
                        course: affectedCode,
                        missing: requirementStatus.missing,
                    };
                }

                const plannedCourse = semesters
                    .flatMap(semester => semester.courses)
                    .find(course => course.code === affectedCode) || {};
                const restriction = definition.offering_restriction || plannedCourse.offering_restriction;
                const destination = semesters.find(semester => String(semester.term) === targetTerm);
                const destinationLabel = String(destination?.label || '').toLowerCase();
                if ((restriction === 'fall_only' && !destinationLabel.startsWith('fall'))
                    || (restriction === 'spring_only' && !destinationLabel.startsWith('spring'))) {
                    return {
                        valid: false,
                        reason: 'offering',
                        course: affectedCode,
                        restriction,
                    };
                }
            }
            return { valid: true, movedCodes };
        },

        moveCourse(code, fromTerm, toTerm, fromSection, toSection) {
            const fromList = fromSection === this.CARD_DOM.SECTION_COMPLETED ? deps.plan().completedSemesters : deps.plan().semesters;
            const toList = toSection === this.CARD_DOM.SECTION_COMPLETED ? deps.plan().completedSemesters : deps.plan().semesters;

            const fromSem = fromList.find(s => s.term === fromTerm);
            const toSem = toList.find(s => s.term === toTerm);

            if (!fromSem || !toSem) return;

            const courseIdx = fromSem.courses.findIndex(c => c.code === code);
            if (courseIdx < 0) return;

            const course = fromSem.courses[courseIdx];

            if (fromSection === this.CARD_DOM.SECTION_PLANNED && toSection === this.CARD_DOM.SECTION_PLANNED) {
                const validation = this.validatePlannedMove(code, fromTerm, toTerm);
                if (!validation.valid && validation.reason === 'dependent') {
                    alert(`${code} cannot be moved to ${toSem.label} because ${validation.course} requires it first.`);
                    return;
                }
                if (!validation.valid && validation.reason === 'prerequisite') {
                    alert(`${code} cannot be moved to ${toSem.label}. Complete ${validation.missing.join(' or ')} first.`);
                    return;
                }
                if (!validation.valid && validation.reason === 'offering') {
                    alert(`${validation.course} is marked ${validation.restriction === 'fall_only' ? 'Fall only' : 'Spring only'} and cannot be placed in ${toSem.label}.`);
                    return;
                }
                if (!validation.valid) return;
            }

            fromSem.courses.splice(courseIdx, 1);
            fromSem.total_credits -= course.credits;
            toSem.courses.push(course);
            toSem.total_credits += course.credits;

            if (fromSection === this.CARD_DOM.SECTION_PLANNED && toSection === this.CARD_DOM.SECTION_PLANNED) {
                const linked = this.linkedCourseCodesForMove(code, fromSem);
                linked.delete(code);
                linked.forEach(linkedCode => {
                    const index = fromSem.courses.findIndex(item => item.code === linkedCode);
                    if (index < 0) return;
                    const [linkedCourse] = fromSem.courses.splice(index, 1);
                    fromSem.total_credits -= linkedCourse.credits;
                    toSem.courses.push(linkedCourse);
                    toSem.total_credits += linkedCourse.credits;
                    deps.plan().pins[linkedCode] = toTerm;
                });
            }

            if (toSection === this.CARD_DOM.SECTION_PLANNED) {
                deps.plan().pins[code] = toTerm;
            }

            this.render();
        },
        };
    }

    return { createMovesPart };
}));
