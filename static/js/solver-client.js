/* Resumable solver transport. Storage acknowledgements are the durability boundary. */
(function initSolverClient(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.SolverClient = api;
}(typeof globalThis === 'object' ? globalThis : self, root => {
    'use strict';
    let sequence = 0;

    const createLocal = (params, options) => {
        const runner = root.SolverRunner || (typeof require === 'function' ? require('./solver-runner.js') : null);
        if (!runner) throw new Error('Schedule solver runner is unavailable');
        return runner.createLocal(params, options);
    };

    function create(params, options = {}) {
        params = { ...params, session_id: params.session_id || `solver-${Date.now()}-${++sequence}`,
            input_revision: params.input_revision || '' };
        if (options.useWorker === false || typeof root.Worker !== 'function') return createLocal(params, options);
        let worker;
        try { worker = new root.Worker(options.workerUrl || '/static/js/solver-worker.js'); }
        catch { return createLocal(params, options); }
        let disposed = false;
        let state = options.checkpoint?.complete ? 'complete' : 'paused';
        let committed = options.checkpoint || null;
        let operation = null;
        let fallback = null;
        let batches = Promise.resolve();
        let failure = null;
        const send = message => {
            if (!disposed && worker) worker.postMessage({ ...message,
                session_id: params.session_id, input_revision: params.input_revision });
        };
        const finish = message => {
            state = message.state;
            const pending = operation;
            operation = null;
            pending?.resolve(message);
        };
        const fail = async error => {
            if (disposed || failure) return;
            failure = error;
            worker?.terminate();
            worker = null;
            // A batch already handed to storage may still finish. Wait for it
            // before restarting from the newest committed checkpoint.
            await batches.catch(() => {});
            if (disposed) return;
            try {
                fallback = createLocal(params, { ...options, useWorker: false, checkpoint: committed,
                    onBatch: async batch => { await options.onBatch?.(batch); committed = batch.checkpoint; },
                });
            } catch (fallbackError) {
                const message = { session_id: params.session_id, input_revision: params.input_revision,
                    state: 'paused', stop_reason: 'error', checkpoint: committed,
                    total_found: committed?.total_found || 0,
                    error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) };
                options.onError?.(fallbackError);
                finish(message);
                return;
            }
            options.onProgress?.({ session_id: params.session_id, input_revision: params.input_revision,
                checkpoint: committed, total_found: committed?.total_found || 0, state: 'paused',
                stop_reason: 'worker_fallback' });
            if (operation) {
                const pending = operation;
                operation = null;
                if (pending.pausing) pending.resolve(await fallback.pause());
                else pending.resolve(await fallback.resume());
            }
        };
        worker.addEventListener('error', event => { fail(new Error(event.message || 'Schedule worker failed')); });
        worker.addEventListener('message', event => {
            const message = event.data || {};
            if (disposed || message.session_id !== params.session_id
                || message.input_revision !== params.input_revision) return;
            if (message.type === 'batch') {
                batches = batches.then(async () => {
                    if (disposed) return;
                    try {
                        await options.onBatch?.(message);
                        if (disposed) return;
                        committed = message.checkpoint;
                        send({ command: 'ack', batch_id: message.batch_id });
                    } catch (error) {
                        send({ command: 'ack', batch_id: message.batch_id,
                            error: error instanceof Error ? error.message : String(error) });
                    }
                });
            } else if (message.type === 'progress') {
                state = message.state;
                options.onProgress?.(message);
            } else if (message.type === 'terminal') {
                batches.then(() => { if (!disposed) finish(message); });
            } else if (message.type === 'error') {
                fail(new Error(message.error || 'Schedule worker failed'));
            }
        });
        const start = command => {
            if (disposed) return Promise.resolve({ state: 'disposed', checkpoint: committed });
            if (fallback) return fallback[command === 'start' ? 'start' : 'resume']();
            if (operation) return operation.promise;
            let resolve;
            const promise = new Promise(done => { resolve = done; });
            operation = { promise, resolve };
            state = 'running';
            send({ command, params, checkpoint: committed, run_budget_ms: options.runBudgetMs || 30000 });
            return promise;
        };
        return {
            start: () => start('start'), resume: () => start('resume'),
            pause() {
                if (disposed) return Promise.resolve({ state: 'disposed', checkpoint: committed });
                if (fallback) return fallback.pause();
                if (!operation) return Promise.resolve({ state, checkpoint: committed,
                    total_found: committed?.total_found || 0, session_id: params.session_id, input_revision: params.input_revision });
                operation.pausing = true;
                send({ command: 'pause' });
                return operation.promise;
            },
            dispose() {
                if (disposed) return;
                send({ command: 'dispose' });
                disposed = true; state = 'disposed';
                worker?.terminate(); worker = null;
                fallback?.dispose();
                operation?.resolve({ state: 'disposed', checkpoint: committed });
                operation = null;
            },
            get checkpoint() { return fallback?.checkpoint || committed; },
            get state() { return fallback?.state || state; },
            queryPage(query) { return Promise.resolve(options.onPageQuery?.(query)); },
        };
    }
    return { create, createLocal };
}));
