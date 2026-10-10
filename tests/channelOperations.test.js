const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ChannelOperations } = fs.existsSync(require('node:path').join(__dirname, '../channelOperations.js'))
    ? require('../channelOperations') : {};
const formula = (number, expression) => ({ number, type: 'formula', expression });
const constant = (number, expression) => ({ number, type: 'constant', expression });
function run(definitions, samples) {
    assert.equal(typeof ChannelOperations, 'function', 'global channel evaluator exists');
    const engine = new ChannelOperations(2, definitions);
    return samples.map(values => engine.push(values));
}

test('arithmetic respects precedence, signs, constants and current/previous indices', () => {
    const values = run([constant(3, '[0]=1,[1]=-2.3'), formula(4, '(CH01+CH02)*-2+CH03[1]'),
        formula(5, 'CH01[0]-CH01[-1]')], [[2, 3], [5, 2]]);
    assert.deepEqual(values.map(v => v[3]), [-12.3, -16.3]);
    assert.ok(Number.isNaN(values[0][4])); assert.equal(values[1][4], 3);
});

test('nested difference and sample integration keep position through invalid samples', () => {
    const values = run([formula(3, 'diff(diff(CH01))'), formula(4, 'int(CH01/CH02)')],
        [[1, 1], [3, 0], [6, 2], [10, 1]]);
    assert.deepEqual(values.map(v => Number.isNaN(v[2]) ? null : v[2]), [null, null, 1, 1]);
    assert.deepEqual(values.map(v => Number.isNaN(v[3]) ? null : v[3]), [1, null, 4, 14]);
});

test('filter with a constant kernel pads causal input history with zero', () => {
    const values = run([constant(3, '[0]=1,[1]=-2,[2]=3'), formula(4, 'filter(CH01,CH03)'),
        formula(5, 'filter(CH01+CH02,CH03)')], [[2, 1], [4, 1], [6, 1]]);
    assert.deepEqual(values.map(v => v[3]), [2, 0, 4]);
    assert.deepEqual(values.map(v => v[4]), [3, -1, 6]);
});

test('removed conv calls are rejected even with valid kernels and inside nested formulas', () => {
    for (const expression of ['conv(CH01,CH03)', 'conv(CH03,CH01)', 'diff(conv(CH01,CH03))'])
        assert.throws(() => new ChannelOperations(2, [constant(3, '[0]=1'), formula(4, expression)]),
            /filter/, expression);
});

test('filter accepts either order of signal and kernel including expressions and nested operations', () => {
    const values = run([constant(3, '[0]=1,[1]=-2,[2]=3'), formula(4, 'filter(CH03,CH01)'),
        formula(5, 'filter(CH03,CH01+CH02)'), formula(6, 'int(filter(CH03,CH01))')],
    [[2, 1], [4, 1], [6, 1]]);
    assert.deepEqual(values.map(row => row[3]), [2, 0, 4]);
    assert.deepEqual(values.map(row => row[4]), [3, -1, 6]);
    assert.deepEqual(values.map(row => row[5]), [2, 2, 6]);
});

test('filter accepts reversed systems while preserving their specified initial state', () => {
    const values = run([{ number: 3, type: 'system', expression: 'x[0]+0.5*y[-1]', initial: 'y[-1]=2' },
        formula(4, 'filter(CH03,CH01)'), formula(5, 'filter(CH01,CH03)')], [[1, 0], [2, 0], [3, 0]]);
    assert.deepEqual(values.map(row => row[3]), [2, 3, 4.5]);
    assert.deepEqual(values.map(row => row[4]), [2, 3, 4.5]);
});

test('filter requires exactly one signal and one constant kernel or system', () => {
    for (const expression of ['filter(CH03,CH03)', 'filter(CH01,CH02)', 'filter(CH01,CH03,CH02)'])
        assert.throws(() => new ChannelOperations(2, [constant(3, '[0]=1'), formula(4, expression)]),
            /filter/, expression);
});

test('derived dependencies evaluate in order and invalid output does not stop later samples', () => {
    const values = run([formula(3, 'CH04+2'), formula(4, 'CH01/CH02')], [[2, 0], [6, 2]]);
    assert.ok(Number.isNaN(values[0][2])); assert.equal(values[1][2], 5);
});

test('grammar rejects arbitrary code, ambiguous functions, wrong indices and cyclic references', () => {
    assert.equal(typeof ChannelOperations, 'function');
    for (const expression of ['CH01.foo', 'alert(1)', 'diffCH01', 'int()', 'CH01[1]', 'CH01[-1.5]',
        'filter(CH01,CH02)', 'CH01++CH02', 'CH99', 'diff(CH01,CH02)'])
        assert.throws(() => new ChannelOperations(2, [formula(3, expression)]), undefined, expression);
    assert.throws(() => new ChannelOperations(2, [formula(3, 'CH04'), formula(4, 'CH03')]), /循环/);
    assert.throws(() => new ChannelOperations(2, [constant(3, '[1]=1')]), /连续/);
    assert.throws(() => new ChannelOperations(2, [constant(3, '[0]=Infinity')]), /有限|数值/);
    assert.throws(() => new ChannelOperations(2, [formula(3, 'CH04+1'), constant(4, '[0]=1')]), /索引/);
});

test('reusable difference systems give each filter independent initial state', () => {
    const values = run([{ number: 3, type: 'system', expression: 'y[n]=x[n]+0.5*y[n-1]', initial: 'y[-1]=2' },
        formula(4, 'filter(CH01,CH03)'), formula(5, 'filter(CH02,CH03)')], [[1, 10], [2, 20], [3, 30]]);
    assert.deepEqual(values.map(v => v[3]), [2, 3, 4.5]);
    assert.deepEqual(values.map(v => v[4]), [11, 25.5, 42.75]);
});

test('system input history, feedback history and finite-array filter use specified state', () => {
    const values = run([{ number: 3, type: 'system', expression: 'x[0]+x[-1]-y[-2]',
        initial: 'x[-1]=5,y[-1]=2,y[-2]=3' }, formula(4, 'filter(CH01,CH03)'),
    constant(5, '[0]=1,[1]=-1'), formula(6, 'filter(CH01,CH05)')], [[1, 0], [4, 0], [9, 0]]);
    assert.deepEqual(values.map(v => v[3]), [3, 3, 10]);
    assert.deepEqual(values.map(v => v[5]), [1, 3, 5]);
});

test('system rejects instantaneous feedback, unspecified state and system scalar arithmetic', () => {
    assert.equal(typeof ChannelOperations, 'function');
    for (const definition of [
        { number: 3, type: 'system', expression: 'y[0]+x[0]', initial: '' },
        { number: 3, type: 'system', expression: 'x[0]+y[-1]', initial: '' },
        { number: 3, type: 'system', expression: 'x[1]', initial: '' }])
        assert.throws(() => new ChannelOperations(2, [definition]));
    assert.throws(() => new ChannelOperations(2, [{ number: 3, type: 'system',
        expression: 'x[0]', initial: '' }, formula(4, 'CH03+CH01')]), /filter/);
});

test('zero denominator and arithmetic overflow produce gaps without corrupting integral state', () => {
    const values = run([formula(3, 'int(CH01*CH02)'), formula(4, 'CH01/CH02')],
        [[2, 3], [1e308, 1e308], [4, 2], [0, 0], [1, 1]]);
    assert.deepEqual(values.map(v => Number.isNaN(v[2]) ? null : v[2]), [6, null, 14, 14, 15]);
    assert.ok(Number.isNaN(values[3][3])); assert.equal(values[4][3], 1);
});

test('history indices and parameter bounds are checked without accepting ambiguous identifiers', () => {
    for (const expression of ['CH03[-1]', 'CH03[2]', 'CH0', 'CH01(2)', 'CH01[-65537]', 'Int(CH01)',
        'filter(CH01,CH02)', 'CH01;process.exit()', 'constructor(CH01)'])
        assert.throws(() => new ChannelOperations(2, [constant(3, '[0]=1,[1]=2'), formula(4, expression)]), undefined, expression);
    assert.throws(() => new ChannelOperations(2, [constant(3, '[0]=1,[0]=2')]), /连续/);
});

test('very deep arithmetic reports a validation error before entering recursive evaluation', () => {
    assert.throws(() => new ChannelOperations(2, [formula(3, Array(150).fill('CH01').join('+'))]), /嵌套/);
});
