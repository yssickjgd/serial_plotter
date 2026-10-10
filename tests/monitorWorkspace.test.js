const test = require('node:test');
const assert = require('node:assert/strict');
const { fitWorkspaceRect, moveWorkspaceRect, resizeWorkspaceRect,
    defaultWorkspaceRects, MonitorWorkspace } = require('../monitorWorkspace');

const bounds = { width: 800, height: 600 };
const minimum = { width: 200, height: 120 };
const rect = { x: 100, y: 100, width: 400, height: 300 };

test('moving a monitor clamps every edge within the workspace', () => {
    assert.deepEqual(moveWorkspaceRect(rect, 900, -900, bounds, minimum),
        { x: 400, y: 0, width: 400, height: 300 });
    assert.deepEqual(moveWorkspaceRect(rect, -900, 900, bounds, minimum),
        { x: 0, y: 300, width: 400, height: 300 });
    assert.deepEqual(rect, { x: 100, y: 100, width: 400, height: 300 });
});

test('resizing each monitor edge keeps its opposite edge anchored', () => {
    for (const [direction, dx, dy, expected] of [
        ['e', 900, 0, { x: 100, y: 100, width: 700, height: 300 }],
        ['w', -900, 0, { x: 0, y: 100, width: 500, height: 300 }],
        ['n', 0, -900, { x: 100, y: 0, width: 400, height: 400 }],
        ['s', 0, 900, { x: 100, y: 100, width: 400, height: 500 }],
        ['nw', 900, 900, { x: 300, y: 280, width: 200, height: 120 }],
        ['ne', -900, 900, { x: 100, y: 280, width: 200, height: 120 }],
        ['sw', 900, -900, { x: 300, y: 100, width: 200, height: 120 }],
        ['se', -900, -900, { x: 100, y: 100, width: 200, height: 120 }]
    ]) assert.deepEqual(resizeWorkspaceRect(rect, direction, dx, dy, bounds, minimum), expected, direction);
});

test('fitting restored geometry respects viewport limits and minimum readable sizes', () => {
    assert.deepEqual(fitWorkspaceRect({ x: 700, y: -10, width: 50, height: 900 }, bounds, minimum),
        { x: 600, y: 0, width: 200, height: 600 });
    assert.deepEqual(fitWorkspaceRect(rect, { width: 100, height: 80 }, minimum),
        { x: 0, y: 0, width: 100, height: 80 });
});

test('default layout stacks monitors and reserves the byte monitor minimum height', () => {
    const minima = { wave: { width: 280, height: 180 }, byte: { width: 320, height: 260 } };
    assert.deepEqual(defaultWorkspaceRects(bounds, minima, true), {
        wave: { x: 0, y: 0, width: 800, height: 330 },
        byte: { x: 0, y: 340, width: 800, height: 260 }
    });
    assert.deepEqual(defaultWorkspaceRects(bounds, minima, false), {
        byte: { x: 0, y: 0, width: 800, height: 600 }
    });
});

function fixture(saved = null, initialByteHeight = null, onActivate = () => {}) {
    function element() {
        const listeners = {}, classes = new Set();
        return { style: {}, children: [], clientWidth: 800, clientHeight: 600,
            classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
            setAttribute() {}, appendChild(child) { this.children.push(child); },
            addEventListener(name, callback) { (listeners[name] ??= []).push(callback); },
            setPointerCapture() {}, releasePointerCapture() {},
            fire(name, properties = {}) {
                const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0,
                    preventDefault() {}, target: this, ...properties };
                for (const callback of listeners[name] ?? []) callback(event);
            }
        };
    }
    const viewport = element(), surface = element(), wave = element(), byte = element();
    const waveHandle = element(), byteHandle = element();
    const values = new Map(saved ? [['serialplot_v3_workspace', JSON.stringify(saved)]] : []);
    const document = { createElement: element, body: { style: {} } };
    const window = { addEventListener() {} };
    let notifications = 0;
    const workspace = new MonitorWorkspace({ viewport, surface, document, window,
        storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
        panels: [
            { id: 'wave', element: wave, handle: waveHandle, label: '波形监视台',
                minimum: () => ({ width: 280, height: 180 }) },
            { id: 'byte', element: byte, handle: byteHandle, label: '字节流监视台',
                minimum: () => ({ width: 320, height: initialByteHeight && !byte.style.width ? initialByteHeight : 260 }) }
        ], onResize: () => notifications++, onActivate });
    return { workspace, viewport, surface, wave, byte, waveHandle, byteHandle, values,
        notifications: () => notifications };
}

test('dragging a resized monitor saves its placement and restores it after reload', () => {
    const f = fixture();
    const corner = f.wave.children.find(child => child.dataset?.direction === 'se');
    corner.fire('pointerdown');
    corner.fire('pointermove', { clientX: -400, clientY: -130 });
    corner.fire('pointerup');
    f.waveHandle.fire('pointerdown', { clientX: 100, clientY: 50 });
    f.waveHandle.fire('pointermove', { clientX: 400, clientY: 130 });
    f.waveHandle.fire('pointerup');
    assert.equal(f.wave.style.left, '300px');
    assert.equal(f.wave.style.top, '80px');
    const restored = fixture(JSON.parse(f.values.get('serialplot_v3_workspace')));
    assert.equal(restored.wave.style.left, '300px');
    assert.equal(restored.wave.style.top, '80px');
    assert.equal(restored.wave.style.height, '200px');
});

test('resized floating panels retain placement when capture mode hides and restores waveform', () => {
    const f = fixture();
    const corner = f.wave.children.find(child => child.dataset?.direction === 'se');
    assert.ok(corner, 'corner resize handle exists');
    corner.fire('pointerdown');
    corner.fire('pointermove', { clientX: -200, clientY: -50 });
    corner.fire('pointerup');
    assert.equal(f.wave.style.width, '600px');
    assert.equal(f.wave.style.height, '280px');
    f.workspace.setWaveformVisible(false);
    assert.equal(f.wave.hidden, true);
    assert.equal(f.byte.style.top, '0px');
    assert.equal(f.byte.style.height, '600px');
    f.workspace.setWaveformVisible(true);
    assert.equal(f.wave.hidden, false);
    assert.equal(f.wave.style.width, '600px');
    assert.equal(f.wave.style.height, '280px');
    f.workspace.reset();
    assert.equal(f.wave.style.width, '800px');
    assert.equal(f.wave.style.height, '330px');
});

test('cancelled dragging restores geometry without saving a partial layout', () => {
    const f = fixture();
    f.waveHandle.fire('pointerdown');
    f.waveHandle.fire('pointermove', { clientX: 0, clientY: 100 });
    assert.equal(f.wave.style.top, '10px', 'movement stops at the other monitor edge');
    f.waveHandle.fire('pointercancel');
    assert.equal(f.wave.style.top, '0px');
    assert.equal(f.values.has('serialplot_v3_workspace'), false);
});

test('workspace resizing scales saved placement and keeps both monitors reachable', () => {
    const f = fixture();
    const corner = f.wave.children.find(child => child.dataset?.direction === 'se');
    corner.fire('pointerdown');
    corner.fire('pointermove', { clientX: -200, clientY: -50 });
    corner.fire('pointerup');
    f.viewport.clientWidth = 400;
    f.workspace.refresh();
    assert.equal(f.wave.style.width, '300px');
    assert.equal(f.byte.style.width, '400px');
    f.viewport.clientHeight = 180;
    f.workspace.refresh();
    assert.ok(parseFloat(f.surface.style.height) >= 450, 'short viewports can scroll through readable panels');
    assert.ok(parseFloat(f.byte.style.top) + parseFloat(f.byte.style.height) <= parseFloat(f.surface.style.height));
});

test('invalid saved layouts use the default readable layout', () => {
    for (const saved of [{ version: 8 }, { version: 1, layouts: { both: { width: -1 } } }]) {
        const f = fixture(saved);
        assert.equal(f.wave.style.height, '330px');
        assert.equal(f.byte.style.top, '340px');
    }
});

test('moving panels keeps grid gaps near peers and resolves actual collisions without overlap', () => {
    const peer = { x: 400, y: 100, width: 300, height: 200 };
    const start = { x: 0, y: 100, width: 200, height: 200 };
    const options = { step: 10, obstacles: [peer] };
    assert.deepEqual(moveWorkspaceRect(start, 192, 0, bounds, minimum, options),
        { x: 190, y: 100, width: 200, height: 200 });
    assert.deepEqual(moveWorkspaceRect(start, 250, 0, bounds, minimum, options),
        { x: 200, y: 100, width: 200, height: 200 });
    assert.deepEqual(resizeWorkspaceRect(start, 'e', 350, 0, bounds, minimum, options),
        { x: 0, y: 100, width: 400, height: 200 });
});

test('monitor dimensions and coordinates follow the chosen alignment step', () => {
    assert.deepEqual(resizeWorkspaceRect(rect, 'se', 13, 27, bounds, minimum, { step: 20 }),
        { x: 100, y: 100, width: 420, height: 320 });
    const f = fixture();
    f.workspace.setStep(20);
    assert.equal(parseFloat(f.wave.style.height) % 20, 0);
    assert.equal(parseFloat(f.byte.style.top) % 20, 0);
    const stored = JSON.parse(f.values.get('serialplot_v3_workspace'));
    assert.equal(stored.step, 20);
});

test('shrinking away from a touching peer preserves the first and second grid steps on every edge', () => {
    const start = { x: 320, y: 320, width: 320, height: 320 };
    const area = { width: 1200, height: 1200 }, min = { width: 100, height: 100 };
    for (const step of [10, 20, 40]) {
        for (const [direction, peer, dx, dy] of [
            ['n', { x: 320, y: 0, width: 320, height: 320 }, 0, 1],
            ['s', { x: 320, y: 640, width: 320, height: 320 }, 0, -1],
            ['w', { x: 0, y: 320, width: 320, height: 320 }, 1, 0],
            ['e', { x: 640, y: 320, width: 320, height: 320 }, -1, 0]
        ]) {
            for (const count of [1, 2]) {
                const delta = count * step;
                const result = resizeWorkspaceRect(start, direction, dx * delta, dy * delta, area, min,
                    { step, obstacles: [peer] });
                assert.deepEqual(result, {
                    x: start.x + (direction === 'w' ? delta : 0),
                    y: start.y + (direction === 'n' ? delta : 0),
                    width: start.width - (dx ? delta : 0), height: start.height - (dy ? delta : 0)
                }, `${direction}, step ${step}, change ${count}`);
            }
        }
    }
});

test('leaving a touching edge retains grid thresholds and returning keeps the final grid gap', () => {
    const start = { x: 0, y: 300, width: 640, height: 300 };
    const peer = { x: 0, y: 0, width: 640, height: 300 };
    const area = { width: 1000, height: 1000 };
    const options = { step: 10, obstacles: [peer] };
    for (const [dy, top] of [[4, 300], [5, 310], [14, 310], [15, 320], [25, 330]]) {
        const result = resizeWorkspaceRect(start, 'n', 0, dy, area, minimum, options);
        assert.equal(result.y, top, `pointer delta ${dy}`);
        assert.equal(result.y + result.height, 600, 'opposite edge stays fixed');
    }
    assert.equal(resizeWorkspaceRect(start, 'n', 0, -10, area, minimum, options).y, 300);
    const detached = { ...start, y: 320, height: 280 };
    assert.equal(resizeWorkspaceRect(detached, 'n', 0, -10, area, minimum, options).y, 310,
        'a one-step gap remains until the pointer reaches the touching grid position');
});

test('nearby peer edges do not alter any valid grid position during moving and resizing', () => {
    const area = { width: 1200, height: 1200 }, min = { width: 100, height: 100 };
    const start = { x: 300, y: 300, width: 300, height: 300 };
    for (const [direction, peer, dx, dy, expected] of [
        ['n', { x: 300, y: 0, width: 300, height: 280 }, 0, -10, { ...start, y: 290, height: 310 }],
        ['s', { x: 300, y: 620, width: 300, height: 300 }, 0, 10, { ...start, height: 310 }],
        ['w', { x: 0, y: 300, width: 280, height: 300 }, -10, 0, { ...start, x: 290, width: 310 }],
        ['e', { x: 620, y: 300, width: 300, height: 300 }, 10, 0, { ...start, width: 310 }]
    ]) {
        assert.deepEqual(resizeWorkspaceRect(start, direction, dx, dy, area, min, { obstacles: [peer] }), expected);
        assert.deepEqual(moveWorkspaceRect(start, dx, dy, area, min, { obstacles: [peer] }),
            { ...start, x: start.x + dx, y: start.y + dy });
    }
});

test('corner resizing can leave both original edges and still respects the minimum size', () => {
    const start = { x: 0, y: 300, width: 640, height: 300 };
    const options = { step: 10, obstacles: [{ x: 0, y: 0, width: 640, height: 300 }] };
    const area = { width: 1000, height: 1000 };
    assert.deepEqual(resizeWorkspaceRect(start, 'nw', 10, 10, area, minimum, options),
        { x: 10, y: 310, width: 630, height: 290 });
    assert.deepEqual(resizeWorkspaceRect(start, 'nw', 1000, 1000, area, minimum, options),
        { x: 440, y: 480, width: 200, height: 120 });
});

test('restoring a layout measures toolbar wrapping at the saved panel width', () => {
    const saved = { version: 1, step: 10, layouts: { both: { width: 800, height: 600, rects: {
        wave: { x: 100, y: 80, width: 400, height: 200 },
        byte: { x: 0, y: 340, width: 800, height: 260 }
    } } } };
    const f = fixture(saved, 500);
    assert.equal(f.wave.style.left, '100px');
    assert.equal(f.wave.style.top, '80px');
    assert.equal(f.wave.style.width, '400px');
    assert.equal(f.wave.style.height, '200px');
    assert.equal(f.byte.style.top, '340px');
});

test('header height changes refresh renderers even when panel geometry stays the same', () => {
    const f = fixture();
    const before = f.notifications();
    const height = f.wave.style.height;
    f.workspace.refresh({ contentChanged: true });
    assert.equal(f.wave.style.height, height);
    assert.ok(f.notifications() > before, 'canvas and logs must remeasure their remaining content area');
});

test('monitor activation reports pointer and keyboard focus changes once', () => {
    const activations = [];
    const f = fixture(null, null, id => activations.push(id));
    f.wave.fire('pointerdown');
    f.wave.fire('pointerdown');
    f.byte.fire('pointerdown', { button: 2 });
    f.waveHandle.fire('keydown', { key: 'ArrowRight' });
    assert.deepEqual(activations, ['wave', 'byte', 'wave']);
    assert.equal(f.workspace.activePanel, 'wave');
});

test('hiding an active waveform selects the byte monitor and ignores hidden panel activation', () => {
    const activations = [];
    const f = fixture(null, null, id => activations.push(id));
    f.wave.fire('pointerdown');
    f.workspace.setWaveformVisible(false);
    f.wave.fire('pointerdown');
    assert.deepEqual(activations, ['wave', 'byte']);
    assert.equal(f.workspace.activePanel, 'byte');
    f.workspace.setWaveformVisible(true);
    assert.equal(f.workspace.activePanel, 'byte', 'restoring a monitor does not steal active context');
});
