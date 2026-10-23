const test = require('node:test');
const assert = require('node:assert/strict');
const { SynchronizedFrames } = require('../engineFrames');

test('synchronized frames honor persisted symbol versions and require uppercase edits', () => {
    const legacy = new SynchronizedFrames(1, 10, { definitions: [{ number: 2, type: 'formula', expression: 'int(CH1)' }] });
    assert.equal(legacy.definitions[0].expression, 'INT(CH00001)');
    assert.throws(() => new SynchronizedFrames(1, 10, { symbolVersion: 2,
        definitions: [{ number: 2, type: 'formula', expression: 'int(CH1)' }] }));
    legacy.ingest(0, new Map([[0, 2]]), { order: 1 });
    assert.throws(() => legacy.updateDefinitions([{ number: 2, type: 'formula', expression: 'diff(CH1)' }]));
    legacy.advance(1);
    assert.equal(legacy.getValue(1, 1), 4);
});

test('synchronized output is causal held expired and compact during idle', () => {
    const f = new SynchronizedFrames(2, 100000, { sampleRate: 1000, expiry: { 0: .002 } });
    f.ingest(1000, new Map([[0, 2]]), { byteOffset: 7, order: 1 });
    f.ingest(1001, new Map([[1, 3]]), { byteOffset: 12, order: 2 });
    f.advance(1099);
    assert.equal(f.length, 100);
    assert.equal(f.getValue(0, 0), 2);
    assert.ok(Number.isNaN(f.getValue(1, 0)));
    assert.equal(f.getValue(1, 99), 3);
    assert.equal(f.statusAt(0, 1), 'held');
    assert.equal(f.statusAt(0, 2), 'expired');
    assert.equal(f.provenanceAt(1, 90).byteOffset, 12);
    assert.ok(f.estimatedMemoryBytes < 10000);
    f.stop(); f.advance(10000); assert.equal(f.length, 100);
    f.ingest(20000, new Map([[1, 5]]), { byteOffset: 19 });
    assert.equal(f.timestampAt(100), 20000);
    f.resize(2); assert.equal(f.length, 2); assert.equal(f.getValue(1, 1), 5);
});

test('synchronized formula edits rebuild affected history, preserve independent integration and catch live ticks', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = new SynchronizedFrames(1, 100, { definitions: [{ number: 2, type: 'formula', expression: 'int(CH1)' },
        { number: 3, type: 'formula', expression: 'CH1+1' }], yieldControl: () => gate });
    f.ingest(0, new Map([[0, 2]]), { order: 1 }); f.advance(2);
    await f.updateDefinitions([{ number: 2, type: 'formula', expression: 'INT(CH1)' },
        { number: 3, type: 'formula', expression: 'CH1+10' }], { rebuild: false });
    assert.deepEqual(f.channelSlice(2), [3, 3, 3]); f.advance(3);
    assert.deepEqual(f.channelSlice(1), [2, 4, 6, 8]); assert.equal(f.getValue(2, 3), 12);
    const pending = f.updateDefinitions(f.definitions, { rebuild: true, reapply: [3] });
    assert.equal(f.rebuilding, true); assert.ok(f.estimatedMemoryBytes > 0);
    f.ingest(4, new Map([[0, 3]]), { order: 2 }); release(); await pending;
    assert.deepEqual(f.channelSlice(2), [12, 12, 12, 12, 13]); assert.deepEqual(f.channelSlice(1), [2, 4, 6, 8, 11]);
    assert.equal(f.rebuilding, false);
});

test('synchronized renumbering moves stored columns and carries formula history without replay', async () => {
    const f = new SynchronizedFrames(1, 10, { definitions: [{ number: 2, type: 'formula', expression: 'int(CH1)' },
        { number: 3, type: 'formula', expression: 'diff(CH2)' }] });
    f.ingest(0, new Map([[0, 2]]), { order: 1 }); f.advance(1);
    const column = f.columns.get(1);
    await f.updateDefinitions([{ number: 3, type: 'formula', expression: 'INT(CH1)' },
        { number: 2, type: 'formula', expression: 'DIFF(CH3)' }], { rebuild: false, numberMap: new Map([[1, 1], [2, 3], [3, 2]]) });
    assert.equal(f.columns.get(2), column); f.advance(2);
    assert.deepEqual(f.channelSlice(2), [2, 4, 6]); assert.equal(f.getValue(1, 2), 2);
});

test('synchronized clear cancels an asynchronous rebuild and rule edits preserve past timestamps and expiry', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = new SynchronizedFrames(1, 10, { definitions: [{ number: 2, type: 'formula', expression: 'CH1' }], yieldControl: () => gate });
    f.ingest(0, new Map([[0, 2]]), { order: 1 }); f.advance(2);
    const old = f.channelSlice(0), times = [f.timestampAt(0), f.timestampAt(1), f.timestampAt(2)];
    f.updateSynchronization({ sampleRate: 500, expiry: { 0: .001 } }, { timestamp: 3 }); f.advance(6);
    assert.deepEqual(f.channelSlice(0).slice(0, 3), old); assert.deepEqual([f.timestampAt(0), f.timestampAt(1), f.timestampAt(2)], times);
    assert.ok(Number.isNaN(f.getValue(0, f.length - 1)));
    const pending = f.updateDefinitions([{ number: 2, type: 'formula', expression: 'CH1+1' }]);
    f.clear(); release(); await pending; assert.equal(f.length, 0); assert.equal(f.rebuilding, false);
});

test('late same-tick events never change an already sampled tick or advance into the future', () => {
    const f = new SynchronizedFrames(1, 10, { definitions: [{ number: 2, type: 'formula', expression: 'CH1*2' }] });
    f.ingest(0, new Map([[0, 2]]), { order: 1 }); f.advance(1);
    f.ingest(1, new Map([[0, 5]]), { order: 2 });
    assert.equal(f.length, 2); assert.deepEqual(f.channelSlice(0), [2, 2]); assert.deepEqual(f.channelSlice(1), [4, 4]);
    f.advance(2); assert.equal(f.getValue(0, 2), 5); assert.equal(f.getValue(1, 2), 10);
});

test('formula provenance follows recursively referenced inputs and status recognizes a nonaligned first presentation', () => {
    const f = new SynchronizedFrames(2, 10, { expiry: { 1: .001 }, definitions: [
        { number: 3, type: 'formula', expression: 'CH1*2' }, { number: 4, type: 'formula', expression: 'CH3+CH2' }
    ] });
    const a = { order: 10, byteOffset: 100, endByte: 104 }, b = { order: 20, byteOffset: 200, endByte: 204 };
    f.ingest(1000, new Map([[0, 2]]), a); f.ingest(1000.3, new Map([[1, 3]]), b); f.advance(1001);
    assert.equal(f.statusAt(1, 1), 'new'); assert.equal(f.statusAt(2, 1), 'held'); assert.equal(f.statusAt(3, 1), 'new');
    assert.equal(f.provenanceAt(2, 1).byteOffset, 100); assert.equal(f.provenanceAt(3, 1).byteOffset, 200);
    assert.deepEqual(f.provenanceAt(3, 1).origins.map(origin => origin.byteOffset).sort((x, y) => x - y), [100, 200]);
    f.advance(1002); assert.ok(Number.isNaN(f.getValue(3, 2))); assert.equal(f.statusAt(3, 2), 'expired');
});

test('history, convolution and system provenance use the corresponding sample and ignore byte-free parameters', () => {
    const f = new SynchronizedFrames(1, 10, { definitions: [
        { number: 2, type: 'formula', expression: 'CH1[-1]' }, { number: 3, type: 'constant', expression: '[0]=1,[1]=2' },
        { number: 4, type: 'formula', expression: 'filter(CH1,CH3)' }, { number: 5, type: 'system', expression: 'x[-1]', initial: 'x[-1]=0' },
        { number: 6, type: 'formula', expression: 'filter(CH5,CH1)' }, { number: 7, type: 'formula', expression: '5' },
        { number: 8, type: 'formula', expression: 'diff(CH1)' }
    ] });
    f.ingest(0, new Map([[0, 2]]), { order: 10, byteOffset: 100, endByte: 104 });
    f.ingest(1, new Map([[0, 3]]), { order: 20, byteOffset: 200, endByte: 204 });
    assert.equal(f.provenanceAt(1, 1).byteOffset, 100); assert.equal(f.provenanceAt(3, 1).byteOffset, 200);
    assert.equal(f.provenanceAt(5, 1).byteOffset, 100); assert.equal(f.provenanceAt(7, 1).byteOffset, 200);
    assert.deepEqual(f.provenanceInfoAt(3, 1).origins.map(origin => origin.order).sort((a, b) => a - b), [10, 20]);
    assert.deepEqual(f.provenanceInfoAt(7, 1).origins.map(origin => origin.order).sort((a, b) => a - b), [10, 20]);
    assert.equal(f.provenanceAt(6, 1), null); assert.equal(f.provenanceInfoAt(6, 1).hasInputs, false);
    assert.equal(f.statusAt(6, 1), 'held'); assert.equal(f.statusAt(2, 1), 'missing'); assert.equal(f.statusAt(4, 1), 'missing');
});

test('new status uses each sample period across retention and short paused segments', () => {
    const f = new SynchronizedFrames(2, 10);
    f.ingest(0, new Map([[0, 1], [1, 9]]), { order: 1 }); f.ingest(.3, new Map([[0, 2]]), { order: 2 });
    f.advance(1); f.ingest(1.8, new Map([[1, 10]]), { order: 3 }); f.advance(2); f.resize(2);
    assert.equal(f.timestampAt(0), 1); assert.equal(f.statusAt(0, 0), 'new'); assert.equal(f.statusAt(0, 1), 'held');
    assert.equal(f.statusAt(1, 1), 'new');
    f.stop(); f.ingest(2.3, new Map([[0, 3]]), { order: 4 });
    assert.equal(f.statusAt(0, f.length - 1), 'new'); assert.equal(f.statusAt(1, f.length - 1), 'held');
});

test('a 65535-channel dependency chain traces provenance without recursive calls or a per-sample history cache', () => {
    const definitions = [];
    for (let number = 2; number <= 65535; number++) definitions.push({ number, type: 'formula', expression: `CH${number - 1}` });
    const f = new SynchronizedFrames(1, 2, { definitions }); f.chunkSize = 1;
    f.ingest(0, new Map([[0, 7]]), { order: 1, byteOffset: 100, endByte: 104 });
    assert.equal(f.provenanceAt(65534, 0).byteOffset, 100); assert.equal(f.statusAt(65534, 0), 'new');
    assert.equal(f.provenanceResults.size, 1); assert.equal(f.provenancePlans.size, 65534);
});

test('future-only formula edits preserve historical source identity through reordering and explicit reapply', async () => {
    const f = new SynchronizedFrames(2, 10, { definitions: [{ number: 3, type: 'formula', expression: 'CH1' },
        { number: 4, type: 'formula', expression: 'CH3*2' }] });
    f.ingest(0, new Map([[0, 2]]), { order: 1, byteOffset: 100, endByte: 104 });
    f.ingest(.3, new Map([[1, 3]]), { order: 2, byteOffset: 200, endByte: 204 }); f.advance(1);
    await f.updateDefinitions([{ number: 3, type: 'formula', expression: 'CH2' }, { number: 4, type: 'formula', expression: 'CH3*2' }], { rebuild: false });
    assert.equal(f.provenanceAt(3, 1).byteOffset, 100); f.advance(2); assert.equal(f.provenanceAt(3, 2).byteOffset, 200);
    await f.updateDefinitions([{ number: 4, type: 'formula', expression: 'CH2' }, { number: 3, type: 'formula', expression: 'CH4*2' }],
        { rebuild: false, numberMap: new Map([[1, 1], [2, 2], [3, 4], [4, 3]]) });
    assert.equal(f.provenanceAt(2, 1).byteOffset, 100); assert.equal(f.provenanceAt(2, 2).byteOffset, 200);
    await f.updateDefinitions(f.definitions, { rebuild: true, reapply: [4] });
    assert.equal(f.provenanceAt(2, 1).byteOffset, 200);
});
