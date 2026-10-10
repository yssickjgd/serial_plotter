const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelOperations } = require('../channelOperations');
const fs = require('node:fs');
const api = fs.existsSync(require.resolve('../channelOperations').replace('channelOperations.js', 'systemResponse.js'))
    ? require('../systemResponse') : {};
function response(definition, count = 8) {
    assert.equal(typeof api.prepareSystemResponse, 'function');
    const engine = new ChannelOperations(1, [{ number: 2, ...definition }]);
    return api.prepareSystemResponse(engine.entries.get(2), count);
}
const system = (expression, initial = '') => ({ type: 'system', expression, initial });
const kernel = expression => ({ type: 'constant', expression });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('constant arrays keep exact samples and transfer gain without one-sided FFT normalization', () => {
    const r = response(kernel('[0]=2,[1]=-1'));
    assert.deepEqual(Array.from(r.samples), [2, -1]);
    near(r.mags[0], 1); near(r.mags.at(-1), 3);
    near(r.phases[0], 0); near(r.mags[2], Math.sqrt(5)); near(r.phases[2], Math.atan(0.5) * 180 / Math.PI);
});
test('pure delay has unity gain and negative phase while a notch has no defined phase', () => {
    const delay = response(kernel('[0]=0,[1]=1'));
    near(delay.mags[2], 1); near(delay.phases[2], -90);
    const average = response(kernel('[0]=0.5,[1]=0.5'));
    near(average.mags[0], 1); near(average.phases[2], -45);
    near(average.mags.at(-1), 0); assert.ok(Number.isNaN(average.phases.at(-1)));
});
test('recursive system response uses zero state and exact rational frequency response', () => {
    const r = response(system('y[n]=x[n]+0.5*y[n-1]', 'y[-1]=20'));
    assert.deepEqual(Array.from(r.samples), [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125]);
    near(r.mags[0], 2); near(r.mags.at(-1), 2 / 3);
    near(r.mags[2], 1 / Math.sqrt(1.25)); near(r.phases[2], -Math.atan(0.5) * 180 / Math.PI);
});
test('linear coefficient extraction handles parentheses repeated references division and delayed inputs', () => {
    const r = response(system('(2*x[0]+x[-1])/2-(y[-1]+y[-1])/4', 'x[-1]=9,y[-1]=3'));
    assert.deepEqual(Array.from(r.samples).slice(0, 4), [1, 0, 0, 0]);
    for (const mag of r.mags) near(mag, 1);
});
test('nonlinear affine and singular systems report errors instead of manufacturing Bode curves', () => {
    for (const expression of ['x[0]*x[0]', 'x[0]/x[-1]', 'x[0]+1', 'x[0]/0']) {
        const r = response(system(expression, expression.includes('x[-1]') ? 'x[-1]=0' : ''));
        assert.ok(r.error, expression); assert.equal(r.mags.length, 0);
    }
    const pole = response(system('x[0]+y[-1]', 'y[-1]=0'));
    assert.ok(Number.isNaN(pole.mags[0])); assert.ok(Number.isNaN(pole.phases[0]));
    near(pole.mags.at(-1), 0.5);
    assert.deepEqual(Array.from(response(system('x[0]*x[0]')).samples), [1, 0, 0, 0, 0, 0, 0, 0]);
});
test('unstable system impulse overflow creates gaps without spoiling its algebraic frequency response', () => {
    const r = response(system('x[0]+1e200*y[-1]', 'y[-1]=0'));
    assert.ok(Number.isNaN(r.samples[2])); assert.ok(r.mags.every(Number.isFinite));
});
test('long kernels preserve all coefficients and include Nyquist', () => {
    const r = response(kernel(Array.from({ length: 65 }, (_, i) => `[${i}]=${i === 64 ? 1 : 0}`).join(',')), 8);
    assert.ok(r.fftSize >= 65); assert.equal(r.mags.length, r.fftSize / 2 + 1);
    near(r.mags[0], 1); near(r.mags.at(-1), 1);
});
test('decibel conversion supports both factors and leaves zero and invalid magnitudes undefined', () => {
    assert.equal(typeof api.decibelMagnitude, 'function');
    near(api.decibelMagnitude(10, 20), 20); near(api.decibelMagnitude(10, 10), 10);
    near(api.decibelMagnitude(0.1, 20), -20);
    assert.ok(Number.isNaN(api.decibelMagnitude(0, 20)));
    assert.ok(Number.isNaN(api.decibelMagnitude(NaN, 20)));
});
test('phase unwrapping follows each contiguous valid segment', () => {
    assert.equal(typeof api.unwrapPhaseDegrees, 'function');
    assert.deepEqual(api.unwrapPhaseDegrees([170, -170, -160, NaN, -170, 170]), [170, 190, 200, NaN, -170, -190]);
});
