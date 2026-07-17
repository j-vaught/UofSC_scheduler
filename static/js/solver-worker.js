/* Off-main-thread wrapper around the browser-native schedule solver. */
importScripts('/static/js/solver-core.js');

self.addEventListener('message', event => {
    const { id, params } = event.data || {};
    if (id === undefined || id === null) return;
    try {
        self.postMessage({ id, result: SolverCore.solve(params) });
    } catch (error) {
        self.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

