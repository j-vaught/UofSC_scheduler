const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadSiteNotices(contextValues = {}) {
    const context = vm.createContext({
        Date,
        Number,
        Promise,
        Set,
        encodeURIComponent,
        ...contextValues,
    });
    const source = `${fs.readFileSync('static/js/notices.js', 'utf8')}\n`
        + 'globalThis.__result = SiteNotices;';
    vm.runInContext(source, context);
    return context.__result;
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.listeners = {};
        this.hidden = false;
        this.parent = null;
        this.textContent = '';
    }

    appendChild(child) {
        child.parent = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        this.children = [];
        children.forEach(child => this.appendChild(child));
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    addEventListener(name, listener) {
        this.listeners[name] = listener;
    }

    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }
}

function fakeDocument(container) {
    return {
        createElement(tagName) { return new FakeElement(tagName); },
        getElementById(id) { return id === 'site-notices' ? container : null; },
    };
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
        values,
    };
}

test('notice visibility respects active flags, date windows, and revision dismissals', () => {
    const notices = loadSiteNotices();
    const storage = memoryStorage();
    const payload = {
        notices: [
            { id: 'inactive', active: false, title: 'Inactive' },
            { id: 'future', start: '2026-08-01T00:00:00Z', title: 'Future' },
            { id: 'expired', end: '2026-06-01T00:00:00Z', title: 'Expired' },
            { id: 'current', revision: 2, title: 'Current' },
        ],
    };

    let visible = notices.visibleNotices(payload, {
        storage,
        now: new Date('2026-07-16T12:00:00Z'),
    });
    assert.deepEqual(visible.map(notice => notice.id), ['current']);

    storage.setItem(notices.dismissalKey(visible[0]), '1');
    visible = notices.visibleNotices(payload, {
        storage,
        now: new Date('2026-07-16T12:00:00Z'),
    });
    assert.equal(visible.length, 0);

    payload.notices[3].revision = 3;
    visible = notices.visibleNotices(payload, {
        storage,
        now: new Date('2026-07-16T12:00:00Z'),
    });
    assert.equal(visible.length, 1);
});

test('notices render with text nodes, safe links, and persistent dismissal', () => {
    const notices = loadSiteNotices();
    const storage = memoryStorage();
    const container = new FakeElement('div');
    const documentRef = fakeDocument(container);

    const rendered = notices.render({
        notices: [{
            id: 'help',
            revision: 4,
            kind: 'help',
            title: '<b>Need help?</b>',
            message: '<img src=x onerror=alert(1)>',
            link: { url: 'javascript:alert(1)', label: 'Unsafe link' },
        }],
    }, { container, documentRef, storage, now: new Date() });

    assert.equal(rendered.length, 1);
    assert.equal(container.hidden, false);
    assert.equal(rendered[0].className, 'site-notice site-notice--help');
    assert.equal(rendered[0].children[0].children[0].textContent, '<b>Need help?</b>');
    assert.equal(rendered[0].children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(rendered[0].children[0].children.length, 2);

    const dismiss = rendered[0].children[1];
    dismiss.listeners.click();
    assert.equal(container.children.length, 0);
    assert.equal(container.hidden, true);
    assert.equal(storage.getItem(notices.dismissalKey({ id: 'help', revision: 4 })), '1');
});

test('initialization fails silently when the static config cannot be loaded', async () => {
    const notices = loadSiteNotices();
    const container = new FakeElement('div');
    const result = await notices.init({
        container,
        documentRef: fakeDocument(container),
        fetchImpl: async () => { throw new Error('offline'); },
    });

    assert.equal(result.length, 0);
    assert.equal(container.children.length, 0);
});

test('initialization loads the static config and renders an active notice', async () => {
    const notices = loadSiteNotices();
    const container = new FakeElement('div');
    let requestedUrl = '';
    const result = await notices.init({
        container,
        documentRef: fakeDocument(container),
        fetchImpl: async url => {
            requestedUrl = url;
            return {
                ok: true,
                async json() {
                    return {
                        notices: [{
                            id: 'maintenance',
                            kind: 'maintenance',
                            title: 'Maintenance tonight',
                            dismissible: false,
                        }],
                    };
                },
            };
        },
    });

    assert.equal(requestedUrl, '/static/data/site_notices.json');
    assert.equal(result.length, 1);
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].children.length, 1);
});

test('notice implementation never inserts config as HTML', () => {
    const source = fs.readFileSync('static/js/notices.js', 'utf8');
    assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);

    const config = JSON.parse(fs.readFileSync('static/data/site_notices.json', 'utf8'));
    assert.deepEqual(
        config.notices.map(notice => notice.kind),
        ['maintenance', 'help', 'action'],
    );
    assert.ok(config.notices.every(notice => notice.active === false));
});
