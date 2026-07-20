/*
 * Grade qualifiers and "or higher" in bulletin prerequisite prose.
 *
 * Every phrasing asserted here was read from the live bulletin
 * (academicbulletins.sc.edu, srcdb 2026) rather than invented, because the
 * parser's failures are failures to match how the registrar actually writes.
 * The source course is named at each case so a future reader can re-check it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadObject } = require('./support/scheduler-harness.js');
const planner = require('../static/js/runtime/degree-planner.js');

function prereqs() {
    return loadObject('static/js/prereqs.js', 'Prereqs', {});
}

function plain(groups) {
    return JSON.parse(JSON.stringify(groups));
}

test('a repeated grade qualifier does not break an OR chain', () => {
    // ELCT 221, verbatim. ELCT 220 is a third alternative, not a fourth
    // requirement: reading the repeated "D or better" as a connector made it
    // mandatory, and since ELCT 220 is in no EE map the whole ELCT chain
    // cascaded out of the plan.
    const groups = prereqs().parsePrereqGroups(
        'Prerequisites: C or better in MATH 142; C or better in either ELCT 102 or AESP 265 or D or better in ELCT 220.',
    );
    assert.deepEqual(plain(groups), [
        { courses: ['MATH 142'], type: 'and' },
        { courses: ['ELCT 102', 'AESP 265', 'ELCT 220'], type: 'or' },
    ]);
});

test('a grade qualifier on each side of an "or" still yields one alternative group', () => {
    const groups = prereqs().parsePrereqGroups('C or better in ENGL 101 or D or better in ENGL 102.');
    assert.deepEqual(plain(groups), [{ courses: ['ENGL 101', 'ENGL 102'], type: 'or' }]);
});

test('juxtaposed requirements with no connector remain separate AND groups', () => {
    // The case the grade test was written for, and the reason it cannot simply
    // be deleted: nothing but the repeated grade separates these two.
    const groups = prereqs().parsePrereqGroups('D or better in ENCP 200 D or better in PHYS 211');
    assert.deepEqual(plain(groups), [
        { courses: ['ENCP 200'], type: 'and' },
        { courses: ['PHYS 211'], type: 'and' },
    ]);
});

test('a plain OR of two courses is unchanged', () => {
    // CSCE 146, verbatim. Regression guard: the connector fix must not reach
    // prose that never had a repeated qualifier in it.
    const groups = prereqs().parsePrereqGroups('C or better in CSCE 145 or CSCE 106.');
    assert.deepEqual(plain(groups), [{ courses: ['CSCE 145', 'CSCE 106'], type: 'or' }]);
});

test('an explicit "and" still wins over an "or" elsewhere in the same clause', () => {
    const groups = prereqs().parsePrereqGroups('D or better in EMCH 290 or ENCP 290 and AESP 265.');
    assert.deepEqual(plain(groups), [
        { courses: ['EMCH 290', 'ENCP 290'], type: 'or' },
        { courses: ['AESP 265'], type: 'and' },
    ]);
});

test('"or higher" becomes a course-number floor rather than being dropped', () => {
    const feature = prereqs();
    const groups = feature.parsePrereqGroups('C or better in MATH 111 or higher.');
    assert.deepEqual(plain(groups), [{
        courses: ['MATH 111'],
        type: 'at-least',
        subject: 'MATH',
        minNumber: 111,
    }]);

    // The point of the whole exercise: a student who placed past the named
    // course has met the requirement, and was previously told they had not.
    assert.equal(feature.groupIsMet(groups[0], new Set(['MATH 141'])), true);
    assert.equal(feature.groupIsMet(groups[0], new Set(['MATH 111'])), true);
    assert.equal(feature.groupIsMet(groups[0], new Set(['MATH 110'])), false);
    // No cross-subject equivalence is inferred; the phrasing does not claim it.
    assert.equal(feature.groupIsMet(groups[0], new Set(['ENGL 200'])), false);
    assert.equal(feature.groupIsMet(groups[0], new Set()), false);
});

test('"or above" and "higher-numbered" phrasings read as the same floor', () => {
    const feature = prereqs();
    for (const text of [
        'C or better in MATH 111 or above.',
        'C or better in MATH 111 or a higher-numbered course.',
        'C or better in MATH 111 or higher-numbered MATH course.',
    ]) {
        const [group] = feature.parsePrereqGroups(text);
        assert.equal(group.type, 'at-least', text);
        assert.equal(group.subject, 'MATH', text);
        assert.equal(group.minNumber, 111, text);
    }
});

test('an "or higher" floor spans the union of the alternatives it trails', () => {
    // CHEM 111, verbatim. The phrase sits on MATH 115, but MATH 111 is offered
    // as an alternative in the same breath, so the floor is 111.
    const [group] = prereqs().parsePrereqGroups(
        'Prerequisites: C or higher in MATH 111 or higher (or by placement score into MATH 115 or higher).',
    );
    assert.deepEqual(plain([group]), [{
        courses: ['MATH 111', 'MATH 115'],
        type: 'at-least',
        subject: 'MATH',
        minNumber: 111,
    }]);
});

test('an "or higher" mention that belongs to a later clause does not raise the floor', () => {
    // The floor is anchored to the code it follows. Without that, any stray
    // "or higher" later in the sentence would rewrite an unrelated group.
    const groups = prereqs().parsePrereqGroups('C or better in MATH 141, and a placement score of 60 or higher.');
    assert.equal(groups[0].type, 'and');
    assert.equal(groups[0].subject, undefined);
});

test('both evaluators read a course-number floor identically', () => {
    // groupIsMet is duplicated between the browser feature and the runtime.
    // This is the assertion that keeps the copies honest for the new type.
    const feature = prereqs();
    const group = { courses: ['MATH 111'], type: 'at-least', subject: 'MATH', minNumber: 111 };
    for (const completed of [['MATH 141'], ['MATH 111'], ['MATH 110'], ['ENGL 200'], []]) {
        assert.equal(
            feature.evaluateGroups([group], new Set(completed)).satisfied,
            planner.evaluateRequirementGroups([group], completed).satisfied,
            `disagreement on ${JSON.stringify(completed)}`,
        );
    }
});

test('a malformed floor degrades to an alternative rather than blocking outright', () => {
    // Losing the widening is acceptable; inventing an unsatisfiable group is not.
    const normalized = planner.requirementGroupsForCourse({
        prerequisite_groups: [{ courses: ['MATH 111'], type: 'at-least' }],
    });
    assert.deepEqual(normalized, [{ courses: ['MATH 111'], type: 'or' }]);
    assert.equal(planner.evaluateRequirementGroups(normalized, ['MATH 111']).satisfied, true);
});

test('a course placed on an unverified condition is planned and reported', () => {
    // Placing it is correct: refusing would strand a student who did place past
    // the prerequisite. Saying nothing about it is what was wrong.
    const map = {
        total_credits_required: 3,
        required_courses: [{
            code: 'MATH 141',
            title: 'Calculus I',
            credits: 3,
            prerequisite_groups: [{
                courses: ['MATH 112'],
                type: 'or',
                conditions: [{ label: 'Placement exam', kind: 'manual' }],
            }],
        }],
    };

    const plan = planner.planDegree(map, [], { start_term: '202608' });
    assert.deepEqual(plan.semesters[0].courses.map(course => course.code), ['MATH 141']);
    const warning = plan.warnings.find(item => /Placed assuming/.test(item.message));
    assert.equal(warning.type, 'warning', 'an unverified condition is a warning, not an error');
    assert.equal(
        warning.message,
        'Placed assuming a placement exam: MATH 141. You must pass the placement exam '
        + '(or provide transfer credit) before registering for these.',
    );
    assert.ok(!plan.warnings.some(item => item.type === 'error'));

    // A student who already has the course is not warned about it.
    const settled = planner.planDegree(map, ['MATH 112'], { start_term: '202608' });
    assert.ok(!settled.warnings.some(item => /Placed assuming/.test(item.message)));
});

test('the condition warning names each course once and groups by condition', () => {
    const conditioned = code => ({
        code,
        title: code,
        credits: 3,
        prerequisite_groups: [{
            courses: [`${code}X`],
            type: 'or',
            conditions: [{ label: 'Placement exam', kind: 'manual' }],
        }],
    });
    const map = {
        total_credits_required: 9,
        required_courses: [conditioned('MATH 141'), conditioned('CHEM 111'), {
            code: 'ENGL 101', title: 'Composition', credits: 3,
        }],
    };

    const plan = planner.planDegree(map, [], { start_term: '202608' });
    const messages = plan.warnings.filter(item => /Placed assuming/.test(item.message));
    assert.equal(messages.length, 1, 'one condition yields one warning, not one per course');
    assert.equal(
        messages[0].message,
        'Placed assuming a placement exam: MATH 141, CHEM 111. You must pass the placement exam '
        + '(or provide transfer credit) before registering for these.',
    );
});
