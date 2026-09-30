const test = require('node:test');
const assert = require('node:assert/strict');
const { ByteUtils } = require('../byteUtils');

test('Hex prefixes are accepted only at token starts', () => {
    assert.deepEqual([...ByteUtils.hexToBytes('0xAB, CD')], [0xAB, 0xCD]);
    assert.throws(() => ByteUtils.hexToBytes('A0xB'), /Hex/);
});
