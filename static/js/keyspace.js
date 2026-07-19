/*
 * Storage keyspace and device-local accounts.
 *
 * Constraint 2: a student can have more than one set of plans on a shared
 * machine, with no server, no credentials, and no user records anywhere. The
 * site is static; there is nowhere to keep an account but this browser.
 *
 * How it works, and why it is this small: an account is a name and an id. The
 * active id prefixes storage keys, so two accounts cannot see each other's data
 * even though they share one origin. Switching writes the active id and reloads.
 *
 * The reload is the whole design. An in-place switch would need every module to
 * tear down its subscriptions and rebuild against new data, which is a lifecycle
 * system, a registry, and a class of double-subscription bug that is hard to
 * see and easy to ship. A reload is correct by construction on a static site
 * and costs a few hundred milliseconds of a thing a student does rarely.
 *
 * Keys not yet routed through here keep working unchanged: an unprefixed key is
 * shared by every account on the device, which is the right default for things
 * like sidebar width and the wrong one for plans. Callers move over one at a
 * time.
 */
(function initKeyspace(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.Keyspace = api;
}(typeof globalThis === 'object' ? globalThis : self, root => {
    'use strict';

    const ACCOUNTS_KEY = 'uosc-accounts-v1';
    const DEVICE_SCOPE = 'device';

    function storage() {
        try {
            return root.localStorage || null;
        } catch (error) {
            // Access itself throws in some privacy modes, before any read.
            return null;
        }
    }

    /*
     * Every storage access in the application funnels through these two, so the
     * quota and private-mode guards exist once rather than in each caller. The
     * previous arrangement repeated a bare try/catch at roughly a dozen sites,
     * each silently doing nothing, which is why a student in private browsing
     * got an application that appeared to save and did not.
     */
    function readRaw(key) {
        const store = storage();
        if (!store) return null;
        try {
            return store.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function writeRaw(key, value) {
        const store = storage();
        if (!store) return false;
        try {
            store.setItem(key, value);
            return true;
        } catch (error) {
            // Quota exhausted or storage denied. Reported rather than swallowed
            // so a caller can tell the student their work is not being saved.
            return false;
        }
    }

    function readAccounts() {
        try {
            const parsed = JSON.parse(readRaw(ACCOUNTS_KEY) || 'null');
            if (!parsed || typeof parsed !== 'object') return null;
            if (!Array.isArray(parsed.accounts)) return null;
            return parsed;
        } catch (error) {
            return null;
        }
    }

    const api = {
        DEVICE_SCOPE,

        /* The active account id, or 'device' when none has been created. */
        activeId() {
            const doc = readAccounts();
            if (!doc || !doc.activeId) return DEVICE_SCOPE;
            return doc.accounts.some(account => account.id === doc.activeId)
                ? doc.activeId
                : DEVICE_SCOPE;
        },

        list() {
            const doc = readAccounts();
            return doc ? doc.accounts.map(account => ({ ...account })) : [];
        },

        /*
         * Scope a key to the active account. Data written before accounts
         * existed keeps the unprefixed key under the device scope, so a student
         * who never creates an account sees exactly what they saw before.
         */
        key(name) {
            const id = api.activeId();
            return id === DEVICE_SCOPE ? String(name) : `acct:${id}:${name}`;
        },

        /* Explicitly device-wide: shared by every account. Layout preferences. */
        deviceKey(name) {
            return String(name);
        },

        read(name) {
            return readRaw(api.key(name));
        },

        write(name, value) {
            return writeRaw(api.key(name), String(value));
        },

        /* True when storage is usable, so a caller can say so rather than guess. */
        isWritable() {
            const probe = '__uosc_probe__';
            if (!writeRaw(probe, '1')) return false;
            const store = storage();
            try {
                store.removeItem(probe);
            } catch (error) { /* removal failing does not change writability */ }
            return true;
        },

        create(name) {
            const label = String(name || '').trim();
            if (!label) throw new Error('An account needs a name.');
            const doc = readAccounts() || { accounts: [], activeId: null };
            const id = `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
            doc.accounts.push({ id, name: label });
            if (!doc.activeId) doc.activeId = id;
            writeRaw(ACCOUNTS_KEY, JSON.stringify(doc));
            return id;
        },

        /*
         * Switch and reload. Nothing is torn down in place, so there is no
         * partially-switched state for a module to observe.
         */
        switchTo(id, { reload = true } = {}) {
            const doc = readAccounts();
            if (!doc || !doc.accounts.some(account => account.id === id)) {
                throw new Error(`No such account: ${id}`);
            }
            doc.activeId = id;
            writeRaw(ACCOUNTS_KEY, JSON.stringify(doc));
            if (reload && root.location && typeof root.location.reload === 'function') {
                root.location.reload();
            }
            return id;
        },

        /*
         * Remove an account and everything scoped to it. Deliberately explicit:
         * this is the only operation here that destroys a student's work.
         */
        remove(id) {
            const doc = readAccounts();
            if (!doc) return false;
            const remaining = doc.accounts.filter(account => account.id !== id);
            if (remaining.length === doc.accounts.length) return false;
            const store = storage();
            if (store) {
                const prefix = `acct:${id}:`;
                const doomed = [];
                try {
                    for (let index = 0; index < store.length; index += 1) {
                        const key = store.key(index);
                        if (key && key.startsWith(prefix)) doomed.push(key);
                    }
                    doomed.forEach(key => store.removeItem(key));
                } catch (error) { /* leaving orphaned keys is better than throwing */ }
            }
            doc.accounts = remaining;
            if (doc.activeId === id) doc.activeId = remaining.length ? remaining[0].id : null;
            writeRaw(ACCOUNTS_KEY, JSON.stringify(doc));
            return true;
        },
    };

    return api;
}));
