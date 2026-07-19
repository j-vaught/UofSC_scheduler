/*
 * Degree-planning setup, fenced: major selection, transcript entry, planning pace.
 *
 * The fifth extraction under phase 7a, and the half that closes the cycle the
 * plan grouped: this module and the custom map builder used to call each other
 * directly. Both edges are dependencies now, so neither module knows the other
 * exists and the composition points decide what is wired to what.
 *
 * Two more existence-guarded ternaries came out, the pattern that has now
 * appeared in every extraction. Both fell back to "no custom maps" when the
 * global was missing, which inside a fence is always -- so a student's own
 * major maps would silently disappear from the program list and a saved custom
 * map would be re-fetched from the network as though it were an official one.
 *
 * Twelve dependencies is a lot, and that is the honest number: this module
 * reads the profile, writes it, reads coursework, writes coursework, fetches
 * two kinds of map, parses two transcript formats, and announces changes. The
 * count is a fair measure of how central it is, not of the fence being wrong.
 *
 * The DOM stays ambient, as in the map and builder features. This module is
 * mostly form population; a document is what it is for.
 *
 * The body is the previous implementation verbatim apart from those seams.
 */
(function initProfileFeature(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.Features) root.Features = {};
    root.Features.profile = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createProfileFeature(deps) {
        for (const name of ['getMajorMaps', 'getMajorMap', 'listCustomMaps', 'getCustomMap',
            'parseTranscript', 'parseTranscriptCSV', 'profile', 'completedCourses',
            'completedDetails', 'addManualCompleted', 'removeCompleted',
            'emitProfileUpdated', 'onTranscriptChange']) {
            if (typeof deps?.[name] !== 'function') {
                throw new TypeError(`profile feature needs a ${name}() dependency`);
            }
        }

        const feature = {
        majorMaps: [],

        init() {
            this.loadMajorMaps();
            this.bindMajorSelect();
            this.bindTranscript();
            this.bindPlanMode();
            this.renderCompletedChips();
            this.renderCreditSummary();
            deps.onTranscriptChange(() => {
                this.renderCompletedChips();
                this.renderCreditSummary();
            });
        },

        async loadMajorMaps() {
            try {
                const officialMaps = this.normalizeMajorMaps(await deps.getMajorMaps());
                // Was an existence-guarded ternary falling back to an empty list.
                // Inside a fence that guard always takes the empty branch, so a
                // student's own maps would quietly vanish from the program list.
                const customMaps = deps.listCustomMaps();
                this.majorMaps = [...officialMaps, ...customMaps];
                this.populateProgramSelect();

                const saved = this.resolveSavedMap(deps.profile().major, deps.profile().majorData);
                if (saved) {
                    document.getElementById('major-program-select').value = this.programKey(saved);
                    this.populateCatalogYears(this.programKey(saved), saved.id);
                    await this.onMajorChange(saved.id);
                } else {
                    deps.profile().major = null;
                    deps.profile().majorData = null;
                    this.populateCatalogYears('');
                }
            } catch (e) {
                console.error('Failed to load major maps:', e);
            }
        },

        normalizeMajorMaps(maps) {
            const list = Array.isArray(maps) ? maps : (maps?.maps || []);
            return list.filter(map => map?.id).map(map => ({
                ...map,
                major: String(map.major || map.name || 'Major'),
                program: String(map.program || map.degree || 'Program'),
                catalog_year: String(
                    map.catalog_year
                    || map.bulletin_year
                    || map.academic_year
                    || map.catalogYear
                    || map.year
                    || 'Current'
                ),
            }));
        },

        programKey(map) {
            return `${map.major}\u001f${map.program}`;
        },

        resolveSavedMap(mapId, savedData) {
            const exact = this.majorMaps.find(map => map.id === mapId);
            if (exact || !savedData) return exact || null;
            const normalize = value => String(value || '').trim().toLowerCase();
            return this.majorMaps.find(map => (
                normalize(map.major) === normalize(savedData.major)
                && normalize(map.program) === normalize(savedData.program)
                && normalize(map.catalog_year) === normalize(savedData.catalog_year)
            )) || null;
        },

        catalogYearLabel(map) {
            const year = String(map.catalog_year || 'Current').trim();
            return /catalog/i.test(year) ? year : `${year} catalog`;
        },

        sourceLabel(map) {
            if (typeof map.source === 'string' && map.source.trim()) return map.source.trim();
            return String(
                map.source?.label
                || map.source?.title
                || map.source_name
                || map.source_label
                || map.source_title
                || 'Official major map'
            );
        },

        sourceUrl(map) {
            const value = String(
                map.source_url
                || map.source?.url
                || map.pdf_url
                || map.repository_url
                || ''
            ).trim();
            return /^https?:\/\//i.test(value) ? value : '';
        },

        sortedProgramGroups() {
            const groups = new Map();
            this.majorMaps.forEach(map => {
                const key = this.programKey(map);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(map);
            });
            return [...groups.entries()]
                .map(([key, maps]) => ({ key, maps: this.sortCatalogYears(maps) }))
                .sort((a, b) => {
                    const left = `${a.maps[0].major} ${a.maps[0].program}`;
                    const right = `${b.maps[0].major} ${b.maps[0].program}`;
                    return left.localeCompare(right);
                });
        },

        sortCatalogYears(maps) {
            return [...maps].sort((a, b) => {
                const years = value => (String(value).match(/\d{4}/g) || []).map(Number);
                const aYears = years(a.catalog_year);
                const bYears = years(b.catalog_year);
                const aYear = aYears.length ? Math.max(...aYears) : -1;
                const bYear = bYears.length ? Math.max(...bYears) : -1;
                return bYear - aYear || String(b.catalog_year).localeCompare(String(a.catalog_year));
            });
        },

        populateProgramSelect() {
            const select = document.getElementById('major-program-select');
            select.replaceChildren(new Option('-- Select Your Major --', ''));
            this.sortedProgramGroups().forEach(group => {
                const map = group.maps[0];
                select.appendChild(new Option(`${map.major} — ${map.program}`, group.key));
            });
        },

        populateCatalogYears(programKey, preferredMapId = '') {
            const select = document.getElementById('major-select');
            const maps = this.sortCatalogYears(this.majorMaps.filter(map => this.programKey(map) === programKey));
            select.replaceChildren(new Option(
                maps.length ? '-- Select Catalog Year --' : '-- Select a Major First --',
                '',
            ));
            maps.forEach(map => select.appendChild(new Option(this.catalogYearLabel(map), map.id)));
            select.disabled = maps.length === 0;
            const selected = maps.some(map => map.id === preferredMapId) ? preferredMapId : (maps[0]?.id || '');
            select.value = selected;
            return selected;
        },

        bindMajorSelect() {
            const majorSel = document.getElementById('major-select');
            const programSel = document.getElementById('major-program-select');
            const concSel = document.getElementById('concentration-select');

            programSel.addEventListener('change', () => {
                const mapId = this.populateCatalogYears(programSel.value);
                this.onMajorChange(mapId);
            });

            majorSel.addEventListener('change', () => {
                this.onMajorChange(majorSel.value);
            });

            concSel.addEventListener('change', () => {
                deps.profile().concentration = concSel.value;
                deps.emitProfileUpdated();
            });
        },

        async onMajorChange(mapId) {
            if (!mapId) {
                deps.profile().major = null;
                deps.profile().majorData = null;
                document.getElementById('major-summary').innerHTML = '';
                this.renderCreditSummary();
                deps.emitProfileUpdated();
                return;
            }

            try {
                const customMap = deps.getCustomMap(mapId);
                const data = customMap || await deps.getMajorMap(mapId);
                deps.profile().major = mapId;
                deps.profile().majorData = data;

                const indexEntry = this.majorMaps.find(map => map.id === mapId) || {};
                const displayData = { ...indexEntry, ...data };

                // Populate concentrations
                const concSel = document.getElementById('concentration-select');
                concSel.innerHTML = '';
                const concs = data.concentrations || {};
                const concentrationEntries = Object.entries(concs);
                if (!concentrationEntries.length) {
                    const option = document.createElement('option');
                    option.value = 'general';
                    option.textContent = 'None available';
                    concSel.appendChild(option);
                    concSel.disabled = true;
                    deps.profile().concentration = 'general';
                } else for (const [key, val] of concentrationEntries) {
                    const opt = document.createElement('option');
                    opt.value = key;
                    opt.textContent = val.label;
                    concSel.appendChild(opt);
                }
                if (concentrationEntries.length) concSel.disabled = false;
                if (deps.profile().concentration && concs[deps.profile().concentration]) {
                    concSel.value = deps.profile().concentration;
                }

                // Show summary
                const summary = document.getElementById('major-summary');
                summary.replaceChildren();
                const heading = document.createElement('div');
                heading.className = 'summary-item major-summary-heading';
                const strong = document.createElement('strong');
                strong.textContent = displayData.major;
                heading.append(strong, document.createTextNode(` — ${displayData.program}`));
                summary.appendChild(heading);
                if (displayData.college) this.appendSummaryItem(summary, displayData.college);
                const requiredCredits = displayData.total_credits_required ?? displayData.total_credits;
                if (requiredCredits != null) this.appendSummaryItem(summary, `${requiredCredits} credits required`);
                this.appendSummaryItem(summary, this.catalogYearLabel(displayData), 'major-summary-catalog');
                const sourceUrl = this.sourceUrl(displayData);
                const source = document.createElement(sourceUrl ? 'a' : 'div');
                source.className = 'summary-item major-map-source';
                source.textContent = `Source: ${this.sourceLabel(displayData)}`;
                if (sourceUrl) {
                    source.href = sourceUrl;
                    source.target = '_blank';
                    source.rel = 'noopener noreferrer';
                    source.title = 'Open the official major map in a new tab';
                }
                summary.appendChild(source);

                this.renderCreditSummary();
                deps.emitProfileUpdated();
            } catch (e) {
                console.error('Failed to load major map:', e);
            }
        },

        appendSummaryItem(container, text, className = '') {
            const item = document.createElement('div');
            item.className = `summary-item ${className}`.trim();
            item.textContent = text;
            container.appendChild(item);
        },

        bindTranscript() {
            // Parse button
            document.getElementById('btn-parse-transcript').addEventListener('click', () => {
                const text = document.getElementById('transcript-input').value.trim();
                if (!text) return;
                this.parseAndAddCourses(text);
                document.getElementById('transcript-input').value = '';
            });

            // Also allow Enter key in textarea with Ctrl/Cmd
            document.getElementById('transcript-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    document.getElementById('btn-parse-transcript').click();
                }
            });

            // CSV upload
            document.getElementById('csv-upload').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const data = await deps.parseTranscriptCSV(ev.target.result);
                        if (data.courses) {
                            deps.addManualCompleted(data.courses);
                        }
                    } catch (err) {
                        console.error('CSV parse error:', err);
                    }
                };
                reader.readAsText(file);
                e.target.value = ''; // Reset input
            });
        },

        async parseAndAddCourses(text) {
            try {
                const data = await deps.parseTranscript(text);
                if (data.courses) {
                    deps.addManualCompleted(data.courses);
                }
            } catch (e) {
                console.error('Parse error:', e);
            }
        },

        renderCompletedChips() {
            const container = document.getElementById('completed-chips');
            if (!container) return;
            container.innerHTML = '';

            if (deps.completedCourses().length === 0) {
                container.innerHTML = '<p class="hint">No courses added yet.</p>';
                return;
            }

            // Sort alphabetically
            const sorted = [...deps.completedCourses()].sort();
            sorted.forEach(course => {
                const chip = document.createElement('span');
                chip.className = 'completed-chip';
                chip.append(document.createTextNode(`${course} `));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'remove';
                remove.setAttribute('aria-label', `Remove ${course}`);
                remove.title = `Remove ${course}`;
                remove.textContent = '×';
                chip.appendChild(remove);
                chip.querySelector('.remove').addEventListener('click', () => {
                    deps.removeCompleted(course);
                });
                container.appendChild(chip);
            });
        },

        renderCreditSummary() {
            const el = document.getElementById('credit-summary');
            if (!el) return;

            const totalCompleted = deps.completedCourses().length;
            const majorData = deps.profile().majorData;

            if (!majorData) {
                el.innerHTML = `<strong>${totalCompleted}</strong> courses entered`;
                return;
            }

            // Estimate credits (3 per course if no detail data)
            let creditsDone = 0;
            deps.completedDetails().forEach(c => {
                creditsDone += c.credits || 3;
            });
            // For courses without details, assume 3 credits
            const detailedCodes = new Set(deps.completedDetails().map(c => c.code));
            deps.completedCourses().forEach(code => {
                if (!detailedCodes.has(code)) {
                    // Check major map for credits
                    const mapCourse = majorData.required_courses.find(c => c.code === code);
                    creditsDone += mapCourse ? mapCourse.credits : 3;
                }
            });

            const totalRequired = majorData.total_credits_required;
            const remaining = Math.max(0, totalRequired - creditsDone);

            el.innerHTML = `
                <strong>${creditsDone}</strong> credits completed &bull;
                <strong>${remaining}</strong> credits remaining &bull;
                <strong>${totalRequired}</strong> total required
            `;
        },

        bindPlanMode() {
            document.querySelectorAll('input[name="plan-mode"]').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    deps.profile().planMode = e.target.value;
                    const customPanel = document.getElementById('custom-credits-panel');
                    if (e.target.value === 'custom') {
                        customPanel.classList.remove('hidden');
                    } else {
                        customPanel.classList.add('hidden');
                    }
                    this.checkScholarshipWarning();
                    deps.emitProfileUpdated();
                });
            });

            // Custom credit inputs
            ['custom-min', 'custom-max', 'custom-target'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', () => {
                        deps.profile().customCredits = {
                            min: parseInt(document.getElementById('custom-min').value) || 12,
                            max: parseInt(document.getElementById('custom-max').value) || 18,
                            target: parseInt(document.getElementById('custom-target').value) || 15,
                        };
                    });
                }
            });

            // Restore saved mode
            const savedMode = deps.profile().planMode;
            const radio = document.querySelector(`input[name="plan-mode"][value="${savedMode}"]`);
            if (radio) radio.checked = true;
            if (savedMode === 'custom') {
                document.getElementById('custom-credits-panel').classList.remove('hidden');
            }

            this.checkScholarshipWarning();
        },

        checkScholarshipWarning() {
            const warning = document.getElementById('scholarship-warning');
            if (!warning) return;
            if (deps.profile().planMode === 'scholarship' || deps.profile().planMode === 'part_time') {
                warning.classList.remove('hidden');
            } else {
                warning.classList.add('hidden');
            }
        },
};

        return feature;
    }

    return { createProfileFeature };
}));
