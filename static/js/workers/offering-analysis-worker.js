'use strict';

self.importScripts('../runtime/offering-analyzer.js');

self.addEventListener('message', event => {
    const { requestId = null, operation, payload = {} } = event.data || {};
    try {
        let result;
        if (operation === 'analyze') {
            result = self.OfferingAnalyzerRuntime.analyzeOfferingPattern(
                payload.history_data,
                payload.as_of_term,
            );
        } else if (operation === 'summary') {
            result = self.OfferingAnalyzerRuntime.getOfferingSummary(
                payload.history_data,
                payload.current_term,
            );
        } else if (operation === 'predict') {
            result = self.OfferingAnalyzerRuntime.predictNextOffering(
                payload.pattern_data,
                payload.current_term,
            );
        } else if (operation === 'enrollment') {
            result = self.OfferingAnalyzerRuntime.summarizeEnrollment(payload.terms);
        } else {
            throw new Error(`Unknown offering-analysis operation: ${operation}`);
        }
        self.postMessage({ requestId, ok: true, result });
    } catch (error) {
        self.postMessage({ requestId, ok: false, error: error?.message || String(error) });
    }
});
