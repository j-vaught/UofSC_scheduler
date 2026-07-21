'use strict';

/*
 * Non-standard major-map sections: required summer blocks and flexible-timing
 * blocks.
 *
 * Registrar major-map PDFs sometimes carry a section that is not one of the
 * eight numbered semesters -- most often a required summer block ("Summer (6
 * Credit Hours)", e.g. Retailing's RETL 495 internship) and occasionally a
 * flexible-timing block ("Take during Semester Three or Four"). The importer
 * gives each its own semester_plan entry: number = 8 + N so it never collides
 * with 1-8, and label = the header text verbatim. Before this file, planDegree
 * had no idea these existed -- courses tied to them just got an
 * map_semester_index like any other course, and since include_summer defaults
 * to false, planDegree's summer-skipping logic (see the loop in planDegree)
 * never visits a summer term at all, so a required summer course could only
 * ever land in whatever ordinary Fall/Spring term its gate happened to open
 * in. For a 6-credit summer internship, that is not "the planner made a
 * timing simplification" -- it is telling the student to take an internship
 * during a semester they're also carrying a full course load, or (as
 * originally reported) letting the credits silently inflate whatever semester
 * was still open when the section boundary went unrecognized.
 *
 * None of the 185 real 2026-2027 maps under data/curated currently contain a
 * non-standard section (the importer fix landed before the curated data was
 * regenerated), so every fixture here is hand-built. The last test in this
 * file instead proves the negative on real data: every one of those 185 maps
 * plans identically to how it always has, because classifyNonStandardSections
 * finds nothing to tag.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const planner = require('../static/js/runtime/degree-planner.js');

const ROOT = path.resolve(__dirname, '..');

function section(number, label, courseCodes, title) {
    return {
        number,
        label,
        planned_credit_hours: 3,
        requirements: [{ course_codes: courseCodes, title }],
    };
}

function retailingStyleMap() {
    // Six ordinary standard semesters, a required summer section sitting
    // between "Semester Six" and "Semester Seven" in document order (as
    // RETL's internship does -- after the junior year, before the senior
    // year), then the remaining two standard semesters. FREE 400 has no
    // semester_plan entry of its own (an ordinary unassigned elective, the
    // kind that already floats to wherever there is room) so it can prove the
    // forced summer term does not become a dumping ground for it.
    return {
        total_credits_required: 33,
        required_courses: [
            { code: 'ENGL 101', title: 'Comp I', credits: 3, category: 'core', prerequisites: [] },
            { code: 'MATH 111', title: 'Calc', credits: 3, category: 'core', prerequisites: [] },
            { code: 'CSCE 101', title: 'Intro CS', credits: 3, category: 'core', prerequisites: [] },
            { code: 'HIST 101', title: 'History', credits: 3, category: 'core', prerequisites: [] },
            { code: 'PSYC 101', title: 'Psych', credits: 3, category: 'core', prerequisites: [] },
            { code: 'SOCI 101', title: 'Soc', credits: 3, category: 'core', prerequisites: ['MATH 111'] },
            { code: 'RETL 495', title: 'Retailing Internship', credits: 6, category: 'major_core', prerequisites: [] },
            { code: 'FREE 400', title: 'Free Elective', credits: 3, category: 'electives', prerequisites: ['SOCI 101'] },
            { code: 'MKTG 301', title: 'Marketing', credits: 3, category: 'major_core', prerequisites: [] },
            { code: 'MGMT 301', title: 'Management', credits: 3, category: 'major_core', prerequisites: [] },
        ],
        elective_groups: [],
        semester_plan: [
            section(1, 'Semester One', ['ENGL 101'], 'Req1'),
            section(2, 'Semester Two', ['MATH 111'], 'Req2'),
            section(3, 'Semester Three', ['CSCE 101'], 'Req3'),
            section(4, 'Semester Four', ['HIST 101'], 'Req4'),
            section(5, 'Semester Five', ['PSYC 101'], 'Req5'),
            section(6, 'Semester Six', ['SOCI 101'], 'Req6'),
            section(9, 'Summer (6 Credit Hours)', ['RETL 495'], 'Internship'),
            section(7, 'Semester Seven', ['MKTG 301'], 'Req7'),
            section(8, 'Semester Eight', ['MGMT 301'], 'Req8'),
        ],
    };
}

test('a required summer section places its course into an actual summer term', () => {
    const map = retailingStyleMap();
    // include_summer is omitted -- the default is false. The point of a
    // required summer section is that it does not need the student to opt in.
    const plan = planner.planDegree(map, [], { start_term: '202608' });

    const retailing = plan.semesters.find(semester => semester.courses.some(course => course.code === 'RETL 495'));
    assert.ok(retailing, 'RETL 495 must be placed somewhere');
    assert.match(retailing.label, /^Summer /, `RETL 495 landed in "${retailing.label}", not a summer term`);
    assert.match(retailing.term, /05$/, 'the term code itself must carry the summer semester code');

    // Nothing else rides along just because the forced term is open: the
    // student never asked for general summer acceleration, so an ordinary
    // unassigned elective (FREE 400, eligible from the moment SOCI 101 is
    // done) must wait for the next real Fall/Spring rather than opportunistically
    // filling the summer term.
    assert.deepEqual(retailing.courses.map(course => course.code), ['RETL 495']);
    const free400Semester = plan.semesters.find(semester => semester.courses.some(course => course.code === 'FREE 400'));
    assert.ok(free400Semester);
    assert.doesNotMatch(free400Semester.label, /^Summer /, 'FREE 400 has no reason to be in summer');

    // Every other course is still placed -- the forced summer term is an
    // addition to the schedule, not a disruption of it.
    const allCodes = plan.semesters.flatMap(semester => semester.courses.map(course => course.code)).sort();
    assert.deepEqual(allCodes, [
        'CSCE 101', 'ENGL 101', 'FREE 400', 'HIST 101', 'MATH 111',
        'MGMT 301', 'MKTG 301', 'PSYC 101', 'RETL 495', 'SOCI 101',
    ].sort());
    assert.ok(!plan.warnings.some(warning => warning.type === 'error'), JSON.stringify(plan.warnings));
});

test('include_summer: false does not suppress a required summer section', () => {
    // Same map, explicit false this time -- the flag some callers pass
    // deliberately rather than by omission, since it's the value most UI
    // entry points send. A required summer section is a property of the
    // program, not of whether the student opted into acceleration, so this
    // must plan identically to the default-omitted case above.
    const map = retailingStyleMap();
    const explicit = planner.planDegree(map, [], { start_term: '202608', include_summer: false });
    const omitted = planner.planDegree(map, [], { start_term: '202608' });
    assert.deepEqual(explicit, omitted);

    const retailing = explicit.semesters.find(semester => semester.courses.some(course => course.code === 'RETL 495'));
    assert.match(retailing.label, /^Summer /);
});

test('include_summer: true still places the required summer course correctly', () => {
    // Opting into general acceleration must not break the forced-summer path;
    // it should simply mean other courses are also free to use summer terms.
    const map = retailingStyleMap();
    const plan = planner.planDegree(map, [], { start_term: '202608', include_summer: true });
    const retailing = plan.semesters.find(semester => semester.courses.some(course => course.code === 'RETL 495'));
    assert.ok(retailing);
    assert.match(retailing.label, /^Summer /);
});

test('a flexible-timing section is not treated as summer', () => {
    // "Take during Semester Three or Four" (RETL's own catalog also has this
    // shape elsewhere in the corpus) names a window, not a season. Reading it
    // as a summer requirement would invent precision -- and a wrong kind of
    // precision, since it would also force an actual summer term into a
    // schedule for a student who never needed one.
    const map = {
        total_credits_required: 15,
        required_courses: [
            { code: 'ENGL 101', title: 'Comp I', credits: 3, category: 'core', prerequisites: [] },
            { code: 'MATH 111', title: 'Calc', credits: 3, category: 'core', prerequisites: [] },
            { code: 'CHEM 333', title: 'Flexible Course', credits: 3, category: 'major_core', prerequisites: [] },
            { code: 'CSCE 101', title: 'Intro CS', credits: 3, category: 'core', prerequisites: [] },
            { code: 'HIST 101', title: 'History', credits: 3, category: 'core', prerequisites: [] },
        ],
        elective_groups: [],
        semester_plan: [
            section(1, 'Semester One', ['ENGL 101'], 'Req1'),
            section(2, 'Semester Two', ['MATH 111'], 'Req2'),
            section(9, 'Take during Semester Three or Four (0-2 Hours)', ['CHEM 333'], 'Flex'),
            section(3, 'Semester Three', ['CSCE 101'], 'Req3'),
            section(4, 'Semester Four', ['HIST 101'], 'Req4'),
        ],
    };
    const plan = planner.planDegree(map, [], { start_term: '202608' });

    // No summer term exists anywhere in this plan: include_summer was never
    // set, and nothing in this map should force one.
    assert.ok(!plan.semesters.some(semester => /^Summer /.test(semester.label)),
        `a flexible-timing section must never manufacture a summer term: ${JSON.stringify(plan.semesters.map(s => s.label))}`);

    const flexible = plan.semesters.find(semester => semester.courses.some(course => course.code === 'CHEM 333'));
    assert.ok(flexible);

    // The student is told the timing is the planner's best guess, not the
    // major map's -- the whole reason not to invent precision is that the
    // student still needs to go verify it.
    const notice = plan.warnings.find(warning => warning.message.includes('CHEM 333'));
    assert.ok(notice, JSON.stringify(plan.warnings));
    assert.equal(notice.type, 'info');
    assert.equal(
        notice.message,
        'The major map lists flexible timing ("Take during Semester Three or Four (0-2 Hours)") '
        + 'rather than a specific semester for CHEM 333. Confirm the exact term with your advisor.',
    );
});

test('classifyNonStandardSections separates required-summer from flexible-timing and ignores the standard eight', () => {
    const semesterPlan = [
        section(1, 'Semester One', ['ENGL 101'], 'Req1'),
        section(8, 'Semester Eight', ['MGMT 301'], 'Req8'),
        section(9, 'Summer (6 Credit Hours)', ['RETL 495'], 'Internship'),
        section(10, 'Summer After Junior Year (6 Credit Hours)', ['RETL 496'], 'Internship 2'),
        section(11, 'Take during Semester Three or Four (0-2 Hours)', ['CHEM 333'], 'Flex'),
        section(12, 'Winter Session (3 Credit Hours)', ['WINT 101'], 'Winter'),
    ];
    const { summerIndexes, flexibleLabels } = planner.classifyNonStandardSections(semesterPlan);

    // Indexes, not semester.number, because that is what map_semester_index
    // gates against -- array position 0 and 1 are the two standard sections
    // above, so a correct implementation must never tag them.
    assert.deepEqual([...summerIndexes].sort(), [2, 3]);
    assert.deepEqual(
        [...flexibleLabels.entries()].sort((a, b) => a[0] - b[0]),
        [
            [4, 'Take during Semester Three or Four (0-2 Hours)'],
            [5, 'Winter Session (3 Credit Hours)'],
        ],
    );
});

test('the offering-restriction warning pattern covers summer-only courses, not just fall/spring', () => {
    // canOfferInTerm already refuses to place a summer_only course outside
    // summer (that branch predates this change), which is exactly why this
    // warning -- like its pre-existing fall_only/spring_only siblings -- can
    // never actually fire through planDegree's own placement loop: nothing
    // mismatched ever makes it into `semesters`. It exists as the same kind
    // of defense-in-depth the Fall/Spring branches already were, so it is
    // exercised directly against generateWarnings rather than by trying to
    // manufacture an unreachable state through planDegree.
    const semesters = [{
        term: '202708',
        label: 'Fall 2027',
        total_credits: 6,
        courses: [
            { code: 'RETL 495', offering_restriction: 'summer_only' },
            { code: 'ENGL 101', offering_restriction: null },
        ],
    }];
    const warnings = planner.generateWarnings(
        semesters, 'full_time', {}, [], planner.MODE_CREDITS.full_time,
    );
    assert.ok(warnings.some(warning => (
        warning.type === 'error' && warning.message === 'RETL 495 is Summer only but planned for Fall 2027.'
    )), JSON.stringify(warnings));
    assert.ok(!warnings.some(warning => warning.message.includes('ENGL 101')));
});

test('a major map with no non-standard section plans exactly as it always has', () => {
    // The single most important property: 26 of 185 real maps gain a
    // non-standard section once the importer is re-run, and 159 must not
    // notice anything changed. This fixture has no section past "Semester
    // Two", so classifyNonStandardSections tags nothing, requires_summer_section
    // and flexible_section_label are never set on any course, and every
    // branch this change added becomes a no-op by construction.
    const map = {
        total_credits_required: 6,
        required_courses: [
            { code: 'ENGL 101', title: 'Comp I', credits: 3, category: 'core', prerequisites: [] },
            { code: 'MATH 111', title: 'Calc', credits: 3, category: 'core', prerequisites: [] },
        ],
        elective_groups: [],
        semester_plan: [
            section(1, 'Semester One', ['ENGL 101'], 'Req1'),
            section(2, 'Semester Two', ['MATH 111'], 'Req2'),
        ],
    };
    const plan = planner.planDegree(map, [], { start_term: '202608' });
    assert.deepEqual(plan.semesters.map(semester => ({ label: semester.label, codes: semester.courses.map(c => c.code) })), [
        { label: 'Fall 2026', codes: ['ENGL 101'] },
        { label: 'Spring 2027', codes: ['MATH 111'] },
    ]);
    assert.ok(!plan.semesters.some(semester => /^Summer /.test(semester.label)));
    assert.ok(!plan.warnings.some(warning => warning.message.includes('flexible timing')));
});

test('across every real 2026-2027 map, summer appears exactly where the map asks for it', () => {
    /*
     * Run the whole curated corpus through the planner and check both halves of
     * the contract at once: a map with a summer section gets a summer term even
     * though include_summer defaults to false, and a map without one plans
     * exactly as it always did.
     *
     * This test previously asserted that NO map has a summer section, which was
     * true the day it was written -- the importer had been fixed but the curated
     * data had not been regenerated yet. Encoding "the data has not caught up
     * yet" as an invariant meant the test failed the moment the data did catch
     * up, reporting the intended outcome as a regression. What is durable is the
     * relationship between a map and its plan, not the corpus's contents on a
     * particular afternoon.
     */
    const mapsDir = path.join(ROOT, 'data/curated/major_maps/2026-2027');
    const files = fs.readdirSync(mapsDir).filter(file => file.endsWith('.json'));
    assert.ok(files.length > 100, 'sanity check that the curated corpus is actually present');

    let withSummer = 0;
    let withoutSummer = 0;

    for (const file of files) {
        const map = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8'));
        const { summerIndexes } = planner.classifyNonStandardSections(map.semester_plan);
        const plan = planner.planDegree(map, [], { start_term: '202608' });
        const plannedSummer = plan.semesters.some(semester => /^Summer /.test(semester.label));

        if (summerIndexes.size > 0) {
            withSummer += 1;
            assert.ok(
                plannedSummer,
                `${file} declares a summer section but the plan never enters a summer term`,
            );
        } else {
            withoutSummer += 1;
            assert.ok(
                !plannedSummer,
                `${file} has no summer section yet planned into summer with include_summer false`,
            );
        }
    }

    // Neither branch may be empty, or this passes without having tested anything.
    // Both populations exist in the corpus today; if one disappears, that is a
    // data change worth failing over rather than quietly reducing coverage.
    assert.ok(withSummer > 0, 'no map exercised the summer path; this test proved nothing');
    assert.ok(withoutSummer > 0, 'no map exercised the unaffected path');
});
