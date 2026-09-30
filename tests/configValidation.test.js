const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIntInRange, parsePort, validateConfig } = require('../configValidation');

test('rejects invalid channel, point and network port values instead of coercing', () => {
    assert.throws(() => parseIntInRange('0', 1, 24, '通道数'), /通道数/);
    assert.throws(() => parseIntInRange('25', 1, 24, '通道数'), /通道数/);
    assert.throws(() => parseIntInRange('1', 2, 100000, '采样点数'), /采样点数/);
    assert.throws(() => parsePort('abc'), /端口/);
    assert.throws(() => parsePort('65536'), /端口/);
    assert.equal(parsePort('9000'), 9000);
});

test('import validation accepts old Y bounds while rejecting malformed channels', () => {
    assert.equal(validateConfig({ channelsCount: '2', maxPoints: '5000', plotYMin: '-1' }).plotYMin, '-1');
    assert.throws(() => validateConfig({ channelsCount: '2', maxPoints: '-3' }), /采样点数/);
    assert.throws(() => validateConfig({ channels: 'bad' }), /通道配置/);
    assert.throws(() => validateConfig({ enableHeader: true, headerHex: 'A' }), /帧头/);
    assert.throws(() => validateConfig({ plotViewMode: 'other' }), /绘图模式/);
    assert.throws(() => validateConfig({ dataType: 'object' }), /数据类型/);
    assert.throws(() => validateConfig({ enableHeader: 'false' }), /enableHeader/);
    assert.throws(() => validateConfig({ channels: [{ visible: 'yes' }] }), /通道配置/);
    assert.throws(() => validateConfig({ serialBaud: 'bad' }), /波特率/);
});
