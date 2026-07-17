'use strict';

self.importScripts('../runtime/offering-analyzer.js', '../runtime/degree-planner.js');

self.addEventListener('message', event => {
    const { requestId = null, operation, payload = {} } = event.data || {};
    try {
        let result;
        if (operation === 'plan-degree') {
            result = self.DegreePlannerRuntime.planDegree(
                payload.major_map,
                payload.completed || [],
                payload.options || {},
            );
        } else if (operation === 'compute-remaining') {
            result = self.DegreePlannerRuntime.computeRemaining(
                payload.major_map,
                payload.completed || [],
                payload.concentration,
            );
        } else if (operation === 'evaluate-requirements') {
            result = self.DegreePlannerRuntime.evaluateRequirementGroups(
                payload.groups || [],
                payload.completed || [],
            );
        } else {
            throw new Error(`Unknown degree-planner operation: ${operation}`);
        }
        self.postMessage({ requestId, ok: true, result });
    } catch (error) {
        self.postMessage({ requestId, ok: false, error: error?.message || String(error) });
    }
});
