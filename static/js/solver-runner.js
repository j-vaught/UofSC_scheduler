/* Yielding search runner shared by the worker and the local fallback. */
(function initSolverRunner(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.SolverRunner = api;
}(typeof globalThis === 'object' ? globalThis : self, root => {
    'use strict';
    const clock = () => root.performance?.now ? root.performance.now() : Date.now();
    const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
    const core = () => root.SolverCore || (typeof require === 'function' ? require('./solver-core.js') : null);
    function createLocal(params, options = {}) {
        const engine = core();
        if (!engine) throw new Error('Schedule solver is unavailable');
        let session = engine.createSession(params, options.checkpoint || null);
        let committed = engine.getCheckpoint(session);
        let disposed = false;
        let pauseRequested = false;
        let running = null;
        let state = session.complete ? 'complete' : 'paused';
        let stopReason = session.complete ? 'exhausted' : 'ready';
        let progressTime = -Infinity;
        const envelope = checkpoint => ({ session_id: session.session_id, input_revision: session.input_revision,
            checkpoint, total_found: checkpoint.total_found, visited: checkpoint.visited,
            state, stop_reason: stopReason });
        const progress = (force = false) => {
            if (!disposed && (force || clock() - progressTime >= 500)) {
                progressTime = clock();
                options.onProgress?.(envelope(committed));
            }
        };
        async function run() {
            state = 'running';
            stopReason = null;
            progress(true);
            let active = 0;
            let buffered = [];
            let flushTime = clock();
            const runBudget = Math.max(1, Number(options.runBudgetMs) || 30000);
            try {
                while (!disposed) {
                    if (!pauseRequested && active < runBudget && !session.complete) {
                        const result = engine.step(session, { budgetMs: Math.min(50, runBudget - active), maxResults: 250 - buffered.length });
                        active += result.active_ms;
                        buffered.push(...result.results);
                    }
                    const stopping = pauseRequested || active >= runBudget || session.complete;
                    if (stopping) {
                        state = session.complete ? 'complete' : 'paused';
                        stopReason = session.complete ? 'exhausted' : pauseRequested ? 'user' : 'time_budget';
                    }
                    if (buffered.length >= 250 || clock() - flushTime >= 500 || stopping) {
                        const checkpoint = engine.getCheckpoint(session);
                        const batch = { ...envelope(checkpoint), results: buffered };
                        // Do not advance search until the caller has committed both
                        // result references and this exact checkpoint atomically.
                        await options.onBatch?.(batch);
                        if (disposed) return envelope(committed);
                        committed = checkpoint;
                        buffered = [];
                        flushTime = clock();
                    }
                    progress();
                    if (stopping) return envelope(committed);
                    await yieldTask();
                }
                return envelope(committed);
            } catch (error) {
                session = engine.createSession(params, committed);
                state = 'paused';
                stopReason = 'storage';
                progress(true);
                options.onError?.(error);
                return { ...envelope(committed), error: error instanceof Error ? error.message : String(error) };
            } finally {
                running = null;
            }
        }
        const start = () => {
            if (disposed) return Promise.resolve({ ...envelope(committed), state: 'disposed' });
            if (running) return running;
            // Defer entering run so even a synchronously thrown callback cannot
            // race the assignment of the active promise.
            pauseRequested = false;
            running = Promise.resolve().then(run);
            return running;
        };
        return {
            start, resume: start,
            pause() {
                pauseRequested = true;
                if (running) return running;
                return Promise.resolve(envelope(committed));
            },
            dispose() { disposed = true; pauseRequested = true; state = 'disposed'; },
            get checkpoint() { return committed; },
            get state() { return state; },
            queryPage(query) { return Promise.resolve(options.onPageQuery?.(query)); },
        };
    }

    return { createLocal };
}));
