const test = require('node:test');
const assert = require('node:assert/strict');

test('config view restores fields without emitting change events', () => {
const { applyConfigToView, collectConfigFromView } = require('../configView');
    const elements = Object.fromEntries([
        'connType', 'serialBaud', 'serialData', 'serialStop', 'serialParity',
        'netHost', 'netPort', 'netLocalPort', 'headerHex', 'footerHex',
        'dataType', 'endianness', 'channelsCount', 'maxPoints', 'plotWindowPoints',
        'sendIntervalUnit', 'plotViewMode', 'plotYScaleMode',
        'plotTimeXUnit', 'plotFreqXUnit', 'plotFreqXScale', 'plotFreqYScale',
        'plotFftWindow',
        'plotYMin', 'plotYMax'
    ].map(key => [key, { value: '' }]));
    for (const key of ['enableHeader', 'enableFooter', 'enableChecksum', 'plotFftRemoveDc'])
        elements[key] = { checked: false };
    elements.wrapFftRemoveDc = { style: {} };
    elements.wrapPlotTimeAxis = { style: {} };
    elements.wrapPlotFreqAxis = { style: {} };
    elements.wrapPlotYBounds = { style: {} };
    const bounds = { time: { min: '-1', max: '1' }, frequency: { min: '-1', max: '1' } };
    const calls = [];
    applyConfigToView({ connType: 'udp', channelsCount: '23',
        plotYMin: '-5', plotYMax: '5' }, {
        elements, bounds,
        updateConnectionModeUI: () => calls.push('mode'),
        updateFrameFormat: () => calls.push('format'),
        updateChannels: () => calls.push('channels'),
        updatePlot: () => calls.push('plot')
    });
    assert.equal(elements.connType.value, 'udp');
    assert.equal(elements.channelsCount.value, '23');
    assert.deepEqual(bounds.time, { min: '-5', max: '5' });
    assert.deepEqual(calls, ['mode', 'format', 'channels', 'plot']);
    assert.equal(elements.wrapPlotTimeAxis.style.display, '');
    assert.equal(elements.wrapPlotFreqAxis.style.display, 'none');
    assert.equal(elements.wrapPlotYBounds.style.display, 'none');
    assert.equal(elements.plotFftWindow.value, 'hann');
    applyConfigToView({ plotViewMode: 'frequency', plotFreqXUnit: 'bins',
        plotFreqXScale: 'log', plotFreqYScale: 'log',
        plotYScaleMode: 'manual', plotFftWindow: 'flatTop' }, {
        elements, bounds,
        updateConnectionModeUI() {}, updateFrameFormat() {},
        updateChannels() {}, updatePlot() {}
    });
    assert.equal(elements.wrapPlotTimeAxis.style.display, 'none');
    assert.equal(elements.wrapPlotFreqAxis.style.display, '');
    assert.equal(elements.wrapPlotYBounds.style.display, '');
    const saved = collectConfigFromView(elements, bounds, [{ name: 'CH1', color: '#123456',
        visible: true, gainEnabled: true, gain: -2, offsetEnabled: true, offset: 3 }]);
    assert.equal(saved.plotFreqXUnit, 'bins');
    assert.equal(saved.plotFreqXScale, 'log');
    assert.equal(saved.plotFreqYScale, 'log');
    assert.equal(saved.plotFftWindow, 'flatTop');
    assert.equal(saved.plotWindowPoints, '1000');
    assert.deepEqual(saved.channels[0], { name: 'CH1', color: '#123456', visible: true,
        gainEnabled: true, gain: -2, offsetEnabled: true, offset: 3 });
    applyConfigToView({ channels: [{ name: 'legacy', color: '#123456', visible: true }] }, {
        elements, bounds, updateConnectionModeUI() {}, updateFrameFormat() {},
        updateChannels() {}, updatePlot() {}
    });
    assert.equal(elements.plotFftWindow.value, 'hann');
    applyConfigToView({ maxPoints: '500' }, {
        elements, bounds, updateConnectionModeUI() {}, updateFrameFormat() {},
        updateChannels() {}, updatePlot() {}
    });
    assert.equal(elements.plotWindowPoints.value, '500');
});
