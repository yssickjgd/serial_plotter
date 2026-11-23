const test = require('node:test');
const assert = require('node:assert/strict');
const { planWorkspaceChannels, WorkspaceChannelCapture } = require('../workspaceChannels');
const { FrameBuffer } = require('../frameBuffer');
const { CaptureHistory } = require('../captureHistory');

function channel(sourceId, number) {
    return { sourceId, channelId: 'raw:' + number, number, name: sourceId + number, color: '#123456' };
}

test('automatic mapping packs sources in order and preserves formula references by stable identity', () => {
    const first = channel('serial-2', 1), second = channel('primary', 1);
    const previous = { mappings: [first], channelDefinitions: [
        { id: 'twice', type: 'formula', number: 2, expression: 'CH00001 * 2' },
        { id: 'sum', type: 'formula', number: 3, expression: 'CH00002 + CH00001' }
    ], channelNames: ['serial-21', 'twice', 'sum'], channelColors: [] };
    const plan = planWorkspaceChannels(previous, [second, first, channel('serial-2', 2)]);
    assert.deepEqual([...plan.numberMap], [[1, 2], [2, 4], [3, 5]]);
    assert.deepEqual(plan.globals.channelDefinitions.map(({ id, number, expression }) => [id, number, expression]),
        [['twice', 4, 'CH00002 * 2'], ['sum', 5, 'CH00004 + CH00002']]);
    assert.throws(() => planWorkspaceChannels(previous, [second]), /引用/);
});

test('global sampling holds independent sources on a shared clock and expires missing inputs', () => {
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
        sampleRate: 1000, holdMs: 5,
        channelDefinitions: [{ id: 'delta', type: 'formula', number: 3, expression: 'CH1 - CH2' }] }, 40);
    const events = [
        { time: 10, values: [[0, 15]], origin: { sourceId: 'primary', order: 1 } },
        { time: 10, values: [[1, 4]], origin: { sourceId: 'serial-2', order: 1 } },
        { time: 11, values: [[0, 16]], origin: { sourceId: 'primary', order: 2 } },
        { time: 15, values: [[0, 18]], origin: { sourceId: 'primary', order: 3 } }
    ];
    capture.ingest(events);
    const frames = capture.numericSource.frames;
    assert.equal(frames.getValue(2, 0), 11);
    assert.equal(frames.getValue(2, 1), 12);
    assert.equal(frames.statusAt(1, 1), 'held');
    assert.ok(Number.isNaN(frames.getValue(2, 5)));
    assert.equal(frames.provenanceAt(1, 1).sourceId, 'serial-2');
    assert.equal(frames.orderAt(1), 2);
    assert.deepEqual(frames.rawTraceAt(1, 0, 6).times, [10]);
    assert.deepEqual(frames.provenanceInfoAt(2, 0).origins.map(origin => origin.sourceId).sort(), ['primary', 'serial-2']);
});

test('bulk synchronized reads retain individual values without per-sample random access', () => {
    for (const method of ['hold', 'nearest', 'linear', 'quadratic', 'spline']) {
        const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
            methods: { primary: method }, holdMs: 12 }, 128);
        const events = (from, to, index, pitch) => Array.from({ length: to - from }, (_, i) => {
            const time = (i + from) * pitch;
            return { time, values: [[index, i % 19 === 5 ? NaN : time ** 2]], origin: { breakBefore: i === 9 } };
        });
        capture.ingest([...events(0, 40, 0, 2.5), ...events(0, 60, 1, 2)].sort((a, b) => a.time - b.time));
        // The primary source advances in order, but the other source has already sealed these times.
        capture.ingest(events(40, 65, 0, 2.5));
        const frames = capture.numericSource.frames;
        const expected = Array.from({ length: 77 }, (_, i) => frames.getValue(0, i + 1));
        assert.ok(expected.some(Number.isFinite));
        const get = frames.getValue;
        frames.getValue = () => { throw new Error('bulk reads must advance through the existing event order'); };
        try { assert.deepEqual([...frames.copyChannel(0, 1, 78)], expected, method); }
        finally { frames.getValue = get; }
    }
});

test('widgets with the same global view share raw trace snapshots until the next capture update', () => {
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1)] }, 128);
    const events = time => ({ time, values: [[0, time]], origin: {} });
    capture.ingest([events(0), events(1), events(2)]);
    const frames = capture.numericSource.frames, trace = frames.rawTraceAt(0, 0, 3);
    assert.equal(frames.rawTraceAt(0, 0, 3, { first: 0, last: 2 }), trace);
    const other = frames.rawTraceAt(0, 0, 2, { first: 0, last: 1 });
    assert.deepEqual(other.times, [0, 1]);
    assert.equal(frames.rawTraceAt(0, 0, 3), trace, 'different widget windows can coexist');
    capture.ingest([events(3)]);
    assert.notEqual(frames.rawTraceAt(0, 0, 3), trace);
    assert.deepEqual(frames.rawTraceAt(0, 0, 4).values, [0, 1, 2, 3]);
});

function lane(id, frames, { timeOffsetMs = 0 } = {}) {
    const history = new CaptureHistory();
    const buffer = new FrameBuffer(2, 128);
    for (const [index, [timestamp, signal, marker]] of frames.entries()) {
        const bytes = Uint8Array.of(signal);
        history.append(bytes, { timestamp });
        buffer.append([signal, marker], bytes, '', 1 + index / (frames.length + 1), timestamp, { byteOffset: index, endByte: index + 1 });
    }
    return { settings: { id, timeOffsetMs }, capture: { history, epoch: 0, dataEngine: {
        mode: 'Data_Array', arraySource: { frames: buffer, generation: 0 },
        globals: { channelRecords: [{ number: 1, id: 'raw:1', type: 'raw' }, { number: 2, id: 'raw:2', type: 'raw' }] }
    } } };
}

test('different fixed source rates ignore host read batches and known sequence gaps affect only that source', () => {
    const primary = lane('primary', [[1000, 10, 20], [1000, 11, 21], [1009, 13, 23], [1009, 14, 24]]);
    const secondary = lane('serial-2', [[1000, 20], [1009, 25]], { timeOffsetMs: 1 });
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
        timebases: { primary: { mode: 'fixed', sampleRate: 1000, sequenceChannelId: 'raw:2' },
            'serial-2': { mode: 'fixed', sampleRate: 200 } } }, 128);
    let pending = capture.collect([primary, secondary], Infinity, 2);
    for (let attempt = 0; attempt < 20 && Number.isFinite(pending); attempt++)
        pending = capture.collect([primary, secondary], Infinity, 2);
    assert.equal(pending, Infinity);
    const buffer = capture.numericSource.frames;
    const first = buffer.rawTraceAt(0, 0, buffer.length), second = buffer.rawTraceAt(1, 0, buffer.length);
    assert.deepEqual(first.times.filter((time, index) => Number.isFinite(first.values[index])), [1000, 1001, 1003, 1004]);
    assert.deepEqual(second.times, [1001, 1006]);
    assert.ok(Number.isNaN(buffer.getValue(0, 2)));
    assert.equal(buffer.getValue(1, 2), 20);
    const zoom = buffer.rawTraceAt(1, 2, 5);
    assert.deepEqual(zoom.times, [1002, 1004]);
    assert.deepEqual(zoom.values, [21, 23]);
    assert.equal(zoom.syntheticStart && zoom.syntheticEnd, true);
    assert.equal(buffer.locateOrigin('primary', 2, true).timestamp, 1003);
    assert.equal(buffer.locateOrigin('serial-2', 1004).origin.byteOffset, 1);
});

test('device clocks preserve a common sample time and replay retained history with independent anchors', () => {
    const primary = lane('primary', [[1000, 10, 1000], [1007, 12, 1002]]);
    const secondary = lane('serial-2', [[1004, 9, 1], [1010, 11, 1.002]]);
    const common = { mode: 'device', timestampChannelId: 'raw:2', deviceClock: 'shared' };
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
        timebases: { primary: { ...common, timestampUnit: 'ms' }, 'serial-2': { ...common, timestampUnit: 's' } } }, 128);
    // Millisecond and second representations of the same device counter line up despite different host arrival times.
    capture.collect([primary, secondary]);
    const old = capture.numericSource.frames;
    assert.deepEqual(old.rawTraceAt(1, 0, old.length).times, [1000, 1002]);
    assert.equal(old.getValue(1, 0), 9);
    const oldRawBytes = [primary.capture.history.endByte, secondary.capture.history.endByte];
    capture.timebases['serial-2'] = { ...capture.timebases['serial-2'], deviceClock: 'anchored' };
    const stage = capture.createAlignmentReplay();
    stage.collect([primary, secondary]);
    assert.equal(capture.numericSource.frames, old);
    assert.deepEqual(old.rawTraceAt(1, 0, old.length).times, [1000, 1002]);
    capture.finishAlignmentReplay(stage);
    const next = capture.numericSource.frames;
    assert.deepEqual(next.rawTraceAt(1, 0, next.length).times, [1004, 1006]);
    assert.deepEqual([primary.capture.history.endByte, secondary.capture.history.endByte], oldRawBytes);
});

test('host availability gates shared timing without delaying a large negative device zero correction', () => {
    const primary = lane('primary', [[2000, 10, 1]]);
    const secondary = lane('serial-2', [[2005, 20, 1000]], { timeOffsetMs: -999000 });
    const timing = { mode: 'device', timestampChannelId: 'raw:2', deviceClock: 'shared', timestampUnit: 's' };
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
        timebases: { primary: timing, 'serial-2': timing } }, 128);
    assert.equal(capture.collect([primary, secondary], 2004), 2005);
    assert.equal(capture.collect([primary, secondary], 2005), 2025);
    assert.equal(capture.collect([primary, secondary], 2025), Infinity);
    const frames = capture.numericSource.frames;
    assert.equal(frames.length, 1);
    assert.equal(frames.timestampAt(0), 2000);
    assert.equal(frames.getValue(0, 0), 10);
    assert.equal(frames.getValue(1, 0), 20);
});


test('400 Hz samples drive 1000 Hz formulas with independently selected interpolation', () => {
    for (const [method, expected] of Object.entries({ hold: 2.5, nearest: 5, linear: 4, quadratic: 4, spline: 4 })) {
        const c = new WorkspaceChannelCapture({ mappings: [channel('primary', 1)], sampleRate: 1000,
            methods: { primary: method }, waitMs: 20, channelDefinitions: [{ number: 2, type: 'formula', expression: 'CH1*2' }] }, 128);
        c.ingest([0, 2.5, 5, 7.5].map(time => ({ time, values: [[0, time]], origin: { sourceId: 'primary' } })));
        assert.equal(c.numericSource.frames.getValue(1, 4), expected * 2);
        assert.deepEqual(c.numericSource.frames.rawTraceAt(0, 0, c.numericSource.frames.length).times, [0, 2.5, 5, 7.5]);
    }
});

test('late source samples fill their original curve positions without revising finalized formula rows', () => {
    const c = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
        methods: { 'serial-2': 'linear' }, channelDefinitions: [{ number: 3, type: 'formula', expression: 'CH1+CH2' }] }, 120);
    c.ingest([{ time: 100, values: [[0,1], [1,2]], origin: {} }, { time: 140, values: [[0,3]], origin: {} }]);
    const frames = c.numericSource.frames;
    assert.ok(Number.isNaN(frames.getValue(2, 10)));
    c.ingest([{ time: 111, values: [[1,7]], origin: {} }]);
    assert.deepEqual(frames.rawTraceAt(1, 0, frames.length).times, [100,111]);
    assert.ok(Number.isNaN(frames.getValue(2, 10)));
    assert.ok(Number.isNaN(frames.getValue(1, 10)));
});

test('pending formulas leave the first raw samples visible and expire without extrapolating', () => {
    for (const method of ['nearest', 'linear', 'quadratic', 'spline']) {
        const c = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
            methods: { primary: method }, sampleRate: 1000, waitMs: 20,
            channelDefinitions: [{ number: 3, type: 'formula', expression: 'CH1*2' }] }, 128);
        const a = lane('primary', [[1000, 7]]);
        const b = lane('serial-2', [[1000, 3], [1004, 5]]);
        c.collect([a, b], 1004);
        const frames = c.numericSource.frames;
        assert.equal(frames.length, 0);
        assert.ok(frames.hasPendingTrace);
        assert.deepEqual(frames.rawTraceAt(1, 0, 1).times, [1000, 1004]);
        c.collect([a, b], 1024);
        assert.equal(frames.hasPendingTrace, false);
        const result = frames.getValue(2, 4);
        if (method === 'nearest') assert.equal(result, 14);
        else assert.ok(Number.isNaN(result));
    }
});

test('quadratic and natural cubic interpolation have distinct nonlinear results; midpoint rounds forward', () => {
    const expected = { nearest: 4, linear: 2.5, quadratic: 2.25, spline: 2.2 };
    for (const [method, value] of Object.entries(expected)) {
        const c = new WorkspaceChannelCapture({ mappings: [channel('primary', 1)], methods: { primary: method },
            sampleRate: 2000, waitMs: 0 }, 128);
        c.ingest([0, 1, 2, 3].map(t => ({ time: t, values: [[0, t * t]], origin: {} })));
        assert.ok(Math.abs(c.numericSource.frames.getValue(0, 3) - value) < 1e-10, method);
    }
});

test('high-order recovery uses distinct timestamps and supports one-sided cubic stencils', () => {
    const squared = times => times.map(time => ({ time, values: [[0, time ** 2]], origin: time === 5
        ? { missingBefore: 2, period: 1 } : {} }));
    for (const method of ['quadratic', 'spline']) {
        const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1)],
            methods: { primary: method }, channelDefinitions: [{ number: 2, type: 'formula', expression: 'CH1' }] }, 40);
        capture.ingest(squared([0, 0, 1, 1, 2, 2, 5]));
        const frames = capture.numericSource.frames;
        const trace = frames.rawTraceAt(0, 0, frames.length);
        const expected = method === 'quadratic' ? [9, 16] : [11 - 140 / 93, 18 - 112 / 93];
        for (const [i, time] of [3, 4].entries()) {
            const index = trace.times.indexOf(time);
            assert.ok(Math.abs(trace.values[index] - expected[i]) < 1e-10, method);
            assert.ok(trace.recoveredIndices.has(index), method);
            assert.ok(Math.abs(frames.getValue(1, time) - expected[i]) < 1e-10, method + ' formula');
        }
    }
});

test('high-order recovery falls back between valid brackets and leaves expired or disconnected data blank', () => {
    for (const method of ['quadratic', 'spline']) {
        const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1)],
            methods: { primary: method }, holdMs: 5,
            channelDefinitions: [{ number: 2, type: 'formula', expression: 'CH1' }] }, 40);
        capture.ingest([
            { time: 0, values: [[0, 0]], origin: {} },
            { time: 6, values: [[0, 12]], origin: { missingBefore: 5, period: 1 } },
            { time: 10, values: [[0, 20]], origin: { breakBefore: true } }
        ]);
        const frames = capture.numericSource.frames;
        const trace = frames.rawTraceAt(0, 0, frames.length);
        assert.deepEqual([...trace.recoveredIndices ?? []].map(i => [trace.times[i], trace.values[i]]),
            [[2, 4], [3, 6], [4, 8]], method);
        assert.ok(Number.isNaN(frames.getValue(1, 1)), method + ' expired right sample');
        assert.ok(Number.isNaN(frames.getValue(1, 5)), method + ' expired left sample');
        assert.ok(Number.isNaN(frames.getValue(1, 8)), method + ' stream boundary');
        assert.ok(Number.isNaN(frames.getValue(1, 9)), method + ' stream boundary');
    }
});

test('zooming between recovered samples keeps a finite line without adding markers', () => {
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1)],
        methods: { primary: 'spline' } }, 40);
    capture.ingest([
        { time: 0, values: [[0, 0]], origin: {} },
        { time: 3, values: [[0, 6]], origin: { missingBefore: 2, period: 1 } }
    ]);
    const frames = capture.numericSource.frames;
    const trace = frames.rawTraceAt(0, 0, frames.length, { first: 1.2, last: 1.8 });
    assert.deepEqual(trace.times, [1.2, 1.8]);
    assert.ok(trace.values.every((value, index) => Math.abs(value - [2.4, 3.6][index]) < 1e-10));
    assert.equal(trace.syntheticStart && trace.syntheticEnd, true);
    assert.equal(trace.recoveredIndices, undefined);

    const start = 1700000000000, period = 1000 / 44100, end = start + 7 * period;
    capture.clear();
    capture.ingest([
        { time: start, values: [[0, 0]], origin: {} },
        { time: end, values: [[0, 6]], origin: { missingBefore: 6, period } }
    ]);
    const slot = end - 6 * period + period;
    const edge = frames.rawTraceAt(0, 0, frames.length, { first: slot, last: slot });
    assert.deepEqual(edge.times, [slot]);
    assert.deepEqual([...edge.recoveredIndices], [0]);
});

test('multiple origins skip time spent paused in both timebases, including on history replay', () => {
    const a = lane('primary', [[1000, 1], [1001, 2], [6002, 3], [6003, 4]]);
    const b = lane('serial-2', [[1000, 5], [1001, 6], [6002, 7], [6003, 8]]);
    for (const { capture } of [a, b]) {
        const history = new CaptureHistory();
        history.append(Uint8Array.of(1, 2), { timestamp: 1000 });
        history.markBoundary({ timestamp: 1002 });
        history.append(Uint8Array.of(3, 4), { timestamp: 6002 });
        capture.history = history;
    }
    for (const mode of ['receive', 'fixed']) {
        const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
            timebases: { primary: { mode }, 'serial-2': { mode } },
            channelDefinitions: [{ number: 3, type: 'formula', expression: 'CH1 + CH2' }] }, 128);
        capture.collect([a, b], 1001);
        capture.setPaused(true, 1002);
        capture.collect([a, b], 1001);
        capture.setPaused(false, 6002);
        capture.collect([a, b]);
        const replay = capture.createAlignmentReplay();
        replay.collect([a, b]);
        for (const view of [capture, replay]) {
            const frames = view.numericSource.frames;
            assert.equal(frames.length, 4, mode + (view === replay ? ' replay' : ' live'));
            assert.deepEqual(frames.rawTraceAt(0, 0, frames.length).times, [1000, 1001, 1002, 1003]);
            assert.deepEqual(frames.rawTraceAt(1, 0, frames.length).values, [5, 6, 7, 8]);
            assert.equal(frames.getValue(2, 2), 10);
            assert.equal(frames.locateOrigin('serial-2', 2, true).origin.timestamp, 6002);
            assert.equal(view.receiveTime(1003), 6003);
        }
    }
});

test('sustained loss shifts only the lagging source and repairs its plotted gap with the selected strategy', () => {
    const samples = Array.from({ length: 125 }, (_, i) => [1000 + i, i]);
    const a = lane('primary', samples.filter((_, i) => i < 3 || i >= 9));
    const b = lane('serial-2', samples);
    const expected = { linear: 108 + 1 / 7, hold: 108, nearest: 108, quadratic: 108 + 11 / 14, spline: 108 + 27 / 49 };
    for (const [method, value] of Object.entries(expected)) {
        const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)],
            timebases: { primary: { mode: 'fixed' }, 'serial-2': { mode: 'fixed' } },
            methods: { primary: method } }, 128);
        capture.collect([a, b]);
        const frames = capture.numericSource.frames;
        const trace = frames.rawTraceAt(0, 0, frames.length);
        assert.equal(frames.locateOrigin('primary', 103, true).origin.alignedTime, 1109);
        assert.equal(frames.locateOrigin('primary', 103, true).origin.missingBefore, 6);
        assert.equal(frames.locateOrigin('serial-2', 5, true).origin.alignedTime, 1005);
        assert.ok(Math.abs(trace.values[trace.times.indexOf(1103)] - value) < 1e-10, method);
        const repairedTimes = [...trace.recoveredIndices].map(index => trace.times[index]);
        assert.deepEqual(repairedTimes, [1103, 1104, 1105, 1106, 1107, 1108]);
        assert.equal(trace.values.at(-1), 124);
    }
});

test('a single delayed browser batch does not shift a fixed rate source', () => {
    const a = lane('primary', [[1000, 0], [1000, 1], [1016, 2], ...Array.from({ length: 15 }, (_, i) => [1017, i + 3])]);
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1)],
        timebases: { primary: { mode: 'fixed' } } }, 128);
    capture.collect([a]);
    const frames = capture.numericSource.frames;
    assert.deepEqual(frames.rawTraceAt(0, 0, frames.length).times, Array.from({ length: 18 }, (_, i) => 1000 + i));
});

test('live 5000-point viewport stays five seconds wide while formulas catch up after a long gap', () => {
    const capture = new WorkspaceChannelCapture({ mappings: [channel('primary', 1), channel('serial-2', 1)], sampleRate: 1000,
        channelDefinitions: [{ number: 3, type: 'formula', expression: 'CH1 + CH2' }] }, 2000000);
    capture.ingest([{ time: 1000, values: [[0, 1], [1, 2]], origin: {} }]);
    const start = 758000;
    capture.ingest(Array.from({ length: 5000 }, (_, index) => ({
        time: start + index, values: [[0, index], [1, -index]], origin: {}
    })));
    const frames = capture.numericSource.frames;
    const bounds = frames.liveTimeBounds(5000);
    assert.equal(capture.pendingGrid, true);
    assert.ok(frames.timestampAt(frames.length - 1) < bounds.first);
    assert.deepEqual(bounds, { first: start, last: start + 4999 });
    const raw = frames.rawTraceAt(0, 0, frames.length, bounds);
    assert.equal(raw.times.length, 5000);
    assert.equal(raw.times[0], bounds.first);
    assert.equal(raw.times.at(-1), bounds.last);
    assert.equal(frames.indexAtTimeBoundary(bounds.first), frames.length);
});
