const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');
const { createIndexedDbHarness } = require('./helpers/indexedDbHarness');

const CONFIG_KEY = 'serialplot_v3_config';
const copy = value => JSON.parse(JSON.stringify(value));
async function bootIndexedDb(t, options = {}) {
    const f = bootApplication(options.legacy ?? null);
    const initial = f.S.WidgetConfig.migrateWorkspaceConfig(f.app.getConfig());
    await f.app.dispose();
    const config = options.config ? options.config(initial) : initial;
    const database = createIndexedDbHarness({ seed: { [CONFIG_KEY]: config }, ...options.database });
    f.context.indexedDB = database.indexedDB;
    f.S.application = undefined;
    f.document.dispatchEvent({ type: 'DOMContentLoaded' });
    assert.equal(f.S.application, undefined, 'IndexedDB configuration must load before constructing the application');
    assert.ok(f.S.applicationReady instanceof Promise || typeof f.S.applicationReady?.then === 'function');
    const ready = await f.S.applicationReady;
    assert.equal(ready, f.S.application);
    f.app = ready;
    t.after(() => f.app.dispose());
    return { f, database, config };
}

test('no-IndexedDB startup remains synchronous while exposing a ready promise and version 3 configuration', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    assert.ok(f.app);
    assert.equal(f.app.getConfig().version, 3);
    assert.equal(await f.S.applicationReady, f.app);
    assert.equal(f.app.workspaceStorage.hasIndexedDB, false);
    assert.equal(typeof f.app.flushConfig, 'function');
});

test('IndexedDB startup restores the saved configuration before widgets and layout initialize', async t => {
    const { f } = await bootIndexedDb(t, { config: config => {
        config.global.serialBaud = '57600'; config.uiLayout.leftSplitRatio = .65;
        return config;
    } });
    assert.equal(f.get('serial-baud').value, '57600');
    assert.equal(f.app.getConfig().uiLayout.leftSplitRatio, .65);
    assert.equal(f.app.workspaceStorage.hasIndexedDB, true);
});

test('save feedback waits for the IndexedDB transaction and the compatibility mirror retains the old configuration', async t => {
    const { f, database } = await bootIndexedDb(t, { database: { holdWrites: true } });
    const oldMirror = f.storage.get(CONFIG_KEY);
    f.change('serial-baud', '57600'); await f.tick(200);
    assert.equal(database.writes.length, 1);
    assert.doesNotMatch(f.get('cfg-save-status').textContent, /配置已保存/);
    assert.equal(f.storage.get(CONFIG_KEY), oldMirror);
    database.writes[0].complete();
    await f.app.flushConfig();
    assert.equal(database.records.get(CONFIG_KEY).global.serialBaud, '57600');
    assert.equal(JSON.parse(f.storage.get(CONFIG_KEY)).global.serialBaud, '57600');
    assert.match(f.get('cfg-save-status').textContent, /配置已保存/);
});

test('queued application saves cannot commit stale configuration after a newer change', async t => {
    const { f, database } = await bootIndexedDb(t, { database: { holdWrites: true } });
    f.change('serial-baud', '57600'); await f.tick(200);
    f.change('serial-baud', '38400'); await f.tick(200);
    assert.equal(database.writes.length, 1);
    database.writes[0].complete();
    for (let index = 0; index < 15; index++) await Promise.resolve();
    assert.equal(database.writes.length, 2);
    assert.doesNotMatch(f.get('cfg-save-status').textContent, /配置已保存/);
    database.writes[1].complete(); await f.app.flushConfig();
    assert.equal(database.records.get(CONFIG_KEY).global.serialBaud, '38400');
    assert.match(f.get('cfg-save-status').textContent, /配置已保存/);
});

test('failed startup reads show an error and block automatic default overwrites until a valid explicit import', async t => {
    const original = '{broken';
    const f = bootApplication(original); t.after(() => f.app.dispose());
    assert.match(f.get('cfg-save-status').textContent, /读取|加载/);
    f.change('serial-baud', '57600'); await f.tick(200);
    assert.equal(f.storage.get(CONFIG_KEY), original);
    const before = JSON.stringify(f.app.getConfig());
    assert.throws(() => f.app.applyConfig({ version: 999 }));
    assert.equal(JSON.stringify(f.app.getConfig()), before);
    assert.equal(f.storage.get(CONFIG_KEY), original);
    const imported = f.app.getConfig(); imported.uiLayout.leftSplitRatio = .72;
    f.app.applyConfig(imported); await f.app.flushConfig();
    assert.equal(JSON.parse(f.storage.get(CONFIG_KEY)).uiLayout.leftSplitRatio, .72);
});

test('an IndexedDB read failure preserves saved data and keeps subsequent UI changes unsaved', async t => {
    const f = bootApplication(); const initial = f.S.WidgetConfig.migrateWorkspaceConfig(f.app.getConfig()); await f.app.dispose();
    const database = createIndexedDbHarness({ seed: { [CONFIG_KEY]: initial } });
    database.failNextRead = new Error('Cannot read workspace');
    f.context.indexedDB = database.indexedDB; f.S.application = undefined;
    f.document.dispatchEvent({ type: 'DOMContentLoaded' }); await f.S.applicationReady;
    f.app = f.S.application; t.after(() => f.app.dispose());
    assert.match(f.get('cfg-save-status').textContent, /Cannot read workspace/);
    f.change('serial-baud', '57600'); await f.tick(200);
    assert.equal(database.writes.length, 0);
    assert.equal(database.records.get(CONFIG_KEY).global.serialBaud, '115200');
});

test('conflicting legacy protocol leaves the original saved workspace untouched and identifies its source', async t => {
    const seed = bootApplication();
    const config = seed.app.getConfig(); await seed.app.dispose();
    config.dataEngine.protocols.push({ id: 'old.conflict', name: '旧测试协议',
        framing: { header: [170], fixedLength: 4, length: { offset: 0, type: 'uint8' } }, payloadOffset: 1,
        messages: [{ id: 'data', fields: [{ name: 'v', type: 'uint8' }] }] });
    const original = JSON.stringify(config), f = bootApplication(original); t.after(() => f.app.dispose());
    assert.match(f.get('cfg-save-status').textContent, /旧测试协议.*old\.conflict/);
    assert.match(f.get('cfg-save-status').textContent, /\[0, 1\)/);
    f.change('serial-baud', '57600'); await f.tick(200);
    assert.equal(f.storage.get(CONFIG_KEY), original);
});

test('a transaction abort reports failure, retains old data, and a later save can recover', async t => {
    const { f, database } = await bootIndexedDb(t);
    database.abortNextWrite = new Error('Disk quota exceeded');
    f.change('serial-baud', '57600'); await f.tick(200);
    await assert.rejects(f.app.flushConfig(), /Disk quota/);
    assert.equal(database.records.get(CONFIG_KEY).global.serialBaud, '115200');
    assert.match(f.get('cfg-save-status').textContent, /Disk quota/);
    f.change('serial-baud', '38400'); await f.app.flushConfig();
    assert.equal(database.records.get(CONFIG_KEY).global.serialBaud, '38400');
});

test('version 3 saves and imports retain data-engine settings and the left split ratio', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const imported = f.app.getConfig(); imported.uiLayout.leftSplitRatio = .3;
    imported.dataEngine.synchronization.sampleRate = 250;
    f.app.applyConfig(imported); await f.app.flushConfig();
    const saved = JSON.parse(f.storage.get(CONFIG_KEY));
    assert.equal(saved.version, 3);
    assert.equal(saved.uiLayout.leftSplitRatio, .3);
    assert.deepEqual(saved.dataEngine, copy(imported.dataEngine));
    const restored = bootApplication(saved); t.after(() => restored.app.dispose());
    assert.deepEqual(copy(restored.app.getConfig().dataEngine), saved.dataEngine);
});
