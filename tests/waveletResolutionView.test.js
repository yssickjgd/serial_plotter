const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { WaveletWindow, heatmapColorScale } = require('../waveletPlot');
const { createWaveletProcessor } = require('../wavelet');

const source = count => {
    const frames = new FrameBuffer(1, count);
    for (let i = 0; i < count; i++) frames.append([Math.cos(i / 10)], undefined, '', i + 1, i);
    return frames;
};
const clock = i => ({ time: i / 1000, rate: 1000 });
const base = { channel: 0, basis: 'morlet' };

test('wavelet views share pending coefficients only for identical source windows and cancel independently', async t => {
    const queued = [], pool = { runTask(task, { signal }) {
        return new Promise(resolve => queued.push({ task, signal, resolve }));
    } };
    const frames = source(256);
    const reads = t.mock.method(frames, 'copyChannel');
    const views = Array.from({ length: 5 }, () => new WaveletWindow(pool, () => {}));
    t.after(() => views.forEach(view => view.clear()));
    const update = (view, data, options) => view.update(data, 0, data.length, clock, { ...base, ...options }, null, true);
    update(views[0], frames, { viewMode: 'magnitude' });
    update(views[1], frames, { viewMode: 'phase' });
    assert.equal(queued.length, 1);
    assert.equal(reads.mock.callCount(), 1);
    update(views[2], frames, { frequencyScale: 'linear' });
    update(views[3], source(256), {});
    update(views[4], frames, { edgeExtension: 'zero' });
    assert.equal(queued.length, 4);
    assert.equal(queued[0].task.edgeExtension, 'mirror');
    assert.equal(queued[3].task.edgeExtension, 'zero', 'different boundary values require their own coefficients');
    views[0].clear();
    assert.equal(queued[0].signal.aborted, false);
    views[2].clear();
    assert.equal(queued[1].signal.aborted, true);
    const proc = createWaveletProcessor(queued[0].task);
    proc.step(Infinity);
    queued[0].resolve(proc.result());
    await Promise.resolve();
    assert.equal(views[1].snapshot.result, proc.result());
    assert.equal(views[0].snapshot, null);
});

test('returning from a crop reuses the retained full wavelet window until the underlying data changes', () => {
    const frames = source(256), job = new WaveletWindow(null, () => {});
    const update = zoom => job.update(frames, 0, frames.length, clock, base, zoom, true);
    update(null);
    const original = job.snapshot.result;
    update([.1, .15]);
    assert.notEqual(job.snapshot.result, original);
    update(null);
    assert.equal(job.snapshot.result, original);
    frames.append([10], undefined, '', 257, 256);
    update(null);
    assert.notEqual(job.snapshot.result, original);
});

test('resetting the wavelet widget restores the full grid and publishes its automatic column count', t => {
    const { bootArrayApplication } = require('./helpers/widgetAppHarness');
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const { source, view } = f.app.widgets.create({ type: 'wavelet', settings: {
        freezeXOnZoom: true, frequencyRows: 3
    } });
    view.wavelet.pool = null;
    view.setPaused(true);
    source.sampleRate.rate = 1000;
    for (let i = 0; i < 1000; i++) source.frames.append([Math.cos(i / 10)], undefined, '', i + 1, i);
    const columns = [];
    view.onWaveletResolutionInfo = () => columns.push(view.wavelet.snapshot?.result.fullColumns);
    view.renderNow();
    const full = view.wavelet.snapshot;
    const crop = () => { view.setZoom([.81, .92], null); view.renderNow(); };
    crop();
    assert.notEqual(columns.at(-1), full.result.fullColumns);
    view.resetZoom();
    view.renderNow();
    assert.equal(view.waveletDrawSnapshot.result, full.result, 'the widget reset reuses the retained matrix');
    assert.equal(columns.at(-1), full.result.fullColumns);

    crop();
    source.frames.append([7], undefined, '', 1001, 1000);
    view.wavelet.pool = { runTask() { return new Promise(() => {}); } };
    view.followLatest();
    assert.equal(view.wavelet.displaySnapshot(null), null, 'CSV cannot access the previous window after returning to live data');
    assert.throws(() => view.exportSvg(), /分辨率/);
    view.renderNow();
    assert.equal(view.waveletDrawSnapshot, null, 'pending current data cannot display the old transform as the latest');
    view.wavelet.cancel(); view.wavelet.pool = null; view.renderNow();
    assert.notEqual(view.waveletDrawSnapshot.result, full.result);
    assert.equal(view.waveletDrawSnapshot.lastTime, 1);
    assert.equal(view.wavelet.displaySnapshot(null), view.waveletDrawSnapshot);
});

test('a cancelled wavelet job settling late cannot remove its replacement from the sharing table', async t => {
    const queued = [], frames = source(128);
    const pool = { runTask(task, { signal }) { return new Promise((resolve, reject) => queued.push({ reject, signal })); } };
    const views = Array.from({ length: 3 }, () => new WaveletWindow(pool, () => {}));
    t.after(() => views.forEach(view => view.clear()));
    const update = view => view.update(frames, 0, frames.length, clock, base, null, true);
    update(views[0]);
    views[0].clear();
    update(views[1]);
    queued[0].reject(new Error('cancelled'));
    await Promise.resolve();
    update(views[2]);
    assert.equal(queued.length, 2);
    views[1].clear();
    assert.equal(queued[1].signal.aborted, false);
    views[2].clear();
    assert.equal(queued[1].signal.aborted, true);
});

test('live wavelet starts the latest window on the next paint and coalesces input during a transform', async t => {
    let now = 500;
    t.mock.method(performance, 'now', () => now);
    const queued = [], pool = { available: true, runTask(task) {
        return new Promise(resolve => queued.push({ task, resolve }));
    } };
    const window = new WaveletWindow(pool, () => {});
    t.after(() => window.clear());
    const frames = source(256);
    const update = () => window.update(frames, 0, frames.length, clock, { ...base, frequencyRows: 2 }, null, false);
    update();
    for (let i = 256; i < 264; i++) {
        frames.append([i], undefined, '', i + 1, i);
        update();
    }
    assert.equal(queued.length, 1);
    const processor = createWaveletProcessor(queued[0].task);
    processor.step(Infinity);
    queued[0].resolve(processor.result());
    await Promise.resolve();
    now += 17;
    update();
    assert.equal(queued.length, 2);
    assert.equal(queued[1].task.values.at(-1), 263);
});

test('edited resolution cancels old requests and only publishes coefficients for the committed choices', async () => {
    const queued = [];
    const pool = { runTask(task, { signal }) {
        return new Promise(resolve => queued.push({ task, signal, resolve }));
    } };
    const info = [];
    const frames = source(256), job = new WaveletWindow(pool, () => {}, x => info.push(x));
    const run = settings => job.update(frames, 0, frames.length, clock, settings, null, true);
    const finish = async request => {
        const proc = createWaveletProcessor(request.task);
        proc.step(Infinity);
        request.resolve(proc.result());
        await Promise.resolve();
    };
    run(base); await finish(queued[0]);
    const old = job.snapshot;
    run({ ...base, frequencyRows: 7, timeStride: 2 });
    assert.equal(job.displaySnapshot(null, true), old);
    assert.equal(job.displaySnapshot(null), null);
    run({ ...base, frequencyRows: 33, timeStride: 4 });
    assert.ok(queued[1].signal.aborted);
    await finish(queued[1]); assert.equal(job.snapshot, old);
    await finish(queued[2]);
    assert.equal(job.displaySnapshot(null).result.frequencies.length, 33);
    assert.equal(job.snapshot.result.hop, 4);
    // The inspector also refreshes when automatic grid dimensions are ready.
    assert.equal(info.length, 3);
    assert.deepEqual(info.at(-1), { count: 256, rate: 1000 });
    job.clear();
    assert.equal(info.at(-1), null);
});

test('a grid over budget keeps navigable time bounds and can compute a narrow selection at full density', () => {
    const frames = source(10240), queued = [];
    const job = new WaveletWindow({ runTask(task) { queued.push(task); return new Promise(() => {}); } }, () => {});
    const run = zoom => job.update(frames, 0, frames.length, clock,
        { ...base, frequencyRows: 8193, timeStride: 1 }, zoom, true);
    run(null);
    assert.equal(queued.length, 0);
    assert.match(job.error, /MiB/);
    assert.deepEqual(job.requestedWindow.retained, [0, 10.239]);
    assert.equal(job.displaySnapshot(null), null);
    run([4.5, 4.55]);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].timeStride, 1);
    assert.equal(queued[0].frequencyRows, 8193);
    assert.ok(queued[0].last - queued[0].first < 60);
    assert.equal(job.error, '');
    job.clear();
});

test('changing slider settings on a zoomed plot preserves the viewport and exports only the new result', async t => {
    const { bootArrayApplication } = require('./helpers/widgetAppHarness');
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wavelet', settings: { freezeXOnZoom: true } });
    const { view, source } = widget;
    source.sampleRate.rate = 1000;
    for (let i = 0; i < 256; i++) source.frames.append([Math.cos(i / 10)], undefined, '', i + 1, i);
    const settle = async () => { for (let i = 0; i < 3; i++) await f.tick(); };
    view.renderNow(); await settle();
    const right = view.range[1];
    view.setZoom([right - .1, right - .02], [20, 240]); view.renderNow(); await settle();
    const previous = [...view.range];
    view.setSettings({ ...view.settings, timeColumns: 72, frequencyRows: 42 });
    view.renderNow();
    assert.throws(() => view.exportSvg(), /分辨率/);
    await settle();
    assert.deepEqual([...view.range], previous);
    assert.equal(view.waveletDrawSnapshot.result.fullColumns, 72);
    assert.ok(view.waveletDrawSnapshot.result.columns < 72);
    assert.equal(view.waveletDrawSnapshot.result.positions.length, view.waveletDrawSnapshot.result.columns);
    assert.equal(view.waveletDrawSnapshot.result.frequencies.length, 42);
    assert.match(view.exportSvg(), /data-wavelet-heatmap/);
});

test('editing the wavelet extension invalidates pending work and labels the resulting reference regions', async t => {
    const { bootArrayApplication } = require('./helpers/widgetAppHarness');
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const { view, source } = f.app.widgets.create({ type: 'wavelet', settings: { frequencyRows: 3 } });
    source.sampleRate.rate = 1000;
    for (let i = 0; i < 256; i++) source.frames.append([Math.sin(i / 10)], undefined, '', i + 1, i);
    view.setPaused(true);
    const tasks = [];
    view.wavelet.pool = { runTask(task) {
        return new Promise(resolve => tasks.push({ task, resolve }));
    } };
    view.renderNow();
    view.setSettings({ ...view.settings, edgeExtension: 'hold' });
    view.renderNow();
    assert.equal(tasks[1].task.edgeExtension, 'hold');
    const obsolete = createWaveletProcessor(tasks[0].task);
    obsolete.step(Infinity);
    tasks[0].resolve(obsolete.result());
    await Promise.resolve();
    assert.equal(view.wavelet.snapshot, null);
    view.wavelet.cancel(); view.wavelet.pool = null;
    for (const [mode, label] of [['zero', '0 填充'], ['hold', '端点保持']]) {
        view.setSettings({ ...view.settings, edgeExtension: mode });
        assert.equal(view.waveletDrawSnapshot, null);
        view.renderNow();
        assert.ok(view.svg.querySelector('[data-wavelet-reference]').textContent.includes(label));
        assert.ok(view.exportSvg().includes(label));
        view.hover({ x: view.area.left, y: view.area.top + view.area.height / 2 });
        assert.ok(view.overlay.textContent.includes(label));
    }
});

test('switching the wavelet frequency axis recalculates retained samples and exports the selected frequency rows', async t => {
    const { bootArrayApplication } = require('./helpers/widgetAppHarness');
    const { waveletCsv } = require('../waveletPlot');
    const f = bootArrayApplication(); t.after(() => f.app.dispose());
    const widget = f.app.widgets.create({ type: 'wavelet', settings: {
        channel: 0, basis: 'mexicanHat', frequencyRows: 3, timeColumns: 1, frequencyScale: 'log'
    } });
    const { view, source } = widget;
    source.sampleRate.rate = 1000;
    for (let i = 0; i < 256; i++) source.frames.append([Math.cos(i / 10)], undefined, '', i + 1, i);
    const settle = async () => { view.renderNow(); for (let i = 0; i < 3; i++) await f.tick(); };
    await settle();
    const log = view.waveletDrawSnapshot.result;
    const [low, middle, high] = log.frequencies;
    assert.ok(Math.abs(middle - Math.sqrt(low * high)) < 1e-10);
    for (const scale of ['linear', 'log']) {
        view.setSettings({ ...view.settings, frequencyScale: scale });
        assert.throws(() => view.exportSvg(), /分辨率/);
        assert.equal(view.wavelet.displaySnapshot(null, true), null);
        await settle();
        const snapshot = view.waveletDrawSnapshot;
        const expected = scale === 'linear' ? (low + high) / 2 : middle;
        assert.ok(Math.abs(snapshot.result.frequencies[1] - expected) < 1e-10);
        assert.equal(snapshot.result.frequencies[0], low);
        assert.equal(snapshot.result.frequencies[2], high);
        const csv = [...waveletCsv(snapshot)].join('').trim().split(/\r?\n/).slice(1);
        assert.deepEqual(csv.map(row => Number(row.split(',')[1])), [...snapshot.result.frequencies]);
        assert.match(view.exportSvg(), /data-wavelet-heatmap/);
    }
});

test('large no-worker calculations yield and can be cancelled before retaining a matrix', async () => {
    const frames = source(1200);
    let redraws = 0;
    const job = new WaveletWindow(null, () => { redraws++; });
    job.update(frames, 0, frames.length, clock, { ...base, frequencyRows: 901, timeStride: 1 }, null, true);
    assert.ok(job.request);
    assert.ok(!job.snapshot);
    job.update(frames, 0, frames.length, clock, { ...base, frequencyRows: 901, timeStride: 512 }, null, true);
    assert.ok(job.request, 'computing hundreds of frequency scales still yields with sparse output columns');
    job.clear();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(redraws, 0);
    assert.equal(job.snapshot, null);
});

test('zoom inside a retained analysis window preserves the original rounded centers and their coefficients', () => {
    const frames = source(1400), windowPoints = 256;
    const settings = { ...base, timeColumns: 21, frequencyRows: 7 };
    const job = new WaveletWindow(null, () => {});
    const update = zoom => job.update(frames, frames.length - windowPoints, frames.length,
        clock, settings, zoom, true, { windowPoints });
    update(null);
    const full = job.snapshot;
    const zoom = [1.187, 1.251];
    update(zoom);
    const selected = job.snapshot;
    assert.equal(selected.t0, full.t0);
    assert.equal(selected.lastTime, full.lastTime);
    assert.ok(selected.result.columns < full.result.columns);
    for (const [column, sample] of selected.result.positions.entries()) {
        const index = full.result.positions.indexOf(sample);
        assert.ok(index >= 0);
        assert.equal(selected.result.magnitude[column], full.result.magnitude[index]);
    }
    update([.321, .405]);
    assert.ok(job.snapshot.lastTime < full.t0);
    assert.ok(job.displaySnapshot([.321, .405]));
});

test('block-indexed color scale matches a direct viewport scan, including gaps and phase masking', () => {
    const count = 2048;
    const values = Float64Array.from({ length: count }, (_, i) => i % 721 === 0 ? NaN : Math.cos(i / 10));
    const proc = createWaveletProcessor({ values, basis: 'morlet', rate: 1000, frequencyRows: 601, timeStride: 1 });
    proc.step(Infinity);
    const result = proc.result();
    assert.equal(result.blockWidth, 128);
    const viewport = { range: [.081, 1.929, 3.14, 410.62] };
    for (const phase of [false, true]) {
        const indexed = heatmapColorScale(viewport, { result, t0: 0, rate: 1000 }, phase);
        const linear = heatmapColorScale(viewport, { result: { ...result, blockWidth: 0 }, t0: 0, rate: 1000 }, phase);
        assert.deepEqual(indexed, linear);
    }
    const highest = result.frequencies.at(-1);
    const highBand = { range: [.081, 1.929, highest - .001, 500] };
    const scale = heatmapColorScale(highBand, { result, t0: 0, rate: 1000 }, true);
    const direct = heatmapColorScale(highBand, { result: { ...result, blockWidth: 0 }, t0: 0, rate: 1000 }, true);
    assert.deepEqual(scale, direct);
    assert.ok(scale.max > 0, 'the highest computed row can have a visible phase');
});
