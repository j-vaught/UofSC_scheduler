'use strict';

const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const {
    StaticDataStore,
    normalizeCourseCode,
    professorPrefix,
    nextAcademicTerm,
} = require('../static/js/data-store.js');

function jsonRecord(value) {
    const text = JSON.stringify(value);
    return {
        text,
        bytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'),
    };
}

function response(text, status = 200) {
    return new Response(text, {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

class MemoryCache {
    constructor() {
        this.records = new Map();
    }

    async match(key) {
        const stored = this.records.get(String(key));
        return stored ? stored.clone() : undefined;
    }

    async put(key, value) {
        this.records.set(String(key), value.clone());
    }

    async delete(key) {
        return this.records.delete(String(key));
    }
}

class MemoryCacheStorage {
    constructor() {
        this.caches = new Map();
    }

    async open(name) {
        if (!this.caches.has(name)) this.caches.set(name, new MemoryCache());
        return this.caches.get(name);
    }

    async delete(name) {
        return this.caches.delete(name);
    }

    async keys() {
        return [...this.caches.keys()];
    }
}

function fixture() {
    const grades = jsonRecord({
        schema_version: 1,
        courses: { 'CSCE 145': { average_gpa: 3.1 } },
    });
    const history = jsonRecord({
        schema_version: 1,
        coverage: {
            complete_terms: ['202601'],
            incomplete_terms: [{ term: '202605', reason: 'source timeout' }],
            last_complete_term: '202601',
        },
        courses: { 'CSCE 145': { terms: [{ term: '202601', offered: true }] } },
    });
    const professor = jsonRecord({
        schema_version: 1,
        professors: { prof_a123: { name: 'Faculty, Example' } },
    });
    const manifest = {
        schema_version: 1,
        release_id: 'test-release',
        artifacts: {
            'grades/courses/CSCE': {
                url: 'releases/test-release/grades-CSCE.1234.json',
                bytes: grades.bytes,
                sha256: grades.sha256,
            },
            'grades/professors/a': {
                url: 'releases/test-release/professors-a.1234.json',
                bytes: professor.bytes,
                sha256: professor.sha256,
            },
            'history/CSCE': {
                url: 'releases/test-release/history-CSCE.1234.json',
                bytes: history.bytes,
                sha256: history.sha256,
            },
        },
    };
    return { grades, history, professor, manifest };
}

async function run() {
    assert.equal(normalizeCourseCode('csce145'), 'CSCE 145');
    assert.equal(normalizeCourseCode(' MATH   141 '), 'MATH 141');
    assert.equal(professorPrefix('prof_a123'), 'a');
    assert.equal(nextAcademicTerm('202608'), '202701');

    const values = fixture();
    const manifestUrl = 'https://scheduler.example/static/data/manifest.json';
    const urls = {
        [manifestUrl]: JSON.stringify(values.manifest),
        'https://scheduler.example/static/data/releases/test-release/grades-CSCE.1234.json':
            values.grades.text,
        'https://scheduler.example/static/data/releases/test-release/professors-a.1234.json':
            values.professor.text,
        'https://scheduler.example/static/data/releases/test-release/history-CSCE.1234.json':
            values.history.text,
    };
    const calls = [];
    const cacheStorage = new MemoryCacheStorage();
    const fetchImpl = async url => {
        calls.push(String(url));
        const body = urls[String(url)];
        return body === undefined ? response('{}', 404) : response(body);
    };
    const store = new StaticDataStore({
        manifestUrl,
        fetchImpl,
        cacheStorage,
        indexedDB: null,
        cryptoImpl: webcrypto,
    });

    assert.deepEqual(await store.getCourseGrades('csce145'), { average_gpa: 3.1 });
    assert.deepEqual(await store.getCourseGrades('CSCE 145'), { average_gpa: 3.1 });
    const offeringHistory = await store.getOfferingHistory('CSCE145');
    assert.equal(offeringHistory.code, 'CSCE 145');
    assert.equal(offeringHistory.offered_count, 1);
    assert.equal(offeringHistory.as_of_term, '202605');
    assert.deepEqual(offeringHistory.terms, [
        {
            term: '202601',
            offered: true,
            label: 'Spring 2026',
            available: true,
            complete: true,
        },
        {
            term: '202605',
            label: 'Summer 2026',
            available: false,
            complete: false,
            error: true,
            error_reason: 'source timeout',
        },
    ]);
    assert.deepEqual(
        await store.getProfessorGrades('prof_a123'),
        { name: 'Faculty, Example' },
    );
    assert.equal(calls.filter(url => url === manifestUrl).length, 1);
    assert.equal(calls.filter(url => url.includes('grades-CSCE')).length, 1);

    const offlineStore = new StaticDataStore({
        manifestUrl,
        fetchImpl: async () => { throw new Error('offline'); },
        cacheStorage,
        indexedDB: null,
        cryptoImpl: webcrypto,
    });
    assert.equal((await offlineStore.getManifest()).release_id, 'test-release');
    assert.deepEqual(await offlineStore.getCourseGrades('CSCE 145'), { average_gpa: 3.1 });

    const corruptCache = new MemoryCacheStorage();
    const corruptArtifactCache = await corruptCache.open(
        'course-scheduler-data-artifacts-v1-test-release',
    );
    const gradeUrl = Object.keys(urls).find(url => url.includes('grades-CSCE'));
    await corruptArtifactCache.put(gradeUrl, response('{"corrupt":true}'));
    let artifactCalls = 0;
    const repairStore = new StaticDataStore({
        manifestUrl,
        fetchImpl: async url => {
            const key = String(url);
            if (key.includes('grades-CSCE')) artifactCalls += 1;
            return response(urls[key]);
        },
        cacheStorage: corruptCache,
        indexedDB: null,
        cryptoImpl: webcrypto,
    });
    assert.deepEqual(await repairStore.getCourseGrades('CSCE 145'), { average_gpa: 3.1 });
    assert.equal(artifactCalls, 1, 'a corrupt cached artifact should be fetched again');

    const progress = [];
    const prefetched = await store.prefetch([
        'grades/courses/CSCE',
        'history/CSCE',
        'missing',
    ], { concurrency: 2, onProgress: item => progress.push(item) });
    assert.equal(prefetched.total, 3);
    assert.equal(prefetched.completed, 3);
    assert.ok(prefetched.failures.missing instanceof Error);
    assert.equal(progress.length, 3);
    assert.equal(store.status().releaseId, 'test-release');

    const noIntegrityStore = new StaticDataStore({
        manifestUrl,
        fetchImpl,
        cacheStorage: new MemoryCacheStorage(),
        indexedDB: null,
        cryptoImpl: null,
    });
    await assert.rejects(
        () => noIntegrityStore.getCourseGrades('CSCE 145'),
        /integrity validation is unavailable/,
    );

    console.log('data store tests passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
