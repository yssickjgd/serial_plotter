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
            /FILTER/, expression);
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
            /FILTER/, expression);
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
        expression: 'x[0]', initial: '' }, formula(4, 'CH03+CH01')]), /FILTER/);
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

test('original and total channel counts support the entire 65535-channel range', () => {
    assert.equal(new ChannelOperations(51).push(Array(51).fill(7))[50], 7);
    const maximum = new ChannelOperations(65535);
    assert.equal(maximum.channelCount, 65535);
    assert.equal(maximum.push(Array(65535).fill(2))[65534], 2);
    const last = new ChannelOperations(65534, [formula(65535, 'CH65534+1')]);
    assert.equal(last.push(Array(65534).fill(2))[65534], 3);
    assert.throws(() => new ChannelOperations(65536), /65535/);
    assert.throws(() => new ChannelOperations(65535, [formula(65536, '1')]), /65535/);
    assert.throws(() => new ChannelOperations(1, [formula(65536, '1')]), /范围/);
});

test('Unicode aliases resolve safely and saved expressions use canonical numbered references', () => {
    const names = ['温度', 'cafe\u0301', '结果'];
    const engine = new ChannelOperations(2, [formula(3, '温度 + café + CH1 + CH01 + CH00001 + 1e3')], { names });
    assert.equal(engine.push([2, 5])[2], 1013);
    assert.equal(engine.definitions[0].expression, 'CH00001 + CH00002 + CH00001 + CH00001 + CH00001 + 1e3');
    assert.throws(() => new ChannelOperations(2, [formula(3, '同名')], { names: ['同名', '同名'] }));
    assert.equal(new ChannelOperations(2, [formula(3, 'CH1+CH02')], { names: ['坏 名称', '坏 名称'] }).push([3, 4])[2], 7);
    for (const expression of ['$value', '温\u200d度']) assert.throws(() => new ChannelOperations(2, [formula(3, expression)],
        { names: ['$value', '温\u200d度'] }));
    const filtered = new ChannelOperations(1, [constant(2, '[0]=1,[1]=2'), formula(3, 'int(filter(温度,系数))')],
        { names: ['温度', '系数', '积分'] });
    assert.deepEqual([filtered.push([2])[2], filtered.push([3])[2]], [2, 9]);
});

test('a maximum-sized dependency DAG is ordered iteratively without allocating unused history', () => {
    const definitions = [];
    for (let number = 2; number < 65535; number++) definitions.push(formula(number, `CH${number + 1}+1`));
    definitions.push(formula(65535, 'CH1+1'));
    const engine = new ChannelOperations(1, definitions);
    assert.equal(engine.order.length, 65534);
    assert.equal(engine.push([1])[1], 65535);
    assert.equal(engine.history.size, 0);
    assert.equal(engine.requiredMemoryBytes, 0);
    definitions[definitions.length - 1] = formula(65535, 'CH2');
    assert.throws(() => new ChannelOperations(1, definitions), /循环/);
});

test('canonical renumbering preserves identifier boundaries and state adoption', () => {
    const { renumberChannelExpression, resolveChannelExpression } = require('../channelOperations');
    assert.equal(renumberChannelExpression('CH1+CH01+CH00001+温度CH1+1e3', new Map([[1, 12]])),
        'CH00012+CH00012+CH00012+温度CH1+1e3');
    assert.equal(resolveChannelExpression('温度+CH1', { rawCount: 1, names: ['温度'] }), 'CH00001+CH00001');
});

test('version 2 evaluates uppercase functions and sample indices with unchanged stateful results', () => {
    const engine = new ChannelOperations(2, [constant(3, '[0]=1,[1]=-1'),
        formula(4, 'DIFF(DIFF(CH01[N]))'), formula(5, 'INT(CH01/CH02)'),
        formula(6, 'FILTER(CH01,CH03)'), formula(7, 'FILTER(CH03,CH01)')], { symbolVersion: 2 });
    const values = [[1, 1], [3, 0], [6, 2], [10, 1]].map(row => engine.push(row));
    assert.deepEqual(values.map(row => Number.isNaN(row[3]) ? null : row[3]), [null, null, 1, 1]);
    assert.deepEqual(values.map(row => Number.isNaN(row[4]) ? null : row[4]), [1, null, 4, 14]);
    assert.deepEqual(values.map(row => row[5]), [1, 2, 3, 4]);
    assert.deepEqual(values.map(row => row[6]), [1, 2, 3, 4]);
});

test('version 2 systems use uppercase input output and initial state symbols', () => {
    const engine = new ChannelOperations(2, [{ number: 3, type: 'system',
        expression: 'Y[N]=X[N]+X[N-1]-Y[N-2]', initial: 'X[-1]=5,Y[-1]=2,Y[-2]=3' },
    formula(4, 'FILTER(CH01,CH03)'), formula(5, 'FILTER(CH02,CH03)')], { symbolVersion: 2 });
    const values = [[1, 10], [4, 20], [9, 30]].map(row => engine.push(row));
    assert.deepEqual(values.map(row => row[3]), [3, 3, 10]);
    assert.deepEqual(values.map(row => row[4]), [12, 28, 38]);
});

test('version 2 rejects lowercase or mixed case function calls and system syntax', () => {
    for (const expression of ['diff(CH01)', 'int(CH01)', 'filter(CH01,CH03)', 'Diff(CH01)',
        'Int(CH01)', 'Filter(CH01,CH03)', 'CH01[n]', 'ch01'])
        assert.throws(() => new ChannelOperations(2, [constant(3, '[0]=1'), formula(4, expression)],
            { symbolVersion: 2 }), undefined, expression);
    for (const definition of [
        { expression: 'y[n]=x[n]+y[n-1]', initial: 'y[-1]=0' },
        { expression: 'X[n]', initial: '' },
        { expression: 'X[N]+Y[N-1]', initial: 'y[-1]=0' }])
        assert.throws(() => new ChannelOperations(2, [{ number: 3, type: 'system', ...definition }],
            { symbolVersion: 2 }), undefined, definition.expression);
});

test('legacy definitions migrate syntax before parsing and save uppercase symbols without changing their source', () => {
    const definitions = [{ number: 3, type: 'system', expression: 'y[n]=x[n]+0.5*y[n-1]', initial: 'y[-1]=2' },
        formula(4, 'int(filter(CH01,CH03))+diff(CH02[n])')];
    const engine = new ChannelOperations(2, definitions);
    assert.deepEqual(engine.definitions, [
        { number: 3, type: 'system', expression: 'Y[N]=X[N]+0.5*Y[N-1]', initial: 'Y[-1]=2' },
        formula(4, 'INT(FILTER(CH00001,CH00003))+DIFF(CH00002[N])')]);
    assert.equal(definitions[0].expression, 'y[n]=x[n]+0.5*y[n-1]');
    assert.equal(definitions[1].expression, 'int(filter(CH01,CH03))+diff(CH02[n])');
    assert.ok(Number.isNaN(engine.push([1, 10])[3]));
    assert.equal(engine.push([2, 20])[3], 15);
});

test('lowercase names stay ordinary case sensitive aliases while uppercase function calls remain operators', () => {
    const engine = new ChannelOperations(2, [formula(3, 'diff+x+INT(diff)+DIFF(x)')],
        { names: ['diff', 'x'], symbolVersion: 2 });
    assert.ok(Number.isNaN(engine.push([2, 10])[2]));
    assert.equal(engine.push([3, 14])[2], 26);
    assert.equal(engine.definitions[0].expression, 'CH00001+CH00002+INT(CH00001)+DIFF(CH00002)');
    assert.throws(() => new ChannelOperations(2, [formula(3, 'diff+x+int(diff)')], { names: ['diff', 'x'] }));
    assert.throws(() => new ChannelOperations(2, [formula(3, 'Diff+x')],
        { names: ['diff', 'x'], symbolVersion: 2 }));
});

test('unsupported explicit symbol versions are rejected while version 1 still migrates legacy definitions', () => {
    for (const symbolVersion of [0, 3, '2', null])
        assert.throws(() => new ChannelOperations(1, [formula(2, 'CH01')], { symbolVersion }), /符号版本/);
    const engine = new ChannelOperations(1, [formula(2, 'int(CH01)')], { symbolVersion: 1 });
    assert.equal(engine.definitions[0].expression, 'INT(CH00001)');
    assert.equal(engine.push([3])[1], 3);
});

test('legacy aliases newly reserved by version 2 bind to numbered references before upgrading function syntax', () => {
    const names = ['MIN', 'SEQ'], definitions = [formula(3, 'MIN+SEQ+int(MIN)')];
    const engine = new ChannelOperations(2, definitions, { names });
    assert.equal(engine.definitions[0].expression, 'CH00001+CH00002+INT(CH00001)');
    assert.equal(engine.push([2, 5])[2], 9);
    assert.equal(engine.push([3, 10])[2], 18);
    assert.deepEqual(names, ['MIN', 'SEQ']);
    assert.equal(definitions[0].expression, 'MIN+SEQ+int(MIN)');
    assert.throws(() => new ChannelOperations(2, definitions, { names, symbolVersion: 2 }));
});

test('legacy uppercase system and function names remain channel aliases during formula migration', () => {
    const names = ['X', 'Y', 'N', 'HEADER', 'DIFF', 'INT', 'FILTER'];
    const engine = new ChannelOperations(7, [formula(8, 'X+Y+N+HEADER+DIFF+INT+FILTER')], { names, symbolVersion: 1 });
    assert.equal(engine.push([1, 2, 3, 4, 5, 6, 7])[7], 28);
    assert.equal(engine.definitions[0].expression, 'CH00001+CH00002+CH00003+CH00004+CH00005+CH00006+CH00007');
    const indexed = new ChannelOperations(1, [formula(2, 'N[n]-N[n-1]')], { names: ['N'] });
    assert.ok(Number.isNaN(indexed.push([2])[1]));
    assert.equal(indexed.push([5])[1], 3);
    assert.equal(indexed.definitions[0].expression, 'CH00001[N]-CH00001[N-1]');
});

test('legacy alias binding stays case sensitive and ambiguous aliases require explicit numbered references', () => {
    const caseSensitive = new ChannelOperations(2, [formula(3, 'MIN-min')], { names: ['MIN', 'min'] });
    assert.equal(caseSensitive.push([7, 2])[2], 5);
    assert.throws(() => new ChannelOperations(2, [formula(3, 'Min')], { names: ['MIN', 'min'] }));
    assert.throws(() => new ChannelOperations(2, [formula(3, 'MIN+1')], { names: ['MIN', 'MIN'] }));
    const numbered = new ChannelOperations(2, [formula(3, 'CH1+CH2')], { names: ['MIN', 'MIN'] });
    assert.equal(numbered.push([7, 2])[2], 9);
    const numberPriority = new ChannelOperations(2, [formula(3, 'CH2+MIN')], { names: ['CH2', 'MIN'] });
    assert.equal(numberPriority.push([7, 2])[2], 4);
});

test('legacy aliases bind from registry display names while the upgraded registry keeps reserved-name warnings', () => {
    const { ChannelRegistry } = require('../channelRegistry');
    const registry = new ChannelRegistry({ rawCount: 2, names: ['MIN', 'SEQ'] });
    const engine = new ChannelOperations(2, [formula(3, 'MIN+SEQ')], { registry });
    assert.equal(engine.push([7, 2])[2], 9);
    assert.equal(engine.definitions[0].expression, 'CH00001+CH00002');
    assert.equal(registry.get(1).name, 'MIN');
    assert.ok(registry.nameErrors.has(1));
    assert.throws(() => new ChannelOperations(2, [formula(3, 'MIN+SEQ')], { registry, symbolVersion: 2 }));
});
