/*
 * Behaviour and source contracts for grade history and professor
 * profiles (static/js/grades.js and its fenced feature under features/grades).
 * Split out of test_scheduler_frontend.js by module-under-test.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    loadObject, moduleSource, gradesSource, bootSource,
    stylesheet,
} = require('./support/scheduler-harness.js');

test('Course and professor close controls remain available while scrolling', () => {
    const source = gradesSource();
    const styles = stylesheet();

    assert.match(styles, /\.course-detail-header-sticky\s*{[^}]*position:\s*sticky;/s);
    assert.match(styles, /\.course-detail-header-sticky \.browse-close-details\s*{[^}]*position:\s*absolute;/s);
    assert.match(styles, /\.browse-close-details:hover,[\s\S]*background:\s*#FFFFFF;[\s\S]*color:\s*#73000A;/);
    assert.match(styles, /#modal\.professor-profile-modal #modal-close\s*{[^}]*height:\s*44px;[^}]*position:\s*sticky;/s);
    assert.match(source, /openProfessorLoading\(name/);
    assert.match(source, /professorDetailContextIsCurrent/);
});

test('Professor names use the first comma as the sole first and last name delimiter', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});

    assert.equal(grades.displayProfessorName('KANAPALA, NEEMA'), 'NEEMA KANAPALA');
    assert.equal(grades.displayProfessorName('DE LA CRUZ, MARIA JOSE'), 'MARIA JOSE DE LA CRUZ');
    assert.equal(grades.displayProfessorName('Mary Ann Smith'), 'Mary Ann Smith');
});

test('surname-only live instructor labels resolve one unique historical professor', async () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {
        Search: {
            _detailToken: 7,
            _detailGroup: { code: 'CSCE 145' },
            _browseState: 'detail',
        },
        window: { AppModal: { version: 3 } },
    });
    let selected = null;
    let unmatched = null;
    grades.openProfessorLoading = () => {};
    grades.courseData = async () => ({
        instructors: [
            { id: 'prof_kanapala', name: 'Kanapala, Neema', average_gpa: 3.04 },
            { id: 'prof_hoskins', name: 'Hoskins, William', average_gpa: 3.35 },
        ],
    });
    grades.showProfessor = (id, context) => { selected = { id, context }; };
    grades.showUnmatchedProfessor = (name, email) => { unmatched = { name, email }; };

    await grades.showProfessorForCourseName('CSCE 145', 'Kanapala', 'neema@cse.sc.edu');

    assert.equal(unmatched, null);
    assert.equal(selected.id, 'prof_kanapala');
    assert.equal(selected.context.displayName, 'Kanapala');
    assert.equal(selected.context.email, 'neema@cse.sc.edu');
    assert.equal(selected.context.currentCourse, 'CSCE 145');
});

test('surname-only professor matching refuses ambiguous historical records', async () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {
        Search: {
            _detailToken: 8,
            _detailGroup: { code: 'TEST 101' },
            _browseState: 'detail',
        },
        window: { AppModal: { version: 4 } },
    });
    let selected = null;
    let unmatched = null;
    grades.openProfessorLoading = () => {};
    grades.courseData = async () => ({
        instructors: [
            { id: 'prof_alex', name: 'Smith, Alex', average_gpa: 3.2 },
            { id: 'prof_jordan', name: 'Smith, Jordan', average_gpa: 3.8 },
        ],
    });
    grades.showProfessor = (id, context) => { selected = { id, context }; };
    grades.showUnmatchedProfessor = (name, email) => { unmatched = { name, email }; };

    await grades.showProfessorForCourseName('TEST 101', 'Smith', '');

    assert.equal(selected, null);
    assert.deepEqual(unmatched, { name: 'Smith', email: '' });
});

test('surname fallback matches token boundaries instead of substrings', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});
    const records = [
        { id: 'prof_hu', name: 'Hu, Ming' },
        { id: 'prof_huang', name: 'Huang, Lin' },
        { id: 'prof_li', name: 'Li, Wei' },
        { id: 'prof_franklin', name: 'Franklin, Tara' },
    ];

    assert.deepEqual(Array.from(grades.matchingProfessorRecords(records, 'Hu'), record => record.id), ['prof_hu']);
    assert.deepEqual(Array.from(grades.matchingProfessorRecords(records, 'Li'), record => record.id), ['prof_li']);
});

test('section professor lookup keeps a supplied stable ID ahead of same-name fallbacks', async () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {
        Search: {
            _detailToken: 9,
            _detailGroup: { code: 'TEST 101' },
            _browseState: 'detail',
        },
        window: { AppModal: { version: 5 } },
    });
    let selected = null;
    let courseDataCalls = 0;
    grades.openProfessorLoading = () => {};
    grades.courseData = async () => {
        courseDataCalls += 1;
        return { instructors: [{ id: 'prof_old', name: 'Smith, Alex' }] };
    };
    grades.showProfessor = id => { selected = id; };
    grades.showUnmatchedProfessor = () => { throw new Error('stable ID should be used'); };

    await grades.showProfessorForCourseName(
        'TEST 101',
        'Smith, Alex',
        'alex@example.edu',
        'prof_current',
    );

    assert.equal(selected, 'prof_current');
    assert.equal(courseDataCalls, 0);
});

test('Professor profiles use alphabetical GPA rows and a full-year connected timeline', () => {
    const source = gradesSource();
    const styles = fs.readFileSync('static/css/grades.css', 'utf8');
    const html = fs.readFileSync('static/index.html', 'utf8');

    assert.match(source, /localeCompare\(String\(right\.code \|\| ''\), undefined, \{ numeric: true \}\)/);
    assert.match(source, /class="professor-course-gpa-dot/);
    assert.doesNotMatch(source, /<i><b style="width:\$\{width\}%"><\/b><\/i>/);
    assert.match(source, /class="professor-primary-gpa"/);
    assert.match(source, /class="professor-year-line"/);
    assert.match(source, /preserveAspectRatio="none"/);
    assert.match(source, /vector-effect="non-scaling-stroke"/);
    assert.doesNotMatch(source, /professor-year-segment/);
    assert.match(source, /\$\{point\.year\}: \$\{this\.formatGpa\(point\.gpa\)\} GPA/);
    assert.match(source, /\(point\.year - firstYear\) \* 90 \/ yearSpan/);
    assert.match(source, /Teaching span in available records/);
    assert.match(source, /currentFacultyForCourse\(code\)/);
    assert.match(source, /return `\$\{term\}:\$\{code\}:\$\{crns\.join\(','\)\}`/);
    // A faculty lookup started before the professor/section changed must be
    // discarded. That courseFacultyKey actually changes when the professor
    // changes is executed in test_feature_grades.js; here we pin only the
    // semantic core in loadForCourse -- a key captured up front, then compared
    // and short-circuited when it no longer matches -- tolerating the local's
    // name and the surrounding conditions.
    assert.match(source, /const \w+ = this\.courseFacultyKey\(code\)/, 'the faculty key must be captured before the async lookup');
    assert.match(source, /courseFacultyKey\(code\) !== \w+\)[\s\S]{0,20}return;/, 'a late faculty lookup must be discarded once the key changes');
    assert.match(moduleSource('search'), /(?:deps\.grades|Grades)\.refreshCourseFaculty\(group\.code\)/);
    assert.match(styles, /\.professor-year-line\s*{[^}]*stroke:\s*#73000A;[^}]*stroke-linecap:\s*butt;[^}]*stroke-linejoin:\s*miter;/s);
    assert.doesNotMatch(styles, /\.professor-year-segment/);
    assert.match(styles, /\.professor-year-plot\s*{[^}]*height:\s*clamp\(160px, 24vw, 210px\);/s);
    assert.match(styles, /\.professor-year-labels\s*{[^}]*border-left:\s*2px solid transparent;/s);
    assert.match(styles, /\.professor-year-point\s*{[^}]*border-radius:\s*50% !important;/s);
    assert.match(source, /class="professor-year-point" role="img" tabindex="0"/);
    assert.doesNotMatch(source, /<button[^>]*class="professor-year-point"/);
    assert.match(styles, /\.professor-year-point:focus\s*{/);
    assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.professor-year-label:not\(\.compact-visible\)/);
    assert.match(html + bootSource(), /update\(markup, options = \{\}\)/);
    assert.match(source, /AppModal\.update\(markup/);
    assert.match(source, /const professorId = instructor\?\.professorId \|\| instructor\?\.grade\?\.id/);
    assert.match(source, /!this\.professorDetailContextIsCurrent\(detailToken, detailCode\)\) return;/);
    // The fetch is a seam now; what this pins is the ordering after it -- a
    // missing record must fall through to the unmatched-professor view rather
    // than leaving the modal on its loading state.
    assert.match(source, /data = await deps\.getProfessorGrades\(professorId\)[\s\S]*if \(!data\)[\s\S]*this\.showUnmatchedProfessor\(context\.displayName \|\| 'Instructor', context\.email \|\| ''\)/);
});

test('Professor GPA timeline uses calendar-year spacing and an aligned zero-to-four scale', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});
    const markup = grades.professorYearMarkup([
        { academic_year: 2018, average_gpa: 4 },
        { academic_year: 2020, average_gpa: 3 },
        { academic_year: 2024, average_gpa: 2 },
    ]);

    assert.match(markup, /left:5%;top:6%/);
    assert.match(markup, /left:35%;top:28%/);
    assert.match(markup, /left:95%;top:50%/);
    assert.match(markup, /class="professor-year-line" points="5,6 35,28 95,50"/);
    assert.doesNotMatch(markup, /professor-year-segment|stroke-dasharray/);
    assert.match(markup, /top:6%">4\.0/);
    assert.match(markup, /top:94%">0\.0/);
    assert.match(markup, /class="professor-year-gridline" x1="0" y1="28" x2="100" y2="28"/);
    assert.equal((markup.match(/class="professor-year-point"/g) || []).length, 3);
    assert.doesNotMatch(markup, /grid-template-columns/);
});

test('Professor GPA timeline plots values below one instead of pinning them to one', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});
    const markup = grades.professorYearMarkup([
        { academic_year: 2021, average_gpa: 0.625 },
    ]);

    assert.match(markup, /left:50%;top:80\.25%/);
    assert.match(markup, /2021, 0\.63 GPA/);
    assert.doesNotMatch(markup, /class="professor-year-line"/);
});

test('Professor profile review links use the UofSC Rate My Professors school search', () => {
    const grades = loadObject('static/js/grades.js', 'Grades', {});

    assert.equal(
        grades.rateMyProfessorsUrl('Hu, Ming'),
        'https://www.ratemyprofessors.com/search/professors/1309?q=Ming+Hu',
    );
    const markup = grades.professorMarkup({ name: 'Hu, Ming', courses: [], years: [] });
    assert.match(markup, /href="https:\/\/www\.ratemyprofessors\.com\/search\/professors\/1309\?q=Ming\+Hu"/);
});
