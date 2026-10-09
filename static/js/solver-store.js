/* Local, resumable schedule results and immutable ranking snapshots. */
(function exposeSolverStore(global) {
    'use strict';

    const DATABASE = 'course-scheduler-solver-sessions-v1';
    const MEMORY_LIMIT = 32 * 1024 * 1024;
    const SORTS = new Set(['best', 'days', 'walking', 'gaps', 'later', 'gpa', 'online']);
    const temporarySessions = new Map();
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const bytes = value => JSON.stringify(value).length * 2 + 128;
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const identifier = () => global.crypto?.randomUUID?.()
        || `solver-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    class SolverStorageError extends Error {
        constructor(message, cause) {
            super(message);
            this.name = 'SolverStorageError';
            if (cause) this.cause = cause;
        }
    }

    function storageError(error) {
        return error instanceof SolverStorageError ? error
            : new SolverStorageError('Schedule storage could not save this progress. Free local storage before continuing.', error);
    }

    function completeness(metric) {
        if (!metric || !Number.isFinite(metric.value)) return 2;
        return metric.completeness === 'complete' ? 0
            : metric.completeness === 'partial' ? 1 : 2;
    }

    function sortComponents(result, sort) {
        const metrics = result.metrics || {};
        let quality = 0;
        let value = 0;
        if (sort === 'walking' || sort === 'gpa') {
            const metric = metrics[sort];
            quality = completeness(metric);
            value = quality === 2 ? 0 : metric.value * (sort === 'gpa' ? -1 : 1);
        } else if (sort !== 'best') {
            const field = { days: 'campusDays', gaps: 'gaps', later: 'laterStart', online: 'online' }[sort];
            const metric = metrics[field];
            quality = Number.isFinite(metric) ? 0 : 2;
            if (sort === 'days' && quality !== 2) {
                quality = metrics.campusDaysCompleteness === 'partial' ? 1
                    : metrics.campusDaysCompleteness === 'missing' ? 2 : 0;
            }
            value = quality === 2 ? 0 : metric * (sort === 'later' || sort === 'online' ? -1 : 1);
        }
        return [quality, value, -(Number.isFinite(result.score) ? result.score : 0), String(result.id)];
    }

    function compareResults(a, b, sort = 'best') {
        const left = sortComponents(a, sort);
        const right = sortComponents(b, sort);
        for (let index = 0; index < left.length; index += 1) {
            if (left[index] < right[index]) return -1;
            if (left[index] > right[index]) return 1;
        }
        return 0;
    }

    function resultRow(result, session) {
        if (!result || !result.id || !Number.isInteger(result.ordinal) || result.ordinal < 1
            || !Array.isArray(result.refs) || result.refs.some(ref => !Array.isArray(ref)
                || ref.length !== 2 || ref.some(index => !Number.isInteger(index) || index < 0))) {
            throw new TypeError('Schedule results require an identity, discovery ordinal, and section references.');
        }
        return {
            session_id: session,
            id: String(result.id),
            ordinal: result.ordinal,
            ordinal_key: [session, result.ordinal, String(result.id)],
            refs: copy(result.refs),
            score: Number.isFinite(result.score) ? result.score : 0,
            metrics: copy(result.metrics || {}),
            metrics_ready_counted: result.metrics?.ready === true,
        };
    }

    function publicResult(row) {
        if (!row) return null;
        return copy({ id: row.id, ordinal: row.ordinal, refs: row.refs, score: row.score, metrics: row.metrics });
    }

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function transactionDone(transaction) {
        const completion = new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onabort = () => reject(transaction.error || new Error('Storage transaction aborted.'));
            transaction.onerror = () => { /* Abort carries the final transaction error. */ };
        });
        // A failed request can reject before its transaction aborts. The caller still
        // receives the rejection, but this avoids a second unhandled rejection.
        completion.catch(() => {});
        return completion;
    }

    function prefixRange(prefix) {
        return global.IDBKeyRange.bound(prefix, [...prefix, []]);
    }

    function deleteByIndex(store, index, range) {
        return new Promise((resolve, reject) => {
            const request = store.index(index).openCursor(range);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return resolve();
                cursor.delete();
                cursor.continue();
            };
        });
    }

    async function database(indexedDB) {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('sessions', { keyPath: 'term' });
            const results = db.createObjectStore('results', { keyPath: ['session_id', 'id'] });
            results.createIndex('session', 'session_id');
            results.createIndex('ordinal', 'ordinal_key');
            const snapshots = db.createObjectStore('snapshots', { keyPath: ['session_id', 'snapshot', 'id'] });
            snapshots.createIndex('session', 'session_id');
            snapshots.createIndex('snapshot', ['session_id', 'snapshot']);
            snapshots.createIndex('ranking', 'order');
        };
        return requestResult(request);
    }

    function initialMeta(term, inputRevision, params) {
        return {
            term: String(term), session_id: identifier(), input_revision: String(inputRevision),
            params: copy(params), total_found: 0, metrics_ready: 0, state: 'ready', stop_reason: null,
            checkpoint: null, revision: 0, publishedRevision: -1, publishedSort: 'best',
            publishedCount: 0, publishedSnapshot: null,
        };
    }

    class SessionStore {
        constructor(meta, db, memory, limit) {
            this.meta = memory ? memory.meta : meta;
            this.persistent = !!db;
            this._db = db;
            this._memory = memory;
            this._limit = limit;
            this._queue = Promise.resolve();
            this._closed = false;
        }

        _locked(operation) {
            const pending = this._queue.then(() => {
                if (this._closed) throw new SolverStorageError('This schedule session is closed.');
                return operation();
            });
            this._queue = pending.catch(() => {});
            return pending;
        }

        _memoryBytes(meta = this.meta) {
            // Catalogs can be large; their size is computed once for the session.
            const { params, ...metadata } = meta;
            return bytes(metadata) + this._memory.catalogBytes
                + this._memory.resultBytes + this._memory.snapshotBytes;
        }

        _checkMemory(meta, additionalBytes = 0) {
            if (this._memoryBytes(meta) + additionalBytes > this._limit) {
                throw new SolverStorageError('Temporary schedule storage reached its 32 MiB limit. Progress is paused.');
            }
        }

        _assertBatch(batch) {
            if ((batch.session_id && batch.session_id !== this.meta.session_id)
                || (batch.input_revision !== undefined && String(batch.input_revision) !== this.meta.input_revision)) {
                throw new SolverStorageError('This progress belongs to a different schedule session.');
            }
        }

        _advanceMeta(meta, batch, added, ready = 0) {
            const next = { ...meta, total_found: meta.total_found + added,
                metrics_ready: (meta.metrics_ready || 0) + ready,
                revision: meta.revision + (added ? 1 : 0) };
            if (Object.hasOwn(batch, 'checkpoint')) next.checkpoint = copy(batch.checkpoint);
            if (Object.hasOwn(batch, 'state')) next.state = batch.state;
            if (Object.hasOwn(batch, 'stop_reason')) next.stop_reason = batch.stop_reason;
            return next;
        }

        commitBatch(batch) {
            return this._locked(async () => {
                this._assertBatch(batch);
                const rows = (batch.results || []).map(result => resultRow(result, this.meta.session_id));
                if (!this.persistent) {
                    const additions = new Map();
                    let addedBytes = 0;
                    let ready = 0;
                    for (const row of rows) if (!this._memory.results.has(row.id) && !additions.has(row.id)) {
                        additions.set(row.id, row);
                        addedBytes += bytes(row);
                        if (row.metrics_ready_counted) ready += 1;
                    }
                    const next = this._advanceMeta(this.meta, batch, additions.size, ready);
                    this._checkMemory(next, addedBytes);
                    for (const [id, row] of additions) this._memory.results.set(id, row);
                    this._memory.resultBytes += addedBytes;
                    this._memory.meta = next;
                    this.meta = next;
                    return copy(next);
                }
                try {
                    const transaction = this._db.transaction(['sessions', 'results'], 'readwrite');
                    const done = transactionDone(transaction);
                    const sessions = transaction.objectStore('sessions');
                    const results = transaction.objectStore('results');
                    const current = await requestResult(sessions.get(this.meta.term));
                    if (current?.session_id !== this.meta.session_id) {
                        transaction.abort();
                        await done.catch(() => {});
                        throw new SolverStorageError('The schedule inputs changed in another window. Generate again.');
                    }
                    let added = 0;
                    let ready = 0;
                    for (const row of rows) if (!await requestResult(results.get([row.session_id, row.id]))) {
                        results.put(row);
                        added += 1;
                        if (row.metrics_ready_counted) ready += 1;
                    }
                    const next = this._advanceMeta(current, batch, added, ready);
                    sessions.put(next);
                    await done;
                    this.meta = next;
                    return copy(next);
                } catch (error) { throw storageError(error); }
            });
        }

        setState(state, stopReason = null) {
            return this.commitBatch({ results: [], state, stop_reason: stopReason });
        }

        updateMetrics(id, metrics) {
            return this._locked(async () => {
                if (!this.persistent) {
                    const current = this._memory.results.get(String(id));
                    if (!current) return null;
                    const row = { ...current, metrics: { ...current.metrics, ...copy(metrics) } };
                    const becameReady = row.metrics.ready === true && !current.metrics_ready_counted;
                    row.metrics_ready_counted = !!current.metrics_ready_counted || becameReady;
                    if (JSON.stringify(row.metrics) === JSON.stringify(current.metrics)) return publicResult(current);
                    const next = { ...this.meta, revision: this.meta.revision + 1,
                        metrics_ready: (this.meta.metrics_ready || 0) + (becameReady ? 1 : 0) };
                    const additionalBytes = bytes(row) - bytes(current);
                    this._checkMemory(next, additionalBytes);
                    this._memory.results.set(row.id, row);
                    this._memory.resultBytes += additionalBytes;
                    this._memory.meta = next;
                    this.meta = next;
                    return publicResult(row);
                }
                try {
                    const transaction = this._db.transaction(['sessions', 'results'], 'readwrite');
                    const done = transactionDone(transaction);
                    const rows = transaction.objectStore('results');
                    const current = await requestResult(rows.get([this.meta.session_id, String(id)]));
                    if (!current) { await done; return null; }
                    const row = { ...current, metrics: { ...current.metrics, ...copy(metrics) } };
                    const becameReady = row.metrics.ready === true && !current.metrics_ready_counted;
                    row.metrics_ready_counted = !!current.metrics_ready_counted || becameReady;
                    if (JSON.stringify(row.metrics) === JSON.stringify(current.metrics)) { await done; return publicResult(current); }
                    const sessions = transaction.objectStore('sessions');
                    const currentMeta = await requestResult(sessions.get(this.meta.term));
                    if (currentMeta?.session_id !== this.meta.session_id) {
                        transaction.abort();
                        await done.catch(() => {});
                        throw new SolverStorageError('The schedule inputs changed in another window. Generate again.');
                    }
                    const next = { ...currentMeta, revision: currentMeta.revision + 1,
                        metrics_ready: (currentMeta.metrics_ready || 0) + (becameReady ? 1 : 0) };
                    rows.put(row);
                    sessions.put(next);
                    await done;
                    this.meta = next;
                    return publicResult(row);
                } catch (error) { throw storageError(error); }
            });
        }

        async _readChunk(lastKey, limit) {
            const transaction = this._db.transaction('results', 'readonly');
            const done = transactionDone(transaction);
            const range = lastKey
                ? global.IDBKeyRange.bound(lastKey, [this.meta.session_id, []], true)
                : prefixRange([this.meta.session_id]);
            const rows = await new Promise((resolve, reject) => {
                const output = [];
                const request = transaction.objectStore('results').index('ordinal').openCursor(range);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor || output.length === limit) return resolve(output);
                    output.push(cursor.value);
                    cursor.continue();
                };
            });
            await done;
            return rows;
        }

        async iterateResults(callback, batchSize = 250) {
            const limit = Math.max(1, Math.min(1000, Math.floor(batchSize)));
            // No lock spans the callback: callers can enrich rows with updateMetrics().
            const upperOrdinal = this.meta.total_found;
            if (!this.persistent) {
                const iterator = this._memory.results.values();
                let finished = false;
                while (true) {
                    const rows = [];
                    while (rows.length < limit) {
                        const entry = iterator.next();
                        if (entry.done || entry.value.ordinal > upperOrdinal) { finished = true; break; }
                        rows.push(publicResult(entry.value));
                    }
                    if (!rows.length) return;
                    await callback(rows);
                    if (finished) return;
                    await tick();
                }
            }
            let lastKey = null;
            while (true) {
                const rows = await this._readChunk(lastKey, limit);
                const included = rows.filter(row => row.ordinal <= upperOrdinal);
                if (!included.length) return;
                await callback(included.map(publicResult));
                lastKey = included[included.length - 1].ordinal_key;
                if (rows.length < limit || included.length < rows.length) return;
                await tick();
            }
        }

        getResult(id) {
            return this._locked(async () => {
                if (!this.persistent) return publicResult(this._memory.results.get(String(id)));
                const transaction = this._db.transaction('results', 'readonly');
                const done = transactionDone(transaction);
                const row = await requestResult(transaction.objectStore('results').get([this.meta.session_id, String(id)]));
                await done;
                return publicResult(row);
            });
        }

        async _deleteSnapshot(snapshot) {
            if (!snapshot) return;
            const transaction = this._db.transaction('snapshots', 'readwrite');
            const done = transactionDone(transaction);
            await deleteByIndex(transaction.objectStore('snapshots'), 'snapshot',
                global.IDBKeyRange.only([this.meta.session_id, snapshot]));
            await done;
        }

        publish(sort = 'best') {
            return this._locked(async () => {
                if (!SORTS.has(sort)) throw new TypeError('Unknown schedule ordering.');
                const snapshot = identifier();
                const next = { ...this.meta, publishedRevision: this.meta.revision,
                    publishedSort: sort, publishedCount: this.meta.total_found, publishedSnapshot: snapshot };
                if (!this.persistent) {
                    // Reserve space before allocating the additional immutable copy.
                    let snapshotBytes = 0;
                    for (const row of this._memory.results.values()) snapshotBytes += bytes(publicResult(row));
                    this._checkMemory(next, snapshotBytes);
                    const rows = Array.from(this._memory.results.values(), publicResult);
                    rows.sort((a, b) => compareResults(a, b, sort));
                    this._memory.snapshots = new Map([[snapshot, rows]]);
                    this._memory.snapshotBytes = snapshotBytes;
                    this._memory.meta = next;
                    this.meta = next;
                    return copy(next);
                }
                let lastKey = null;
                let count = 0;
                try {
                    while (true) {
                        const rows = await this._readChunk(lastKey, 250);
                        if (!rows.length) break;
                        const transaction = this._db.transaction('snapshots', 'readwrite');
                        const done = transactionDone(transaction);
                        const snapshots = transaction.objectStore('snapshots');
                        for (const row of rows) {
                            snapshots.put({ ...publicResult(row), session_id: this.meta.session_id, snapshot,
                                order: [this.meta.session_id, snapshot, ...sortComponents(row, sort)] });
                        }
                        await done;
                        count += rows.length;
                        lastKey = rows[rows.length - 1].ordinal_key;
                        await tick();
                    }
                    const oldSnapshot = this.meta.publishedSnapshot;
                    const transaction = this._db.transaction('sessions', 'readwrite');
                    const done = transactionDone(transaction);
                    const sessions = transaction.objectStore('sessions');
                    const current = await requestResult(sessions.get(this.meta.term));
                    if (current?.session_id !== this.meta.session_id || current.revision !== next.publishedRevision) {
                        transaction.abort();
                        await done.catch(() => {});
                        throw new SolverStorageError('The schedule session changed while preparing results. Update results again.');
                    }
                    next.publishedCount = count;
                    sessions.put(next);
                    await done;
                    this.meta = next;
                    await this._deleteSnapshot(oldSnapshot).catch(() => {});
                    return copy(next);
                } catch (error) {
                    await this._deleteSnapshot(snapshot).catch(() => {});
                    throw storageError(error);
                }
            });
        }

        page(offset = 0, limit = 10) {
            return this._locked(async () => {
                const start = Math.max(0, Math.floor(offset) || 0);
                const size = Math.max(1, Math.min(1000, Math.floor(limit) || 10));
                let results = [];
                if (this.meta.publishedSnapshot && !this.persistent) {
                    results = copy((this._memory.snapshots.get(this.meta.publishedSnapshot) || []).slice(start, start + size));
                } else if (this.meta.publishedSnapshot) {
                    const transaction = this._db.transaction('snapshots', 'readonly');
                    const done = transactionDone(transaction);
                    results = await new Promise((resolve, reject) => {
                        const output = [];
                        let skipped = false;
                        const request = transaction.objectStore('snapshots').index('ranking')
                            .openCursor(prefixRange([this.meta.session_id, this.meta.publishedSnapshot]));
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => {
                            const cursor = request.result;
                            if (!cursor || output.length === size) return resolve(output);
                            if (start && !skipped) { skipped = true; cursor.advance(start); return; }
                            output.push(publicResult(cursor.value));
                            cursor.continue();
                        };
                    });
                    await done;
                }
                return { results, total: this.meta.publishedCount, offset: start,
                    sort: this.meta.publishedSort, revision: this.meta.publishedRevision };
            });
        }

        close() {
            return this._locked(() => { this._closed = true; this._db?.close(); });
        }

        dispose() { return this.close(); }
    }

    async function open(options) {
        const { term, inputRevision, params } = options || {};
        if (!term || inputRevision === undefined) throw new TypeError('A term and input revision are required.');
        const indexedDB = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : global.indexedDB;
        const limit = options.memoryLimitBytes ?? MEMORY_LIMIT;
        let db = null;
        if (indexedDB) {
            try { db = await database(indexedDB); } catch (_) { /* Denied local storage uses a bounded temporary session. */ }
        }
        if (!db) {
            let memory = temporarySessions.get(String(term));
            if (!memory || memory.meta.input_revision !== String(inputRevision)) {
                memory = { meta: initialMeta(term, inputRevision, params), results: new Map(), snapshots: new Map(),
                    catalogBytes: bytes(params || {}), resultBytes: 0, snapshotBytes: 0 };
            }
            const store = new SessionStore(memory.meta, null, memory, limit);
            if (!Number.isInteger(memory.meta.metrics_ready)) {
                let ready = 0;
                let additionalBytes = 0;
                const updates = [];
                for (const row of memory.results.values()) {
                    if (row.metrics_ready_counted || row.metrics?.ready === true) {
                        ready += 1;
                        if (!row.metrics_ready_counted) {
                            const updated = { ...row, metrics_ready_counted: true };
                            additionalBytes += bytes(updated) - bytes(row);
                            updates.push(updated);
                        }
                    }
                }
                const next = { ...memory.meta, metrics_ready: ready };
                store._checkMemory(next, additionalBytes);
                for (const row of updates) memory.results.set(row.id, row);
                memory.resultBytes += additionalBytes;
                memory.meta = next;
                store.meta = next;
            }
            store._checkMemory(memory.meta);
            temporarySessions.set(String(term), memory);
            return store;
        }
        try {
            const transaction = db.transaction(['sessions', 'results', 'snapshots'], 'readwrite');
            const done = transactionDone(transaction);
            const sessions = transaction.objectStore('sessions');
            let meta = await requestResult(sessions.get(String(term)));
            if (!meta || meta.input_revision !== String(inputRevision)) {
                if (meta) await Promise.all([
                    deleteByIndex(transaction.objectStore('results'), 'session', global.IDBKeyRange.only(meta.session_id)),
                    deleteByIndex(transaction.objectStore('snapshots'), 'session', global.IDBKeyRange.only(meta.session_id)),
                ]);
                meta = initialMeta(term, inputRevision, params);
                sessions.put(meta);
            } else {
                if (!Number.isInteger(meta.metrics_ready)) {
                    // Sessions written before readiness counts were introduced retain
                    // their checkpoint and published snapshot during this migration.
                    let ready = 0;
                    const request = transaction.objectStore('results').index('session')
                        .openCursor(global.IDBKeyRange.only(meta.session_id));
                    await new Promise((resolve, reject) => {
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => {
                            const cursor = request.result;
                            if (!cursor) return resolve();
                            const row = cursor.value;
                            if (row.metrics_ready_counted || row.metrics?.ready === true) {
                                ready += 1;
                                if (!row.metrics_ready_counted) cursor.update({ ...row, metrics_ready_counted: true });
                            }
                            cursor.continue();
                        };
                    });
                    meta = { ...meta, metrics_ready: ready };
                    sessions.put(meta);
                }
                // Interrupted snapshot builds are never activated and can be discarded on reopening.
                const request = transaction.objectStore('snapshots').index('session')
                    .openCursor(global.IDBKeyRange.only(meta.session_id));
                await new Promise((resolve, reject) => {
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => {
                        const cursor = request.result;
                        if (!cursor) return resolve();
                        if (cursor.value.snapshot !== meta.publishedSnapshot) cursor.delete();
                        cursor.continue();
                    };
                });
            }
            await done;
            return new SessionStore(meta, db, null, limit);
        } catch (error) { db.close(); throw storageError(error); }
    }

    const SolverStore = { open, compareResults, sortComponents, SolverStorageError, DATABASE, MEMORY_LIMIT };
    if (typeof module !== 'undefined' && module.exports) module.exports = SolverStore;
    global.SolverStore = SolverStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
