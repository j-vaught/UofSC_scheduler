'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const TranscriptUploadDialog = require('../static/js/transcript-upload-dialog.js');

test('one reusable transcript dialog serves home, profile, and degree plan', () => {
    const html = fs.readFileSync('static/index.html', 'utf8');
    const launchers = [...html.matchAll(/data-transcript-upload-launch="([^"]+)"/g)]
        .map(match => match[1]);

    assert.deepEqual(launchers, ['home', 'profile', 'degree']);
    assert.equal((html.match(/id="transcript-upload-dialog"/g) || []).length, 0);
    assert.match(html, /src="\/static\/js\/transcript-upload-dialog\.js"/);
    assert.match(html, /TranscriptImport\.init\(\)/);
});

test('dialog provides direct and fallback UofSC transcript guidance', () => {
    const markup = TranscriptUploadDialog.shellMarkup();

    assert.match(markup, /banner\.onecarolina\.sc\.edu\/StudentSelfService\/ssb\/academicTranscript\?mepCode=COL/);
    assert.match(markup, /https:\/\/my\.sc\.edu/);
    assert.match(markup, /Undergraduate/);
    assert.match(markup, /Graduate/);
    assert.match(markup, /Advising/);
    assert.match(markup, /Submit/);
    assert.match(markup, /Print/);
    assert.match(markup, /Download/);
    assert.match(markup, /Processed on this device/);
});

test('PDF validation accepts advising PDFs and rejects unsafe inputs', () => {
    assert.equal(TranscriptUploadDialog.validPdf({
        name: 'Advising Transcript.pdf',
        type: 'application/pdf',
        size: 500_000,
    }), true);
    assert.equal(TranscriptUploadDialog.validPdf({
        name: 'Advising Transcript.pdf',
        type: '',
        size: 500_000,
    }), true);
    assert.equal(TranscriptUploadDialog.validPdf({
        name: 'transcript.csv',
        type: 'text/csv',
        size: 500_000,
    }), false);
    assert.equal(TranscriptUploadDialog.validPdf({
        name: 'transcript.pdf',
        type: 'application/pdf',
        size: TranscriptUploadDialog.MAX_FILE_BYTES + 1,
    }), false);
});

test('review summary separates completed, current, transfer, and uncertain records', () => {
    const summary = TranscriptUploadDialog.summarizeResult({
        courses: [
            { code: 'CSCE 145', status: 'completed' },
            { code: 'MATH 142', status: 'in_progress' },
            { code: 'ENGL 101', status: 'completed', source: 'transfer' },
            { code: 'CHEM 111', status: 'completed', confidence: 0.6 },
        ],
    });

    assert.deepEqual(summary, {
        completed: 1,
        inProgress: 1,
        transfer: 1,
        needsReview: 1,
        total: 4,
    });

    const source = fs.readFileSync('static/js/transcript-upload-dialog.js', 'utf8');
    assert.match(source, /course record.*course records/);
});

test('public processor and apply-handler seams are mockable', () => {
    const processor = async () => ({ courses: [] });
    const applyHandler = async () => {};

    assert.equal(TranscriptUploadDialog.setProcessor(processor), TranscriptUploadDialog);
    assert.equal(TranscriptUploadDialog._processor, processor);
    assert.equal(TranscriptUploadDialog.setApplyHandler(applyHandler), TranscriptUploadDialog);
    assert.equal(TranscriptUploadDialog._applyHandler, applyHandler);
    assert.throws(() => TranscriptUploadDialog.setProcessor('bad'), TypeError);
    assert.throws(() => TranscriptUploadDialog.setApplyHandler({}), TypeError);

    TranscriptUploadDialog.setProcessor(null);
    TranscriptUploadDialog.setApplyHandler(null);
});

test('transcript modules expose explicit browser globals for hosted startup', () => {
    const dialogSource = fs.readFileSync('static/js/transcript-upload-dialog.js', 'utf8');
    const importSource = fs.readFileSync('static/js/transcript-import.js', 'utf8');

    assert.match(dialogSource, /globalThis\.TranscriptUploadDialog\s*=\s*TranscriptUploadDialog/);
    assert.match(importSource, /globalThis\.TranscriptImport\s*=\s*TranscriptImport/);
});

test('dialog source includes keyboard, outside-click, drag-and-drop, and focus restoration', () => {
    const source = fs.readFileSync('static/js/transcript-upload-dialog.js', 'utf8');

    assert.match(source, /event\.key === 'Escape'/);
    assert.match(source, /event\.target === this\.overlay/);
    assert.match(source, /addEventListener\('drop'/);
    assert.match(source, /event\.key !== 'Enter' && event\.key !== ' '/);
    assert.match(source, /this\.trapFocus\(event\)/);
    assert.match(source, /restore\?\.isConnected && restore\.focus\(\)/);
    assert.match(source, /transcript-import:selected/);
    assert.match(source, /transcript-import:confirmed/);
    assert.match(source, /transcript-import:applied/);
});

test('dialog uses accessible modal, progress, alert, and file-picker semantics', () => {
    const markup = TranscriptUploadDialog.shellMarkup();
    const styles = fs.readFileSync('static/css/style.css', 'utf8');

    assert.match(markup, /role="dialog" aria-modal="true"/);
    assert.match(markup, /aria-labelledby="transcript-upload-title"/);
    assert.match(markup, /role="progressbar"/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /accept="application\/pdf,\.pdf"/);
    assert.match(markup, /name="transcript-import-mode" value="merge" checked/);
    assert.match(markup, /name="transcript-import-mode" value="replace"/);
    assert.match(styles, /\.transcript-upload-dialog\s*{[^}]*max-width:\s*1040px/s);
    assert.match(styles, /\.transcript-upload-close:hover\s*{[^}]*background:\s*#73000A/s);
});
