'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const State = require('../static/js/state.js');
const TranscriptUploadDialog = require('../static/js/transcript-upload-dialog.js');

// The startup sequence moved out of an inline <script> in index.html and
// into static/js/boot.js, because the site's CSP forbids inline scripts.
function bootSource() {
    return require('node:fs').readFileSync('static/js/boot.js', 'utf8');
}

function resetState() {
    State.savedPlans = {};
    State.currentPlan = 'Plan A';
    State.manualCompletedDetails = [];
    State.transcriptAttempts = [];
    State.completedCourses = [];
    State.completedDetails = [];
    State._listeners = {};
}

function attempts() {
    return [
        {
            attempt_id: 'institution:Fall 2025:CSCE 145:1',
            code: 'CSCE 145',
            title: 'Algorithmic Design I',
            term: 'Fall 2025',
            level: 'UG',
            normalized_grade: 'A',
            credit_hours: 4,
            earned_credits: 4,
            status: 'completed',
            counts_as_completed: true,
            source: 'institution',
            confidence: { score: 0.98, level: 'high', reasons: ['not persisted'] },
            evidence: { page: 1, line: 'private transcript line' },
            student_name: 'must not persist',
        },
        {
            attempt_id: 'institution:Spring 2026:CSCE 145:1',
            code: 'CSCE 145',
            title: 'Algorithmic Design I',
            term: 'Spring 2026',
            level: 'UG',
            raw_grade: 'W',
            credit_hours: 4,
            status: 'withdrawn',
            counts_as_completed: false,
            source: 'institution',
            evidence: { page: 2, line: 'another private line' },
        },
        {
            attempt_id: 'institution:Spring 2026:MATH 142:1',
            code: 'MATH 142',
            title: 'Calculus II',
            term: 'Spring 2026',
            level: 'UG',
            raw_grade: null,
            credit_hours: 4,
            status: 'in_progress',
            counts_as_completed: false,
            source: 'institution',
        },
    ];
}

test('confirmed transcript attempts are sanitized, preserved, and safely derived', () => {
    resetState();
    const applied = State.applyTranscriptAttempts(attempts(), { mode: 'merge', level: 'UG' });

    assert.equal(applied.added, 3);
    assert.equal(State.transcriptAttempts.length, 3);
    assert.deepEqual(State.completedCourses, ['CSCE 145']);
    assert.equal(State.completedDetails.length, 1);
    assert.equal(State.completedDetails[0].counts_as_completed, true);
    assert.equal(Object.hasOwn(State.transcriptAttempts[0], 'evidence'), false);
    assert.equal(Object.hasOwn(State.transcriptAttempts[0], 'student_name'), false);
    assert.equal(Object.hasOwn(State.transcriptAttempts[0].confidence, 'reasons'), false);
});

test('merge deduplicates reimports while replace and undo have predictable semantics', () => {
    resetState();
    State.addManualCompletedRecords([{ code: 'ENGL 101', credits: 3 }]);
    const first = State.applyTranscriptAttempts(attempts(), { mode: 'merge', level: 'UG' });
    const repeated = State.applyTranscriptAttempts(attempts(), { mode: 'merge', level: 'UG' });

    assert.equal(first.added, 3);
    assert.equal(repeated.added, 0);
    assert.equal(repeated.duplicates, 3);
    assert.deepEqual(State.completedCourses, ['CSCE 145', 'ENGL 101']);

    const replaced = State.applyTranscriptAttempts([attempts()[2]], { mode: 'replace', level: 'UG' });
    assert.deepEqual(State.completedCourses, []);
    assert.equal(State.manualCompletedDetails.length, 0);
    assert.equal(State.transcriptAttempts.length, 1);

    State.restoreTranscriptSnapshot(replaced.snapshot);
    assert.deepEqual(State.completedCourses, ['CSCE 145', 'ENGL 101']);
    assert.equal(State.transcriptAttempts.length, 3);
});

test('legacy plan and JSON data migrate into explicit completed manual records', () => {
    resetState();
    State.savedPlans.Legacy = {
        completedCourses: ['CSCE145', 'MATH 141'],
        completedDetails: [{ code: 'CSCE 145', grade: 'B', credits: 4, semester: 'Fall 2024' }],
    };
    assert.equal(State.loadPlan('Legacy'), true);
    assert.deepEqual(State.completedCourses, ['CSCE 145', 'MATH 141']);
    assert.ok(State.completedDetails.every(record => record.counts_as_completed === true));
    assert.equal(State.transcriptAttempts.length, 0);

    resetState();
    assert.equal(State.importFromJSON(JSON.stringify({
        version: 4,
        completedCourses: ['ENGL 101'],
        completedDetails: [],
    })), true);
    assert.deepEqual(State.completedCourses, ['ENGL 101']);
});

test('controller connects local PDF parsing, state updates, persistence, refresh, and undo', async () => {
    resetState();
    const calls = { save: 0, profile: 0, degree: 0, progress: [] };
    // Import persists coursework only. It must NOT call savePlan, which
    // snapshots the whole application state over the student's saved schedule.
    State.saveCompletedCoursework = () => { calls.save += 1; };
    State.savePlan = () => { calls.overwroteWholePlan = (calls.overwroteWholePlan || 0) + 1; };
    global.State = State;
    global.API = {
        async parseTranscriptPDF(file, options) {
            assert.equal(file.name, 'advising.pdf');
            assert.equal(options.level, 'UG');
            options.onProgress({ phase: 'extracting', percent: 50 });
            return { attempts: attempts() };
        },
    };
    global.Profile = {
        renderCompletedChips() { calls.profile += 1; },
        renderCreditSummary() { calls.profile += 1; },
    };
    global.DegreePlan = {
        buildCompletedSemesters() { calls.degree += 1; },
        updateSidebar() { calls.degree += 1; },
        render() { calls.degree += 1; },
    };
    const TranscriptImport = require('../static/js/transcript-import.js');
    const result = await TranscriptImport.process({
        file: { name: 'advising.pdf' },
        level: 'UG',
        onProgress: event => calls.progress.push(event),
    });
    assert.equal(result.attempts.length, 3);
    assert.equal(calls.progress[0].message, 'Reading transcript pages');

    const applied = await TranscriptImport.apply({ result, mode: 'merge', level: 'UG' });
    assert.equal(State.transcriptAttempts.length, 3);
    assert.equal(calls.save, 1);
    assert.equal(calls.overwroteWholePlan, undefined, 'import must not overwrite the saved plan');
    assert.equal(calls.profile, 2);
    assert.equal(calls.degree, 3);
    assert.equal(typeof applied.undo, 'function');

    await applied.undo();
    assert.equal(State.transcriptAttempts.length, 0);
    assert.equal(calls.save, 2);
});

test('dialog and static shell expose attempt review, immediate undo, and integration assets', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const worker = fs.readFileSync('static/service-worker.js', 'utf8');
    const markup = TranscriptUploadDialog.shellMarkup();
    const summary = TranscriptUploadDialog.summarizeResult({ attempts: attempts() });

    assert.deepEqual(summary, {
        completed: 1,
        inProgress: 1,
        transfer: 0,
        needsReview: 1,
        total: 3,
    });
    assert.match(markup, /id="transcript-undo" hidden>UNDO IMPORT/);
    // Cache markers are stamped from file contents at build time, so the source
    // tag carries none. test_static_site_build.py covers the stamping itself.
    assert.match(html, /src="\/static\/js\/transcript-import\.js"/);
    assert.match(html, /src="\/static\/js\/api\.js"/);
    // Boot registers modules as `['Label', () => Module]` rows now.
    assert.match(html + bootSource(), /\(\)\s*=>\s*TranscriptImport\b/);
    /*
     * These used to be asserted against a hand-maintained list in
     * service-worker.js. The shell list is derived from index.html at build
     * time now, so being on the page *is* being precached -- asserting the
     * script tag is the same guarantee with one fewer thing to keep in sync.
     */
    assert.match(worker, /const SHELL_ASSETS = __SHELL_ASSETS__;/);
    assert.match(html, /src="\/static\/js\/transcript-upload-dialog\.js/);
    assert.match(html, /src="\/static\/js\/transcript-import\.js/);
});
