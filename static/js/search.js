/* Course search UI */
const Search = {
    _prereqCache: {},
    _searchId: 0,
    _subjects: [],

    // Levenshtein edit distance between two strings
    _editDistance(a, b) {
        const m = a.length, n = b.length;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1]
                    : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
            }
        }
        return dp[m][n];
    },

    // Find closest subject codes by edit distance. Returns [] if input is an exact match.
    _fuzzyMatchSubject(input) {
        const upper = input.toUpperCase();
        if (this._subjects.includes(upper)) return [];  // exact match, no fuzzy needed
        const scored = this._subjects
            .map(s => ({ code: s, dist: this._editDistance(upper, s) }))
            .filter(s => s.dist <= 2)
            .sort((a, b) => a.dist - b.dist);
        return scored.slice(0, 3);
    },

    // Validate/correct a subject code. Returns corrected code, or null if unresolvable (hint shown).
    _resolveSubject(raw) {
        const upper = raw.toUpperCase();
        if (!this._subjects.length || this._subjects.includes(upper)) return upper;
        const matches = this._fuzzyMatchSubject(upper);
        if (matches.length === 1 && matches[0].dist === 1) {
            // Auto-correct single close match
            return matches[0].code;
        }
        if (matches.length > 0) {
            const links = matches.map(m =>
                `<a href="#" class="fuzzy-suggestion" data-code="${m.code}">${m.code}</a>`
            ).join(', ');
            this.showHint(`Unknown subject "${upper}". Did you mean: ${links}?`);
            document.querySelectorAll('.fuzzy-suggestion').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    const input = document.getElementById('keyword-input');
                    input.value = input.value.replace(/^[A-Za-z]{3,4}/i, e.target.dataset.code);
                    this.doSearch();
                });
            });
        } else {
            this.showHint(`Unknown subject "${upper}". Check the code and try again.`);
        }
        return null;
    },

    init() {
        // Load subject list for fuzzy matching
        fetch('/api/subjects').then(r => r.json()).then(list => { this._subjects = list; });

        document.getElementById('btn-search').addEventListener('click', () => this.doSearch());
        document.getElementById('keyword-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.doSearch();
        });

        // Clear button
        const clearBtn = document.getElementById('search-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                document.getElementById('keyword-input').value = '';
                document.getElementById('keyword-input').focus();
            });
        }

        // Filter toggle
        const filterToggle = document.getElementById('filter-toggle');
        const filterPanel = document.getElementById('filter-panel');
        const filterArrow = document.getElementById('filter-arrow');
        if (filterToggle && filterPanel) {
            filterToggle.addEventListener('click', () => {
                filterPanel.classList.toggle('hidden');
                filterArrow.classList.toggle('open');
            });
        }

        // Update term label when term changes
        const termSelect = document.getElementById('term-select');
        if (termSelect) {
            const updateTermLabel = () => {
                const opt = termSelect.options[termSelect.selectedIndex];
                const label = document.getElementById('filter-term-label');
                if (label && opt) label.textContent = opt.textContent;
            };
            termSelect.addEventListener('change', updateTermLabel);
            updateTermLabel();
        }
    },


    async doSearch() {
        const rawInput = document.getElementById('keyword-input').value.trim();
        const openOnly = document.getElementById('filter-open').checked;
        const eligibleOnly = document.getElementById('filter-eligible').checked;
        const currentTermOnly = document.getElementById('filter-current-term').checked;

        // Level filter — removed from UI; range/wildcard search (e.g. CSCE 500+) replaces it
        const levelMode = '';
        const levelValue = 0;

        // Size filter
        const sizeMode = document.getElementById('filter-size-mode').value;
        const sizeValue = parseInt(document.getElementById('filter-size-value').value) || 0;

        // Availability filter
        const availMode = document.getElementById('filter-avail-mode').value;
        const availValue = parseInt(document.getElementById('filter-avail-value').value) || 0;

        if (!rawInput) {
            this.showHint('Enter a subject code (CSCE), course number (CSCE 145), range (CSCE 500+), or keyword.');
            return;
        }

        const kw = rawInput.trim();
        const criteria = [];
        let subject = '';
        let courseNumberFilter = null;   // exact match (e.g. "145" or "145L")
        let courseRangeFilter = null;     // function(code) → boolean for +, wildcards, partial

        // Wildcard characters that stand for "any digit"
        const WILDCARD = /[xX*#_?%]/;
        const hasWildcard = (s) => WILDCARD.test(s);

        // Build a filter function from a number pattern with wildcards/+/partial
        const buildRangeFilter = (numPart) => {
            // Plus suffix: CSCE 500+ → >= 500, optional letter suffix on courses
            if (/^\d{1,3}\+$/.test(numPart)) {
                const floor = parseInt(numPart.slice(0, -1));
                return (code) => {
                    const m = code.match(/^[A-Z]+\s*(\d{3})/i);
                    return m && parseInt(m[1]) >= floor;
                };
            }
            // Wildcard pattern: digits + wildcards + optional trailing letter
            // e.g. "5xx", "55x", "x77", "5x7", "3xxL"
            const wcMatch = numPart.match(/^([\dxX*#_?%]{1,3})([A-Za-z]?)$/);
            if (wcMatch && hasWildcard(wcMatch[1])) {
                const digits = wcMatch[1];
                const suffix = wcMatch[2].toUpperCase();
                // Pad to 3 chars by appending wildcards (so "5" + wildcard = "5xx")
                const padded = (digits + 'xx').slice(0, 3);
                const reStr = padded.replace(/[xX*#_?%]/g, '\\d');
                const numRe = new RegExp('^' + reStr + '$');
                return (code) => {
                    const m = code.match(/^[A-Z]+\s*(\d{3})([A-Za-z]?)$/i);
                    if (!m) return false;
                    if (!numRe.test(m[1])) return false;
                    if (suffix && m[2].toUpperCase() !== suffix) return false;
                    return true;
                };
            }
            return null;
        };

        // Parse the input to determine what the user wants

        // 3-4 letter subject code only (e.g. "CSCE", "MATH")
        if (/^[A-Za-z]{3,4}$/i.test(kw)) {
            subject = this._resolveSubject(kw);
            if (!subject) return;
            document.getElementById('keyword-input').value = subject;
            criteria.push({ field: 'subject', value: subject });

        // Range/wildcard course code: "CSCE 500+", "CSCE 5xx", "CSCE 5xxL", "CSCE x77"
        } else if (/^[A-Za-z]{3,4}\s*[\dxX*#_?%]{1,3}\+?[A-Za-z]?$/i.test(kw) &&
                   (kw.includes('+') || hasWildcard(kw))) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*([\dxX*#_?%]{1,3}\+?[A-Za-z]?)$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            const numPart = m[2].toUpperCase();
            courseRangeFilter = buildRangeFilter(numPart);
            if (!courseRangeFilter) {
                this.showHint('Invalid range pattern. Try CSCE 500+, CSCE 5xx, or CSCE 5xxL.');
                return;
            }
            criteria.push({ field: 'subject', value: subject });

        // Partial course number: "CSCE 5" or "CSCE 55" → prefix match (implicit wildcards)
        } else if (/^[A-Za-z]{3,4}\s*\d{1,2}$/i.test(kw)) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{1,2})$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            const partial = m[2];
            const padded = (partial + 'xx').slice(0, 3);
            const reStr = padded.replace(/x/g, '\\d');
            const numRe = new RegExp('^' + reStr + '$');
            courseRangeFilter = (code) => {
                const cm = code.match(/^[A-Z]+\s*(\d{3})/i);
                return cm && numRe.test(cm[1]);
            };
            criteria.push({ field: 'subject', value: subject });

        // Full course code: "CSCE 145" or "CSCE145" or "csce 145"
        } else if (/^[A-Za-z]{3,4}\s*\d{3}[A-Za-z]?$/i.test(kw)) {
            const m = kw.match(/^([A-Za-z]{3,4})\s*(\d{3}[A-Za-z]?)$/i);
            subject = this._resolveSubject(m[1]);
            if (!subject) return;
            const num = m[2].toUpperCase();
            const normalized = subject + ' ' + num;
            document.getElementById('keyword-input').value = normalized;
            criteria.push({ field: 'alias', value: normalized });

        // 5-digit CRN
        } else if (/^\d{5}$/.test(kw)) {
            criteria.push({ field: 'crn', value: kw });

        // 4 digits — invalid
        } else if (/^\d{4}$/.test(kw)) {
            this.showHint('4-digit numbers are not valid. Enter a 3-digit course number (e.g. CSCE 101) or a 5-digit CRN.');
            return;

        // 3 digits + optional letter — need subject prefix
        } else if (/^\d{3}\s?[A-Za-z]?$/.test(kw)) {
            this.showHint('Include the subject code (e.g. CSCE 101, not just 101).');
            return;

        // 1-2 digits
        } else if (/^\d{1,2}$/.test(kw)) {
            this.showHint('Enter a subject code (e.g. CSCE) or full course number (e.g. CSCE 101).');
            return;

        // Text keyword — require 5+ characters
        } else if (kw.length < 5) {
            this.showHint('Keywords must be at least 5 characters. For courses, enter a subject code (e.g. CSCE) or course number (e.g. CSCE 145).');
            return;

        // Valid text keyword
        } else {
            criteria.push({ field: 'keyword', value: kw });
        }

        if (openOnly) criteria.push({ field: 'stat', value: 'A' });

        this.showLoading();
        const searchId = ++this._searchId;

        try {
            let results = [];
            let totalCount = 0;

            if (currentTermOnly) {
                // Search live class offerings for the selected term
                const data = await API.searchCourses(State.term, criteria);
                results = data.results || [];
                totalCount = data.count || 0;
            } else {
                // Search the bulletin catalog (all courses, not term-specific)
                if (!subject) {
                    this.showHint('Pick a subject to browse the full catalog.');
                    return;
                }
                const bulletinData = await API.bulletinSearch(subject);
                const bulletinCourses = bulletinData.results || [];

                // Also fetch live term data to cross-reference availability
                const liveCriteria = [{ field: 'subject', value: subject }];
                const liveData = await API.searchCourses(State.term, liveCriteria);
                const liveResults = liveData.results || [];

                // Build a set of course codes offered this term + their open status
                const liveByCode = {};
                liveResults.forEach(r => {
                    if (!liveByCode[r.code]) {
                        liveByCode[r.code] = { hasOpen: false, sections: 0 };
                    }
                    liveByCode[r.code].sections++;
                    if (r.stat === 'A') liveByCode[r.code].hasOpen = true;
                });

                // Convert bulletin results, merging live availability info
                results = bulletinCourses.map(c => {
                    const live = liveByCode[c.code];
                    return {
                        code: c.code,
                        title: c.title || c.name || '',
                        crn: '',
                        section: 'CAT',
                        stat: live ? (live.hasOpen ? 'A' : 'F') : '',
                        instr: '',
                        meets: live ? `${live.sections} section${live.sections !== 1 ? 's' : ''} this term` : 'Not offered this term',
                        meetingTimes: null,
                        total: '',
                        key: c.key,
                        _isCatalog: true,
                        _offeredThisTerm: !!live,
                        _hasOpen: live ? live.hasOpen : false,
                    };
                });
                totalCount = results.length;

                // Apply keyword course number filter to catalog results
                if (courseNumberFilter) {
                    results = results.filter(r => {
                        const codeNum = (r.code || '').replace(/^[A-Z]+\s*/i, '').toUpperCase();
                        return codeNum === courseNumberFilter;
                    });
                    courseNumberFilter = null; // already applied
                }
            }

            // Client-side filters

            // Range/wildcard filter (from patterns like "500+", "5xx", "55x", "x77", "3xxL")
            if (courseRangeFilter) {
                results = results.filter(r => courseRangeFilter(r.code || ''));
            }

            // Course number filter (from 3-digit input like "101" or "101L")
            if (courseNumberFilter) {
                results = results.filter(r => {
                    const codeNum = (r.code || '').replace(/^[A-Z]+\s*/i, '').toUpperCase();
                    return codeNum === courseNumberFilter;
                });
            }

            // Level filter
            if (levelMode && levelValue) {
                results = results.filter(r => {
                    const num = parseInt((r.code || '').replace(/[A-Z\s]+/g, ''));
                    if (!num) return true;
                    const level = Math.floor(num / 100) * 100;
                    if (levelMode === 'exact') return level === levelValue;
                    if (levelMode === 'above') return num >= levelValue;
                    if (levelMode === 'below') return num < levelValue;
                    return true;
                });
            }

            // Size filter (total seats)
            if (sizeMode && sizeValue) {
                results = results.filter(r => {
                    const total = parseInt(r.total) || 0;
                    if (sizeMode === 'above') return total >= sizeValue;
                    if (sizeMode === 'below') return total < sizeValue;
                    return true;
                });
            }

            // Availability filter (seats remaining)
            // The API gives 'stat' (A=open) and 'total' but not remaining directly.
            // We'll need to fetch details for this. For now, filter on total and stat.
            // We store a flag to do detailed seat filtering after render.
            this._pendingAvailFilter = (availMode && availValue) ? { mode: availMode, value: availValue } : null;

            // If a newer search was started, discard these results
            if (searchId !== this._searchId) return;

            // Skip bulk prereq fetch — prereqs load on-demand when a course is clicked
            const prereqData = this._prereqCache[subject] || {};

            this.renderResults(results, totalCount || results.length, prereqData, eligibleOnly);
        } catch (err) {
            this.showHint('Search failed. Try again.');
        }
    },

    async fetchPrereqForCourse(courseCode) {
        // Fetch prereq data for a single course (on-demand, cached)
        const subject = courseCode.split(' ')[0];
        if (!this._prereqCache[subject]) this._prereqCache[subject] = {};
        if (this._prereqCache[subject][courseCode]) return this._prereqCache[subject][courseCode];

        try {
            const search = await API.bulletinSearch(subject);
            const courses = search.results || [];
            const target = courses.find(c => c.code === courseCode);
            if (!target) return { prereqs: [], raw: '' };

            const details = await API.bulletinDetails(target.key);
            const prereqHtml = details.prereq || '';
            const codes = (prereqHtml.match(/[A-Z]{3,4}\s+\d{3}[A-Z]?/g) || []);
            const result = {
                prereqs: [...new Set(codes)],
                raw: prereqHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            };
            this._prereqCache[subject][courseCode] = result;
            return result;
        } catch (e) {
            return { prereqs: [], raw: '' };
        }
    },

    checkEligibility(courseCode, prereqData) {
        const info = prereqData[courseCode];
        if (!info || info.prereqs.length === 0) return { eligible: true, missing: [], noData: !info };
        const completed = new Set(State.completedCourses);
        const missing = info.prereqs.filter(p => !completed.has(p));
        return { eligible: missing.length === 0, missing, noData: false };
    },

    renderResults(results, count, prereqData, eligibleOnly) {
        const container = document.getElementById('search-results');

        if (results.length === 0) {
            container.innerHTML = '<p class="hint">No results found.</p>';
            return;
        }

        // Group by course code
        const groups = {};
        results.forEach(r => {
            const code = r.code;
            if (!groups[code]) groups[code] = { code, title: r.title, sections: [] };
            groups[code].sections.push(r);
        });

        let groupList = Object.values(groups);

        // Filter by eligibility if requested
        if (eligibleOnly) {
            groupList = groupList.filter(g => {
                const elig = this.checkEligibility(g.code, prereqData);
                return elig.eligible;
            });
        }

        State.courseGroups = groupList;

        container.innerHTML = `<p style="font-size:0.75rem;color:#555;margin-bottom:6px;font-weight:600">${groupList.length} courses (${count} total sections)</p>`;

        groupList.forEach(group => {
            const div = document.createElement('div');
            div.className = 'course-group';

            const isCatalog = group.sections.some(s => s._isCatalog);
            let badgeClass, badgeText;
            if (isCatalog) {
                const offeredThisTerm = group.sections.some(s => s._offeredThisTerm);
                const hasOpen = group.sections.some(s => s._hasOpen);
                if (offeredThisTerm && hasOpen) {
                    badgeClass = 'badge-open';
                    badgeText = this.shortTermLabel(State.term);
                } else if (offeredThisTerm) {
                    badgeClass = 'badge-full';
                    badgeText = 'FULL';
                } else {
                    badgeClass = 'badge-na';
                    badgeText = 'N/A';
                }
            } else {
                const hasOpen = group.sections.some(s => s.stat === 'A');
                if (hasOpen) {
                    badgeClass = 'badge-open';
                    badgeText = this.shortTermLabel(State.term);
                } else {
                    badgeClass = 'badge-full';
                    badgeText = 'FULL';
                }
            }

            // Eligibility badge
            const elig = this.checkEligibility(group.code, prereqData);
            let eligBadge = '';
            if (State.completedCourses.length > 0 && !elig.noData) {
                if (elig.eligible) {
                    eligBadge = '<span class="badge badge-eligible" style="margin-left:4px">CAN TAKE</span>';
                } else {
                    eligBadge = `<span class="badge badge-prereq-missing" style="margin-left:4px" title="Missing: ${elig.missing.join(', ')}">PREREQS NEEDED</span>`;
                }
            }

            div.innerHTML = `
                <div class="course-header">
                    <span><span class="code">${group.code}</span><span class="title">${group.title}</span>${eligBadge}</span>
                    <span class="badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="course-sections"></div>
            `;

            const header = div.querySelector('.course-header');
            const sectionsDiv = div.querySelector('.course-sections');

            header.addEventListener('click', () => {
                // Collapse all other course sections and remove active highlight
                const isExpanding = !sectionsDiv.classList.contains('expanded');
                document.querySelectorAll('#search-results .course-group.active').forEach(g => g.classList.remove('active'));
                document.querySelectorAll('#search-results .course-sections.expanded').forEach(s => {
                    if (s !== sectionsDiv) s.classList.remove('expanded');
                });
                sectionsDiv.classList.toggle('expanded', isExpanding);
                div.classList.toggle('active', isExpanding);
                // Load course info using the first section's data
                const firstSec = group.sections[0];
                if (firstSec) {
                    if (typeof Prereqs !== 'undefined' && Prereqs.loadForCourse) {
                        Prereqs.loadForCourse(firstSec.code);
                    }
                    if (typeof History !== 'undefined' && History.loadForCourse) {
                        History.loadForCourse(firstSec.code);
                    }
                    // Show course-level details (not section-specific)
                    const detailsTab = document.getElementById('tab-details');
                    if (detailsTab) {
                        detailsTab.innerHTML = `
                            <h3>${firstSec.code} - ${firstSec.title}</h3>
                            <p><strong>Sections available:</strong> ${group.sections.length}</p>
                            <p class="loading">Loading details</p>
                        `;
                        const subject = firstSec.code.split(' ')[0];
                        API.bulletinSearch(subject).then(search => {
                            const target = (search.results || []).find(c => c.code === firstSec.code);
                            if (!target) return;
                            return API.bulletinDetails(target.key);
                        }).then(details => {
                            if (!details) return;
                            const desc = (details.description || '').replace(/<[^>]+>/g, ' ').trim();
                            detailsTab.innerHTML = `
                                <h3>${firstSec.code} - ${details.title || firstSec.title}</h3>
                                <p><strong>Credits:</strong> ${details.hours_html || 'N/A'}</p>
                                <p><strong>Sections available:</strong> ${group.sections.length}</p>
                                ${desc ? `<p><strong>Description:</strong> ${desc.substring(0, 400)}${desc.length > 400 ? '...' : ''}</p>` : ''}
                            `;
                        }).catch(() => {
                            detailsTab.querySelector('.loading')?.remove();
                        });
                    }
                }
            });

            group.sections.forEach(sec => {
                const row = document.createElement('div');
                const isAdded = State.isSelected(sec.crn);
                row.className = 'section-row' + (isAdded ? ' selected' : '');
                const statusDot = sec.stat === 'A'
                    ? '<span style="color:#2e7d32;font-weight:700">&#9679;</span>'
                    : '<span style="color:#c62828;font-weight:700">&#9679;</span>';
                row.innerHTML = `
                    <span class="sec-status">${statusDot}</span>
                    <span class="sec-id">${sec.section}</span>
                    <span class="sec-instr">${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')}</span>
                    <span class="sec-time">${sec.meets || 'TBA'}</span>
                `;

                // Clicking the row shows details in the main content panel
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Clear all viewing highlights across all course groups
                    document.querySelectorAll('#search-results .section-row.viewing').forEach(r => r.classList.remove('viewing'));
                    row.classList.add('viewing');
                    // Show section details with Add to Schedule button in main panel
                    Search.showSectionDetail(sec);
                });
                row.dataset.crn = sec.crn;
                sectionsDiv.appendChild(row);
            });

            container.appendChild(div);
        });
    },

    showSectionDetail(sec) {
        const detailsTab = document.getElementById('tab-details');
        if (!detailsTab) return;

        const isAdded = State.isSelected(sec.crn);
        const btnLabel = isAdded ? 'REMOVE FROM SCHEDULE' : 'ADD TO SCHEDULE';
        const btnClass = isAdded ? 'btn-danger' : 'btn-green';

        detailsTab.innerHTML = `
            <h3>${sec.code} - ${sec.title}</h3>
            <p><strong>Section:</strong> ${sec.section} (CRN: ${sec.crn})</p>
            <p><strong>Instructor:</strong> ${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')}</p>
            <p><strong>Meets:</strong> ${sec.meets || 'TBA'}</p>
            <p><strong>Method:</strong> ${sec.inst_mthd || 'N/A'}</p>
            <p><strong>Status:</strong> ${sec.stat === 'A' ? '<span style="color:#2e7d32;font-weight:700">Open</span>' : '<span style="color:#c62828;font-weight:700">Full</span>'}</p>
            <div class="section-actions">
                <button id="btn-section-toggle" class="${btnClass}" style="margin-top:10px">${btnLabel}</button>
                <button id="btn-view-schedule" class="btn-garnet" style="margin-top:10px">VIEW SCHEDULE</button>
            </div>
            <p class="loading">Loading details</p>
        `;

        // Bind Add/Remove button
        document.getElementById('btn-section-toggle').addEventListener('click', () => {
            State.toggleSection(sec);
            // Re-render to update button state
            this.showSectionDetail(sec);
            // Update the search results row styling
            const row = document.querySelector(`.section-row[data-crn="${sec.crn}"]`);
            if (row) row.classList.toggle('selected', State.isSelected(sec.crn));
        });

        // Bind View Schedule button
        document.getElementById('btn-view-schedule').addEventListener('click', () => {
            if (typeof Tabs !== 'undefined') Tabs.switchTo('schedule');
        });

        // Fetch full details
        API.getDetails(sec.crn, State.term).then(data => {
            const seatsMatch = (data.seats || '').match(/seats_avail[^>]*>(\d+)/);
            const maxMatch = (data.seats || '').match(/seats_max[^>]*>(\d+)/);
            const seats = seatsMatch ? seatsMatch[1] : '?';
            const max = maxMatch ? maxMatch[1] : '?';
            const desc = (data.description || '').replace(/<[^>]+>/g, ' ').trim();
            const meeting = this.parseMeetingHtml(data.meeting_html);
            const timesStr = meeting.times.length > 0 ? meeting.times.join('; ') : (sec.meets || 'TBA');
            const locsStr = meeting.locations.length > 0 ? meeting.locations.join('; ') : 'TBA';
            const locLabel = meeting.locations.length > 1 ? 'Locations' : 'Location';

            const isAdded2 = State.isSelected(sec.crn);
            const btnLabel2 = isAdded2 ? 'REMOVE FROM SCHEDULE' : 'ADD TO SCHEDULE';
            const btnClass2 = isAdded2 ? 'btn-danger' : 'btn-green';

            detailsTab.innerHTML = `
                <h3>${sec.code} - ${sec.title}</h3>
                <p><strong>Section:</strong> ${sec.section} (CRN: ${sec.crn})</p>
                <p><strong>Instructor:</strong> ${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')}</p>
                <p><strong>Class Times:</strong> ${timesStr}</p>
                <p><strong>${locLabel}:</strong> ${locsStr}</p>
                <p><strong>Credits:</strong> ${data.hours_html || 'N/A'}</p>
                <p><strong>Seats:</strong> <span class="seats-info">${seats} / ${max} available</span></p>
                <p><strong>Method:</strong> ${data.inst_mthd || sec.inst_mthd || 'N/A'}</p>
                ${desc ? `<p><strong>Description:</strong> ${desc.substring(0, 400)}${desc.length > 400 ? '...' : ''}</p>` : ''}
                ${data.clssnotes ? `<p><strong>Notes:</strong> ${data.clssnotes.replace(/<[^>]+>/g, ' ').trim()}</p>` : ''}
                <div class="section-actions">
                    <button id="btn-section-toggle" class="${btnClass2}" style="margin-top:10px">${btnLabel2}</button>
                    <button id="btn-view-schedule" class="btn-garnet" style="margin-top:10px">VIEW SCHEDULE</button>
                </div>
            `;

            document.getElementById('btn-section-toggle').addEventListener('click', () => {
                State.toggleSection(sec);
                this.showSectionDetail(sec);
                const row = document.querySelector(`.section-row[data-crn="${sec.crn}"]`);
                if (row) row.classList.toggle('selected', State.isSelected(sec.crn));
            });

            document.getElementById('btn-view-schedule').addEventListener('click', () => {
                if (typeof Tabs !== 'undefined') Tabs.switchTo('schedule');
            });
        }).catch(() => {
            detailsTab.querySelector('.loading')?.remove();
        });
    },

    parseMeetingHtml(meetingHtml) {
        // Parse meeting_html to extract separate times and locations
        // Format: <div class="meet">MW 10:50am-11:40am<span ...> in <a ...>Sumwalt College 305</a></span></div>
        if (!meetingHtml) return { times: [], locations: [] };

        const times = [];
        const locationSet = new Set();

        // Match each <div class="meet"> block
        const meetBlocks = meetingHtml.match(/<div class="meet">[^]*?<\/div>/gi) || [meetingHtml];

        meetBlocks.forEach(block => {
            // Extract time: text before the <span
            const timeMatch = block.match(/<div class="meet">\s*([^<]+)/i);
            if (timeMatch) {
                times.push(timeMatch[1].trim());
            }

            // Extract location from <a> tag
            const locMatch = block.match(/<a[^>]*>([^<]+)<\/a>/i);
            if (locMatch) {
                locationSet.add(this.abbreviateBuilding(locMatch[1].trim()));
            }
        });

        return {
            times: times,
            locations: [...locationSet],
        };
    },

    abbreviateBuilding(fullName) {
        // Official UofSC registrar building codes
        // Source: sc.edu/about/offices_and_divisions/registrar/toolbox/scheduling/classroom_capacities/
        // Keys match the actual strings returned by the classes.sc.edu API
        const abbrevs = {
            'Swearingen Engr Ctr': 'SWGN',
            'Swearingen': 'SWGN',
            'Sumwalt College': 'SMWALT',
            'Close-Hipp Building': 'CLHIPP',
            'Close-Hipp': 'CLHIPP',
            'Gambrell': 'GAMBRL',
            'Hamilton College': 'HAMLTN',
            'Humanities Classroom': 'HUMCB',
            'Jones Physical Sci Ctr': 'JONES',
            'Jones Physical Sci': 'JONES',
            'Leconte College': 'LCONTE',
            'LeConte College': 'LCONTE',
            'Coker Life Science': 'COKER',
            'Coker Life Sciences': 'COKER',
            'Callcot Soc Sci Ctr': 'CLLCTT',
            'Callcott': 'CLLCTT',
            'Byrnes': 'BYRNES',
            'Currell College': 'CRRELL',
            'Wardlaw College': 'WRDLAW',
            'Wardlaw Coll': 'WRDLAW',
            'Petigru College': 'PETIGR',
            'Sloan College': 'SLOAN',
            'McMaster College': 'MCMSTR',
            'Carolina Coliseum': 'COL',
            'Blatt PE Center': 'BLATT',
            'Darla Moore Sch of Bus': 'DMSB',
            'Darla Moore': 'DMSB',
            'Moore School of Bus': 'DMSB',
            'Davis College': 'DAVIS',
            'Flinn Hall': 'FLINN',
            'Flinn': 'FLINN',
            'Columbia Hall': 'COLH',
            'Science and Technology Bldg': '1112GR',
            'Science and Technology': '1112GR',
            'WMBB Nursing': 'WMBB',
            'Nursing Building': 'WMBB',
            'Horizon': 'HZNPG',
            'Public Health Research': 'PHRC',
            'Public Hlth Res': 'PHRC',
            'Booker T Washington': 'BTWASH',
            'Booker T. Washington': 'BTWASH',
            '300 Main': '300MN',
            'Band Dance': 'BANDDF',
            'ROTC': 'ROTC',
            'Sch of Jour': 'SJMC',
        };

        // Try to match known building names (API returns "Building Room")
        for (const [apiName, code] of Object.entries(abbrevs)) {
            if (fullName.startsWith(apiName)) {
                const room = fullName.slice(apiName.length).trim();
                return room ? `${code} ${room} (${apiName})` : `${code} (${apiName})`;
            }
        }

        // Fallback: just return what the API gave us (already fairly short)
        return fullName;
    },

    shortTermLabel(termCode) {
        const year = termCode.slice(2, 4);
        const sem = termCode.slice(4);
        const semLabel = { '01': 'Sp', '05': 'Su', '08': 'Fa' }[sem] || sem;
        return `${semLabel}${year}`;
    },

    showLoading() {
        document.getElementById('search-results').innerHTML = '<p class="loading">Searching courses</p>';
    },

    showHint(msg) {
        document.getElementById('search-results').innerHTML = `<p class="hint">${msg}</p>`;
    },
};
