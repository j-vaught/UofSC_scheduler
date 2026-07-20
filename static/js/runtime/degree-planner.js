(function initDegreePlannerRuntime(root, factory) {
    let offering = root.OfferingAnalyzerRuntime;
    if (!offering && typeof require === 'function') offering = require('./offering-analyzer.js');
    const api = factory(offering);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DegreePlannerRuntime = api;
}(typeof globalThis === 'object' ? globalThis : self, offering => {
    'use strict';

    if (!offering) throw new Error('DegreePlannerRuntime requires OfferingAnalyzerRuntime');

    const MODE_CREDITS = Object.freeze({
        full_time: Object.freeze({ min: 14, max: 18, target: 15 }),
        scholarship: Object.freeze({ min: 12, max: 18, target: 15 }),
        part_time: Object.freeze({ min: 3, max: 9, target: 6 }),
    });
    const SCHOLARSHIP_ANNUAL_MIN = 30;

    function cleanRequirementLabel(value) {
        return String(value || '').replace(/(Elective|Core [A-Z-]+)\d+$/i, '$1').trim();
    }

    function ensureCategory(categories, name) {
        if (!categories[name]) categories[name] = { required: 0, completed: 0, remaining: 0 };
        return categories[name];
    }

    function computeRemaining(majorMap, completedCodes, concentration = 'general') {
        const completed = new Set(completedCodes || []);
        const required = majorMap?.required_courses || [];
        const electiveGroups = majorMap?.elective_groups || [];
        const totalRequired = majorMap?.total_credits_required ?? 120;
        const requiredRemaining = [];
        let completedCredits = 0;
        const categories = {};

        for (const course of required) {
            const code = course.code;
            const category = course.category || 'other';
            const credits = course.credits ?? 3;
            const totals = ensureCategory(categories, category);
            totals.required += credits;
            if (completed.has(code)) {
                completedCredits += credits;
                totals.completed += credits;
            } else {
                requiredRemaining.push(course);
                totals.remaining += credits;
            }
        }

        const concentrationData = majorMap?.concentrations?.[concentration] || {};
        for (const code of concentrationData.extra_required || []) {
            if (!completed.has(code) && !requiredRemaining.some(course => course.code === code)) {
                requiredRemaining.push({
                    code,
                    title: `${code} (Concentration)`,
                    credits: 3,
                    typical_year: 3,
                    typical_semester: 'Fall',
                    prerequisites: [],
                    corequisites: [],
                    category: 'major_electives',
                });
            }
        }

        const electiveGroupsRemaining = [];
        for (const group of electiveGroups) {
            const options = group.options || [];
            const totalPick = group.pick || 0;
            const pickCredits = group.pick_credits || 0;
            const creditsEach = group.credits_each ?? group.credits_required ?? 3;
            const completedInGroup = options.filter(code => completed.has(code));

            if (pickCredits > 0) {
                const earned = completedInGroup.length * creditsEach;
                const remainingCredits = Math.max(0, pickCredits - earned);
                if (remainingCredits > 0) {
                    electiveGroupsRemaining.push({
                        ...group,
                        completed_count: completedInGroup.length,
                        remaining_credits: remainingCredits,
                        remaining_pick: Math.max(1, Math.floor(remainingCredits / creditsEach)),
                    });
                }
            } else if (totalPick > 0) {
                const remainingPick = Math.max(0, totalPick - completedInGroup.length);
                if (remainingPick > 0) {
                    const remainingOptions = options.filter(code => !completed.has(code));
                    const remainingCredits = remainingPick * creditsEach;
                    electiveGroupsRemaining.push({
                        ...group,
                        completed_count: completedInGroup.length,
                        remaining_pick: remainingPick,
                        remaining_options: remainingOptions,
                        remaining_credits: remainingCredits,
                    });
                    ensureCategory(categories, group.category || 'electives').remaining += remainingCredits;
                }
            }
        }

        const remainingRequiredCredits = requiredRemaining
            .reduce((sum, course) => sum + (course.credits ?? 3), 0);
        const remainingElectiveCredits = electiveGroupsRemaining
            .reduce((sum, group) => sum + (group.remaining_credits || 0), 0);

        return {
            required_remaining: requiredRemaining,
            elective_groups_remaining: electiveGroupsRemaining,
            total_credits_remaining: Math.max(
                remainingRequiredCredits + remainingElectiveCredits,
                totalRequired - completedCredits,
            ),
            completed_credits: completedCredits,
            categories,
        };
    }

    function parseCourseCode(code) {
        const parsed = String(code || '').match(/^([A-Z]{2,8})\s+(\d{3})/i);
        if (!parsed) return null;
        return { subject: parsed[1].toUpperCase(), minNumber: Number(parsed[2]) };
    }

    function normalizeRequirementGroup(group) {
        if (!group || typeof group !== 'object') return null;
        const courses = [...new Set((group.courses || []).filter(Boolean).map(String))];
        const conditions = Array.isArray(group.conditions) ? group.conditions : [];
        if (!courses.length && !conditions.length) return null;
        /*
         * An "or higher" group carries the floor that defines it. Without both
         * halves it cannot be evaluated, and degrading it to 'or' is the safe
         * reading -- the listed courses were always acceptable answers, so this
         * only loses the widening, never invents an eligibility.
         */
        const subject = String(group.subject || '').toUpperCase();
        const minNumber = Number(group.minNumber);
        const isFloor = group.type === 'at-least' && subject && Number.isFinite(minNumber);
        if (isFloor) {
            return {
                courses,
                type: 'at-least',
                subject,
                minNumber,
                ...(conditions.length ? { conditions } : {}),
            };
        }
        return {
            courses,
            type: group.type === 'or' || group.type === 'at-least' ? 'or' : 'and',
            ...(conditions.length ? { conditions } : {}),
        };
    }

    function requirementGroupsForCourse(course) {
        // Catalog prose stays with the existing browser prerequisite parser.
        // This runtime consumes its normalized groups and treats legacy flat
        // arrays as a sequence of required courses for backward compatibility.
        if (Array.isArray(course?.prerequisite_groups)) {
            return course.prerequisite_groups.map(normalizeRequirementGroup).filter(Boolean);
        }
        return (course?.prerequisites || []).map(code => ({ courses: [String(code)], type: 'and' }));
    }

    function corequisiteGroupsForCourse(course) {
        const explicit = Array.isArray(course?.corequisite_groups)
            ? course.corequisite_groups.map(normalizeRequirementGroup).filter(Boolean)
            : (course?.corequisites || []).map(code => ({ courses: [String(code)], type: 'and' }));
        const either = Array.isArray(course?.prerequisite_or_corequisite_groups)
            ? course.prerequisite_or_corequisite_groups.map(normalizeRequirementGroup).filter(Boolean)
            : [];
        return [...explicit, ...either];
    }

    /*
     * Must answer identically to groupIsMet in
     * static/js/features/prereqs/index.js. The two evaluators are duplicated
     * because neither module can import the other;
     * tests/test_browser_runtime_parity.js is what stops them drifting.
     */
    function groupIsMet(group, completed) {
        if (group.type === 'at-least' && group.subject && Number.isFinite(group.minNumber)) {
            // A listed alternative may sit outside the floor's subject
            // ("ELCT 102 or AESP 265 or higher"), so check both.
            if (group.courses.some(code => completed.has(code))) return true;
            for (const code of completed) {
                const parsed = parseCourseCode(code);
                if (parsed && parsed.subject === group.subject
                    && parsed.minNumber >= group.minNumber) return true;
            }
            return false;
        }
        return group.type === 'or' || group.type === 'at-least'
            ? group.courses.some(code => completed.has(code))
            : group.courses.every(code => completed.has(code));
    }

    function evaluateRequirementGroups(groups, completedCodes) {
        const completed = completedCodes instanceof Set ? completedCodes : new Set(completedCodes || []);
        const unmet = (groups || []).filter(group => !groupIsMet(group, completed));
        const uncertain = unmet.filter(group => (group.conditions || []).length);
        const definite = unmet.filter(group => !(group.conditions || []).length);
        return {
            satisfied: unmet.length === 0,
            eligible: definite.length === 0,
            uncertain: uncertain.length > 0,
            missing: [...new Set(definite.flatMap(group => group.courses))],
        };
    }

    /*
     * The condition labels a course would be placed on but nothing has checked.
     * A group carrying conditions counts as uncertain rather than definite, so
     * the course stays eligible and gets planned -- correct, because refusing it
     * would strand a student who did place past the prerequisite. The student
     * still has to be told, which is what generateWarnings uses this for.
     */
    function unverifiedConditionLabels(groups, completed) {
        const labels = [];
        for (const group of groups || []) {
            if (groupIsMet(group, completed)) continue;
            for (const condition of group.conditions || []) {
                const label = String(condition?.label || '').trim();
                if (label && !labels.includes(label)) labels.push(label);
            }
        }
        return labels;
    }

    function buildPrerequisiteDag(courses, majorMap) {
        const lookup = {};
        for (const course of majorMap?.required_courses || []) {
            lookup[course.code] = new Set(course.prerequisites || []);
        }
        const courseCodes = new Set((courses || []).map(course => course.code));
        const adjacency = {};
        const inDegree = {};
        const prerequisites = {};
        const requirementGroups = {};
        const corequisiteGroups = {};

        for (const course of courses || []) {
            const allPrerequisites = lookup[course.code] || new Set();
            const relevant = [...allPrerequisites].filter(code => courseCodes.has(code));
            prerequisites[course.code] = relevant;
            requirementGroups[course.code] = requirementGroupsForCourse(
                (majorMap?.required_courses || []).find(item => item.code === course.code) || course,
            );
            corequisiteGroups[course.code] = corequisiteGroupsForCourse(
                (majorMap?.required_courses || []).find(item => item.code === course.code) || course,
            );
            inDegree[course.code] = relevant.length;
            for (const prerequisite of relevant) {
                if (!adjacency[prerequisite]) adjacency[prerequisite] = [];
                adjacency[prerequisite].push(course.code);
            }
        }
        return {
            adjacency,
            in_degree: inDegree,
            prereqs: prerequisites,
            requirement_groups: requirementGroups,
            corequisite_groups: corequisiteGroups,
        };
    }

    function requiredCorequisiteCodes(groups, satisfiedCodes, availableCodes) {
        const satisfied = satisfiedCodes instanceof Set ? satisfiedCodes : new Set(satisfiedCodes || []);
        const available = availableCodes instanceof Set ? availableCodes : new Set(availableCodes || []);
        const required = [];
        for (const group of groups || []) {
            if (groupIsMet(group, satisfied)) continue;
            if ((group.conditions || []).length) continue;
            // An "or higher" companion is still satisfied by any one listed
            // course, so it picks like an or-group rather than demanding all.
            if (group.type === 'or' || group.type === 'at-least') {
                const choice = (group.courses || []).find(code => available.has(code));
                if (!choice) return null;
                required.push(choice);
                continue;
            }
            for (const code of group.courses || []) {
                if (!available.has(code)) return null;
                required.push(code);
            }
        }
        return [...new Set(required)];
    }

    function topologicalSort(courses, adjacency, inDegree) {
        const courseMap = Object.fromEntries((courses || []).map(course => [course.code, course]));
        const degrees = { ...(inDegree || {}) };
        const queue = (courses || [])
            .filter(course => (degrees[course.code] || 0) === 0)
            .map(course => course.code);
        const sorted = [];

        while (queue.length) {
            queue.sort((left, right) => {
                const leftCourse = courseMap[left] || {};
                const rightCourse = courseMap[right] || {};
                return (leftCourse.typical_year ?? 5) - (rightCourse.typical_year ?? 5)
                    || (leftCourse.credits ?? 3) - (rightCourse.credits ?? 3);
            });
            const code = queue.shift();
            sorted.push(courseMap[code]);
            for (const dependent of adjacency?.[code] || []) {
                degrees[dependent] -= 1;
                if (degrees[dependent] === 0) queue.push(dependent);
            }
        }
        return sorted;
    }

    function semesterType(termCode) {
        const [, semester] = offering.termToParts(termCode);
        return offering.semesterTypeLabel(semester);
    }

    function canOfferInTerm(course, termCode, offeringHints) {
        const restriction = course.offering_restriction || offeringHints?.[course.code];
        const type = semesterType(termCode).toLowerCase();
        if (restriction === 'fall_only' && type !== 'fall') return false;
        if (restriction === 'spring_only' && type !== 'spring') return false;
        if (restriction === 'summer_only' && type !== 'summer') return false;
        /*
         * A course whose major-map section is itself a required summer block
         * (e.g. a summer internship) may not drift into the next Fall or
         * Spring -- that would be handing the student wrong advice about when
         * to take it. This is independent of offering_restriction, which
         * describes when the registrar runs the course; this describes when
         * the program's own sequence puts it.
         */
        if (course.requires_summer_section && type !== 'summer') return false;
        return true;
    }

    function distributeElectives(electiveGroups, semesters, creditLimits) {
        const result = {};
        for (const group of electiveGroups || []) {
            const remainingPick = group.remaining_pick || 0;
            const creditsEach = group.credits_each ?? 3;
            const label = group.label || 'Elective';
            const groupId = group.id || '';
            let slotsPlaced = 0;

            for (let index = 0; index < semesters.length && slotsPlaced < remainingPick; index += 1) {
                const additions = result[index] || [];
                const currentCredits = semesters[index].total_credits
                    + additions.reduce((sum, elective) => sum + (elective.credits ?? 3), 0);
                if (currentCredits + creditsEach <= creditLimits.max) {
                    if (!result[index]) result[index] = [];
                    result[index].push({
                        code: `[${label}]`,
                        title: label,
                        credits: creditsEach,
                        category: group.category || 'electives',
                        is_elective_slot: true,
                        elective_group_id: groupId,
                        options: group.remaining_options || group.options || [],
                        pinned: false,
                    });
                    slotsPlaced += 1;
                }
            }
        }
        return result;
    }

    /*
     * A major-map section beyond the standard eight ("Semester One" ..
     * "Semester Eight") is either a required summer block (import label
     * starts with "Summer", e.g. "Summer (6 Credit Hours)") or a
     * flexible-timing block ("Take during Semester Three or Four", "Winter
     * ..."). Only the first kind gets forced into an actual summer term; the
     * second kind carries no evidence of *which* semester, so it is planned
     * through the ordinary map_semester_index gate like any other course and
     * merely flagged for the student to confirm. Keyed on array index because
     * that -- not semester.number -- is what map_semester_index gates
     * against.
     */
    function classifyNonStandardSections(semesterPlan) {
        const summerIndexes = new Set();
        const flexibleLabels = new Map();
        (semesterPlan || []).forEach((semester, index) => {
            const number = Number(semester?.number);
            if (!Number.isFinite(number) || number <= 8) return;
            const label = String(semester?.label || '').trim();
            if (/^summer\b/i.test(label)) {
                summerIndexes.add(index);
            } else {
                flexibleLabels.set(index, label || 'Non-standard section');
            }
        });
        return { summerIndexes, flexibleLabels };
    }

    function generateWarnings(
        semesters,
        mode,
        annualCredits,
        unplaced,
        creditLimits,
        conditionalPlacements = [],
        nonStandardPlacements = [],
    ) {
        const warnings = [];
        if (unplaced.length) {
            const codes = unplaced.map(course => course.code);
            warnings.push({
                type: 'error',
                message: `Could not place ${unplaced.length} course(s): ${codes.join(', ')}. Check prerequisites and offering restrictions.`,
            });
        }
        /*
         * A warning, not an error: these courses are on the plan and the plan is
         * usable. What the student cannot see otherwise is that one of them
         * rests on a condition nobody has verified. Grouped by condition so the
         * sentence names the thing they have to go and do.
         */
        const codesByCondition = new Map();
        for (const placement of conditionalPlacements) {
            for (const label of placement.conditions || []) {
                if (!codesByCondition.has(label)) codesByCondition.set(label, []);
                const codes = codesByCondition.get(label);
                if (!codes.includes(placement.code)) codes.push(placement.code);
            }
        }
        for (const [label, codes] of codesByCondition) {
            const condition = label.toLowerCase();
            warnings.push({
                type: 'warning',
                message: `Placed assuming a ${condition}: ${codes.join(', ')}. You must pass the ${condition} (or provide transfer credit) before registering for these.`,
            });
        }
        /*
         * A flexible-timing section ("Take during Semester Three or Four")
         * carries no evidence of which semester, unlike a required summer
         * block. The planner still has to put the course somewhere, so it
         * uses the ordinary map_semester_index gate -- but the student needs
         * to know the placement is the planner's best guess, not the major
         * map's.
         */
        const codesByFlexibleLabel = new Map();
        for (const placement of nonStandardPlacements) {
            if (!codesByFlexibleLabel.has(placement.label)) codesByFlexibleLabel.set(placement.label, []);
            const codes = codesByFlexibleLabel.get(placement.label);
            if (!codes.includes(placement.code)) codes.push(placement.code);
        }
        for (const [label, codes] of codesByFlexibleLabel) {
            warnings.push({
                type: 'info',
                message: `The major map lists flexible timing ("${label}") rather than a specific semester for ${codes.join(', ')}. Confirm the exact term with your advisor.`,
            });
        }
        for (const semester of semesters) {
            if (semester.total_credits > creditLimits.max) {
                warnings.push({
                    type: 'warning',
                    message: `${semester.label}: ${semester.total_credits} credits exceeds the ${creditLimits.max} credit maximum.`,
                });
            }
        }
        for (const semester of semesters) {
            if (semester.total_credits < creditLimits.min) {
                warnings.push({
                    type: 'info',
                    message: `${semester.label}: Only ${semester.total_credits} credits planned. Consider adding electives to reach ${creditLimits.min} credits.`,
                });
            }
        }
        if (mode === 'scholarship') {
            for (const [yearValue, credits] of Object.entries(annualCredits)) {
                if (credits < SCHOLARSHIP_ANNUAL_MIN) {
                    const year = Number(yearValue);
                    const deficit = SCHOLARSHIP_ANNUAL_MIN - credits;
                    warnings.push({
                        type: 'warning',
                        message: `Academic year ${year}-${year + 1}: Only ${credits} credits planned. Need ${SCHOLARSHIP_ANNUAL_MIN} credits/year for most scholarships. Consider adding ${deficit} summer credits.`,
                    });
                }
            }
        }
        for (const semester of semesters) {
            const type = semesterType(semester.term).toLowerCase();
            for (const course of semester.courses) {
                if (course.offering_restriction === 'fall_only' && type !== 'fall') {
                    warnings.push({
                        type: 'error',
                        message: `${course.code} is Fall only but planned for ${semester.label}.`,
                    });
                } else if (course.offering_restriction === 'spring_only' && type !== 'spring') {
                    warnings.push({
                        type: 'error',
                        message: `${course.code} is Spring only but planned for ${semester.label}.`,
                    });
                } else if (course.offering_restriction === 'summer_only' && type !== 'summer') {
                    warnings.push({
                        type: 'error',
                        message: `${course.code} is Summer only but planned for ${semester.label}.`,
                    });
                }
            }
        }
        return warnings;
    }

    function planDegree(majorMap, completedCodes, options = {}) {
        const {
            mode = 'full_time',
            pins = {},
            start_term: startTerm = '202608',
            include_summer: includeSummer = false,
            custom_credits: customCredits = null,
            concentration = 'general',
            strategy = 'major_map',
            offering_history: offeringHistory = {},
        } = options;
        void offeringHistory;
        const completed = new Set(completedCodes || []);
        const offeringHints = majorMap?.offering_hints || {};
        const remaining = computeRemaining(majorMap, completed, concentration);
        const mapOrder = new Map();
        const mapSemester = new Map();
        const requirementSemesterQueues = new Map();
        (majorMap?.semester_plan || []).forEach((semester, semesterIndex) => {
            (semester.requirements || []).forEach((requirement, requirementIndex) => {
                (requirement.course_codes || []).forEach(code => {
                    if (!mapOrder.has(code)) mapOrder.set(code, (semesterIndex * 100) + requirementIndex);
                    if (!mapSemester.has(code)) mapSemester.set(code, semesterIndex);
                });
                const label = String(requirement.title || '').trim().toLowerCase();
                if (label) {
                    if (!requirementSemesterQueues.has(label)) requirementSemesterQueues.set(label, []);
                    requirementSemesterQueues.get(label).push(semesterIndex);
                }
            });
        });
        let remainingCourses = remaining.required_remaining.map(course => ({
            ...course,
            map_semester_index: mapSemester.get(course.code),
        }));
        for (const [groupIndex, group] of remaining.elective_groups_remaining.entries()) {
            const slotCount = Math.max(1, Number(group.remaining_pick) || 1);
            const totalCredits = Number(group.remaining_credits) || Number(group.credits_required) || 0;
            if (totalCredits <= 0) continue;
            const creditsEach = Number(group.credits_each) || (totalCredits / slotCount);
            const labelKey = String(group.label || '').trim().toLowerCase();
            const semesterQueue = requirementSemesterQueues.get(labelKey) || [];
            for (let index = 0; index < slotCount; index += 1) {
                remainingCourses.push({
                    code: `[REQ-${groupIndex + 1}-${index + 1}]`,
                    title: cleanRequirementLabel(group.label) || 'Degree requirement',
                    credits: creditsEach,
                    category: group.category || 'electives',
                    is_elective_slot: true,
                    elective_group_id: group.id || `requirement-${groupIndex + 1}`,
                    options: group.remaining_options || group.options || [],
                    prerequisites: [],
                    corequisites: [],
                    typical_year: 4,
                    map_semester_index: semesterQueue.shift(),
                });
            }
        }
        /*
         * Tag remaining courses (both required courses and the synthetic
         * elective-slot entries pushed above) that belong to a non-standard
         * major-map section, so the placement loop below can force a real
         * summer term for the summer kind and flag the flexible kind for the
         * student rather than silently guessing precision the source doesn't
         * have.
         */
        const { summerIndexes, flexibleLabels } = classifyNonStandardSections(majorMap?.semester_plan);
        for (const course of remainingCourses) {
            if (summerIndexes.has(course.map_semester_index)) {
                course.requires_summer_section = true;
            } else if (flexibleLabels.has(course.map_semester_index)) {
                course.flexible_section_label = flexibleLabels.get(course.map_semester_index);
            }
        }
        const dag = buildPrerequisiteDag(remainingCourses, majorMap);
        const creditLimits = mode === 'custom' && customCredits
            ? customCredits
            : (MODE_CREDITS[mode] || MODE_CREDITS.full_time);
        const semesters = [];
        const placed = new Set();
        const conditionalPlacements = [];
        const nonStandardPlacements = [];
        const annualCredits = {};
        let currentTerm = startTerm;
        let planningIterations = 0;

        while (remainingCourses.length && semesters.length < 20 && planningIterations < 60) {
            planningIterations += 1;
            const [year, semesterCode] = offering.termToParts(currentTerm);
            const type = semesterType(currentTerm);
            const summerType = type.toLowerCase() === 'summer';
            /*
             * A required summer section (a RETL-495-style internship) has to
             * pull a summer term into the schedule even when the student
             * never opted into includeSummer -- that flag governs optional
             * acceleration, not a program that structurally requires a
             * summer term. So the skip below only fires when nothing left
             * actually needs summer.
             */
            const summerRequiredNow = remainingCourses.some(course => course.requires_summer_section);
            if (summerType && !includeSummer && !summerRequiredNow) {
                currentTerm = offering.nextTerm(currentTerm, false);
                continue;
            }

            const completedOrPlaced = new Set([...completed, ...placed]);
            let available = remainingCourses.filter(course => {
                if (placed.has(course.code)) return false;
                if (strategy === 'major_map'
                    && Number.isInteger(course.map_semester_index)
                    && course.map_semester_index > semesters.length) return false;
                const groups = dag.requirement_groups[course.code] || [];
                if (!evaluateRequirementGroups(groups, completedOrPlaced).eligible) return false;
                return canOfferInTerm(course, currentTerm, offeringHints);
            });
            /*
             * This summer term is only open because a required section
             * forced it; the student did not ask for summer acceleration in
             * general, so nothing else should opportunistically fill it.
             */
            if (summerType && !includeSummer) {
                available = available.filter(course => course.requires_summer_section);
            }

            const semesterCourses = [];
            let semesterCredits = 0;
            for (const [code, pinTerm] of Object.entries(pins || {})) {
                if (pinTerm !== currentTerm) continue;
                const course = available.find(item => item.code === code);
                if (!course) continue;
                semesterCourses.push({ ...course, pinned: true });
                semesterCredits += course.credits ?? 3;
                available = available.filter(item => item.code !== code);
            }

            const categoryRank = course => ['major_core', 'major_electives'].includes(course.category) ? 0 : 1;
            available.sort((left, right) => {
                if (strategy === 'critical_path') {
                    return (dag.adjacency[right.code]?.length || 0) - (dag.adjacency[left.code]?.length || 0)
                        || (mapOrder.get(left.code) ?? 9999) - (mapOrder.get(right.code) ?? 9999);
                }
                if (strategy === 'major_first') {
                    return categoryRank(left) - categoryRank(right)
                        || (mapOrder.get(left.code) ?? 9999) - (mapOrder.get(right.code) ?? 9999);
                }
                if (strategy === 'balanced') {
                    return (right.credits ?? 3) - (left.credits ?? 3)
                        || categoryRank(left) - categoryRank(right)
                        || (mapOrder.get(left.code) ?? 9999) - (mapOrder.get(right.code) ?? 9999);
                }
                return (left.map_semester_index ?? 9999) - (right.map_semester_index ?? 9999)
                    || (mapOrder.get(left.code) ?? 9999) - (mapOrder.get(right.code) ?? 9999)
                    || (left.typical_year ?? 5) - (right.typical_year ?? 5);
            });
            for (const course of available) {
                if (semesterCourses.some(item => item.code === course.code)) continue;
                const availableCodes = new Set(available.map(item => item.code));
                const companionCodes = requiredCorequisiteCodes(
                    dag.corequisite_groups[course.code] || [],
                    new Set([...completedOrPlaced, ...semesterCourses.map(item => item.code)]),
                    availableCodes,
                );
                if (companionCodes === null) continue;
                const companions = companionCodes
                    .map(code => available.find(item => item.code === code))
                    .filter(Boolean)
                    .filter(item => !semesterCourses.some(placedCourse => placedCourse.code === item.code));
                const bundle = [course, ...companions];
                const credits = bundle.reduce((sum, item) => sum + (item.credits ?? 3), 0);
                if (semesterCredits + credits <= creditLimits.max) {
                    bundle.forEach(item => semesterCourses.push({ ...item, pinned: false }));
                    semesterCredits += credits;
                }
                if (strategy !== 'major_map' && semesterCredits >= creditLimits.target) break;
            }

            if (semesterCourses.length) {
                const placedCodes = new Set(semesterCourses.map(course => course.code));
                placedCodes.forEach(code => placed.add(code));
                /*
                 * Judged against completedOrPlaced, the same set the eligibility
                 * filter used above, so the warning reports the condition the
                 * placement actually rested on rather than a later state.
                 */
                for (const course of semesterCourses) {
                    const conditions = unverifiedConditionLabels([
                        ...(dag.requirement_groups[course.code] || []),
                        ...(dag.corequisite_groups[course.code] || []),
                    ], completedOrPlaced);
                    if (conditions.length) conditionalPlacements.push({ code: course.code, conditions });
                    if (course.flexible_section_label) {
                        nonStandardPlacements.push({ code: course.code, label: course.flexible_section_label });
                    }
                }
                semesters.push({
                    term: currentTerm,
                    label: offering.termLabel(currentTerm),
                    courses: semesterCourses.map(course => ({
                        code: course.code,
                        title: course.title || '',
                        credits: course.credits ?? 3,
                        category: course.category || '',
                        is_elective_slot: Boolean(course.is_elective_slot),
                        elective_group_id: course.elective_group_id || '',
                        options: course.options || [],
                        pinned: course.pinned || false,
                        offering_restriction: course.offering_restriction || offeringHints[course.code] || null,
                    })),
                    total_credits: semesterCredits,
                });
                const academicYear = semesterCode !== '01' ? year : year - 1;
                annualCredits[academicYear] = (annualCredits[academicYear] || 0) + semesterCredits;
                remainingCourses = remainingCourses.filter(course => !placedCodes.has(course.code));
            }
            /*
             * Recomputed against the post-placement remainder: once the
             * required summer course is placed it stops pulling summer terms
             * into the schedule, and normal (non-summer) advancement resumes.
             */
            const summerStillRequired = remainingCourses.some(course => course.requires_summer_section);
            currentTerm = offering.nextTerm(currentTerm, includeSummer || summerStillRequired);
        }

        return {
            semesters,
            warnings: generateWarnings(
                semesters,
                mode,
                annualCredits,
                remainingCourses,
                creditLimits,
                conditionalPlacements,
                nonStandardPlacements,
            ),
            total_credits_remaining: remaining.total_credits_remaining,
            completed_credits: remaining.completed_credits,
            estimated_graduation: semesters.length ? semesters.at(-1).label : 'Unknown',
            categories: remaining.categories,
        };
    }

    return Object.freeze({
        MODE_CREDITS,
        SCHOLARSHIP_ANNUAL_MIN,
        computeRemaining,
        requirementGroupsForCourse,
        corequisiteGroupsForCourse,
        evaluateRequirementGroups,
        requiredCorequisiteCodes,
        buildPrerequisiteDag,
        topologicalSort,
        classifyNonStandardSections,
        generateWarnings,
        planDegree,
    });
}));
