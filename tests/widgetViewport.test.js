const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createPlotter(length = 128, firstOrder = 1) {
    const context2d = new Proxy({}, { get: (_, key) => key === 'measureText'
        ? () => ({ width: 20 }) : () => {} });
    const element = () => ({ style: {}, offsetHeight: 0, clientWidth: 800,
        addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 400 }) });
    const canvas = { ...element(), parentElement: element(), getContext: () => context2d };
    const document = { getElementById: () => element(), addEventListener() {} };
    const context = vm.createContext({ document, window: { addEventListener() {} },
        performance, requestAnimationFrame() {}, console });
    for (const file of ['projectLimits.js', 'frameBuffer.js', 'plotMath.js',
        'channelTransform.js', 'spectrum.js', 'plotViewport.js', 'plotter.js'])
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
    const frames = new context.SerialPlotter.FrameBuffer(1, 1024);
    for (let i = 0; i < length; i++) frames.append([i], Uint8Array.of(i & 255),
        `time-${i}`, firstOrder + i, i, { byteOffset: i * 4 });
    const plotter = new context.SerialPlotter.Plotter(canvas, frames, { viewOnly: true });
    plotter.setChannelCount(1);
    plotter.setChannelVisible(0, true);
    return plotter;
}

const state = () => ({
    time: { displayCount: 32, autoFollow: false, startFraction: 0.25, yZoom: null },
    frequency: { displayCount: 17, autoFollow: false, startFraction: 0.5, yZoom: null }
});
const viewportApi = () => require('../widgetViewport');

test('a live time zoom roundtrips its offset in samples and duration in milliseconds', () => {
    const { captureWidgetViewport, restoreWidgetViewport, normalizeWidgetViewport } = viewportApi();
    const first = createPlotter();
    Object.assign(first.vp.time, { displayCount: 32, scrollOffset: 84, autoFollow: true,
        followLag: 12, followTime: { lag: 24, span: 62 } });
    const saved = captureWidgetViewport(first);
    assert.equal(saved.time.followLag, 12);
    assert.deepEqual(saved.time.followTime, { lag: 24, span: 62 });
    assert.notEqual(saved.time.followTime, first.vp.time.followTime);
    const other = createPlotter(160);
    assert.equal(restoreWidgetViewport(other, saved), true);
    assert.equal(other.vp.time.scrollOffset, 116);
    assert.equal(other.vp.time.followLag, 12);
    assert.deepEqual(other.vp.time.followTime, { lag: 24, span: 62 });
    assert.equal(restoreWidgetViewport(other, state()), true);
    assert.equal(other.vp.time.followLag, undefined);
    assert.equal(other.vp.time.followTime, undefined);
    saved.time.followTime.span = 0;
    assert.throws(() => normalizeWidgetViewport(saved));
    saved.time.followLag = -1;
    delete saved.time.followTime;
    assert.throws(() => normalizeWidgetViewport(saved));
});

test('manual time scrollbar restores a historical time fraction across unevenly spaced samples', () => {
    const { captureWidgetViewport, restoreWidgetViewport } = viewportApi();
    function timedPlotter(times) {
        const plotter = createPlotter(0);
        for (const [i, time] of times.entries()) plotter.frames.append([i], Uint8Array.of(i), '', i + 1, time);
        plotter.receiveTimeAxis = true;
        plotter.timeXUnit = 's';
        plotter.vp.time.displayCount = 3;
        return plotter;
    }
    const source = timedPlotter([0, 1, 2, 3, 4, 200, 205, 500]);
    Object.assign(source.vp.time, { autoFollow: true, followLag: 0, followTime: { lag: 0, span: 100 } });
    source._panXToFraction(.5);
    const saved = captureWidgetViewport(source);
    assert.equal(saved.time.autoFollow, false);
    assert.equal(saved.time.followLag, undefined);
    assert.equal(saved.time.startFraction, .5);
    assert.deepEqual(saved.time.followTime, { lag: 200, span: 100 });
    const restored = timedPlotter([1000, 1010, 1015, 1120, 1212, 1300, 1400, 1500]);
    restored._frozenTimeEnd = 1234;
    restoreWidgetViewport(restored, saved);
    assert.deepEqual({ ...restored._timeZoomBounds() }, { first: 1200, last: 1300 });
    assert.equal(restored.vp.time.scrollOffset, 4);
    assert.equal(restored.vp.time.followLag, undefined);
    restored.frames.append([8], Uint8Array.of(8), '', 9, 1600);
    restored.invalidateData();
    assert.deepEqual({ ...restored._timeZoomBounds() }, { first: 1200, last: 1300 });
    assert.equal(captureWidgetViewport(restored).time.startFraction, .4);
    restoreWidgetViewport(restored, state());
    assert.equal(restored._frozenTimeEnd, null);
});

test('capture saves independent portable ranges without source coordinates', () => {
    const { captureWidgetViewport } = viewportApi();
    const first = createPlotter(), second = createPlotter();
    first.plotWindowPoints = 64;
    Object.assign(first.vp.time, { displayCount: 32, scrollOffset: 24, autoFollow: false });
    Object.assign(first.vp.frequency, { displayCount: 17, scrollOffset: 8, autoFollow: false });
    first._timeCenterOrder = 41;
    first._boxZoomY.time = { min: 10, max: 20 };
    first._zoomBaseY.time = { min: 0, max: 100, yScale: 'linear' };
    const saved = captureWidgetViewport(first);
    assert.equal(saved.time.startFraction, 0.25);
    assert.equal(saved.frequency.startFraction, 0.5, '64 input samples produce 33 bins');
    assert.deepEqual(saved.time.yZoom, { min: 10, max: 20,
        base: { min: 0, max: 100, yScale: 'linear' } });
    assert.equal(captureWidgetViewport(second).time.displayCount, 1000);
    assert.doesNotMatch(JSON.stringify(saved), /order|byte|timestamp|scrollOffset|timeCenter/i);
    saved.time.yZoom.base.max = 500;
    assert.equal(first._zoomBaseY.time.max, 100);
});

test('restore maps history to current samples and restores Y panning and frequency bins', () => {
    const { restoreWidgetViewport, captureWidgetViewport } = viewportApi();
    const plotter = createPlotter(128, 10001), saved = state();
    plotter.isPaused = true;
    plotter.displayMode = 'frequency';
    plotter.sampleRateHz = 500;
    saved.time.yZoom = { min: 10, max: 20,
        base: { min: 0, max: 100, yScale: 'linear' } };
    saved.frequency.displayCount = 5;
    saved.frequency.yZoom = { min: 0.05, max: 0.5,
        base: { min: 0, max: 2, yScale: { type: 'log-linear', linearThreshold: 0.02 } } };
    const originalFrames = plotter.frames, version = originalFrames.version;
    assert.equal(restoreWidgetViewport(plotter, saved), true);
    assert.equal(plotter.vp.time.scrollOffset, 24);
    assert.equal(plotter.vp.time.autoFollow, false);
    assert.equal(plotter._timeCenterOrder, 10041, 'the new session supplies the center order');
    assert.equal(plotter.currentTimeFrameIndex(), 40);
    assert.equal(plotter.vp.frequency.scrollOffset, 6, '32 paused samples produce 17 bins');
    assert.equal(plotter.vp.frequency.autoFollow, false);
    assert.equal(plotter._cachedScrollTotal, 17);
    assert.equal(plotter.frames, originalFrames);
    assert.equal(plotter.frames.version, version);
    assert.equal(plotter.sampleRateHz, 500);
    plotter.draw();
    assert.equal(plotter._drawState.min, 0.05);
    assert.equal(plotter._drawState.yScale.linearThreshold, 0.02);
    plotter._panYToFraction(0);
    assert.ok(plotter._boxZoomY.frequency.max > 1.99);
    assert.equal(captureWidgetViewport(plotter).time.startFraction, 0.25);
    plotter.displayMode = 'time';
    plotter.draw();
    assert.equal(plotter._drawState.startIdx, 24);
    assert.equal(plotter._drawState.visibleCnt, 32);
    assert.equal(plotter._drawState.min, 10);
});

test('empty numeric and raw buffers defer restoration until samples exist', () => {
    const { restoreWidgetViewport } = viewportApi();
    const plotter = createPlotter(0), saved = state();
    assert.equal(restoreWidgetViewport(plotter, saved), false);
    plotter.frames.setRawMode(true);
    plotter.frames.appendRaw(Uint8Array.of(1, 2));
    assert.equal(restoreWidgetViewport(plotter, saved), false);
    plotter.frames.clear();
    plotter.frames.setRawMode(false);
    for (let i = 0; i < 128; i++) plotter.frames.append([i]);
    assert.equal(restoreWidgetViewport(plotter, saved), true);
    assert.equal(plotter.vp.time.scrollOffset, 24);
});

test('saved boundary jumps restore legal time windows and FFT spans', () => {
    const { captureWidgetViewport, restoreWidgetViewport } = viewportApi();
    const plotter = createPlotter();
    plotter.isPaused = true;
    plotter.setPlotWindowPoints(32);
    for (const [index, start] of [[0, 0], [127, 96]]) {
        plotter.jumpToFrame(index);
        plotter.setDisplayOptions({ displayMode: 'frequency' });
        plotter.draw();
        assert.equal(plotter._cachedScrollTotal, 17, 'boundary navigation retains all 32 FFT input samples');
        const saved = captureWidgetViewport(plotter);
        assert.equal(restoreWidgetViewport(plotter, saved), true);
        plotter.setDisplayOptions({ displayMode: 'time' });
        plotter.draw();
        assert.equal(plotter._drawState.startIdx, start);
        assert.equal(plotter._drawState.visibleCnt, 32);
        assert.deepEqual({ ...plotter._frequencyInputRange() }, { start, end: start + 32 });
    }
});

test('following restores the latest window while preserving zoom counts as data grows', () => {
    const { restoreWidgetViewport } = viewportApi();
    const plotter = createPlotter(1), saved = state();
    saved.time.autoFollow = true;
    saved.frequency.autoFollow = true;
    saved.frequency.displayCount = 5;
    assert.equal(restoreWidgetViewport(plotter, saved), true);
    assert.equal(plotter.vp.time.displayCount, 32);
    assert.equal(plotter.vp.time.scrollOffset, 0);
    assert.equal(plotter._timeCenterOrder, null);
    for (let i = 1; i < 128; i++) plotter.frames.append([i]);
    plotter.invalidateData();
    assert.equal(plotter.vp.time.displayCount, 32);
    assert.equal(plotter.vp.time.scrollOffset, 96);
    assert.equal(restoreWidgetViewport(plotter, saved), true);
    assert.equal(plotter.vp.frequency.displayCount, 5);
    assert.equal(plotter.vp.frequency.scrollOffset, 60);
    assert.equal(plotter.vp.frequency.autoFollow, true);
});

test('normalization rejects malformed saved ranges and strips runtime properties', () => {
    const { normalizeWidgetViewport } = viewportApi();
    for (const bad of [null, [], {}, { time: state().time }])
        assert.throws(() => normalizeWidgetViewport(bad));
    for (const [key, values] of Object.entries({ displayCount: [0, -1, NaN, Infinity, '32'],
        autoFollow: [0, 'false'], startFraction: [-0.1, 1.1, NaN, '0.5'],
        yZoom: [[], { min: 0, max: 0 }, { min: 2, max: 1 }, { min: 0, max: Infinity },
            { min: '0', max: 1 }, { min: 0, max: 1, base: { min: 0, max: 2, yScale: 'bad' } },
            { min: 0, max: 1, base: { min: 0, max: 2,
                yScale: { type: 'log-linear', linearThreshold: 0 } } }] })) {
        for (const value of values) {
            const invalid = state();
            invalid.time[key] = value;
            assert.throws(() => normalizeWidgetViewport(invalid), `${key}: ${JSON.stringify(value)}`);
        }
    }
    const input = state();
    input.time.rawByteOffset = 123;
    input.frequency.order = 456;
    delete input.time.yZoom;
    assert.deepEqual(normalizeWidgetViewport(input), state());
});
