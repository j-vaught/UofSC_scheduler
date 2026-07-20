/*
 * Narrowing a result set: methods, patterns, attributes, eligibility.
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
(function initFiltersPart(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.SearchParts) root.SearchParts = {};
    root.SearchParts.createFiltersPart = api.createFiltersPart;
}(typeof globalThis === 'object' ? globalThis : self, () => {
    'use strict';

    function createFiltersPart(deps) {
        return {
        buildLiveCourseIndex(sections) {
            const index = {};
            sections.forEach(section => {
                if (!index[section.code]) index[section.code] = { hasOpen: false, records: [] };
                index[section.code].records.push(section);
                if (section.stat === 'A') index[section.code].hasOpen = true;
            });
            return index;
        },

        mergeCatalogWithLiveSections(courses, liveByCode) {
            return courses.flatMap(course => {
                const live = liveByCode[course.code];
                if (live) {
                    return live.records.map(section => ({
                        ...section,
                        _offeredThisTerm: true,
                        _hasOpen: live.hasOpen,
                        _relevanceScore: course._relevanceScore || 0,
                    }));
                }
                return [{
                    code: course.code,
                    title: course.title || course.name || '',
                    crn: '',
                    section: 'CAT',
                    stat: '',
                    instr: '',
                    meets: 'Not offered this term',
                    meetingTimes: null,
                    total: '',
                    key: course.key,
                    _isCatalog: true,
                    _offeredThisTerm: false,
                    _hasOpen: false,
                    _relevanceScore: course._relevanceScore || 0,
                }];
            });
        },

        matchesInstructionalMethod(section, selectedMethod) {
            if (!selectedMethod) return true;
            const method = String(
                (section.instructionalMethod || section.inst_mthd) || section.instructionalMethod || section.instructional_method || '',
            ).toLowerCase();
            if (selectedMethod === 'online') return /online|web|distance|remote/.test(method);
            if (selectedMethod === 'hybrid') return /hybrid|blended/.test(method);
            if (selectedMethod === 'face-to-face') {
                return /face-to-face|face to face|in-person|in person|traditional/.test(method);
            }
            return true;
        },

        meetingCount(section) {
            if (!section.meetingTimes) return 0;
            try {
                const meetings = typeof section.meetingTimes === 'string'
                    ? JSON.parse(section.meetingTimes)
                    : section.meetingTimes;
                return Array.isArray(meetings) ? meetings.length : 0;
            } catch (error) {
                return 0;
            }
        },

        matchesMeetingPattern(section, selectedPattern) {
            if (!selectedPattern) return true;
            if (section._isCatalog) return false;
            const count = this.meetingCount(section);
            if (selectedPattern === 'scheduled') return count > 0;
            if (selectedPattern === 'unscheduled') return count === 0;
            if (selectedPattern === 'once') return count === 1;
            if (selectedPattern === 'twice') return count === 2;
            if (selectedPattern === 'three-plus') return count >= 3;
            return true;
        },

        async fetchBulletinDetailsForCourse(courseCode) {
            if (this._bulletinDetailsCache[courseCode]) {
                return this._bulletinDetailsCache[courseCode];
            }
            const subject = courseCode.split(' ')[0];
            if (!this._bulletinCourseCache[subject]) {
                this._bulletinCourseCache[subject] = deps.api.bulletinSearch(subject)
                    .then(data => data.results || [])
                    .catch(error => {
                        delete this._bulletinCourseCache[subject];
                        throw error;
                    });
            }
            this._bulletinDetailsCache[courseCode] = this._bulletinCourseCache[subject]
                .then(courses => {
                    const target = courses.find(course => course.code === courseCode);
                    return target ? deps.api.bulletinDetails(target.key) : {};
                })
                .catch(error => {
                    delete this._bulletinDetailsCache[courseCode];
                    throw error;
                });
            return this._bulletinDetailsCache[courseCode];
        },

        async fetchSectionFilterDetails(section) {
            if (!section.crn) return null;
            const key = `${deps.state.term}:${section.crn}`;
            if (!this._sectionDetailCache[key]) {
                this._sectionDetailCache[key] = deps.api.getDetails(section.crn, deps.state.term)
                    .catch(error => {
                        delete this._sectionDetailCache[key];
                        throw error;
                    });
            }
            return this._sectionDetailCache[key];
        },

        matchesPartOfTerm(value, selectedPart) {
            if (!selectedPart) return true;
            const part = String(value || '').toLowerCase();
            if (selectedPart === 'full') return /full term/.test(part);
            if (selectedPart === 'first') return /first half|1st half/.test(part);
            if (selectedPart === 'second') return /second half|2nd half/.test(part);
            if (selectedPart === 'other') {
                return Boolean(part) && !/full term|first half|1st half|second half|2nd half/.test(part);
            }
            return true;
        },

        async filterByPartOfTerm(results, selectedPart) {
            if (!selectedPart) return results;
            const checked = await Promise.all(results.map(async section => {
                const details = await this.fetchSectionFilterDetails(section);
                return details && this.matchesPartOfTerm(details.part_of_term, selectedPart)
                    ? section
                    : null;
            }));
            return checked.filter(Boolean);
        },

        isHonorsSection(section, details = {}) {
            const text = [
                section.code,
                section.title,
                section.section,
                details.title,
                details.section,
                details.course_attr,
                details.clssnotes,
                details.registration_restrictions,
            ].filter(Boolean).join(' ');
            return /^SCHC\b/i.test(String(section.code || ''))
                || /^H\d/i.test(String(section.section || ''))
                || /\bHNRS\b|\bhonors?\b/i.test(text);
        },

        async filterByHonors(results, selectedHonors) {
            if (!selectedHonors) return results;
            const checked = await Promise.all(results.map(async section => {
                const details = await this.fetchSectionFilterDetails(section) || {};
                const honors = this.isHonorsSection(section, details);
                const keep = selectedHonors === 'only' ? honors : !honors;
                return keep ? section : null;
            }));
            return checked.filter(Boolean);
        },

        /*
         * Course attributes live on the section, in course_attr, alongside the
         * honors marker the filter above already reads. They look like
         * "GLD: Global Learning (3GDG)" or "CMW: Communication/Writing (3CMW)".
         *
         * This used to read details.experiential, details.founding_documents
         * and details.graduation off the bulletin course payload. None of those
         * fields exist there -- it carries code, title, hours, description and
         * prerequisites -- so all six options matched nothing, every time.
         *
         * Attributes are also genuinely a section property, not a course one:
         * one section of a course can carry Global Learning while another does
         * not, so filtering per section is both the fix and the correct grain.
         */
        matchesCourseAttribute(details, selectedAttribute) {
            if (!selectedAttribute) return true;
            const attributes = String(details?.course_attr || '')
                .replace(/<[^>]+>/g, ' ')
                .toLowerCase();
            if (!attributes.trim()) return false;
            if (selectedAttribute === 'elo') return /experiential learning/.test(attributes);
            if (selectedAttribute === 'founding') return /founding documents/.test(attributes);
            if (selectedAttribute === 'gld-community') return /community engagement|social advocacy/.test(attributes);
            if (selectedAttribute === 'gld-global') return /global learning/.test(attributes);
            if (selectedAttribute === 'gld-professional') return /professional engagement/.test(attributes);
            // Scoped to the GLD prefix: a bare /research/ would match any
            // attribute whose prose happens to contain the word.
            if (selectedAttribute === 'gld-research') return /gld:\s*research/.test(attributes);
            return true;
        },

        async filterByCourseAttribute(results, selectedAttribute) {
            if (!selectedAttribute) return results;
            const checked = await Promise.all(results.map(async section => {
                const details = await this.fetchSectionFilterDetails(section);
                return this.matchesCourseAttribute(details, selectedAttribute) ? section : null;
            }));
            return checked.filter(Boolean);
        },

        /*
         * Carolina Core outcomes for a course.
         *
         * This used to scrape a `carolinacore` field off the bulletin detail
         * payload. That field does not exist -- the payload carries code,
         * title, hours, description and prerequisites and nothing else -- so
         * the scrape always produced an empty list and the Carolina Core filter
         * returned zero results for all ten of its options, always. Selecting
         * "CMW" hid every course including ENGL 101.
         *
         * The data was already in the build the whole time, as the same
         * carolina_core_courses.json shard the degree planner's Core picker
         * reads. It is a collaborator now rather than a scrape.
         */
        async fetchCarolinaCoreCodes(courseCode) {
            if (this._carolinaCoreCache[courseCode]) return this._carolinaCoreCache[courseCode];
            if (!deps.carolinaCore) return [];
            try {
                const catalog = await deps.carolinaCore.loadCatalog();
                const entry = (catalog.courses || []).find(course => course.code === courseCode);
                this._carolinaCoreCache[courseCode] = [...new Set(entry?.outcomes || [])];
            } catch (error) {
                // An unreachable shard must not silently mean "no course
                // carries this outcome", which is what the old scrape did.
                return [];
            }
            return this._carolinaCoreCache[courseCode];
        },

        /* The outcome currently chosen in the filter panel, or ''. */
        selectedCarolinaCore() {
            if (typeof document === 'undefined') return '';
            return document.getElementById('filter-carolina-core')?.value || '';
        },

        /*
         * The upstream search value for an outcome, or '' when there is none.
         * '' is what routes an outcome to the shard fallback below, so a
         * missing catalogue module means the filter still works rather than
         * silently matching everything.
         */
        carolinaCoreSearchValue(outcome) {
            if (!outcome || !deps.carolinaCore?.searchValue) return '';
            return deps.carolinaCore.searchValue(outcome);
        },

        async filterByCarolinaCore(results, selectedCore) {
            if (!selectedCore) return results;
            /*
             * Already applied upstream as a course_attr criterion. Narrowing
             * again here would let a stale shard drop a course upstream was
             * right to return.
             */
            if (this.carolinaCoreSearchValue(selectedCore)) return results;
            const courseCodes = [...new Set(results.map(result => result.code).filter(Boolean))];
            const matches = await Promise.all(courseCodes.map(async code => {
                const coreCodes = await this.fetchCarolinaCoreCodes(code);
                return coreCodes.includes(selectedCore) ? code : null;
            }));
            const allowed = new Set(matches.filter(Boolean));
            return results.filter(result => allowed.has(result.code));
        },

        async applySectionFilters(results, filters) {
            let filtered = results;
            if (filters.openOnly) filtered = filtered.filter(section => section.stat === 'A');
            if (filters.instructionalMethod) {
                filtered = filtered.filter(section => this.matchesInstructionalMethod(
                    section,
                    filters.instructionalMethod,
                ));
            }
            if (filters.meetingPattern) {
                filtered = filtered.filter(section => this.matchesMeetingPattern(
                    section,
                    filters.meetingPattern,
                ));
            }
            if (filters.sizeMode && filters.sizeValue) {
                filtered = await this.filterByClassSize(
                    filtered,
                    filters.sizeMode,
                    filters.sizeValue,
                );
            }
            if (filters.availMode && filters.availValue !== null) {
                filtered = await this.filterByAvailableSeats(
                    filtered,
                    filters.availMode,
                    filters.availValue,
                );
            }
            filtered = await this.filterByPartOfTerm(filtered, filters.partOfTerm);
            filtered = await this.filterByHonors(filtered, filters.honors);
            filtered = await this.filterByCourseAttribute(filtered, filters.courseAttribute);
            return this.filterByCarolinaCore(filtered, filters.carolinaCore);
        },

        async fetchPrereqForCourse(courseCode) {
            // Fetch prereq data for a single course (on-demand, cached)
            const subject = courseCode.split(' ')[0];
            if (!this._prereqCache[subject]) this._prereqCache[subject] = {};
            if (this._prereqCache[subject][courseCode]) return this._prereqCache[subject][courseCode];

            try {
                const search = await deps.api.bulletinSearch(subject);
                const courses = search.results || [];
                const target = courses.find(c => c.code === courseCode);
                if (!target) return { prereqs: [], raw: '' };

                const details = await deps.api.bulletinDetails(target.key);
                const prereqHtml = details.prereq || '';
                const codes = (prereqHtml.match(/[A-Z]{3,4}\s+\d{3}[A-Z]?/g) || []);
                const groups = deps.prereqs && deps.prereqs.parsePrereqGroups
                    ? deps.prereqs.parsePrereqGroups(prereqHtml)
                    : [];
                const result = {
                    prereqs: [...new Set(codes)],
                    groups,
                    raw: prereqHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                };
                this._prereqCache[subject][courseCode] = result;
                return result;
            } catch (error) {
                throw error;
            }
        },

        checkEligibility(courseCode, prereqData) {
            const info = prereqData[courseCode];
            if (!info) return { eligible: true, missing: [], noData: true };
            const completed = new Set(deps.state.completedCourses);
            if (info.groups?.length
                && deps.prereqs
                && deps.prereqs.evaluateGroups) {
                const evaluation = deps.prereqs.evaluateGroups(info.groups, completed);
                return {
                    eligible: evaluation.eligible,
                    missing: evaluation.missing,
                    noData: false,
                    unknown: evaluation.uncertain,
                };
            }
            const prerequisites = info.prereqs || [];
            if (!prerequisites.length) return { eligible: true, missing: [], noData: false };
            const missing = prerequisites.filter(p => !completed.has(p));
            return { eligible: missing.length === 0, missing, noData: false };
        },

        async loadPrereqsForResults(results) {
            const codes = [...new Set(results.map(result => result.code).filter(Boolean))];
            const entries = await Promise.all(codes.map(async code => {
                const info = await this.fetchPrereqForCourse(code);
                return [code, info];
            }));
            return Object.fromEntries(entries);
        },

        /*
         * Class size, meaning maximum enrolment: how big the room is, not how
         * much of it is left.
         *
         * This used to read section.seatsOpen, which is seats *remaining*. That
         * made "Class Size: less than 30" match almost every section, because
         * few sections have thirty seats still open, and "more than 100" match
         * nothing at all. It was a second, mislabelled copy of the Seats
         * Available filter below, and a student looking for small classes got
         * the whole catalogue back and no reason to doubt it.
         *
         * seats_max is in the same detail payload seats_avail comes from, so
         * this costs the same per-section fetch that filter already pays.
         */
        async filterByClassSize(results, mode, value) {
            if (!mode || value === null || value === undefined) return results;
            const checked = await Promise.all(results.map(async result => {
                if (!result.crn) return null;
                const details = await this.fetchSectionFilterDetails(result);
                if (!details) return null;
                const match = (details.seats || '').match(/seats_max[^>]*>(\d+)/);
                if (!match) return null;
                return { result, size: Number(match[1]) };
            }));
            return checked
                .filter(item => item && (mode === 'above' ? item.size >= value : item.size < value))
                .map(item => item.result);
        },

        async filterByAvailableSeats(results, mode, value) {
            if (!mode || value === null || value === undefined) return results;
            const checked = await Promise.all(results.map(async result => {
                if (!result.crn) return null;
                const details = await this.fetchSectionFilterDetails(result);
                if (!details) return null;
                const match = (details.seats || '').match(/seats_avail[^>]*>(\d+)/);
                if (!match) return null;
                return { result, available: Number(match[1]) };
            }));
            return checked
                .filter(item => item && (mode === 'above' ? item.available >= value : item.available < value))
                .map(item => item.result);
        },

        courseAvailability(group) {
            const liveSections = group.sections.filter(section => section.crn && !section._isCatalog);
            if (group.sections.some(section => section.availability_unknown)) {
                return { kind: 'unknown', text: 'Live availability unavailable' };
            }
            if (liveSections.length === 0) return { kind: 'unavailable', text: 'Not offered' };

            const openCount = liveSections.filter(section => section.stat === 'A').length;
            const sectionLabel = liveSections.length === 1 ? 'section' : 'sections';
            if (openCount > 0) {
                return {
                    kind: 'open',
                    text: `${openCount} of ${liveSections.length} ${sectionLabel} open`,
                };
            }
            return {
                kind: 'full',
                text: liveSections.length === 1 ? '1 section full' : `All ${liveSections.length} sections full`,
            };
        },

        updateCourseSelectionStyles(courseCode) {
            document.querySelectorAll('#search-results .course-group').forEach(course => {
                if (course.dataset.courseCode === courseCode) {
                    course.classList.toggle('course-added', deps.state.isCourseSelected(courseCode));
                }
            });
        },

        };
    }

    return { createFiltersPart };
}));
