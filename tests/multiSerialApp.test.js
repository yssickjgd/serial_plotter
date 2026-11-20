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

test('serial data engines and widget input bindings isolate parsing and export per connection', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('chk-header', false); f.change('data-type', 'uint8');
    await f.app.engineView.apply();
    f.click('serial-source-add');
    const secondary = f.app.serialSources.get('serial-2');
    f.change('engine-connection-source', 'serial-2');
    f.change('engine-mode', 'Data_Array'); f.change('chk-header', false);
    f.change('data-type', 'uint16'); f.change('channels-count', '2');
    await f.app.engineView.apply();
    assert.equal(f.app.dataEngine.config.array.dataType, 'uint8');
    assert.equal(secondary.capture.dataEngine.config.array.dataType, 'uint16');
    const mainWave = f.app.widgets.create({ type: 'wave' });
    const secondWave = f.app.widgets.create({ type: 'wave' });
    f.change('widget-connection-source', 'serial-2');
    f.app.widgets.setChannelVisible(1, true);
    const byte = f.app.widgets.create({ type: 'byte' });
    f.change('widget-connection-source', 'serial-2');
    f.change('capture-mode', 'engine');

    f.app.service.receive(Uint8Array.of(33));
    secondary.capture.receive(Uint8Array.of(0x34, 0x12, 0x78, 0x56));
    await f.settle();
    assert.equal(mainWave.source.frames.getValue(0, 0), 33);
    assert.equal(secondWave.source.frames.getValue(0, 0), 0x1234);
    assert.equal(secondWave.source.frames.getValue(1, 0), 0x5678);
    assert.equal(byte.source, secondWave.source);

    f.app.widgets.activate(secondWave.id);
    f.change('widget-export-format', 'csv');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.match(await f.blobs.at(-1).text(), /22136/);

    const restored = bootApplication(f.app.getConfig()); t.after(() => restored.app.dispose());
    const restoredWave = restored.app.widgets.widgets.get(secondWave.id);
    assert.equal(restoredWave.settings.connectionSource, 'serial-2');
    assert.equal(restored.app.serialSources.get('serial-2').capture.dataEngine.config.array.channelsCount, '2');
});

test('cross-connection time navigation uses timestamps and applies a signed millisecond offset', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    f.change('chk-header', false); f.change('data-type', 'uint8'); await f.app.engineView.apply();
    f.click('serial-source-add');
    const second = f.app.serialSources.get('serial-2');
    f.change('engine-connection-source', 'serial-2');
    f.change('engine-mode', 'Data_Array'); f.change('chk-header', false); f.change('data-type', 'uint8');
    await f.app.engineView.apply();
    const a = f.app.widgets.create({ type: 'wave' }), b = f.app.widgets.create({ type: 'wave' });
    f.change('widget-connection-source', 'serial-2');
    f.app.service.receive(Uint8Array.of(1), { timestamp: 1000 });
    f.app.service.receive(Uint8Array.of(2), { timestamp: 1004 });
    second.capture.receive(Uint8Array.of(4), { timestamp: 2000 });
    second.capture.receive(Uint8Array.of(5), { timestamp: 2004 });
    await f.settle();
    f.app.widgets.activate(a.id); f.click('btn-pause');
    f.change('nav-jump-mode', 'relative'); f.change('nav-jump-relative', '.004');
    assert.equal(f.app.tools.jumpToTime(), true);
    assert.equal(b.view.navigationMarkers.timeOrder, null);
    assert.match(f.get('nav-jump-status').textContent, /超出保留范围/);
    f.change('serial-2-timeOffsetMs', '-1000');
    assert.equal(f.app.tools.jumpToTime(), true);
    assert.equal(b.view.navigationMarkers.timeOrder, b.source.frames.orderAt(1));
    assert.equal(f.app.getConfig().serialSources.entries[0].timeOffsetMs, -1000);
});

test('regular sends target the selected physical connection and retain its own TX bytes', async t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const primary = makePort(), secondary = makePort(), ports = [primary, secondary], sent = [[], []];
    ports.forEach((port, index) => {
        port.writable = { getWriter: () => ({ write: async bytes => sent[index].push([...bytes]), releaseLock() {} }) };
    });
    f.context.navigator.serial = { requestPort: async () => ports.shift() };
    f.click('btn-connect'); await f.tick(1);
    f.click('serial-source-add'); f.click('serial-2-connect'); await f.tick(1);
    f.change('send-connection-source', 'serial-2'); f.change('send-input', 'AB CD');
    f.change('send-interval', '1');
    f.click('btn-send'); await f.tick(1);
    assert.deepEqual(sent, [[], [[0xab, 0xcd]]]);
    assert.equal(f.app.service.txFrames.length, 0);
    const target = f.app.serialSources.get('serial-2').capture;
    assert.deepEqual([...target.txFrames.rawBytesAt(0)], [0xab, 0xcd]);
    f.change('send-connection-source', 'primary'); await f.tick(2000);
    assert.deepEqual(sent, [[], [[0xab, 0xcd]]]);
    f.change('send-interval', '0'); f.click('btn-send'); await f.tick(1);
    assert.deepEqual(sent, [[[0xab, 0xcd]], [[0xab, 0xcd]]]);

    f.change('export-source', 'serial-2'); f.change('export-format', 'binary');
    f.change('export-direction', 'tx');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0xab, 0xcd]);
});

test('a secondary custom protocol decodes and exports its own fields without changing primary rules', async t => {
    const original = bootApplication(); t.after(() => original.app.dispose());
    original.click('serial-source-add');
    const config = original.app.getConfig(), source = config.serialSources.entries[0];
    const schema = { id: 'secondary-protocol', endian: 'little',
        framing: { header: [170], fixedLength: 4 }, command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
        messages: [{ id: 'data', name: '温度', command: 1, fields: [{ name: 'temperature', type: 'int16' }] }] };
    Object.assign(source.engine, { mode: 'Self_Defined_Frame', protocols: [schema], protocolId: schema.id,
        mappings: [{ protocolId: schema.id, messageId: 'data', path: 'temperature', channel: 0 }] });
    const f = bootApplication(config); t.after(() => f.app.dispose());
    const secondary = f.app.serialSources.get('serial-2').capture;
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine', connectionSource: 'serial-2' } });
    secondary.receive(Uint8Array.of(170, 1, 0x4c, 0x04));
    await f.tick(20);
    assert.equal(byte.source.kind, 'protocol');
    assert.equal(byte.source.frames.length, 1);
    assert.equal(f.app.service.numericSource.frames.length, 0);
    f.change('widget-export-format', 'engine-text');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.match(await f.blobs.at(-1).text(), /temperature=1100/);
    f.change('send-connection-source', 'serial-2');
    assert.equal(f.app.protocolSession.getProtocol(schema.id)?.id, schema.id);
    f.change('send-connection-source', 'primary');
    assert.equal(f.app.protocolSession.getProtocol(schema.id), undefined);
});
