const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSourceTimebase, SourceTimebase, cloneSourceTimebaseAnchors } = require('../sourceTimebase');

function sample(clock, order, receiveTime, marker, streamKey = 'port-session-1') {
    return clock.sample({ receiveTime, order, marker, streamKey });
}

test('source clock defaults to receive time and validates saved configuration', () => {
    assert.deepEqual(normalizeSourceTimebase(), {
        mode: 'receive', sampleRate: 1000, sequenceChannelId: null, sequenceWrap: null,
        timestampChannelId: null, timestampUnit: 'ms', deviceClock: 'anchored', timestampWrap: null,
        resyncEnabled: true, resyncDelayMs: 5, resyncBatches: 3, resyncConfirmationMs: 100
    });
    for (const input of [[], { mode: 'unknown' }, { sampleRate: 0 }, { sampleRate: 1000001 },
        { mode: 'device' }, { timestampChannelId: '' }, { timestampUnit: 'minutes' },
        { sequenceChannelId: 12 }, { sequenceWrap: 1.5 }, { timestampWrap: -1 }, { deviceClock: 'unknown' }]) {
        assert.throws(() => normalizeSourceTimebase(input));
    }
    assert.equal(normalizeSourceTimebase({ mode: 'fixed', sampleRate: .001 }).sampleRate, .001);
    assert.equal(normalizeSourceTimebase({ mode: 'fixed', sampleRate: 1000000 }).sampleRate, 1000000);
});

test('receive mode keeps arrival jitter and applies the integer millisecond offset', () => {
    const clock = new SourceTimebase({}, { offsetMs: -6 });
    assert.deepEqual(sample(clock, 10, 100), { time: 94, breakBefore: false });
    assert.deepEqual(sample(clock, 11, 100), { time: 94, breakBefore: false });
    assert.deepEqual(sample(clock, 12, 108), { time: 102, breakBefore: false });
    assert.deepEqual(sample(clock, 13, 109, undefined, 'port-session-2'), { time: 103, breakBefore: true });
});

test('fixed mode uses capture order to recover independent sample rates despite receive jitter', () => {
    const faster = new SourceTimebase({ mode: 'fixed', sampleRate: 1000 });
    const slower = new SourceTimebase({ mode: 'fixed', sampleRate: 200 });
    assert.deepEqual([sample(faster, 20, 100).time, sample(faster, 21, 109).time, sample(faster, 22, 109).time], [100, 101, 102]);
    assert.deepEqual([sample(slower, 3, 102).time, sample(slower, 4, 109).time, sample(slower, 5, 113).time], [102, 107, 112]);
});

test('fixed sequence mode marks a forward jump at the first missing sample', () => {
    const clock = new SourceTimebase({ mode: 'fixed', sampleRate: 500, sequenceChannelId: 'sequence' }, { offsetMs: 10 });
    assert.deepEqual(sample(clock, 0, 200, 18), { time: 210, breakBefore: false });
    assert.deepEqual(sample(clock, 1, 209, 19), { time: 212, breakBefore: false });
    assert.deepEqual(sample(clock, 2, 210, 22), { time: 218, breakBefore: true, gapStart: 214 });
    assert.deepEqual(sample(clock, 3, 210, 23), { time: 220, breakBefore: false });
});

test('a missing or duplicate sequence value leaves a break before the next real frame', () => {
    const clock = new SourceTimebase({ mode: 'fixed', sequenceChannelId: 'sequence' });
    assert.deepEqual(sample(clock, 0, 100, 10), { time: 100, breakBefore: false });
    assert.equal(sample(clock, 1, 104, undefined), null);
    assert.equal(sample(clock, 2, 104, 10), null);
    assert.deepEqual(sample(clock, 3, 130, 11), { time: 101, breakBefore: true });
});

test('optional sequence modulus tracks rollover while a mid-range regression reanchors at receive time', () => {
    const clock = new SourceTimebase({ mode: 'fixed', sequenceChannelId: 'sequence', sequenceWrap: 256 });
    assert.deepEqual(sample(clock, 0, 100, 254), { time: 100, breakBefore: false });
    assert.deepEqual(sample(clock, 1, 120, 1), { time: 103, breakBefore: true, gapStart: 101 });
    assert.equal(sample(clock, 2, 121, 256), null);
    assert.deepEqual(sample(clock, 3, 200, 100), { time: 202, breakBefore: true, gapStart: 104 });
    assert.deepEqual(sample(clock, 4, 205, 2), { time: 205, breakBefore: true, gapStart: 203 });
    assert.deepEqual(sample(clock, 5, 210, 3), { time: 206, breakBefore: false });
});

test('anchored device time uses the first receive time independently for each source and session', () => {
    const config = { mode: 'device', timestampChannelId: 'counter', timestampUnit: 'us' };
    const first = new SourceTimebase(config, { offsetMs: -2 });
    const second = new SourceTimebase(config);
    assert.deepEqual(sample(first, 8, 100, 9000), { time: 98, breakBefore: false });
    assert.deepEqual(sample(second, 1, 107, 9000), { time: 107, breakBefore: false });
    assert.deepEqual(sample(first, 9, 110, 10500), { time: 99.5, breakBefore: false });
    assert.deepEqual(sample(second, 2, 111, 9000), { time: 107, breakBefore: false });
    assert.deepEqual(sample(first, 0, 150, 14000, 'port-session-2'), { time: 148, breakBefore: true, gapStart: 99.501 });
});

test('device time keeps small deltas in large integer nanosecond timestamps', () => {
    const clock = new SourceTimebase({ mode: 'device', timestampChannelId: 'ns', timestampUnit: 'ns' });
    const epoch = 1700000000000000000n;
    assert.equal(sample(clock, 0, 100, epoch).time, 100);
    assert.equal(sample(clock, 1, 150, epoch + 125000n).time, 100.125);
    assert.equal(sample(clock, 2, 151, epoch + 125001n).time, 100.125001);
});

test('device rollover stays continuous and local reset starts a new time segment', () => {
    const clock = new SourceTimebase({ mode: 'device', timestampChannelId: 'tick', timestampWrap: 1000 });
    assert.deepEqual(sample(clock, 0, 100, 998), { time: 100, breakBefore: false });
    assert.deepEqual(sample(clock, 1, 110, 2), { time: 104, breakBefore: false });
    assert.deepEqual(sample(clock, 2, 200, 50), { time: 152, breakBefore: false });
    assert.deepEqual(sample(clock, 3, 210, 3), { time: 210, breakBefore: true, gapStart: 152.001 });
    assert.equal(sample(clock, 4, 215, Infinity), null);
    assert.equal(sample(clock, 5, 220, 4).breakBefore, true);
});

test('shared device clock aligns different sources and units using a single first receive anchor', () => {
    const setup = { mode: 'device', timestampChannelId: 'tick', deviceClock: 'shared' };
    const sharedAnchor = {};
    const first = new SourceTimebase({ ...setup, timestampUnit: 'ms' }, { sharedAnchor, offsetMs: 7 });
    const second = new SourceTimebase({ ...setup, timestampUnit: 'ns' }, { sharedAnchor });
    assert.equal(sample(first, 0, 45, 1700000000000n).time, 52);
    assert.equal(sample(second, 0, 513, 1700000000000500000n).time, 45.5);
    assert.equal(sample(second, 1, 516, 1700000000001500000n).time, 46.5);
    assert.equal(sharedAnchor.receiveTime, 45);
});

test('shared device clock suspends a regressed source until its previous counter value', () => {
    const config = { mode: 'device', timestampChannelId: 'tick', deviceClock: 'shared' };
    const sharedAnchor = {};
    const first = new SourceTimebase(config, { sharedAnchor });
    const second = new SourceTimebase(config, { sharedAnchor });
    assert.equal(sample(first, 0, 50, 1000).time, 50);
    assert.equal(sample(first, 1, 60, 1050).time, 100);
    assert.equal(sample(first, 2, 100, 100), null);
    assert.equal(sample(first, 3, 101, 101), null);
    assert.equal(sample(second, 0, 107, 1060).time, 110);
    assert.deepEqual(sample(first, 4, 400, 1050), { time: 100, breakBefore: true });
});

test('a shared source joining after an observed rollover uses the shared rollover epoch', () => {
    const config = { mode: 'device', timestampChannelId: 'tick', deviceClock: 'shared', timestampWrap: 256 };
    const sharedAnchor = {};
    const first = new SourceTimebase(config, { sharedAnchor });
    const late = new SourceTimebase(config, { sharedAnchor });
    assert.equal(sample(first, 0, 100, 254).time, 100);
    assert.equal(sample(first, 1, 105, 2).time, 104);
    assert.equal(sample(late, 0, 110, 3).time, 105);
});

test('a shared source near the end of the first cycle keeps its current rollover epoch', () => {
    const config = { mode: 'device', timestampChannelId: 'tick', deviceClock: 'shared', timestampWrap: 256 };
    const sharedAnchor = {};
    const first = new SourceTimebase(config, { sharedAnchor });
    const late = new SourceTimebase(config, { sharedAnchor });
    assert.equal(sample(first, 0, 100, 10).time, 100);
    assert.equal(sample(late, 0, 300, 200).time, 290);
});

test('fixed replay uses the original capture-order anchor after early frames have been evicted', () => {
    const config = { mode: 'fixed', sampleRate: 200 };
    const anchors = new Map();
    const live = new SourceTimebase(config, { anchors });
    assert.equal(sample(live, 10, 100).time, 100);
    assert.equal(sample(live, 13, 250).time, 115);
    const replay = new SourceTimebase(config, { anchors: cloneSourceTimebaseAnchors(anchors), offsetMs: 2 });
    assert.deepEqual(sample(replay, 13, 250), { time: 117, breakBefore: false });
    assert.deepEqual(sample(replay, 14, 300), { time: 122, breakBefore: false });
});

test('device replay can start after the original anchor, rollover or reset', () => {
    const config = { mode: 'device', timestampChannelId: 'tick', timestampWrap: 100 };
    const anchors = new Map();
    const live = new SourceTimebase(config, { anchors });
    assert.equal(sample(live, 0, 50, 95).time, 50);
    assert.equal(sample(live, 1, 70, 3).time, 58);
    assert.equal(sample(live, 2, 100, 6).time, 61);
    assert.equal(sample(live, 3, 130, 2).time, 130);
    assert.equal(sample(live, 4, 140, 4).time, 132);
    const replay = new SourceTimebase(config, { anchors, offsetMs: -1 });
    assert.deepEqual(sample(replay, 2, 100, 6), { time: 60, breakBefore: false });
    assert.deepEqual(sample(replay, 3, 130, 2), { time: 129, breakBefore: true, gapStart: 60.001 });
    assert.deepEqual(sample(replay, 4, 140, 4), { time: 131, breakBefore: false });
    const laterReplay = new SourceTimebase(config, { anchors });
    assert.equal(sample(laterReplay, 4, 140, 4).time, 132);
});

test('retained replay preserves the unsynchronized interval after a shared device reset', () => {
    const config = { mode: 'device', timestampChannelId: 'tick', deviceClock: 'shared' };
    const options = { anchors: new Map(), sharedAnchor: {} };
    const live = new SourceTimebase(config, options);
    assert.equal(sample(live, 0, 50, 1000).time, 50);
    assert.equal(sample(live, 1, 70, 1050).time, 100);
    assert.equal(sample(live, 2, 100, 10), null);
    assert.equal(sample(live, 3, 101, 12), null);
    assert.equal(sample(live, 4, 300, 1051).time, 101);
    const replay = new SourceTimebase(config, options);
    assert.equal(sample(replay, 3, 101, 12), null);
    assert.deepEqual(sample(replay, 4, 300, 1051), { time: 101, breakBefore: true });
});

test('frame indices project batched samples with fractional capture order and retain replay timing', () => {
    const config = { mode: 'fixed', sampleRate: 200 };
    const anchors = new Map();
    const live = new SourceTimebase(config, { anchors });
    assert.equal(live.sample({ receiveTime: 100, order: 10.25, frameIndex: 120 }).time, 100);
    assert.equal(live.sample({ receiveTime: 100, order: 10.5, frameIndex: 121 }).time, 105);
    assert.equal(live.sample({ receiveTime: 110, order: 25, frameIndex: 122 }).time, 110);
    const replay = new SourceTimebase(config, { anchors: cloneSourceTimebaseAnchors(anchors) });
    assert.equal(replay.sample({ receiveTime: 110, order: 25, frameIndex: 122 }).time, 110);
});

test('a reset or a new stream cannot move an anchored projection backwards', () => {
    const clock = new SourceTimebase({ mode: 'device', timestampChannelId: 'tick' });
    assert.equal(sample(clock, 0, 100, 100).time, 100);
    assert.equal(sample(clock, 1, 110, 200).time, 200);
    assert.deepEqual(sample(clock, 2, 120, 100), { time: 200, breakBefore: true });
    assert.deepEqual(sample(clock, 3, 130, 10, 'port-session-2'), { time: 200, breakBefore: true });
    assert.equal(sample(clock, 4, 140, 11, 'port-session-2').time, 201);
});

test('a regressed shared device stays unsynchronized across a reconnect and replay', () => {
    const config = { mode: 'device', timestampChannelId: 'tick', deviceClock: 'shared' };
    const options = { anchors: new Map(), sharedAnchor: {} };
    const live = new SourceTimebase(config, options);
    assert.equal(sample(live, 0, 100, 1000).time, 100);
    assert.equal(sample(live, 1, 105, 1010).time, 110);
    assert.equal(sample(live, 2, 115, 50, 'port-session-2'), null);
    assert.equal(sample(live, 3, 120, 100, 'port-session-2'), null);
    assert.equal(sample(live, 4, 140, 1011, 'port-session-2').time, 111);
    const replay = new SourceTimebase(config, options);
    assert.equal(sample(replay, 3, 120, 100, 'port-session-2'), null);
    assert.deepEqual(sample(replay, 4, 140, 1011, 'port-session-2'), { time: 111, breakBefore: true });
});

test('projection rejects finite numeric times outside the Date range after offset', () => {
    const clock = new SourceTimebase({}, { offsetMs: 10 });
    assert.equal(sample(clock, 0, 8.64e15), null);
    assert.deepEqual(sample(clock, 1, 8.64e15 - 10), { time: 8.64e15, breakBefore: true });
});

test('checkpoint pruning preserves the retained prefix, newer segments and existing replay copies', () => {
    const config = { mode: 'device', timestampChannelId: 'tick', timestampWrap: 100 };
    const anchors = new Map();
    const live = new SourceTimebase(config, { anchors });
    assert.equal(sample(live, 0, 50, 95).time, 50);
    assert.equal(sample(live, 1, 70, 3).time, 58);
    assert.equal(sample(live, 3, 130, 2).time, 130);
    const olderReplay = new SourceTimebase(config, { anchors: cloneSourceTimebaseAnchors(anchors) });
    live.pruneBefore('port-session-1', 2);

    const retainedPrefix = new SourceTimebase(config, { anchors: cloneSourceTimebaseAnchors(anchors) });
    assert.equal(sample(retainedPrefix, 2, 100, 6).time, 61);
    const retainedReset = new SourceTimebase(config, { anchors: cloneSourceTimebaseAnchors(anchors) });
    assert.equal(sample(retainedReset, 4, 140, 4).time, 132);
    const fresh = new SourceTimebase(config, { anchors: cloneSourceTimebaseAnchors(anchors) });
    assert.equal(sample(fresh, 0, 75, 95).time, 75);
    assert.equal(sample(olderReplay, 0, 75, 95).time, 50);
});

test('fixed rate resynchronization follows the source switch, delay and consecutive batch limit', () => {
    const run = settings => {
        const clock = new SourceTimebase({ mode: 'fixed', sampleRate: 1000, ...settings }, { estimateLoss: true });
        return Array.from({ length: 150 }, (_, index) => sample(clock, index, 100 + index + (index < 2 ? 0 : 10)));
    };
    assert.equal(run({})[102].missingBefore, 10);
    assert.equal(run({ resyncBatches: 120 })[121].missingBefore, 10);
    assert.equal(run({ resyncEnabled: false }).at(-1).time, 249);
    assert.equal(run({ resyncDelayMs: 11 }).at(-1).time, 249);
    assert.equal(run({ resyncDelayMs: 9.5, resyncBatches: 2 })[102].missingBefore, 10);
    const firstCorrection = settings => run(settings).findIndex(frame => frame.missingBefore > 0);
    assert.equal(firstCorrection({ resyncConfirmationMs: 35 }), 37);
    assert.equal(firstCorrection({ resyncConfirmationMs: 0 }), 4);
    assert.equal(firstCorrection({ resyncConfirmationMs: 0, resyncBatches: 7 }), 8);
    assert.equal(firstCorrection({ resyncConfirmationMs: 0, resyncDelayMs: 10 }), -1);
    for (const invalid of [{ resyncEnabled: 'false' }, { resyncDelayMs: -1 }, { resyncBatches: 0 }, { resyncBatches: 1.5 },
        ...[-1, 60001, '0', null, Infinity].map(resyncConfirmationMs => ({ resyncConfirmationMs }))])
        assert.throws(() => normalizeSourceTimebase(invalid));
});

function runFixedReplay(receipts, options = {}) {
    const clock = new SourceTimebase({ mode: 'fixed', sampleRate: 1000 }, { estimateLoss: true, ...options });
    let tail;
    return receipts.map((receiveTime, order) => {
        if (!order || receiveTime !== receipts[order - 1]) {
            tail = order;
            while (receipts[tail + 1] === receiveTime) tail++;
        }
        return clock.sample({ receiveTime, order, frameIndex: order, batchTail: tail, streamKey: 'capture' });
    });
}

test('short recurring delivery delays never insert missing frames', () => {
    const receipts = Array.from({ length: 2400 }, (_, frame) => {
        const batch = Math.floor(frame / 24), index = frame % 24;
        return batch * 24 + (index < 10 ? index + 10 : 23);
    });
    const frames = runFixedReplay(receipts);
    assert.ok(frames.every(frame => frame.missingBefore === undefined));
    assert.equal(frames.at(-1).time - frames[0].time, receipts.length - 1);
});

test('late delivery that resembles a loss is unwound when the backlog catches up', () => {
    const receipts = Array.from({ length: 800 }, (_, i) => i < 200 || i > 460 ? i : Math.min(i + 40, 460));
    const anchors = new Map();
    const frames = runFixedReplay(receipts, { anchors });
    assert.equal(frames.find(frame => frame.missingBefore)?.missingBefore, 40);
    assert.equal(frames.at(-1).time, 799);
    assert.ok(frames.every((frame, i) => i === 0 || frame.time > frames[i - 1].time));
    const replay = new SourceTimebase({ mode: 'fixed', sampleRate: 1000 }, { estimateLoss: true,
        anchors: cloneSourceTimebaseAnchors(anchors) });
    for (let order = 580; order < 750; order++)
        assert.equal(replay.sample({ receiveTime: receipts[order], order, streamKey: 'capture' }).time, frames[order].time);
});
