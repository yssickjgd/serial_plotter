const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { MonitorView, mergeMonitorRows, bytesToHex } = require('../monitorView');
const { parseMonitorSearch, MonitorSearchSession } = require('../monitorSearch');

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
    } finally {
        global.document = oldDocument;
    }
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
        assert.equal(view.spacer.children[0].children[1].textContent, 'CH1=1.5');
        const numeric = new MonitorSearchSession(frames, parseMonitorSearch('number', '1.5', 0, 0));
        numeric.step(10);
        view.setSearchResults(numeric.matches, 0);
        assert.ok(view.spacer.children[0].children[1].children.some(span =>
            span.className === 'monitor-search-current' && span.textContent === 'CH1=1.5'));
    } finally { global.document = oldDocument; }
});
