const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');
const { GLOBAL_DEFAULTS } = require('../widgetConfig');

function boot(t, global = {}) {
    const f = bootApplication({ version: 2,
        global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false, channelsCount: '2', ...global },
        widgets: [], workspace: { step: 10, rects: {} }, nextNumber: 1 });
    t.after(() => f.app.dispose());
    return f;
}

test('left export keeps unmatched bytes while right BIN and Hex use only successful frames', async t => {
    const f = boot(t, { enableHeader: true, headerHex: 'AB' });
    const wave = f.app.widgets.create({ type: 'wave' });
    f.app.service.receive(Uint8Array.of(0x99, 0xab, 4, 5, 0x88));
    f.app.service.endStream(); await f.tick();
    assert.ok(f.get('export-panel').closest('#sidebar-top'));
    assert.ok(f.get('tab-widget-export').closest('#monitor-settings-tabs'));
    f.change('export-format', 'binary'); f.change('export-source', 'base');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0x99, 0xab, 4, 5, 0x88]);
    f.app.widgets.activate(wave.id); f.click('tab-widget-export-button');
    assert.equal(wave.lastTab, 'tab-widget-export');
    f.change('widget-export-format', 'binary');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [0xab, 4, 5]);
    f.change('widget-export-format', 'hex-text');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.equal(await f.blobs.at(-1).text(), 'AB 04 05\r\n');
    f.app.widgets.activate(null);
    assert.equal(f.get('btn-widget-export').disabled, true);
    assert.equal(await f.app.exportData(), true);
});

test('text follows text-byte source encoding while engine text and CSV follow the active channels', async t => {
    const f = boot(t);
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'lf', textEncoding: 'gbk' } });
    f.app.widgets.activate(byte.id);
    f.app.service.receive(Uint8Array.of(0xd6, 0xd0, 0x0a, 0)); f.app.service.endStream(); await f.tick();
    f.change('widget-export-format', 'text');
    f.change('widget-export-output-encoding', 'utf-16be');
    assert.equal(await f.app.exportWidgetData(), true);
    const decoded = new TextDecoder('utf-16be').decode(await f.blobs.at(-1).arrayBuffer());
    assert.match(decoded, /^中\n/);
    f.change('widget-export-format', 'csv');
    assert.equal(f.get('btn-widget-export').disabled, true);
    f.change('capture-mode', 'hex');
    f.change('widget-export-format', 'text');
    assert.equal(f.get('btn-widget-export').disabled, true);
    f.change('capture-mode', 'engine');
    f.app.widgets.setChannelVisible(0, false);
    f.change('widget-export-format', 'engine-text');
    assert.equal(await f.app.exportWidgetData(), true);
    const text = await f.blobs.at(-1).text();
    assert.match(text, /CH00002=208/);
    assert.doesNotMatch(text, /CH00001/);
    f.change('widget-export-format', 'csv');
    assert.equal(await f.app.exportWidgetData(), true);
    assert.match(await f.blobs.at(-1).text(), /^Index,CH00002\r\n/);
});

test('removing the only owner of a local raw source requires reselection', async t => {
    const f = boot(t);
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'lf' } });
    f.app.service.receive(Uint8Array.of(4, 5)); f.app.service.endStream(); await f.tick();
    f.change('export-format', 'binary'); f.change('export-source', byte.id);
    assert.equal(f.get('btn-export').disabled, false);
    f.app.widgets.remove(byte.id);
    assert.equal(f.get('export-source').value, '');
    assert.equal(f.get('btn-export').disabled, true);
    assert.equal(await f.app.exportData(), false);
    f.change('export-source', 'base');
    assert.equal(await f.app.exportData(), true);
});

test('TX-only export ignores a removed RX range and reports its own retained byte count', async t => {
    const f = boot(t);
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'lf' } });
    f.change('export-format', 'binary'); f.change('export-source', byte.id);
    f.change('export-direction', 'tx'); f.app.service.appendTx(Uint8Array.of(67, 68, 69)); f.app.widgets.remove(byte.id);
    assert.equal(f.get('wrap-export-source').hidden, true);
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs.at(-1).arrayBuffer())], [67, 68, 69]);
    assert.match(f.get('export-range-summary').textContent, /原始字节 3 B/);
    assert.match(f.get('export-range-summary').textContent, /时间范围/);
    f.change('export-direction', 'rx');
    assert.equal(f.get('wrap-export-source').hidden, false);
    assert.equal(f.get('btn-export').disabled, true);
});

test('shared raw buffers appear once and the surviving owner keeps their export range', t => {
    const f = boot(t), settings = { captureMode: 'text', textBoundary: 'lf' };
    const first = f.app.widgets.create({ type: 'byte', settings }), second = f.app.widgets.create({ type: 'byte', settings });
    f.app.widgets.create({ type: 'byte', settings: { captureMode: 'engine' } });
    assert.deepEqual(f.get('export-source').options.map(option => option.value), ['base', first.id]);
    f.change('export-source', first.id);
    assert.match(f.get('export-scope-hint').textContent, new RegExp(second.title));
    f.app.widgets.remove(first.id);
    assert.equal(f.get('export-source').value, second.id);
});

test('older text output metadata migrates to the widget panel and old numeric ranges use base raw records', t => {
    const initial = boot(t);
    const config = initial.app.getConfig();
    delete config.tools.widgetExport;
    Object.assign(config.tools, { exportFormat: 'text', exportSourceId: 'numeric', exportRecordSourceId: 'numeric' });
    Object.assign(config.tools.exportProfiles.numeric.formats.text, { outputEncoding: 'gbk', timestamps: true, markers: true });
    const f = bootApplication(config); t.after(() => f.app.dispose());
    assert.equal(f.get('export-source').value, 'base');
    assert.equal(f.get('widget-export-format').value, 'text');
    assert.equal(f.get('widget-export-output-encoding').value, 'gbk');
    assert.equal(f.get('widget-export-timestamps').checked, true);
    assert.equal(f.get('widget-export-markers').checked, true);
});
