const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadSearch(contextValues = {}) {
    const context = vm.createContext({ ...contextValues });
    const source = `${fs.readFileSync('static/js/search.js', 'utf8')}\nglobalThis.__result = Search;`;
    vm.runInContext(source, context);
    return context.__result;
}

function configureSemanticFixture(search, { localCourses = 0 } = {}) {
    const extractor = async values => {
        const count = Array.isArray(values) ? values.length : 1;
        return { data: new Float32Array(count).fill(1) };
    };
    search._searchId = 1;
    search._loadExtractor = async () => extractor;
    search._loadPhraseData = async () => {};
    search._embedQuery = async () => new Float32Array([1]);
    search._findNearestPhrases = () => Array.from(
        { length: 19 },
        (_, index) => ({ phrase: `generated ${index + 1}`, sim: 0.9 - index / 100 }),
    );
    search._courseEmbeddings = {
        courses: Array.from({ length: localCourses }, (_, index) => ({
            code: `LOCAL ${500 + index}`,
            title: `Local course ${index + 1}`,
            key: String(index + 1),
        })),
    };
    search._courseVecs = Array.from(
        { length: localCourses },
        () => new Float32Array([1]),
    );
    search._pcaParams = { mean: [0], components: [[1]], dims: 1 };
}

test('ordinary semantic searches never exceed the six-request shared budget', async () => {
    let keywordCalls = 0;
    let subjectCalls = 0;
    const search = loadSearch({
        API: {
            async post() {
                keywordCalls += 1;
                return {
                    results: [{
                        code: `TEST ${500 + keywordCalls}`,
                        title: `Result ${keywordCalls}`,
                    }],
                };
            },
            async searchCourses(_term, criteria) {
                subjectCalls += 1;
                const subject = criteria.find(item => item.field === 'subject')?.value || 'TEST';
                return { results: [{ code: `${subject} 500`, crn: String(subjectCalls) }] };
            },
        },
        State: { term: '202608' },
        console,
    });
    configureSemanticFixture(search);

    const semantic = await search._doSemanticSearch(
        'machine learning',
        false,
        false,
        1,
    );
    const hydration = await search._fetchSemanticLiveSubjects(
        ['TEST', 'MATH', 'CSCE', 'EMCH'],
        1,
        semantic.requestBudget,
    );

    assert.equal(keywordCalls, 4);
    assert.equal(subjectCalls, 2);
    assert.equal(keywordCalls + subjectCalls, 6);
    assert.equal(semantic.requestBudget.totalLimit, 6);
    assert.deepEqual(Array.from(hydration.subjects), ['TEST', 'MATH']);
});

test('a strong local catalog shortlist stops keyword expansion after one batch', async () => {
    let calls = 0;
    const search = loadSearch({
        API: {
            async post() {
                calls += 1;
                return { results: [{ code: 'LIVE 500', title: 'Live result' }] };
            },
        },
        State: { term: '202608' },
        console,
    });
    configureSemanticFixture(search, { localCourses: 18 });

    const result = await search._doSemanticSearch('data analysis', false, false, 1);

    assert.equal(calls, 2);
    assert.equal(result.requestBudget.keywordUsed, 2);
    assert.equal(result.results.length > 10, true);
});

test('scoped semantic searches use a larger but bounded ten-request plan', async () => {
    let keywordCalls = 0;
    let subjectCalls = 0;
    const search = loadSearch({
        API: {
            async post() {
                keywordCalls += 1;
                return {
                    results: [{
                        code: `CSCE ${500 + keywordCalls}`,
                        title: `Scoped result ${keywordCalls}`,
                    }],
                };
            },
            async searchCourses(_term, criteria) {
                subjectCalls += 1;
                const subject = criteria.find(item => item.field === 'subject').value;
                return { results: [{ code: `${subject} 585`, crn: String(subjectCalls) }] };
            },
        },
        State: { term: '202608' },
        console,
    });
    configureSemanticFixture(search);
    const scope = search.buildCourseScope('CSCE MATH EMCH STAT', '500+');

    const semantic = await search._doSemanticSearch(
        'machine learning',
        false,
        false,
        1,
        scope,
    );
    const hydration = await search._fetchSemanticLiveSubjects(
        search._semanticSubjectPlan(semantic.results, scope),
        1,
        semantic.requestBudget,
    );

    assert.equal(keywordCalls, 6);
    assert.equal(subjectCalls, 4);
    assert.equal(keywordCalls + subjectCalls, 10);
    assert.equal(semantic.requestBudget.totalLimit, 10);
    assert.equal(hydration.subjects.length, 4);
});

test('a superseding search prevents later semantic keyword batches', async () => {
    let calls = 0;
    const resolvers = [];
    const search = loadSearch({
        API: {
            post() {
                calls += 1;
                return new Promise(resolve => resolvers.push(resolve));
            },
        },
        State: { term: '202608' },
        console,
    });
    configureSemanticFixture(search);

    const pending = search._doSemanticSearch('machine learning', false, false, 1);
    while (resolvers.length < 2) await new Promise(resolve => setImmediate(resolve));
    search._searchId = 2;
    resolvers.forEach(resolve => resolve({ results: [] }));

    assert.equal(await pending, null);
    assert.equal(calls, 2);
});

test('a superseding search prevents later live-subject batches', async () => {
    let calls = 0;
    const resolvers = [];
    const search = loadSearch({
        API: {
            searchCourses() {
                calls += 1;
                return new Promise(resolve => resolvers.push(resolve));
            },
        },
        State: { term: '202608' },
        console,
    });
    search._searchId = 1;
    const budget = {
        ...search._semanticRequestBudget({ active: true }),
        keywordUsed: 6,
    };

    const pending = search._fetchSemanticLiveSubjects(
        ['CSCE', 'MATH', 'EMCH', 'STAT'],
        1,
        budget,
    );
    while (resolvers.length < 2) await new Promise(resolve => setImmediate(resolve));
    search._searchId = 2;
    resolvers.forEach(resolve => resolve({ results: [] }));
    const result = await pending;

    assert.equal(result.stale, true);
    assert.equal(calls, 2);
});
