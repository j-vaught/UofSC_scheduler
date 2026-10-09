const assert = require('node:assert/strict');
const test = require('node:test');
const SolverStore = require('../static/js/solver-store.js');

let term = 900000;
function open(overrides = {}) {
    return SolverStore.open({ term: String(term++), inputRevision: 'catalog-v1',
        params: { courses: [{ code: 'TEST 101', sections: [{ crn: '1', hours: 3 }] }] },
        indexedDB: null, ...overrides });
}

function row(id, ordinal, score, metrics = {}) {
    return { id, ordinal, score, refs: [[0, 0]], metrics };
}

const complete = value => ({ value, completeness: 'complete' });
const partial = value => ({ value, completeness: 'partial', issues: ['Missing history.'] });

test('temporary sessions commit checkpoints and deduplicate stable schedule identities', async () => {
    const store = await open();
    assert.equal(store.persistent, false);
    const checkpoint = { stack: [{ selected: 0 }], visited: 3 };
    await store.commitBatch({ results: [row('a', 1, 5), row('a', 1, 5)], checkpoint, state: 'paused', stop_reason: 'budget' });
    checkpoint.stack[0].selected = 99;
    assert.equal(store.meta.total_found, 1);
    assert.equal(store.meta.checkpoint.stack[0].selected, 0);
    assert.equal(store.meta.stop_reason, 'budget');
    await store.commitBatch({ results: [row('a', 1, 5)], checkpoint: { visited: 4 } });
    assert.equal(store.meta.total_found, 1);
    assert.deepEqual(store.meta.checkpoint, { visited: 4 });
    const result = await store.getResult('a');
    assert.deepEqual(result.refs, [[0, 0]]);
    assert.deepEqual(Object.keys(result).sort(), ['id', 'metrics', 'ordinal', 'refs', 'score']);
    result.refs[0][0] = 77;
    assert.deepEqual((await store.getResult('a')).refs, [[0, 0]]);
});

test('all seven rankings use complete values first, preference ties, then stable identity', async () => {
    const rows = [
        row('a', 1, 10, { campusDays: 4, gaps: 100, laterStart: 540, online: 0, walking: complete(2), gpa: complete(3) }),
        row('b', 2, 20, { campusDays: 2, gaps: 50, laterStart: 600, online: 2, walking: complete(1), gpa: complete(3.5) }),
        row('c', 3, 20, { campusDays: 2, gaps: 50, laterStart: 600, online: 2, walking: partial(0.1), gpa: partial(4) }),
        row('d', 4, 25, { campusDays: 1, gaps: 10, laterStart: null, online: 3,
            walking: { value: null, completeness: 'missing' }, gpa: { value: null, completeness: 'missing' } }),
    ];
    const expected = {
        best: ['d', 'b', 'c', 'a'], days: ['d', 'b', 'c', 'a'], walking: ['b', 'a', 'c', 'd'],
        gaps: ['d', 'b', 'c', 'a'], later: ['b', 'c', 'a', 'd'], gpa: ['b', 'a', 'c', 'd'],
        online: ['d', 'b', 'c', 'a'],
    };
    const store = await open();
    await store.commitBatch({ results: rows, checkpoint: {}, state: 'complete' });
    for (const [sort, ids] of Object.entries(expected)) {
        await store.publish(sort);
        const page = await store.page();
        assert.equal(page.sort, sort);
        assert.deepEqual(page.results.map(result => result.id), ids, sort);
        assert.equal(store.meta.state, 'complete');
    }
});

test('published results are immutable until explicitly updated and retain discovery ordinals', async () => {
    const store = await open();
    await store.commitBatch({ results: [row('first', 1, 1), row('second', 2, 2)], checkpoint: { next: 3 } });
    await store.publish('gpa');
    const before = await store.page();
    await store.updateMetrics('first', { gpa: complete(4), grade: { issues: [] }, ready: true });
    await store.commitBatch({ results: [row('third', 3, 3, { gpa: complete(3) })], checkpoint: { next: 4 } });
    assert.deepEqual(await store.page(), before);
    assert.ok(store.meta.revision > store.meta.publishedRevision);
    await store.publish('gpa');
    const after = await store.page();
    assert.deepEqual(after.results.map(result => result.id), ['first', 'third', 'second']);
    assert.deepEqual(after.results.map(result => result.ordinal), [1, 3, 2]);
    assert.equal(after.results[0].metrics.ready, true);
    assert.equal(after.total, 3);
});

test('pagination reaches every published schedule without duplicate or omitted rows', async () => {
    const store = await open();
    const rows = Array.from({ length: 73 }, (_, index) => row(`id-${String(index).padStart(3, '0')}`, index + 1, index));
    await store.commitBatch({ results: rows, checkpoint: { next: 74 }, state: 'complete' });
    await store.publish('best');
    const collected = [];
    for (let offset = 0; offset < 73; offset += 10) {
        const page = await store.page(offset);
        assert.equal(page.offset, offset);
        assert.equal(page.total, 73);
        collected.push(...page.results.map(result => result.id));
    }
    assert.equal(new Set(collected).size, 73);
    assert.deepEqual(collected, rows.toReversed().map(result => result.id));
    assert.deepEqual((await store.page(100)).results, []);
});

test('metric enrichment iterates bounded batches and can update each row without deadlock', async () => {
    const store = await open();
    await store.commitBatch({ results: Array.from({ length: 17 }, (_, index) => row(`id-${index}`, index + 1, index)), checkpoint: {} });
    const batchSizes = [];
    await store.iterateResults(async rows => {
        batchSizes.push(rows.length);
        for (const result of rows) await store.updateMetrics(result.id, { walking: complete(result.ordinal), ready: true });
    }, 5);
    assert.deepEqual(batchSizes, [5, 5, 5, 2]);
    assert.equal((await store.getResult('id-16')).metrics.ready, true);
    const revision = store.meta.revision;
    await store.updateMetrics('id-16', { ready: true });
    assert.equal(store.meta.revision, revision);
    await store.updateMetrics('id-16', { gpa: partial(3.8) });
    assert.deepEqual((await store.getResult('id-16')).metrics.walking, complete(17));
    assert.equal(await store.updateMetrics('absent', { ready: true }), null);
});

test('matching inputs reopen progress while changed inputs replace only that term', async () => {
    const store = await open();
    await store.commitBatch({ results: [row('saved', 1, 1)], checkpoint: { position: 3 }, state: 'paused' });
    await store.publish('online');
    const other = await open();
    await other.commitBatch({ results: [row('unrelated', 1, 4)], checkpoint: {} });
    const sessionId = store.meta.session_id;
    const currentTerm = store.meta.term;
    await store.close();
    const restored = await open({ term: currentTerm, params: { ignored: true } });
    assert.equal(restored.meta.session_id, sessionId);
    assert.deepEqual(restored.meta.checkpoint, { position: 3 });
    assert.ok(restored.meta.params.courses);
    assert.equal((await restored.page()).results[0].id, 'saved');
    const changed = await open({ term: currentTerm, inputRevision: 'catalog-v2' });
    assert.notEqual(changed.meta.session_id, sessionId);
    assert.equal(changed.meta.total_found, 0);
    assert.equal((await other.getResult('unrelated')).id, 'unrelated');
});

test('storage exhaustion rejects an entire batch and preserves the last committed checkpoint', async () => {
    const store = await open({ memoryLimitBytes: 4500 });
    await store.commitBatch({ results: [row('small', 1, 1)], checkpoint: { position: 1 }, state: 'paused' });
    const prior = structuredClone(store.meta);
    await assert.rejects(store.commitBatch({ results: [row('large', 2, 2, { notes: 'x'.repeat(5000) })], checkpoint: { position: 2 }, state: 'complete' }),
        { name: 'SolverStorageError' });
    assert.deepEqual(store.meta, prior);
    assert.equal(await store.getResult('large'), null);
    assert.equal((await store.getResult('small')).id, 'small');
});

test('a failed snapshot retains the prior published page and exposes no partial ordering', async () => {
    const store = await open({ memoryLimitBytes: 2300 });
    await store.commitBatch({ results: [row('a', 1, 1)], checkpoint: {} });
    await store.publish();
    const before = await store.page();
    await store.updateMetrics('a', { extra: 'x'.repeat(220) });
    await assert.rejects(store.publish('online'), { name: 'SolverStorageError' });
    assert.deepEqual(await store.page(), before);
});

test('storage denial uses an explicit bounded temporary session; stale batches are rejected', async () => {
    const store = await open({ indexedDB: { open() { throw new Error('Denied'); } } });
    assert.equal(store.persistent, false);
    await assert.rejects(store.commitBatch({ session_id: 'other', results: [], checkpoint: {} }), { name: 'SolverStorageError' });
    await assert.rejects(store.commitBatch({ input_revision: 'other', results: [] }), { name: 'SolverStorageError' });
    assert.equal(store.meta.total_found, 0);
    await store.setState('paused', 'storage');
    assert.equal(store.meta.state, 'paused');
    assert.equal(store.meta.stop_reason, 'storage');
});

test('invalid rows and orderings fail without changing committed data', async () => {
    const store = await open();
    await assert.rejects(store.commitBatch({ results: [{ id: 'bad', ordinal: 0, refs: [[0, 0]] }], checkpoint: {} }), TypeError);
    await assert.rejects(store.publish('unknown'), TypeError);
    assert.equal(store.meta.total_found, 0);
    await store.close();
    await assert.rejects(store.page(), { name: 'SolverStorageError' });
});

test('concurrent mutations serialize around an immutable publication cutoff', async () => {
    const store = await open();
    await store.commitBatch({ results: [row('first', 1, 1)], checkpoint: { next: 2 } });
    await Promise.all([
        store.publish('gpa'),
        store.commitBatch({ results: [row('second', 2, 2)], checkpoint: { next: 3 } }),
        store.updateMetrics('first', { gpa: complete(3.48001), ready: true }),
    ]);
    const old = await store.page();
    assert.equal(old.total, 1);
    assert.equal(old.results[0].metrics.gpa, undefined);
    assert.equal(store.meta.total_found, 2);
    await store.updateMetrics('second', { gpa: complete(3.48) });
    await store.publish('gpa');
    assert.deepEqual((await store.page()).results.map(result => result.id), ['first', 'second']);
    const revision = store.meta.revision;
    await store.setState('paused', 'user');
    assert.equal(store.meta.revision, revision);
    assert.deepEqual(store.meta.checkpoint, { next: 3 });
});

test('enrichment fixes its initial result boundary while new schedules arrive', async () => {
    const store = await open();
    await store.commitBatch({ results: [row('a', 1, 1), row('b', 2, 2)], checkpoint: {} });
    const visited = [];
    await store.iterateResults(async records => {
        visited.push(...records.map(result => result.id));
        await store.commitBatch({ results: [row('c', 3, 3)], checkpoint: {} });
    }, 1);
    assert.deepEqual(visited, ['a', 'b']);
    assert.equal(store.meta.total_found, 3);
});

test('temporary storage accounts for the original catalog before accepting a session', async () => {
    await assert.rejects(open({ params: { largeCatalog: 'x'.repeat(5000) }, memoryLimitBytes: 4000 }),
        { name: 'SolverStorageError' });
});

test('campus-day ordering ranks complete observations before partial or missing locations', async () => {
    const store = await open();
    await store.commitBatch({ results: [
        row('complete', 1, 1, { campusDays: 3, campusDaysCompleteness: 'complete' }),
        row('legacy', 2, 2, { campusDays: 2 }),
        row('partial', 3, 30, { campusDays: 1, campusDaysCompleteness: 'partial' }),
        row('missing', 4, 40, { campusDays: 0, campusDaysCompleteness: 'missing' }),
    ], checkpoint: {} });
    await store.publish('days');
    assert.deepEqual((await store.page()).results.map(result => result.id),
        ['legacy', 'complete', 'partial', 'missing']);
});

test('metrics-ready progress counts each result once and survives reopening', async () => {
    const store = await open();
    await store.commitBatch({ results: [row('a', 1, 1), row('b', 2, 2, { ready: true })], checkpoint: {} });
    assert.equal(store.meta.metrics_ready, 1);
    await store.updateMetrics('a', { ready: true });
    await store.updateMetrics('a', { ready: true, gpa: complete(3) });
    await store.commitBatch({ results: [row('b', 2, 2, { ready: true })], checkpoint: {} });
    assert.equal(store.meta.metrics_ready, 2);
    const restored = await open({ term: store.meta.term });
    assert.equal(restored.meta.metrics_ready, 2);
    await restored.updateMetrics('a', { walking: complete(2), ready: true });
    assert.equal(restored.meta.metrics_ready, 2);
});

test('legacy sessions recover readiness counts without losing checkpoints or rankings', async () => {
    const store = await open();
    await store.commitBatch({ results: [row('a', 1, 1, { ready: true }), row('b', 2, 2)],
        checkpoint: { next: 3 }, state: 'complete' });
    await store.publish('best');
    const original = await store.page();
    delete store._memory.meta.metrics_ready;
    delete store._memory.results.get('a').metrics_ready_counted;
    const restored = await open({ term: store.meta.term });
    assert.equal(restored.meta.metrics_ready, 1);
    assert.deepEqual(restored.meta.checkpoint, { next: 3 });
    assert.equal(restored.meta.state, 'complete');
    assert.deepEqual(await restored.page(), original);
    await restored.updateMetrics('a', { ready: true, gpa: complete(3.4) });
    assert.equal(restored.meta.metrics_ready, 1);
    await restored.updateMetrics('b', { ready: true });
    assert.equal(restored.meta.metrics_ready, 2);
});
