const test = require('node:test');
const assert = require('node:assert/strict');
const { ReservedNames: R } = require('../reservedNames');
test('shared reserved catalog covers languages and protects only exact-case symbols', () => {
    for (const name of [...R.channelFunctions, ...R.channelVariables, ...R.protocolFunctions, ...R.protocolVariables, 'CH1', 'CH00001', 'CH65535']) {
        assert.ok(R.error(name, 'channel'), name); assert.ok(R.error(name, 'field'), name);
    }
    for (const name of ['diff', 'filter', 'x', 'n', 'frameLength', 'seq', 'sequence', 'rm_seq', 'ch1']) {
        assert.equal(R.error(name, 'channel'), null, name); assert.equal(R.error(name, 'field'), null, name);
    }
    for (const name of ['__proto__', 'prototype', 'constructor', '_raw', '_unknownTail', '_segmentTails', '_inferLength', 'rawPayload']) assert.ok(R.error(name, 'field'), name);
    assert.ok(R.definitions.every(row => row.description && row.category));
});
