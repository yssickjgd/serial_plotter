const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { FrameBuffer } = require('../frameBuffer');
const { ComputedFrames } = fs.existsSync(require('node:path').join(__dirname, '../computedFrames.js'))
    ? require('../computedFrames') : {};
const formula = (number, expression) => ({ number, type: 'formula', expression });
function frames(definitions, capacity = 4, options) {
    assert.equal(typeof ComputedFrames, 'function', 'shared computed frame view exists');
    return new ComputedFrames(new FrameBuffer(1, capacity), definitions, options);
}
const append = (f, value) => f.append([value], Uint8Array.of(value), '', value, value * 10);

test('renumbering preserves filter integration and explicit lookback state with the same stored columns', async () => {
    const definitions = [formula(2, 'CH01'), { number: 3, type: 'constant', expression: '[0]=1,[1]=1' },
        { number: 4, type: 'system', expression: 'x[0]+y[-1]', initial: 'y[-1]=5' },
        formula(5, 'int(filter(CH01,CH03))+filter(CH01,CH04)+CH01[-1]'), formula(6, 'diff(CH05)')];
    const f = frames(definitions, 2); append(f, 1); append(f, 2);
    const oldColumn = f.columns.get(5);
    await f.updateDefinitions([{ ...definitions[1], number: 2 }, { ...definitions[2], number: 3 },
        formula(4, 'int(filter(CH01,CH02))+filter(CH01,CH03)+CH01[-1]'), formula(5, 'diff(CH04)')],
    { numberMap: new Map([[1, 1], [3, 2], [4, 3], [5, 4], [6, 5]]) });
    assert.equal(f.columns.get(4), oldColumn);
    assert.equal(f.getValue(3, 1), 13);
    append(f, 3);
    assert.deepEqual(f.channelSlice(3), [13, 22]);
    assert.equal(f.getValue(4, 1), 9); assert.deepEqual([...f.rawBytesAt(1)], [3]);
});

test('renumbering during a rebuild resumes affected channels and cancels writes using obsolete IDs', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = frames([formula(2, 'CH01'), formula(3, 'int(CH01)')], 4, { yieldControl: () => gate });
    append(f, 1); append(f, 2);
    const pending = f.updateDefinitions([formula(2, 'CH01'), formula(3, 'int(CH01*2)')]);
    const renamed = f.updateDefinitions([formula(2, 'int(CH01*2)')], { rebuild: false, numberMap: new Map([[1, 1], [3, 2]]) });
    append(f, 3); release(); await Promise.all([pending, renamed]);
    assert.deepEqual(f.channelSlice(1), [2, 6, 12]);
    assert.equal(f.rebuilding, false); append(f, 4); assert.equal(f.getValue(1, 3), 20);
});

test('computed storage retains raw bytes and follows overwrite and resize without restarting integration', () => {
    const f = frames([formula(2, 'int(CH01)')]);
    for (let i = 1; i <= 6; i++) append(f, i);
    assert.deepEqual(f.channelSlice(1), [6, 10, 15, 21]);
    assert.deepEqual([...f.rawBytesAt(0)], [3]);
    f.resize(2); assert.deepEqual(f.channelSlice(1), [15, 21]);
    f.resize(8); append(f, 7); assert.deepEqual(f.channelSlice(1), [15, 21, 28]);
    f.clear(); append(f, 8); assert.deepEqual(f.channelSlice(1), [8]);
});

test('future-only edits preserve every historical waveform and restart affected states only', async () => {
    const f = frames([formula(2, 'int(CH01)'), formula(3, 'diff(CH02)'), formula(4, 'int(CH01)')]);
    append(f, 1); append(f, 2);
    await f.updateDefinitions([formula(2, 'int(CH01*2)'), formula(3, 'diff(CH02)'), formula(4, 'int(CH01)')], { rebuild: false });
    assert.deepEqual(f.channelSlice(1), [1, 3]);
    append(f, 3);
    assert.deepEqual(f.channelSlice(1), [1, 3, 6]);
    assert.ok(Number.isNaN(f.getValue(2, 2)));
    assert.equal(f.getValue(3, 2), 6);
});

test('async historical edits catch live samples once and keep unrelated channel history unchanged', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = frames([formula(2, 'int(CH01)'), formula(3, 'int(CH01)')], 4, { yieldControl: () => gate });
    append(f, 1); append(f, 2);
    const rebuilding = f.updateDefinitions([formula(2, 'int(CH01*2)'), formula(3, 'int(CH01)')], { rebuild: true });
    append(f, 3); release(); await rebuilding;
    assert.deepEqual(f.channelSlice(1), [2, 6, 12]);
    assert.deepEqual(f.channelSlice(2), [1, 3, 6]);
    append(f, 4); assert.equal(f.getValue(1, 3), 20);
});

test('clear cancels old computed rebuild and invalid definition never replaces valid data', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = frames([formula(2, 'CH01*2')], 4, { yieldControl: () => gate });
    append(f, 1);
    assert.throws(() => f.updateDefinitions([formula(2, 'CH99')]), /不存在/);
    const pending = f.updateDefinitions([formula(2, 'CH01*3')], { rebuild: true });
    f.clear(); append(f, 2); release(); await pending;
    assert.deepEqual(f.channelSlice(1), [6]);
});

test('rebuilding a dependent channel reads unchanged accumulated historical values', async () => {
    const f = frames([formula(2, 'int(CH01)'), formula(3, 'CH02')], 2);
    append(f, 1); append(f, 2); append(f, 3);
    await f.updateDefinitions([formula(2, 'int(CH01)'), formula(3, 'CH02*2')]);
    assert.deepEqual(f.channelSlice(1), [3, 6]); assert.deepEqual(f.channelSlice(2), [6, 12]);
    append(f, 4); assert.deepEqual(f.channelSlice(2), [12, 20]);
});

test('introducing an explicit lookback uses existing retained samples', async () => {
    const f = frames([]); append(f, 1); append(f, 2);
    await f.updateDefinitions([formula(2, 'CH01[-1]')], { rebuild: false }); append(f, 3);
    assert.equal(f.getValue(1, 2), 2);
});

test('explicit reapply rebuilds the selected definition and dependents without resetting unrelated history', async () => {
    const definitions = [formula(2, 'CH01'), formula(3, 'CH02*2'), formula(4, 'int(CH01)')];
    const f = frames(definitions, 2);
    append(f, 1); append(f, 2); append(f, 3);
    const changed = [formula(2, 'CH01*3'), definitions[1], definitions[2]];
    await f.updateDefinitions(changed, { rebuild: false });
    append(f, 4);
    await f.updateDefinitions(changed, { rebuild: true, reapply: [2] });
    assert.deepEqual(f.channelSlice(1), [9, 12]);
    assert.deepEqual(f.channelSlice(2), [18, 24]);
    assert.deepEqual(f.channelSlice(3), [6, 10]);
    append(f, 5); assert.equal(f.getValue(3, 1), 15);
});

test('consecutive edits rebuild every pending dependency instead of losing the first update', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = frames([formula(2, 'CH01'), formula(3, 'CH01')], 4, { yieldControl: () => gate });
    append(f, 2); append(f, 3);
    const first = f.updateDefinitions([formula(2, 'CH01*2'), formula(3, 'CH01')]);
    const second = f.updateDefinitions([formula(2, 'CH01*2'), formula(3, 'CH01*3')]);
    release(); await Promise.all([first, second]);
    assert.deepEqual(f.channelSlice(1), [4, 6]); assert.deepEqual(f.channelSlice(2), [6, 9]);
});

test('shrinking a buffer during a rebuild completes against the remaining samples', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = frames([formula(2, 'CH01')], 4, { yieldControl: () => gate });
    append(f, 1); append(f, 2); append(f, 3); append(f, 4);
    const pending = f.updateDefinitions([formula(2, 'CH01*2')]);
    f.resize(2); release(); await pending;
    assert.deepEqual(f.channelSlice(1), [6, 8]); assert.equal(f.rebuilding, false);
});

test('editing a shared system preserves old output and initializes the new system for future samples', async () => {
    const system = { number: 2, type: 'system', expression: 'x[0]+y[-1]', initial: 'y[-1]=5' };
    const f = frames([system, formula(3, 'filter(CH01,CH02)')]);
    append(f, 1); append(f, 2);
    await f.updateDefinitions([{ ...system, initial: 'y[-1]=10' }, formula(3, 'filter(CH01,CH02)')], { rebuild: false });
    append(f, 3); assert.deepEqual(f.channelSlice(2), [6, 8, 13]);
    await f.updateDefinitions([{ ...system, initial: 'y[-1]=20' }, formula(3, 'filter(CH01,CH02)')]);
    assert.deepEqual(f.channelSlice(2), [21, 23, 26]);
});

test('convolution preserves required state after samples leave the visible cache', () => {
    const f = frames([{ number: 2, type: 'constant', expression: '[0]=1,[1]=1,[2]=1' },
        formula(3, 'filter(CH01,CH02)')], 2);
    append(f, 1); append(f, 2); append(f, 3); append(f, 4);
    assert.deepEqual(f.channelSlice(2), [6, 9]);
});
