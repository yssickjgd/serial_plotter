const test = require('node:test');
const assert = require('node:assert/strict');

test('config view restores fields without emitting change events', () => {
    const { applyConfigToView } = require('../configView');
    const elements = Object.fromEntries([
        'connType', 'serialBaud', 'serialData', 'serialStop', 'serialParity',
        'netHost', 'netPort', 'netLocalPort', 'headerHex', 'footerHex',
        'dataType', 'endianness', 'channelsCount', 'maxPoints',
        'sendIntervalUnit', 'plotViewMode', 'plotYScaleMode',
        'plotYMin', 'plotYMax'
    ].map(key => [key, { value: '' }]));
    for (const key of ['enableHeader', 'enableFooter', 'enableChecksum', 'plotFftRemoveDc'])
        elements[key] = { checked: false };
    elements.wrapFftRemoveDc = { style: {} };
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
});
