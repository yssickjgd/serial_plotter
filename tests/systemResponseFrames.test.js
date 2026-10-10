const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelOperations } = require('../channelOperations');
const fs = require('node:fs');
const file = require.resolve('../channelOperations').replace('channelOperations.js', 'systemResponseFrames.js');
const { SystemResponseFrames } = fs.existsSync(file) ? require(file) : {};
function source() {
    return { channelCount: 3, engine: new ChannelOperations(1, [
        { number: 2, type: 'constant', expression: '[0]=1,[1]=2,[2]=3' },
        { number: 3, type: 'system', expression: 'x[0]+0.5*y[-1]', initial: 'y[-1]=10' }
    ]) };
}
test('response view has data without received frames and anchors zero at every visible left edge', () => {
    assert.equal(typeof SystemResponseFrames, 'function');
    const f = new SystemResponseFrames(); f.configure(source(), 8);
    assert.equal(f.length, 8); assert.equal(f.isSignal(0), false); assert.equal(f.isSignal(1), true);
    assert.deepEqual(f.channelSlice(1, 3, 8), [1, 2, 3, 0, 0]);
    assert.deepEqual(f.channelSlice(1, 1, 4), [1, 2, 3]);
    assert.deepEqual(f.channelSlice(1, 5, 7), [1, 2]);
    assert.deepEqual(f.channelSlice(2, 0, 3), [1, 0.5, 0.25]);
    assert.equal(f.getValue(1, 0), 1); assert.equal(f.getValue(1, 2), 3);
    assert.equal(f.getValue(2, 0), 1); assert.equal(f.getValue(2, 2), 0.25);
});
test('response caches ignore received data and only invalidate changed definitions or response length', () => {
    assert.equal(typeof SystemResponseFrames, 'function');
    const f = new SystemResponseFrames(), s = source(); f.configure(s, 8);
    const first = f.frequencyForChannel(1), version = f.version;
    s.version = 999; f.configure(s, 8);
    assert.equal(f.version, version); assert.equal(f.frequencyForChannel(1), first);
    s.engine = new ChannelOperations(1, [...s.engine.definitions.map(d => d.number === 3 ? { ...d, initial: 'y[-1]=0' } : d)]);
    f.configure(s, 8); assert.equal(f.frequencyForChannel(1), first);
    f.configure(s, 16); assert.notEqual(f.frequencyForChannel(1), first);
});

test('all systems share a frequency grid even when one kernel exceeds the requested time window', () => {
    const s = source();
    s.engine = new ChannelOperations(1, [
        { number: 2, type: 'constant', expression: Array.from({ length: 65 }, (_, i) => `[${i}]=${i === 64 ? 1 : 0}`).join(',') },
        { number: 3, type: 'system', expression: 'x[0]+0.5*y[-1]', initial: 'y[-1]=0' }
    ]);
    const f = new SystemResponseFrames(); f.configure(s, 8);
    assert.equal(f.frequencyForChannel(1).fftSize, f.frequencyForChannel(2).fftSize);
});

test('response time length is independent of the shared frequency grid', () => {
    const f = new SystemResponseFrames(), s = source();
    f.configure(s, 8, 64);
    assert.equal(f.length, 8);
    assert.equal(f.frequencyForChannel(2).fftSize, 64);
    f.configure(s, 128, 64);
    assert.equal(f.length, 128);
    assert.equal(f.frequencyForChannel(2).samples.length, 128);
    assert.equal(f.frequencyForChannel(2).fftSize, 64);
});
