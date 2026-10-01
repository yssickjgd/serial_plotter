const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createPlotter(canvasScale = 1) {
    const events = new Map();
    const overlays = [];
    const context2d = new Proxy({}, { get: (_, key) => key === 'measureText'
        ? () => ({ width: 20 })
        : key === 'strokeRect' ? (...args) => { overlays.push(args); }
            : () => {} });
    const element = () => ({ style: {}, offsetHeight: 0, clientWidth: 800,
        addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 400, left: 10, top: 20 }) });
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
    }, addEventListener() {} };
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
    for (let i = 0; i <= 100; i++) plotter.addFrame([i]);
    plotter.draw();
    const fire = (name, x, y) => events.get(name)({
        button: 0, pointerId: 1,
        clientX: 10 + x * canvasScale, clientY: 20 + y * canvasScale,
        preventDefault() {}
    });
    return { plotter, fire, events, overlays };
}

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
