const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol } = require('../protocolEngine');

function schema(byteLength = 3, endian = 'little') {
    return { schemaVersion: 2, id: 'bit-fields', endian, framing: { fixedLength: byteLength + 1 }, messages: [{ id: 'state', fields: [
        { id: 'flags', name: 'flags', type: 'bitfield', byteLength, bits: [
            { id: 'enabled', name: 'enabled', offset: 0, length: 1, type: 'bool' },
            { id: 'mode', name: 'mode', offset: 1, length: 3, type: 'uint' },
            { id: 'temperature', name: 'temperature', offset: 4, length: 12, type: 'int' },
            { id: 'reserved', name: 'reserved', offset: 16, length: 8, type: 'reserved' }
        ] }, { name: 'next', type: 'uint8' }
    ] }] };
}

test('boolean slice labels support numeric enum keys and preserve existing boolean-key labels', () => {
    const input = schema(); input.messages[0].fields[0].bits[0].enum = { 0: '关闭', 1: '开启' };
    for (const value of [0, 1]) {
        const record = Protocol.decode([value, 0, 0, 0], input);
        assert.equal(record.flatFields.find(field => field.path === 'flags.enabled').label, value ? '开启' : '关闭');
    }
    input.messages[0].fields[0].bits[0].enum = { false: 'legacy-off', true: 'legacy-on' };
    assert.equal(Protocol.decode([1, 0, 0, 0], input).flatFields.find(field => field.path === 'flags.enabled').label, 'legacy-on');
});

test('byte-sized bit groups decode signed slices and reserved bits without consuming the next field', () => {
    const input = schema(), bytes = Uint8Array.of(0xA5, 0x9C, 0x12, 0x7F), record = Protocol.decode(bytes, input);
    assert.equal(record.valid, true); assert.equal(record.fields.flags, 0x129CA5); assert.equal(record.fields.next, 127);
    const fields = new Map(record.flatFields.map(field => [field.path, field]));
    assert.equal(fields.get('flags.enabled').value, true); assert.equal(fields.get('flags.mode').value, 2);
    assert.equal(fields.get('flags.temperature').value, -1590);
    assert.equal(fields.get('flags.reserved').value, 0x12); assert.equal(fields.get('flags.reserved').numeric, null);
    assert.deepEqual([...Protocol.encode(input, 'state', record.fields)], [...bytes]);
    assert.deepEqual([...Protocol.encode(input, 'state', { flags: { _raw: 0x120000, enabled: true, mode: 2, temperature: -1590 }, next: 127 })], [...bytes]);
    const fresh = Protocol.encode(input, 'state', { flags: { enabled: true, mode: 2, temperature: -1590 }, next: 127 });
    assert.equal(fresh[2], 0, 'new reserved bits default to zero');
});

test('bit groups use byte endian order while slice source spans retain physical positions', () => {
    const input = schema(3, 'big'), record = Protocol.decode([0x12, 0x9C, 0xA5, 8], input);
    assert.equal(record.values['flags.temperature'], -1590);
    const reserved = record.flatFields.find(field => field.path === 'flags.reserved');
    const flag = record.flatFields.find(field => field.path === 'flags.enabled');
    assert.equal(reserved.byteOffset, 0); assert.equal(reserved.endByte, 1); assert.equal(flag.byteOffset, 2);
    assert.deepEqual([...Protocol.encode(input, 'state', record.fields)], [0x12, 0x9C, 0xA5, 8]);
});

test('wide bit groups retain exact integers and support slices wider than 64 bits', () => {
    const input = schema(16); input.messages[0].fields[0].bits = [
        { name: 'wide', type: 'uint', offset: 0, length: 100 },
        { name: 'reserve', type: 'reserved', offset: 100, length: 28 }
    ];
    const value = (1n << 99n) + 37n;
    const encoded = Protocol.encode(input, 'state', { flags: { wide: value.toString() }, next: 6 });
    const decoded = Protocol.decode(encoded, input);
    assert.equal(decoded.values['flags.wide'], value); assert.equal(decoded.fields.flags, value);
    assert.equal(decoded.flatFields.find(field => field.path === 'flags.wide').numeric, null);
    assert.deepEqual(Protocol.encode(input, 'state', decoded.fields), encoded);
});

test('invalid bit widths, overlapping slices and unsafe integer inputs are rejected explicitly', () => {
    for (const byteLength of [0, -1, 1.5, Protocol.LIMITS.frame + 1]) assert.throws(() => Protocol.compile(schema(byteLength)));
    const overlap = schema(); overlap.messages[0].fields[0].bits[1].offset = 0;
    assert.throws(() => Protocol.compile(overlap), /overlap|重叠/i);
    const overflow = schema(); overflow.messages[0].fields[0].bits[3].length = 9;
    assert.throws(() => Protocol.compile(overflow));
    assert.throws(() => Protocol.encode(schema(), 'state', { flags: { mode: 8 }, next: 0 }), /overflow/i);
    const wide = schema(16); wide.messages[0].fields[0].bits = [];
    assert.throws(() => Protocol.encode(wide, 'state', { flags: Number.MAX_SAFE_INTEGER + 1, next: 0 }), /exact|精确/i);
});
