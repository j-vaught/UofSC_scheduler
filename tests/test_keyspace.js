'use strict';

/*
 * Device-local accounts, constraint 2: more than one student's plans on a shared
 * machine, with no server, no credentials, and no user records anywhere.
 *
 * The property that matters is separation. If two accounts can see each other's
 * plans the feature is worse than not having it, because a student would believe
 * their work is private when it is not.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

function freshStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        get length() { return map.size; },
        key: index => [...map.keys()][index] ?? null,
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: k => map.delete(k),
        _map: map,
    };
}

function loadKeyspace(storage = freshStorage(), location = { reload() {} }) {
    // The module resolves storage lazily on every call, not once at load, so
    // the globals have to stay in place for the duration of the test rather
    // than only while requiring. Each test calls this fresh, which re-points
    // them, so tests stay independent without restoring in between.
    delete require.cache[require.resolve('../static/js/keyspace.js')];
    global.localStorage = storage;
    global.location = location;
    const keyspace = require('../static/js/keyspace.js');
    return { keyspace, storage };
}

test('with no account, keys are unprefixed so existing data keeps working', () => {
    const { keyspace } = loadKeyspace();
    assert.equal(keyspace.activeId(), 'device');
    assert.equal(keyspace.key('uosc-scheduler-plans'), 'uosc-scheduler-plans');
});

test('two accounts cannot read each other keys', () => {
    const { keyspace } = loadKeyspace();
    const alice = keyspace.create('Alice');
    const bob = keyspace.create('Bob');

    keyspace.switchTo(alice, { reload: false });
    const aliceKey = keyspace.key('uosc-scheduler-plans');
    keyspace.switchTo(bob, { reload: false });
    const bobKey = keyspace.key('uosc-scheduler-plans');

    assert.notEqual(aliceKey, bobKey, 'accounts must not share a storage key');
    assert.match(aliceKey, /^acct:/);
    assert.match(bobKey, /^acct:/);
});

test('data written under one account is invisible to the other', () => {
    const { keyspace } = loadKeyspace();
    const alice = keyspace.create('Alice');
    const bob = keyspace.create('Bob');

    keyspace.switchTo(alice, { reload: false });
    keyspace.write('uosc-scheduler-plans', '{"alice":true}');
    keyspace.switchTo(bob, { reload: false });

    assert.equal(keyspace.read('uosc-scheduler-plans'), null, 'Bob must not see Alice data');
    keyspace.write('uosc-scheduler-plans', '{"bob":true}');
    keyspace.switchTo(alice, { reload: false });
    assert.equal(keyspace.read('uosc-scheduler-plans'), '{"alice":true}', 'Alice data must survive');
});

test('switching reloads, because an in-place switch would need a lifecycle system', () => {
    let reloads = 0;
    const { keyspace } = loadKeyspace(freshStorage(), { reload() { reloads += 1; } });
    const id = keyspace.create('Alice');
    keyspace.switchTo(id);
    assert.equal(reloads, 1);
});

test('switching to an unknown account throws rather than silently doing nothing', () => {
    const { keyspace } = loadKeyspace();
    assert.throws(() => keyspace.switchTo('not-an-account', { reload: false }), /No such account/);
});

test('removing an account deletes only its data', () => {
    const { keyspace } = loadKeyspace();
    const alice = keyspace.create('Alice');
    const bob = keyspace.create('Bob');

    keyspace.switchTo(alice, { reload: false });
    keyspace.write('uosc-scheduler-plans', 'alice-plans');
    keyspace.switchTo(bob, { reload: false });
    keyspace.write('uosc-scheduler-plans', 'bob-plans');

    keyspace.remove(alice);
    assert.deepEqual(keyspace.list().map(a => a.name), ['Bob']);
    keyspace.switchTo(bob, { reload: false });
    assert.equal(keyspace.read('uosc-scheduler-plans'), 'bob-plans', 'Bob data must survive Alice removal');
});

test('device-scoped keys stay shared, which is right for layout preferences', () => {
    const { keyspace } = loadKeyspace();
    const alice = keyspace.create('Alice');
    keyspace.switchTo(alice, { reload: false });
    assert.equal(keyspace.deviceKey('uofsc-schedule-sidebar-width-v1'), 'uofsc-schedule-sidebar-width-v1');
});

test('denied storage is reported rather than silently dropping writes', () => {
    const denied = {
        get length() { return 0; },
        key: () => null,
        getItem() { throw new Error('SecurityError'); },
        setItem() { throw new Error('QuotaExceededError'); },
        removeItem() {},
    };
    const { keyspace } = loadKeyspace(denied);
    assert.equal(keyspace.isWritable(), false, 'a caller must be able to tell the student');
    assert.doesNotThrow(() => keyspace.read('anything'));
    assert.equal(keyspace.write('anything', 'x'), false, 'a failed write must report failure');
});

test('an account name is required', () => {
    const { keyspace } = loadKeyspace();
    assert.throws(() => keyspace.create('   '), /needs a name/);
});
