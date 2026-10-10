const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createPlotter(canvasScale = 1) {
    const events = new Map();
    const documentEvents = new Map();
    const overlays = [];
    const transforms = [];
    const context2d = new Proxy({}, { get: (_, key) => key === 'measureText'
        ? () => ({ width: 20 })
        : key === 'strokeRect' ? (...args) => { overlays.push(args); }
            : key === 'setTransform' ? (...args) => { transforms.push(args); }
            : () => {} });
    const element = () => ({ style: {}, listeners: {}, offsetHeight: 0, offsetWidth: 100,
        clientWidth: 800, clientHeight: 378,
        addEventListener(name, callback) { this.listeners[name] = callback; },
        getBoundingClientRect: () => ({ width: 800, height: 400, left: 10, top: 20 }) });
    const canvas = { ...element(), parentElement: element(),
        addEventListener(name, callback) { events.set(name, callback); },
        setPointerCapture() {}, releasePointerCapture() {},
        getBoundingClientRect: () => ({ width: 800 * canvasScale,
            height: 400 * canvasScale, left: 10, top: 20 }),
        getContext: () => context2d };
    const nodes = new Map([['waveform-canvas', canvas]]);
    const document = { getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
    }, addEventListener(name, callback) {
        if (!documentEvents.has(name)) documentEvents.set(name, []);
        documentEvents.get(name).push(callback);
    } };
    const context = vm.createContext({
        document, window: { addEventListener() {} }, performance,
        requestAnimationFrame() {}, console
    });
    for (const file of ['projectLimits.js', 'frameBuffer.js', 'plotMath.js',
        'channelTransform.js', 'spectrum.js', 'plotter.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context, { filename: file });
    }
    const { FrameBuffer, Plotter } = context.SerialPlotter;
    const plotter = new Plotter('waveform-canvas', new FrameBuffer(1, 1000));
    plotter.setChannelCount(1);
    plotter.setChannelVisible(0, true);
    for (let i = 0; i <= 100; i++) plotter.addFrame([i], Uint8Array.of(i), `t${i}`, i, i);
    plotter.draw();
    const fire = (name, x, y, extra = {}) => events.get(name)({
        button: 0, pointerId: 1,
        clientX: 10 + x * canvasScale, clientY: 20 + y * canvasScale,
        preventDefault() {}, ...extra
    });
    const fireDocument = (name, event) => {
        for (const callback of documentEvents.get(name) || []) callback(event);
    };
    return { plotter, fire, fireDocument, nodes, events, overlays, transforms, context };
}

test('resizing a workspace panel excludes its padding and border from the canvas dimensions', () => {
    const { plotter, nodes, context } = createPlotter();
    context.getComputedStyle = () => ({ paddingLeft: '5px', paddingRight: '5px',
        paddingTop: '5px', paddingBottom: '5px', borderLeftWidth: '1px', borderRightWidth: '1px',
        borderTopWidth: '1px', borderBottomWidth: '1px' });
    plotter.resize();
    assert.equal(nodes.get('waveform-canvas').width, 788);
    assert.equal(nodes.get('waveform-canvas').height, 388);
});

test('workspace scale increases canvas resolution while keeping Y scrollbar in logical coordinates', () => {
    const { plotter, fire, nodes } = createPlotter(2);
    plotter.canvas.closest = () => ({ dataset: { workspaceZoom: '2' } });
    plotter.canvas.parentElement.getBoundingClientRect = () => ({ width: 1600, height: 800, left: 10, top: 20 });
    plotter.resize(); plotter.draw();
    assert.equal(plotter.canvas.width, 1600); assert.equal(plotter.canvas.height, 800);
    fire('pointerdown', 100, 100); fire('pointerup', 500, 250);
    assert.equal(parseFloat(nodes.get('plot-y-scrollbar-wrap').style.height), 378);
});

test('high DPI workspace redraw preserves logical axes pointer coordinates and the data viewport', () => {
    const { plotter, fire, context, transforms } = createPlotter(2);
    const viewport = JSON.stringify(plotter.vp);
    plotter.canvas.closest = () => ({ dataset: { workspaceZoom: '2' } });
    plotter.canvas.parentElement.getBoundingClientRect = () => ({ width: 1600, height: 800, left: 10, top: 20 });
    context.window.devicePixelRatio = 2;
    plotter.resize(); plotter.draw(); plotter.draw();
    assert.equal(plotter.canvas.width, 3200); assert.equal(plotter.canvas.height, 1600);
    assert.equal(plotter.width, 800); assert.equal(plotter.height, 400);
    assert.equal(plotter._drawState.plotW, 710); assert.equal(plotter._drawState.plotH, 378);
    assert.deepEqual(transforms.at(-1), [4, 0, 0, 4, 0, 0]);
    fire('pointermove', 200, 150);
    assert.equal(plotter.mousePos.x, 200); assert.equal(plotter.mousePos.y, 150);
    assert.equal(JSON.stringify(plotter.vp), viewport);
    context.window.devicePixelRatio = 1.25;
    plotter.resize(); plotter.draw();
    assert.equal(plotter.canvas.width, 2000); assert.equal(plotter.canvas.height, 1000);
    assert.deepEqual(transforms.at(-1), [2.5, 0, 0, 2.5, 0, 0]);
});

test('scaled horizontal scrollbar dragging uses logical rather than screen distance', () => {
    const { plotter, fireDocument, nodes } = createPlotter();
    plotter.canvas.closest = () => ({ dataset: { workspaceZoom: '2' } });
    Object.assign(plotter.vp.time, { displayCount: 40, scrollOffset: 0, autoFollow: false });
    nodes.get('plot-scrollbar-thumb').listeners.mousedown({ clientX: 100, preventDefault() {} });
    fireDocument('mousemove', { clientX: 300 });
    fireDocument('mouseup', {});
    assert.equal(plotter.vp.time.scrollOffset, 9);
});

test('raw capture draws an empty waveform without decoding samples or calculating FFT', () => {
    const { plotter } = createPlotter();
    plotter.frames.clear(); plotter.frames.setRawMode(true);
    plotter.frames.appendRaw(Uint8Array.of(1, 2), 't', 1);
    plotter.frames.getValue = () => { throw new Error('raw capture must not read samples'); };
    const statistics = [];
    plotter.onStatsUpdate = value => statistics.push(value);
    for (const displayMode of ['time', 'frequency']) {
        plotter.setDisplayOptions({ displayMode });
        plotter.draw();
        assert.equal(plotter._drawState, null);
        assert.equal(plotter._computeFftForVisibleChannels().size, 0);
    }
    assert.equal(statistics.at(-1), null);
});

test('wave search position follows latest data or the time window center even in frequency mode', () => {
    const { plotter, fire } = createPlotter();
    plotter.setPlotWindowPoints(40);
    assert.equal(plotter.currentFrameIndex(), 100);
    plotter.jumpToFrame(30);
    assert.equal(plotter.currentFrameIndex(), 30);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    assert.equal(plotter.currentFrameIndex(), 30);
    plotter.setDisplayOptions({ displayMode: 'time' });
    fire('contextmenu', 100, 100);
    assert.equal(plotter.currentFrameIndex(), 100);
    plotter.frames.clear();
    assert.equal(plotter.currentFrameIndex(), -1);
});

test('left-button rectangle zoom selects both sample and Y ranges', () => {
    const { plotter, fire, overlays } = createPlotter();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointermove', plotW * 3 / 4, plotH * 3 / 4);
    plotter.draw();
    assert.ok(overlays.some(([x, y, width, height]) =>
        x === plotW / 4 && y === plotH / 4 && width === plotW / 2 && height === plotH / 2));
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    assert.equal(plotter.vp.time.scrollOffset, 25);
    assert.equal(plotter.vp.time.displayCount, 51);
    assert.equal(plotter.vp.time.autoFollow, false);
    assert.equal(plotter.yScaleMode, 'auto');
    assert.equal(plotter.yBounds.time.min, -1);
    assert.equal(plotter.yBounds.time.max, 1);
    assert.ok(Math.abs(plotter._drawState.min - 21) < 1e-9);
    assert.ok(Math.abs(plotter._drawState.max - 79) < 1e-9);
});

test('user viewport callbacks cover X/Y zoom and pan in both modes and right-click reset only', () => {
    const { plotter, fire, fireDocument, nodes } = createPlotter();
    const changes = [];
    plotter.onViewportChange = () => changes.push(plotter.displayMode);
    plotter.addFrame([102], Uint8Array.of(102)); plotter.draw();
    assert.equal(changes.length, 0);
    for (const mode of ['time', 'frequency']) {
        plotter.setDisplayOptions({ displayMode: mode }); plotter.draw();
        const before = changes.length;
        fire('wheel', 200, 100, { deltaY: -1 });
        assert.equal(changes.length, before + 1, mode + ' X wheel');
        plotter.draw();
        fire('wheel', 790, 100, { deltaY: -1 });
        assert.equal(changes.length, before + 2, mode + ' Y wheel');
        plotter.draw();
        nodes.get('plot-y-scrollbar-wrap').listeners.click({ clientY: 21, target: nodes.get('plot-y-scrollbar-wrap') });
        assert.equal(changes.length, before + 3, mode + ' Y track pan');
        nodes.get('plot-y-scrollbar-thumb').listeners.mousedown({ clientY: 21, preventDefault() {} });
        fireDocument('mousemove', { clientY: 100 }); fireDocument('mouseup', {});
        assert.equal(changes.length, before + 4, mode + ' Y thumb pan');
        fire('pointerdown', 100, 100); fire('pointerup', 350, 220);
        assert.equal(changes.length, before + 5, mode + ' rectangle zoom');
        nodes.get('plot-scrollbar-wrap').listeners.click({ clientX: 11, target: nodes.get('plot-scrollbar-wrap') });
        assert.equal(changes.length, before + 6, mode + ' X track pan');
        fire('contextmenu', 0, 0);
        assert.equal(changes.length, before + 7, mode + ' reset');
    }
    const count = changes.length;
    plotter.dispose();
    assert.equal(plotter.onViewportChange, null);
    plotter._notifyViewportChange?.('outdated');
    assert.equal(changes.length, count);
});

test('tiny drag and cancelled pointer leave the viewport unchanged', () => {
    const { plotter, fire } = createPlotter();
    fire('pointerdown', 100, 100);
    fire('pointermove', 103, 104);
    fire('pointerup', 103, 104);
    assert.equal(plotter.vp.time.displayCount, 1000);
    assert.equal(plotter.yScaleMode, 'auto');
    fire('pointerdown', 100, 100);
    fire('pointermove', 300, 250);
    fire('pointercancel', 300, 250);
    assert.equal(plotter.vp.time.displayCount, 1000);
    assert.equal(plotter.yScaleMode, 'auto');
    fire('pointerdown', 100, 100);
    fire('pointermove', 300, 250);
    fire('lostpointercapture', 300, 250);
    assert.equal(plotter._selection, null);
    assert.equal(plotter.vp.time.autoFollow, true);
});

test('pointer coordinates account for CSS canvas scaling', () => {
    const { plotter, fire } = createPlotter(2);
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    assert.equal(plotter.vp.time.scrollOffset, 25);
    assert.equal(plotter.vp.time.displayCount, 51);
});

test('paused data can be rectangle zoomed and explicit Y settings replace the temporary zoom', () => {
    const { plotter, fire } = createPlotter();
    plotter.togglePause();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    assert.equal(plotter._drawState.min, 21);
    plotter.setDisplayOptions({ yScaleMode: 'manual', yMinTime: 0, yMaxTime: 100 });
    assert.equal(plotter._drawState.min, 0);
    assert.equal(plotter._drawState.max, 100);
});

test('right click restores the Y scale that existed before rectangle zoom', () => {
    const { plotter, fire } = createPlotter();
    plotter.setDisplayOptions({ yScaleMode: 'manual', yMinTime: 0, yMaxTime: 100 });
    plotter.draw();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    assert.equal(plotter._drawState.min, 25);
    fire('contextmenu', 0, 0);
    plotter.draw();
    assert.equal(plotter.vp.time.displayCount, plotter.maxPoints);
    assert.equal(plotter.yScaleMode, 'manual');
    assert.equal(plotter.yBounds.time.min, 0);
    assert.equal(plotter.yBounds.time.max, 100);
    assert.equal(plotter._drawState.min, 0);
    assert.equal(plotter._drawState.max, 100);
});

test('frequency manual bounds apply in both scales and editing clears a temporary zoom', () => {
    const { plotter, fire } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'frequency', yScaleMode: 'manual', yMinFreq: 0.01, yMaxFreq: 2 });
    plotter.draw();
    assert.equal(plotter._drawState.min, 0.01);
    assert.equal(plotter._drawState.max, 2);
    plotter.setDisplayOptions({ freqYScale: 'log' });
    plotter.draw();
    assert.equal(plotter._drawState.min, 0.01);
    assert.equal(plotter._drawState.max, 2);
    const { plotW, plotH } = plotter._drawState;
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    plotter.draw();
    assert.notEqual(plotter._drawState.min, 0.01);
    plotter.setDisplayOptions({ yScaleMode: 'manual', yMinFreq: 0.01, yMaxFreq: 2, resetYZoom: true });
    plotter.draw();
    assert.equal(plotter._drawState.min, 0.01);
    assert.equal(plotter._drawState.max, 2);
});

test('zero-inclusive frequency Y zoom and scrollbar share a stable adaptive transform', () => {
    const { plotter, fire, nodes } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'frequency', freqYScale: 'log',
        yScaleModeFreq: 'manual', yMinFreq: 0, yMaxFreq: 100 });
    plotter.draw();
    const { plotW, plotH, yScale } = plotter._drawState;
    assert.equal(plotter._drawState.min, 0);
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    assert.ok(plotter._drawState.min > 0);
    assert.ok(plotter._drawState.max < 100);
    assert.equal(plotter._drawState.yScale, yScale);
    assert.equal(nodes.get('plot-y-scrollbar-wrap').hidden, false);
    plotter._panYToFraction(1);
    plotter.draw();
    assert.ok(Math.abs(plotter._drawState.min) < 1e-12);
    assert.ok(Number.isFinite(plotter._drawState.max));
    const oldMax = plotter._drawState.max;
    fire('wheel', plotW + 20, plotH, { deltaY: -1 });
    plotter.draw();
    assert.ok(Math.abs(plotter._drawState.min) < 1e-12);
    assert.ok(plotter._drawState.max < oldMax);
    plotter.addFrame([10000]);
    plotter._fftVersion = -1;
    plotter.draw();
    assert.equal(plotter._drawState.yScale, yScale, 'new data does not shift a zoomed transform');
    fire('contextmenu', 0, 0);
    plotter.draw();
    assert.equal(plotter._drawState.min, 0);
    assert.equal(plotter._drawState.max, 100);
    assert.equal(nodes.get('plot-y-scrollbar-wrap').hidden, true);
    assert.ok(Number.isFinite(plotter._drawState.yScale.linearThreshold));
});

test('frequency rectangle zoom keeps the time viewport separate', () => {
    const { plotter, fire } = createPlotter();
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    plotter.draw();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    assert.ok(plotter.vp.frequency.displayCount < 1000);
    assert.equal(plotter.vp.time.displayCount, 1000);
    assert.equal(plotter.yScaleMode, 'auto');
    const frequencyBounds = { min: plotter._drawState.min, max: plotter._drawState.max };
    plotter.setDisplayOptions({ displayMode: 'time' });
    plotter.draw();
    assert.notEqual(plotter._drawState.min, frequencyBounds.min);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    plotter.draw();
    assert.equal(plotter._drawState.min, frequencyBounds.min);
    assert.equal(plotter._drawState.max, frequencyBounds.max);
});

test('wheel zoom selects X in the plot or bottom axis and Y beside the right axis', () => {
    const { plotter, fire, nodes } = createPlotter();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    const originalY = { min: plotter._drawState.min, max: plotter._drawState.max };
    const yBar = nodes.get('plot-y-scrollbar-wrap');
    assert.equal(yBar.hidden, true);

    fire('wheel', plotW / 2, plotH / 2, { deltaY: -1 });
    plotter.draw();
    const insideCount = plotter.vp.time.displayCount;
    assert.ok(insideCount < 100);
    assert.equal(plotter._boxZoomY.time, null);

    fire('wheel', plotW / 2, plotH + 10, { deltaY: -1 });
    plotter.draw();
    assert.ok(plotter.vp.time.displayCount < insideCount);
    assert.equal(plotter._boxZoomY.time, null);

    const xCount = plotter.vp.time.displayCount;
    fire('wheel', plotW + 20, plotH / 2, { deltaY: -1 });
    plotter.draw();
    assert.equal(plotter.vp.time.displayCount, xCount);
    assert.ok(plotter._drawState.min > originalY.min);
    assert.ok(plotter._drawState.max < originalY.max);
    assert.equal(yBar.hidden, false);
    assert.ok(parseFloat(nodes.get('plot-y-scrollbar-thumb').style.height) < 378);
});

test('a Y scrollbar pans the zoomed range and right click restores both axes', () => {
    const { plotter, fire, fireDocument, nodes } = createPlotter();
    const plotW = plotter.canvas.width - plotter.pX;
    const plotH = plotter.canvas.height - plotter.pY;
    fire('pointerdown', plotW / 4, plotH / 4);
    fire('pointerup', plotW * 3 / 4, plotH * 3 / 4);
    const yBar = nodes.get('plot-y-scrollbar-wrap');
    const thumb = nodes.get('plot-y-scrollbar-thumb');
    assert.equal(yBar.hidden, false);
    assert.ok(parseFloat(nodes.get('plot-scrollbar-thumb').style.width) < 800);
    const originalSpan = plotter._drawState.max - plotter._drawState.min;
    const originalMin = plotter._drawState.min;
    thumb.listeners.mousedown({ clientY: 100, preventDefault() {} });
    fireDocument('mousemove', { clientY: 130 });
    fireDocument('mouseup', {});
    plotter.draw();
    assert.ok(plotter._drawState.min < originalMin);
    assert.ok(Math.abs(plotter._drawState.max - plotter._drawState.min - originalSpan) < 1e-9);
    fire('contextmenu', 0, 0);
    plotter.draw();
    assert.equal(plotter.vp.time.displayCount, plotter.maxPoints);
    assert.equal(plotter._boxZoomY.time, null);
    assert.equal(yBar.hidden, true);
});

test('the plot window setting limits time zoom and right click follows its latest samples', () => {
    const { plotter, fire } = createPlotter();
    plotter.setPlotWindowPoints(40);
    assert.equal(plotter.vp.time.displayCount, 40);
    assert.equal(plotter.vp.time.scrollOffset, 61);
    fire('wheel', 200, 100, { deltaY: -1 });
    assert.ok(plotter.vp.time.displayCount < 40);
    fire('contextmenu', 0, 0);
    assert.equal(plotter.vp.time.displayCount, 40);
    assert.equal(plotter.vp.time.scrollOffset, 61);
    assert.equal(plotter.vp.time.autoFollow, true);
    plotter.setMaxPoints(30);
    assert.equal(plotter.plotWindowPoints, 30);
    assert.equal(plotter.vp.time.displayCount, 30);
});

test('live X scrollbar keeps the selected samples fixed until they leave the buffer', () => {
    const { plotter, fireDocument, nodes } = createPlotter();
    plotter.setMaxPoints(120);
    plotter.setPlotWindowPoints(20);
    const thumb = nodes.get('plot-scrollbar-thumb');
    thumb.listeners.mousedown({ clientX: 0, preventDefault() {} });
    fireDocument('mousemove', { clientX: -250 });
    fireDocument('mouseup', {});
    const viewport = plotter.vp.time;
    assert.equal(viewport.autoFollow, false,
        JSON.stringify({ offset: viewport.scrollOffset, count: viewport.displayCount,
            length: plotter.frames.length }));
    const selectedOffset = viewport.scrollOffset;
    const selected = plotter.frames.getValue(0, viewport.scrollOffset);
    plotter.draw();
    for (let value = 101; value < 120 + selectedOffset; value++) {
        plotter.addFrame([value]);
        assert.equal(plotter.frames.getValue(0, viewport.scrollOffset), selected);
        assert.equal(plotter._dirty, false);
    }
    assert.equal(viewport.scrollOffset, 0);
    plotter.addFrame([120 + selectedOffset]);
    assert.equal(plotter.frames.getValue(0, 0), selected + 1);
    assert.equal(plotter._dirty, true);
});

test('time and byte jumps clamp to retained samples and keep the full window at both edges', () => {
    const { plotter } = createPlotter();
    plotter.setPlotWindowPoints(40);
    plotter.isPaused = true;
    for (const [index, start, end] of [[0, 0, 40], [10, 0, 40], [50, 30, 70], [100, 61, 101]]) {
        assert.equal(plotter.jumpToFrame(index), true);
        plotter.draw();
        assert.equal(plotter._drawState.startIdx, start);
        assert.equal(plotter._drawState.visibleCnt, end - start);
        assert.equal(plotter.vp.time.scrollOffset, start);
        assert.deepEqual({ ...plotter._frequencyInputRange() }, { start, end });
        assert.equal(plotter.currentFrameIndex(), start + 20);
        assert.equal(plotter.jumpToByteOffset(plotter.frames.rawByteOffsetAt(index)), true);
        assert.equal(plotter._drawState.startIdx, start);
    }
});

test('jumping within a short history fills the plot with real samples without shrinking the configured count', () => {
    const { plotter } = createPlotter();
    plotter.isPaused = true;
    for (const index of [0, 50, 100]) {
        plotter.jumpToFrame(index); plotter.draw();
        assert.equal(plotter._drawState.startIdx, 0);
        assert.equal(plotter._drawState.visibleCnt, 101);
        assert.equal(plotter.vp.time.displayCount, 1000);
        assert.deepEqual({ ...plotter._frequencyInputRange() }, { start: 0, end: 101 });
        assert.equal(plotter.currentFrameIndex(), 50);
    }
    plotter._timeCenterOrder = null;
    assert.equal(plotter.currentFrameIndex(), 50, 'history reference uses actual samples when the configured window is larger');
});
