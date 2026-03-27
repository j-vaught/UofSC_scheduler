/* Course search UI */
const Search = {
    _prereqCache: {},

    init() {
        this.populateSubjects();
        document.getElementById('btn-search').addEventListener('click', () => this.doSearch());
        document.getElementById('keyword-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.doSearch();
        });
    },

    populateSubjects() {
        const sel = document.getElementById('subject-select');
        const subjects = [
            "ACCT","AESP","AFAM","ANTH","ARAB","ARTE","ARTH","ARTS","ASTR",
            "BADM","BIOL","BMEN","BMSC","CHEM","CHIN","COMD","COMM","CPLT",
            "CRJU","CSCE","CYBR","DANC","ECHE","ECIV","ECON","EDUC","ELCT",
            "EMCH","ENCP","ENGL","ENTR","ENVR","EXSC","FINA","FREN","GEOG",
            "GEOL","GERM","HIST","HRSM","HRTM","ITAL","JAPA","JOUR","KORE",
            "LATN","LAWS","LING","MART","MATH","MGMT","MGSC","MKTG","MSCI",
            "MUED","MUSC","NURS","PHAR","PHIL","PHYS","POLI","PORT","PSYC",
            "PUBH","RELG","RETL","RUSS","SCHC","SOCY","SOWK","SPAN","SPCH",
            "SPTE","STAT","THEA","UNIV","WGST",
        ];
        subjects.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            sel.appendChild(opt);
        });
    },

    async doSearch() {
        const subject = document.getElementById('subject-select').value;
        const keyword = document.getElementById('keyword-input').value.trim();
        const openOnly = document.getElementById('filter-open').checked;
        const gradOnly = document.getElementById('filter-grad').checked;
        const eligibleOnly = document.getElementById('filter-eligible').checked;

        if (!subject && !keyword) {
            this.showHint('Pick a subject or enter a course number.');
            return;
        }

        const criteria = [];
        if (subject) criteria.push({ field: 'subject', value: subject });
        if (keyword) {
            if (/^[A-Z]{3,4}\s+\d{2,5}$/i.test(keyword)) {
                criteria.push({ field: 'alias', value: keyword.toUpperCase() });
            } else if (/^\d{5}$/.test(keyword)) {
                criteria.push({ field: 'crn', value: keyword });
            } else {
                criteria.push({ field: 'keyword', value: keyword });
            }
        }
        if (openOnly) criteria.push({ field: 'stat', value: 'A' });
        if (gradOnly) criteria.push({ field: 'course_level', value: 'course_level_A5' });

        this.showLoading();

        try {
            const data = await API.searchCourses(State.term, criteria);
            let results = data.results || [];

            // Fetch prereq data for eligibility check
            let prereqData = {};
            if (subject && (eligibleOnly || State.completedCourses.length > 0)) {
                prereqData = await this.fetchPrereqData(subject);
            }

            this.renderResults(results, data.count || 0, prereqData, eligibleOnly);
        } catch (err) {
            this.showHint('Search failed. Try again.');
        }
    },

    async fetchPrereqData(subject) {
        if (this._prereqCache[subject]) return this._prereqCache[subject];

        try {
            const search = await API.bulletinSearch(subject);
            const courses = search.results || [];
            const prereqMap = {};

            for (const course of courses) {
                try {
                    const details = await API.bulletinDetails(course.key);
                    const prereqHtml = details.prereq || '';
                    const codes = (prereqHtml.match(/[A-Z]{3,4}\s+\d{3}[A-Z]?/g) || []);
                    prereqMap[course.code] = {
                        prereqs: [...new Set(codes)],
                        raw: prereqHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                    };
                } catch (e) {
                    prereqMap[course.code] = { prereqs: [], raw: '' };
                }
            }

            this._prereqCache[subject] = prereqMap;
            return prereqMap;
        } catch (e) {
            return {};
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

            const hasOpen = group.sections.some(s => s.stat === 'A');
            const badgeClass = hasOpen ? 'badge-open' : 'badge-full';
            const badgeText = hasOpen ? 'OPEN' : 'FULL';

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
                sectionsDiv.classList.toggle('expanded');
            });

            group.sections.forEach(sec => {
                const row = document.createElement('div');
                row.className = 'section-row' + (State.isSelected(sec.crn) ? ' selected' : '');
                const statusDot = sec.stat === 'A'
                    ? '<span style="color:#2e7d32;font-weight:700">&#9679;</span>'
                    : '<span style="color:#c62828;font-weight:700">&#9679;</span>';
                row.innerHTML = `
                    <span class="sec-id">${sec.section}</span>
                    <span class="sec-instr">${sec.instr || 'Staff'}</span>
                    <span class="sec-time">${sec.meets || 'TBA'}</span>
                    <span class="sec-status">${statusDot}</span>
                `;

                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    State.toggleSection(sec);
                    row.classList.toggle('selected', State.isSelected(sec.crn));
                    // Deselect sibling rows for same course
                    sectionsDiv.querySelectorAll('.section-row').forEach(r => {
                        if (r !== row && r.dataset.crn) {
                            r.classList.toggle('selected', State.isSelected(r.dataset.crn));
                        }
                    });
                });
                row.dataset.crn = sec.crn;
                sectionsDiv.appendChild(row);
            });

            container.appendChild(div);
        });
    },

    showLoading() {
        document.getElementById('search-results').innerHTML = '<p class="loading">Searching courses</p>';
    },

    showHint(msg) {
        document.getElementById('search-results').innerHTML = `<p class="hint">${msg}</p>`;
    },
};
