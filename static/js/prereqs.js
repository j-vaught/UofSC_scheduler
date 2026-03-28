/* Prerequisite chain visualization */
const Prereqs = {
    _cache: {},

    async loadForCourse(courseCode) {
        const container = document.getElementById('prereq-container');
        if (!container) return;
        container.innerHTML = '<p class="loading">Loading prerequisites</p>';

        const subject = courseCode.split(' ')[0];
        try {
            // Get all courses in the subject from bulletin
            const search = await API.bulletinSearch(subject);
            const courses = search.results || [];

            // Find the target course
            const target = courses.find(c => c.code === courseCode);
            if (!target) {
                container.innerHTML = `<p class="hint">Course ${courseCode} not found in bulletin.</p>`;
                return;
            }

            // Get details for the target course
            const details = await API.bulletinDetails(target.key);
            const prereqHtml = details.prereq || '';
            const coreqHtml = details.corequisite || details.prerequisite_or_corequisite || '';

            // Parse course codes from prereq HTML
            const prereqCodes = this.parseCourseCodes(prereqHtml);
            const coreqCodes = this.parseCourseCodes(coreqHtml);

            // Build display
            const completed = new Set(State.completedCourses);

            let html = `<h3>${courseCode} - ${details.title || ''}</h3>`;
            html += `<p><strong>Credits:</strong> ${details.hours_html || 'N/A'}</p>`;

            if (prereqHtml) {
                const cleanPrereq = prereqHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                html += `<p><strong>Prerequisites:</strong> ${cleanPrereq}</p>`;
            } else {
                html += `<p><strong>Prerequisites:</strong> None listed</p>`;
            }

            if (coreqHtml) {
                const cleanCoreq = coreqHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                html += `<p><strong>Corequisites:</strong> ${cleanCoreq}</p>`;
            }

            if (prereqCodes.length > 0) {
                html += '<div style="margin-top:12px">';
                html += '<h4 style="margin-bottom:6px;color:#466A9F">Prerequisite Status</h4>';
                prereqCodes.forEach(code => {
                    const met = completed.has(code);
                    const icon = met ? '<span class="offered">&#10003;</span>' : '<span class="not-offered">&#10007;</span>';
                    html += `<div style="margin-bottom:3px;font-size:0.85rem">${icon} <a href="#" class="prereq-link" data-code="${code}">${code}</a> ${met ? '(completed)' : '(not completed)'}</div>`;
                });

                const allMet = prereqCodes.every(c => completed.has(c));
                if (allMet) {
                    html += '<p style="color:#2e7d32;margin-top:8px;font-weight:600">All prerequisites met!</p>';
                } else {
                    html += '<p style="color:#c62828;margin-top:8px;font-weight:600">Some prerequisites are missing.</p>';
                }
                html += '</div>';
            }

            // Render SVG graph
            html += '<div style="margin-top:12px">';
            html += this.renderGraph(courseCode, prereqCodes, coreqCodes, completed);
            html += '</div>';

            container.innerHTML = html;

            // Bind clickable prereq links
            container.querySelectorAll('.prereq-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.navigateToCourse(link.dataset.code);
                });
            });

            // Bind clickable SVG nodes (prereq/coreq, not the target)
            container.querySelectorAll('.prereq-node:not(.prereq-target)').forEach(node => {
                node.style.cursor = 'pointer';
                node.addEventListener('click', () => {
                    const text = node.querySelector('text');
                    if (text) this.navigateToCourse(text.textContent.trim());
                });
            });

        } catch (err) {
            container.innerHTML = `<p class="hint">Error loading prerequisites: ${err.message}</p>`;
        }
    },

    navigateToCourse(courseCode) {
        // Clear course details and reload for the clicked prereq course
        const detailsTab = document.getElementById('tab-details');
        if (detailsTab) {
            detailsTab.innerHTML = `<p class="loading">Loading ${courseCode}</p>`;
        }

        // Load prereqs, history, and bulletin details for the new course
        this.loadForCourse(courseCode);
        if (typeof History !== 'undefined' && History.loadForCourse) {
            History.loadForCourse(courseCode);
        }

        // Fetch bulletin details to populate the course info panel
        const subject = courseCode.split(' ')[0];
        API.bulletinSearch(subject).then(search => {
            const courses = search.results || [];
            const target = courses.find(c => c.code === courseCode);
            if (!target || !detailsTab) return;
            API.bulletinDetails(target.key).then(details => {
                const desc = (details.description || '').replace(/<[^>]+>/g, ' ').trim();
                detailsTab.innerHTML = `
                    <h3>${courseCode} - ${details.title || ''}</h3>
                    <p><strong>Credits:</strong> ${details.hours_html || 'N/A'}</p>
                    ${desc ? `<p><strong>Description:</strong> ${desc.substring(0, 300)}${desc.length > 300 ? '...' : ''}</p>` : ''}
                    <p class="hint" style="margin-top:8px">Viewing from prerequisite chain. Search and select a section for full details.</p>
                `;
            });
        }).catch(() => {});
    },

    parseCourseCodes(html) {
        if (!html) return [];
        const matches = html.match(/[A-Z]{3,4}\s+\d{3}[A-Z]?/g) || [];
        return [...new Set(matches)];
    },

    renderGraph(target, prereqs, coreqs, completed) {
        if (prereqs.length === 0 && coreqs.length === 0) {
            return '<p style="color:#888;font-size:0.8rem">No prerequisite graph to display.</p>';
        }

        const nodeW = 90, nodeH = 30, padX = 20, padY = 40;
        const allNodes = [...prereqs, ...coreqs, target];
        const cols = Math.min(allNodes.length, 4);
        const svgW = Math.max(300, (cols + 1) * (nodeW + padX));

        // Layout: prereqs on top row, target on bottom
        const nodes = [];
        const edges = [];

        // Prereq row
        prereqs.forEach((code, i) => {
            const x = padX + i * (nodeW + padX);
            const y = padY;
            const cls = completed.has(code) ? 'prereq-met' : 'prereq-unmet';
            nodes.push({ code, x, y, cls });
            edges.push({ from: { x: x + nodeW / 2, y: y + nodeH }, to: null, type: 'prereq' });
        });

        // Coreq row (offset)
        coreqs.forEach((code, i) => {
            const x = padX + (prereqs.length + i) * (nodeW + padX);
            const y = padY;
            const cls = completed.has(code) ? 'prereq-met' : 'prereq-unmet';
            nodes.push({ code, x, y, cls });
            edges.push({ from: { x: x + nodeW / 2, y: y + nodeH }, to: null, type: 'coreq' });
        });

        // Target node
        const targetX = padX + ((prereqs.length + coreqs.length - 1) / 2) * (nodeW + padX);
        const targetY = padY + nodeH + padY;
        nodes.push({ code: target, x: Math.max(padX, targetX), y: targetY, cls: 'prereq-target' });

        const targetCenter = { x: Math.max(padX, targetX) + nodeW / 2, y: targetY };
        edges.forEach(e => { e.to = targetCenter; });

        const svgH = targetY + nodeH + padY;

        let svg = `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">`;

        // Edges
        edges.forEach(e => {
            const dash = e.type === 'coreq' ? 'stroke-dasharray="4,3"' : '';
            svg += `<line x1="${e.from.x}" y1="${e.from.y}" x2="${e.to.x}" y2="${e.to.y}" class="prereq-edge" ${dash}/>`;
            // Arrow
            svg += `<polygon points="${e.to.x},${e.to.y} ${e.to.x - 4},${e.to.y - 8} ${e.to.x + 4},${e.to.y - 8}" fill="#555"/>`;
        });

        // Nodes
        nodes.forEach(n => {
            svg += `<g class="prereq-node ${n.cls}" transform="translate(${n.x},${n.y})">`;
            svg += `<rect width="${nodeW}" height="${nodeH}" stroke-width="1.5"/>`;
            svg += `<text x="${nodeW / 2}" y="${nodeH / 2 + 4}" text-anchor="middle">${n.code}</text>`;
            svg += `</g>`;
        });

        svg += '</svg>';
        return svg;
    },
};
