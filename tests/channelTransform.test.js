const test = require('node:test');
const assert = require('node:assert/strict');
const { transformChannelValue } = require('../channelTransform');

test('channel transform applies enabled gain before enabled offset', () => {
    const channel = { gainEnabled: true, gain: -2, offsetEnabled: true, offset: 3 };
    assert.equal(transformChannelValue(4, channel), -5);
    assert.equal(transformChannelValue(4, { ...channel, gainEnabled: false }), 7);
    assert.equal(transformChannelValue(4, { ...channel, offsetEnabled: false }), -8);
    assert.equal(transformChannelValue(4, { ...channel, gain: 0 }), 3);
    assert.equal(transformChannelValue(4, { ...channel, gainEnabled: false, offsetEnabled: false }), 4);
});

test('channel transform rejects nonfinite results without changing raw input', () => {
    const channel = { gainEnabled: true, gain: 1e308, offsetEnabled: false, offset: 0 };
    assert.ok(Number.isNaN(transformChannelValue(1e308, channel)));
    assert.ok(Number.isNaN(transformChannelValue(Infinity, channel)));
});
