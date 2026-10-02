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
    assert.throws(() => validateConfig({ plotTimeXUnit: 'ms' }), /时域横轴/);
    assert.throws(() => validateConfig({ plotFreqXUnit: 'seconds' }), /频域横轴单位/);
    assert.throws(() => validateConfig({ plotFreqXScale: 'cubic' }), /频域横轴形式/);
    assert.throws(() => validateConfig({ plotFreqYScale: 'db' }), /频域纵轴形式/);
    assert.throws(() => validateConfig({ plotViewMode: 'frequency',
        plotFreqYScale: 'log', plotYScaleMode: 'manual',
        plotYMinFreq: '-1', plotYMaxFreq: '1' }), /对数纵轴/);
    assert.equal(validateConfig({ plotViewMode: 'frequency',
        plotFreqYScale: 'log', plotYScaleMode: 'manual',
        plotYMinFreq: '0.001', plotYMaxFreq: '10' }).plotFreqYScale, 'log');
});

test('validates FFT window and finite optional channel calibration', () => {
    assert.equal(validateConfig({ plotFftWindow: 'flatTop' }).plotFftWindow, 'flatTop');
    assert.throws(() => validateConfig({ plotFftWindow: 'kaiser' }), /窗函数/);
    assert.equal(validateConfig({ channels: [{ gainEnabled: true, gain: -2,
        offsetEnabled: true, offset: 0 }] }).channels[0].gain, -2);
    for (const channel of [
        { gainEnabled: 'true' }, { offsetEnabled: 1 },
        { gain: 'Infinity' }, { offset: 'NaN' }, { gain: '' }
    ]) assert.throws(() => validateConfig({ channels: [channel] }), /通道配置/);
});

test('plot window points are bounded by the canvas limit and retained capacity', () => {
    assert.equal(validateConfig({ maxPoints: '100000', plotWindowPoints: '65536' }).plotWindowPoints,
        '65536');
    assert.throws(() => validateConfig({ maxPoints: '100000', plotWindowPoints: '65537' }),
        /波形监视台内采样点数/);
    assert.throws(() => validateConfig({ maxPoints: '500', plotWindowPoints: '501' }),
        /波形监视台内采样点数/);
});

test('one hour at 1000 Hz supports 50 channels while rejecting larger limits', () => {
    assert.equal(validateConfig({ channelsCount: '50', maxPoints: '3600000',
        plotWindowPoints: '65536' }).channelsCount, '50');
    assert.throws(() => validateConfig({ channelsCount: '51' }), /通道数/);
    assert.throws(() => validateConfig({ maxPoints: '3600001' }), /采样点数/);
});
