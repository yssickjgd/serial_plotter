const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIntInRange, parsePort, validateConfig } = require('../configValidation');

test('capture configuration validates modes, encodings, boundaries and finite idle intervals', () => {
    assert.throws(() => validateConfig({ captureMode: 'custom' }), /采集/);
    assert.throws(() => validateConfig({ textEncoding: 'invalid' }), /字符集/);
    assert.throws(() => validateConfig({ textBoundary: 'invalid' }), /断帧/);
    for (const idleGapSeconds of ['', 'NaN', '0', '-1', '0.0001', 'Infinity'])
        assert.throws(() => validateConfig({ idleGapSeconds }), /间隔/);
    assert.equal(validateConfig({ captureMode: 'hex', idleGapSeconds: '0.01',
        enableHeader: true, headerHex: 'not used' }).captureMode, 'hex');
    assert.throws(() => validateConfig({ serialData: '6' }), /数据位/);
    assert.throws(() => validateConfig({ serialParity: 'invalid' }), /奇偶校验/);
});

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

test('validates independent manual Y ranges even when the other plot is displayed', () => {
    assert.equal(validateConfig({ plotViewMode: 'time', plotYScaleModeTime: 'auto',
        plotYScaleModeFreq: 'manual', plotFreqYScale: 'log',
        plotYMinFreq: '0.01', plotYMaxFreq: '2' }).plotYScaleModeFreq, 'manual');
    assert.throws(() => validateConfig({ plotYScaleModeTime: 'other' }), /时域 Y/);
    assert.throws(() => validateConfig({ plotYScaleModeFreq: 'other' }), /频域 Y/);
    assert.throws(() => validateConfig({ plotViewMode: 'time', plotYScaleModeFreq: 'manual',
        plotFreqYScale: 'log', plotYMinFreq: '0', plotYMaxFreq: '2' }), /正数/);
    assert.throws(() => validateConfig({ plotYScaleModeTime: 'manual',
        plotYMinTime: '3', plotYMaxTime: '2' }), /大于/);
    assert.throws(() => validateConfig({ plotYScaleModeFreq: 'manual',
        plotYMinFreq: '', plotYMaxFreq: '2' }), /有限数值/);
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

test('validates nested monitor display settings without modifying imported configuration', () => {
    const config = { captureMode: 'hex', dataType: 'uint8', monitorDisplay: {
        hexBytesPerLine: '16', hexGroupBytes: '4', showRx: false,
        textInvalid: 'escape', textNewline: 'line-break', textTab: 'spaces-4',
        timestamp: 'relative', keyword: 'alarm\nWARNING', keywordColor: '#abcdef',
        keywordCaseSensitive: true, foldLong: true, foldLines: 4, refreshRate: '20'
    } };
    const before = JSON.stringify(config);
    assert.equal(validateConfig(config), config);
    assert.equal(JSON.stringify(config), before);
    for (const monitorDisplay of [null, [], 'bad', { hexBytesPerLine: 12 },
        { showRx: 'false' }, { textInvalid: 'ignore' }, { textTab: 'spaces-3' },
        { foldLines: 0 }, { foldLines: 65 }, { refreshRate: 60 },
        { keyword: 'a'.repeat(257) }, { keyword: new Array(33).fill('alarm').join('\n') },
        { keywordColor: 'red' }]) {
        assert.throws(() => validateConfig({ monitorDisplay }));
    }
    assert.equal(validateConfig({ captureMode: 'text' }).monitorDisplay, undefined);
});
