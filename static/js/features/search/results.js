/*
 * Rendering results, progress, and error states.
 *
 * One of five parts of the search feature, which was a single 4,248-line
 * module. Each part is a factory returning plain methods; index.js merges them
 * onto one object, so `this` still reaches every method regardless of which
 * file it lives in and no call site changed.
 *
 * The split is at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly -- asserted before anything was
 * written. Sorting or regrouping methods would not have that property.
 */
(function initResultsPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SearchParts) root.SearchParts = {};
    root.SearchParts.createResultsPart = api.createResultsPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createResultsPart(deps) {
        return {
        observeCourseResultSummary(element, group) {
            if (typeof IntersectionObserver === 'undefined') return;
            if (!this._resultSummaryObserver) {
                this._resultSummaryObserver = new IntersectionObserver(entries => {
                    entries.forEach(entry => {
                        if (!entry.isIntersecting) return;
                        this._resultSummaryObserver.unobserve(entry.target);
                        const code = entry.target.dataset.courseCode;
                        const matchedGroup = (deps.state.courseGroups || []).find(item => item.code === code);
                        if (matchedGroup) this.hydrateCourseResultSummary(entry.target, matchedGroup);
                    });
                }, {
                    root: document.getElementById('search-results'),
                    rootMargin: '160px 0px',
                });
            }
            element.dataset.courseCode = group.code;
            this._resultSummaryObserver.observe(element);
        },

        async hydrateCourseResultSummary(element, group) {
            if (!this._resultSummaryCache[group.code]) {
                this._resultSummaryCache[group.code] = Promise.allSettled([
                    this.fetchBulletinDetailsForCourse(group.code),
                    deps.api.getCourseGrades(group.code),
                ]).then(([detailsResult, gradesResult]) => ({
                    details: detailsResult.status === 'fulfilled' ? detailsResult.value : {},
                    grades: gradesResult.status === 'fulfilled' && !gradesResult.value?.error
                        ? gradesResult.value
                        : {},
                }));
            }
            const { details, grades } = await this._resultSummaryCache[group.code];
            if (!element.isConnected) return;
            const fullDescription = String(details?.description || '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const description = fullDescription
                ? `${fullDescription.slice(0, 185)}${fullDescription.length > 185 ? '…' : ''}`
                : 'Course description unavailable.';
            const averageGpa = Number(grades?.average_gpa);
            const gradedStudents = Number(grades?.graded_students || 0);
            element.innerHTML = `
                <p class="course-result-description">${this.escapeText(description)}</p>
                ${Number.isFinite(averageGpa) && averageGpa > 0
                    ? `<p class="course-result-grade"><strong>${averageGpa.toFixed(2)} historical GPA</strong><span>${gradedStudents.toLocaleString()} grades</span></p>`
                    : '<p class="course-result-grade unavailable">Historical grades unavailable</p>'}
            `;
        },

        generatedSearchesMarkup(searchTerms) {
            if (!searchTerms?.length) return '';
            const expandedTags = searchTerms.map((search, index) => {
                const term = typeof search === 'string' ? search : search.term;
                const failed = typeof search === 'object' && Boolean(search.failed);
                const catalogSource = typeof search === 'object'
                    && search.kind === 'semantic-catalog';
                const resultCount = typeof search === 'string' ? null : Number(search.count);
                const countLabel = failed
                    ? 'Search failed'
                    : Number.isFinite(resultCount)
                        ? `${resultCount.toLocaleString()} ${resultCount === 1 ? 'course' : 'courses'}`
                        : '';
                const disabled = !failed && Number.isFinite(resultCount) && resultCount === 0
                    ? ' disabled'
                    : '';
                const failedClass = failed ? ' is-failed' : '';
                const dataCount = failed ? -1 : (resultCount || 0);
                const content = `<span>${this.escapeText(term)}</span>${countLabel ? `<strong>${countLabel}</strong>` : ''}`;
                if (catalogSource) {
                    return `<div class="semantic-search-term is-catalog" data-result-count="${dataCount}" title="Courses found by comparing your request with the local course catalog">${content}</div>`;
                }
                return `<button type="button" class="semantic-search-term${failedClass}" data-regular-search-index="${index}" data-result-count="${dataCount}"${disabled}>${content}</button>`;
            }).join(' ');
            return `
                <div class="semantic-search-terms">
                    <button type="button" class="semantic-search-terms-toggle" aria-expanded="false" aria-controls="semantic-search-term-list">
                        <span><b>${searchTerms.length} Search sources</b></span><i aria-hidden="true">&#9660;</i>
                    </button>
                    <div id="semantic-search-term-list" class="semantic-search-term-list hidden">${expandedTags}</div>
                </div>`;
        },

        bindGeneratedSearches(container, searchTerms) {
            const searchTermsToggle = container.querySelector('.semantic-search-terms-toggle');
            const searchTermsList = container.querySelector('.semantic-search-term-list');
            searchTermsToggle?.addEventListener('click', () => {
                const willExpand = searchTermsList?.classList.contains('hidden');
                searchTermsList?.classList.toggle('hidden', !willExpand);
                searchTermsToggle.setAttribute('aria-expanded', String(willExpand));
            });
            container.querySelectorAll('[data-regular-search-index]').forEach(button => {
                button.addEventListener('click', () => {
                    const search = searchTerms[Number(button.dataset.regularSearchIndex)];
                    const term = typeof search === 'string' ? search : search?.term;
                    if (term) this.openRegularSearch(term);
                });
            });
        },

        renderResults(results, count, prereqData, eligibleOnly, searchTerms) {
            const container = document.getElementById('search-results');
            this.setBrowseState('results');
            const fallbackNotice = this._semanticFallbackNotice;
            this._semanticFallbackNotice = '';

            if (results.length === 0) {
                deps.state.courseGroups = [];
                container.innerHTML = `${fallbackNotice ? `<p class="search-fallback-notice">${this.escapeText(fallbackNotice)}</p>` : ''}<p class="hint">No results found.</p>${this.generatedSearchesMarkup(searchTerms)}`;
                this.bindGeneratedSearches(container, searchTerms || []);
                return;
            }

            // Group by course code, preserving relevance order
            const groups = {};
            const groupOrder = [];
            results.forEach(r => {
                const code = r.code;
                if (!groups[code]) {
                    groups[code] = { code, title: r.title, sections: [], _relevanceScore: r._relevanceScore || 0 };
                    groupOrder.push(code);
                }
                groups[code].sections.push(r);
                // Keep the highest relevance score for the group
                if ((r._relevanceScore || 0) > groups[code]._relevanceScore) {
                    groups[code]._relevanceScore = r._relevanceScore;
                }
            });

            let groupList = groupOrder.map(code => groups[code]);

            // If semantic search, sort groups by relevance score
            if (searchTerms) {
                groupList.sort((a, b) => b._relevanceScore - a._relevanceScore);
            }

            // Filter by eligibility if requested
            if (eligibleOnly) {
                groupList = groupList.filter(g => {
                    const elig = this.checkEligibility(g.code, prereqData);
                    return elig.eligible;
                });
            }

            deps.state.courseGroups = groupList;

            // Header with compact search information
            const courseLabel = groupList.length === 1 ? 'course' : 'courses';
            const hasUnknownAvailability = groupList.some(group => (
                group.sections.some(section => section.availability_unknown)
            ));
            const sectionLabel = count === 1 ? 'section' : 'sections';
            const sectionSummary = hasUnknownAvailability
                ? 'Live section totals unavailable'
                : `${count} total ${sectionLabel}`;
            let header = `<div class="browse-results-summary"><strong>${groupList.length} ${courseLabel}</strong><span>${sectionSummary}</span></div>`;
            if (this._relatedSearchOrigin) {
                const origin = this.escapeText(this._relatedSearchOrigin);
                header = `<button type="button" class="related-search-back" aria-label="Back to search for ${origin}"><span class="related-search-back-icon" aria-hidden="true">&larr;</span><span class="related-search-back-copy"><small>Back to search</small><strong>${origin}</strong></span></button>${header}`;
            }
            if (fallbackNotice) {
                header += `<p class="search-fallback-notice">${this.escapeText(fallbackNotice)}</p>`;
            }
            header += this.generatedSearchesMarkup(searchTerms);
            container.innerHTML = header;
            this.bindGeneratedSearches(container, searchTerms || []);
            container.querySelector('.related-search-back')?.addEventListener('click', () => this.returnToMainSearch());

            groupList.forEach(group => {
                const div = document.createElement('div');
                div.className = 'course-group';
                div.dataset.courseCode = group.code;
                div.tabIndex = 0;
                div.setAttribute('role', 'button');
                div.setAttribute('aria-label', `View details for ${group.code} ${group.title || ''}`);
                const availability = this.courseAvailability(group);
                const liveSections = group.sections.filter(section => !section._isCatalog);
                const instructors = new Set(liveSections
                    .map(section => (section.instructor || section.instr))
                    .filter(name => name && name !== 'Staff'));
                const sectionLabel = availability.kind === 'unknown'
                    ? 'Live section details unavailable'
                    : `${liveSections.length} ${liveSections.length === 1 ? 'section' : 'sections'}`;
                const instructorLabel = availability.kind === 'unknown'
                    ? ''
                    : instructors.size
                        ? `${instructors.size} ${instructors.size === 1 ? 'instructor' : 'instructors'}`
                        : 'Instructor TBA';

                // Eligibility badge
                const elig = this.checkEligibility(group.code, prereqData);
                let eligBadge = '';
                if (deps.state.completedCourses.length > 0 && !elig.noData) {
                    if (elig.eligible) {
                        eligBadge = '<span class="badge badge-eligible" style="margin-left:4px">CAN TAKE</span>';
                    } else {
                        eligBadge = `<span class="badge badge-prereq-missing" style="margin-left:4px" title="Missing: ${elig.missing.join(', ')}">PREREQS NEEDED</span>`;
                    }
                }

                div.innerHTML = `
                    <div class="course-header">
                        <div class="course-header-main"><span class="code">${group.code}</span><span class="title">${group.title}</span>${eligBadge}</div>
                        <div class="course-availability ${availability.kind}">${availability.text}</div>
                        <div class="course-result-meta">${sectionLabel}${instructorLabel ? ` · ${instructorLabel}` : ''}</div>
                    </div>
                    <div class="course-result-summary"><p class="course-result-description loading">Loading course summary</p></div>
                `;

                const summary = div.querySelector('.course-result-summary');
                div.classList.toggle('course-added', deps.state.isCourseSelected(group.code));

                const openDetail = () => {
                    this._lastDetailTrigger = div;
                    this.showCourseDetail(group);
                };
                div.addEventListener('click', openDetail);
                div.addEventListener('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openDetail();
                });

                container.appendChild(div);
                this.observeCourseResultSummary(summary, group);
            });
        },

        showSectionDetail(sec) {
            const group = (deps.state.courseGroups || []).find(item => item.code === sec.code) || {
                code: sec.code,
                title: sec.title,
                sections: [sec],
            };
            if (this.detailRouteState().code !== sec.code) this.showCourseDetail(group);
            this.selectDetailSection(sec.crn);
            document.getElementById('course-section-picker-wrap')?.scrollIntoView({ block: 'start' });
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
                    times.push(this.decodeHtmlEntities(timeMatch[1].trim()));
                }

                // Extract location from <a> tag
                const locMatch = block.match(/<a[^>]*>([^<]+)<\/a>/i);
                if (locMatch) {
                    locationSet.add(this.abbreviateBuilding(
                        this.decodeHtmlEntities(locMatch[1].trim()),
                    ));
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

        showSearchProgress({ phase, completed = 0, total = 0, candidates = 0 }) {
            if (typeof document === 'undefined') return;
            const container = document.getElementById('search-results');
            if (!container) return;
            const safeTotal = Math.max(total, completed, 1);
            let title = `${completed} of up to ${total} searches complete`;
            let detail = candidates
                ? `${candidates.toLocaleString()} candidate ${candidates === 1 ? 'course' : 'courses'} found`
                : 'Finding relevant course matches';
            if (phase === 'planned') {
                title = `Preparing up to ${total} generated searches`;
                detail = 'Building search variations';
            } else if (phase === 'combining') {
                title = `${completed} searches complete`;
                detail = `Combining ${candidates.toLocaleString()} candidate courses`;
            } else if (phase === 'filtering') {
                title = `${completed} searches complete`;
                detail = `Applying filters to ${candidates.toLocaleString()} candidate courses`;
            }
            container.innerHTML = `
                <div class="search-progress" role="status" aria-live="polite">
                    <div><strong>${title}</strong><span>${detail}</span></div>
                    <progress value="${Math.min(completed, safeTotal)}" max="${safeTotal}">${completed} of ${safeTotal}</progress>
                </div>`;
        },

        showLoading(label = 'Searching courses') {
            document.getElementById('search-results').innerHTML = `<p class="loading">${label}</p>`;
        },

        clearSearchErrors() {
            ['search-input-error', 'filter-scope-error'].forEach(id => {
                const element = document.getElementById(id);
                if (!element) return;
                element.textContent = '';
                element.classList.add('hidden');
            });
            ['filter-scope-subjects', 'filter-scope-numbers'].forEach(id => {
                document.getElementById(id)?.removeAttribute('aria-invalid');
            });
            document.getElementById('keyword-input')?.removeAttribute('aria-invalid');
        },

        showSearchError(message, { scope = false } = {}) {
            const topError = document.getElementById('search-input-error');
            if (topError) {
                topError.textContent = message;
                topError.classList.remove('hidden');
            }
            if (!scope) document.getElementById('keyword-input')?.setAttribute('aria-invalid', 'true');
            if (!scope) return;
            const scopeError = document.getElementById('filter-scope-error');
            if (scopeError) {
                scopeError.textContent = message;
                scopeError.classList.remove('hidden');
            }
            const numberError = /course number|first course/i.test(message);
            const target = document.getElementById(
                numberError ? 'filter-scope-numbers' : 'filter-scope-subjects',
            );
            target?.setAttribute('aria-invalid', 'true');
            requestAnimationFrame(() => target?.focus());
        },

        showHint(msg) {
            this.setBrowseState('results');
            document.getElementById('search-results').innerHTML = `<p class="hint">${msg}</p>`;
        },
        };
    }

    return { createResultsPart };
}));
