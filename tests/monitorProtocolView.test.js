const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { MonitorView } = require('../monitorView');

function fixture(capacity = 3100, count = 3000) {
    const document = { createElement() { return { style: {}, children: [], dataset: {},
        append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children.flatMap(child => child.fragment ? child.children : [child]); } }; },
    createDocumentFragment() { return { fragment: true, children: [], appendChild(child) { this.children.push(child); } }; } };
    const container = { ownerDocument: document, clientWidth: 800, clientHeight: 180, scrollTop: 0, children: [], listeners: {},
        replaceChildren(child) { this.children = [child]; }, addEventListener(name, callback) { this.listeners[name] = callback; },
        removeEventListener(name) { delete this.listeners[name]; },
        get scrollHeight() { return Math.max(this.clientHeight, parseFloat(this.children[0]?.style.height) || 0); } };
    const frames = new FrameBuffer(1, capacity);
    for (let index = 0; index < count; index++) frames.appendRaw(Uint8Array.of(1, 2, 3, 4), 't', index + 1, 1700000000000 + index,
        { byteOffset: 100 + index * 4 });
    let decodes = 0, version = 0;
    const decode = index => { decodes++; return { ...frames.frameAt(index), record: { known: true, messageId: 'status',
        messageName: `设备状态${version}`, command: 7, flatFields: [
            { path: 'clock', value: 9007199254740993n, numeric: null, byteOffset: 0, endByte: 2 },
            { path: 'flags.ready', value: true, numeric: 1, byteOffset: 2, endByte: 3, bitOffset: 1, bitLength: 1 }
        ] } }; };
    const view = new MonitorView(container, frames, { getProtocolRecord: decode });
    view.setDisplayOptions({ timestamp: 'none', showDirection: false }, { deferRender: true });
    const text = () => view.spacer.children.map(row => row.children[1]?.children.map(span => span.textContent).join('')).join('\n');
    return { document, container, frames, view, decode, text, get decodes() { return decodes; }, bumpVersion() { version++; } };
}

test('protocol mode lazily decodes nearby records, caches versions and keeps raw Hex unchanged', () => {
    const f = fixture(); f.view.setMode('protocol');
    assert.ok(f.decodes < 40, `decoded ${f.decodes} offscreen records`);
    assert.match(f.text(), /设备状态0.*命令=7.*状态=正常/); assert.match(f.text(), /clock = 9007199254740993/);
    const initial = f.decodes; f.view.render(); assert.equal(f.decodes, initial);
    f.bumpVersion(); f.view.setProtocolDecoder(f.decode, { version: 2 });
    assert.match(f.text(), /设备状态1/); assert.ok(f.decodes > initial);
    const spans = f.view.getVisibleHexSpans(); assert.ok(spans.length);
    assert.equal(spans[0].byteOffset, f.frames.rawByteOffsetAt(spans[0].frameIndex) + spans[0].startByte);
    assert.equal(spans.find(span => span.path === 'flags.ready').bitOffset, 1);
    f.view.setMode('hex'); assert.equal(f.view.mode, 'hex');
    assert.ok(f.view.spacer.children.some(row => row.children[1].textContent === '01 02 03 04'));
    assert.deepEqual(f.frames.rawBytesAt(0), Uint8Array.of(1, 2, 3, 4)); f.view.dispose();
});

test('structured monitor honors integer display bases without changing byte navigation', () => {
    const f = fixture(10, 1);
    f.view.setProtocolDecoder(() => ({ valid: true, messageId: 'hex', flatFields: [
        { fieldId: 'value', path: 'value', value: 255, numeric: 255, displayBase: 'hex', byteOffset: 1, endByte: 2 }
    ] }), { version: 1 });
    f.view.setMode('protocol'); assert.match(f.text(), /value = 0xFF/);
    assert.equal(f.view.getVisibleHexSpans().find(span => span.path === 'value').startByte, 1); f.view.dispose();
});

test('protocol selection, byte navigation and field search highlight use the original byte mapping', () => {
    const f = fixture(10, 3); f.view.setMode('engine'); assert.equal(f.view.mode, 'protocol');
    f.view.setProtocolOptions({ fieldPaths: ['flags'] });
    assert.doesNotMatch(f.text(), /clock =/); assert.match(f.text(), /flags.ready = true/);
    f.view.setSearchResults([{ startOrder: 2, endOrder: 2, startByte: 2, endByte: 3, path: 'flags.ready' }], 0);
    f.view.jumpToByteOffset(f.frames.rawByteOffsetAt(1) + 2);
    assert.equal(f.view.anchor.order, 2);
    const row = f.view.spacer.children.find(row => row.children[1]?.children.some(span => /monitor-search-current/.test(span.className)));
    assert.ok(row); assert.match(row.children[1].children.find(span => /monitor-search-current/.test(span.className)).textContent, /flags.ready/);
    f.view.setProtocolOptions({ fieldPaths: null, collapsedPaths: ['flags'] }); assert.doesNotMatch(f.text(), /flags.ready/);
    f.view.dispose();
});

test('protocol history anchoring and native selection survive live arrivals and cache invalidation on clear', () => {
    const f = fixture(); f.view.setMode('protocol');
    f.container.scrollTop = (f.container.scrollHeight - f.container.clientHeight) * .43; f.container.listeners.scroll();
    const tracked = f.view.rowPositions.find(row => row.top > f.container.scrollTop).order;
    const relative = () => f.view.rowPositions.find(row => row.order === tracked).top - f.container.scrollTop;
    const original = relative(), order = f.view.anchor.order;
    for (let index = 3000; index < 3010; index++) {
        f.frames.appendRaw(Uint8Array.of(1, 2, 3, 4), 't', index + 1); f.view.render();
        assert.equal(f.view.anchor.order, order); assert.ok(Math.abs(relative() - original) < .01);
    }
    const selected = f.view.spacer.children[0], selection = { isCollapsed: false, anchorNode: selected, focusNode: selected };
    f.document.getSelection = () => selection; f.container.contains = node => node === selected;
    f.frames.appendRaw(Uint8Array.of(1, 2, 3, 4), 't', 3011); f.view.render();
    assert.equal(f.view.spacer.children[0], selected);
    selection.isCollapsed = true; f.frames.clear(); f.view.clear({ deferRender: true }); f.bumpVersion();
    f.frames.appendRaw(Uint8Array.of(1, 2, 3, 4), 't', 1); f.view.render();
    assert.match(f.text(), /设备状态1/); f.view.dispose();
});
