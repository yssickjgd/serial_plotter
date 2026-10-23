const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol: P } = require('../protocolEngine');
const { ProtocolModel: M } = require('../protocolModel');

function schema(expression = 'size + 3') {
    return { id: 'frame-expression', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
        id: 'frame', byteLength: 0, lengthFrom: expression, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
            { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
            { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'FRAME_LENGTH - 3' },
            { id: 'end', name: 'end', type: 'fixed', byteLength: 1, bytes: [13], framingRole: 'end' }
        ]
    }] };
}

test('literal zero chooses content-defined frame boundaries while blank expressions remain invalid', () => {
    for (const zero of [0, '0', ' 0 ']) {
        const s = schema(zero);
        s.messages[0].fields[2].lengthFrom = 'size';
        const parser = new P.StreamParser(s), received = [];
        parser.onFrameParsed = record => received.push(record);
        parser.appendData([170, 2, 11]); parser.appendData([22, 13, 170, 1, 33, 13]);
        assert.deepEqual(received.map(record => [...record.fields.body]), [[11,22], [33]]);
        assert.deepEqual([...P.encode(s, 'frame', { size: 2, body: [11,22] })], [170,2,11,22,13]);
    }
    for (const invalid of ['', '  ', '0 + 0']) assert.throws(() => P.compile(schema(invalid)), undefined, invalid);
});

test('frame length expressions frame arbitrary stream chunks and retain affine automatic length writes', () => {
    const s = schema(), bytes = [170, 2, 11, 22, 13];
    assert.deepEqual([...P.encode(s, 'frame', { body: [11, 22] })], bytes);
    const input = [99, ...bytes, 170, 1, 33, 13];
    for (let split = 0; split <= input.length; split++) {
        const parser = new P.StreamParser(s), received = [];
        parser.onFrameParsed = record => received.push(record);
        parser.appendData(input.slice(0, split)); parser.appendData(input.slice(split));
        assert.deepEqual(received.map(record => [...record.fields.body]), [[11, 22], [33]], 'split ' + split);
    }
    assert.equal(P.decode(bytes, s).fields.size, 2);
    assert.throws(() => P.decode([170, 1, 11, 22, 13], s), /length|长度/i);
});

test('frame expressions support multiple nested numeric inputs and reject mismatched sends', () => {
    const s = schema('header.count * header.width + 4'), frame = s.messages[0];
    frame.fields.splice(1, 1, { id: 'header', name: 'header', type: 'struct', byteLength: 2, fields: [
        { id: 'count', name: 'count', type: 'uint8', byteLength: 1 },
        { id: 'width', name: 'width', type: 'uint8', byteLength: 1 }
    ] });
    frame.fields[2].lengthFrom = 'FRAME_LENGTH - 4';
    const wire = [170, 2, 2, 1, 2, 3, 4, 13];
    assert.deepEqual([...P.encode(s, 'frame', { header: { count: 2, width: 2 }, body: [1, 2, 3, 4] })], wire);
    assert.deepEqual([...P.decode(wire, s).fields.body], [1, 2, 3, 4]);
    assert.throws(() => P.encode(s, 'frame', { header: { count: 2, width: 2 }, body: [1] }), /length|长度/i);
});

test('frame expressions reject circular unknown late or conflicting dependencies before application', () => {
    for (const source of ['FRAME_LENGTH + 1', 'REMAINING', 'missing + 3', '', 'size +'])
        assert.throws(() => P.compile(schema(source)), undefined, source);
    const late = schema('late + 3');
    late.messages[0].fields.splice(3, 0, { id: 'late', name: 'late', type: 'uint8', byteLength: 1 });
    assert.throws(() => P.compile(late), /reference|前置|位置|located/i);
    const fixed = schema(); fixed.messages[0].byteLength = 5;
    assert.throws(() => P.compile(fixed), /conflict|冲突/i);
    const both = schema(); both.messages[0].lengthSource = { fieldId: 'size' };
    assert.throws(() => P.compile(both), /conflict|冲突/i);
});

test('invalid expression results resynchronize without retaining or emitting bogus frames', () => {
    const s = schema('size * size + 3'), parser = new P.StreamParser(s), received = [];
    parser.onFrameParsed = record => received.push(record);
    parser.appendData([170, 255, 99, 170, 1, 42, 13]);
    assert.equal(received.length, 1); assert.deepEqual([...received[0].fields.body], [42]);
    for (const source of ['size / 2 + 3', 'size - 5', 'size / (size - 1)'])
        assert.throws(() => P.decode([170, 1, 42, 13], schema(source)), /length|range|zero|长度|范围/i, source);
});

test('frame expression references survive field renames and are discoverable from the source', () => {
    const s = schema();
    assert.ok(M.inspectReferences(s, 'size').some(item => item.nodeId === 'frame' && item.property === 'lengthFrom'));
    const renamed = M.renameField(s, 'size', { name: 'data_length' }).protocol;
    assert.equal(renamed.messages[0].lengthFrom, 'data_length + 3');
    assert.deepEqual([...P.encode(renamed, 'frame', { body: [11, 22] })], [170, 2, 11, 22, 13]);
});

test('expressions bound remainder fields without delimiters and checksum writes retain independent wire values', () => {
    const s = schema('size + 4'), frame = s.messages[0];
    frame.fields[2].lengthFrom = 'FRAME_LENGTH - 4';
    delete frame.fields[3].framingRole;
    frame.fields.splice(3, 0, { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1,
        checksum: { type: 'sum', start: { fieldId: 'sync', edge: 'start' }, end: { fieldId: 'sum', edge: 'start' } } });
    const wire = [170, 2, 11, 22, 205, 13];
    assert.deepEqual([...P.encode(s, 'frame', { body: [11, 22] })], wire);
    assert.equal(P.decode(wire, s).valid, true);
    const changed = wire.slice(); changed[4]++;
    assert.throws(() => P.decode(changed, s), /checksum/i);
    const parser = new P.StreamParser(s), received = [];
    parser.onFrameParsed = record => received.push(record);
    for (const byte of wire) parser.appendData([byte]);
    assert.equal(received.length, 1); assert.equal(received[0].fields.size, 2);
});

test('non-scalar bit groups cannot become frame length inputs and nested reference renames keep their scope', () => {
    const bits = schema(); bits.messages[0].fields[1] = { id: 'size', name: 'size', type: 'bitfield', byteLength: 1,
        bits: [{ name: 'part', offset: 0, length: 8, type: 'uint' }] };
    assert.throws(() => P.compile(bits), /reference|前置|数值/i);
    const nested = schema('header.size + 3');
    nested.messages[0].fields[1] = { id: 'header', name: 'header', type: 'struct', byteLength: 1, fields: [
        { id: 'size', name: 'size', type: 'uint8', byteLength: 1 }
    ] };
    const renamed = M.renameField(M.renameField(nested, 'size', { name: 'count' }).protocol, 'header', { name: 'info' }).protocol;
    assert.equal(renamed.messages[0].lengthFrom, 'info.count + 3');
    assert.deepEqual([...P.encode(renamed, 'frame', { body: [11, 22] })], [170, 2, 11, 22, 13]);
});

test('a constant length expression supplies the same encoding boundary as a legacy fixed frame', () => {
    const s = { id: 'constant-boundary', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
        id: 'frame', byteLength: 4, fields: [{ id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'FRAME_LENGTH' }]
    }] };
    assert.deepEqual([...P.encode(s, 'frame', { body: [11,22] })], [11,22,0,0]);
    s.messages[0].byteLength = 0; s.messages[0].lengthFrom = '2 + 2';
    assert.deepEqual([...P.encode(s, 'frame', { body: [11,22] })], [11,22,0,0]);
    assert.equal(P.decode([11,22,0,0], s).valid, true);
});
