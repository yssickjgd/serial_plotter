const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { MonitorView, mergeMonitorRows, bytesToHex } = require('../monitorView');
const { parseMonitorSearch, MonitorSearchSession } = require('../monitorSearch');

function monitorFixture(frames, width = 800, height = 100) {
    const container = { clientWidth: width, clientHeight: height, scrollTop: 0, children: [],
        replaceChildren(child) { this.children = [child]; }, addEventListener() {},
        get scrollHeight() { return Math.max(height, parseInt(this.children[0]?.style.height || '0', 10)); } };
    return new MonitorView(container, frames);
}

function monitorDocument() {
    return {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
}

test('byte display colors apply to records and search backgrounds in numerical mode too', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5);
        frames.append([2], Uint8Array.of(65, 66), 't', 1);
        const view = monitorFixture(frames, 800, 600);
        view.extras.push({ kind: 'tx', bytes: Uint8Array.of(65), time: 't', order: 2 },
            { kind: 'error', bytes: Uint8Array.of(65), time: 't', order: 3 },
            { kind: 'tx-error', bytes: Uint8Array.of(65), time: 't', order: 4 });
        view.setDisplayOptions({ rxColor: '#112233', txColor: '#223344', rxErrorColor: '#334455',
            txErrorColor: '#445566', searchCurrentColor: '#556677', searchMatchColor: '#667788' });
        assert.deepEqual(view.spacer.children.map(row => row.style.color),
            ['#112233', '#223344', '#334455', '#445566']);
        view.setSearchResults([
            { startOrder: 1, endOrder: 1, startByte: 0, endByte: 1 },
            { startOrder: 1, endOrder: 1, startByte: 1, endByte: 2 }
        ], 0);
        const highlights = view.spacer.children[0].children[1].children;
        assert.equal(highlights.find(span => span.className === 'monitor-search-current').style.backgroundColor, '#556677');
        assert.equal(highlights.find(span => span.className === 'monitor-search-match').style.backgroundColor, '#667788');
        view.setMode('number');
        assert.equal(view.spacer.children[0].style.color, '#112233');
        view.setDisplayOptions({ showTx: false });
        assert.deepEqual(view.lastRows.map(row => row.kind), ['rx', 'error']);
    } finally { global.document = oldDocument; }
});

test('Hex keywords highlight corresponding bytes in text and both Hex representations', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(Uint8Array.of(65, 66, 255, 67), 't', 1);
        const view = monitorFixture(frames, 800, 600);
        view.setDisplayOptions({ keywordFormat: 'hex', keyword: '41 42\nFF', hexAscii: true });
        assert.equal(view.spacer.children[0].children[1].children
            .filter(span => span.className === 'monitor-keyword').map(span => span.textContent).join(''), '4142FFAB.');
        view.setMode('text');
        const highlights = view.spacer.children[0].children[1].children
            .filter(span => span.className === 'monitor-keyword');
        assert.equal(highlights.map(span => span.textContent).join(''), 'AB�');
        assert.equal(highlights.at(-1).style.color, '#fff');
        assert.deepEqual(frames.rawBytesAt(0), Uint8Array.of(65, 66, 255, 67));
    } finally { global.document = oldDocument; }
});

test('text keywords match decoded characters when the record is shown as Hex', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new TextEncoder().encode('中文Error'), 't', 1);
        const view = monitorFixture(frames, 800, 600);
        view.setDisplayOptions({ keywordFormat: 'text', keyword: '中文error' });
        assert.equal(view.spacer.children[0].children[1].children
            .filter(span => span.className === 'monitor-keyword').map(span => span.textContent).join(''),
        'E4B8ADE696874572726F72');
    } finally { global.document = oldDocument; }
});

test('text keywords on a long standalone TX record avoid sampling frame lookups', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(Uint8Array.of(66), 't', 1);
        const view = monitorFixture(frames, 800, 100);
        view.extras.push({ kind: 'tx', bytes: new Uint8Array(65536).fill(65), order: 2, time: 'u' });
        view.setDisplayOptions({ keyword: 'A' });
        assert.ok(view.spacer.children.at(-1).children[1].children.some(span => span.className === 'monitor-keyword'));
    } finally { global.document = oldDocument; }
});

test('numerical keyword highlighting ignores inserted line wrapping', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5);
        frames.append([123456], Uint8Array.of(65), 't', 1);
        const view = monitorFixture(frames, 800, 600);
        view.setMode('number');
        view.setDisplayOptions({ keyword: '1.23456e+5' });
        view.container.clientWidth = 120;
        view.render();
        assert.equal(view.spacer.children[0].children[1].children
            .filter(span => span.className === 'monitor-keyword').map(span => span.textContent).join(''), '1.23456e+5');
    } finally { global.document = oldDocument; }
});

test('text keywords in Hex mode highlight every byte of a split UTF8 character', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(Uint8Array.of(0xe4, 0xb8), 't', 1);
        frames.appendRaw(Uint8Array.of(0xad, 65), 'u', 2);
        const view = monitorFixture(frames, 800, 600);
        view.setDisplayOptions({ keyword: '中' });
        assert.deepEqual(view.spacer.children.map(row => row.children[1].children
            .filter(span => span.className === 'monitor-keyword').map(span => span.textContent).join('')), ['E4B8', 'AD']);
    } finally { global.document = oldDocument; }
});

test('long-frame text keywords preserve split-character byte spans at both boundaries', async () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        for (const encoding of ['utf-8', 'utf-16le', 'gbk']) {
            const first = new Uint8Array(65538).fill(65);
            const head = encoding === 'utf-8' ? [0xe4, 0xb8] : encoding === 'gbk' ? [0xd6] : [0x2d];
            const tail = encoding === 'utf-8' ? [0xad] : encoding === 'gbk' ? [0xd0] : [0x4e];
            // UTF-16 splits after an odd number of bytes; UTF-8 and GBK split at the long-row threshold.
            const bytes = first.subarray(0, encoding === 'utf-16le' ? 65537 : 65536);
            bytes.set(head, bytes.length - head.length);
            const frames = new FrameBuffer(1, 5, { raw: true });
            frames.appendRaw(bytes, 't', 1);
            frames.appendRaw(Uint8Array.from([...tail, 65]), 'u', 2);
            const view = monitorFixture(frames);
            view.setEncoding(encoding, { deferRender: true });
            view.displayOptions = { ...view.displayOptions, keyword: '\u4e2d' };
            if (encoding === 'gbk') view.installPreparedText(await view.prepareText(frames, encoding, {
                yieldControl: async () => {}
            }));
            const row = { ...frames.frameAt(0), frameIndex: 0 };
            const parts = head.map((_, index) => ({ byteIndex: bytes.length - head.length + index }));
            assert.deepEqual(view._keywordByteRanges(row, {}, parts),
                [{ start: bytes.length - head.length, end: bytes.length }], encoding);
            assert.deepEqual(view._keywordByteRanges({ ...row, streamEnded: true }, {}, parts), [],
                `${encoding} forced stream end`);

            const leading = new FrameBuffer(1, 5, { raw: true });
            leading.appendRaw(Uint8Array.from(head), 't', 1);
            const longTail = new Uint8Array(65536).fill(65);
            longTail.set(tail);
            leading.appendRaw(longTail, 'u', 2);
            const leadingView = monitorFixture(leading);
            leadingView.setEncoding(encoding, { deferRender: true });
            leadingView.displayOptions = { ...leadingView.displayOptions, keyword: '\u4e2d' };
            if (encoding === 'gbk') leadingView.installPreparedText(await leadingView.prepareText(leading, encoding, {
                yieldControl: async () => {}
            }));
            assert.deepEqual(leadingView._keywordByteRanges({ ...leading.frameAt(1), frameIndex: 1 }, {},
                tail.map((_, byteIndex) => ({ byteIndex }))), [{ start: 0, end: tail.length }], `${encoding} prefix`);
        }
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(Uint8Array.of(66), 't', 1);
        frames.appendRaw(new Uint8Array(65536).fill(65), 'u', 2);
        const view = monitorFixture(frames);
        view.displayOptions = { ...view.displayOptions, keyword: 'B' };
        assert.deepEqual(view._keywordByteRanges({ ...frames.frameAt(1), frameIndex: 1 }, {},
            [{ byteIndex: 0 }]), [], 'a match belonging only to the preceding frame is not highlighted');
    } finally { global.document = oldDocument; }
});

test('long frame toggles occupy the first row without adding a line or covering body text', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new Uint8Array(300).fill(65), 't', 1);
        const view = monitorFixture(frames, 400, 100);
        view.setDisplayOptions({ foldLong: true, foldLines: 3 });
        const row = view.spacer.children[0];
        const toggle = row.children.find(child => child.className === 'monitor-fold-toggle');
        assert.ok(toggle);
        assert.equal(view.rowPositions[0].height, 60);
        assert.ok(Number.parseFloat(toggle.style.maxWidth) > 0);
        assert.ok(!row.children[1].children.some(child => child.className === 'monitor-fold-toggle'));
        toggle.onclick({ stopPropagation() {} });
        assert.ok(view.rowPositions[0].height > 60);
        assert.equal(view.spacer.children[0].children.at(-1).className, 'monitor-fold-toggle');
    } finally { global.document = oldDocument; }
});

test('returning to latest removes old positioning padding so a folded frame header stays visible', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new Uint8Array(300).fill(65), 't', 1);
        const view = monitorFixture(frames, 400, 100);
        view.setDisplayOptions({ foldLong: true, foldLines: 3 });
        view.centerPadding = 400;
        view.followTail = true;
        view.render();
        const headerTop = view.rowPositions[0].top - view.container.scrollTop;
        assert.ok(headerTop >= 0 && headerTop < view.container.clientHeight);
    } finally { global.document = oldDocument; }
});

test('Hex display groups bytes with offsets and ASCII while preserving both search representations', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5);
        frames.append([1], Uint8Array.of(65, 66, 0, 255, 67, 68, 69, 70, 71), 't', 1);
        const version = frames.version;
        const view = monitorFixture(frames, 1000, 600);
        view.setDisplayOptions({ hexBytesPerLine: 8, hexGroupBytes: 2, hexOffset: 'frame', hexAscii: true });
        const body = view.spacer.children[0].children[1];
        assert.ok(body.textContent.includes('00000000: 41 42  00 FF  43 44  45 46  |AB..CDEF|'));
        assert.ok(body.textContent.includes('00000008: 47' + ' '.repeat(26) + '|G|'));
        view.setSearchResults([{ startOrder: 1, endOrder: 1, startByte: 1, endByte: 2 }], 0);
        const highlights = view.spacer.children[0].children[1].children
            .filter(span => span.className === 'monitor-search-current').map(span => span.textContent);
        assert.deepEqual(highlights, ['42', 'B']);
        assert.equal(frames.version, version);
        assert.deepEqual(frames.rawBytesAt(0), Uint8Array.of(65, 66, 0, 255, 67, 68, 69, 70, 71));
        view.setMode('number');
        assert.equal(view.spacer.children[0].children[1].textContent, 'CH01= 1.00000e+0');
    } finally { global.document = oldDocument; }
});

test('text display escapes failed characters, merges CRLF breaks and expands tabs without losing highlights', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(Uint8Array.of(65, 0, 255, 9, 13, 10, 66), 't', 1);
        const version = frames.version;
        const view = monitorFixture(frames, 800, 600);
        view.setMode('text');
        view.setDisplayOptions({ textInvalid: 'escape', textNewline: 'line-break', textTab: 'spaces-4' });
        const body = view.spacer.children[0].children[1];
        assert.equal(body.children.map(span => span.textContent).join(''), 'A\\x00\\xFF    \nB');
        assert.equal(view.rowPositions[0].height, 40);
        assert.ok(body.children.some(span => span.style.color === '#fff' && span.textContent === '\\x00\\xFF'));
        view.setSearchResults([{ startOrder: 1, endOrder: 1, startByte: 2, endByte: 3 }], 0);
        assert.ok(view.spacer.children[0].children[1].children.some(span =>
            span.className === 'monitor-search-current' && span.textContent === '\\xFF' && span.style.color === '#fff'));
        assert.equal(frames.version, version);
    } finally { global.document = oldDocument; }
});

test('raw filters keep hidden samples addressable and reveal a time or search target', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5000);
        for (let i = 0; i < 5000; i++) frames.append([i], Uint8Array.of(65), 't', i * 2 + 1);
        const view = monitorFixture(frames, 800, 600);
        view.extras.push({ kind: 'tx', bytes: Uint8Array.of(66), time: 't', order: 2 },
            { kind: 'error', bytes: Uint8Array.of(67), time: 't', order: 4, reason: 'test' });
        view.setDisplayOptions({ showRx: false, showErrors: false });
        assert.equal(view.lastRows.length, 1);
        assert.equal(view.lastRows[0].kind, 'tx');
        view.jumpToFrame(1234);
        assert.ok(view.lastRows.some(row => row.frameIndex === 1234));
        assert.equal(frames.length, 5000);
        view.setSearchResults([{ startOrder: 4001, endOrder: 4001, startByte: 0, endByte: 1 }], 0);
        view.jumpToFrame(2000);
        assert.ok(view.spacer.children.some(row => row.children[1].children.some(span =>
            span.className === 'monitor-search-current')));
    } finally { global.document = oldDocument; }
});

test('long raw frames fold, expand on demand and retain all bytes for positioning', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new Uint8Array(100000).fill(65), 't', 1);
        const view = monitorFixture(frames, 800, 600);
        view.setDisplayOptions({ foldLong: true, foldLines: 3 });
        assert.equal(view.rowPositions[0].height, 60);
        const body = view.spacer.children[0].children[1];
        assert.ok(body.textContent.length < 400);
        const toggle = view.spacer.children[0].children.find(child => child.className === 'monitor-fold-toggle');
        assert.ok(toggle);
        toggle.onclick({ stopPropagation() {} });
        assert.ok(view.rowPositions[0].height > 10000);
        assert.equal(frames.rawBytesAt(0).length, 100000);
        view.clear({ deferRender: true });
        view.render();
        assert.equal(view.rowPositions[0].height, 60);
        view.jumpToFrame(0);
        assert.ok(view.rowPositions[0].height > 10000);
    } finally { global.document = oldDocument; }
});

test('timestamps stay applied across display modes and timer fallback has no refresh-rate delay', () => {
    const oldDocument = global.document, oldTimeout = global.setTimeout, oldClearTimeout = global.clearTimeout;
    global.document = monitorDocument();
    const delays = [];
    global.setTimeout = (_callback, delay) => { delays.push(delay); return delays.length; };
    global.clearTimeout = () => {};
    try {
        const frames = new FrameBuffer(1, 5);
        frames.append([1], Uint8Array.of(65), 't', 1, 1000);
        frames.append([2], Uint8Array.of(66), 'u', 2, 1250);
        const view = monitorFixture(frames, 800, 600);
        view.setDisplayOptions({ timestamp: 'relative', showDirection: false, refreshRate: 20 });
        assert.equal(view.spacer.children[1].children[0].textContent, '[0.250 s] ');
        view.schedule();
        assert.equal(delays.at(-1), 0);
        view.setDisplayOptions({ timestamp: 'none', keywordFormat: 'hex', keyword: '42', keywordColor: '#abcdef' });
        assert.equal(view.spacer.children[1].children[0].textContent, '');
        assert.ok(view.spacer.children[1].children[1].children.some(span =>
            span.className === 'monitor-keyword' && span.textContent === '42' && span.style.color === '#abcdef'));
        view.setMode('number');
        assert.equal(view.spacer.children[1].children[0].textContent, '');
    } finally { global.document = oldDocument; global.setTimeout = oldTimeout; global.clearTimeout = oldClearTimeout; }
});

test('live byte updates coalesce into the next animation frame and can refresh above 30 FPS', () => {
    const oldDocument = global.document;
    const oldAnimationFrame = global.requestAnimationFrame;
    const oldCancelAnimationFrame = global.cancelAnimationFrame;
    global.document = monitorDocument();
    const callbacks = new Map();
    let nextId = 0;
    global.requestAnimationFrame = callback => { const id = nextId++; callbacks.set(id, callback); return id; };
    global.cancelAnimationFrame = id => callbacks.delete(id);
    try {
        const frames = new FrameBuffer(1, 500);
        const view = monitorFixture(frames);
        let renders = 0;
        const render = view.render.bind(view);
        view.render = () => { renders++; render(); };
        for (let tick = 0; tick < 120; tick++) {
            for (let batch = 0; batch < 3; batch++) {
                frames.append([tick], Uint8Array.of(tick), 't', tick * 3 + batch);
                view.appendFrame();
            }
            assert.equal(callbacks.size, 1, 'all arrivals before a paint share one callback');
            const [id, callback] = callbacks.entries().next().value;
            callbacks.delete(id);
            callback(tick * 1000 / 120);
            assert.equal(callbacks.size, 0, 'no new data means no further refresh is queued');
            assert.equal(view.lastRows.at(-1).order, tick * 3 + 2);
        }
        assert.equal(renders, 120);
        assert.equal(frames.length, 360, 'display batching retains every received frame');
        view.appendFrame();
        view.render();
        assert.equal(callbacks.size, 0, 'explicit renders cancel redundant queued updates');
        view.appendFrame();
        view.setDisplayOptions({ showDirection: false });
        assert.equal(callbacks.size, 0, 'settings update cancels the queued animation frame');
        view.appendFrame();
        assert.equal(callbacks.size, 1, 'settings updates do not suspend subsequent reception');
        view._cancelScheduledRender();
    } finally {
        global.document = oldDocument;
        global.requestAnimationFrame = oldAnimationFrame;
        global.cancelAnimationFrame = oldCancelAnimationFrame;
    }
});

test('long prepared text keeps configured breaks and escaping after worker preparation and resize', async () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    const { HistoryWorkerPool } = require('../historyWorkers');
    const pool = new HistoryWorkerPool({ hardwareConcurrency: 4, workerFactory: () => {
        const { Worker } = require('node:worker_threads');
        const { buildHistoryWorkerSource } = require('../historyWorkers');
        const worker = new Worker(`const { parentPort } = require('node:worker_threads');
            global.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer) };
            ${buildHistoryWorkerSource()}
            parentPort.on('message', data => self.onmessage({ data }));`, { eval: true });
        worker.on('message', data => worker.onmessage?.({ data }));
        worker.on('error', error => worker.onerror?.(error));
        return worker;
    } });
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        const bytes = Uint8Array.from({ length: 96000 }, (_, i) => [65, 0, 255, 9, 13, 10][i % 6]);
        frames.appendRaw(bytes, 't', 1);
        const view = monitorFixture(frames, 800, 600);
        view.setMode('text', { deferRender: true });
        view.setDisplayOptions({ textInvalid: 'escape', textNewline: 'line-break', textTab: 'spaces-4' }, { deferRender: true });
        const options = { yieldControl: async () => {} };
        const local = await view.prepareText(frames, 'utf-8', options);
        const worker = await view.prepareText(frames, 'utf-8', { ...options, prepareRecord: task => pool.runTask(task) });
        assert.deepEqual(worker.rows.get(1).layouts, local.rows.get(1).layouts);
        assert.equal(worker.rows.get(1).layouts.values().next().value.length, 16001);
        view.installPreparedText(worker);
        view.render();
        const body = view.spacer.children[0].children[1];
        assert.ok(body.children.map(span => span.textContent).join('').includes('A\\x00\\xFF    \n'));
        assert.ok(body.children.length < 3000, 'long text must mount only viewport characters');
        view.container.clientWidth = 90;
        view.render();
        assert.ok(view.rowPositions[0].height > 320020);
        view.container.clientWidth = 800;
        view.render();
        assert.equal(view.rowPositions[0].height, 320020);
        assert.deepEqual(frames.rawBytesAt(0), bytes);
    } finally { pool.dispose(); global.document = oldDocument; }
});

test('a prepared newline at an exact column boundary adds only one line', () => {
    const { appendCompactTokens } = require('../monitorView');
    const { MappedTextDecoder } = require('../textCodec');
    const decoder = new MappedTextDecoder();
    const data = { chunks: [], length: 0, width: 0, initialLines: [0], layouts: new Map(), columns: 4,
        displayOptions: { textNewline: 'line-break' } };
    appendCompactTokens(data, decoder.write(new TextEncoder().encode('ABCD\r\nEF'), 0));
    assert.deepEqual(data.initialLines, [0, 5]);
    assert.equal(data.width, 2);
});

test('filtering a large RX history keeps TX scrolling in the displayed row coordinates', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 2100);
        for (let i = 0; i < 2100; i++) frames.append([i], Uint8Array.of(65), 't', i + 1);
        const listeners = {};
        const container = { clientWidth: 800, clientHeight: 100, scrollTop: 0, children: [],
            replaceChildren(child) { this.children = [child]; }, addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() { return Math.max(100, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const view = new MonitorView(container, frames);
        for (let i = 0; i < 20; i++) view.extras.push({ kind: 'tx', bytes: Uint8Array.of(66), time: 't', order: 2200 + i });
        view.setDisplayOptions({ showRx: false });
        assert.equal(container.scrollTop, 300);
        container.scrollTop = 100;
        listeners.scroll();
        assert.equal(container.scrollTop, 100);
        assert.equal(view.anchor.order, 2205);
        assert.equal(view.followTail, false);
    } finally { global.document = oldDocument; }
});

test('search reference uses the nearest sampling frame when the centered TX view hides RX', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5);
        for (const order of [10, 20, 30]) frames.append([order], Uint8Array.of(65), 't', order);
        const view = monitorFixture(frames, 800, 20);
        for (const order of [12, 18, 23, 40])
            view.extras.push({ kind: 'tx', bytes: Uint8Array.of(66), time: 't', order });
        view.setDisplayOptions({ showRx: false });
        view.followTail = false;
        view.anchor = { order: 18, within: 0 };
        assert.equal(view.currentFrameIndex(), 1);
        view.followTail = true;
        assert.equal(view.currentFrameIndex(), 2);
    } finally { global.document = oldDocument; }
});

test('ordinary text with many real line breaks renders only tail lines while following', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new TextEncoder().encode('A\n'.repeat(100) + 'Z'), 't', 1);
        const view = monitorFixture(frames, 800, 100);
        view.setMode('text', { deferRender: true });
        view.setDisplayOptions({ textNewline: 'line-break' });
        const body = view.spacer.children[0].children[1];
        assert.ok(body.textContent.length < 40);
        assert.ok(body.textContent.endsWith('Z'));
        assert.equal(view.rowPositions[0].height, 2020);
        assert.equal(frames.rawBytesAt(0).length, 201);
    } finally { global.document = oldDocument; }
});

test('offscreen long text does not overlay the next frame when its visible range is empty', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new TextEncoder().encode('A\n'.repeat(100) + 'Z'), 't', 1);
        frames.appendRaw(new TextEncoder().encode('B\n'.repeat(20) + 'Q'), 'u', 2);
        const view = monitorFixture(frames, 800, 100);
        view.setMode('text');
        view.setDisplayOptions({ textNewline: 'line-break', keyword: 'Z' });
        const first = view.spacer.children.find(row => row.children[0]?.textContent === '[t] RX ');
        assert.ok(first);
        assert.equal(first.children[1].children.map(span => span.textContent).join(''), '');
        const last = view.spacer.children.at(-1).children[1];
        assert.ok(last.children.map(span => span.textContent).join('').endsWith('Q'));
    } finally { global.document = oldDocument; }
});

test('keyword highlighting follows original text across soft wrapping but not real line breaks', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new TextEncoder().encode('x'.repeat(86) + 'ERROR'), 't', 1);
        frames.appendRaw(new TextEncoder().encode('ER\nROR'), 't', 2);
        const view = monitorFixture(frames, 800, 600);
        view.setMode('text', { deferRender: true });
        view.setDisplayOptions({ keyword: 'ERROR', textNewline: 'line-break' });
        const body = view.spacer.children[0].children[1];
        assert.equal(body.children.filter(span => span.className === 'monitor-keyword')
            .map(span => span.textContent).join(''), 'ERROR');
        assert.ok(!view.spacer.children[1].children[1].children.some(span => span.className === 'monitor-keyword'));
        view.container.clientWidth = 1000;
        view.render();
        assert.equal(view.spacer.children[0].children[1].children.filter(span => span.className === 'monitor-keyword')
            .map(span => span.textContent).join(''), 'ERROR');
    } finally { global.document = oldDocument; }
});

test('unchanged text logs and live eviction decode only visible records after layout measurement', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    const { MappedTextDecoder } = require('../textCodec');
    const write = MappedTextDecoder.prototype.write;
    let decodedBytes = 0;
    MappedTextDecoder.prototype.write = function(bytes, ...args) {
        decodedBytes += bytes.length;
        return write.call(this, bytes, ...args);
    };
    try {
        const frames = new FrameBuffer(1, 1000, { raw: true });
        const bytes = Uint8Array.from({ length: 96 }, (_, index) => index * 53 % 256);
        for (let i = 0; i < 1000; i++) frames.appendRaw(bytes, 't', i + 1, i);
        const view = monitorFixture(frames);
        view.setMode('text');
        view.textCache.clear();
        decodedBytes = 0;
        view.render();
        assert.ok(decodedBytes < 8192, `offscreen records were decoded again: ${decodedBytes} bytes`);
        frames.appendRaw(bytes, 'u', 1001, 1001);
        decodedBytes = 0;
        view.render();
        assert.ok(decodedBytes < 8192, `eviction invalidated unchanged offscreen rows: ${decodedBytes} bytes`);
        assert.ok(view.spacer.children.length < 30);
    } finally {
        MappedTextDecoder.prototype.write = write;
        global.document = oldDocument;
    }
});

test('text row height refreshes when a split character completes and when width changes', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 10, { raw: true });
        frames.appendRaw(Uint8Array.of(0xf0, 0x9f, 0x98), 't', 1, 1);
        const view = monitorFixture(frames, 90);
        view.setMode('text');
        assert.equal(view.lastOffsets[1] - view.lastOffsets[0], 40);
        frames.appendRaw(Uint8Array.of(0x80), 'u', 2, 2);
        view.render();
        assert.equal(view.lastOffsets[1] - view.lastOffsets[0], 20);
        frames.appendRaw(new TextEncoder().encode('abcdefghijklmnop'), 'v', 3, 3);
        view.render();
        const narrow = view.lastOffsets[3] - view.lastOffsets[2];
        view.container.clientWidth = 800;
        view.render();
        assert.ok(view.lastOffsets[3] - view.lastOffsets[2] < narrow);
    } finally { global.document = oldDocument; }
});

test('numeric log alignment resizes and preserves search highlighting by channel', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(12, 5);
        frames.append(Array.from({ length: 12 }, (_, i) => i + 0.5), Uint8Array.of(1), 't', 1);
        const view = monitorFixture(frames, 620, 600);
        view.setMode('number');
        const layout = view._rowLayout({ ...frames.frameAt(0), frameIndex: 0 }, 90);
        assert.equal(layout.numberText.split('\n').length, 6);
        assert.equal(layout.numberText.split('\n')[0].indexOf('CH02=') + 'CH02='.length,
            layout.numberText.split('\n')[4].indexOf('CH10=') + 'CH10='.length);
        view.setSearchResults([{ startOrder: 1, endOrder: 1, channel: 9 }], 0);
        const body = view.spacer.children[0].children[1];
        assert.ok(body.children.some(span => span.className === 'monitor-search-current' &&
            /^CH10= +9\.50000e\+0$/.test(span.textContent)));
        const oldHeight = view.rowPositions[0].height;
        view.container.clientWidth = 1200;
        view.render();
        assert.ok(view.rowPositions[0].height < oldHeight);
    } finally { global.document = oldDocument; }
});

test('numeric monitor aligns e across frames, resizing and precision edits without rounding stored samples', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(4, 10);
        frames.append([1.25, -2.5, 3.75, 4.5], Uint8Array.of(1), 't', 1);
        frames.append([-123.456, 20.25, 99.5, -30.75], Uint8Array.of(2), 't', 2);
        const view = monitorFixture(frames, 600, 600);
        view.setMode('number');
        const bodies = () => view.spacer.children.map(row => {
            const body = row.children[1];
            return (body.textContent ?? body.children.map(span => span.textContent).join('')).split('\n');
        });
        const exponents = lines => lines.map(line => Array.from(line.matchAll(/e[+-]/g), match => match.index));
        assert.deepEqual(exponents(bodies()[0]), exponents(bodies()[1]));
        const positions = exponents(bodies()[1]);
        frames.append([0.5, 0.5, -0.5, -0.5], Uint8Array.of(3), 't', 3);
        view.render();
        assert.deepEqual(exponents(bodies()[2]), positions);
        view.container.clientWidth = 1200;
        view.render();
        assert.deepEqual(exponents(bodies()[0]), exponents(bodies()[1]));
        assert.deepEqual(exponents(bodies()[1]), exponents(bodies()[2]));
        const search = new MonitorSearchSession(frames, parseMonitorSearch('number', '-123.456', 0, 0));
        search.step(10);
        assert.equal(search.matches.length, 1);
        view.setSearchResults(search.matches, 0);
        view.setDisplayOptions({ numericSignificantDigits: 3 });
        assert.match(bodies()[0][0], /CH01= 1\.25e\+0/);
        assert.match(bodies()[1][0], /CH01=-1\.23e\+2/);
        assert.deepEqual(exponents(bodies()[0]), exponents(bodies()[1]));
        view.setDisplayOptions({ numericSignificantDigits: 1 });
        assert.match(bodies()[1][0], /CH01=-1e\+2/);
        assert.ok(view.spacer.children[1].children[1].children.some(span =>
            span.className === 'monitor-search-current' && span.textContent === 'CH01=-1e+2'));
        assert.equal(view.matches, search.matches);
        assert.equal(view.followTail, true);
        assert.equal(frames.getValue(0, 1), -123.456, 'display precision must not change samples');
        assert.deepEqual(frames.rawBytesAt(1), Uint8Array.of(2));
    } finally { global.document = oldDocument; }
});

test('large numeric logs align only nearby frames and reset padding when cleared', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(4, 3000);
        for (let i = 0; i < 3000; i++)
            frames.append(i % 2 ? [-123.5, 20.25, 99.5, -30.75] : [1.5, -2.25, 3.5, 4.75],
                Uint8Array.of(i % 256), 't', i + 1);
        const getValue = frames.getValue;
        let reads = 0;
        frames.getValue = function(...args) { reads++; return getValue.apply(this, args); };
        const view = monitorFixture(frames, 600, 300);
        view.setMode('number');
        assert.ok(reads < 300, `alignment scanned offscreen samples: ${reads} reads`);
        const decimalPositions = view.spacer.children.map(row => row.children[1].textContent
            .split('\n').map(line => Array.from(line.matchAll(/\./g), match => match.index)));
        assert.ok(decimalPositions.length > 1);
        assert.ok(decimalPositions.every(positions => JSON.stringify(positions) ===
            JSON.stringify(decimalPositions[0])));
        view.jumpToFrame(500);
        assert.equal(view.followTail, false);
        const order = view.anchor.order;
        frames.append([0.5, -0.5, 0.5, -0.5], Uint8Array.of(0), 't', 3001);
        view.render();
        assert.equal(view.anchor.order, order);
        frames.clear();
        view.clear({ deferRender: true });
        frames.append([1.5, 2.5, 3.5, 4.5], Uint8Array.of(1), 't', 1);
        view.render();
        assert.ok(view.spacer.children[0].children[1].textContent.startsWith('CH01= 1.5'));
    } finally { global.document = oldDocument; }
});

test('unchanged numeric rows reuse decoded values and refresh when their buffer is replaced', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(4, 500);
        for (let i = 0; i < 500; i++) frames.append([1.5, -2.25, 3.5, 4.75], Uint8Array.of(1), 't', i + 1);
        const getValue = frames.getValue;
        let reads = 0;
        frames.getValue = function(...args) { reads++; return getValue.apply(this, args); };
        const view = monitorFixture(frames, 600, 300);
        view.setMode('number');
        reads = 0;
        view.render();
        assert.equal(reads, 0, 'unchanged rows must not be decoded again');
        frames.append([-123.5, 20.25, 99.5, -30.75], Uint8Array.of(2), 't', 501);
        view.render();
        assert.equal(reads, 4, 'only the new frame needs numeric decoding');
        const bodies = view.spacer.children.map(row => row.children[1].textContent.split('\n'));
        assert.equal(bodies.at(-1)[0].indexOf('.'), bodies[0][0].indexOf('.'));
        view.container.clientWidth = 1200;
        view.render();
        assert.equal(reads, 4, 'resizing reuses immutable decoded values');
        const rebuilt = new FrameBuffer(4, 500);
        rebuilt.append([456.5, -0.25, 0.5, 0.75], Uint8Array.of(3), 't', 501);
        frames.replaceFrom(rebuilt);
        view.render();
        assert.ok(view.spacer.children[0].children[1].textContent.includes('4.56500e+2'));
        assert.ok(!view.spacer.children[0].children[1].textContent.includes('1.23500e+2'));
        const replacement = new FrameBuffer(4, 500);
        replacement.append([-789.5, 0.25, -0.5, -0.75], Uint8Array.of(4), 't', 501);
        view.frames = replacement;
        view.render();
        assert.ok(view.spacer.children[0].children[1].textContent.includes('-7.89500e+2'));
    } finally { global.document = oldDocument; }
});

test('large Hex and ASCII records mount only viewport lines while retaining full row height', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        const bytes = new Uint8Array(100_000).fill(65);
        bytes[bytes.length - 1] = 90;
        frames.appendRaw(bytes, 't', 1, 1);
        const view = monitorFixture(frames);
        for (const mode of ['hex', 'ascii']) {
            view.setSearchResults([]);
            view.setMode(mode);
            const row = view.spacer.children[0], body = row.children[1];
            assert.ok(body.textContent.length < 3000, 'offscreen bytes must not be converted or mounted');
            assert.ok(parseInt(row.style.height, 10) > 20_000);
            assert.ok(parseInt(body.style.marginTop, 10) > 20_000);
            assert.ok(body.textContent.endsWith(mode === 'hex' ? '5A' : 'Z'));
            view.setSearchResults([{ startOrder: 1, endOrder: 1, startByte: 99999, endByte: 100000 }], 0);
            const highlighted = view.spacer.children[0].children[1];
            assert.ok(highlighted.children.map(span => span.textContent).join('').length < 3000);
            assert.ok(highlighted.children.some(span => span.className === 'monitor-search-current' &&
                span.textContent === (mode === 'hex' ? '5A' : 'Z')));
        }
        assert.equal(frames.rawBytesAt(0).length, 100000);
    } finally { global.document = oldDocument; }
});

test('asynchronous text preparation yields, clips long records and reuses decoded data after resize', async () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        const bytes = new Uint8Array(100_000).fill(65);
        bytes.set([0xe4, 0xb8], bytes.length - 2);
        frames.appendRaw(bytes, 't', 1, 1);
        frames.appendRaw(Uint8Array.of(0xad, 0xff, 0, 90), 'u', 2, 2);
        const view = monitorFixture(frames);
        let yields = 0;
        const progress = [];
        assert.equal(typeof view.prepareText, 'function');
        const prepared = await view.prepareText(frames, 'utf-8', {
            yieldControl: async () => { yields++; }, onProgress: value => progress.push(value)
        });
        assert.ok(yields >= 20, 'large records must be decoded in bounded batches');
        assert.equal(progress.at(-1), 1);
        assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
        view.setEncoding('utf-8', { deferRender: true });
        view.setMode('text', { deferRender: true });
        view.installPreparedText(prepared);
        const decode = view._textTokens.bind(view);
        view._textTokens = row => {
            if (row.bytes.length >= 65536) throw new Error('prepared rows must not decode synchronously');
            return decode(row);
        };
        assert.equal(prepared.rows.size, 1, 'short records must not be retained as prepared decoded history');
        view.render();
        const contents = () => view.spacer.children.map(row => {
            const body = row.children[1];
            return body.textContent ?? body.children.map(span => span.textContent).join('');
        }).join('');
        assert.ok(contents().length < 3000);
        assert.match(contents(), /中/);
        assert.match(contents(), /\uFFFD\uFFFDZ/);
        const white = view.spacer.children.at(-1).children[1].children.find(span => span.style.color === '#fff');
        assert.equal(white.textContent, '\uFFFD\uFFFD');
        const height = view.spacer.style.height;
        view.container.clientWidth = 400;
        view.render();
        assert.ok(parseInt(view.spacer.style.height, 10) > parseInt(height, 10));
        assert.ok(contents().length < 3000);
        assert.match(contents(), /中/);
    } finally { global.document = oldDocument; }
});

test('cancelled text preparation leaves the displayed state intact', async () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        frames.appendRaw(new Uint8Array(100_000).fill(65), 't', 1, 1);
        const view = monitorFixture(frames);
        let cancelled = false;
        assert.equal(typeof view.prepareText, 'function');
        const state = await view.prepareText(frames, 'utf-8', {
            isCancelled: () => cancelled,
            yieldControl: async () => { cancelled = true; }
        });
        assert.equal(state, null);
        assert.equal(view.mode, 'hex');
        assert.equal(view.preparedText, null);
    } finally { global.document = oldDocument; }
});

test('worker text preparation matches local layouts and dispatches visible rows together', async () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        for (const [encoding, tail, next] of [
            ['utf-8', [0xe4, 0xb8], [0xad, 0xff, 0, 90]],
            ['gb18030', [0x94, 0x39], [0xfc, 0x36, 32, 65]],
            ['utf-16le', [0x3d, 0xd8], [0, 0xde, 90, 0]]
        ]) {
            const frames = new FrameBuffer(1, 5, { raw: true });
            const bytes = new Uint8Array(70_000).fill(65);
            if (encoding.startsWith('utf-16')) {
                for (let i = 1; i < bytes.length; i += 2) bytes[i] = 0;
            }
            bytes.set(tail, bytes.length - tail.length);
            frames.appendRaw(bytes, 't', 1, 1);
            frames.appendRaw(Uint8Array.from(next), 'u', 2, 2);
            frames.appendRaw(bytes, 'v', 3, 3);
            const view = monitorFixture(frames);
            const local = await view.prepareText(frames, encoding, { yieldControl: async () => {} });
            const tasks = [], completions = [];
            const pending = view.prepareText(frames, encoding, {
                yieldControl: async () => {},
                prepareRecord(task) {
                    tasks.push(task);
                    return new Promise(resolve => completions.push(() => {
                        const { createHistoryTaskProcessor } = require('../historyWorkers');
                        const { textCells, appendCompactTokens } = require('../monitorView');
                        const processor = createHistoryTaskProcessor(task,
                            { ...require('../textCodec'), textCells, appendCompactTokens });
                        processor.step(Infinity); // Match the actual worker's bounded inner writes.
                        resolve(processor.result());
                    }));
                }
            });
            await Promise.resolve();
            assert.equal(tasks.length, 2, 'independent visible rows must be dispatched without waiting');
            for (const complete of completions.reverse()) complete();
            const prepared = await pending;
            const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
            const summarize = state => [...state.rows].sort((a, b) => a[0] - b[0]).map(([order, data]) => ({
                order, length: data.length, width: data.width, columns: data.columns,
                byteLength: data.byteLength, byteOffset: data.byteOffset,
                nextOrders: data.nextOrders, needsFollowing: data.needsFollowing, streamEnded: data.streamEnded,
                text: digest(data.chunks.map(chunk => chunk.text).join('')),
                mappings: ['cells', 'starts', 'ends', 'crosses', 'failed'].map(key => digest(Buffer.concat(
                    data.chunks.map(chunk => Buffer.from(chunk[key].buffer))))),
                lines: [...data.layouts].map(([columns, lines]) => [columns, digest(Buffer.from(lines.buffer))])
            }));
            assert.deepEqual(summarize(prepared), summarize(local), encoding);
            assert.equal(frames.rawBytesAt(0).length, 70000, 'source records must remain available');
        }
    } finally { global.document = oldDocument; }
});

test('new long text rows prepare asynchronously and deferred clear does not render', async () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    let view;
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        const bytes = new Uint8Array(70_000).fill(65);
        bytes[bytes.length - 1] = 90;
        frames.appendRaw(bytes, 't', 1, 1);
        view = monitorFixture(frames);
        const prepare = view.prepareText.bind(view);
        view.prepareText = (source, encoding, options) => prepare(source, encoding,
            { ...options, yieldControl: async () => {} });
        view._textTokens = () => { throw new Error('long live rows must not decode synchronously'); };
        view.setMode('text');
        assert.ok(view.textPreparation instanceof Promise);
        const pendingRow = view.spacer.children[0], pendingBody = pendingRow.children[1];
        assert.match(pendingBody.textContent, /准备文本/);
        const indicatorTop = parseInt(pendingRow.style.top, 10) +
            parseInt(pendingBody.style.marginTop || '0', 10) - view.container.scrollTop;
        assert.ok(indicatorTop >= 0 && indicatorTop < view.rowHeight,
            'the preparation indicator must be inside the viewport while following a long record tail');
        await view.textPreparation;
        assert.ok(view.spacer.children[0].children[1].textContent.endsWith('Z'));
        let renders = 0;
        view.render = () => { renders++; };
        view.clear({ deferRender: true });
        assert.equal(renders, 0);
        assert.equal(view.preparedText, null);
        view.clear();
        assert.equal(renders, 1);
    } finally {
        if (view?.textPreparation) await view.textPreparation;
        global.document = oldDocument;
    }
});

test('text rows never join encoded characters across a forced stream end', () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        for (const [encoding, left, right] of [
            ['utf-8', [0xe4, 0xb8], [0xad, 65]], ['gbk', [0xd6], [0xd0, 32, 65]],
            ['utf-16le', [0x3d, 0xd8], [0, 0xde, 65, 0]]
        ]) {
            const frames = new FrameBuffer(1, 5, { raw: true });
            frames.appendRaw(Uint8Array.from(left), 't', 1, 1);
            frames.appendRaw(Uint8Array.from(right), 'u', 2, 2);
            frames.streamEndedAt = index => index === 0;
            const frameAt = frames.frameAt.bind(frames);
            frames.frameAt = index => { const row = frameAt(index); return row && { ...row, streamEnded: index === 0 }; };
            const view = monitorFixture(frames);
            view.setEncoding(encoding, { deferRender: true });
            const first = view._textTokens({ ...frames.frameAt(0), frameIndex: 0 });
            const second = view._textTokens({ ...frames.frameAt(1), frameIndex: 1 });
            assert.ok(first.every(token => token.invalid), encoding);
            assert.equal(second.at(-1).text, 'A', encoding);
            assert.equal(second[0].invalid, true, encoding);
            assert.ok(first.every(token => token.endFrame === token.startFrame), encoding);
        }
    } finally { global.document = oldDocument; }
});

test('prepared long text flushes a stream tail rather than joining the next stream', async () => {
    const oldDocument = global.document;
    global.document = monitorDocument();
    try {
        const frames = new FrameBuffer(1, 5, { raw: true });
        const bytes = new Uint8Array(70_000).fill(65);
        bytes.set([0xe4, 0xb8], bytes.length - 2);
        frames.appendRaw(bytes, 't', 1, 1);
        frames.appendRaw(Uint8Array.of(0xad, 90), 'u', 2, 2);
        frames.streamEndedAt = index => index === 0;
        const frameAt = frames.frameAt.bind(frames);
        frames.frameAt = index => { const row = frameAt(index); return row && { ...row, streamEnded: index === 0 }; };
        const view = monitorFixture(frames);
        const prepared = await view.prepareText(frames, 'utf-8', { yieldControl: async () => {} });
        view.setMode('text', { deferRender: true });
        view.installPreparedText(prepared);
        view.render();
        const body = view.spacer.children[0].children[1];
        const text = body.children.map(span => span.textContent).join('');
        assert.ok(text.endsWith('\uFFFD\uFFFD'));
        assert.ok(!text.includes('中'));
    } finally { global.document = oldDocument; }
});

test('text monitor preserves cross-frame Unicode, wraps display cells and highlights source bytes', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const frames = new FrameBuffer(1, 5);
        frames.append([0], Uint8Array.of(0xe4, 0xb8), 't0', 1);
        frames.append([0], Uint8Array.of(0xad, 0x41, 0x0a, 0xff), 't1', 2);
        const container = { clientWidth: 80, clientHeight: 200, scrollTop: 0, children: [],
            replaceChildren(child) { this.children = [child]; }, addEventListener() {},
            get scrollHeight() { return Math.max(200, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const view = new MonitorView(container, frames);
        view.setEncoding('utf-8');
        view.setMode('text');
        const session = new MonitorSearchSession(frames, parseMonitorSearch('text', '中A'));
        session.step();
        view.setSearchResults(session.matches, 0);
        const first = view.spacer.children[0].children[1];
        assert.equal(first.children.map(span => span.textContent).join(''), '中');
        assert.equal(first.children[0].className, 'monitor-search-current');
        const second = view.spacer.children[1];
        const body = second.children[1].children.map(span => span.textContent).join('');
        assert.match(body, /A/);
        assert.match(body.replaceAll('\n', ''), /\\n\uFFFD/);
        assert.ok(parseInt(second.style.height, 10) >= 40, 'visible escapes participate in wrapping');
    } finally { global.document = oldDocument; }
});

test('text replacement characters stay white with and without search highlights', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); } })
    };
    try {
        const frames = new FrameBuffer(1, 5);
        frames.append([0], Uint8Array.of(0x41, 0xff, 0x00, 0x0d, 0x0a, 0x09), 't', 1);
        const { MappedTextDecoder } = require('../textCodec');
        const decoder = new MappedTextDecoder('utf-8');
        const view = Object.create(MonitorView.prototype);
        view.frames = frames;
        const row = { ...frames.frameAt(0), frameIndex: 0 };
        const tokens = decoder.write(row.bytes, 0);
        const layout = { prefix: '[t] RX ', byteMode: 'text', lineCount: 1,
            parts: tokens.map(token => ({ text: token.display, token })) };
        for (const highlighted of [false, true]) {
            view._rangesForRow = () => highlighted ? [{ start: 1, end: 3, current: true }] : [];
            const body = view._makeRow(row, layout, 0).children[1];
            assert.equal(body.children.map(span => span.textContent).join(''), 'A\uFFFD\uFFFD\\r\\n\\t');
            const replacements = body.children.filter(span => span.textContent.includes('\uFFFD'));
            assert.equal(replacements.length, 1);
            assert.equal(replacements[0].textContent, '\uFFFD\uFFFD');
            assert.equal(replacements[0].style.color, '#fff');
            if (highlighted) assert.match(replacements[0].className, /monitor-search-current/);
            const normal = body.children.filter(span => !span.textContent.includes('\uFFFD'));
            assert.ok(normal.every(span => !span.style.color));
        }
        const search = new MonitorSearchSession(frames, parseMonitorSearch('text', '\uFFFD'));
        search.step();
        assert.deepEqual(search.matches, [], 'invalid bytes must not match a literal replacement character');
    } finally { global.document = oldDocument; }
});

test('random-access legacy text decoding finds actual boundaries in an uninterrupted multibyte run', () => {
    const oldDocument = global.document;
    global.document = { createElement: () => ({ style: {}, replaceChildren() {} }) };
    try {
        const frames = new FrameBuffer(1, 10);
        for (let i = 0; i < 8; i++) frames.append([0], Uint8Array.of(i % 2 ? 0xd0 : 0xd6), '', i);
        const view = new MonitorView({ scrollTop: 0, replaceChildren() {}, addEventListener() {} }, frames);
        view.encoding = 'gbk';
        assert.deepEqual(view._textTokens({ ...frames.frameAt(5), frameIndex: 5 }), []);
        assert.equal(view._textTokens({ ...frames.frameAt(4), frameIndex: 4 })[0].text, '中');
        frames.resize(8);
        frames.append([0], Uint8Array.of(0xd6), '', 8);
        assert.equal(view._textTokens({ ...frames.frameAt(4), frameIndex: 4 })[0].text, '兄',
            'retained-stream display starts at the same byte origin as a new text search');
    } finally { global.document = oldDocument; }
});

test('a long idle-framed text record does not exceed the JavaScript argument limit', () => {
    const oldDocument = global.document;
    global.document = { createElement: () => ({ style: {}, replaceChildren() {} }) };
    try {
        const frames = new FrameBuffer(1, 2);
        frames.append([0], new Uint8Array(150_000).fill(65), '', 0);
        const view = new MonitorView({ scrollTop: 0, replaceChildren() {}, addEventListener() {} }, frames);
        assert.equal(view._textTokens({ ...frames.frameAt(0), frameIndex: 0 }).length, 150_000);
    } finally { global.document = oldDocument; }
});

test('large variable-length text logs keep live following and historical frame centering', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const frames = new FrameBuffer(1, 3000);
        for (let i = 0; i < 3000; i++)
            frames.append([0], new TextEncoder().encode(`第${i}帧 ` + '内容'.repeat(i % 20) + '\n'), `t${i}`, i);
        const listeners = {};
        const container = { clientWidth: 240, clientHeight: 200, scrollTop: 0, children: [],
            replaceChildren(child) { this.children = [child]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() { return Math.max(200, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const view = new MonitorView(container, frames);
        view.setMode('text');
        assert.equal(view.followTail, true);
        assert.equal(view.currentFrameIndex(), 2999);
        assert.ok(view.spacer.children.length < 25);
        container.scrollTop -= 30;
        listeners.scroll();
        assert.equal(view.followTail, false);
        view.jumpToFrame(1500);
        assert.equal(view.currentFrameIndex(), 1500);
        container.scrollTop = container.scrollHeight - container.clientHeight;
        listeners.scroll();
        assert.equal(view.followTail, true);
        assert.equal(view.currentFrameIndex(), 2999);
    } finally { global.document = oldDocument; }
});

test('all retained RX frames remain addressable alongside recent TX events', () => {
    const frames = new FrameBuffer(1, 3);
    frames.append([1], Uint8Array.of(1), 't1', 1);
    frames.append([2], Uint8Array.of(2), 't2', 3);
    frames.append([3], Uint8Array.of(3), 't3', 4);
    frames.append([4], Uint8Array.of(4), 't4', 5);
    const rows = mergeMonitorRows(frames, [{ order: 2, kind: 'tx', bytes: Uint8Array.of(255), time: 'tx' }]);
    assert.deepEqual(rows.map(row => row.order), [2, 3, 4, 5]);
    assert.deepEqual(rows.filter(row => row.kind === 'rx').map(row => [...row.bytes][0]), [2, 3, 4]);
    assert.equal(bytesToHex(rows[0].bytes), 'FF');
});

test('virtual monitor follows the newest row while mounting only visible rows', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const listeners = {};
        const container = { clientWidth: 800, clientHeight: 200, scrollTop: 0, children: [],
            replaceChildren(child) { this.children = [child]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() { return Math.max(200, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(1, 100);
        const view = new MonitorView(container, frames);
        for (let i = 0; i < 100; i++) frames.append([i], Uint8Array.of(i), `t${i}`, i);
        view.render();
        assert.ok(view.spacer.children.length < 25);
        assert.match(view.spacer.children.at(-1).children[0].textContent, /t99/);
        container.scrollTop = 0;
        listeners.scroll();
        assert.match(view.spacer.children[0].children[0].textContent, /t0/);
        assert.equal(view.currentFrameIndex(), 5, 'center of the visible 10 rows');
    } finally {
        global.document = oldDocument;
    }
});

test('large live monitor fills the log above the newest row', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const listeners = {};
        const container = { clientWidth: 800, clientHeight: 400, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() { return Math.max(400, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(1, 3000);
        for (let i = 0; i < 3000; i++) frames.append([i], Uint8Array.of(i & 255), `t${i}`, i);
        const view = new MonitorView(container, frames);
        view.render();
        const firstTop = parseInt(view.spacer.children[0].style.top, 10);
        assert.ok(firstTop <= container.scrollTop,
            `first visible row starts ${firstTop - container.scrollTop}px below the log top`);
        assert.match(view.spacer.children.at(-1).children[0].textContent, /t2999/);
        container.scrollTop = 0;
        listeners.scroll();
        assert.ok(parseInt(view.spacer.children[0].style.top, 10) <= container.scrollTop);
        view.jumpToFrame(0);
        assert.ok(Math.abs(parseInt(view.spacer.children[0].style.top, 10) -
            container.scrollTop - container.clientHeight / 2) <= view.rowHeight);
        assert.equal(view.currentFrameIndex(), 0);
        view.jumpToFrame(1500);
        assert.equal(view.currentFrameIndex(), 1500);
    } finally { global.document = oldDocument; }
});

test('live buffer eviction keeps the selected record at the same viewport position', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const listeners = {};
        const container = { clientWidth: 800, clientHeight: 60, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() { return Math.max(60, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(1, 10);
        const view = new MonitorView(container, frames);
        for (let i = 0; i < 10; i++) frames.append([i], Uint8Array.of(i), `t${i}`, i);
        view.render();
        container.scrollTop = 80;
        listeners.scroll();
        const topRecord = () => view.spacer.children.find(row => {
            const top = parseInt(row.style.top, 10);
            return top <= container.scrollTop && top + parseInt(row.style.height, 10) > container.scrollTop;
        })?.children[0].textContent;
        assert.equal(topRecord(), '[t4] RX ');

        frames.append([10], Uint8Array.of(10), 't10', 10);
        view.render();
        assert.equal(container.scrollTop, 60);
        assert.equal(topRecord(), '[t4] RX ');
    } finally {
        global.document = oldDocument;
    }
});

test('long Hex records wrap into variable-height rows aligned after the timestamp', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const container = { clientWidth: 120, clientHeight: 100, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; }, addEventListener() {},
            get scrollHeight() { return Math.max(100, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(1, 10);
        frames.append([1], Uint8Array.from({ length: 8 }, (_, i) => i), 't', 1);
        frames.append([2], Uint8Array.of(255), 'u', 2);
        const view = new MonitorView(container, frames);
        view.render();
        const [first, second] = view.spacer.children;
        assert.equal(first.children[0].textContent, '[t] RX ');
        assert.equal(first.children[1].textContent, '00 01\n02 03\n04 05\n06 07');
        assert.equal(first.style.height, '80px');
        assert.equal(second.style.top, '80px');
        assert.equal(view.spacer.style.height, '100px');
        assert.equal(view.currentFrameIndex(), 1, 'follow mode uses latest even with a long row');
        view.followTail = false;
        assert.equal(view.currentFrameIndex(), 0, 'viewport midpoint is inside the wrapped first row');
    } finally {
        global.document = oldDocument;
    }
});

test('log midpoint inside a TX or error record chooses the closest sample row', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children.flatMap(child => child.children || [child]); } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const frames = new FrameBuffer(1, 10);
        frames.append([1], Uint8Array.of(1), 't', 1);
        frames.append([2], Uint8Array.of(2), 'u', 3);
        const container = { clientWidth: 120, clientHeight: 80, scrollTop: 0, children: [],
            replaceChildren(child) { this.children = [child]; }, addEventListener() {},
            get scrollHeight() { return Math.max(80, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const view = new MonitorView(container, frames);
        view.followTail = false;
        view.appendExtra({ order: 2, kind: 'tx', bytes: Uint8Array.of(5, 6, 7, 8), time: 'x' });
        clearTimeout(view.pending);
        assert.equal(view.currentFrameIndex(), 0);
        container.scrollTop = 20;
        assert.equal(view.currentFrameIndex(), 1);
        frames.clear();
        assert.equal(view.currentFrameIndex(), -1);
    } finally { global.document = oldDocument; }
});

test('scrolling slightly upward from the bottom disables tail following until returning to bottom', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const listeners = {};
        const container = { clientWidth: 800, clientHeight: 100, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() { return Math.max(100, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(1, 100);
        const view = new MonitorView(container, frames);
        for (let i = 0; i < 30; i++) frames.append([i], Uint8Array.of(i), `t${i}`, i);
        view.render();
        const bottom = container.scrollTop;
        assert.ok(bottom > 10);

        container.scrollTop = bottom - 10;
        listeners.scroll();
        assert.equal(container.scrollTop, bottom - 10);
        frames.append([30], Uint8Array.of(30), 't30', 30);
        view.render();
        assert.equal(container.scrollTop, bottom - 10);

        container.scrollTop = container.scrollHeight - container.clientHeight;
        listeners.scroll();
        frames.append([31], Uint8Array.of(31), 't31', 31);
        view.render();
        assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
    } finally {
        global.document = oldDocument;
    }
});

test('queued programmatic scroll does not stop numeric-mode tail following', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const listeners = {};
        const container = { clientWidth: 200, clientHeight: 100, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() { return Math.max(100, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(20, 100);
        const view = new MonitorView(container, frames);
        for (let i = 0; i < 20; i++)
            frames.append(Array(20).fill(i), Uint8Array.of(i), `t${i}`, i);
        view.setMode('number');
        const renderedScrollTop = container.scrollTop;
        view.spacer.style.height = `${parseInt(view.spacer.style.height, 10) + 100}px`;
        listeners.scroll();
        assert.equal(view.followTail, true);
        container.scrollTop = renderedScrollTop - 20;
        listeners.scroll();
        assert.equal(view.followTail, false);
    } finally { global.document = oldDocument; }
});

test('large numeric rows scroll upward from the live tail without snapping back', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const listeners = {};
        const container = { clientWidth: 200, clientHeight: 100, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            get scrollHeight() {
                const spacer = this.children[0];
                const childrenBottom = Math.max(0, ...(spacer?.children || []).map(row =>
                    parseInt(row.style.top || '0', 10) + parseInt(row.style.height || '0', 10)));
                return Math.max(100, parseInt(spacer?.style.height || '0', 10),
                    spacer?.style.overflow === 'clip' ? 0 : childrenBottom);
            } };
        const frames = new FrameBuffer(50, 3000);
        for (let i = 0; i < 3000; i++)
            frames.append(Array(50).fill(i), Uint8Array.of(i & 255), `t${i}`, i);
        const view = new MonitorView(container, frames);
        view.setMode('number');
        const bottom = container.scrollTop;
        const newestTop = () => parseInt(view.spacer.children.find(row =>
            row.children[0].textContent === '[t2999] RX ')?.style.top, 10) - container.scrollTop;
        const initialNewestTop = newestTop();
        assert.ok(bottom > 120);
        container.scrollTop = bottom - 120;
        listeners.scroll();
        assert.equal(view.followTail, false);
        assert.ok(Math.abs(container.scrollTop - (bottom - 120)) < 1);
        assert.ok(newestTop() > initialNewestTop,
            'older content should come into view even when the wheel moves less than one row');

        const afterUpTop = newestTop();
        container.scrollTop += 60;
        listeners.scroll();
        assert.ok(newestTop() < afterUpTop,
            `scrolling down should move rows upward: ${afterUpTop} -> ${newestTop()}, ` +
            `scroll ${container.scrollTop}, max ${container.scrollHeight - container.clientHeight}, ` +
            `spacer ${view.spacer.style.height}, mounted ${JSON.stringify(view.spacer.children.map(row =>
                [row.style.top, row.style.height]))}`);

        for (let i = 0; i < 8; i++) {
            container.scrollTop = Math.max(0, container.scrollTop - 120);
            listeners.scroll();
        }
        let previousOrder = view.anchor.order;
        for (let i = 0; i < 8; i++) {
            container.scrollTop = Math.min(container.scrollHeight - container.clientHeight,
                container.scrollTop + 120);
            listeners.scroll();
            assert.ok(view.followTail || view.anchor.order >= previousOrder,
                `scrolling down moved to older frame ${view.anchor.order} from ${previousOrder}`);
            previousOrder = view.anchor?.order ?? previousOrder;
        }

        const selectedOrder = view.anchor.order;
        const visibleLabel = view.spacer.children[0].children[0].textContent;
        const selectedTop = () => parseInt(view.spacer.children.find(row =>
            row.children[0].textContent === visibleLabel)?.style.top, 10) - container.scrollTop;
        const fixedTop = selectedTop();
        frames.append(Array(50).fill(3000), Uint8Array.of(0), 't3000', 3000);
        view.render();
        assert.equal(view.followTail, false);
        assert.equal(view.anchor.order, selectedOrder);
        assert.ok(Math.abs(selectedTop() - fixedTop) < 1,
            `incoming frames should keep selected record fixed: ${fixedTop} -> ${selectedTop()}, ` +
            `anchor ${JSON.stringify(view.anchor)}`);
        container.scrollTop = container.scrollHeight - container.clientHeight;
        listeners.scroll();
        frames.append(Array(50).fill(3001), Uint8Array.of(1), 't3001', 3001);
        view.render();
        listeners.scroll(); // queued programmatic scroll event must not disable live following
        assert.equal(view.followTail, true);
        assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
        assert.match(view.spacer.children.at(-1).children[0].textContent, /t3001/);
    } finally { global.document = oldDocument; }
});

test('monitor time jump centers edge records and large mode renders only nearby rows', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const container = { clientWidth: 800, clientHeight: 200, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; },
            addEventListener() {},
            get scrollHeight() { return Math.max(200, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(1, 20000);
        for (let i = 0; i < 100; i++) frames.append([i], Uint8Array.of(i), `t${i}`, i);
        const view = new MonitorView(container, frames);
        view.render();
        view.jumpToFrame(0);
        assert.ok(Math.abs(parseInt(view.spacer.children[0].style.top, 10) - container.scrollTop - 100) <= 10);
        for (let i = 100; i < 20000; i++) frames.append([i], Uint8Array.of(i & 255), `t${i}`, i);
        let reads = 0;
        const originalFrameAt = frames.frameAt.bind(frames);
        frames.frameAt = index => { reads++; return originalFrameAt(index); };
        view.jumpToFrame(10000);
        assert.ok(view.spacer.children.length < 30);
        assert.ok(reads < 30, `only visible rows should read raw frames, read ${reads}`);
    } finally { global.document = oldDocument; }
});

test('ASCII and decoded display modes retain all bytes and show active cross-frame matches', () => {
    const oldDocument = global.document;
    global.document = {
        createElement: () => ({ style: {}, children: [],
            append(...children) { this.children.push(...children); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) {
                this.children = children.flatMap(child => child.children || [child]);
            } }),
        createDocumentFragment: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    try {
        const container = { clientWidth: 800, clientHeight: 200, scrollTop: 0,
            children: [], replaceChildren(child) { this.children = [child]; }, addEventListener() {},
            get scrollHeight() { return Math.max(200, parseInt(this.children[0]?.style.height || '0', 10)); } };
        const frames = new FrameBuffer(1, 5);
        frames.append([1.5], Uint8Array.of(65, 66), 't1', 1);
        frames.append([2.5], Uint8Array.of(67, 0), 't2', 2);
        const view = new MonitorView(container, frames);
        view.setMode('ascii');
        assert.equal(view.spacer.children[0].children[1].textContent, 'AB');
        assert.equal(view.spacer.children[1].children[1].textContent, 'C·');
        const search = new MonitorSearchSession(frames, parseMonitorSearch('ascii', 'BC'));
        search.step(10);
        view.setSearchResults(search.matches);
        view.selectSearchMatch(0);
        assert.ok(view.spacer.children[0].children[1].children.some(span =>
            span.className === 'monitor-search-current' && span.textContent === 'B'));
        assert.ok(view.spacer.children[1].children[1].children.some(span =>
            span.className === 'monitor-search-current' && span.textContent === 'C'));
        view.setMode('number');
        assert.equal(view.spacer.children[0].children[1].textContent, 'CH01= 1.50000e+0');
        const numeric = new MonitorSearchSession(frames, parseMonitorSearch('number', '1.5', 0, 0));
        numeric.step(10);
        view.setSearchResults(numeric.matches, 0);
        assert.ok(view.spacer.children[0].children[1].children.some(span =>
            span.className === 'monitor-search-current' && span.textContent === 'CH01= 1.50000e+0'));
    } finally { global.document = oldDocument; }
});

test('an incomplete text tail is visibly marked without losing RX indentation', () => {
    const view = Object.create(MonitorView.prototype);
    view.mode = 'hex';
    const row = { kind: 'rx', time: 't', bytes: Uint8Array.of(65), incomplete: true };
    const layout = view._rowLayout(row, 80);
    assert.equal(layout.prefix, '[t] RX[帧未完整] ');
    assert.equal(view._rowLayout({ ...row, incomplete: false }, 80).prefix, '[t] RX ');
});
