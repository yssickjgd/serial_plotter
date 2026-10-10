const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { WorkspaceTools } = require('../workspaceTools');

function element() {
    const listeners = new Map();
    return { value: '', checked: true, hidden: false, disabled: false, textContent: '', children: [],
        classList: { add() {}, remove() {} },
        append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); },
        replaceChildren(...nodes) { this.children = nodes; }, contains(target) { return target === this || this.children.includes(target); },
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        fire(name) { for (const fn of listeners.get(name) ?? []) fn({ target: this }); }
    };
}
function widget(id, values, { type = 'wave', offset = 0, settings = {}, timestamps } = {}) {
    const frames = new FrameBuffer(1, Math.max(5, values.length));
    values.forEach((value, index) => frames.append([value], Uint8Array.of(value), '', index + 1,
        timestamps?.[index] ?? 10000 + index * 1000, { byteOffset: offset + index, endByte: offset + index + 1 }));
    const view = { reference: offset, jumps: [], navigationMarkers: { timeOrder: null },
        getReferenceByteOffset() { return this.reference; }, jumpToByteOffset(value) { this.jumps.push(value); return true; },
        setSearchResults(matches, current) { this.matches = matches; this.current = current; },
        setNavigationMarkers(markers) { this.navigationMarkers = markers; },
        setNavigationColors(colors) { this.colors = colors; },
        setDisplayOptions(options) { this.displayOptions = { ...this.displayOptions, ...options }; } };
    return { id, type, title: id, source: { frames, generation: 0 }, view,
        settings: { captureMode: 'number', channels: [], ...settings } };
}
function fixture(widgets) {
    const elements = new Map();
    const document = { ...element(), createElement: element, getElementById(id) {
        if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
    } };
    document.getElementById('nav-jump-mode').value = 'relative';
    document.getElementById('nav-jump-relative').value = '0';
    const service = { paused: true, epoch: 0 }, map = new Map(widgets.map(w => [w.id, w]));
    let activeId = null;
    const tools = new WorkspaceTools({ document, service, getWidgets: () => map, getActiveWidget: () => map.get(activeId) });
    const activate = id => { activeId = id; tools.syncSources(); };
    const select = (sourceId, referenceId = sourceId) => {
        activeId = sourceId; tools.syncSources({ referenceId });
    };
    return { tools, document, service, map, select, activate, el: id => document.getElementById(id) };
}

test('numeric parser gaps cannot create search markers or jumps', async () => {
    const byte = widget('byte', [0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0], { type: 'byte', settings: { captureMode: 'hex' } });
    const wave = widget('wave', [1]);
    wave.source.frames.append([2], Uint8Array.of(2), '', 2, 11000, { byteOffset: 10, endByte: 11 });
    const f = fixture([byte, wave]); f.select('byte'); f.el('monitor-search-query').value = '07';
    assert.equal(await f.tools.requestSearch('nearest'), true);
    assert.deepEqual(wave.view.navigationMarkers.matches, []);
    assert.deepEqual(wave.view.jumps, []);
    assert.match(f.el('monitor-search-status').textContent, /wave/);
    f.tools.matches = [{ startByte: 0, endByte: 11 }]; f.tools._publish();
    assert.deepEqual(wave.view.navigationMarkers.matches, [], 'a spanning hit cannot bridge an uncovered gap');
});

test('view navigation rejection is reported without publishing a time marker', () => {
    const source = widget('source', [1]), rejecting = widget('rejecting', [1]);
    rejecting.view.jumpToByteOffset = () => false;
    const f = fixture([source, rejecting]); f.select('source');
    assert.equal(f.tools.jumpToTime(), true);
    assert.equal(rejecting.view.navigationMarkers.timeOrder, null);
    assert.match(f.el('nav-jump-status').textContent, /rejecting/);
});

test('nonmonotonic timestamps keep the first sample origin and allow every retained absolute time', () => {
    const source = widget('source', [1, 2, 3], { timestamps: [10000, 5000, 11000] });
    const f = fixture([source]); f.select('source');
    assert.equal(f.tools.jumpToTime(), true); assert.deepEqual(source.view.jumps, [0]);
    f.el('nav-jump-mode').value = 'absolute';
    f.el('nav-jump-absolute').value = new Date(5000).toISOString();
    assert.equal(f.tools.jumpToTime(), true); assert.deepEqual(source.view.jumps, [0, 1]);
    f.el('nav-jump-absolute').value = new Date(12000).toISOString();
    assert.equal(f.tools.jumpToTime(), false);
});

test('source and default nearest reference follow activation and no active widget disables navigation', () => {
    const f = fixture([widget('a', [1]), widget('b', [2])]);
    assert.deepEqual(f.tools.serialize(), { referenceId: null });
    f.select('a', 'b');
    f.activate('b');
    assert.equal(f.tools.sourceId, 'b');
    f.activate('a');
    f.map.delete('a'); f.tools.syncSources();
    assert.deepEqual(f.tools.serialize(), { referenceId: null });
    assert.equal(f.tools.sourceId, null);
    assert.equal(f.el('nav-jump-button').disabled, true);
    assert.ok(f.el('monitor-search-status').textContent);
    f.map.set('c', widget('c', [3])); f.tools.syncSources();
    assert.equal(f.tools.sourceId, null);
});

test('nearest search immediately uses the active widget without choosing a placeholder', async () => {
    const a = widget('a', [7, 0, 7]), b = widget('b', [7, 0, 7]);
    b.view.reference = 2;
    const f = fixture([a, b]); f.activate('a'); f.el('monitor-search-query').value = '7';
    assert.equal(await f.tools.requestSearch('nearest'), true);
    assert.equal(f.tools.matches[f.tools.currentMatch].startByte, 0);
    assert.equal(f.el('monitor-search-origin').value, 'a');
    assert.ok(f.el('monitor-search-origin').children.every(option => option.value));
    f.select('a', 'b'); await f.tools.requestSearch('nearest');
    assert.equal(f.tools.matches[f.tools.currentMatch].startByte, 2, 'another reference may still be chosen manually');
    f.activate('b'); assert.equal(f.tools.referenceId, 'b');
    f.activate('a'); assert.equal(f.el('monitor-search-origin').value, 'a');
    await f.tools.requestSearch('nearest');
    assert.equal(f.tools.matches[f.tools.currentMatch].startByte, 0);
    f.tools.dispose();
});

test('changing active source cancels old asynchronous search and updates search type and latest time', async () => {
    const wave = widget('wave', Array(600).fill(7));
    const byte = widget('byte', [65], { type: 'byte', settings: { captureMode: 'text' }, timestamps: [1234567890123] });
    const f = fixture([wave, byte]); f.select('wave'); f.el('monitor-search-query').value = '7';
    const pending = f.tools.requestSearch('nearest');
    f.activate('byte');
    assert.equal(await pending, false);
    assert.equal(f.tools.sourceId, 'byte');
    assert.equal(f.tools.referenceId, 'byte');
    assert.equal(f.tools.matches.length, 0);
    assert.equal(f.el('monitor-search-tolerance').hidden, true);
    assert.equal(f.el('monitor-search-case-wrap').hidden, false);
    assert.equal(new Date(f.el('nav-jump-absolute').value).getTime(), 1234567890123);
    assert.deepEqual(wave.view.jumps, []);
    f.activate(null);
    assert.equal(await f.tools.requestSearch('nearest'), false);
    assert.equal(f.el('monitor-search-nearest').disabled, true);
});

test('wave search applies instance calibration while a numeric byte source uses raw values', async () => {
    const wave = widget('wave', [2, 5], { settings: { channels: [{ gainEnabled: true, gain: 2, offsetEnabled: true, offset: 1 }] } });
    const byte = { ...widget('byte', []), type: 'byte', source: wave.source };
    const f = fixture([wave, byte]);
    f.select('wave'); f.el('monitor-search-query').value = '5';
    await f.tools.requestSearch('nearest');
    assert.equal(f.tools.matches.length, 1);
    assert.equal(f.tools.matches[0].startByte, 0);
    assert.deepEqual(wave.view.jumps, [0]);
    f.select('byte'); await f.tools.requestSearch('nearest');
    assert.equal(f.tools.matches[0].startByte, 1);
    assert.equal(byte.view.matches[0].channel, 0);
});

test('first direction skips nearest in the requested special direction then cycles normally', async () => {
    const a = widget('a', [7, 0, 7, 0, 7]); a.view.reference = 2;
    const f = fixture([a]); f.select('a'); f.el('monitor-search-query').value = '7';
    await f.tools.requestSearch('prev'); assert.equal(f.tools.currentMatch, 2);
    await f.tools.requestSearch('prev'); assert.equal(f.tools.currentMatch, 1);
    f.tools.invalidate(); await f.tools.requestSearch('next'); assert.equal(f.tools.currentMatch, 0);
    await f.tools.requestSearch('prev'); assert.equal(f.tools.currentMatch, 2);
    a.view.reference = 1; await f.tools.requestSearch('nearest'); assert.equal(f.tools.currentMatch, 0);
});

test('time relative zero is the earliest retained timestamp and targets outside another retained view are skipped', () => {
    const a = widget('a', [1, 2], { offset: 100 }), b = widget('b', [3, 4], { offset: 200 });
    const f = fixture([a, b]); f.select('a');
    assert.equal(f.tools.jumpToTime(), true);
    assert.deepEqual(a.view.jumps, [100]); assert.deepEqual(b.view.jumps, []);
    assert.match(f.el('nav-jump-status').textContent, /保留/);
    f.el('nav-jump-relative').value = '100';
    assert.equal(f.tools.jumpToTime(), false); assert.deepEqual(a.view.jumps, [100]);
});

test('public tools stay inactive while receiving and default absolute time comes from the chosen source', async () => {
    const f = fixture([widget('a', [1, 2], { timestamps: [1234567890000, 1234567890123] })]);
    f.select('a');
    assert.equal(new Date(f.el('nav-jump-absolute').value).getTime(), 1234567890123);
    f.service.paused = false; f.tools.syncPaused();
    assert.equal(f.el('monitor-search-nearest').disabled, true);
    assert.equal(await f.tools.requestSearch('nearest'), false);
    assert.equal(f.tools.jumpToTime(), false);
});

test('incremental search captures click reference and cancels on epoch changes', async () => {
    const values = Array.from({ length: 600 }, (_, i) => i % 100 === 0 ? 7 : 0);
    const a = widget('a', values); a.view.reference = 200;
    const f = fixture([a]); f.select('a'); f.el('monitor-search-query').value = '7';
    const pending = f.tools.requestSearch('nearest'); a.view.reference = 500;
    await pending; assert.equal(f.tools.matches[f.tools.currentMatch].startByte, 200);
    f.tools.invalidate(); const stale = f.tools.requestSearch('nearest'); f.service.epoch++;
    assert.equal(await stale, false); assert.equal(f.tools.matches.length, 0);
});

test('reference changes reuse search results and removed source cancels pending work', async () => {
    const a = widget('a', [7, 0, 7]), b = widget('b', [7, 0, 7]); b.view.reference = 2;
    const f = fixture([a, b]); f.select('a'); f.el('monitor-search-query').value = '7';
    await f.tools.requestSearch('nearest'); const matches = f.tools.matches;
    f.select('a', 'b'); assert.equal(f.tools.matches, matches);
    await f.tools.requestSearch('nearest'); assert.equal(f.tools.currentMatch, 1);
    f.tools.dispose(); f.el('monitor-search-query').fire('input');
    assert.equal(await f.tools.requestSearch('nearest'), false);
});

test('text byte search maps cross-frame Unicode spans and source colors to each retained view', async () => {
    const byte = widget('byte', [], { type: 'byte', settings: { captureMode: 'text', textEncoding: 'utf-8',
        monitorDisplay: { searchCurrentColor: '#123456', searchMatchColor: '#654321' } } });
    byte.source.frames.appendRaw(Uint8Array.of(0x61, 0xe4, 0xb8), '', 1, 10000, { byteOffset: 100 });
    byte.source.frames.appendRaw(Uint8Array.of(0xad, 0x42), '', 2, 10001, { byteOffset: 103 });
    const wave = widget('wave', [1, 2, 3, 4, 5], { offset: 100 });
    const missing = widget('missing', [1, 2], { offset: 200 });
    byte.view.reference = 100;
    const f = fixture([byte, wave, missing]); f.select('byte');
    f.el('monitor-search-query').value = '中b'; f.el('monitor-search-case-sensitive').checked = false;
    await f.tools.requestSearch('nearest');
    assert.deepEqual(f.tools.matches.map(match => [match.startByte, match.endByte]), [[101, 105]]);
    assert.deepEqual(byte.view.matches.map(match => [match.startByte, match.endByte, match.startOrder, match.endOrder]), [[1, 2, 1, 2]]);
    assert.equal(wave.view.navigationMarkers.matches[0].startOrder, 2);
    assert.equal(wave.view.navigationMarkers.currentMatch, 0);
    assert.deepEqual(wave.view.colors, { current: '#123456', match: '#654321' });
    assert.deepEqual(missing.view.jumps, []);
    assert.deepEqual(missing.view.navigationMarkers.matches, []);
    assert.equal(f.el('monitor-search-channel').hidden, true);
    assert.equal(f.el('monitor-search-case-wrap').hidden, false);
});

test('deleting a pending reference cancels the old request and defaults back to the active widget', async () => {
    const a = widget('a', Array(600).fill(7)), b = widget('b', [7]);
    const f = fixture([a, b]); f.select('a', 'b'); f.el('monitor-search-query').value = '7';
    const pending = f.tools.requestSearch('nearest'); f.map.delete('b'); f.tools.syncSources();
    assert.equal(await pending, false);
    assert.deepEqual(a.view.jumps, []);
    assert.equal(f.tools.serialize().referenceId, 'a');
    assert.equal(await f.tools.requestSearch('nearest'), true);
});

test('a view render failure settles asynchronous search without leaking a pending request', async () => {
    const a = widget('a', Array(600).fill(7));
    const f = fixture([a]); f.select('a'); f.el('monitor-search-query').value = '7';
    const pending = f.tools.requestSearch('nearest');
    const setter = a.view.setNavigationMarkers;
    a.view.setNavigationMarkers = function(markers) {
        if (markers.matches.length) throw new Error('render failed');
        setter.call(this, markers);
    };
    const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('unsettled'), 50))]);
    assert.equal(outcome, false);
    assert.match(f.el('monitor-search-status').textContent, /render failed/);
});
