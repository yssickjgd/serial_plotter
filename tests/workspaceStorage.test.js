const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceStorage } = require('../workspaceStorage');
const { createIndexedDbHarness } = require('./helpers/indexedDbHarness');

const CONFIG_KEY = 'serialplot_v3_config', WORKSPACE_KEY = 'serialplot_v3_workspace';
const clone = value => JSON.parse(JSON.stringify(value));
function localStorageWith(values = {}) {
    const entries = new Map(Object.entries(values));
    return {
        entries, failSet: null,
        getItem(key) { return entries.get(key) ?? null; },
        setItem(key, value) {
            if (this.failSet) throw this.failSet;
            entries.set(key, String(value));
        }
    };
}
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test('localStorage-only loading gives the validator the legacy workspace without saving defaults', async () => {
    const localStorage = localStorageWith({ [CONFIG_KEY]: '{"legacy":true}', [WORKSPACE_KEY]: '{"step":20}' });
    const storage = new WorkspaceStorage({ indexedDB: null, localStorage,
        validate: (config, workspace) => ({ version: 2, old: config.legacy, workspace }) });
    assert.equal(storage.hasIndexedDB, false);
    assert.deepEqual(await storage.load(), { version: 2, old: true, workspace: { step: 20 } });
    assert.equal(localStorage.getItem(CONFIG_KEY), '{"legacy":true}');
    assert.equal(await new WorkspaceStorage({ indexedDB: null, localStorage: localStorageWith() }).load(), null);
});

test('small localStorage-only saves happen immediately and keep an immutable snapshot', async () => {
    const localStorage = localStorageWith();
    const storage = new WorkspaceStorage({ indexedDB: null, localStorage });
    const config = { version: 2, values: [1], workspace: { step: 10 } };
    const saved = storage.save(config);
    config.values[0] = 99;
    assert.deepEqual(JSON.parse(localStorage.getItem(CONFIG_KEY)), { version: 2, values: [1], workspace: { step: 10 } });
    const result = await saved;
    result.values[0] = 33;
    assert.deepEqual(await storage.flush(), { version: 2, values: [1], workspace: { step: 10 } });
});

test('IndexedDB configuration takes precedence over the legacy mirror', async () => {
    const db = createIndexedDbHarness({ seed: { [CONFIG_KEY]: { version: 2, source: 'database' } } });
    const localStorage = localStorageWith({ [CONFIG_KEY]: '{"source":"legacy"}', [WORKSPACE_KEY]: 'broken' });
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage });
    assert.equal(storage.hasIndexedDB, true);
    assert.deepEqual(await storage.load(), { version: 2, source: 'database' });
});

test('a successful request does not report saved or update the mirror before the transaction commits', async () => {
    const db = createIndexedDbHarness({ holdWrites: true });
    const localStorage = localStorageWith({ [CONFIG_KEY]: '{"old":true}' });
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage });
    let settled = false;
    const save = storage.save({ next: true }).then(value => { settled = true; return value; });
    await tick();
    assert.equal(settled, false);
    assert.equal(localStorage.getItem(CONFIG_KEY), '{"old":true}');
    db.writes[0].complete();
    assert.deepEqual(await save, { next: true });
    assert.equal(localStorage.getItem(CONFIG_KEY), '{"next":true}');
});

test('overlapping saves commit in call order and snapshot each supplied configuration', async () => {
    const db = createIndexedDbHarness({ holdWrites: true });
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage: localStorageWith() });
    const config = { values: [1] };
    const first = storage.save(config);
    config.values[0] = 2;
    const second = storage.save(config);
    config.values[0] = 3;
    await tick();
    assert.equal(db.writes.length, 1);
    db.writes[0].complete();
    assert.deepEqual(await first, { values: [1] });
    await tick();
    assert.equal(db.writes.length, 2);
    db.writes[1].complete();
    assert.deepEqual(await second, { values: [2] });
    assert.deepEqual(db.records.get(CONFIG_KEY), { values: [2] });
    assert.deepEqual(await storage.flush(), { values: [2] });
});

test('aborted transactions retain the previous saved configuration and allow the next save', async () => {
    const old = { old: true };
    const db = createIndexedDbHarness({ seed: { [CONFIG_KEY]: old } });
    const localStorage = localStorageWith({ [CONFIG_KEY]: JSON.stringify(old) }), errors = [];
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage, onError: error => errors.push(error) });
    await storage.load();
    db.abortNextWrite = new Error('disk full');
    await assert.rejects(storage.save({ next: true }), /disk full/);
    await assert.rejects(storage.flush(), /disk full/);
    assert.deepEqual(db.records.get(CONFIG_KEY), { old: true });
    assert.equal(localStorage.getItem(CONFIG_KEY), '{"old":true}');
    assert.equal(errors.length, 1);
    assert.deepEqual(await storage.save({ recovered: true }), { recovered: true });
});

test('large saves use an IndexedDB manifest and retain a recoverable legacy backup', async () => {
    const db = createIndexedDbHarness();
    const localStorage = localStorageWith({ [CONFIG_KEY]: '{"old":true}' });
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage });
    const config = { payload: 'x'.repeat(300000) };
    await storage.save(config);
    assert.deepEqual(JSON.parse(localStorage.getItem(CONFIG_KEY)), {
        storage: 'indexedDB', database: 'serialplot_workspace', version: 1, store: 'config', key: CONFIG_KEY
    });
    assert.equal(localStorage.getItem(CONFIG_KEY + '_legacy_backup'), '{"old":true}');
    assert.deepEqual(await new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage }).load(), config);
});

test('a manifest can recover the legacy backup when IndexedDB is unavailable and reports degraded storage', async () => {
    const localStorage = localStorageWith({
        [CONFIG_KEY]: JSON.stringify({ storage: 'indexedDB', database: 'serialplot_workspace', version: 1, store: 'config', key: CONFIG_KEY }),
        [CONFIG_KEY + '_legacy_backup']: '{"old":true}'
    });
    const errors = [];
    const storage = new WorkspaceStorage({ indexedDB: null, localStorage, onError: error => errors.push(error) });
    assert.deepEqual(await storage.load(), { old: true });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /IndexedDB/);
});

test('invalid persisted configuration rejects load and remains untouched', async () => {
    for (const raw of ['broken', '{"invalid":true}']) {
        const localStorage = localStorageWith({ [CONFIG_KEY]: raw }), errors = [];
        const storage = new WorkspaceStorage({ indexedDB: null, localStorage,
            validate: () => { throw new Error('Invalid configuration'); }, onError: error => errors.push(error) });
        await assert.rejects(storage.load());
        assert.equal(localStorage.getItem(CONFIG_KEY), raw);
        assert.equal(errors.length, 1);
    }
});

test('null and non-object saved values cannot be mistaken for a request to create defaults', async () => {
    for (const raw of ['null', '[]', 'true', '42', '"legacy"']) {
        const localStorage = localStorageWith({ [CONFIG_KEY]: raw });
        const storage = new WorkspaceStorage({ indexedDB: null, localStorage, validate: () => ({ defaults: true }) });
        await assert.rejects(storage.load(), /Invalid/);
        assert.equal(localStorage.getItem(CONFIG_KEY), raw);
    }
});

test('a failed IndexedDB read rejects instead of loading an older localStorage mirror', async () => {
    const db = createIndexedDbHarness({ seed: { [CONFIG_KEY]: { newer: true } } });
    db.failNextRead = new Error('Read transaction failed');
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB,
        localStorage: localStorageWith({ [CONFIG_KEY]: '{"older":true}' }) });
    await assert.rejects(storage.load(), /Read transaction failed/);
    assert.deepEqual(db.records.get(CONFIG_KEY), { newer: true });
});

test('a failed synchronous save cannot overwrite the flush status of a later successful save', async () => {
    const localStorage = localStorageWith(), storage = new WorkspaceStorage({ indexedDB: null, localStorage });
    localStorage.failSet = new Error('Quota exceeded');
    const failed = storage.save({ failed: true });
    localStorage.failSet = null;
    const saved = storage.save({ later: true });
    await assert.rejects(failed, /Quota/);
    await saved;
    assert.deepEqual(await storage.flush(), { later: true });
});

test('a missing IndexedDB target never turns a manifest into a configuration', async () => {
    const localStorage = localStorageWith({ [CONFIG_KEY]: JSON.stringify({
        storage: 'indexedDB', database: 'serialplot_workspace', version: 1, store: 'config', key: CONFIG_KEY
    }) });
    const storage = new WorkspaceStorage({ indexedDB: null, localStorage });
    await assert.rejects(storage.load(), /IndexedDB/);
});

test('blocked or failed database opens fall back to small localStorage saves and report the failure', async () => {
    for (const options of [{ blocked: true }, { openError: new Error('IndexedDB unavailable') }]) {
        const db = createIndexedDbHarness(options), localStorage = localStorageWith(), errors = [];
        const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage,
            onError: error => { errors.push(error); throw new Error('Reporter failed'); } });
        assert.deepEqual(await storage.save({ fallback: true }), { fallback: true });
        assert.equal(localStorage.getItem(CONFIG_KEY), '{"fallback":true}');
        assert.equal(errors.length, 1);
    }
});

test('localStorage quota failures and oversized fallback saves reject without overwriting old data', async () => {
    const localStorage = localStorageWith({ [CONFIG_KEY]: '{"old":true}' }), errors = [];
    const storage = new WorkspaceStorage({ indexedDB: null, localStorage, onError: error => errors.push(error) });
    localStorage.failSet = Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
    await assert.rejects(storage.save({ next: true }), /Quota/);
    localStorage.failSet = null;
    await assert.rejects(storage.save({ payload: 'x'.repeat(300000) }), /IndexedDB/);
    assert.equal(localStorage.getItem(CONFIG_KEY), '{"old":true}');
    assert.equal(errors.length, 2);
});

test('mirror failure reports a warning while the committed IndexedDB configuration remains loadable', async () => {
    const db = createIndexedDbHarness(), localStorage = localStorageWith({ [CONFIG_KEY]: '{"old":true}' }), errors = [];
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage, onError: error => errors.push(error) });
    localStorage.failSet = new Error('Mirror quota exceeded');
    assert.deepEqual(await storage.save({ next: true }), { next: true });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'WORKSPACE_STORAGE_MIRROR_FAILED');
    assert.equal(localStorage.getItem(CONFIG_KEY), '{"old":true}');
    assert.deepEqual(await storage.load(), { next: true });
});

test('versionchange closes the connection and subsequent work reopens IndexedDB', async () => {
    const db = createIndexedDbHarness(), storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage: localStorageWith() });
    await storage.save({ first: true });
    db.connections[0].onversionchange();
    assert.equal(db.connections[0].closed, true);
    await storage.save({ second: true });
    assert.equal(db.connections.length, 2);
    assert.deepEqual(await storage.load(), { second: true });
});

test('dispose waits for queued saves, closes the database, and refuses later writes', async () => {
    const db = createIndexedDbHarness({ holdWrites: true });
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage: localStorageWith() });
    const saved = storage.save({ final: true });
    await tick();
    const disposed = storage.dispose();
    assert.equal(db.connections[0].closed, false);
    await assert.rejects(storage.save({ tooLate: true }), /disposed/);
    db.writes[0].complete();
    await saved;
    await disposed;
    assert.equal(db.connections[0].closed, true);
    assert.deepEqual(clone(db.records.get(CONFIG_KEY)), { final: true });
});

test('disposing before IndexedDB opens still commits previously accepted saves to IndexedDB', async () => {
    const db = createIndexedDbHarness(), localStorage = localStorageWith();
    const storage = new WorkspaceStorage({ indexedDB: db.indexedDB, localStorage });
    const save = storage.save({ final: true });
    const disposed = storage.dispose();
    await save;
    await disposed;
    assert.deepEqual(db.records.get(CONFIG_KEY), { final: true });
    assert.equal(db.connections[0].closed, true);
});
