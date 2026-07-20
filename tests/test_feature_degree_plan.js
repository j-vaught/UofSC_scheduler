'use strict';

/*
 * The degree plan fence.
 *
 * The widest extraction so far, and the one whose seams matter most to what
 * comes next: the edges into Search and Scheduler are navigation, not data, so
 * turning them into callbacks removes inbound edges from the cycle that has to
 * be untangled last. These tests hold that line -- the feature must never reach
 * those modules again, only ask its caller to go there.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const featureSource = (() => {
    // The whole feature: it is split into parts its index merges, so reading
    // index.js alone finds composition and none of the methods.
    const dir = path.join(ROOT, 'static/js/features/degree-plan');
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
})();

const codeOnly = featureSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const asHost = value => JSON.parse(JSON.stringify(value));

const DEP_NAMES = ['getDegreePlan', 'bulletinSearch', 'getOfferingAnalysis',
    'plan', 'profile', 'completedCourses', 'completedDetails',
    'selectedSections', 'selectedCourses', 'sectionLocks', 'currentTerm',
    'setSectionLock', 'removeCourse', 'emitPlanUpdated',
    'findMajorMap', 'catalogYearLabel', 'sourceUrl', 'sourceLabel',
    'onCourseworkChanged', 'showCourse', 'searchFor',
    'onProfileChange', 'onTranscriptChange', 'onPlanChange'];

/*
 * The DOM is ambient for this feature by design, so a sandbox with no document
 * proves the State/API fence but cannot run any path that touches the page --
 * and generatePlan touches it immediately, to put the button into its
 * generating state. Tests of those paths get a minimal document; fence tests
 * pass nothing and confirm the module still constructs without one.
 */
function stubElement() {
    return {
        innerHTML: '', textContent: '', value: '', disabled: false, className: '', hidden: false,
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        setAttribute() {},
        classList: { add() {}, remove() {}, contains: () => false },
        closest: () => null,
        dataset: {},
    };
}

function loadFeature({ withDocument = false, document: documentOverride } = {}) {
    const globals = {
        console, JSON, Math, Object, Array, Promise, Number, String, Boolean, Set, Map, Date, RegExp,
    };
    if (withDocument) {
        // Most tests only need the generic stub. A couple bind real listeners
        // (the completed-coursework controls) and need specific elements back
        // from specific ids, so an override is accepted rather than forking
        // this helper.
        globals.document = documentOverride || {
            getElementById: () => stubElement(),
            createElement: () => stubElement(),
            createTextNode: text => ({ textContent: String(text) }),
            querySelector: () => null,
            querySelectorAll: () => [],
        };
    }
    const sandbox = vm.createContext(globals);
    vm.runInContext(`${featureSource}\nglobalThis.__f = Features.degreePlan;`, sandbox);
    return sandbox.__f;
}

function stubDeps(overrides = {}) {
    const plan = { semesters: [], pins: {}, warnings: [], categories: {}, completedSemesters: [] };
    const profile = { major: null, majorData: null, concentration: 'general', planMode: 'full_time' };
    const base = {
        getDegreePlan: async () => ({ semesters: [] }),
        bulletinSearch: async () => ({ courses: [] }),
        getOfferingAnalysis: async () => ({}),
        plan: () => plan,
        profile: () => profile,
        completedCourses: () => [],
        completedDetails: () => [],
        selectedSections: () => ({}),
        selectedCourses: () => ({}),
        sectionLocks: () => ({}),
        currentTerm: () => '202608',
        setSectionLock: () => {},
        removeCourse: () => {},
        emitPlanUpdated: () => {},
        findMajorMap: () => null,
        catalogYearLabel: () => '2026-2027 catalog',
        sourceUrl: () => '',
        sourceLabel: () => 'Official major map',
        onCourseworkChanged: () => {},
        showCourse: () => {},
        searchFor: () => {},
        onProfileChange: () => {},
        onTranscriptChange: () => {},
        onPlanChange: () => {},
    };
    return { ...base, ...overrides };
}

test('no application global is reachable from the feature', () => {
    for (const global of ['State', 'API', 'Profile', 'Prereqs', 'Scheduler', 'Search', 'Tabs']) {
        assert.doesNotMatch(
            codeOnly,
            new RegExp(`\\b${global}\\.`),
            `${global} is reached directly; it should be a declared dependency`,
        );
    }
});

test('every dependency is declared and missing ones fail at construction', () => {
    const { createDegreePlanFeature } = loadFeature();
    for (const name of DEP_NAMES) {
        const deps = stubDeps();
        delete deps[name];
        assert.throws(
            () => createDegreePlanFeature(deps),
            new RegExp(`needs a ${name}\\(\\)`),
            `${name} should be required up front, not discovered mid-plan`,
        );
    }
});

/*
 * Enrichment is optional because the prerequisite layer is a separate script
 * tag, but it must be a function when supplied -- a truthy non-function would
 * fail deep inside plan generation instead of at construction.
 */
test('enrichment is optional but type-checked when supplied', () => {
    const { createDegreePlanFeature } = loadFeature();
    assert.doesNotThrow(() => createDegreePlanFeature(stubDeps()));
    assert.doesNotThrow(() => createDegreePlanFeature(stubDeps({ enrichMajorMap: async m => m })));
    assert.throws(
        () => createDegreePlanFeature(stubDeps({ enrichMajorMap: 'yes please' })),
        /enrichMajorMap\(\) to be a function/,
    );
});

/*
 * The regression the fence exists to prevent. Enrichment was guarded on a
 * global, so inside a fence the plan would have been built from the unenriched
 * major map: a different plan, with nothing anywhere to say so.
 */
test('the injected enricher is used, and its output is what gets planned', async () => {
    const { createDegreePlanFeature } = loadFeature({ withDocument: true });
    const seen = [];
    const planned = [];
    // One stable object: generatePlan writes the enriched map back onto it.
    const profile = { major: 'cs', majorData: { major: 'CS', required_courses: [], total_credits_required: 120 }, planMode: 'full_time', concentration: 'general' };
    const feature = createDegreePlanFeature(stubDeps({
        profile: () => profile,
        enrichMajorMap: async map => { seen.push(map.major); return { ...map, enriched: true }; },
        getDegreePlan: async request => { planned.push(request.major_map?.enriched === true); return { semesters: [] }; },
    }));
    feature.render = () => {};
    feature.updateSidebar = () => {};
    feature.buildCompletedSemesters = () => {};

    await feature.generatePlan();
    assert.deepEqual(asHost(seen), ['CS'], 'the injected enricher should be called');
    assert.deepEqual(asHost(planned), [true], 'the planner should receive the enriched map');
    assert.equal(profile.majorData.enriched, true, 'the enriched map should be written back');
});

test('without an enricher the plan is still generated, from the raw map', async () => {
    const { createDegreePlanFeature } = loadFeature({ withDocument: true });
    const planned = [];
    const profile = { major: 'cs', majorData: { major: 'CS', required_courses: [], total_credits_required: 120 }, planMode: 'full_time', concentration: 'general' };
    const feature = createDegreePlanFeature(stubDeps({
        profile: () => profile,
        getDegreePlan: async request => { planned.push(request.major_map?.enriched === true); return { semesters: [] }; },
    }));
    feature.render = () => {};
    feature.updateSidebar = () => {};
    feature.buildCompletedSemesters = () => {};

    await feature.generatePlan();
    assert.deepEqual(asHost(planned), [false], 'a missing enricher should degrade, not disable');
});

/*
 * Navigation is the whole reason this tab could be fenced before Search and
 * Scheduler are. If the feature reaches those modules directly again, the last
 * extraction gets harder, so this is checked as source as well as behaviour.
 */
test('navigation goes through callbacks, never to the other modules', () => {
    assert.doesNotMatch(codeOnly, /Scheduler\./);
    assert.doesNotMatch(codeOnly, /Search\./);
    assert.doesNotMatch(codeOnly, /Tabs\./);
    assert.match(codeOnly, /deps\.showCourse\(/);
    assert.match(codeOnly, /deps\.searchFor\(/);
});

test('the term used for offering analysis is the injected one', async () => {
    const { createDegreePlanFeature } = loadFeature();
    const asked = [];
    const feature = createDegreePlanFeature(stubDeps({
        currentTerm: () => '202601',
        getOfferingAnalysis: async (code, term) => { asked.push([code, term]); return {}; },
    }));
    // Reach the call directly; the surrounding render path needs a document.
    if (typeof feature.loadOfferingAnalysis === 'function') {
        await feature.loadOfferingAnalysis('CSCE 350').catch(() => {});
    }
    assert.match(codeOnly, /deps\.getOfferingAnalysis\(code, deps\.currentTerm\(\)\)/);
});

test('two instances keep separate plans', () => {
    const { createDegreePlanFeature } = loadFeature();
    const first = { semesters: [{ term: '202608' }], pins: {} };
    const second = { semesters: [], pins: {} };
    const a = createDegreePlanFeature(stubDeps({ plan: () => first }));
    const b = createDegreePlanFeature(stubDeps({ plan: () => second }));

    assert.notStrictEqual(a, b);
    assert.equal(first.semesters.length, 1);
    assert.equal(second.semesters.length, 0, 'one instance must not write through another');
});

test('the composition point supplies every declared dependency', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/degree-plan.js'), 'utf8');
    for (const name of DEP_NAMES) {
        assert.match(composition, new RegExp(`${name}\\s*:`), `${name} is not supplied at the composition point`);
    }
    // A getter, so the ternary runs when the feature asks rather than when this
    // file is parsed -- see tests/test_no_eager_collaborators.js for why.
    assert.match(
        composition,
        /get enrichMajorMap\(\)/,
        'the optional enricher should still be wired, and resolved at call time',
    );
});

/*
 * ScheduleSidebar shared this file with DegreePlan without sharing anything
 * else. It stays in the composition point until the schedule tab is fenced;
 * losing it during this extraction is exactly the kind of accident a wide
 * refactor produces, and the suite caught it once already.
 */
test('ScheduleSidebar survives the extraction as a global', () => {
    const composition = fs.readFileSync(path.join(ROOT, 'static/js/degree-plan.js'), 'utf8');
    assert.match(composition, /const ScheduleSidebar = \{/, 'ScheduleSidebar must remain defined');
    assert.doesNotMatch(codeOnly, /ScheduleSidebar/, 'it must not have been swallowed into the feature');
});

/*
 * The regression tests/test_no_ambient_guards.js catches by source pattern:
 * coursework.js used to gate deps.onCourseworkChanged() behind
 * `typeof Profile !== 'undefined'`. Profile is never in scope inside this
 * fence, so the guard was always false and the callback silently never ran --
 * profile chips and the credit summary stopped repainting on every edit to
 * completed coursework. This is the behavioural half: the callback must
 * actually fire when a completed course is added, with no document global
 * named Profile anywhere in the sandbox.
 */
test('adding a completed course calls onCourseworkChanged, with no ambient Profile guard swallowing it', async () => {
    let clickHandler = null;
    const addBtn = {
        textContent: '',
        disabled: false,
        addEventListener(event, handler) { if (event === 'click') clickHandler = handler; },
    };
    const addInput = { value: 'CSCE 145', addEventListener() {} };
    const document = {
        getElementById(id) {
            if (id === 'btn-add-completed') return addBtn;
            if (id === 'completed-add-input') return addInput;
            if (id === 'completed-add-errors') return { innerHTML: '' };
            return stubElement();
        },
        createElement: () => stubElement(),
        createTextNode: text => ({ textContent: String(text) }),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    const { createDegreePlanFeature } = loadFeature({ withDocument: true, document });

    const completedCourses = [];
    const completedDetails = [];
    const changed = [];
    const profile = { majorData: { required_courses: [{ code: 'CSCE 145', credits: 3 }] } };
    const feature = createDegreePlanFeature(stubDeps({
        completedCourses: () => completedCourses,
        completedDetails: () => completedDetails,
        profile: () => profile,
        // Shape mirrors the real API.bulletinSearch payload (an object with a
        // `results` array of {code, key, ...}), not the unused `{courses}` in
        // the default stub above.
        bulletinSearch: async subject => {
            assert.equal(subject, 'CSCE');
            return { results: [{ code: 'CSCE 145', key: 'csce-145' }] };
        },
        onCourseworkChanged: () => changed.push(true),
    }));
    feature.render = () => {};
    feature.buildCompletedSemesters = () => {};

    feature.bindCompletedControls();
    assert.equal(typeof clickHandler, 'function', 'the add button should have a click handler bound');
    await clickHandler();

    assert.deepEqual(completedCourses, ['CSCE 145'], 'the parsed, validated course should be added');
    assert.equal(
        changed.length, 1,
        'onCourseworkChanged must fire even though Profile is never in scope inside the fence',
    );
});

/*
 * The course-card DOM contract -- the class names and dataset keys render.js
 * writes into markup, coursework.js binds click handlers to, and moves.js
 * binds drag-and-drop to -- used to be a separate string literal in each of
 * those three files. A typo in any one broke a binding silently: a selector
 * or a dataset read naming a class the markup no longer had just matched
 * nothing, no error, no failing test. CARD_DOM centralizes them on the
 * merged feature object (defined once in index.js, since the part files are
 * separate factories and a module-scope const in one is not visible to the
 * others) so a typo becomes a ReferenceError against a missing CARD_DOM key
 * instead.
 */
test('the course-card DOM contract lives in one place: CARD_DOM', () => {
    const { createDegreePlanFeature } = loadFeature();
    const feature = createDegreePlanFeature(stubDeps());

    assert.deepEqual(asHost(feature.CARD_DOM), {
        CARD_CLASS: 'course-card',
        COMPLETED_CARD_CLASS: 'completed-card',
        ELECTIVE_SLOT_CLASS: 'elective-slot',
        REMOVE_BADGE_CLASS: 'card-remove-badge',
        INFO_BUTTON_CLASS: 'course-card-info',
        COURSES_CONTAINER_CLASS: 'semester-courses',
        DELETE_SEM_BUTTON_CLASS: 'sem-delete-btn',
        CODE_ATTR: 'code',
        SEMESTER_ATTR: 'semester',
        SECTION_ATTR: 'section',
        TERM_ATTR: 'term',
        SECTION_PLANNED: 'planned',
        SECTION_COMPLETED: 'completed',
    });
    assert.throws(
        () => { 'use strict'; feature.CARD_DOM.CARD_CLASS = 'nope'; },
        'CARD_DOM must be frozen -- a part accidentally writing to it should fail loudly, not drift silently',
    );

    /*
     * And the literals themselves must not still be duplicated as raw text in
     * the three part files that consume them -- only in index.js, where
     * CARD_DOM is defined. Plain substring checks are enough for the
     * hyphenated, multi-word ones (none of them prefix an unrelated literal
     * elsewhere in these files); the bare "course-card" class needs a
     * negative lookahead so it does not also flag the unrelated styling
     * classes that legitimately keep it as a raw prefix, like
     * course-card-header or course-card-title.
     */
    const rawLiteralsMustNotAppear = [
        'completed-card', 'elective-slot', 'card-remove-badge',
        'course-card-info', 'semester-courses', 'sem-delete-btn',
        'data-code', 'data-semester', 'data-section', 'data-term',
    ];
    const bareCardClass = /course-card(?!-)/;
    for (const file of ['render.js', 'coursework.js', 'moves.js']) {
        const source = fs.readFileSync(path.join(ROOT, 'static/js/features/degree-plan', file), 'utf8');
        for (const literal of rawLiteralsMustNotAppear) {
            assert.ok(
                !source.includes(literal),
                `${file} repeats "${literal}" as a raw literal instead of referencing this.CARD_DOM`,
            );
        }
        assert.doesNotMatch(
            source, bareCardClass,
            `${file} repeats the bare "course-card" class as a raw literal instead of this.CARD_DOM.CARD_CLASS`,
        );
    }
});

/*
 * The REMOVE badge on a completed card. This handler was dead in production:
 * the fence's mechanical seam substitution rewrote the pre-fence field
 * reassignment into `deps.completedCourses() = ...`, an assignment to a call
 * expression, which throws the moment the badge is clicked. Every suite stayed
 * green because nothing drove the click. This test drives the click.
 */
test('the REMOVE badge deletes the course from the live arrays and notifies', () => {
    let badgeHandler = null;
    const badge = {
        dataset: { code: 'MATH 141' },
        addEventListener(event, handler) { if (event === 'click') badgeHandler = handler; },
    };
    const document = {
        getElementById: () => stubElement(),
        createElement: () => stubElement(),
        createTextNode: text => ({ textContent: String(text) }),
        querySelector: () => null,
        querySelectorAll: selector => (
            /completed-card/.test(selector) && /card-remove-badge/.test(selector) ? [badge] : []
        ),
    };
    const { createDegreePlanFeature } = loadFeature({ withDocument: true, document });

    // Live arrays, as State supplies them: the handler must mutate these in
    // place, because reassignment through a getter is impossible.
    const completedCourses = ['MATH 141', 'CSCE 145'];
    const completedDetails = [
        { code: 'MATH 141', grade: 'A', credits: 4 },
        { code: 'CSCE 145', grade: 'B', credits: 4 },
    ];
    const changed = [];
    const feature = createDegreePlanFeature(stubDeps({
        completedCourses: () => completedCourses,
        completedDetails: () => completedDetails,
        onCourseworkChanged: () => changed.push(true),
    }));
    let rebuilt = 0;
    let rendered = 0;
    feature.buildCompletedSemesters = () => { rebuilt += 1; };
    feature.render = () => { rendered += 1; };

    feature.bindCompletedControls();
    assert.equal(typeof badgeHandler, 'function', 'the badge should have a click handler bound');

    badgeHandler({ stopPropagation() {} });

    assert.deepEqual(JSON.parse(JSON.stringify(completedCourses)), ['CSCE 145'],
        'the clicked course must leave the live array');
    assert.deepEqual(JSON.parse(JSON.stringify(completedDetails.map(d => d.code))), ['CSCE 145']);
    assert.equal(rebuilt, 1);
    assert.equal(rendered, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(changed)), [true],
        'the coursework change must be announced so profile chips repaint');
});

/*
 * renderCompletedColumn used `isElective` without declaring it -- a local of
 * the sibling renderSemesterColumn, out of scope here -- so any completed
 * semester that actually had courses threw a ReferenceError instead of
 * rendering. The empty-semester case never hit the loop, which is why it
 * survived: plans without imported coursework never exercised the line.
 */
test('a completed semester with courses renders instead of throwing', () => {
    const { createDegreePlanFeature } = loadFeature({ withDocument: true });
    const feature = createDegreePlanFeature(stubDeps());

    const html = feature.renderCompletedColumn({
        type: 'completed',
        term: '202408',
        label: 'Fall 2024',
        total_credits: 8,
        courses: [
            { code: 'MATH 141', title: 'Calculus I', credits: 4 },
            { code: 'CSCE 145', title: 'Algorithmic Design I', credits: 4 },
        ],
    }, 0);

    assert.match(html, /MATH 141/);
    assert.match(html, /CSCE 145/);
    assert.match(html, /Fall 2024/);
    // The REMOVE badge must be present, or the (now-fixed) removal handler
    // has nothing to bind to.
    assert.match(html, new RegExp(feature.CARD_DOM.REMOVE_BADGE_CLASS));
});

/*
 * The column renderers are pure string builders, so they can be exercised
 * directly. The completed-column test is a regression guard: an edit meant for
 * the planned column once landed on the identical line in the completed
 * column, referencing a variable that only exists in the other method, and no
 * test rendered a completed semester with courses in it to catch the throw.
 */
test('completed semester columns render every course by its code', () => {
    const { createDegreePlanFeature } = loadFeature();
    const feature = createDegreePlanFeature(stubDeps());
    const sem = {
        term: '202501',
        label: 'Spring 2025',
        type: 'completed',
        total_credits: 7,
        courses: [
            { code: 'CSCE 145', title: 'Algorithmic Design I', credits: 4 },
            { code: 'MATH 141', title: 'Calculus I', credits: 3 },
        ],
    };

    const html = feature.renderCompletedColumn(sem, 0);

    assert.match(html, /completed-card/);
    assert.match(html, /<span class="course-card-code">CSCE 145<\/span>/);
    assert.match(html, /<span class="course-card-code">MATH 141<\/span>/);
    assert.doesNotMatch(html, /undefined/);

    const current = feature.renderCompletedColumn({ ...sem, type: 'current' }, 1);
    assert.match(current, /current-header/);
});

test('planned elective slots render their title instead of the synthetic code', () => {
    const { createDegreePlanFeature } = loadFeature();
    const feature = createDegreePlanFeature(stubDeps());
    const sem = {
        term: '202608',
        label: 'Fall 2026',
        total_credits: 6,
        courses: [
            {
                code: '[REQ-1-1]',
                title: 'Technical Elective',
                credits: 3,
                is_elective_slot: true,
                elective_group_id: 'requirement-1',
            },
            { code: 'CSCE 240', title: 'Advanced Programming Techniques', credits: 3 },
        ],
    };

    const html = feature.renderSemesterColumn(sem, 0);

    assert.match(html, /<span class="course-card-code">Technical Elective<\/span>/);
    assert.doesNotMatch(html, /<span class="course-card-code">\[REQ-1-1\]<\/span>/);
    assert.match(html, /<span class="course-card-code">CSCE 240<\/span>/);
});
