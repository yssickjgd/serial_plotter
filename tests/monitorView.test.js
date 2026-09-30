const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { MonitorView, mergeMonitorRows, bytesToHex } = require('../monitorView');

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
