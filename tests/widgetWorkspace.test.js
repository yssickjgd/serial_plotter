const test = require('node:test');
const assert = require('node:assert/strict');
const { WidgetWorkspace } = require('../widgetWorkspace');

function element() {
    const listeners = new Map(), classes = new Set();
    return { style: {}, dataset: {}, children: [], clientWidth: 800, clientHeight: 600,
        scrollLeft: 0, scrollTop: 0, parentNode: null,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name),
            contains: name => classes.has(name) },
        setAttribute() {}, closest() { return null; },
        getBoundingClientRect() { return { left: 100, top: 50, right: 900, bottom: 650 }; },
        appendChild(child) { child.parentNode = this; this.children.push(child); },
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); },
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        setPointerCapture() {}, releasePointerCapture() {},
        fire(name, props = {}) {
            const event = { button: 0, pointerId: 1, clientX: 100, clientY: 50,
                target: this, preventDefault() {}, ...props };
            for (const fn of [...(listeners.get(name) ?? [])]) fn(event);
        }
    };
}
function fixture(options = {}) {
    const viewport = element(), surface = element(), document = element(), window = element();
    document.body = element(); document.createElement = element;
    const workspace = new WidgetWorkspace({ viewport, surface, document, window, ...options });
    const add = (id, options = {}) => workspace.add({ id, type: 'waveform', title: id,
        element: element(), handle: element(), ...options });
    return { workspace, viewport, surface, document, window, add };
}
function assertSeparate(workspace) {
    const rects = Object.values(workspace.serialize().rects);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x ||
            a.y + a.height <= b.y || b.y + b.height <= a.y, `${i} overlaps ${j}`);
    }
}

test('first widget sizes and library previews are grid multiples for every alignment step', () => {
    for (const step of [10, 20, 40]) {
        const f = fixture({ step });
        const first = f.add('first');
        assert.equal(first.rect.width % step, 0);
        assert.equal(first.rect.height % step, 0);
        f.workspace.beginLibraryDrag('byte', { button: 0, pointerId: 1, clientX: 150, clientY: 400, preventDefault() {} });
        assert.equal(f.workspace.gesture.dropRect.width % step, 0);
        assert.equal(f.workspace.gesture.dropRect.height % step, 0);
        f.workspace.dispose();
    }
});

test('new widgets inherit the latest activated matching size, including when another type is active', () => {
    const f = fixture();
    const first = f.add('first', { rect: { x: 0, y: 0, width: 420, height: 240 } });
    f.workspace.activate(first.id);
    const second = f.add('second', { rect: { x: 440, y: 0, width: 350, height: 280 } });
    f.workspace.activate(second.id);
    f.workspace.activate(first.id);
    const byte = f.add('byte', { type: 'byte', rect: { x: 0, y: 300, width: 640, height: 300 } });
    f.workspace.activate(byte.id);
    const third = f.add('third');
    assert.equal(third.rect.width, 420);
    assert.equal(third.rect.height, 240);
    f.workspace.remove(first.id);
    const fourth = f.add('fourth');
    assert.equal(fourth.rect.width, 350, 'deletion falls back to the latest activated surviving peer');
    assert.equal(fourth.rect.height, 280);
    assertSeparate(f.workspace);
});

test('inherited sizes use current logical dimensions and remain wider than a narrowed viewport', () => {
    const f = fixture();
    const first = f.add('first');
    f.workspace.activate(first.id);
    f.workspace._apply(first, { x: 0, y: 0, width: 900, height: 360 });
    f.viewport.clientWidth = 400; f.workspace.setZoom(2);
    const second = f.add('second');
    assert.equal(second.rect.width, 900);
    assert.equal(second.rect.height, 360);
    assertSeparate(f.workspace);
    const explicit = f.add('explicit', { rect: { x: 0, y: 900, width: 320, height: 200 } });
    assert.equal(explicit.rect.width, 320, 'saved or explicit dimensions take priority');
    assert.equal(explicit.rect.height, 200);
    f.workspace.remove(first.id); f.workspace.remove(second.id); f.workspace.remove(explicit.id);
    f.viewport.clientWidth = 800; f.workspace.setZoom(1);
    const fresh = f.add('fresh');
    assert.equal(fresh.rect.width, 640);
    assert.equal(fresh.rect.height, 300);
});

test('library drag previews and drops the matching inherited size without clipping it to viewport width', () => {
    const drops = [], f = fixture({ onDrop: value => drops.push(value) });
    const first = f.add('first', { type: 'byte', rect: { x: 0, y: 0, width: 920, height: 260 } });
    f.workspace.activate(first.id);
    const other = f.add('wave'); f.workspace.activate(other.id);
    f.workspace.beginLibraryDrag('byte', { button: 0, pointerId: 1, clientX: 120, clientY: 400, preventDefault() {} });
    assert.equal(f.workspace.gesture.preview.style.width, '920px');
    assert.equal(f.workspace.gesture.preview.style.height, '260px');
    f.document.fire('pointerup', { clientX: 120, clientY: 400 });
    assert.equal(drops.length, 1);
    assert.equal(drops[0].rect.width, 920);
    assert.equal(drops[0].rect.height, 260);
});

test('blank workspace clears selection while widget descendants and drag previews preserve it', () => {
    const activations = [];
    const f = fixture({ onActivate: id => activations.push(id) });
    const entry = f.add('a'); entry.element.fire('pointerdown');
    f.surface.fire('pointerdown', { target: { closest: () => entry.element } });
    assert.equal(f.workspace.activeId, 'a');
    f.surface.fire('pointerdown');
    assert.equal(f.workspace.activeId, null);
    f.document.fire('pointerup');
    entry.element.fire('pointerdown'); f.viewport.fire('pointerdown');
    assert.equal(f.workspace.activeId, null);
    f.document.fire('pointerup');
    assert.deepEqual(activations, ['a', null, 'a', null]);
    entry.element.fire('pointerdown');
    f.workspace.beginLibraryDrag('byte', { button: 0, pointerId: 1, clientX: 160, clientY: 400, preventDefault() {} });
    f.surface.fire('pointerdown');
    assert.equal(f.workspace.activeId, 'a');
    f.workspace.dispose();
});

test('a log row replaced during activation is still a widget click rather than blank workspace', () => {
    const f = fixture();
    const entry = f.add('byte');
    entry.element.fire('pointerdown');
    // Native propagation keeps its original path even after an inspector update detaches the target.
    const target = { closest: () => null };
    const composedPath = () => [target, entry.element, f.surface, f.viewport];
    f.surface.fire('pointerdown', { target, composedPath });
    f.viewport.fire('pointerdown', { target, composedPath });
    assert.equal(f.workspace.activeId, 'byte');
    f.surface.fire('pointerdown', { composedPath: () => [f.surface, f.viewport] });
    assert.equal(f.workspace.activeId, null);
    f.workspace.dispose();
});

test('multiple widgets get stable identity and expand the scroll surface without overlapping', () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.add(`wave-${i}`);
    assert.equal(f.workspace.entries.size, 5);
    assert.deepEqual(f.workspace.getRect('wave-0'), { x: 0, y: 0, width: 640, height: 300 });
    assert.ok(parseFloat(f.surface.style.height) >= 1540);
    assert.equal(f.viewport.style.overflow, 'auto');
    assertSeparate(f.workspace);
    assert.throws(() => f.add('wave-0'));
});

test('restore rejects overlap in any pair atomically and accepts an empty workspace', () => {
    const f = fixture();
    for (const id of ['a', 'b', 'c']) f.add(id);
    const before = f.workspace.serialize();
    const bad = structuredClone(before);
    bad.rects.c = { ...bad.rects.b };
    assert.equal(f.workspace.restore(bad), false);
    assert.deepEqual(f.workspace.serialize(), before);
    bad.rects.c = { ...before.rects.c, width: NaN };
    assert.equal(f.workspace.restore(bad), false);
    assert.equal(f.workspace.restore(before), true);
    for (const id of ['a', 'b', 'c']) f.workspace.remove(id);
    assert.equal(f.workspace.restore({ step: 20, rects: {} }), true);
    assert.deepEqual(f.workspace.serialize(), { step: 20, zoom: 1, rects: {} });
});

test('viewport narrowing and step changes preserve widget widths on a horizontally scrollable surface', () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) f.add(`w-${i}`);
    f.viewport.clientWidth = 220;
    f.viewport.clientHeight = 90;
    f.workspace.refresh();
    f.workspace.setStep(40);
    assert.equal(f.workspace.entries.size, 8);
    for (const rect of Object.values(f.workspace.serialize().rects)) {
        assert.equal(rect.width, 640);
        assert.ok(rect.height >= 180);
        assert.equal(rect.x % 40, 0);
        assert.equal(rect.y % 40, 0);
        assert.ok(rect.y + rect.height <= parseFloat(f.surface.style.height));
    }
    assertSeparate(f.workspace);
    assert.ok(parseFloat(f.surface.style.width) > f.viewport.clientWidth);
    f.workspace.reset();
    assert.equal(f.workspace.entries.size, 8);
    assertSeparate(f.workspace);
});

test('title drag is scoped and Escape restores the original rectangle', () => {
    const f = fixture();
    const entry = f.add('a');
    const before = f.workspace.getRect('a');
    entry.element.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 200, clientY: 150 });
    assert.deepEqual(f.workspace.getRect('a'), before, 'content is not a move handle');
    entry.handle.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 200, clientY: 150 });
    assert.equal(f.workspace.getRect('a').x, 100);
    assert.equal(f.workspace.getRect('a').y, 100);
    f.document.fire('keydown', { key: 'Escape' });
    assert.deepEqual(f.workspace.getRect('a'), before);
    entry.handle.fire('pointerdown', { target: { closest: () => ({}) } });
    f.document.fire('pointermove', { clientX: 200, clientY: 150 });
    assert.deepEqual(f.workspace.getRect('a'), before, 'buttons in title do not move widget');
});

test('resize stops at peer collisions and focus activation, removal and disposal tear down listeners', () => {
    const activations = [], deleted = [];
    const f = fixture({ onActivate: id => activations.push(id), onDelete: id => deleted.push(id) });
    const a = f.add('a', { rect: { x: 0, y: 0, width: 300, height: 300 } });
    f.add('b', { rect: { x: 400, y: 0, width: 300, height: 300 } });
    const edge = a.element.children.find(c => c.dataset.direction === 'e');
    edge.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 500 });
    f.document.fire('pointerup');
    assert.equal(f.workspace.getRect('a').width, 400);
    assertSeparate(f.workspace);
    a.element.fire('focusin');
    assert.equal(f.workspace.activeId, 'a');
    a.handle.fire('keydown', { key: 'Delete' });
    assert.deepEqual(deleted, ['a']);
    f.workspace.remove('a');
    a.handle.fire('keydown', { key: 'Delete' });
    assert.deepEqual(deleted, ['a']);
    f.workspace.dispose();
    assert.equal(f.workspace.entries.size, 0);
    assert.ok(activations.includes('a'));
});

test('changing minimum height while resizing keeps the gesture and clamps at the new limit', () => {
    const f = fixture();
    const entry = f.add('byte', { rect: { x: 0, y: 0, width: 640, height: 300 }, minHeight: 140 });
    entry.element.children.find(child => child.dataset.direction === 'se').fire('pointerdown');
    f.document.fire('pointermove', { clientX: -100, clientY: -150 });
    assert.deepEqual(f.workspace.getRect('byte'), { x: 0, y: 0, width: 440, height: 140 });
    entry.minHeight = 175; // A narrower statistics row now wraps into two lines.
    f.workspace.refresh();
    assert.ok(f.workspace.gesture, 'measuring the chrome must not cancel the drag');
    assert.deepEqual(f.workspace.getRect('byte'), { x: 0, y: 0, width: 440, height: 180 });
    f.document.fire('pointermove', { clientX: -900, clientY: -900 });
    assert.deepEqual(f.workspace.getRect('byte'), { x: 0, y: 0, width: 280, height: 180 });
    f.document.fire('pointerup');
    assert.equal(f.workspace.gesture, null);
    assert.deepEqual(f.workspace.getRect('byte'), { x: 0, y: 0, width: 280, height: 180 });
    assertSeparate(f.workspace);
    f.workspace.dispose();
});

test('a minimum change during a north-west resize preserves the opposite corner and Escape cancellation', () => {
    const f = fixture();
    const entry = f.add('byte', { rect: { x: 0, y: 0, width: 640, height: 300 }, minHeight: 140 });
    entry.element.children.find(child => child.dataset.direction === 'nw').fire('pointerdown');
    f.document.fire('pointermove', { clientX: 500, clientY: 250 });
    entry.minHeight = 175;
    f.workspace.refresh();
    assert.deepEqual(f.workspace.getRect('byte'), { x: 360, y: 120, width: 280, height: 180 });
    assert.ok(f.workspace.gesture);
    f.document.fire('keydown', { key: 'Escape' });
    assert.deepEqual(f.workspace.getRect('byte'), { x: 0, y: 0, width: 640, height: 300 });
    f.workspace.dispose();
});

test('library pointer drop previews a vacant rectangle and rejects drops outside the viewport', () => {
    const drops = [];
    const f = fixture({ onDrop: value => drops.push(value) });
    f.add('a');
    const down = { button: 0, pointerId: 4, clientX: 20, clientY: 20, preventDefault() {} };
    f.workspace.beginLibraryDrag('bytes', down);
    f.document.fire('pointermove', { pointerId: 4, clientX: 160, clientY: 400 });
    const preview = f.surface.children.find(c => c.className === 'widget-drop-preview');
    assert.equal(preview.hidden, false);
    f.document.fire('pointerup', { pointerId: 4, clientX: 160, clientY: 400 });
    assert.equal(drops.length, 1);
    assert.equal(drops[0].type, 'bytes');
    assert.ok(drops[0].rect.y >= 300);
    f.workspace.beginLibraryDrag('bytes', down);
    f.document.fire('pointerup', { pointerId: 4, clientX: 10, clientY: 10 });
    assert.equal(drops.length, 1);
});

test('keyboard arrows move one grid step away from an edge without snapping back', () => {
    const f = fixture();
    const a = f.add('a');
    a.handle.fire('keydown', { key: 'ArrowRight' });
    assert.equal(f.workspace.getRect('a').x, 10);
    a.handle.fire('keydown', { key: 'ArrowDown' });
    assert.equal(f.workspace.getRect('a').y, 10);
    a.handle.fire('keydown', { key: 'ArrowRight', shiftKey: true });
    assert.equal(f.workspace.getRect('a').width, 650);
});

test('restore from a wide viewport preserves horizontal positions in the narrow viewport', () => {
    const f = fixture();
    f.add('a'); f.add('b'); f.add('c');
    f.viewport.clientWidth = 320;
    assert.equal(f.workspace.restore({ step: 10, rects: {
        a: { x: 0, y: 0, width: 300, height: 300 },
        b: { x: 320, y: 0, width: 300, height: 300 },
        c: { x: 640, y: 0, width: 300, height: 300 }
    } }), true);
    assertSeparate(f.workspace);
    assert.deepEqual(f.workspace.getRect('c'), { x: 640, y: 0, width: 300, height: 300 });
    assert.ok(parseFloat(f.surface.style.width) >= 940);
});

test('moving and resizing beyond the visible right edge expands the horizontal scroll range without overlap', () => {
    const f = fixture();
    const a = f.add('a');
    a.handle.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 500 });
    f.document.fire('pointerup');
    assert.equal(f.workspace.getRect('a').x, 400);
    assert.ok(parseFloat(f.surface.style.width) >= 1040);
    const edge = a.element.children.find(child => child.dataset.direction === 'e');
    edge.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 300 });
    f.document.fire('pointerup');
    assert.equal(f.workspace.getRect('a').width, 840);
    assert.ok(parseFloat(f.surface.style.width) >= 1240);
    f.add('b', { rect: { x: 0, y: 0, width: 300, height: 300 } });
    assertSeparate(f.workspace);
});

test('cancelling a horizontal drag removes its temporary expansion and reset fits the visible width', () => {
    const f = fixture();
    const a = f.add('a');
    a.handle.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 900 });
    assert.ok(parseFloat(f.surface.style.width) > f.viewport.clientWidth);
    f.document.fire('keydown', { key: 'Escape' });
    assert.equal(f.workspace.getRect('a').x, 0);
    assert.equal(parseFloat(f.surface.style.width), 800);
    f.add('b', { rect: { x: 900, y: 0, width: 640, height: 300 } });
    f.workspace.reset();
    assert.equal(parseFloat(f.surface.style.width), 800);
    for (const rect of Object.values(f.workspace.serialize().rects)) assert.ok(rect.x + rect.width <= 800);
    assertSeparate(f.workspace);
});

test('Shift wheel and horizontal trackpad gestures pan the workspace with correct direction, units, and bounds', () => {
    const f = fixture();
    f.add('a', { rect: { x: 800, y: 0, width: 640, height: 300 } });
    let prevented = 0, stopped = 0;
    const event = { preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
    f.viewport.fire('wheel', { ...event, shiftKey: true, deltaY: 100 });
    assert.equal(f.viewport.scrollLeft, 100);
    f.viewport.fire('wheel', { ...event, deltaX: -40, deltaY: 2 });
    assert.equal(f.viewport.scrollLeft, 60);
    f.viewport.fire('wheel', { ...event, shiftKey: true, deltaY: 2, deltaMode: 1 });
    assert.equal(f.viewport.scrollLeft, 92);
    f.viewport.fire('wheel', { ...event, shiftKey: true, deltaY: 1, deltaMode: 2 });
    assert.equal(f.viewport.scrollLeft, 640);
    f.viewport.fire('wheel', { ...event, shiftKey: true, deltaY: -2000 });
    assert.equal(f.viewport.scrollLeft, 0);
    assert.equal(prevented, 5);
    assert.equal(stopped, 5);
    assert.equal(f.viewport.scrollTop, 0);
    f.workspace.dispose();
    f.viewport.fire('wheel', { ...event, shiftKey: true, deltaY: 100 });
    assert.equal(f.viewport.scrollLeft, 0);
});

test('ordinary vertical wheels, meta zoom, and input controls keep their original wheel behavior', () => {
    const f = fixture();
    f.add('a', { rect: { x: 800, y: 0, width: 640, height: 300 } });
    let prevented = 0;
    for (const props of [{ deltaY: 100 }, { deltaX: 100, metaKey: true },
        { shiftKey: true, deltaY: 100, metaKey: true },
        { shiftKey: true, deltaY: 100, target: { closest: () => ({}) } }]) {
        f.viewport.fire('wheel', { ...props, preventDefault() { prevented++; } });
    }
    assert.equal(prevented, 0);
    assert.equal(f.viewport.scrollLeft, 0);
});

test('Ctrl wheel scales only the workspace around the pointer and preserves logical widget geometry', () => {
    const f = fixture();
    f.add('a', { rect: { x: 800, y: 800, width: 640, height: 300 } });
    f.viewport.scrollLeft = 200; f.viewport.scrollTop = 100;
    let prevented = 0, stopped = 0;
    f.viewport.fire('wheel', { ctrlKey: true, deltaY: -100, clientX: 200, clientY: 150,
        preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    assert.equal(f.workspace.zoom, 1.1);
    assert.equal(f.workspace.surface.style.zoom, '1.1');
    assert.equal(f.workspace.surface.style.transform, undefined);
    assert.ok(Math.abs(f.viewport.scrollLeft - 230) < 1e-9);
    assert.ok(Math.abs(f.viewport.scrollTop - 120) < 1e-9);
    assert.deepEqual(f.workspace.getRect('a'), { x: 800, y: 800, width: 640, height: 300 });
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    assert.equal(f.document.body.style.transform, undefined);
});

test('zooming in around a small panel preserves the pointer anchor without rounding-only scrollbars', () => {
    const f = fixture();
    f.add('a', { rect: { x: 0, y: 0, width: 300, height: 200 } });
    f.viewport.fire('wheel', { ctrlKey: true, deltaY: -100, clientX: 500, clientY: 350 });
    assert.ok(Math.abs(f.viewport.scrollLeft - 40) < 1e-9);
    assert.ok(Math.abs(f.viewport.scrollTop - 30) < 1e-9);
    f.workspace.setZoom(1);
    assert.equal(parseFloat(f.workspace.scaleLayer.style.width), 800);
    assert.equal(parseFloat(f.workspace.scaleLayer.style.height), 600);
});

test('Ctrl plus and minus override browser shortcuts only while the pointer is in the workspace', () => {
    const f = fixture();
    let prevented = 0;
    const event = { ctrlKey: true, preventDefault() { prevented++; }, stopPropagation() {} };
    f.document.fire('keydown', { ...event, key: '=' });
    assert.equal(prevented, 0);
    f.viewport.fire('pointerenter');
    f.document.fire('keydown', { ...event, key: '=' });
    assert.equal(f.workspace.zoom, 1.1);
    f.document.fire('keydown', { ...event, key: '-' });
    assert.equal(f.workspace.zoom, 1);
    f.document.fire('keydown', { ...event, key: '+', code: 'NumpadAdd' });
    assert.equal(f.workspace.zoom, 1.1);
    f.viewport.fire('pointerleave');
    f.document.fire('keydown', { ...event, key: '-' });
    assert.equal(f.workspace.zoom, 1.1);
    assert.equal(prevented, 3);
    f.viewport.fire('pointerenter'); f.window.fire('blur');
    f.document.fire('keydown', { ...event, key: '-' });
    assert.equal(prevented, 3);
    f.workspace.dispose();
    f.viewport.fire('wheel', { ...event, deltaY: 100 });
    assert.equal(prevented, 3);
});

test('zoom limits consume Ctrl wheels and scaled scroll extents restore with the layout', () => {
    const f = fixture();
    f.add('a', { rect: { x: 800, y: 800, width: 640, height: 300 } });
    let prevented = 0;
    for (let i = 0; i < 60; i++) f.viewport.fire('wheel', { ctrlKey: true, deltaY: -1,
        preventDefault() { prevented++; } });
    assert.equal(f.workspace.zoom, 5); assert.equal(prevented, 60);
    assert.equal(parseFloat(f.workspace.scaleLayer.style.width), 7200);
    const saved = f.workspace.serialize();
    assert.equal(saved.zoom, 5);
    f.workspace.setZoom(0.5, { x: 0, y: 0 });
    assert.equal(f.workspace.restore(saved), true);
    assert.equal(f.workspace.zoom, 5);
    assert.equal(f.workspace.restore({ ...saved, zoom: NaN }), false);
    for (let i = 0; i < 60; i++) f.viewport.fire('wheel', { ctrlKey: true, deltaY: 1 });
    assert.equal(f.workspace.zoom, 0.25);
    assert.ok(parseFloat(f.workspace.scaleLayer.style.width) >= 800);
    assert.equal(f.workspace.restore({ step: 10, rects: saved.rects }), true);
    assert.equal(f.workspace.zoom, 1);
});

test('scaled panel drag and edge resize convert screen deltas to snapped logical coordinates', () => {
    const f = fixture();
    const entry = f.add('a', { rect: { x: 100, y: 50, width: 300, height: 200 } });
    f.workspace.setZoom(2, { x: 0, y: 0 });
    entry.handle.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 200, clientY: 90 });
    f.document.fire('pointerup');
    assert.deepEqual(f.workspace.getRect('a'), { x: 150, y: 70, width: 300, height: 200 });
    entry.element.children.find(child => child.dataset.direction === 'e').fire('pointerdown');
    f.document.fire('pointermove', { clientX: 180, clientY: 50 });
    f.document.fire('pointerup');
    assert.equal(f.workspace.getRect('a').width, 340);
});

test('library drops convert viewport position and scroll to scaled logical coordinates', () => {
    const drops = [], f = fixture({ onDrop: drop => drops.push(drop) });
    f.workspace.setZoom(2, { x: 0, y: 0 });
    f.viewport.scrollLeft = 80; f.viewport.scrollTop = 40;
    f.workspace.beginLibraryDrag('byte', { button: 0, pointerId: 1, clientX: 220, clientY: 130, preventDefault() {} });
    f.document.fire('pointerup', { clientX: 220, clientY: 130 });
    assert.deepEqual(drops[0].rect, { x: 100, y: 60, width: 400, height: 300 });
});

test('scrolling during a drag stays in surface coordinates and cancellation ignores other pointers', () => {
    const f = fixture();
    const a = f.add('a');
    a.handle.fire('pointerdown');
    f.viewport.scrollTop = 100;
    f.document.fire('pointermove', { clientY: 150 });
    assert.equal(f.workspace.getRect('a').y, 200);
    f.document.fire('pointercancel', { pointerId: 9 });
    assert.equal(f.workspace.getRect('a').y, 200);
    f.document.fire('pointercancel');
    assert.equal(f.workspace.getRect('a').y, 0);
});

test('disposing a library drag cancels its preview and prevents later drop callbacks', () => {
    const drops = [];
    const f = fixture({ onDrop: drop => drops.push(drop) });
    f.workspace.beginLibraryDrag('waveform', { button: 0, pointerId: 1,
        clientX: 160, clientY: 400, preventDefault() {} });
    f.workspace.dispose();
    f.document.fire('pointerup', { clientX: 160, clientY: 400 });
    assert.deepEqual(drops, []);
    assert.equal(f.surface.children.length, 0);
    assert.equal(f.document.body.style.userSelect, undefined);
});

test('workspace disposal does not publish an empty replacement layout to persistence callbacks', () => {
    const changes = [];
    const f = fixture({ onLayoutChange: layout => changes.push(layout) });
    f.add('a');
    changes.length = 0;
    f.workspace.dispose();
    assert.deepEqual(changes, []);
});

test('workspace accepts integer percentages through 500 percent and fits bounds with ten-pixel bleed', () => {
    const f = fixture();
    f.add('a', { rect: { x: 0, y: 0, width: 960, height: 300 } });
    f.workspace.setZoom(0.81);
    assert.equal(f.workspace.zoom, 0.81);
    f.workspace.setZoom(1.555);
    assert.equal(f.workspace.zoom, 1.56);
    f.workspace.setZoom(9);
    assert.equal(f.workspace.zoom, 5);
    assert.equal(f.workspace.fitZoom(), 0.81);
    f.workspace.setZoom(0.9);
    f.viewport.fire('wheel', { ctrlKey: true, deltaY: 1 });
    assert.equal(f.workspace.zoom, 0.81, 'crossing the fit percentage snaps to it');
    const left = parseFloat(f.surface.style.left) * f.workspace.zoom - f.viewport.scrollLeft;
    assert.ok(left >= 10 * f.workspace.zoom);
    assert.ok(left + 970 * f.workspace.zoom <= f.viewport.clientWidth);
    f.viewport.fire('wheel', { ctrlKey: true, deltaY: 1 });
    assert.equal(f.workspace.zoom, 0.71, 'can leave the snapped percentage');
});

test('blank context menu alternates visible-center 100 percent and all-widget fit, without intercepting widgets', () => {
    const f = fixture();
    const a = f.add('a', { rect: { x: 1000, y: 0, width: 960, height: 300 } });
    f.workspace.setZoom(2);
    f.viewport.scrollLeft = 1800;
    f.viewport.fire('contextmenu', { clientX: 300, clientY: 200 });
    assert.equal(f.workspace.zoom, 1);
    assert.equal(f.viewport.scrollLeft, 700);
    f.viewport.fire('contextmenu');
    assert.equal(f.workspace.zoom, 0.81);
    f.viewport.fire('contextmenu', { composedPath: () => [a.element, f.surface, f.viewport] });
    assert.equal(f.workspace.zoom, 0.81);
    f.workspace.remove('a');
    f.add('large', { rect: { x: 0, y: 0, width: 4000, height: 3000 } });
    f.viewport.fire('contextmenu');
    f.viewport.fire('contextmenu', { clientX: 300, clientY: 200 });
    assert.equal(f.workspace.zoom, 0.25);
});

test('marquee selection moves a group on the grid, keeps relative offsets and cancels together', () => {
    const f = fixture();
    const a = f.add('a', { rect: { x: 50, y: 50, width: 300, height: 200 } });
    f.add('b', { rect: { x: 400, y: 50, width: 300, height: 200 } });
    f.add('c', { rect: { x: 800, y: 50, width: 300, height: 200 } });
    f.surface.fire('pointerdown', { clientX: 110, clientY: 60 });
    f.document.fire('pointermove', { clientX: 820, clientY: 320 });
    f.document.fire('pointerup');
    assert.deepEqual([...f.workspace.selectedIds], ['a', 'b']);
    a.handle.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 170, clientY: 90 });
    assert.equal(f.workspace.getRect('a').x, 120);
    assert.equal(f.workspace.getRect('b').x, 470);
    assert.equal(f.workspace.getRect('a').y, 90);
    assertSeparate(f.workspace);
    f.document.fire('keydown', { key: 'Escape' });
    assert.equal(f.workspace.getRect('a').x, 50);
    assert.equal(f.workspace.getRect('b').x, 400);
    a.handle.fire('pointerdown');
    f.document.fire('pointermove', { clientX: 250, clientY: 50 });
    f.document.fire('pointerup');
    assert.equal(f.workspace.getRect('b').x, 500, 'group stops at outsider boundary');
    assert.equal(f.workspace.getRect('b').x - f.workspace.getRect('a').x, 350);
    assertSeparate(f.workspace);
    f.workspace.dispose();
});

test('marquee and library coordinates include the fitted origin and group deletion cancels every move', () => {
    const f = fixture();
    const a = f.add('a', { rect: { x: 0, y: 0, width: 300, height: 200 } });
    f.add('b', { rect: { x: 350, y: 0, width: 300, height: 200 } });
    f.workspace.fitAll();
    const point = (x, y) => ({ clientX: 100 + f.workspace.origin.x + x * f.workspace.zoom,
        clientY: 50 + f.workspace.origin.y + y * f.workspace.zoom });
    f.surface.fire('pointerdown', point(-5, -5));
    f.document.fire('pointermove', point(660, 210));
    f.document.fire('pointerup');
    assert.deepEqual([...f.workspace.selectedIds], ['a', 'b']);
    a.handle.fire('pointerdown', point(10, 10));
    f.document.fire('pointermove', point(110, 60));
    assert.equal(f.workspace.getRect('a').x, 100);
    assert.equal(f.workspace.getRect('b').y, 50);
    f.workspace.remove('b');
    assert.equal(f.workspace.gesture, null);
    assert.equal(f.workspace.getRect('a').x, 0);
    assert.deepEqual([...f.workspace.selectedIds], ['a']);
    f.workspace.dispose();
});

test('unfittable content scales to minimum about the click without claiming a full fit', () => {
    const f = fixture();
    f.add('a', { rect: { x: 0, y: 0, width: 4000, height: 3000 } });
    f.viewport.scrollLeft = 1200; f.viewport.scrollTop = 1000;
    f.workspace.fitAll({ x: 200, y: 150 });
    assert.equal(f.workspace.zoom, 0.25);
    assert.equal(f.viewport.scrollLeft, 150);
    assert.equal(f.viewport.scrollTop, 137.5);
    assert.deepEqual(f.workspace.origin, { x: 0, y: 0 });
    assert.equal(f.workspace.fitted, false);
});
