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
                    <span class="sec-id">${sec.section}</span>
                    <span class="sec-instr">${(sec.instr && sec.instr !== 'Staff' ? sec.instr : 'Undecided')}</span>
                    <span class="sec-time">${sec.meets || 'TBA'}</span>
                    <span class="sec-status">${statusDot}</span>
                `;

                // Clicking the row shows details in the main content panel
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Highlight this row
                    sectionsDiv.querySelectorAll('.section-row').forEach(r => r.classList.remove('viewing'));
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
        // Common UofSC building abbreviations
        const abbrevs = {
            'Swearingen Engineering Center': 'SWGN',
            'Sumwalt College': 'SUMW',
            'Close-Hipp Building': 'CLHO',
            'Gambrell Hall': 'GAMB',
            'Hamilton College': 'HAMI',
            'Humanities Classroom Building': 'HCB',
            'Jones Physical Science Center': 'JPSN',
            'LeConte College': 'LECO',
            'Coker Life Sciences Building': 'COLS',
            'Callcott Social Sciences Center': 'CALC',
            'Byrnes Building': 'BYRN',
            'Currell College': 'CURR',
            'Wardlaw College': 'WARD',
            'Welsh Humanities': 'WELH',
            'Barnwell College': 'BARN',
            'Petigru College': 'PETI',
            'Sloan College': 'SLOA',
            'School of Music': 'MUS',
            'Booker T. Washington Building': 'BTW',
            'Bull Street Garage Classroom': 'BSGC',
            'Columbia Hall': 'COLH',
            'Darla Moore School of Business': 'DMSB',
            'Discovery I': 'DISC1',
            'Public Health Research Center': 'PHRC',
            'Horizon I': 'HRZN',
            'Nursing Building': 'NURS',
            'Science and Technology Building': 'STBG',
        };

        // Try to match known building names (building name may include room number)
        for (const [full, abbr] of Object.entries(abbrevs)) {
            if (fullName.startsWith(full)) {
                const room = fullName.slice(full.length).trim();
                return room ? `${abbr} ${room} (${full})` : `${abbr} (${full})`;
            }
        }

        // Fallback: shorten by taking first letters of each word + room number
        const parts = fullName.match(/^(.+?)\s+(\d+\w*)$/);
        if (parts) {
            const buildingName = parts[1];
            const words = buildingName.split(/\s+/);
            if (words.length >= 2 && buildingName.length > 15) {
                const abbr = words.map(w => w[0]).join('').toUpperCase();
                return `${abbr} ${parts[2]} (${buildingName})`;
            }
        }

        return fullName;
    },

    showLoading() {
        document.getElementById('search-results').innerHTML = '<p class="loading">Searching courses</p>';
    },

    showHint(msg) {
        document.getElementById('search-results').innerHTML = `<p class="hint">${msg}</p>`;
    },
};
