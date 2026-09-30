const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('plotter uses the full sample window for CSV and bounds draw work to pixels', () => {
    let lineToCount = 0;
    const ctx = new Proxy({}, { get: (_, key) => key === 'measureText'
        ? () => ({ width: 50 })
        : key === 'lineTo' ? (x, y) => {
            assert.ok(Number.isFinite(x) && Number.isFinite(y)); lineToCount++;
        } : key === 'fillRect' ? (x, y, w, h) => {
            assert.ok([x, y, w, h].every(Number.isFinite));
        } : () => {} });
    const element = () => ({ style: {}, offsetHeight: 12, clientWidth: 800,
        addEventListener() {}, getBoundingClientRect: () => ({ width: 800, height: 400 }) });
    const elements = new Map();
    const canvas = { ...element(), parentElement: element(), getContext: () => ctx };
    elements.set('waveform-canvas', canvas);
    const document = { getElementById: id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    }, addEventListener() {} };
    const context = vm.createContext({
        document, window: { addEventListener() {} }, performance, requestAnimationFrame() {}, console
    });
    for (const file of ['projectLimits.js', 'frameBuffer.js', 'plotMath.js',
        'spectrum.js', 'csvExport.js', 'plotter.js']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context, { filename: file });
    }
    const { Plotter, FrameBuffer, exportFrameCsv } = context.SerialPlotter;
    const frames = new FrameBuffer(1, 1000);
    const plotter = new Plotter('waveform-canvas', frames);
    assert.equal(plotter.frames, frames, 'the application-owned buffer is shared with the view');
    plotter.setChannelCount(2);
    let batchDraws = 0;
    const drawBeforeBatch = plotter.draw.bind(plotter);
    plotter.draw = () => { batchDraws++; };
    plotter.setChannelSettings([
        { name: 'first', color: '#112233', visible: true },
        { name: 'CH2', color: '#445566', visible: false }
    ]);
    assert.equal(batchDraws, 1);
    assert.equal(plotter.getChannelMeta().map(ch => ch.name).join(','), 'first,CH2');
    plotter.draw = drawBeforeBatch;
    plotter.setChannelVisible(0, true);
    plotter.setChannelVisible(1, true);
    plotter.setChannelName(0, 'a,b');
    plotter.setMaxPoints(5000);
    for (let i = 0; i < 6000; i++) plotter.addFrame([i, -i], Uint8Array.of(i & 255), 't');
    plotter.draw();
    assert.equal(plotter.frames.length, 5000);
    assert.equal(plotter.frames.getValue(0, 0), 1000);
    assert.ok(exportFrameCsv(frames, plotter.getChannelMeta()).startsWith('Index,"a,b",CH2\r\n0,1000,-1000\r\n'));
    assert.ok(lineToCount < 10000, `draw called lineTo ${lineToCount} times`);
    plotter.setDisplayOptions({ displayMode: 'frequency' });
    const start = performance.now();
    plotter.draw();
    console.log(`two-channel FFT draw in ${(performance.now() - start).toFixed(1)} ms`);
    assert.equal(elements.get('plot-scrollbar-thumb').style.width, '195px');
    plotter.setChannelCount(23);
    plotter.setAllChannelsVisible(true);
    for (let i = 0; i < 5000; i++) plotter.addFrame(Array.from({ length: 23 }, (_, c) => i + c));
    const allStart = performance.now();
    plotter.draw();
    console.log(`23-channel FFT draw in ${(performance.now() - allStart).toFixed(1)} ms`);
    const cachedStart = performance.now();
    plotter.draw();
    console.log(`23-channel cached draw in ${(performance.now() - cachedStart).toFixed(1)} ms`);
    plotter.clear();
    assert.equal(plotter._scrollTotal(), 0);
    plotter.setDisplayOptions({ displayMode: 'time' });
    plotter.addFrame(new Array(23).fill(NaN));
    plotter.addFrame(new Array(23).fill(1));
    plotter.draw();
    let summary;
    plotter.onStatsUpdate = value => { summary = value; };
    plotter.setAllChannelsVisible(false);
    plotter.setChannelVisible(0, true);
    plotter.draw();
    assert.equal(summary.mean, 1);
});
