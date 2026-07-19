/* Prerequisite chain visualization */
const Prereqs = {
    _cache: {},
    _loadId: 0,
    _degreeRequirementCache: new Map(),
    _degreeRequirementCacheVersion: 1,
    _degreeRequirementCacheTtl: 30 * 24 * 60 * 60 * 1000,

    async loadForCourse(courseCode) {
        const container = document.getElementById('prereq-container');
        if (!container) return;
        const loadId = ++this._loadId;
        container.innerHTML = '<p class="loading">Loading prerequisites</p>';

        const subject = courseCode.split(' ')[0];
        try {
            // Get all courses in the subject from bulletin
            const search = await API.bulletinSearch(subject);
            if (loadId !== this._loadId) return;
            const courses = search.results || [];

            // Find the target course
            const target = courses.find(c => c.code === courseCode);
            if (!target) {
                container.innerHTML = `<p class="hint">Course ${courseCode} not found in bulletin.</p>`;
                return;
            }

            // Get details for the target course
            const details = await API.bulletinDetails(target.key);
            if (loadId !== this._loadId) return;
            const prereqHtml = details.prereq || '';

            // Parse prerequisite groups (AND groups separated by ;, OR options within each)
            const prereqGroups = this.parsePrereqGroups(prereqHtml);
            const completed = new Set(State.completedCourses);
            const cleanPrereq = this.cleanRequirementText(prereqHtml);
            const companions = [
                { html: details.corequisite, mode: 'corequisite' },
                { html: details.prerequisite_or_corequisite, mode: 'either' },
            ].filter(item => item.html).map(item => ({
                mode: item.mode,
                text: this.cleanRequirementText(item.html),
                groups: this.parsePrereqGroups(item.html),
            }));
            const needsReview = this.requirementNeedsReview(cleanPrereq)
                || companions.some(item => this.requirementNeedsReview(item.text));

            let html = this.renderStatus(
                prereqGroups,
                companions,
                completed,
                Boolean(cleanPrereq),
                needsReview,
            );
            html += this.renderPathways(courseCode, prereqGroups, companions, completed);
            html += this.renderCatalogNote(cleanPrereq, companions, needsReview);

            if (loadId !== this._loadId) return;
            container.innerHTML = html;

            // Bind course links in the visual pathway.
            container.querySelectorAll('.prereq-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.navigateToCourse(link.dataset.code);
                });
            });

        } catch (err) {
            container.innerHTML = `<p class="hint">Error loading prerequisites: ${err.message}</p>`;
        }
    },

    async navigateToCourse(courseCode) {
        const subject = courseCode.split(' ')[0];
        try {
            const [live, bulletin] = await Promise.all([
                API.searchCourses(State.term, [{ field: 'subject', value: subject }]),
                API.bulletinSearch(subject),
            ]);
            const sections = (live.results || []).filter(section => section.code === courseCode);
            const catalog = (bulletin.results || []).find(course => course.code === courseCode);
            if (!sections.length && !catalog) return;
            Search.showCourseDetail({
                code: courseCode,
                title: sections[0]?.title || catalog?.title || courseCode,
                sections: sections.length ? sections : [{
                    code: courseCode,
                    title: catalog?.title || courseCode,
                    key: catalog?.key,
                    _isCatalog: true,
                }],
            });
            const focusCloseControl = () => {
                document.getElementById('browse-close-details')?.focus();
            };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusCloseControl);
            else focusCloseControl();
        } catch (error) {
            // Keep the current course visible if navigation cannot be completed.
        }
    },

    parsePrereqGroups(html) {
        // Parse prerequisite text into AND groups of OR options.
        // Semicolons and explicit "and" connectors create separate requirements.
        // Explicit "or" connectors create alternatives. Grade phrases such as
        // "C or better" are not treated as course alternatives.
        //
        // Example: "D or better in ENCP 200, ECIV 200, EMCH 200, or ECHE 300; D or better in PHYS 211"
        // Result: [
        //   { courses: ['ENCP 200', 'ECIV 200', 'EMCH 200', 'ECHE 300'], type: 'or' },
        //   { courses: ['PHYS 211'], type: 'and' }
        // ]

        if (!html) return [];

        // Strip HTML tags
        const clean = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!clean) return [];

        // Split on semicolons to get AND groups
        const andParts = clean.split(/;/);
        const groups = [];

        andParts.forEach(part => {
            const matches = [...part.matchAll(/[A-Z]{3,4}\s+\d{3}[A-Z]?/g)];
            if (!matches.length) return;
            const trailingConditions = this.trailingRequirementAlternatives(part, matches.at(-1));
            if (matches.length === 1) {
                groups.push({
                    courses: [matches[0][0]],
                    type: trailingConditions.length ? 'or' : 'and',
                    ...(trailingConditions.length ? { conditions: trailingConditions } : {}),
                });
                return;
            }

            const gradePhrase = /\b[A-F][+-]?\s+or\s+better\b/i;
            const connectors = matches.slice(1).map((match, index) => {
                const previous = matches[index];
                const between = part.slice(previous.index + previous[0].length, match.index);
                const repeatsGrade = gradePhrase.test(between);
                const logic = between.replace(gradePhrase, ' ');
                if (/\band\b/i.test(logic) || repeatsGrade) return 'and';
                if (/\bor\b/i.test(logic)) return 'or';
                if (logic.includes(',')) return 'comma';
                return 'and';
            });
            const usableTrailingConditions = connectors.includes('and') ? [] : trailingConditions;
            const commaMeansOr = (connectors.includes('or') || usableTrailingConditions.length)
                && !connectors.includes('and');
            let current = [matches[0][0]];

            connectors.forEach((connector, index) => {
                const nextCode = matches[index + 1][0];
                if (connector === 'or' || (connector === 'comma' && commaMeansOr)) {
                    current.push(nextCode);
                    return;
                }
                groups.push({
                    courses: [...new Set(current)],
                    type: current.length > 1 ? 'or' : 'and',
                });
                current = [nextCode];
            });
            const finalGroup = {
                courses: [...new Set(current)],
                type: current.length > 1 || usableTrailingConditions.length ? 'or' : 'and',
            };
            if (usableTrailingConditions.length) finalGroup.conditions = usableTrailingConditions;
            groups.push(finalGroup);
        });

        return groups;
    },

    catalogYearSource(map) {
        const value = String(
            map?.catalog_year
            || map?.bulletin_year
            || map?.academic_year
            || '2026',
        );
        return value.match(/\d{4}/)?.[0] || '2026';
    },

    normalizeCatalogRequirements(details = {}) {
        const prerequisiteText = details.prereq || details.prerequisite_text || '';
        const corequisiteText = details.corequisite || details.corequisite_text || '';
        const eitherText = details.prerequisite_or_corequisite
            || details.prerequisite_or_corequisite_text
            || '';
        const prerequisiteGroups = this.parsePrereqGroups(prerequisiteText);
        const corequisiteGroups = this.parsePrereqGroups(corequisiteText);
        const eitherGroups = this.parsePrereqGroups(eitherText);
        return {
            prerequisite_groups: prerequisiteGroups,
            corequisite_groups: corequisiteGroups,
            prerequisite_or_corequisite_groups: eitherGroups,
            prerequisites: [...new Set(prerequisiteGroups.flatMap(group => group.courses || []))],
            corequisites: [...new Set([
                ...corequisiteGroups.flatMap(group => group.courses || []),
                ...eitherGroups.flatMap(group => group.courses || []),
            ])],
            prerequisite_text: this.cleanRequirementText(prerequisiteText),
            corequisite_text: this.cleanRequirementText(corequisiteText),
            prerequisite_or_corequisite_text: this.cleanRequirementText(eitherText),
        };
    },

    degreeRequirementCacheKey(courseCode, catalogYear) {
        return `degree-requirements:v${this._degreeRequirementCacheVersion}:${catalogYear}:${courseCode}`;
    },

    readDegreeRequirementCache(courseCode, catalogYear) {
        const key = this.degreeRequirementCacheKey(courseCode, catalogYear);
        if (this._degreeRequirementCache.has(key)) {
            const memory = this._degreeRequirementCache.get(key);
            if (Date.now() - Number(memory.saved_at || 0) <= this._degreeRequirementCacheTtl) {
                return memory.value;
            }
            this._degreeRequirementCache.delete(key);
        }
        try {
            const stored = globalThis.localStorage?.getItem(key);
            if (!stored) return null;
            const parsed = JSON.parse(stored);
            if (!parsed?.value || Date.now() - Number(parsed.saved_at || 0) > this._degreeRequirementCacheTtl) {
                globalThis.localStorage?.removeItem(key);
                return null;
            }
            this._degreeRequirementCache.set(key, parsed);
            return parsed.value;
        } catch (error) {
            return null;
        }
    },

    writeDegreeRequirementCache(courseCode, catalogYear, value) {
        const key = this.degreeRequirementCacheKey(courseCode, catalogYear);
        const record = { saved_at: Date.now(), value };
        this._degreeRequirementCache.set(key, record);
        try {
            globalThis.localStorage?.setItem(key, JSON.stringify(record));
        } catch (error) {
            // Memory caching still prevents duplicate work when storage is unavailable.
        }
    },

    async loadDegreeRequirements(course, catalogYear, catalogByCode = new Map()) {
        const courseCode = String(course?.code || '').trim().toUpperCase();
        if (!/^[A-Z]{2,8}\s+\d{3}[A-Z]?$/.test(courseCode)) return null;
        const cached = this.readDegreeRequirementCache(courseCode, catalogYear);
        if (cached) return cached;

        const catalog = catalogByCode.get(courseCode);
        if (!catalog) return null;
        let details = catalog;
        if (catalog.key) {
            try {
                details = await API.bulletinDetails(catalog.key, catalogYear);
            } catch (error) {
                details = catalog;
            }
        }
        const normalized = this.normalizeCatalogRequirements({ ...catalog, ...details });
        this.writeDegreeRequirementCache(courseCode, catalogYear, normalized);
        return normalized;
    },

    async enrichMajorMap(majorMap) {
        if (!majorMap || !Array.isArray(majorMap.required_courses)) return majorMap;
        const catalogYear = this.catalogYearSource(majorMap);
        const courses = majorMap.required_courses;
        const uncachedCourses = courses.filter(course => !this.readDegreeRequirementCache(
            String(course.code || '').trim().toUpperCase(),
            catalogYear,
        ));
        const subjects = [...new Set(uncachedCourses
            .map(course => String(course.code || '').split(' ')[0])
            .filter(Boolean))];
        const catalogByCode = new Map();

        await Promise.all(subjects.map(async subject => {
            try {
                const response = await API.bulletinSearch(subject, catalogYear);
                (response.results || []).forEach(item => {
                    if (item?.code) catalogByCode.set(String(item.code).toUpperCase(), item);
                });
            } catch (error) {
                // Existing map requirements remain usable when a catalog shard is unavailable.
            }
        }));

        const enrichedCourses = await Promise.all(courses.map(async course => {
            const normalized = await this.loadDegreeRequirements(course, catalogYear, catalogByCode);
            if (!normalized) return course;
            const hasCatalogPrerequisites = normalized.prerequisite_groups.length > 0;
            const hasCatalogCorequisites = normalized.corequisite_groups.length > 0
                || normalized.prerequisite_or_corequisite_groups.length > 0;
            return {
                ...course,
                ...normalized,
                prerequisites: hasCatalogPrerequisites
                    ? normalized.prerequisites
                    : (course.prerequisites || []),
                corequisites: hasCatalogCorequisites
                    ? normalized.corequisites
                    : (course.corequisites || []),
                prerequisite_groups: hasCatalogPrerequisites
                    ? normalized.prerequisite_groups
                    : course.prerequisite_groups,
                corequisite_groups: normalized.corequisite_groups.length
                    ? normalized.corequisite_groups
                    : course.corequisite_groups,
                prerequisite_or_corequisite_groups: normalized.prerequisite_or_corequisite_groups.length
                    ? normalized.prerequisite_or_corequisite_groups
                    : course.prerequisite_or_corequisite_groups,
            };
        }));

        return { ...majorMap, required_courses: enrichedCourses };
    },

    trailingRequirementAlternatives(part, lastCourseMatch) {
        if (!lastCourseMatch) return [];
        const tail = String(part).slice(lastCourseMatch.index + lastCourseMatch[0].length);
        if (/\bor\b[^.;]*\bplacement\b(?:\s+(?:exam|examination|test))?/i.test(tail)) {
            return [{ label: 'Placement exam', kind: 'manual' }];
        }
        return [];
    },

    cleanRequirementText(html) {
        return String(html || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^(?:prerequisite or corequisite|prerequisites?|corequisites?):\s*/i, '')
            .trim();
    },

    requirementNeedsReview(text) {
        if (!text) return false;
        const residue = String(text)
            .replace(/[A-Z]{3,4}\s+\d{3}[A-Z]?/g, ' ')
            .replace(/\b(?:and|or|either|one|of|the|following|in|course|courses)\b/gi, ' ')
            .replace(/[\s,;:.()\/-]+/g, '');
        return Boolean(residue);
    },

    escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    groupIsMet(group, completed) {
        return group.type === 'or'
            ? group.courses.some(code => completed.has(code))
            : group.courses.every(code => completed.has(code));
    },

    evaluateGroups(groups, completed) {
        const unmet = groups.filter(group => !this.groupIsMet(group, completed));
        const uncertain = unmet.filter(group => (group.conditions || []).length);
        const definite = unmet.filter(group => !(group.conditions || []).length);
        return {
            satisfied: unmet.length === 0,
            eligible: definite.length === 0,
            uncertain: uncertain.length > 0,
            missing: [...new Set(definite.flatMap(group => group.courses))],
        };
    },

    renderStatus(groups, companions, completed, hasCatalogPrerequisite, needsReview) {
        if (needsReview) {
            return '<div class="prereq-status-card review" role="status"><span class="prereq-status-icon" aria-hidden="true">!</span><div><strong>Review these requirements</strong><span>The catalog includes a condition the planner cannot verify.</span></div></div>';
        }

        const companionGroups = companions.flatMap(item => item.groups);
        if (!groups.length && !companionGroups.length) {
            if (hasCatalogPrerequisite) {
                return '<div class="prereq-status-card review" role="status"><span class="prereq-status-icon" aria-hidden="true">!</span><div><strong>Review the catalog requirement</strong><span>This requirement cannot be checked automatically.</span></div></div>';
            }
            return '<div class="prereq-status-card none" role="status"><span class="prereq-status-icon" aria-hidden="true">&mdash;</span><div><strong>No prerequisites or corequisites listed</strong></div></div>';
        }

        const missingPrereqs = groups.filter(group => !this.groupIsMet(group, completed)).length;
        const pendingCompanions = companionGroups
            .filter(group => !this.groupIsMet(group, completed))
            .length;
        const remaining = missingPrereqs + pendingCompanions;
        const met = remaining === 0;
        let title = 'Requirements marked complete';
        let statusClass = 'met';
        if (missingPrereqs && pendingCompanions) {
            title = `${remaining} requirements to plan`;
            statusClass = 'missing';
        } else if (missingPrereqs) {
            title = `${missingPrereqs} prerequisite requirement${missingPrereqs === 1 ? '' : 's'} remaining`;
            statusClass = 'missing';
        } else if (pendingCompanions) {
            title = `${pendingCompanions} companion course${pendingCompanions === 1 ? '' : 's'} to plan`;
            statusClass = 'companion';
        }
        return `<div class="prereq-status-card ${statusClass}" role="status"><span class="prereq-status-icon" aria-hidden="true">${met ? '&#10003;' : '!'}</span><div><strong>${title}</strong><span>Based on completed courses in your profile</span></div></div>`;
    },

    renderCourseCard(code, completed, pendingLabel) {
        const met = completed.has(code);
        const safeCode = this.escapeHtml(code);
        const state = met ? 'Completed' : pendingLabel;
        return `<a href="#" class="prereq-link prereq-course-card ${met ? 'met' : 'needed'}" data-code="${safeCode}" title="View ${safeCode} course details" aria-label="${safeCode}, ${state}"><strong>${safeCode}</strong><span>${state}</span></a>`;
    },

    renderRequirementCondition(condition) {
        const label = this.escapeHtml(condition?.label || 'Catalog condition');
        return `<div class="prereq-course-card condition" role="note" aria-label="${label}, can satisfy this requirement"><strong>${label}</strong><span>Can satisfy</span></div>`;
    },

    renderPathways(target, groups, companions, completed) {
        const visibleCompanions = companions.filter(item => item.groups.length);
        if (!groups.length && !visibleCompanions.length) return '';
        const safeTarget = this.escapeHtml(target);
        let html = `<div class="prereq-tree" role="group" aria-label="Prerequisite and corequisite tree for ${safeTarget}">`;
        const prerequisiteBranches = groups.map(group => {
            const groupMet = this.groupIsMet(group, completed);
            const optionCount = group.courses.length + (group.conditions || []).length;
            const label = optionCount > 1 ? 'Complete one' : 'Required';
            const courses = group.courses
                .map(code => this.renderCourseCard(code, completed, 'Needed'))
                .join('') + (group.conditions || [])
                .map(condition => this.renderRequirementCondition(condition))
                .join('');
            const optionClass = optionCount > 1 ? ' alternatives' : '';
            return `<section class="prereq-tree-branch prerequisite ${groupMet ? 'met' : 'missing'}"><span class="prereq-tree-branch-label">${label}</span><div class="prereq-course-options${optionClass}">${courses}</div><span class="prereq-tree-branch-drop" aria-hidden="true"></span></section>`;
        });
        const companionBranches = visibleCompanions.flatMap(item => {
            const isEither = item.mode === 'either';
            const modeLabel = isEither ? 'Before or with this course' : 'Take with this course';
            const pendingLabel = isEither ? 'Before or with' : 'Take together';
            return item.groups.map(group => {
                const groupMet = this.groupIsMet(group, completed);
                const optionCount = group.courses.length + (group.conditions || []).length;
                const chooseOne = optionCount > 1 ? ' · choose one' : '';
                const courses = group.courses
                    .map(code => this.renderCourseCard(code, completed, pendingLabel))
                    .join('') + (group.conditions || [])
                    .map(condition => this.renderRequirementCondition(condition))
                    .join('');
                const optionClass = optionCount > 1 ? ' alternatives' : '';
                return `<section class="prereq-tree-branch companion ${groupMet ? 'met' : 'missing'}"><span class="prereq-tree-branch-label">${modeLabel}${chooseOne}</span><div class="prereq-course-options${optionClass}">${courses}</div><span class="prereq-tree-branch-drop" aria-hidden="true"></span></section>`;
            });
        });
        const branches = [...prerequisiteBranches, ...companionBranches];
        const groupClasses = [
            'prereq-tree-groups',
            branches.length === 1 ? 'single' : '',
            prerequisiteBranches.length ? '' : 'companions-only',
        ].filter(Boolean).join(' ');
        const connectorClass = prerequisiteBranches.length ? '' : ' companion';
        html += `<div class="${groupClasses}">${branches.join('')}</div><span class="prereq-tree-connector${connectorClass}" aria-hidden="true"></span>`;
        html += `<div class="prereq-course-card target" aria-label="${safeTarget}, this course"><strong>${safeTarget}</strong><span>This course</span></div>`;
        return `${html}</div>`;
    },

    renderCatalogNote(prerequisite, companions, open) {
        if (!prerequisite && !companions.length) return '';
        const rows = [];
        if (prerequisite) {
            rows.push(`<p><strong>Prerequisite</strong><span>${this.escapeHtml(prerequisite)}</span></p>`);
        }
        companions.forEach(item => {
            const label = item.mode === 'either' ? 'Prerequisite or corequisite' : 'Corequisite';
            rows.push(`<p><strong>${label}</strong><span>${this.escapeHtml(item.text)}</span></p>`);
        });
        return `<details class="prereq-catalog-note"${open ? ' open' : ''}><summary>Catalog wording</summary><div>${rows.join('')}</div></details>`;
    },
};
