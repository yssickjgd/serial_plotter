const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelRegistry, normalizeChannelName, channelNameError, resolveChannelExpression } = require('../channelRegistry');

test('safe Unicode variable names are normalized and reserved names are rejected', () => {
    const registry = new ChannelRegistry({ rawCount: 2, names: ['温度', '压力'] });
    for (const name of ['加速度', 'Δ速度', '_传感器', 'cafe\u0301']) assert.equal(registry.validateName(name, 1).valid, true, name);
    for (const name of ['', '带 空格', '1温度', 'a-b', 'a+b', 'a.b', '$value', 'a\u200db', 'a\u200cb', '\u200d温度', 'DIFF', 'INT', 'FILTER', 'X', 'Y', 'N', 'FRAME_LENGTH', 'SEQ', 'MIN', '__proto__', 'CH1', 'CH00001'])
        assert.equal(registry.validateName(name, 1).valid, false, name);
    assert.equal(normalizeChannelName('cafe\u0301'), 'café');
    assert.equal(channelNameError('温度'), null);
    registry.rename(1, 'cafe\u0301'); assert.equal(registry.get(1).name, 'café');
    assert.equal(registry.resolve('cafe\u0301').number, 1);
    assert.equal(registry.validateName('cafe\u0301', 2).valid, false);
});

test('legacy invalid or duplicate labels stay visible but cannot resolve as aliases', () => {
    const registry = new ChannelRegistry({ rawCount: 5, names: ['旧 名称', 'cafe\u0301', 'café', '温度', 'FILTER'] });
    assert.equal(registry.get(1).name, '旧 名称');
    assert.equal(registry.resolve('café'), undefined); assert.equal(registry.resolve('cafe\u0301'), undefined);
    assert.equal(registry.resolve('FILTER'), undefined);
    for (const reference of ['CH1', 'CH01', 'CH00001']) assert.equal(registry.resolve(reference).number, 1);
    assert.equal(registry.canonicalizeExpression('温度 + CH2 + CH00001'), 'CH00004 + CH00002 + CH00001');
    assert.throws(() => registry.canonicalizeExpression('café+1'), /不存在或重复/);
    assert.throws(() => registry.validateNames(), /名称/);
    assert.throws(() => registry.rename(1, 'café'), /重复/);
    assert.throws(() => new ChannelRegistry({ rawCount: 2, names: ['cafe\u0301', 'café'], strictNames: true }), /重复/);
    assert.equal(new ChannelRegistry({ rawCount: 2, strictNames: true }).validateNames(), true);
    assert.equal(new ChannelRegistry({ rawCount: 2, names: ['CH1', 'CH00002'] }).nameErrors.size, 0);
});

test('renaming and renumbering bind formulas to stable channel identity and retain source mapping', () => {
    const registry = new ChannelRegistry({ rawCount: 2, names: ['温度', '压力', '结果'], definitions: [
        { id: 'calculation', number: 3, type: 'formula', expression: '温度+CH2' }
    ] });
    const rawId = registry.get(1).id, source = { ...registry.get(1).source };
    registry.rename(1, '气温');
    assert.equal(registry.getDefinitions()[0].expression, 'CH00001+CH00002');
    registry.renumber(new Map([[1, 2], [2, 1]]));
    assert.equal(registry.get(rawId).number, 2); assert.deepEqual(registry.get(rawId).source, source);
    assert.equal(registry.getDefinitions()[0].expression, 'CH00002+CH00001');
    assert.equal(registry.resolve('气温').number, 2);
    assert.equal(registry.canonicalizeExpression('气温 + 1e3'), 'CH00002 + 1e3');
    const reloaded = new ChannelRegistry({ rawCount: 2, definitions: registry.getDefinitions(), channels: registry.toJSON() });
    assert.equal(reloaded.get(rawId).number, 2); assert.equal(reloaded.get(3).id, 'calculation');
    assert.throws(() => registry.renumber(new Map([[1, 2]])), /无效/);
});

test('registry completion searches Chinese names and any channel width with a bounded result window', () => {
    const names = Array.from({ length: 65535 }, (_, index) => `信号${index + 1}`);
    const registry = new ChannelRegistry({ rawCount: 65535, names });
    assert.equal(registry.complete('', 65535).length, 30);
    assert.equal(registry.complete('', 0).length, 0);
    assert.equal(registry.query('').total, 65535);
    assert.equal(registry.query('', { offset: 65534 }).items[0].number, 65535);
    assert.equal(registry.complete('信号65535')[0].value, '信号65535');
    assert.equal(registry.complete('CH65535')[0].value, 'CH65535');
    assert.equal(registry.complete('CH00001')[0].number, 1);
    assert.equal(resolveChannelExpression('信号1+CH01', registry), 'CH00001+CH00001');
});


test('system names are exact case while lowercase user aliases and insensitive search stay available', () => {
    const registry = new ChannelRegistry({ rawCount: 3, names: ['diff', 'x', 'ch12'] });
    for (const name of ['diff', 'int', 'filter', 'x', 'y', 'n', 'frameLength', 'ch12']) assert.equal(channelNameError(name), null, name);
    assert.equal(registry.canonicalizeExpression('DIFF(diff) + x'), 'DIFF(CH00001) + CH00002');
    assert.equal(registry.resolve('ch1'), undefined);
    assert.equal(registry.query('DIFF').items[0].name, 'diff');
    assert.throws(() => registry.rename(1, 'ABS'), /保留/);
});
