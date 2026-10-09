/* Off-main-thread solver with acknowledged, resumable result batches. */
importScripts('/static/js/solver-core.js', '/static/js/solver-runner.js');
const sessions = new Map();
let batchSequence = 0;

self.addEventListener('message', event => {
    const message = event.data || {};
    if (!message.command) {
        const { id, params } = message;
        if (id === undefined || id === null) return;
        try { self.postMessage({ id, result: SolverCore.solve(params) }); }
        catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
        return;
    }
    const key = `${message.session_id}:${message.input_revision}`;
    let entry = sessions.get(key);
    if (message.command === 'ack') {
        const pending = entry?.acknowledgements.get(message.batch_id);
        if (!pending) return;
        entry.acknowledgements.delete(message.batch_id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve();
        return;
    }
    if (message.command === 'dispose') {
        entry?.client.dispose();
        entry?.acknowledgements.forEach(pending => pending.resolve());
        sessions.delete(key);
        return;
    }
    if (message.command === 'pause') {
        entry?.client.pause();
        return;
    }
    if (message.command !== 'start' && message.command !== 'resume') return;
    try {
        if (!entry) {
            entry = { acknowledgements: new Map(), running: null };
            const current = entry;
            current.client = SolverRunner.createLocal(message.params, {
                checkpoint: message.checkpoint,
                runBudgetMs: message.run_budget_ms,
                onBatch: batch => new Promise((resolve, reject) => {
                    const batchId = ++batchSequence;
                    current.acknowledgements.set(batchId, { resolve, reject });
                    self.postMessage({ ...batch, type: 'batch', batch_id: batchId });
                }),
                onProgress: progress => self.postMessage({ ...progress, type: 'progress' }),
            });
            sessions.set(key, current);
        }
        if (entry.running) return;
        const current = entry;
        current.running = current.client.resume().then(result => {
            if (sessions.get(key) === current) self.postMessage({ ...result, type: 'terminal' });
        }).finally(() => { current.running = null; });
    } catch (error) {
        self.postMessage({ type: 'error', session_id: message.session_id, input_revision: message.input_revision,
            error: error instanceof Error ? error.message : String(error) });
    }
});
