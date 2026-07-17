const SiteNotices = {
    configUrl: '/static/data/site_notices.json',
    storagePrefix: 'course-scheduler.site-notice.dismissed',
    allowedKinds: new Set(['maintenance', 'help', 'action']),

    dismissalKey(notice) {
        const id = encodeURIComponent(String(notice?.id || '').trim());
        const revision = encodeURIComponent(String(notice?.revision ?? 1).trim());
        return `${this.storagePrefix}.${id}.${revision}`;
    },

    normalizeNotice(raw) {
        if (!raw || typeof raw !== 'object') return null;

        const id = String(raw.id || '').trim();
        const title = String(raw.title || '').trim();
        const message = String(raw.message || '').trim();
        if (!id || (!title && !message)) return null;

        const requestedKind = String(raw.kind || raw.type || 'action').toLowerCase();
        const kind = this.allowedKinds.has(requestedKind) ? requestedKind : 'action';
        const rawLink = raw.link && typeof raw.link === 'object' ? raw.link : {};
        const linkUrl = String(rawLink.url || raw.link_url || '').trim();
        const linkLabel = String(rawLink.label || raw.link_label || 'Learn more').trim();

        return {
            id,
            revision: String(raw.revision ?? 1),
            kind,
            active: raw.active !== false,
            dismissible: raw.dismissible !== false,
            title,
            message,
            start: raw.start || null,
            end: raw.end || null,
            link: linkUrl ? {
                url: linkUrl,
                label: linkLabel || 'Learn more',
                newTab: Boolean(rawLink.new_tab ?? raw.link_new_tab),
            } : null,
        };
    },

    isWithinWindow(notice, now = new Date()) {
        if (!notice?.active) return false;
        const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
        if (!Number.isFinite(currentTime)) return false;

        if (notice.start) {
            const startTime = new Date(notice.start).getTime();
            if (!Number.isFinite(startTime) || currentTime < startTime) return false;
        }
        if (notice.end) {
            const endTime = new Date(notice.end).getTime();
            if (!Number.isFinite(endTime) || currentTime > endTime) return false;
        }
        return true;
    },

    wasDismissed(notice, storage) {
        if (!notice?.dismissible || !storage) return false;
        try {
            return storage.getItem(this.dismissalKey(notice)) === '1';
        } catch (_) {
            return false;
        }
    },

    visibleNotices(payload, { now = new Date(), storage = null } = {}) {
        const rawNotices = Array.isArray(payload) ? payload : payload?.notices;
        if (!Array.isArray(rawNotices)) return [];

        return rawNotices
            .map(raw => this.normalizeNotice(raw))
            .filter(Boolean)
            .filter(notice => this.isWithinWindow(notice, now))
            .filter(notice => !this.wasDismissed(notice, storage));
    },

    safeLinkUrl(value) {
        const url = String(value || '').trim();
        if (!url || /[\u0000-\u001f\u007f]/.test(url)) return '';
        if (/^(https?:|mailto:)/i.test(url)) return url;
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return '';
        return url;
    },

    createNoticeElement(notice, { documentRef, storage } = {}) {
        if (!documentRef?.createElement) return null;

        const element = documentRef.createElement('section');
        element.className = `site-notice site-notice--${notice.kind}`;
        element.dataset.noticeId = notice.id;
        element.dataset.noticeRevision = notice.revision;
        element.setAttribute('role', notice.kind === 'maintenance' ? 'alert' : 'status');

        const content = documentRef.createElement('div');
        content.className = 'site-notice__content';

        if (notice.title) {
            const title = documentRef.createElement('strong');
            title.className = 'site-notice__title';
            title.textContent = notice.title;
            content.appendChild(title);
        }

        if (notice.message) {
            const message = documentRef.createElement('span');
            message.className = 'site-notice__message';
            message.textContent = notice.message;
            content.appendChild(message);
        }

        const linkUrl = this.safeLinkUrl(notice.link?.url);
        if (linkUrl) {
            const link = documentRef.createElement('a');
            link.className = 'site-notice__link';
            link.href = linkUrl;
            link.textContent = notice.link.label;
            if (notice.link.newTab) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            content.appendChild(link);
        }

        element.appendChild(content);

        if (notice.dismissible) {
            const dismiss = documentRef.createElement('button');
            dismiss.className = 'site-notice__dismiss';
            dismiss.type = 'button';
            dismiss.textContent = '\u00d7';
            dismiss.setAttribute('aria-label', `Dismiss ${notice.title || 'site notice'}`);
            dismiss.addEventListener('click', () => {
                const parent = element.parentElement || element.parent || null;
                try {
                    storage?.setItem(this.dismissalKey(notice), '1');
                } catch (_) {
                    // The notice still closes when browser storage is unavailable.
                }
                element.remove();
                if (parent && parent.children.length === 0) parent.hidden = true;
            });
            element.appendChild(dismiss);
        }

        return element;
    },

    render(payload, { container, documentRef, storage, now = new Date() } = {}) {
        if (!container || !documentRef) return [];
        const notices = this.visibleNotices(payload, { now, storage });
        const elements = notices
            .map(notice => this.createNoticeElement(notice, { documentRef, storage }))
            .filter(Boolean);

        if (typeof container.replaceChildren === 'function') {
            container.replaceChildren(...elements);
        } else {
            while (container.firstChild) container.removeChild(container.firstChild);
            elements.forEach(element => container.appendChild(element));
        }
        container.hidden = elements.length === 0;
        return elements;
    },

    async init(options = {}) {
        const documentRef = options.documentRef
            || (typeof document !== 'undefined' ? document : null);
        const container = typeof options.container === 'string'
            ? documentRef?.getElementById(options.container)
            : options.container || documentRef?.getElementById('site-notices');
        if (!documentRef || !container) return [];

        const storage = options.storage
            ?? (typeof localStorage !== 'undefined' ? localStorage : null);
        const fetchImpl = options.fetchImpl
            || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
        if (!fetchImpl) return [];

        try {
            const response = await fetchImpl(options.configUrl || this.configUrl, {
                headers: { Accept: 'application/json' },
            });
            if (!response?.ok) return [];
            const payload = await response.json();
            return this.render(payload, {
                container,
                documentRef,
                storage,
                now: options.now || new Date(),
            });
        } catch (_) {
            return [];
        }
    },
};
