/*
 * Custom major maps, fenced.
 *
 * The fourth extraction under phase 7a, and the first half of the pair the plan
 * groups together: this module and Profile call each other. Rather than fencing
 * the cycle whole, the edge back into Profile is now a callback, so each side
 * depends on something it was given instead of on the other module existing.
 *
 * Three ambient guards came out, all the pattern the map extraction taught:
 * `typeof Profile === 'undefined'` and `typeof State === 'undefined'` read as
 * defensive, but inside a fenced module those globals are always undefined, so
 * every guarded path would return early. Saving a map would have stopped
 * selecting it, silently, with the save itself still working.
 *
 * Storage is injected rather than reached for, which makes visible something
 * that was hidden: custom maps are written to a bare localStorage key, so every
 * device-local account on a shared machine sees the same ones. That is a real
 * gap, recorded in TODO.md rather than fixed here -- changing the key orphans
 * maps students have already saved, so it needs a migration, and a fence is not
 * the place for a behaviour change.
 *
 * The DOM stays ambient, as it does in the map feature. This is a form builder;
 * a document is what it is for. The fence that earns its keep is around the
 * application's own state, not around the platform.
 *
 * The body is the previous implementation verbatim apart from those seams.
 */
(function initCustomMajorMapFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.customMajorMap = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createCustomMajorMapFeature(deps) {
        for (const name of ['readMaps', 'writeMaps', 'currentProfile', 'onProfileChange',
            'onMapSaved', 'onMapDeleted']) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError(`custom major map feature needs a ${name}() dependency`);
            }
        }
        if (!deps.modal || typeof deps.modal.open !== 'function' || typeof deps.modal.close !== 'function') {
            throw new TypeError('custom major map feature needs a modal with open() and close()');
        }


        const STORAGE_KEY = 'uosc-custom-major-maps-v1';
        const CORE_TYPES = Object.freeze([
            ['AIU', 'Aesthetic and Interpretive Understanding'],
            ['ARP', 'Analytical Reasoning and Problem Solving'],
            ['CMS', 'Effective, Engaged, and Persuasive Communication: Spoken'],
            ['CMW', 'Effective, Engaged, and Persuasive Communication: Written'],
            ['GFL', 'Global Citizenship and Multicultural Understanding: Foreign Language'],
            ['GHS', 'Global Citizenship and Multicultural Understanding: Historical Thinking'],
            ['GSS', 'Global Citizenship and Multicultural Understanding: Social Sciences'],
            ['SCI', 'Scientific Literacy'],
            ['VSR', 'Values, Ethics, and Social Responsibility'],
        ]);

        let draft = null;

        function makeId(prefix = 'custom') {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}:${crypto.randomUUID()}`;
            return `${prefix}:${Date.now()}-${Math.random().toString(16).slice(2)}`;
        }

        function emptyEntry() {
            return {
                id: makeId('requirement'),
                type: 'course',
                code: '',
                title: '',
                core: 'AIU',
                allowedCourses: [],
                minCredits: 3,
                maxCredits: 3,
                notes: '',
            };
        }

        function emptySemester(index = 0) {
            return {
                id: makeId('semester'),
                label: `Semester ${index + 1}`,
                entries: [],
            };
        }

        function emptyDraft() {
            return {
                id: makeId('custom-map'),
                name: 'My Major Map',
                degree: 'Custom degree plan',
                totalCredits: 120,
                notes: '',
                semesters: [0, 1, 2, 3, 4, 5, 6, 7].map(emptySemester),
            };
        }

        function finiteCredit(value, fallback = 3, maximum = 30) {
            const number = Number(value);
            return Number.isFinite(number) ? Math.max(0, Math.min(maximum, number)) : fallback;
        }

        function normalizeEntry(entry = {}) {
            const type = ['course', 'elective', 'carolina_core', 'free_choice'].includes(entry.type)
                ? entry.type
                : 'course';
            const minCredits = finiteCredit(entry.minCredits ?? entry.min_credits, 3);
            const maxCredits = Math.max(minCredits, finiteCredit(entry.maxCredits ?? entry.max_credits, minCredits));
            return {
                id: String(entry.id || makeId('requirement')),
                type,
                code: String(entry.code || '').trim().toUpperCase(),
                title: String(entry.title || '').trim(),
                core: CORE_TYPES.some(([code]) => code === entry.core) ? entry.core : 'AIU',
                allowedCourses: normalizeCourseCodes(entry.allowedCourses ?? entry.allowed_courses),
                minCredits,
                maxCredits,
                notes: String(entry.notes || '').trim(),
            };
        }

        function normalizeDraft(value = {}) {
            const sourceSemesters = Array.isArray(value.semesters) ? value.semesters : [];
            const semesters = (sourceSemesters.length ? sourceSemesters : [emptySemester(0)])
                .slice(0, 16)
                .map((semester, index) => ({
                    id: String(semester.id || makeId('semester')),
                    label: String(semester.label || `Semester ${index + 1}`).trim() || `Semester ${index + 1}`,
                    entries: (Array.isArray(semester.entries) ? semester.entries : [])
                        .slice(0, 30)
                        .map(normalizeEntry),
                }));
            return {
                id: String(value.id || makeId('custom-map')),
                name: String(value.name || 'My Major Map').trim() || 'My Major Map',
                degree: String(value.degree || 'Custom degree plan').trim() || 'Custom degree plan',
                totalCredits: finiteCredit(value.totalCredits ?? value.total_credits_required, 120, 300),
                notes: String(value.notes || '').trim(),
                semesters,
            };
        }

        function validCourseCode(value) {
            const match = String(value || '').trim().toUpperCase().match(/^([A-Z]{2,5})\s*([0-9]{3}[A-Z]?)$/);
            return match ? `${match[1]} ${match[2]}` : '';
        }

        function courseCodeTokens(value) {
            if (Array.isArray(value)) return value.map(String);
            const text = String(value || '').toUpperCase();
            return text.match(/[A-Z]{2,5}\s*[0-9]{3}[A-Z]?/g) || [];
        }

        function normalizeCourseCodes(value) {
            return [...new Set(courseCodeTokens(value).map(validCourseCode).filter(Boolean))];
        }

        function invalidCourseCodeText(value) {
            if (Array.isArray(value)) return value.filter(item => !validCourseCode(item)).map(String);
            const remainder = String(value || '')
                .toUpperCase()
                .replace(/[A-Z]{2,5}\s*[0-9]{3}[A-Z]?/g, '')
                .replace(/[\s,;]+/g, '');
            return remainder ? [remainder] : [];
        }

        function entryTitle(entry) {
            if (entry.type === 'course') return entry.title || validCourseCode(entry.code);
            if (entry.type === 'carolina_core') {
                const label = CORE_TYPES.find(([code]) => code === entry.core)?.[1] || 'Carolina Core';
                return entry.title || `Carolina Core ${entry.core} — ${label}`;
            }
            return entry.title || (entry.type === 'free_choice' ? 'Free-choice credits' : 'Elective');
        }

        function creditValue(entry) {
            return entry.minCredits === entry.maxCredits
                ? entry.minCredits
                : [entry.minCredits, entry.maxCredits];
        }

        function buildMajorMap(value) {
            const source = normalizeDraft(value);
            const requiredCourses = [];
            const electiveGroups = [];
            const seenCourses = new Set();
            const semesterPlan = source.semesters.map((semester, semesterIndex) => {
                const requirements = semester.entries.map((entry, entryIndex) => {
                    const credits = creditValue(entry);
                    const title = entryTitle(entry);
                    const code = entry.type === 'course' ? validCourseCode(entry.code) : '';
                    if (code && !seenCourses.has(code)) {
                        seenCourses.add(code);
                        requiredCourses.push({
                            code,
                            title: entry.title || code,
                            credits: entry.maxCredits,
                            credit_hours: credits,
                            category: 'major_core',
                            prerequisites: [],
                            corequisites: [],
                            typical_year: Math.floor(semesterIndex / 2) + 1,
                            typical_semester: semesterIndex % 2 === 0 ? 'Fall' : 'Spring',
                            custom_notes: entry.notes,
                        });
                    } else if (!code) {
                        electiveGroups.push({
                            id: entry.id,
                            label: title,
                            category: entry.type === 'carolina_core' ? 'carolina_core' : 'electives',
                            pick_credits: entry.maxCredits,
                            credits_required: entry.maxCredits,
                            credits_each: entry.maxCredits,
                            options: entry.type === 'free_choice' ? [] : entry.allowedCourses,
                            custom_notes: entry.notes,
                        });
                    }
                    return {
                        id: entry.id,
                        title,
                        course_codes: code ? [code] : [],
                        credit_hours: credits,
                        category: entry.type === 'carolina_core' ? 'carolina_core' : (entry.type === 'course' ? 'major_core' : 'electives'),
                        requirement_type: entry.type,
                        notes: entry.notes,
                    };
                });
                const minimum = semester.entries.reduce((sum, entry) => sum + entry.minCredits, 0);
                const maximum = semester.entries.reduce((sum, entry) => sum + entry.maxCredits, 0);
                return {
                    number: semesterIndex + 1,
                    label: semester.label,
                    planned_credit_hours: minimum === maximum ? minimum : [minimum, maximum],
                    requirements,
                };
            });
            const totalMinimum = source.semesters.flatMap(semester => semester.entries)
                .reduce((sum, entry) => sum + entry.minCredits, 0);
            const totalMaximum = source.semesters.flatMap(semester => semester.entries)
                .reduce((sum, entry) => sum + entry.maxCredits, 0);
            return {
                id: source.id,
                major: source.name,
                program: source.degree,
                catalog_year: 'Personal',
                college: 'Personal plan',
                source: 'Saved on this device',
                custom_map: true,
                custom_notes: source.notes,
                total_credits_required: source.totalCredits,
                total_credit_range: totalMinimum === totalMaximum ? totalMaximum : [totalMinimum, totalMaximum],
                entered_credit_range: totalMinimum === totalMaximum ? totalMaximum : [totalMinimum, totalMaximum],
                semester_plan: semesterPlan,
                required_courses: requiredCourses,
                elective_groups: electiveGroups,
                category_labels: {
                    major_core: 'Exact courses',
                    electives: 'Electives',
                    carolina_core: 'Carolina Core',
                },
                concentrations: {},
                _customDraft: source,
            };
        }

        function readAll() {
            try {
                const parsed = JSON.parse(deps.readMaps() || '[]');
                return Array.isArray(parsed) ? parsed.map(normalizeDraft) : [];
            } catch (_error) {
                return [];
            }
        }

        function writeAll(maps) {
            deps.writeMaps(JSON.stringify(maps.map(normalizeDraft)));
        }

        function listMaps() {
            return readAll().map(buildMajorMap);
        }

        function get(id) {
            const found = readAll().find(map => map.id === id);
            return found ? buildMajorMap(found) : null;
        }

        function save(value) {
            const normalized = normalizeDraft(value);
            const maps = readAll().filter(map => map.id !== normalized.id);
            maps.push(normalized);
            writeAll(maps);
            return buildMajorMap(normalized);
        }

        function remove(id) {
            writeAll(readAll().filter(map => map.id !== id));
        }

        function escape(value) {
            return String(value ?? '').replace(/[&<>'"]/g, character => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
            })[character]);
        }

        function coreOptions(selected) {
            return CORE_TYPES.map(([code, label]) => `<option value="${code}"${code === selected ? ' selected' : ''}>${code} — ${escape(label)}</option>`).join('');
        }

        function entryMarkup(entry, semesterIndex, entryIndex) {
            const isCourse = entry.type === 'course';
            const isCore = entry.type === 'carolina_core';
            const supportsOptions = entry.type === 'elective' || entry.type === 'carolina_core';
            return `<article class="custom-map-entry" data-entry-index="${entryIndex}">
                <div class="custom-map-entry-heading">
                    <strong>REQUIREMENT ${entryIndex + 1}</strong>
                    <button type="button" data-custom-action="remove-entry" data-semester="${semesterIndex}" data-entry="${entryIndex}" aria-label="Remove requirement ${entryIndex + 1}">REMOVE</button>
                </div>
                <div class="custom-map-entry-grid">
                    <label>Requirement type<select data-custom-field="type" data-semester="${semesterIndex}" data-entry="${entryIndex}">
                        <option value="course"${entry.type === 'course' ? ' selected' : ''}>Exact course</option>
                        <option value="elective"${entry.type === 'elective' ? ' selected' : ''}>Elective or choice</option>
                        <option value="carolina_core"${entry.type === 'carolina_core' ? ' selected' : ''}>Carolina Core</option>
                        <option value="free_choice"${entry.type === 'free_choice' ? ' selected' : ''}>Free-choice credits</option>
                    </select></label>
                    ${isCourse ? `<label>Course code<input data-custom-field="code" data-semester="${semesterIndex}" data-entry="${entryIndex}" value="${escape(entry.code)}" placeholder="Example: MATH 141" required></label>` : ''}
                    ${isCore ? `<label>Core requirement<select data-custom-field="core" data-semester="${semesterIndex}" data-entry="${entryIndex}">${coreOptions(entry.core)}</select></label>` : ''}
                    <label class="custom-map-entry-title">${isCourse ? 'Course title (optional)' : 'Requirement name'}<input data-custom-field="title" data-semester="${semesterIndex}" data-entry="${entryIndex}" value="${escape(entry.title)}" placeholder="${isCourse ? 'Example: Calculus I' : (isCore ? 'Optional custom label' : 'Example: Technical elective')}"></label>
                    ${supportsOptions ? `<label class="custom-map-entry-options">Allowed course codes (optional)<textarea rows="2" data-custom-field="allowedCourses" data-semester="${semesterIndex}" data-entry="${entryIndex}" placeholder="CSCE 500; MATH 520; STAT 509">${escape(entry.allowedCourses.join('; '))}</textarea></label>` : ''}
                    <label>Minimum credits<input type="number" min="0" max="30" step="0.5" data-custom-field="minCredits" data-semester="${semesterIndex}" data-entry="${entryIndex}" value="${entry.minCredits}"></label>
                    <label>Maximum credits<input type="number" min="0" max="30" step="0.5" data-custom-field="maxCredits" data-semester="${semesterIndex}" data-entry="${entryIndex}" value="${entry.maxCredits}"></label>
                    <label class="custom-map-entry-notes">Notes<textarea rows="2" data-custom-field="notes" data-semester="${semesterIndex}" data-entry="${entryIndex}" placeholder="Optional selection rules, minimum grade, or advising note">${escape(entry.notes)}</textarea></label>
                </div>
            </article>`;
        }

        function semesterMarkup(semester, index) {
            return `<section class="custom-map-semester" data-semester-index="${index}">
                <header>
                    <label>Semester name<input data-custom-semester-label="${index}" value="${escape(semester.label)}" aria-label="Semester ${index + 1} name"></label>
                    <div class="custom-map-semester-controls">
                        <button type="button" data-custom-action="move-semester-up" data-semester="${index}" aria-label="Move ${escape(semester.label)} earlier"${index === 0 ? ' disabled' : ''}>↑</button>
                        <button type="button" data-custom-action="move-semester-down" data-semester="${index}" aria-label="Move ${escape(semester.label)} later"${index === draft.semesters.length - 1 ? ' disabled' : ''}>↓</button>
                        <button type="button" data-custom-action="remove-semester" data-semester="${index}" aria-label="Remove ${escape(semester.label)}">REMOVE SEMESTER</button>
                    </div>
                </header>
                <div class="custom-map-entry-list">${semester.entries.map((entry, entryIndex) => entryMarkup(entry, index, entryIndex)).join('') || '<p class="custom-map-empty-semester">No requirements in this semester yet.</p>'}</div>
                <button type="button" class="custom-map-add-entry" data-custom-action="add-entry" data-semester="${index}">+ ADD COURSE OR REQUIREMENT</button>
            </section>`;
        }

        function renderBuilder() {
            const rootElement = typeof document !== 'undefined' ? document.getElementById('custom-major-map-builder') : null;
            if (!rootElement || !draft) return;
            rootElement.innerHTML = `
                <div class="custom-map-builder-intro">
                    <span class="degree-eyebrow">PERSONAL DEGREE MAP</span>
                    <h2>${draft.id.startsWith('custom-map:') && get(draft.id) ? 'Edit your major map' : 'Add your own major map'}</h2>
                    <p>Add exact courses, electives, and Carolina Core requirements in the semester where you expect to take them.</p>
                </div>
                <div class="custom-map-basics">
                    <label>Map name<input id="custom-map-name" value="${escape(draft.name)}" maxlength="100" required></label>
                    <label>Degree or program<input id="custom-map-degree" value="${escape(draft.degree)}" maxlength="100" placeholder="Example: Bachelor of Science"></label>
                    <label>Total credits required<input id="custom-map-total-credits" type="number" min="1" max="300" step="0.5" value="${draft.totalCredits}" required></label>
                    <label class="custom-map-notes">Plan notes<textarea id="custom-map-notes" rows="2" maxlength="1000" placeholder="Optional advising notes or assumptions">${escape(draft.notes)}</textarea></label>
                </div>
                <div class="custom-map-semesters">${draft.semesters.map(semesterMarkup).join('')}</div>
                <div class="custom-map-builder-actions">
                    ${get(draft.id) ? '<button type="button" id="custom-map-delete" class="custom-map-delete">DELETE MAP</button>' : '<span></span>'}
                    <button type="button" id="custom-map-add-semester">+ ADD SEMESTER</button>
                    <button type="button" id="custom-map-save" class="btn-garnet">SAVE AND USE THIS MAP</button>
                </div>`;
        }

        function syncField(target) {
            const semesterIndex = Number(target.dataset.semester);
            const entryIndex = Number(target.dataset.entry);
            const field = target.dataset.customField;
            if (field && draft?.semesters?.[semesterIndex]?.entries?.[entryIndex]) {
                draft.semesters[semesterIndex].entries[entryIndex][field] = target.value;
            } else if (target.dataset.customSemesterLabel !== undefined) {
                draft.semesters[Number(target.dataset.customSemesterLabel)].label = target.value;
            } else if (target.id === 'custom-map-name') draft.name = target.value;
            else if (target.id === 'custom-map-degree') draft.degree = target.value;
            else if (target.id === 'custom-map-total-credits') draft.totalCredits = target.value;
            else if (target.id === 'custom-map-notes') draft.notes = target.value;
        }

        function validateDraft(value) {
            const normalized = normalizeDraft(value);
            const errors = [];
            if (!normalized.name) errors.push('Enter a name for this map.');
            if (!(Number(normalized.totalCredits) > 0)) errors.push('Total credits required must be greater than zero.');
            normalized.semesters.forEach((semester, semesterIndex) => {
                semester.entries.forEach((entry, entryIndex) => {
                    if (entry.type === 'course' && !validCourseCode(entry.code)) {
                        errors.push(`${semester.label}, requirement ${entryIndex + 1}: enter a course code such as MATH 141.`);
                    }
                    if (entry.type !== 'course' && !entryTitle(entry)) {
                        errors.push(`${semester.label}, requirement ${entryIndex + 1}: enter a requirement name.`);
                    }
                    if (['elective', 'carolina_core'].includes(entry.type)) {
                        const original = value.semesters?.[semesterIndex]?.entries?.[entryIndex]?.allowedCourses
                            ?? value.semesters?.[semesterIndex]?.entries?.[entryIndex]?.allowed_courses;
                        if (invalidCourseCodeText(original).length) {
                            errors.push(`${semester.label}, requirement ${entryIndex + 1}: allowed courses must use codes such as CSCE 500.`);
                        }
                    }
                });
            });
            return errors;
        }

        function warningsForDraft(value) {
            const normalized = normalizeDraft(value);
            const entries = normalized.semesters.flatMap(semester => semester.entries);
            const minimum = entries.reduce((sum, entry) => sum + entry.minCredits, 0);
            const maximum = entries.reduce((sum, entry) => sum + entry.maxCredits, 0);
            if (normalized.totalCredits >= minimum && normalized.totalCredits <= maximum) return [];
            const range = minimum === maximum ? `${minimum}` : `${minimum}–${maximum}`;
            return [`Semester requirements currently add up to ${range} credits, which does not cover the declared ${normalized.totalCredits}-credit degree total.`];
        }

        /*
         * Selecting a saved map is the caller's business, not this module's. It
         * used to reach into six Profile methods behind a typeof guard -- which
         * inside a fence would always pass and silently do nothing, so a saved map
         * would never become the active one.
         */
        function selectMap(map) {
            deps.onMapSaved(map);
        }

        function saveFromBuilder() {
            const errors = validateDraft(draft);
            const errorBox = document.getElementById('custom-map-errors');
            if (errors.length) {
                errorBox.hidden = false;
                errorBox.innerHTML = `<strong>Check this map before saving.</strong><ul>${errors.map(error => `<li>${escape(error)}</li>`).join('')}</ul>`;
                errorBox.focus();
                return;
            }
            const warnings = warningsForDraft(draft);
            if (warnings.length && !confirm(`${warnings.join('\n')}\n\nSave this map anyway?`)) return;
            const map = save(draft);
            selectMap(map);
            deps.modal.close();
        }

        function open(id = '') {
            draft = id ? (get(id)?._customDraft || emptyDraft()) : emptyDraft();
            deps.modal.open(`
                <div id="custom-map-errors" class="custom-map-errors" role="alert" tabindex="-1" hidden></div>
                <div id="custom-major-map-builder"></div>`, {
                className: 'custom-major-map-modal',
                label: id ? 'Edit personal major map' : 'Add a personal major map',
            });
            renderBuilder();
        }

        function handleBuilderClick(event) {
            const button = event.target.closest('[data-custom-action], #custom-map-add-semester, #custom-map-save, #custom-map-delete');
            if (!button || !draft) return;
            const semesterIndex = Number(button.dataset.semester);
            const entryIndex = Number(button.dataset.entry);
            switch (button.dataset.customAction) {
            case 'add-entry':
                draft.semesters[semesterIndex].entries.push(emptyEntry());
                break;
            case 'remove-entry':
                draft.semesters[semesterIndex].entries.splice(entryIndex, 1);
                break;
            case 'remove-semester':
                if (draft.semesters.length > 1) draft.semesters.splice(semesterIndex, 1);
                break;
            case 'move-semester-up':
                [draft.semesters[semesterIndex - 1], draft.semesters[semesterIndex]] = [draft.semesters[semesterIndex], draft.semesters[semesterIndex - 1]];
                break;
            case 'move-semester-down':
                [draft.semesters[semesterIndex], draft.semesters[semesterIndex + 1]] = [draft.semesters[semesterIndex + 1], draft.semesters[semesterIndex]];
                break;
            default:
                if (button.id === 'custom-map-add-semester') draft.semesters.push(emptySemester(draft.semesters.length));
                else if (button.id === 'custom-map-save') return saveFromBuilder();
                else if (button.id === 'custom-map-delete') {
                    if (confirm('Delete this custom major map from this device?')) {
                        remove(draft.id);
                        deps.modal.close();
                        deps.onMapDeleted();
                    }
                    return;
                }
            }
            renderBuilder();
        }

        function updateEditButton() {
            const button = typeof document !== 'undefined' ? document.getElementById('btn-edit-custom-major-map') : null;
            if (!button) return;
            button.hidden = !deps.currentProfile().majorData?.custom_map;
        }

        function init() {
            if (typeof document === 'undefined') return;
            document.getElementById('btn-add-custom-major-map')?.addEventListener('click', () => open());
            document.getElementById('btn-edit-custom-major-map')?.addEventListener('click', () => open(deps.currentProfile().major));
            document.addEventListener('input', event => {
                if (event.target.closest('#custom-major-map-builder')) syncField(event.target);
            });
            document.addEventListener('change', event => {
                if (!event.target.closest('#custom-major-map-builder')) return;
                syncField(event.target);
                if (event.target.dataset.customField === 'type') renderBuilder();
            });
            document.addEventListener('click', handleBuilderClick);
            deps.onProfileChange(updateEditButton);
            updateEditButton();
        }


        return Object.freeze({
            STORAGE_KEY,
            CORE_TYPES,
            emptyDraft,
            normalizeDraft,
            validCourseCode,
            buildMajorMap,
            validateDraft,
            warningsForDraft,
            normalizeCourseCodes,
            listMaps,
            get,
            save,
            remove,
            open,
            init,
        });
    }

    return { createCustomMajorMapFeature };
}));
