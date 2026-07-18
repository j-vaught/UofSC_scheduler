const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadProfile() {
    const context = vm.createContext({ console });
    const source = `${fs.readFileSync('static/js/profile.js', 'utf8')}\nglobalThis.__Profile = Profile;`;
    vm.runInContext(source, context);
    return context.__Profile;
}

test('major maps accept both the legacy array and maps wrapper', () => {
    const profile = loadProfile();
    const legacy = profile.normalizeMajorMaps([
        { id: 'cs-2026', major: 'Computer Science', program: 'B.S.', catalog_year: '2026-2027' },
    ]);
    const wrapped = profile.normalizeMajorMaps({
        maps: [{ id: 'me-2025', name: 'Mechanical Engineering', degree: 'B.S.E.', bulletin_year: '2025-2026' }],
    });

    assert.equal(legacy[0].id, 'cs-2026');
    assert.equal(wrapped[0].major, 'Mechanical Engineering');
    assert.equal(wrapped[0].program, 'B.S.E.');
    assert.equal(wrapped[0].catalog_year, '2025-2026');
});

test('catalog years are newest first within alphabetized program groups', () => {
    const profile = loadProfile();
    profile.majorMaps = profile.normalizeMajorMaps([
        { id: 'me-2024', major: 'Mechanical Engineering', program: 'B.S.E.', catalog_year: '2024-2025' },
        { id: 'cs-2025', major: 'Computer Science', program: 'B.S.', catalog_year: '2025-2026' },
        { id: 'me-2026', major: 'Mechanical Engineering', program: 'B.S.E.', catalog_year: '2026-2027' },
        { id: 'cs-2026', major: 'Computer Science', program: 'B.S.', catalog_year: '2026-2027' },
    ]);

    const groups = profile.sortedProgramGroups();
    assert.equal(groups[0].maps[0].major, 'Computer Science');
    assert.deepEqual(Array.from(groups[0].maps, map => map.id), ['cs-2026', 'cs-2025']);
    assert.deepEqual(Array.from(groups[1].maps, map => map.id), ['me-2026', 'me-2024']);
});

test('saved maps survive an identifier change when their program and catalog year match', () => {
    const profile = loadProfile();
    profile.majorMaps = profile.normalizeMajorMaps([
        { id: 'new-cs-id', major: 'Computer Science', program: 'B.S.', catalog_year: '2025-2026' },
    ]);

    assert.equal(profile.resolveSavedMap('old-cs-id', {
        major: 'Computer Science',
        program: 'B.S.',
        catalog_year: '2025-2026',
    }).id, 'new-cs-id');
    assert.equal(profile.resolveSavedMap('missing', null), null);
});

test('major map source metadata supports legacy and structured values', () => {
    const profile = loadProfile();
    assert.equal(profile.catalogYearLabel({ catalog_year: '2026-2027' }), '2026-2027 catalog');
    assert.equal(profile.sourceLabel({ source: { label: 'College advising guide' } }), 'College advising guide');
    assert.equal(profile.sourceUrl({ source: { url: 'https://example.edu/map.pdf' } }), 'https://example.edu/map.pdf');
    assert.equal(profile.sourceUrl({ pdf_url: 'https://example.edu/official-map.pdf' }), 'https://example.edu/official-map.pdf');
    assert.equal(profile.sourceUrl({ source_url: 'javascript:alert(1)' }), '');
});

test('degree plan includes selected map context and official source link behavior', () => {
    const source = fs.readFileSync('static/js/degree-plan.js', 'utf8');
    const html = fs.readFileSync('static/index.html', 'utf8');

    assert.match(html, /id="major-program-select"/);
    assert.match(html, /id="degree-map-context"/);
    assert.match(source, /Profile\.catalogYearLabel\(map\)/);
    assert.match(source, /rel = 'noopener noreferrer'/);
});
