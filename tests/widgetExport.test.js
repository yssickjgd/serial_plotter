const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApplication } = require('./helpers/widgetAppHarness');

test('export parsing is independent and text decoding and output encoding are separate', async t => {
    const f = boot(t);
    f.app.service.receive(Uint8Array.of(0, 0, 128, 63)); f.app.service.pause(true); await f.tick();
    const version = f.app.service.numericSource.frames.version;
    f.change('export-format', 'csv'); f.change('export-source', 'base');
    f.change('export-data-type', 'float32'); f.change('export-channels-count', '1');
    assert.equal(f.get('data-type').value, 'uint8');
    assert.equal(f.get('channels-count').value, '2');
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[0].text(), /0,1\r\n/);
    assert.equal(f.app.service.numericSource.frames.version, version);
    f.change('export-format', 'text'); f.change('export-source', 'base');
    f.change('export-encoding', 'ascii'); f.change('export-output-encoding', 'utf-16be');
    assert.equal(f.get('wrap-export-text-parsing').hidden, false);
    assert.equal(await f.app.exportData(), true);
    const bytes = new Uint8Array(await f.blobs[1].arrayBuffer());
    assert.equal(bytes[0], 0); assert.equal(bytes[1], 0);
    const restored = boot(t, f.app.getConfig());
    assert.equal(restored.get('export-output-encoding').value, 'utf-16be');
    restored.change('export-format', 'csv'); restored.change('export-source', 'base');
    assert.equal(restored.get('export-data-type').value, 'float32');
    assert.equal(restored.get('export-channels-count').value, '1');
    f.change('export-format', 'csv'); f.change('export-source', 'base');
    f.change('export-follow-numeric', true);
    assert.equal(f.get('export-data-type').value, 'uint8');
    assert.equal(f.get('export-channels-count').value, '2');
});

test('invalid export frame drafts do not break capture saving or changing the output format', t => {
    const f = boot(t);
    f.change('export-channels-count', '0');
    assert.equal(f.get('btn-export').disabled, true);
    assert.match(f.get('export-parse-status').textContent, /通道数/);
    assert.doesNotThrow(() => f.app.getConfig());
    assert.doesNotThrow(() => f.app.widgets.create({ type: 'wave' }));
    f.change('export-format', 'text');
    assert.equal(f.get('export-format').value, 'text');
    assert.equal(f.get('wrap-export-numeric-parsing').hidden, true);
});

test('CSV defaults to numeric data and remembers the last raw range', t => {
    const f = boot(t);
    f.change('export-format', 'binary');
    assert.equal(f.get('export-source').value, 'base');
    f.change('export-source', 'numeric');
    assert.equal(f.get('export-format').value, 'binary');
    f.change('export-format', 'csv');
    assert.equal(f.get('wrap-export-source').hidden, false);
    f.change('export-format', 'text');
    assert.equal(f.get('export-source').value, 'numeric');
    assert.equal(f.get('wrap-export-source').hidden, false);
    f.change('export-source', 'base');
    assert.equal(f.get('export-format').value, 'text');
    assert.equal(f.get('export-format').options.find(option => option.value === 'csv').disabled, false);
    const restored = boot(t, f.app.getConfig());
    assert.equal(restored.get('export-format').value, 'text');
    restored.change('export-format', 'csv');
    restored.change('export-format', 'binary');
    assert.equal(restored.get('export-source').value, 'base');
});

test('shared byte buffers appear once and retain export availability after alias deletion', async t => {
    const f = boot(t);
    const first = f.app.widgets.create({ type: 'byte' });
    const second = f.app.widgets.create({ type: 'byte' });
    const number = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'number' } });
    const text = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'lf' } });
    f.change('export-format', 'binary');
    assert.deepEqual(f.get('export-source').options.map(option => option.value), ['base', 'numeric', text.id]);
    assert.match(f.get('export-scope-hint').textContent, new RegExp(first.title));
    assert.match(f.get('export-scope-hint').textContent, new RegExp(second.title));
    f.app.service.receive(Uint8Array.of(65, 66)); f.app.service.pause(true); await f.tick();
    f.app.widgets.remove(first.id);
    assert.equal(f.get('export-source').value, 'base');
    assert.equal(await f.app.exportData(), true);
    f.change('export-source', 'numeric');
    assert.match(f.get('export-scope-hint').textContent, new RegExp(number.title));
});

test('TX-only export ignores a missing RX source and reports its own byte and time range', async t => {
    const f = boot(t);
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'lf' } });
    f.change('export-format', 'binary'); f.change('export-source', byte.id);
    f.change('export-direction', 'tx');
    f.app.service.appendTx(Uint8Array.of(67, 68, 69));
    f.app.widgets.remove(byte.id);
    assert.equal(f.get('wrap-export-source').hidden, true);
    assert.equal(f.get('export-format').disabled, false);
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer())], [67, 68, 69]);
    assert.match(f.get('export-range-summary').textContent, /3 B/);
    assert.match(f.get('export-range-summary').textContent, /时间范围/);
    f.change('export-direction', 'rx');
    assert.equal(f.get('wrap-export-source').hidden, false);
    assert.equal(f.get('btn-export').disabled, true);
    f.change('export-format', 'csv');
    assert.equal(f.get('export-source').value, 'numeric');
});

test('legacy shared-source profiles migrate without resetting charset or metadata', t => {
    const original = boot(t);
    const byte = original.app.widgets.create({ type: 'byte' });
    const legacy = original.app.getConfig();
    delete legacy.tools.exportFormat; delete legacy.tools.exportRecordSourceId;
    legacy.tools.exportSourceId = byte.id;
    legacy.tools.exportProfiles[byte.id] = require('../widgetConfig').normalizeBufferExportSettings(null, 'text');
    Object.assign(legacy.tools.exportProfiles[byte.id].formats.text, {
        encoding: 'gbk', encodingEdited: true, timestamps: true, markers: true
    });
    const f = boot(t, legacy);
    assert.equal(f.get('export-source').value, 'base');
    assert.equal(f.get('export-format').value, 'text');
    assert.equal(f.get('export-encoding').value, 'gbk');
    assert.equal(f.get('export-timestamps').checked, true);
    assert.equal(f.get('export-markers').checked, true);
    assert.deepEqual(f.get('export-source').options.map(option => option.value), ['base', 'numeric']);
});

test('export summary counts selected bytes exactly across RX retention and TX filtering', async t => {
    const f = boot(t);
    f.change('max-points', '2');
    for (const data of [[1], [2, 3], [4, 5, 6]]) {
        f.app.service.receive(Uint8Array.from(data)); f.app.service.endStream();
    }
    f.app.service.appendTx(Uint8Array.of(9)); f.app.service.pause(true); await f.tick();
    f.change('export-format', 'binary');
    assert.match(f.get('export-range-summary').textContent, /原始字节 5 B/);
    f.change('export-direction', 'both');
    assert.match(f.get('export-range-summary').textContent, /原始字节 6 B/);
    f.change('export-direction', 'tx');
    assert.match(f.get('export-range-summary').textContent, /原始字节 1 B/);
});

test('shared independent range remains selected after deleting one owner while viewing CSV', t => {
    const f = boot(t);
    const settings = { captureMode: 'text', textBoundary: 'lf' };
    const first = f.app.widgets.create({ type: 'byte', settings });
    const second = f.app.widgets.create({ type: 'byte', settings });
    f.change('export-format', 'text'); f.change('export-source', first.id);
    f.change('export-encoding', 'gbk');
    f.change('export-format', 'csv');
    f.app.widgets.remove(first.id);
    f.change('export-format', 'text');
    assert.equal(f.get('export-source').value, second.id);
    assert.equal(f.get('export-encoding').value, 'gbk');
});

test('independent export ranges retain no selection after deletion', t => {
    const f = bootApplication(); t.after(() => f.app.dispose());
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'lf' } });
    f.change('export-format', 'binary');
    assert.deepEqual(f.get('export-source').children.map(option => option.value), ['base', 'numeric', byte.id]);
    f.change('export-source', byte.id);
    f.app.widgets.remove(byte.id);
    assert.deepEqual(f.get('export-source').children.map(option => option.value), ['base', 'numeric']);
    assert.equal(f.get('export-source').value, '');
    assert.equal(f.get('btn-export').disabled, true);
});
const { GLOBAL_DEFAULTS, validateWorkspaceConfig } = require('../widgetConfig');

function boot(t, initial) {
    const f = bootApplication(initial ?? { version: 2,
        global: { ...GLOBAL_DEFAULTS, dataType: 'uint8', enableHeader: false, channelsCount: '2' },
        widgets: [], workspace: { step: 10, rects: {} }, nextNumber: 1 });
    t.after(() => f.app.dispose());
    return f;
}

test('left export selects a persistent buffer and continues without an active widget', async t => {
    const f = boot(t);
    f.app.service.receive(Uint8Array.of(4, 5));
    assert.ok(f.get('export-panel').closest('#sidebar-top'));
    assert.equal(f.get('export-source').value, 'numeric');
    const wave = f.app.widgets.create({ type: 'wave' });
    f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text' } });
    assert.equal(f.get('export-source').value, 'numeric');
    f.app.widgets.activate(null);
    assert.equal(f.get('btn-export').disabled, false);
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[0].text(), /0,4,5/);
    f.app.widgets.remove(wave.id);
    assert.equal(f.get('export-source').value, 'numeric');
    assert.equal(await f.app.exportData(), true);
});

test('deleting a selected byte source requires explicit reselection instead of falling back', async t => {
    const f = boot(t);
    const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode: 'text', textBoundary: 'lf' } });
    f.app.service.receive(Uint8Array.of(4, 5)); f.app.service.pause(true); await f.tick();
    f.change('export-format', 'binary'); f.change('export-source', byte.id);
    assert.equal(f.get('btn-export').disabled, false);
    f.app.widgets.remove(byte.id);
    assert.equal(f.get('export-source').value, '');
    assert.equal(f.get('btn-export').disabled, true);
    assert.equal(await f.app.exportData(), false);
    f.change('export-source', 'base');
    assert.equal(await f.app.exportData(), true);
});

test('all formats remain available because CSV always uses the common numeric buffer', t => {
    const f = boot(t);
    const wave = f.app.widgets.create({ type: 'wave' });
    const formats = () => f.get('export-format').options.filter(option => !option.hidden).map(option => option.value);
    assert.deepEqual(formats(), ['binary', 'hex-text', 'text', 'csv']);
    f.change('export-format', 'hex-text');
    for (const captureMode of ['hex', 'text', 'number']) {
        const byte = f.app.widgets.create({ type: 'byte', settings: { captureMode } });
        f.change('export-source', byte.id);
        assert.deepEqual(formats(), ['binary', 'hex-text', 'text', 'csv']);
        assert.equal(f.get('export-format').options.find(option => option.value === 'csv').disabled, false);
        f.change('export-format', 'csv');
        assert.equal(f.get('export-source').value, 'numeric');
        f.change('export-format', 'hex-text');
    }
    f.change('export-source', 'numeric');
    assert.deepEqual(formats(), ['binary', 'hex-text', 'text', 'csv']);
});

test('each buffer and format keep their own metadata charset and CSV columns across reload', async t => {
    const f = boot(t), first = f.app.widgets.create({ type: 'wave' });
    f.change('export-timestamps', true);
    const checkbox = f.get('export-channel-list').children[0].children[0];
    checkbox.checked = false; checkbox.dispatchEvent({ type: 'change' });
    f.change('export-format', 'text');
    f.change('export-source', 'numeric');
    assert.equal(f.get('export-timestamps').checked, false);
    f.change('export-encoding', 'gbk');
    f.change('export-format', 'csv');
    assert.equal(f.get('export-timestamps').checked, true);
    assert.equal(f.get('export-channel-list').children[0].children[0].checked, false);
    f.change('export-format', 'text'); f.change('export-source', 'base');
    assert.equal(f.get('export-timestamps').checked, false);
    f.change('export-source', 'numeric'); f.change('export-format', 'text');
    assert.equal(f.get('export-encoding').value, 'gbk');
    const restored = boot(t, f.app.getConfig());
    assert.equal(restored.get('export-source').value, 'numeric');
    assert.equal(restored.get('export-format').value, 'text');
    assert.equal(restored.get('export-encoding').value, 'gbk');
    restored.change('export-format', 'csv');
    assert.equal(restored.get('export-timestamps').checked, true);
    assert.equal(restored.get('export-channel-list').children[0].children[0].checked, false);
    restored.change('export-format', 'text'); restored.change('export-source', 'base');
    assert.equal(restored.get('export-timestamps').checked, false);
    await f.tick(200);
    assert.ok(JSON.parse(f.storage.get('serialplot_v3_config')).tools.exportProfiles.numeric.formats.text);
});

test('numeric buffer export preserves parsed bytes and ignores display calibration', async t => {
    const f = boot(t), wave = f.app.widgets.create({ type: 'wave' });
    Object.assign(wave.settings.channels[0], { gainEnabled: true, gain: 3 });
    f.app.widgets.applySettings(wave);
    f.app.service.receive(Uint8Array.of(4, 5)); f.app.service.appendTx(Uint8Array.of(99));
    f.change('export-format', 'binary');
    f.change('export-source', 'numeric');
    assert.equal(f.get('wrap-export-direction').hidden, false);
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer())], [4, 5]);
    f.change('export-format', 'csv');
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[1].text(), /0,4,5/);
});

test('default all-channel export continues to include newly configured channels', async t => {
    const f = boot(t);
    const wave = f.app.widgets.create({ type: 'wave' });
    f.app.getConfig();
    f.change('channels-count', '3'); await f.settle();
    const choices = f.get('export-channel-list').children;
    assert.equal(choices.length, 3);
    assert.ok([...choices].every(label => label.children[0].checked));
    f.app.service.receive(Uint8Array.of(4, 5, 6));
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[0].text(), /0,4,5,6/);
    assert.equal(f.app.getConfig().tools.exportProfiles.numeric.formats.csv.channelIndices, null);
});

test('static response display never substitutes artificial samples into data export', async t => {
    const f = boot(t), wave = f.app.widgets.create({ type: 'wave' });
    Object.assign(wave.settings.channels[0], { gainEnabled: true, gain: 3 });
    f.app.widgets.applySettings(wave);
    const kernel = f.app.widgets.addChannel('constant');
    f.app.service.receive(Uint8Array.of(4, 5));
    f.change('plot-content', 'response'); f.app.widgets.setChannelVisible(kernel - 1, true);
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[0].text(), /0,4,5/);
});

test('old global export options migrate to their selected widget and invalid profiles import atomically', t => {
    const original = boot(t);
    const wave = original.app.widgets.create({ type: 'wave' });
    const legacy = original.app.getConfig();
    delete legacy.tools.exportProfiles;
    delete legacy.widgets[0].settings.exportSettings;
    legacy.tools.exportSourceId = wave.id;
    legacy.tools.exportSettings = { format: 'csv', direction: 'rx', encoding: 'utf-8', timestamps: true,
        markers: false, channelIndices: [1], encodingEdited: false };
    const f = boot(t, legacy); f.app.widgets.activate(wave.id);
    assert.equal(f.get('export-timestamps').checked, true);
    assert.equal(f.get('export-channel-list').children[0].children[0].checked, false);
    const before = JSON.stringify(f.app.getConfig());
    const bad = f.app.getConfig();
    bad.tools.exportProfiles.numeric.formats.text.encoding = 'unsupported';
    assert.throws(() => validateWorkspaceConfig(bad));
    assert.throws(() => f.app.applyConfig(bad));
    assert.equal(JSON.stringify(f.app.getConfig()), before);
});

test('base export retains undecodable bytes while CSV uses every retained sample beyond the current viewport', async t => {
    const f = boot(t), wave = f.app.widgets.create({ type: 'wave' });
    f.change('chk-header', true); await f.settle();
    const data = Uint8Array.of(0xff, 0xab, 1, 2, 0xab, 3, 4, 0xab, 5, 6);
    f.app.service.receive(data); f.app.service.pause(true); await f.tick();
    wave.view.vp.time.displayCount = 2;
    f.app.widgets.setChannelVisible(0, false);
    f.change('export-format', 'binary'); f.change('export-source', 'base');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer())], [...data]);
    assert.match(f.get('export-range-summary').textContent, /完整保留缓冲区/);
    f.change('export-format', 'csv');
    assert.equal(await f.app.exportData(), true);
    assert.match(await f.blobs[1].text(), /0,1,2\r\n1,3,4\r\n2,5,6/);
});

test('raw buffer export supports all TX directions and metadata without rewriting binary bytes', async t => {
    const f = boot(t);
    f.app.service.receive(Uint8Array.of(65, 66)); f.app.service.appendTx(Uint8Array.of(67));
    f.app.service.pause(true); await f.tick();
    f.change('export-source', 'base'); f.change('export-format', 'binary'); f.change('export-direction', 'tx');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs[0].arrayBuffer())], [67]);
    f.change('export-direction', 'both');
    assert.equal(await f.app.exportData(), true);
    assert.deepEqual([...new Uint8Array(await f.blobs[1].arrayBuffer())], [65, 66, 67]);
    f.change('export-format', 'hex-text'); f.change('export-direction', 'both');
    f.change('export-timestamps', true); f.change('export-markers', true);
    assert.equal(await f.app.exportData(), true);
    const text = await f.blobs[2].text();
    assert.match(text, /RX.*41 42/); assert.match(text, /TX.*43/);
    assert.match(f.get('export-range-summary').textContent, /本次导出 2 帧/);
});
