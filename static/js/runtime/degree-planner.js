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
            const creditsEach = group.credits_each ?? 3;
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

    function normalizeRequirementGroup(group) {
        if (!group || typeof group !== 'object') return null;
        const courses = [...new Set((group.courses || []).filter(Boolean).map(String))];
        const conditions = Array.isArray(group.conditions) ? group.conditions : [];
        if (!courses.length && !conditions.length) return null;
        return {
            courses,
            type: group.type === 'or' ? 'or' : 'and',
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

    function groupIsMet(group, completed) {
        return group.type === 'or'
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

        for (const course of courses || []) {
            const allPrerequisites = lookup[course.code] || new Set();
            const relevant = [...allPrerequisites].filter(code => courseCodes.has(code));
            prerequisites[course.code] = relevant;
            requirementGroups[course.code] = requirementGroupsForCourse(
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
        };
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
                        title: `Choose from ${groupId}`,
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

    function generateWarnings(semesters, mode, annualCredits, unplaced, creditLimits) {
        const warnings = [];
        if (unplaced.length) {
            const codes = unplaced.map(course => course.code);
            warnings.push({
                type: 'error',
                message: `Could not place ${unplaced.length} course(s): ${codes.join(', ')}. Check prerequisites and offering restrictions.`,
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
                }
            }
        }
        return warnings;
    }

    function planDegree(majorMap, completedCodes, options = {}) {
        // Corequisite pairing is not modeled yet. It needs normalized
        // corequisite groups plus atomic same-semester placement, not another
        // interpretation of catalog prose in this module.
        const {
            mode = 'full_time',
            pins = {},
            start_term: startTerm = '202608',
            include_summer: includeSummer = false,
            custom_credits: customCredits = null,
            concentration = 'general',
            offering_history: offeringHistory = {},
        } = options;
        void offeringHistory;
        const completed = new Set(completedCodes || []);
        const offeringHints = majorMap?.offering_hints || {};
        const remaining = computeRemaining(majorMap, completed, concentration);
        let remainingCourses = [...remaining.required_remaining];
        const dag = buildPrerequisiteDag(remainingCourses, majorMap);
        const creditLimits = mode === 'custom' && customCredits
            ? customCredits
            : (MODE_CREDITS[mode] || MODE_CREDITS.full_time);
        const semesters = [];
        const placed = new Set();
        const annualCredits = {};
        let currentTerm = startTerm;
        let planningIterations = 0;

        while (remainingCourses.length && semesters.length < 20 && planningIterations < 60) {
            planningIterations += 1;
            const [year, semesterCode] = offering.termToParts(currentTerm);
            const type = semesterType(currentTerm);
            if (type.toLowerCase() === 'summer' && !includeSummer) {
                currentTerm = offering.nextTerm(currentTerm, false);
                continue;
            }

            const completedOrPlaced = new Set([...completed, ...placed]);
            let available = remainingCourses.filter(course => {
                if (placed.has(course.code)) return false;
                const groups = dag.requirement_groups[course.code] || [];
                if (!evaluateRequirementGroups(groups, completedOrPlaced).eligible) return false;
                return canOfferInTerm(course, currentTerm, offeringHints);
            });

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

            available.sort((left, right) => (
                (left.typical_year ?? 5) - (right.typical_year ?? 5)
                || (dag.prereqs[right.code]?.length || 0) - (dag.prereqs[left.code]?.length || 0)
                || (right.credits ?? 3) - (left.credits ?? 3)
            ));
            for (const course of available) {
                const credits = course.credits ?? 3;
                if (semesterCredits + credits <= creditLimits.max) {
                    semesterCourses.push({ ...course, pinned: false });
                    semesterCredits += credits;
                }
                if (semesterCredits >= creditLimits.target) break;
            }

            if (semesterCourses.length) {
                const placedCodes = new Set(semesterCourses.map(course => course.code));
                placedCodes.forEach(code => placed.add(code));
                semesters.push({
                    term: currentTerm,
                    label: offering.termLabel(currentTerm),
                    courses: semesterCourses.map(course => ({
                        code: course.code,
                        title: course.title || '',
                        credits: course.credits ?? 3,
                        category: course.category || '',
                        pinned: course.pinned || false,
                        offering_restriction: course.offering_restriction || offeringHints[course.code] || null,
                    })),
                    total_credits: semesterCredits,
                });
                const academicYear = semesterCode !== '01' ? year : year - 1;
                annualCredits[academicYear] = (annualCredits[academicYear] || 0) + semesterCredits;
                remainingCourses = remainingCourses.filter(course => !placedCodes.has(course.code));
            }
            currentTerm = offering.nextTerm(currentTerm, includeSummer);
        }

        const electiveSemesters = distributeElectives(
            remaining.elective_groups_remaining,
            semesters,
            creditLimits,
        );
        for (const [indexValue, electives] of Object.entries(electiveSemesters)) {
            const index = Number(indexValue);
            if (index >= semesters.length) continue;
            semesters[index].courses.push(...electives);
            semesters[index].total_credits += electives
                .reduce((sum, elective) => sum + (elective.credits ?? 3), 0);
        }

        return {
            semesters,
            warnings: generateWarnings(
                semesters,
                mode,
                annualCredits,
                remainingCourses,
                creditLimits,
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
        evaluateRequirementGroups,
        buildPrerequisiteDag,
        topologicalSort,
        planDegree,
    });
}));
