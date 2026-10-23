const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameBuffer } = require('../frameBuffer');
const { Protocol } = require('../protocolEngine');
const { protocolValueText, protocolRecordSummary, protocolRecordStatus, protocolVisibleFields, structuredCsvChunks } = require('../protocolRecords');
const { parseProtocolFieldSearch, ProtocolFieldSearchSession } = require('../monitorSearch');

function protocolFixture() {
    const compiled = Protocol.compile({ id: 'records', endian: 'little', framing: { fixedLength: 18 }, payloadOffset: 0,
        messages: [{ id: 'status', name: '设备状态', command: 1, fields: [
            { name: 'temperature', type: 'float32' }, { name: 'clock', type: 'uint64' },
            { name: 'flags', type: 'uint8', bits: [{ name: 'ready', offset: 0, length: 1, type: 'bool' }] },
            { name: 'name', type: 'string', length: 3 }, { name: 'data', type: 'bytes', length: 2 }
        ] }] });
    const frames = new FrameBuffer(1, 4);
    for (let index = 0; index < 2; index++) {
        const bytes = Protocol.encode(compiled, 'status', { temperature: 20.5 + index, clock: 9007199254740993n + BigInt(index),
            flags: index + 1, name: '温', data: Uint8Array.of(1, 2) });
        frames.appendRaw(bytes, 't', index + 1, 1700000000000 + index, { byteOffset: 100 + index * bytes.length });
    }
    const decodeRecord = index => ({ ...frames.frameAt(index), record: Protocol.decode(frames.rawBytesAt(index), compiled) });
    return { frames, compiled, decodeRecord };
}

test('structured value formatting preserves Unicode, JSON arrays, and exact signed and unsigned64 values', () => {
    assert.equal(protocolValueText(18446744073709551615n), '18446744073709551615');
    assert.equal(protocolValueText(-9223372036854775808n), '-9223372036854775808');
    assert.equal(protocolValueText([9007199254740993n, 2, '温']), '["9007199254740993",2,"温"]');
    assert.equal(protocolValueText(Uint8Array.of(1, 255)), '[1,255]');
    const { decodeRecord } = protocolFixture(), record = decodeRecord(0);
    assert.match(protocolRecordSummary(record), /设备状态.*命令=1.*状态=正常/);
    assert.equal(protocolRecordStatus(record), 'ok');
    assert.equal(protocolRecordStatus({ known: false, warnings: [{ code: 'unknown' }] }), 'unknown');
});

test('per-field hexadecimal presentation keeps exact integers, numeric mappings and decimal CSV data', () => {
    const schema = { schemaVersion: 3, id: 'hex-fields', messages: [{ id: 'frame', byteLength: 13, fields: [
        { name: 'signed', type: 'int16', byteLength: 2, displayBase: 'hex' },
        { name: 'wide', type: 'uint64', byteLength: 8, displayBase: 'hex' },
        { name: 'array', type: 'uint8', byteLength: 1, count: 2, displayBase: 'hex' },
        { name: 'flags', type: 'bitfield', byteLength: 1, displayBase: 'hex', bits: [{ name: 'low', type: 'uint', offset: 0, length: 3 }] }
    ] }] };
    const bytes = Protocol.encode(schema, 'frame', { signed: -2, wide: '18446744073709551615', array: [15,255], flags: 5 });
    const record = Protocol.decode(bytes, schema), fields = new Map(record.flatFields.map(field => [field.path, field]));
    const fieldText = path => protocolValueText(fields.get(path).value, fields.get(path));
    assert.equal(fieldText('signed'), '-0x2'); assert.equal(fieldText('wide'), '0xFFFFFFFFFFFFFFFF');
    assert.equal(fieldText('array[1]'), '0xFF'); assert.equal(fieldText('flags.low'), '0x5');
    assert.equal(fields.get('signed').numeric, -2); assert.equal(fields.get('wide').numeric, null);
    assert.equal(protocolValueText([15,255], { displayBase: 'hex' }), '[0xF, 0xFF]');
    const frames = new FrameBuffer(1, 2); frames.appendRaw(bytes, 't', 1, 100);
    const csv = [...structuredCsvChunks(frames, () => record)].join('');
    assert.match(csv, /-2,18446744073709551615/); assert.doesNotMatch(csv, /0x/);
});

test('signed hexadecimal values and numeric enum codes encode without coercion or overflow', () => {
    const schema = { id: 'hex-input', framing: { fixedLength: 10 }, messages: [{ id: 'frame', fields: [
        { name: 'small', type: 'int8' }, { name: 'wide', type: 'int64' }, { name: 'mode', type: 'enum', baseType: 'uint8', enum: { 255: '运行' } }
    ] }] };
    const bytes = Protocol.encode(schema, 'frame', { small: '-0x80', wide: '-0x8000000000000000', mode: '0xFF' });
    const record = Protocol.decode(bytes, schema);
    assert.equal(record.fields.small, -128); assert.equal(record.fields.wide, -9223372036854775808n); assert.equal(record.fields.mode, 255);
    assert.throws(() => Protocol.encode(schema, 'frame', { small: '-0x81', wide: 0, mode: 1 }), /overflow/i);
});

test('protocol field selection honors parent paths, collapsed fields and mapped channel selections', () => {
    const { decodeRecord } = protocolFixture(), record = decodeRecord(0);
    assert.deepEqual(protocolVisibleFields(record, { fieldPaths: ['flags'] }).map(field => field.path), ['flags', 'flags.ready']);
    assert.deepEqual(protocolVisibleFields(record, { fieldPaths: ['flags'], collapsedPaths: ['flags'] }).map(field => field.path), ['flags']);
    assert.deepEqual(protocolVisibleFields(record, { selectedChannels: [5], mappings: [{ messageId: 'status', path: 'clock', channel: 5 }] })
        .map(field => field.path), ['clock']);
    assert.equal(protocolVisibleFields(record, { selectedChannels: [] }).length, 0);
    const unknown = protocolVisibleFields({ known: false, rawPayload: Uint8Array.of(3, 4), payloadOffset: 7, flatFields: [] });
    assert.deepEqual([unknown[0].path, unknown[0].byteOffset, unknown[0].endByte], ['rawPayload', 7, 9]);
});

test('structured CSV emits metadata, a union of paths, exact integers and JSON byte arrays in retained order', () => {
    const { frames, decodeRecord } = protocolFixture();
    const chunks = [...structuredCsvChunks(frames, decodeRecord, { timestamps: true, rowsPerChunk: 1 })];
    assert.equal(chunks.length, 3);
    assert.match(chunks[0], /^Index,Timestamp,MessageId,Message,Command,Status,Warnings,temperature,clock,flags,flags.ready,name,data\r\n$/);
    assert.match(chunks[1], /9007199254740993/); assert.match(chunks[2], /9007199254740994/);
    assert.match(chunks[1], /,"\[1,2\]"\r\n$/);
    assert.match(chunks[1], /^0,2023-11-14T22:13:20.000Z,status,设备状态,1,ok,/);
    const selected = [...structuredCsvChunks(frames, decodeRecord, { fieldPaths: ['clock'] })].join('');
    assert.match(selected, /Warnings,clock\r\n/); assert.doesNotMatch(selected, /temperature/);
    const generator = structuredCsvChunks(frames, decodeRecord); generator.next();
    for (let index = 0; index < 5; index++) frames.appendRaw(new Uint8Array(18), 't', index + 3);
    assert.throws(() => generator.next(), /覆盖/);
});

test('structured searches compare numeric tolerance, Unicode text and exact64 without rounding source values', () => {
    const { frames, decodeRecord } = protocolFixture();
    const number = new ProtocolFieldSearchSession(frames, { decodeRecord, ...parseProtocolFieldSearch('number', '20.6', .11, 'temperature') });
    assert.equal(number.step(1), false); assert.equal(number.position, 1); assert.equal(number.step(1), true);
    assert.equal(number.matches.length, 1); assert.deepEqual([number.matches[0].startByte, number.matches[0].endByte], [0, 4]);
    const exact = new ProtocolFieldSearchSession(frames, decodeRecord, { kind: 'integer64', query: '9007199254740993', path: 'clock' });
    exact.step(); assert.equal(exact.matches.length, 1); assert.equal(exact.matches[0].path, 'clock');
    assert.deepEqual([exact.matches[0].startByte, exact.matches[0].endByte], [4, 12]);
    const approximate = new ProtocolFieldSearchSession(frames, { decodeRecord, kind: 'number', value: '9007199254740993', path: 'clock' });
    approximate.step(); assert.equal(approximate.matches.length, 0);
    const text = new ProtocolFieldSearchSession(frames, { decodeRecord, kind: 'text', query: '温', path: 'name' });
    text.step(); assert.equal(text.matches.length, 2); assert.equal(text.matches[0].startByte, 13);
    const bit = new ProtocolFieldSearchSession(frames, { decodeRecord, kind: 'text', query: 'true', path: 'flags.ready' });
    bit.step(); assert.deepEqual([bit.matches[0].startByte, bit.matches[0].endByte, bit.matches[0].bitOffset, bit.matches[0].bitLength], [12, 13, 0, 1]);
    assert.throws(() => parseProtocolFieldSearch('integer64', 9007199254740992), /文本/);
    for (let index = 0; index < 5; index++) frames.appendRaw(new Uint8Array(18), 't', index + 3);
    assert.throws(() => text.step(), /覆盖/);
});


test('presentation radix applies to byte fields without converting string or floating data to hex', () => {
    const schema = { id: 'all-radix', schemaVersion: 3, messages: [{ id: 'frame', byteLength: 8, fields: [
        { name: 'marker', type: 'fixed', byteLength: 1, bytes: [170], displayBase: 'hex' },
        { name: 'text', type: 'string', byteLength: 2, displayBase: 'hex' },
        { name: 'floating', type: 'float32', byteLength: 4, displayBase: 'hex' },
        { name: 'raw', type: 'bytes', byteLength: 1, displayBase: 'hex' }
    ] }] };
    const encoded = Protocol.encode(schema, 'frame', { text: '12', floating: 3, raw: [255] });
    const record = Protocol.decode(encoded, schema);
    const text = path => { const field = record.flatFields.find(field => field.path === path); return protocolValueText(field.value, field); };
    assert.equal(text('marker'), '[0xAA]'); assert.equal(text('raw'), '[0xFF]');
    assert.equal(text('text'), '12'); assert.equal(text('floating'), '3');
});


test('Hex byte token boundaries cannot silently merge partial bytes', () => {
    const { parseProtocolBytes } = require('../protocolRecords');
    for (const value of ['1 2','F F','0x1 0x2','0x0xFF']) assert.throws(() => parseProtocolBytes(value, 'hex'), /字节/);
    assert.deepEqual(parseProtocolBytes('AA55', 'hex'), [170,85]);
    assert.deepEqual(parseProtocolBytes('0xAA 0x55', 'hex'), [170,85]);
    assert.deepEqual(parseProtocolBytes('170 85', 'dec'), [170,85]);
});


test('decimal formatting normalizes exact imported integer literals while text and floats retain their content', () => {
    assert.equal(protocolValueText('0xFFFFFFFFFFFFFFFF', { displayBase: 'dec', type: 'uint64' }), '18446744073709551615');
    assert.equal(protocolValueText('-0x8000000000000000', { displayBase: 'dec', type: 'int64' }), '-9223372036854775808');
    assert.equal(protocolValueText('0xFF', { displayBase: 'dec', type: 'string' }), '0xFF');
    assert.equal(protocolValueText(3, { displayBase: 'hex', type: 'enum', baseType: 'float32' }), '3');
});
