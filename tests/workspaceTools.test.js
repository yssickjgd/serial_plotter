const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { SynchronizedFrames } = require('../engineFrames');
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

test('65535 search channels render 40 candidates per page and preserve an off-page selection', () => {
    const source = widget('large', [1]); source.source.frames.channelCount = 65535;
    const f = fixture([source]);
    f.service.channelNames = Array.from({ length: 65535 }, (_, index) => index === 65534 ? '末通道' : 'CH' + (index + 1));
    f.select('large');
    assert.ok(f.tools.channelInputs.length <= 41);
    const picker = f.tools.channelPicker; picker.filter.value = '末通道'; picker.filter.fire('input');
    const target = f.tools.channelInputs.find(row => row.channel === 65534);
    assert.equal(target.text.textContent, 'CH65535 · 末通道');
    target.input.checked = true; target.input.fire('change');
    picker.filter.value = ''; picker.filter.fire('input'); picker.next.fire('click');
    assert.ok(f.tools.channelInputs.some(row => row.channel === 40));
    assert.deepEqual([...f.tools.selectedChannels], [65534]);
    assert.match(f.el('monitor-search-channel-toggle').textContent, /CH65535/);
    f.tools.dispose();
});

test('engine numeric sources use scalar search while Raw_Data selects Hex search for every widget', async () => {
    const source = widget('engine', [7], { type: 'byte', settings: { captureMode: 'engine' } }); source.source.kind = 'numeric';
    const f = fixture([source]); f.service.dataEngine = { mode: 'Data_Array' }; f.select('engine');
    assert.equal(f.tools._kind(), 'number'); f.el('monitor-search-query').value = '7';
    assert.equal(await f.tools.requestSearch('nearest'), true);
    f.service.dataEngine.mode = 'Raw_Data'; f.tools.syncSources();
    assert.equal(f.tools._kind(), 'hex');
    assert.equal(f.el('monitor-search-channel').hidden, true);
    f.tools.dispose();
});

test('protocol field searches preserve exact64 and text paths and map source byte spans to other widgets', async () => {
    const { Protocol } = require('../protocolEngine');
    const compiled = Protocol.compile({ id: 'search', framing: { fixedLength: 12 }, payloadOffset: 0,
        messages: [{ id: 'state', command: 1, fields: [{ name: 'clock', type: 'uint64' }, { name: 'label', type: 'string', length: 4 }] }] });
    const source = widget('protocol', [], { type: 'byte', settings: { captureMode: 'engine' } }); source.source.kind = 'protocol';
    source.source.frames.appendRaw(Protocol.encode(compiled, 'state', { clock: 9007199254740993n, label: '温' }), '', 1, 1000, { byteOffset: 100 });
    source.source.decodeRecord = index => Protocol.decode(source.source.frames.rawBytesAt(index), compiled);
    source.view.reference = 100;
    const raw = widget('raw', Array(12).fill(0), { type: 'byte', offset: 100, settings: { captureMode: 'hex' } });
    const f = fixture([source, raw]); f.select('protocol');
    const controls = f.tools.protocolControls;
    assert.equal(controls.host.hidden, false);
    controls.kind.value = 'integer64'; controls.kind.fire('change'); controls.path.value = 'clock'; controls.path.fire('input');
    f.el('monitor-search-query').value = '9007199254740993';
    assert.equal(await f.tools.requestSearch('nearest'), true);
    assert.deepEqual(f.tools.matches.map(match => [match.path, match.startByte, match.endByte]), [['clock', 100, 108]]);
    assert.equal(raw.view.matches[0].absoluteStartByte, 100);
    assert.equal(raw.view.matches[0].absoluteEndByte, 108);
    controls.kind.value = 'text'; controls.kind.fire('change'); controls.path.value = 'label'; controls.path.fire('input');
    f.el('monitor-search-query').value = '温';
    assert.equal(await f.tools.requestSearch('nearest'), true);
    assert.deepEqual(f.tools.matches.map(match => [match.path, match.startByte, match.endByte]), [['label', 108, 112]]);
    f.tools.dispose();
});

test('synchronized held-value matches locate each channel origin instead of the most recent unrelated packet', async () => {
    const source = widget('sync', [7, 7], { offset: 200 });
    source.source.frames.provenanceAt = (channel, index) => ({ order: 10, byteOffset: 100, endByte: 104 });
    source.view.jumpToFrame = index => { source.view.sampleJump = index; return true; };
    const raw = widget('raw', [0, 0, 0, 0], { type: 'byte', offset: 100, settings: { captureMode: 'hex' } });
    raw.source.frames.orderAt = index => index + 10;
    const f = fixture([source, raw]); f.service.dataEngine = { recordsSource: raw.source };
    f.select('sync'); f.el('monitor-search-query').value = '7';
    assert.equal(await f.tools.requestSearch('nearest'), true);
    assert.equal(f.tools.matches[0].startByte, 100);
    assert.equal(source.view.sampleJump, 0);
    assert.deepEqual(raw.view.jumps, [100]);
    assert.equal(source.view.navigationMarkers.matches[0].startOrder, source.source.frames.orderAt(0));
    f.tools.dispose();
});

test('synchronized value matches report evicted source packets without jumping to unrelated retained bytes', async () => {
    const source = widget('sync', [7], { offset: 200 });
    source.source.frames.provenanceAt = () => ({ order: 10, byteOffset: 100, endByte: 104 });
    const raw = widget('raw', [0], { type: 'byte', offset: 200, settings: { captureMode: 'hex' } });
    raw.source.frames.orderAt = () => 20;
    const f = fixture([source, raw]); f.service.dataEngine = { recordsSource: raw.source };
    f.select('sync'); f.el('monitor-search-query').value = '7';
    assert.equal(await f.tools.requestSearch('nearest'), false);
    assert.equal(f.tools.matches.length, 1, 'the held value remains a match even after its packet is evicted');
    assert.match(f.el('monitor-search-status').textContent, /源消息.*保留/);
    assert.deepEqual(raw.view.jumps, []);
    f.tools.dispose();
});

test('synchronized formula searches navigate the referenced input packet and report its actual eviction', async () => {
    const source = widget('sync', []), raw = widget('raw', [], { type: 'byte', settings: { captureMode: 'hex' } });
    const records = new FrameBuffer(1, 5);
    records.appendRaw(Uint8Array.of(1, 2, 3, 4), '', 10, 1000, { byteOffset: 100, endByte: 104 });
    records.appendRaw(Uint8Array.of(5, 6, 7, 8), '', 20, 1000.3, { byteOffset: 200, endByte: 204 });
    raw.source.frames = records;
    const sync = new SynchronizedFrames(2, 10, { definitions: [{ number: 3, type: 'formula', expression: 'CH1*2' },
        { number: 4, type: 'formula', expression: 'CH3+CH2' }], resolveFrame: origin => {
        const index = records.indexAtOrAfterOrder(origin.order);
        return index >= 0 && records.orderAt(index) === origin.order ? records.frameAt(index) : null;
    } });
    sync.ingest(1000, new Map([[0, 2]]), { order: 10, byteOffset: 100, endByte: 104 });
    sync.ingest(1000.3, new Map([[1, 3]]), { order: 20, byteOffset: 200, endByte: 204 }); sync.advance(1001);
    source.source.frames = sync; source.view.jumpToFrame = index => { source.view.sampleJump = index; return true; };
    const f = fixture([source, raw]); f.service.dataEngine = { recordsSource: raw.source };
    f.select('sync'); f.tools.selectedChannels = new Set([2]); f.el('monitor-search-query').value = '4';
    assert.equal(await f.tools.requestSearch('nearest'), true);
    assert.equal(f.tools.matches[0].provenance.byteOffset, 100); assert.deepEqual(raw.view.jumps, [100]);
    records.discardOldest(1); f.tools.invalidate();
    assert.equal(await f.tools.requestSearch('nearest'), false); assert.equal(f.tools.matches[0].unretained, true);
    assert.deepEqual(raw.view.jumps, [100]); assert.match(f.el('monitor-search-status').textContent, /源消息.*保留/);
    f.tools.selectedChannels = new Set([3]); f.el('monitor-search-query').value = '7';
    assert.equal(await f.tools.requestSearch('nearest'), true); assert.equal(f.tools.matches[0].startByte, 200);
    f.tools.dispose();
});

test('a constant-only formula search never invents a source packet from the sampling boundary', async () => {
    const source = widget('sync', []), raw = widget('raw', [1], { type: 'byte', offset: 100, settings: { captureMode: 'hex' } });
    const sync = new SynchronizedFrames(1, 10, { definitions: [{ number: 2, type: 'formula', expression: '5' }] });
    sync.ingest(0, new Map([[0, 1]]), { order: 1, byteOffset: 100, endByte: 101 }); source.source.frames = sync;
    const f = fixture([source, raw]); f.service.dataEngine = { recordsSource: raw.source };
    f.select('sync'); f.tools.selectedChannels = new Set([1]); f.el('monitor-search-query').value = '5';
    assert.equal(await f.tools.requestSearch('nearest'), false); assert.deepEqual(raw.view.jumps, []);
    assert.match(f.el('monitor-search-status').textContent, /没有关联源消息/); f.tools.dispose();
});
