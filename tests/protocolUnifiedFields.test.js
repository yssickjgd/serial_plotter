'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol } = require('../protocolEngine');

function sample() {
    return { schemaVersion: 3, id: 'unified', endian: 'little', framing: { maxLength: 1024 }, messages: [{
        id: 'unified.frame', name: '整帧', byteLength: 0, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', byteLength: 2, bytes: [170, 85], framingRole: 'sync' },
            { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
            { id: 'cmd', name: 'cmd', type: 'uint8', byteLength: 1 },
            { id: 'payload', name: 'payload', type: 'choice', byteLength: 0, lengthSource: { fieldId: 'size' }, selector: 'cmd', branches: [
                { id: 'first', equals: 1, fields: [{ id: 'value32', name: 'value', type: 'float32', byteLength: 4 }] },
                { id: 'second', equals: 2, fields: [{ id: 'value16', name: 'value', type: 'uint16', byteLength: 2 }] },
                { id: 'unknown', default: true, fields: [{ id: 'raw', name: 'raw', type: 'bytes', byteLength: 0, lengthFrom: 'remaining' }] }
            ] },
            { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: { fieldId: 'sync', edge: 'start' }, end: { fieldId: 'sum', edge: 'start' } } },
            { id: 'end', name: 'end', type: 'fixed', byteLength: 2, bytes: [13, 10], framingRole: 'end' }
        ]
    }] };
}

test('whole-frame fields encode lengths, command branches and checksum bytes in their actual positions', () => {
    const compiled = Protocol.compile(sample());
    const bytes = Protocol.encode(compiled, 'unified.frame', { cmd: 1, payload: { value: 1.5 } });
    assert.deepEqual(Array.from(bytes), [170, 85, 4, 1, 0, 0, 192, 63, 3, 13, 10]);
    const record = Protocol.decode(bytes, compiled);
    assert.equal(record.valid, true); assert.equal(record.fields.size, 4);
    assert.equal(record.fields.payload.value, 1.5);
    assert.equal(record.flatFields.find(field => field.fieldId === 'sum').byteOffset, 8);
    const short = Protocol.encode(compiled, 'unified.frame', { cmd: 2, payload: { value: 0x1234 } });
    assert.equal(short.length, 9); assert.equal(short[2], 2);
    assert.equal(Protocol.decode(short, compiled).fields.payload.value, 0x1234);
    const broken = bytes.slice(); broken[8] ^= 1;
    assert.throws(() => Protocol.decode(broken, compiled), /checksum/i);
});

test('field-driven stream framing handles arbitrary splits, back-to-back command lengths and noise', () => {
    const compiled = Protocol.compile(sample());
    const first = Protocol.encode(compiled, 'unified.frame', { cmd: 1, payload: { value: 1.5 } });
    const second = Protocol.encode(compiled, 'unified.frame', { cmd: 2, payload: { value: 24 } });
    const input = Uint8Array.from([99, ...first, ...second]);
    for (let split = 0; split <= input.length; split++) {
        const received = [], parser = new Protocol.StreamParser(compiled);
        parser.onFrameParsed = record => received.push(record);
        parser.appendData(input.slice(0, split)); parser.appendData(input.slice(split));
        assert.equal(received.length, 2, 'split ' + split);
        assert.deepEqual(received.map(record => record.fields.payload.value), [1.5, 24]);
    }
});

test('zero byte lengths require a source and scalar widths must match their types', () => {
    const schema = sample(); delete schema.messages[0].fields[3].lengthSource;
    assert.throws(() => Protocol.compile(schema), /length|长度|boundary/i);
    const scalar = sample(); scalar.messages[0].fields[2].byteLength = 3;
    assert.throws(() => Protocol.compile(scalar), /width|字节|length/i);
    const badReference = sample(); badReference.messages[0].fields[3].lengthSource.fieldId = 'end';
    assert.throws(() => Protocol.compile(badReference), /reference|length|scalar|source/i);
});

test('delimiter-bound bytes exclude independent fixed fields and wait for a complete delimiter', () => {
    const schema = { schemaVersion: 3, id: 'delimited', messages: [{ id: 'frame', byteLength: 0, fields: [
        { id: 'open', name: 'open', type: 'fixed', byteLength: 2, bytes: [170, 85], framingRole: 'sync' },
        { id: 'text', name: 'text', type: 'string', byteLength: 0, encoding: 'utf-8', boundary: { startFieldId: 'open', endFieldId: 'close' } },
        { id: 'close', name: 'close', type: 'fixed', byteLength: 2, bytes: [13, 10], framingRole: 'end' }
    ] }] };
    const compiled = Protocol.compile(schema), expected = Protocol.encode(compiled, 'frame', { text: '你好' });
    const decoded = Protocol.decode(expected, compiled);
    assert.equal(decoded.fields.text, '你好');
    assert.equal(decoded.flatFields.find(field => field.fieldId === 'text').endByte, expected.length - 2);
    const records = [], parser = new Protocol.StreamParser(compiled);
    parser.onFrameParsed = record => records.push(record);
    parser.appendData(expected.slice(0, -1)); assert.equal(records.length, 0);
    parser.appendData(expected.slice(-1)); assert.equal(records.length, 1);
});

test('field checksum ranges reject self coverage and cycles without silently rewriting data fields', () => {
    const schema = sample(); schema.messages[0].fields[4].checksum.end.edge = 'end';
    assert.throws(() => Protocol.compile(schema), /checksum|cycle|self|range/i);
    const cycle = { schemaVersion: 3, id: 'cycle', messages: [{ id: 'frame', byteLength: 2, fields: [
        { id: 'a', name: 'a', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: { fieldId: 'b', edge: 'start' }, end: { fieldId: 'b', edge: 'end' } } },
        { id: 'b', name: 'b', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: { fieldId: 'a', edge: 'start' }, end: { fieldId: 'a', edge: 'end' } } }
    ] }] };
    assert.throws(() => Protocol.compile(cycle), /checksum|cycl/i);
});

test('repeated structures keep exact field checksum scopes and root remainder requires a real end', () => {
    const schema = { schemaVersion: 3, id: 'items', messages: [{ id: 'frame', byteLength: 0, fields: [
        { id: 'start', name: 'start', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
        { id: 'items', name: 'items', type: 'struct', byteLength: 2, count: 2, fields: [
            { id: 'value', name: 'value', type: 'uint8', byteLength: 1 },
            { id: 'check', name: 'check', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: { fieldId: 'value', edge: 'start' }, end: { fieldId: 'check', edge: 'start' } } }
        ] }
    ] }] };
    const bytes = Protocol.encode(schema, 'frame', { items: [{ value: 3 }, { value: 7 }] });
    assert.deepEqual([...bytes], [170,3,3,7,7]);
    assert.deepEqual(Protocol.decode(bytes, schema).fields.items.map(item => item.value), [3,7]);
    const invalid = bytes.slice(); invalid[4] = 3;
    assert.throws(() => Protocol.decode(invalid, schema), /checksum/i);
    const remaining = { schemaVersion: 3, id: 'tail', messages: [{ id: 'frame', byteLength: 0, fields: [
        { id: 'a', name: 'a', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
        { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'remaining - 1' },
        { id: 'z', name: 'z', type: 'fixed', byteLength: 1, bytes: [85], framingRole: 'end' }
    ] }] };
    const parser = new Protocol.StreamParser(remaining), records = []; parser.onFrameParsed = record => records.push(record);
    parser.appendData([170,1,2]); assert.equal(records.length, 0);
    parser.appendData([85]); assert.equal(records.length, 1); assert.deepEqual([...records[0].fields.body], [1,2]);
});

test('legacy array-style messages migrate into inline command branches with stable IDs and exact wire bytes', () => {
    const { ProtocolModel } = require('../protocolModel');
    const legacy = { id: 'old', endian: 'little', framing: { header: [170], length: { offset: 1, type: 'uint8', adjustment: 5 } },
        headerFields: [{ id: 'old.sof', name: 'sof', type: 'uint8', offset: 0 }, { id: 'old.size', name: 'size', type: 'uint8', offset: 1 }],
        command: { offset: 2, type: 'uint8' }, payloadOffset: 3, payloadEnd: -2,
        checksums: [{ id: 'old.crc', type: 'sum', width: 16, offset: -2, start: 0, end: -2 }],
        messages: [{ id: 'old.a', name: 'A', command: 1, fields: [{ id: 'old.value', name: 'value', type: 'float32' }] },
            { id: 'old.b', name: 'B', command: 2, fields: [{ id: 'old.other', name: 'other', type: 'uint16' }] }] };
    const before = JSON.stringify(legacy), unified = ProtocolModel.toUnified(legacy);
    assert.equal(JSON.stringify(legacy), before);
    assert.equal(unified.schemaVersion, 3); assert.equal(unified.messages.length, 1);
    assert.equal(unified.command, undefined); assert.equal(unified.checksums, undefined);
    const compiled = Protocol.compile(unified);
    for (const [id, values] of [['old.a', { value: 1.5 }], ['old.b', { other: 356 }]]) {
        const oldBytes = Protocol.encode(legacy, id, values), newBytes = Protocol.encode(compiled, id, values);
        assert.deepEqual(newBytes, oldBytes);
        const previous = Protocol.decode(oldBytes, legacy), record = Protocol.decode(oldBytes, compiled);
        assert.equal(record.messageId, previous.messageId); assert.equal(record.command, previous.command);
        assert.equal(record.valid, true);
        const original = previous.flatFields.find(field => field.path === (id === 'old.a' ? 'value' : 'other'));
        const migrated = record.flatFields.find(field => field.fieldId === original.fieldId);
        assert.equal(migrated.path, original.path); assert.equal(migrated.numeric, original.numeric);
        assert.equal(migrated.byteOffset, original.byteOffset);
    }
});

test('the RoboMaster catalog migrates every fixed layout without changing bytes, field identities or nested paths', () => {
    const { ProtocolModel } = require('../protocolModel'), { RoboMasterProtocol } = require('../robomasterProtocol');
    const previous = Protocol.compile(RoboMasterProtocol.legacySchema), compiled = Protocol.compile(RoboMasterProtocol.createSchema());
    for (const message of previous.messages) {
        if (message.dispatch || message.commandRange) continue;
        const fields = message.parent ? { sender_id: 1, receiver_id: 257, content: {} } : {};
        const options = { sequence: 254, layout: 'detail' };
        const original = Protocol.encode(previous, message.id, fields, options);
        assert.deepEqual(Protocol.encode(compiled, message.id, fields, options), original, message.id);
        const oldRecord = Protocol.decode(original, previous), record = Protocol.decode(original, compiled);
        assert.equal(record.messageId, oldRecord.messageId); assert.equal(record.subcommand, oldRecord.subcommand);
        assert.equal(record.valid, true, message.id);
        for (const field of oldRecord.flatFields) {
            const actual = record.flatFields.find(item => item.fieldId === field.fieldId && item.path === field.path);
            assert.ok(actual, message.id + ': ' + field.path);
            assert.equal(actual.byteOffset, field.byteOffset); assert.equal(actual.endByte, field.endByte);
            assert.equal(actual.numeric, field.numeric);
        }
    }
});

test('legacy header byte views can overlap fixed synchronization without losing their numeric IDs', () => {
    const { ProtocolModel } = require('../protocolModel');
    const legacy = { id: 'views', framing: { header: [170,187], fixedLength: 4 },
        headerFields: [{ id: 'first', name: 'first', type: 'uint8', offset: 0 }, { id: 'second', name: 'second', type: 'uint8', offset: 1 }],
        command: { offset: 2, type: 'uint8' }, payloadOffset: 3,
        messages: [{ id: 'v', command: 1, fields: [{ id: 'data', name: 'data', type: 'uint8' }] }] };
    const unified = ProtocolModel.toUnified(legacy), expected = Protocol.encode(legacy, 'v', { data: 5 });
    assert.deepEqual(Protocol.encode(unified, 'v', { data: 5 }), expected);
    const record = Protocol.decode(expected, unified);
    assert.equal(record.values['header.first'], 170); assert.equal(record.values['header.second'], 187);
    assert.ok(record.flatFields.some(field => field.fieldId === 'first'));
});

test('legacy count repeats stop before following fields after migration', () => {
    const { ProtocolModel } = require('../protocolModel');
    const old = { id: 'repeat-old', framing: { fixedLength: 3 }, messages: [{ id: 'frame', fields: [
        { name: 'items', type: 'repeat', count: 2, fields: [{ name: 'v', type: 'uint8' }] }, { name: 'tail', type: 'uint8' }
    ] }] };
    const schema = ProtocolModel.toUnified(old), fields = { items: [{ v: 1 }, { v: 2 }], tail: 9 };
    assert.deepEqual([...Protocol.encode(schema, 'frame', fields)], [1,2,9]);
    const record = Protocol.decode([1,2,9], schema); assert.equal(record.valid, true); assert.equal(record.fields.tail, 9);
});

test('frame-length expressions encode against known frame bounds rather than an initial zero', () => {
    const schema = { schemaVersion: 3, id: 'fixed-body', messages: [{ id: 'frame', byteLength: 4, fields: [
        { name: 'sync', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
        { name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'frameLength - 2' },
        { name: 'end', type: 'fixed', byteLength: 1, bytes: [85], framingRole: 'end' }
    ] }] };
    assert.deepEqual([...Protocol.encode(schema, 'frame', { body: [1,2] })], [170,1,2,85]);
});

test('dynamic array counts determine frame boundaries instead of being inferred as one item', () => {
    const schema = { schemaVersion: 3, id: 'counted', messages: [{ id: 'frame', byteLength: 0, fields: [
        { name: 'n', type: 'uint8', byteLength: 1 }, { name: 'values', type: 'uint8', byteLength: 1, count: 'n' }
    ] }] };
    assert.equal(Protocol.compile(schema).framing.fixedLength, undefined);
    assert.deepEqual([...Protocol.encode(schema, 'frame', { n: 2, values: [10,20] })], [2,10,20]);
    const records = [], parser = new Protocol.StreamParser(schema); parser.onFrameParsed = record => records.push(record);
    parser.appendData([2,10]); assert.equal(records.length, 0);
    parser.appendData([20,1,30]); assert.equal(records.length, 2);
    assert.deepEqual(records.map(record => record.fields.values), [[10,20],[30]]);
});

test('migrated range commands honor the chosen command and fixed legacy padding is retained', () => {
    const { ProtocolModel } = require('../protocolModel');
    const range = { id: 'range', framing: { fixedLength: 2 }, command: { offset: 0, type: 'uint8' }, payloadOffset: 1,
        messages: [{ id: 'range.msg', commandRange: [1,3], fields: [{ name: 'v', type: 'uint8' }] }] };
    const bytes = Protocol.encode(ProtocolModel.toUnified(range), 'range.msg', { v: 7 }, { command: 2 });
    assert.deepEqual([...bytes], [2,7]); assert.equal(Protocol.decode(bytes, ProtocolModel.toUnified(range)).messageId, 'range.msg');
    const padded = { id: 'padded', framing: { fixedLength: 4 }, messages: [{ id: 'frame', length: 4, fields: [{ name: 'v', type: 'uint8' }] }] };
    assert.deepEqual(Protocol.encode(ProtocolModel.toUnified(padded), 'frame', { v: 7 }), Protocol.encode(padded, 'frame', { v: 7 }));
});

test('checksum cycles inside a conditional segment are rejected before applying the protocol', () => {
    const schema = { schemaVersion: 3, id: 'cycles', messages: [{ id: 'frame', byteLength: 3, fields: [
        { name: 'command', type: 'uint8', byteLength: 1 },
        { name: 'payload', type: 'choice', byteLength: 2, selector: 'command', branches: [{ id: 'branch', equals: 1, fields: [
            { id: 'a', name: 'a', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: { fieldId: 'b', edge: 'start' }, end: { fieldId: 'b', edge: 'end' } } },
            { id: 'b', name: 'b', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: { fieldId: 'a', edge: 'start' }, end: { fieldId: 'a', edge: 'end' } } }
        ] }] }
    ] }] };
    assert.throws(() => Protocol.compile(schema), /cyclic checksum/i);
});

test('nested stable length references use the owning ancestor scope and survive renaming', () => {
    const { ProtocolModel: M } = require('../protocolModel');
    const schema = { schemaVersion: 3, id: 'nested-length', messages: [{ id: 'frame', byteLength: 3, fields: [
        { id: 'outer', name: 'outer', type: 'struct', byteLength: 3, fields: [
            { id: 'n', name: 'n', type: 'uint8', byteLength: 1 },
            { id: 'inner', name: 'inner', type: 'struct', byteLength: 2, fields: [
                { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthSource: { fieldId: 'n' } }
            ] }
        ] }
    ] }] };
    const renamed = M.renameField(schema, 'n', { name: 'size' }).protocol;
    assert.equal(M.findField(renamed, 'body').lengthSource.fieldId, 'n');
    const bytes = Protocol.encode(renamed, 'frame', { outer: { inner: { body: [5,6] } } });
    assert.deepEqual([...bytes], [2,5,6]);
    assert.deepEqual([...Protocol.decode(bytes, renamed).fields.outer.inner.body], [5,6]);
});

test('implicit sequential legacy header positions migrate without duplicate length fields', () => {
    const { ProtocolModel: M } = require('../protocolModel');
    const old = { id: 'sequential', framing: { header: [170], length: { offset: 1, type: 'uint8', adjustment: 3 } },
        command: { offset: 2, type: 'uint8' }, payloadOffset: 3,
        headerFields: [{ id: 'sof', name: 'sof', type: 'uint8' }, { id: 'len', name: 'len', type: 'uint8' }],
        messages: [{ id: 'm', command: 1, fields: [{ id: 'v', name: 'v', type: 'uint8' }] }] };
    const unified = M.toUnified(old), renamed = M.renameField(unified, 'len', { name: 'size' }).protocol;
    assert.equal(renamed.messages[0].lengthSource.fieldId, 'len');
    assert.deepEqual(Protocol.encode(renamed, 'm', { v: 3 }), Protocol.encode(old, 'm', { v: 3 }));
    assert.equal(Protocol.decode([170,1,1,3], renamed).valid, true);
});

test('checksum references keep stable IDs through field renaming and reordering', () => {
    const { ProtocolModel: M } = require('../protocolModel');
    let schema = sample();
    schema = M.renameField(schema, 'payload', { name: 'content' }).protocol;
    schema = M.renameField(schema, 'sum', { name: 'verify' }).protocol;
    schema = M.moveField(schema, 'cmd', 'unified.frame', 1);
    const check = M.findField(schema, 'sum'); assert.equal(check.checksum.end.fieldId, 'sum');
    const bytes = Protocol.encode(schema, 'unified.frame', { cmd: 1, content: { value: 513 } });
    assert.equal(Protocol.decode(bytes, schema).valid, true);
    assert.ok(M.inspectReferences(schema, 'sum').length > 0);
});

test('structural framing retains a complete CRC failure and continues at the next frame', () => {
    const { ProtocolModel } = require('../protocolModel'), { RoboMasterProtocol } = require('../robomasterProtocol');
    const schema = ProtocolModel.toUnified(RoboMasterProtocol.schema ?? RoboMasterProtocol.compiled.schema);
    const good = Protocol.encode(schema, 'rm2026.0001', {}, { layout: 'detail' });
    const bad = good.slice(); bad[1] = 255; bad[2] = 15;
    const frames = [], parser = new Protocol.StreamParser(schema); parser.onFrameParsed = (record, time, bytes) => frames.push({record,bytes});
    parser.appendData([...bad, ...good]); assert.equal(frames.length, 2);
    assert.equal(frames[0].record.valid,false); assert.equal(frames[0].record.flatFields.every(field=>field.numeric===null),true);
    assert.deepEqual(frames[0].bytes,bad); assert.deepEqual(frames[1].bytes, good); assert.equal(frames[1].record.valid,true);
});

test('migration preserves independent byte orders of length, command and checksum storage', () => {
    const { ProtocolModel } = require('../protocolModel');
    const old = { id: 'mixed-order', endian: 'little', framing: { header: [170], length: { offset: 1, type: 'uint16', endian: 'big', adjustment: 7 } },
        command: { offset: 3, type: 'uint16', endian: 'big' }, payloadOffset: 5, payloadEnd: -2,
        checksums: [{ id: 'sum', type: 'sum', width: 16, endian: 'big', start: 0, end: -2, offset: -2 }],
        messages: [{ id: 'big', command: 0x1234, fields: [{ id: 'value', name: 'value', type: 'uint16' }] }] };
    const schema = ProtocolModel.toUnified(old), expected = Protocol.encode(old, 'big', { value: 0x5678 });
    assert.deepEqual(Protocol.encode(schema, 'big', { value: 0x5678 }), expected);
    assert.equal(Protocol.decode(expected, schema).fields.value, 0x5678);
});

module.exports = { sample };
