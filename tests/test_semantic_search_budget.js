const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadSearch(contextValues = {}) {
    const context = vm.createContext({ ...contextValues });
    // Parts first, then the index that merges them, then the composition point.
    const dir = 'static/js/features/search';
    const partFiles = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'index.js').sort();
    const source = `${[
        ...partFiles.map(f => fs.readFileSync(`${dir}/${f}`, 'utf8')),
        fs.readFileSync(`${dir}/index.js`, 'utf8'),
        fs.readFileSync('static/js/search.js', 'utf8'),
    ].join('\n')}\nglobalThis.__result = Search;`;
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
    assert.equal(result.localResultCodes.length, 18);
});

test('search source accounting includes courses supplied by the semantic catalog', () => {
    const search = loadSearch({});
    search.checkEligibility = () => ({ eligible: true });
    const info = search.buildSemanticSearchInfo(
        {
            searches: [
                { term: 'machine learning', count: 0, failed: false },
                { term: 'neural networks', count: 0, failed: false },
            ],
            localResultCodes: ['CSCE 580', 'CSCE 585', 'CSCE 883', 'STAT 515', 'MATH 546'],
        },
        [[], []],
        [
            { code: 'CSCE 580' },
            { code: 'CSCE 585' },
            { code: 'CSCE 883' },
            { code: 'STAT 515' },
            { code: 'MATH 546' },
        ],
        false,
        {},
    );

    assert.equal(info.length, 3);
    assert.equal(info[0].count, 0);
    assert.equal(info[1].count, 0);
    assert.equal(info[2].term, 'Meaning-based catalog matches');
    assert.equal(info[2].kind, 'semantic-catalog');
    assert.equal(info[2].count, 5);

    search.escapeText = value => String(value);
    const markup = search.generatedSearchesMarkup(info);
    assert.match(markup, /3 Search sources/);
    assert.match(markup, /Meaning-based catalog matches/);
    assert.match(markup, /5 courses/);
    assert.equal((markup.match(/data-regular-search-index=/g) || []).length, 2);
});

test('search source accounting excludes batch courses absent from visible results', () => {
    const search = loadSearch({});
    search.checkEligibility = () => ({ eligible: true });
    const info = search.buildSemanticSearchInfo(
        {
            searches: [{ term: 'machine learning', count: 3, failed: false }],
            localResultCodes: [],
        },
        [[
            { code: 'CSCE 580' },
            { code: 'CSCE 585' },
            { code: 'UNRELATED 999' },
        ]],
        [{ code: 'CSCE 580' }],
        false,
        {},
    );

    assert.equal(info.length, 1);
    assert.equal(info[0].count, 1);
    assert.deepEqual(Array.from(info[0].codes), ['CSCE 580']);
});

test('search source accounting covers only the final visible course union', () => {
    const search = loadSearch({});
    search.checkEligibility = code => ({ eligible: code !== 'CSCE 999' });
    const visibleResults = [
        { code: 'CSCE 580' },
        { code: 'CSCE 585' },
        { code: 'STAT 515' },
        { code: 'CSCE 999' },
    ];
    const info = search.buildSemanticSearchInfo(
        {
            searches: [
                { term: 'machine learning', count: 3, failed: false },
                { term: 'neural networks', count: 3, failed: false },
            ],
            localResultCodes: ['STAT 515', 'MATH 546', 'CSCE 999'],
        },
        [
            [{ code: 'CSCE 580' }, { code: 'HIDDEN 500' }, { code: 'CSCE 999' }],
            [{ code: 'CSCE 580' }, { code: 'CSCE 585' }, { code: 'HIDDEN 501' }],
        ],
        visibleResults,
        true,
        {},
    );

    const attributedCodes = new Set(info.flatMap(source => Array.from(source.codes || [])));
    const eligibleVisibleCodes = new Set(['CSCE 580', 'CSCE 585', 'STAT 515']);
    assert.deepEqual(
        [...attributedCodes].sort(),
        [...eligibleVisibleCodes].sort(),
    );
    assert.equal(
        info.every(source => source.codes.every(code => eligibleVisibleCodes.has(code))),
        true,
    );
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
