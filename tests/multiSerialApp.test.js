const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

function makePort() {
    let read;
    const port = {
        opened: null, closed: 0,
        open: async options => { port.opened = options; },
        close: async () => { port.closed++; },
        readable: { getReader: () => ({
            read: () => new Promise(resolve => { read = resolve; }),
            cancel: async () => read?.({ done: true }),
            releaseLock() {}
        }) },
        receive: bytes => read({ value: Uint8Array.from(bytes) })
    };
    return port;
}

test('additional serial connections keep independent raw histories and can export the selected source', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const primary = makePort(), secondary = makePort(), ports = [primary, secondary];
    f.context.navigator.serial = { requestPort: async () => ports.shift() };
    f.change('serial-baud', '2000000');
    f.click('btn-connect'); await f.tick(1);
    f.click('serial-source-add');
    f.change('serial-2-name', '第二路');
    f.change('serial-2-baudRate', '460800');
    f.click('serial-2-connect'); await f.tick(1);
    assert.equal(primary.opened.baudRate, 2000000);
    assert.equal(secondary.opened.baudRate, 460800);

    primary.receive([0xa1, 0xa2]);
    secondary.receive([0xb1, 0xb2]);
    await f.tick(1);
    await f.tick(55);
    f.click('serial-2-connect'); await f.tick(1);
    assert.equal(primary.closed, 0);
    assert.equal(secondary.closed, 1);
    assert.equal(f.app.service.history.endByte, 2);
    assert.equal(f.app.serialSources.get('serial-2').capture.history.endByte, 2);
    assert.match(f.get('serial-2-status').textContent, /已断开.*RX 2 B/);

    f.change('export-source', 'serial-2');
    f.change('export-format', 'binary');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0xb1, 0xb2]);
    f.change('export-source', 'base');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0xa1, 0xa2]);

    const config = f.app.getConfig();
    const restored = bootApplication(config); t.after(() => restored.app.dispose());
    assert.equal(restored.get('serial-2-name').value, '第二路');
    assert.equal(restored.get('serial-2-baudRate').value, '460800');
    assert.equal(restored.app.serialSources.get('serial-2').capture.history.endByte, 0);
    f.click('btn-clear'); await f.tick(1);
    assert.equal(f.app.serialSources.get('serial-2').capture.history.endByte, 0);
});

test('serial source settings validate atomically and removing a disconnected source preserves the shared capture pool', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.click('serial-source-add');
    const source = f.app.serialSources.get('serial-2');
    const primaryPool = f.app.service.workerPool;
    assert.equal(source.capture.workerPool, primaryPool);
    assert.equal(source.capture.memory.limitBytes + f.app.service.memory.limitBytes, 4096 * 1048576);
    const config = f.app.getConfig();
    config.serialSources.entries.push({ ...config.serialSources.entries[0] });
    assert.throws(() => f.app.applyConfig(config), /串口来源编号重复/);
    assert.equal(f.app.serialSources.get('serial-2'), source);
    f.change('conn-type', 'udp');
    assert.equal(f.get('serial-source-add').hidden, true);
    assert.equal(f.get('serial-source-list').hidden, false);
    f.click('serial-2-remove');
    assert.equal(f.app.serialSources.size, 0);
    assert.equal(source.capture.disposed, true);
    assert.equal(primaryPool.disposed, false);
    assert.equal(f.app.service.memory.limitBytes, 4096 * 1048576);
    f.change('conn-type', 'serial');
    f.click('serial-source-add');
    assert.equal(f.app.serialSources.has('serial-3'), true);
});
