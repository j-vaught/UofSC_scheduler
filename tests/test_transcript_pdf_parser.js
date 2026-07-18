const assert = require('node:assert/strict');
const test = require('node:test');

const parser = require('../static/js/runtime/transcript-parser.js');
const pdfReader = require('../static/js/transcript-pdf.js');

function item(str, x, y, page = 1) {
    return { str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, page };
}

function transcriptPages() {
    const items = [
        item('Academic Transcript', 20, 780),
        item('Curriculum Information', 20, 760),
        item('Current Program', 20, 745),
        item('College: Engineering and Computing', 20, 730),
        item('Major: Computer Science', 20, 715),
        item('INSTITUTION CREDIT', 20, 690),
        item('Term: Fall 2024', 20, 670),
        item('Subject', 20, 650),
        item('Course', 80, 650),
        item('Level', 140, 650),
        item('Title', 190, 650),
        item('Grade', 450, 650),
        item('Credit Hours', 510, 650),
        item('Quality Points', 590, 650),
        item('R', 680, 650),
        item('CSCE', 20, 630),
        item('145', 80, 630),
        item('UG', 140, 630),
        item('Algorithmic Design I', 190, 630),
        item('A', 450, 630),
        item('4.000', 510, 630),
        item('16.00', 590, 630),
        item('CSCE', 20, 610),
        item('145', 80, 610),
        item('UG', 140, 610),
        item('Algorithmic Design I', 190, 610),
        item('W', 450, 610),
        item('0.000', 510, 610),
        item('0.00', 590, 610),
        item('R', 680, 610),
        item('MATH', 20, 590),
        item('141', 80, 590),
        item('UG', 140, 590),
        item('Calculus I', 190, 590),
        item('ZZ', 450, 590),
        item('4.000', 510, 590),
        item('0.00', 590, 590),
        item('Current Term: 12.000 8.000 8.000 8.000 32.00 4.00', 20, 560),
        item('TRANSFER CREDIT ACCEPTED BY INSTITUTION', 20, 520),
        item('Transfer Institution: Midlands Technical College', 20, 500),
        item('Term: Spring 2023', 20, 480),
        item('Subject', 20, 460),
        item('Course', 80, 460),
        item('Level', 140, 460),
        item('Title', 190, 460),
        item('Grade', 450, 460),
        item('Credit Hours', 510, 460),
        item('Quality Points', 590, 460),
        item('ENGL', 20, 440),
        item('101', 80, 440),
        item('UG', 140, 440),
        item('Critical Reading', 190, 440),
        item('A_TR', 450, 440),
        item('3.000', 510, 440),
        item('0.00', 590, 440),
        item('Transcript Totals', 20, 400),
    ];
    return [{ page: 1, items }];
}

test('Banner advising parser preserves attempts and review evidence without identity fields', () => {
    const result = parser.parseAdvisingTranscriptItems(transcriptPages(), { pageCount: 1 });
    assert.equal(result.document.kind, 'uofsc-advising-transcript');
    assert.equal(result.attempts.length, 4);
    assert.equal(result.attempts.filter(attempt => attempt.code === 'CSCE 145').length, 2);
    assert.equal(result.attempts[0].status, 'completed');
    assert.equal(result.attempts[1].status, 'withdrawn');
    assert.equal(result.attempts[1].repeat.repeated, true);
    assert.equal(result.attempts[2].status, 'unknown');
    assert.equal(result.attempts[2].counts_as_completed, null);
    assert.equal(result.attempts[2].needs_review, true);
    assert.equal(result.attempts[3].source, 'transfer');
    assert.equal(result.attempts[3].normalized_grade, 'A');
    assert.equal(result.attempts[3].transfer_institution, 'Midlands Technical College');
    assert.equal(result.terms[0].totals.current.attempted_credits, 12);
    assert.equal(result.document.programs[0].major, 'Computer Science');
    assert.equal(Object.hasOwn(result.document, 'name'), false);
    assert.match(result.attempts[0].evidence.line, /CSCE 145/);
});

test('missing and unknown grades are never silently treated as passing', () => {
    for (const grade of [null, '', 'ZZ', 'UNKNOWN']) assert.equal(parser.isPassing(grade), false);
    assert.deepEqual(parser.classifyGrade(null), {
        status: 'in_progress',
        counts_as_completed: false,
        normalized_grade: null,
        known: true,
    });
    assert.equal(parser.classifyGrade('ZZ').counts_as_completed, null);
});

test('positioned Banner columns keep long titles out of grade cells and support transfer headers', () => {
    const items = [
        item('Academic Transcript', 20, 780),
        item('TRANSFER CREDIT', 20, 760),
        item('Subject', 20, 730),
        item('Course', 80, 730),
        item('Title', 190, 730),
        item('Grade', 450, 730),
        item('Credit', 510, 730),
        item('Quality', 590, 730),
        item('ENGL', 20, 710),
        item('101', 80, 710),
        item('Critical', 190, 710),
        item('Reading', 240, 710),
        item('and', 290, 710),
        item('Composition', 320, 710),
        item('A_TR', 450, 710),
        item('3.000', 510, 710),
        item('0.00', 590, 710),
        item('Transcript Totals', 20, 680),
        item('Credit Hours', 20, 660),
    ];
    const result = parser.parseAdvisingTranscriptItems([{ page: 1, items }], { level: 'UG' });

    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].title, 'Critical Reading and Composition');
    assert.equal(result.attempts[0].normalized_grade, 'A');
    assert.equal(result.attempts[0].status, 'completed');
    assert.equal(result.attempts[0].source, 'transfer');
});

test('unrelated and image-only PDFs fail with structured format errors', () => {
    assert.throws(
        () => parser.parseAdvisingTranscriptItems([{ page: 1, items: [] }]),
        error => error.code === 'NO_EXTRACTABLE_TEXT',
    );
    assert.throws(
        () => parser.parseAdvisingTranscriptItems([{ page: 1, items: [item('Recipe', 10, 10)] }]),
        error => error.code === 'UNRECOGNIZED_TRANSCRIPT',
    );
});

test('PDF reader validates input, extracts pages, reports progress, and destroys the document', async () => {
    let destroyed = false;
    const events = [];
    const fakePdfJs = {
        GlobalWorkerOptions: {},
        getDocument() {
            return {
                promise: Promise.resolve({
                    numPages: 1,
                    async getPage() {
                        return {
                            async getTextContent() { return { items: transcriptPages()[0].items }; },
                            cleanup() {},
                        };
                    },
                    async destroy() { destroyed = true; },
                }),
            };
        },
    };
    const bytes = new TextEncoder().encode('%PDF-fake').buffer;
    const result = await pdfReader.parse(bytes, {
        pdfjsLib: fakePdfJs,
        parser,
        onProgress: event => events.push(event),
    });
    assert.equal(result.attempts.length, 4);
    assert.equal(destroyed, true);
    assert.deepEqual(events.at(-1), { phase: 'parsing', completed: 1, total: 1, percent: 100 });
});
