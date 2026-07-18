'use strict';

self.importScripts('../runtime/transcript-parser.js?v=20260718');

self.addEventListener('message', event => {
    const { requestId = null, operation, payload = {} } = event.data || {};
    try {
        let result;
        if (operation === 'parse-text') {
            result = self.TranscriptParserRuntime.parseText(payload.text);
        } else if (operation === 'parse-csv') {
            result = self.TranscriptParserRuntime.parseCsv(payload.csv);
        } else if (operation === 'parse-advising-items') {
            result = self.TranscriptParserRuntime.parseAdvisingTranscriptItems(
                payload.pages,
                payload.options,
            );
        } else if (operation === 'normalize-code') {
            result = self.TranscriptParserRuntime.normalizeCode(payload.code);
        } else if (operation === 'is-passing') {
            result = self.TranscriptParserRuntime.isPassing(payload.grade, payload.minimum_grade);
        } else {
            throw new Error(`Unknown transcript operation: ${operation}`);
        }
        self.postMessage({ requestId, ok: true, result });
    } catch (error) {
        self.postMessage({ requestId, ok: false, error: error?.message || String(error) });
    }
});
