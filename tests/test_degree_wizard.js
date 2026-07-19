const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('../static/js/runtime/offering-analyzer.js');
const planner = require('../static/js/runtime/degree-planner.js');

const root = path.resolve(__dirname, '..');

test('degree planner shell uses four guided full-page stages', () => {
    const html = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
    for (const step of [1, 2, 3, 4]) {
        assert.match(html, new RegExp(`data-degree-step="${step}"`));
    }
    assert.match(html, /I HAVE NOT TAKEN ANY COURSES YET/);
    assert.match(html, /Advanced course entry/);
    const wizard = fs.readFileSync(path.join(root, 'static/js/degree-wizard.js'), 'utf8');
    assert.match(wizard, /VIEW PDF/);
});

test('Electrical Engineering plans every official required credit', () => {
    const map = JSON.parse(fs.readFileSync(
        path.join(root, 'data/maps/imported/2026-2027/map_374cc4bc138c13c7.json'),
        'utf8',
    ));
    const plan = planner.planDegree(map, [], { start_term: '202608', strategy: 'major_map' });
    const plannedCredits = plan.semesters.reduce((sum, semester) => sum + semester.total_credits, 0);
    assert.equal(map.total_credits_required, 126);
    assert.equal(plan.total_credits_remaining, 126);
    assert.equal(plannedCredits, 126);
    assert.deepEqual(plan.semesters.map(semester => semester.total_credits), [15, 17, 16, 18, 18, 15, 15, 12]);
});

test('major maps without concentrations expose an explicit unavailable state', () => {
    const source = fs.readFileSync(path.join(root, 'static/js/profile.js'), 'utf8');
    assert.match(source, /option\.textContent = 'None available'/);
    assert.match(source, /concSel\.disabled = true/);
});
