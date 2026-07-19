const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const customMaps = require('../static/js/custom-major-map.js');

// The startup sequence moved out of an inline <script> in index.html and
// into static/js/boot.js, because the site's CSP forbids inline scripts.
function bootSource() {
    return require('node:fs').readFileSync('static/js/boot.js', 'utf8');
}

test('custom major maps preserve semester order and detailed requirement types', () => {
    const map = customMaps.buildMajorMap({
        id: 'custom-map:test',
        name: 'My Engineering Plan',
        degree: 'Bachelor of Science',
        totalCredits: 120,
        semesters: [
            {
                label: 'Semester 1',
                entries: [
                    { type: 'course', code: 'MATH141', title: 'Calculus I', minCredits: 4, maxCredits: 4 },
                    { type: 'carolina_core', core: 'CMW', minCredits: 3, maxCredits: 3, allowedCourses: 'ENGL 101; ENGL101; ENGL 102', notes: 'Choose an approved course.' },
                ],
            },
            {
                label: 'Summer 1',
                entries: [
                    { type: 'elective', title: 'Technical elective', minCredits: 3, maxCredits: 6 },
                ],
            },
        ],
    });

    assert.equal(map.custom_map, true);
    assert.equal(map.major, 'My Engineering Plan');
    assert.deepEqual(map.total_credit_range, [10, 13]);
    assert.equal(map.total_credits_required, 120);
    assert.equal(map.required_courses[0].code, 'MATH 141');
    assert.equal(map.required_courses[0].credits, 4);
    assert.equal(map.elective_groups[0].category, 'carolina_core');
    assert.deepEqual(map.elective_groups[0].options, ['ENGL 101', 'ENGL 102']);
    assert.equal(map.elective_groups[1].label, 'Technical elective');
    assert.deepEqual(map.semester_plan[1].planned_credit_hours, [3, 6]);
    assert.equal(map.semester_plan[0].requirements[1].requirement_type, 'carolina_core');
});

test('custom maps distinguish restricted choices from unrestricted free-choice credits', () => {
    const map = customMaps.buildMajorMap({
        name: 'Flexible plan',
        totalCredits: 12,
        semesters: [{
            label: 'Semester 1',
            entries: [
                { type: 'elective', title: 'Choose one', allowedCourses: 'CSCE 145, MATH141; CSCE 145', minCredits: 4, maxCredits: 4 },
                { type: 'free_choice', title: '', minCredits: 8, maxCredits: 8 },
            ],
        }],
    });
    assert.deepEqual(map.elective_groups[0].options, ['CSCE 145', 'MATH 141']);
    assert.deepEqual(map.elective_groups[1].options, []);
    assert.equal(map.elective_groups[1].label, 'Free-choice credits');
    assert.deepEqual(customMaps.warningsForDraft(map._customDraft), []);
});

test('custom major map validation rejects malformed exact course codes', () => {
    const draft = customMaps.emptyDraft();
    draft.semesters = [{ label: 'Semester 1', entries: [{ type: 'course', code: 'calculus', minCredits: 3, maxCredits: 3 }] }];
    assert.match(customMaps.validateDraft(draft)[0], /course code such as MATH 141/);
    assert.equal(customMaps.validCourseCode('csce145'), 'CSCE 145');
});

test('credit-total mismatches warn without becoming validation errors', () => {
    const draft = customMaps.emptyDraft();
    draft.totalCredits = 120;
    draft.semesters = [{ label: 'Semester 1', entries: [{ type: 'free_choice', minCredits: 12, maxCredits: 15 }] }];
    assert.deepEqual(customMaps.validateDraft(draft), []);
    assert.match(customMaps.warningsForDraft(draft)[0], /does not cover the declared 120-credit degree total/);

    draft.semesters[0].entries[0].allowedCourses = 'not a course';
    draft.semesters[0].entries[0].type = 'elective';
    assert.match(customMaps.validateDraft(draft)[0], /allowed courses must use codes/);
});

test('degree wizard exposes the device-local custom major map builder', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const css = fs.readFileSync('static/css/style.css', 'utf8');
    assert.match(html, /id="btn-add-custom-major-map"/);
    assert.match(html, /static\/js\/custom-major-map\.js/);
    assert.match(html + bootSource(), /CustomMajorMap\.init\(\)/);
    assert.match(css, /custom-major-map-modal/);
});
