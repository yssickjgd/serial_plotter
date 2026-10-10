const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { FrameBuffer } = require('../frameBuffer');
const { MonitorView } = require('../monitorView');

function target() {
    const listeners = new Map();
    return { listeners, style: {}, children: [], clientWidth: 800, clientHeight: 100,
        offsetHeight: 12, offsetWidth: 40, scrollTop: 0,
        addEventListener(name, fn) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
        },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        dispatch(name, event = {}) { for (const fn of listeners.get(name) ?? []) fn(event); },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children.flatMap(child => child.fragment ? child.children : [child]); },
        contains(node) { return this === node || this.children.some(child => child.contains?.(node)); },
        getBoundingClientRect: () => ({ width: 800, height: 400, top: 0, left: 0 }),
        get scrollHeight() { return Math.max(this.clientHeight, parseInt(this.children[0]?.style.height || '0', 10)); }
    };
}

function fixture() {
    const pending = new Map(), observers = [];
    let id = 0, now = 1000;
    const document = { ...target(), defaultView: target(), createElement: () => target(),
        createDocumentFragment: () => ({ ...target(), fragment: true }),
        getElementById: () => { throw new Error('instance views must not query global IDs'); } };
    const context = vm.createContext({ document, window: document.defaultView,
        performance: { now: () => now }, console,
        requestAnimationFrame: fn => { pending.set(++id, fn); return id; },
        cancelAnimationFrame: key => pending.delete(key),
        ResizeObserver: class { constructor(fn) { this.fn = fn; observers.push(this); }
            observe(target) { this.target = target; } disconnect() { this.disconnected = true; } },
        IntersectionObserver: class { constructor(fn) { this.fn = fn; observers.push(this); }
            observe(target) { this.target = target; } disconnect() { this.disconnected = true; } }
    });
    for (const file of ['projectLimits', 'frameBuffer', 'plotMath', 'channelTransform', 'spectrum', 'plotter'])
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
    const canvas = () => ({ ...target(), ownerDocument: document, parentElement: target(),
        getContext: () => new Proxy({}, { get: (_, key) => key === 'measureText'
            ? () => ({ width: 50 }) : () => {} }) });
    const plot = frames => new context.SerialPlotter.Plotter(canvas(), frames, { viewOnly: true,
        elements: { scrollWrap: target(), scrollThumb: target(), yScrollWrap: target(), yScrollThumb: target() } });
    return { document, context, pending, observers, plot,
        flush() { now += 120; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn(now)); } };
}

test('multiple view-only plots never append, resize or clear their shared source', () => {
    const f = fixture(), frames = new FrameBuffer(1, 100);
    frames.append([7], Uint8Array.of(7), 't', 1);
    const a = f.plot(frames), b = f.plot(frames), version = frames.version;
    a.setChannelCount(2);
    a.setMaxPoints(50);
    a.addFrame([8], Uint8Array.of(8));
    a.clear();
    assert.equal(frames.version, version);
    assert.equal(frames.length, 1);
    assert.equal(frames.channelCount, 1);
    assert.equal(frames.capacity, 100);
    assert.equal(a.channels.length, 2);
    assert.equal(b.frames.getValue(0, 0), 7);
    a.dispose(); b.dispose();
});

test('plot schedules only dirty visible work and removes its own listeners on disposal', () => {
    const f = fixture(), frames = new FrameBuffer(1, 100), a = f.plot(frames), b = f.plot(frames);
    a.setChannelCount(1); b.setChannelCount(1);
    f.flush();
    assert.equal(f.pending.size, 0, 'unchanged plots must not run endless RAF loops');
    a.setVisible(false);
    frames.append([1], Uint8Array.of(1), 't', 1);
    a.onDataChanged(); b.onDataChanged();
    assert.equal(f.pending.size, 1);
    const hiddenDraws = a.completedDraws;
    f.flush();
    assert.equal(a.completedDraws, hiddenDraws);
    a.setVisible(true);
    f.flush();
    assert.ok(a.completedDraws > hiddenDraws);
    a.onDataChanged(); b.onDataChanged();
    a.dispose(); a.dispose();
    assert.equal(f.pending.size, 1, 'disposing one plot preserves the other plot task');
    assert.equal([...a.canvas.listeners.values()].flatMap(set => [...set]).length, 0);
    const bDraws = b.completedDraws;
    f.flush();
    assert.ok(b.completedDraws > bDraws);
    b.dispose();
    assert.equal(f.pending.size, 0);
    assert.ok(f.observers.every(observer => observer.disconnected));
    assert.equal(frames.length, 1);
});

test('plot references the retained time viewport in both display modes after source replacement', () => {
    const f = fixture(), frames = new FrameBuffer(1, 10), plot = f.plot(frames);
    for (let i = 0; i < 10; i++) frames.append([i], Uint8Array.of(i, i), 't', i + 1);
    assert.equal(plot.getReferenceByteOffset(), 18);
    plot.vp.time.displayCount = 4;
    plot.jumpToFrame(3);
    plot.setDisplayOptions({ displayMode: 'frequency' });
    assert.equal(plot.getReferenceByteOffset(), 6);
    const replacement = new FrameBuffer(1, 10);
    replacement.append([50], Uint8Array.of(5), 't', 100, 10, { rawByteOffset: 400 });
    plot.setFrames(replacement);
    assert.equal(plot.frames, replacement);
    assert.equal(plot.getReferenceByteOffset(), replacement.rawByteOffsetAt(0));
    assert.equal(frames.length, 10);
    plot.dispose();
});

test('right-click in frequency mode restores the latest reference and clears historical time zoom', () => {
    const f = fixture(), frames = new FrameBuffer(1, 100), plot = f.plot(frames);
    for (let i = 0; i < 100; i++) frames.append([i], Uint8Array.of(i, i), 't', i + 1);
    plot.setPlotWindowPoints(50);
    plot.vp.time.displayCount = 20; plot.jumpToFrame(15);
    plot._boxZoomY.time = { min: 1, max: 2 };
    plot.setDisplayOptions({ displayMode: 'frequency' });
    plot._boxZoomY.frequency = { min: 0.1, max: 0.5 };
    assert.equal(plot.getReferenceByteOffset(), 30);
    plot.canvas.dispatch('contextmenu', { preventDefault() {} });
    assert.equal(plot.getReferenceByteOffset(), 198);
    assert.equal(plot.vp.time.displayCount, 50);
    assert.equal(plot.vp.time.scrollOffset, 50);
    assert.equal(plot.vp.time.autoFollow, true);
    assert.equal(plot._boxZoomY.time, null);
    assert.equal(plot._boxZoomY.frequency, null);
    plot.dispose();
});

test('monitor uses its owner document, cancels hidden work and tears down independently', () => {
    const f = fixture(), previous = global.document;
    global.document = { createElement() { throw new Error('wrong document'); } };
    try {
        const frames = new FrameBuffer(1, 20), containerA = target(), containerB = target();
        containerA.ownerDocument = containerB.ownerDocument = f.document;
        const a = new MonitorView(containerA, frames), b = new MonitorView(containerB, frames);
        a.setVisible(false);
        a.appendFrame();
        assert.equal(a.pending, null);
        b.appendFrame();
        assert.notEqual(b.pending, null);
        a.dispose(); a.dispose();
        assert.equal([...containerA.listeners.values()].flatMap(set => [...set]).length, 0);
        assert.equal(f.document.listeners.get('selectionchange').size, 1);
        b.dispose();
        assert.equal(b.pending, null);
        assert.equal(f.document.listeners.get('selectionchange').size, 0);
    } finally { global.document = previous; }
});

test('monitor source replacement cancels stale text preparation without clearing shared samples', async () => {
    const f = fixture(), container = target(); container.ownerDocument = f.document;
    const old = global.document; global.document = f.document;
    try {
        const frames = new FrameBuffer(1, 10), replacement = new FrameBuffer(1, 10);
        frames.append([0], new Uint8Array(70000).fill(65), 't', 1);
        replacement.append([0], Uint8Array.of(66), 't', 2);
        const view = new MonitorView(container, frames);
        let release;
        const work = view.prepareText(frames, 'utf-8', { yieldControl: () => new Promise(resolve => { release = resolve; }) });
        assert.equal(typeof release, 'function');
        view.setFrames(replacement);
        release();
        assert.equal(await work, null);
        assert.equal(view.frames, replacement);
        assert.equal(frames.length, 1);
        assert.equal(view.getReferenceByteOffset(), replacement.rawByteOffsetAt(0));
        view.dispose();
    } finally { global.document = old; }
});

test('byte navigation centers within a long Hex or text record and rejects missing bytes', () => {
    const f = fixture(), container = target(); container.ownerDocument = f.document;
    const frames = new FrameBuffer(1, 10);
    frames.append([0], new Uint8Array(1000).fill(65), 't', 1);
    const view = new MonitorView(container, frames);
    view.charWidth = 8;
    view.setDisplayOptions({ timestamp: 'none', showDirection: false, hexBytesPerLine: 8 });
    assert.equal(view.jumpToByteOffset(403), true);
    assert.equal(view.getReferenceByteOffset(), 400);
    assert.equal(view.followTail, false);
    assert.equal(view.cursorByteOffset, 403);
    const scroll = container.scrollTop;
    assert.equal(view.jumpToByteOffset(1000), false);
    assert.equal(view.jumpToByteOffset(-1), false);
    assert.equal(container.scrollTop, scroll);
    container.clientWidth = 100;
    view.setMode('text');
    assert.equal(view.jumpToByteOffset(403), true);
    assert.equal(view.getReferenceByteOffset(), 400);
    assert.ok(container.scrollTop > 700, 'the middle of the long record is visible');
    view.dispose();
});

test('shared decoded tokens stay isolated by source and survive another monitor disposal', () => {
    const f = fixture(), source = new FrameBuffer(1, 10), other = new FrameBuffer(1, 10);
    source.append([0], Uint8Array.of(65), 't', 1);
    other.append([0], Uint8Array.of(66), 't', 1);
    const cache = new WeakMap();
    const make = frames => {
        const container = target(); container.ownerDocument = f.document;
        return new MonitorView(container, frames, { decodeCache: cache });
    };
    const a = make(source), b = make(source), c = make(other);
    const tokens = view => view._textTokens({ ...view.frames.frameAt(0), frameIndex: 0 });
    assert.equal(tokens(a), tokens(b));
    assert.equal(tokens(c)[0].text, 'B');
    const shared = tokens(b);
    a.dispose();
    assert.equal(tokens(b), shared);
    b.dispose(); c.dispose();
});

test('empty frequency plots stop scheduling and offscreen plots defer data draws', () => {
    const f = fixture(), frames = new FrameBuffer(1, 100), plot = f.plot(frames);
    plot.setChannelCount(1);
    plot.setDisplayOptions({ displayMode: 'frequency' });
    f.flush();
    assert.equal(f.pending.size, 0, 'an empty spectrum cannot produce a later FFT');
    const intersection = f.observers.find(observer => observer.target === plot.canvas);
    intersection.fn([{ isIntersecting: false }]);
    frames.append([1], Uint8Array.of(1), 't', 1);
    plot.onDataChanged();
    assert.equal(f.pending.size, 0);
    const draws = plot.completedDraws;
    plot.draw();
    assert.equal(plot.completedDraws, draws);
    intersection.fn([{ isIntersecting: true }]);
    f.flush();
    assert.ok(plot.completedDraws > draws);
    plot.dispose();
});

test('view-only plot eviction preserves the selected samples despite noncontiguous record orders', () => {
    const f = fixture(), frames = new FrameBuffer(1, 10), plot = f.plot(frames);
    for (let i = 0; i < 10; i++) frames.append([i], Uint8Array.of(i), 't', i * 10);
    plot.setChannelCount(1);
    plot.vp.time.displayCount = 2;
    plot.vp.time.scrollOffset = 5;
    plot.vp.time.autoFollow = false;
    plot.draw();
    frames.append([10], Uint8Array.of(10), 't', 100);
    plot.onDataChanged();
    assert.equal(plot.vp.time.scrollOffset, 4);
    assert.equal(plot.frames.orderAt(plot.vp.time.scrollOffset), 50);
    plot.dispose();
});

test('prepared multibyte text navigation maps visual lines to original byte positions', async () => {
    const f = fixture(), container = target(); container.ownerDocument = f.document;
    container.clientWidth = 100;
    const frames = new FrameBuffer(1, 10);
    frames.append([0], Buffer.from('\u{1f642}'.repeat(17000)), 't', 1);
    const view = new MonitorView(container, frames);
    view.charWidth = 8;
    view.setDisplayOptions({ timestamp: 'none', showDirection: false }, { deferRender: true });
    view.setMode('text', { deferRender: true });
    view.installPreparedText(await view.prepareText(frames, 'utf-8', { yieldControl: async () => {} }));
    assert.equal(view.jumpToByteOffset(40003), true);
    assert.equal(view.getReferenceByteOffset(), 40000);
    assert.ok(view.spacer.children.length < 10);
    view.dispose();
});

test('disposing a monitor cancels and settles pending local text preparation', async () => {
    const f = fixture(), container = target(); container.ownerDocument = f.document;
    const frames = new FrameBuffer(1, 10);
    frames.append([0], new Uint8Array(70000).fill(65), 't', 1);
    const view = new MonitorView(container, frames);
    const pending = view.prepareText(frames, 'utf-8');
    assert.equal(view._yieldTasks.size, 1);
    view.dispose();
    assert.equal(view._yieldTasks.size, 0);
    assert.equal(await pending, null);
    assert.equal(frames.length, 1);
});
