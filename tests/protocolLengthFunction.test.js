const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol: P } = require('../protocolEngine');
const { ProtocolModel: M } = require('../protocolModel');
const { ReservedNames: R } = require('../reservedNames');
const vm = require('node:vm');

function schema(fields, length = 16) {
    return { id: 'len-function', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 128 }, messages: [
        { id: 'frame', byteLength: length, fields }
    ] };
}
test('LEN is a case-sensitive reserved protocol function with help and strict field arguments', () => {
    assert.ok(R.protocolFunctions.includes('LEN'));
    assert.ok(R.definitions.some(item => item.names.includes('LEN') && /字节/.test(item.description)));
    assert.ok(R.error('LEN', 'field')); assert.ok(R.error('LEN', 'channel'));
    assert.equal(R.error('len', 'field'), null);
    assert.throws(() => P.compile(schema([{ name: 'LEN', type: 'uint8', byteLength: 1 }], 1)), /保留|reserved/i);
    for (const expression of ['LEN()', 'LEN(1)', 'LEN(TRUE)', 'LEN(CURRENT)', 'LEN(data, data)', 'len(data)', 'LEN(data + 1)'])
        assert.throws(() => P.evaluateExpression(expression, { data: [1, 2] }), undefined, expression);
    assert.throws(() => P.evaluateExpression('LEN(data)', { data: [1, 2] }), /字节|wire|length|LEN/i);
});
test('LEN counts array wire bytes instead of elements for decode encode and stream scanning', () => {
    const s = schema([
        { id: 'samples', name: 'samples', type: 'float32', byteLength: 4, count: 2 },
        { id: 'copy', name: 'copy', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(samples)' }
    ]);
    const wire = [0,0,128,63,0,0,0,64,1,2,3,4,5,6,7,8];
    assert.deepEqual([...P.encode(s, 'frame', { samples: [1, 2], copy: [1,2,3,4,5,6,7,8] })], wire);
    const record = P.decode(wire, s); assert.equal(record.valid, true); assert.equal(record.fields.copy.length, 8);
    const parser = new P.StreamParser(s), received = []; parser.onFrameParsed = item => received.push(item);
    for (const byte of wire) parser.appendData([byte]);
    assert.equal(received.length, 1); assert.equal(received[0].fields.copy.length, 8);
});
test('LEN includes actual encoded text padding and is independent of decoded character count', () => {
    const s = schema([
        { id: 'text', name: 'text', type: 'string', encoding: 'utf-8', byteLength: 6 },
        { id: 'copy', name: 'copy', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(text)' }
    ], 12);
    const wire = [230,177,137,65,0,0,1,2,3,4,5,6];
    assert.deepEqual([...P.encode(s, 'frame', { text: '汉A', copy: [1,2,3,4,5,6] })], wire);
    const record = P.decode(wire, s);
    assert.equal(record.valid, true); assert.equal(record.fields.text, '汉A'); assert.equal(record.fields.copy.length, 6);
});
test('LEN resolves nested CURRENT PARENT and complete structure byte spans', () => {
    const s = schema([
        { id: 'header', name: 'header', type: 'uint16', byteLength: 2 },
        { id: 'group', name: 'group', type: 'struct', byteLength: 4, fields: [
            { id: 'a', name: 'a', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(PARENT.header)' },
            { id: 'b', name: 'b', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(CURRENT.a)' }
        ] },
        { id: 'copy', name: 'copy', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(group)' }
    ], 10);
    const wire = [0,0,1,2,3,4,5,6,7,8];
    assert.deepEqual([...P.encode(s, 'frame', { header: 0, group: { a: [1,2], b: [3,4] }, copy: [5,6,7,8] })], wire);
    const record = P.decode(wire, s); assert.equal(record.valid, true); assert.equal(record.fields.copy.length, 4);
});
test('whole-frame LEN supports fixed arrays and independently bounded payloads across arbitrary chunks', () => {
    const s = schema([
        { id: 'sync', name: 'sync', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
        { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
        { id: 'payload', name: 'payload', type: 'bytes', byteLength: 0, lengthSource: { fieldId: 'size' } },
        { id: 'end', name: 'end', type: 'fixed', byteLength: 1, bytes: [13], framingRole: 'end' }
    ], 0);
    s.messages[0].lengthFrom = 'LEN(payload) + LEN(sync) + LEN(size) + LEN(end)';
    const wire = [170,2,11,22,13];
    assert.deepEqual([...P.encode(s, 'frame', { payload: [11,22] })], wire);
    for (let split = 0; split <= wire.length; split++) {
        const parser = new P.StreamParser(s), received = []; parser.onFrameParsed = item => received.push(item);
        parser.appendData(wire.slice(0, split)); parser.appendData(wire.slice(split));
        assert.equal(received.length, 1, 'split ' + split); assert.equal(received[0].fields.payload.length, 2);
    }
    const array = schema([{ id: 'values', name: 'values', type: 'float32', byteLength: 4, count: 2 }], 0);
    array.messages[0].lengthFrom = 'LEN(values)';
    assert.equal(P.encode(array, 'frame', { values: [1,2] }).length, 8);
    assert.equal(P.decode([0,0,128,63,0,0,0,64], array).valid, true);
});
test('LEN rejects self future unknown and frame-boundary cycles instead of guessing byte counts', () => {
    for (const name of ['data', 'missing', 'later']) {
        const s = schema([
            { id: 'data', name: 'data', type: 'bytes', byteLength: 0, lengthFrom: `LEN(${name})` },
            { id: 'later', name: 'later', type: 'uint8', byteLength: 1 }
        ]);
        assert.throws(() => P.compile(s), /reference|unread|未知|引用|循环/i);
    }
    const circular = schema([{ id: 'data', name: 'data', type: 'bytes', byteLength: 0, lengthFrom: 'FRAME_LENGTH' }], 0);
    circular.messages[0].lengthFrom = 'LEN(data)';
    assert.throws(() => P.compile(circular), /reference|前置|循环|boundary/i);
    const renamed = M.renameField(schema([
        { id: 'first', name: 'first', type: 'bytes', byteLength: 2 },
        { id: 'second', name: 'second', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(first)' }
    ], 4), 'first', { name: 'payload' }).protocol;
    assert.equal(renamed.messages[0].fields[1].lengthFrom, 'LEN(payload)');
    assert.deepEqual([...P.encode(renamed, 'frame', { payload: [1,2], second: [3,4] })], [1,2,3,4]);
});

test('frame LEN preserves an explicit array count needed before the array is encoded', () => {
    const s = schema([
        { id: 'count', name: 'count', type: 'uint8', byteLength: 1 },
        { id: 'samples', name: 'samples', type: 'float32', byteLength: 4, count: 'count' }
    ], 0);
    s.messages[0].lengthFrom = 'LEN(samples) + 1';
    const wire = [2,0,0,128,63,0,0,0,64];
    assert.deepEqual([...P.encode(s, 'frame', { count: 2, samples: [1,2] })], wire);
    assert.equal(P.decode(wire, s).fields.samples.length, 2);
});

test('LEN tracks repeat and selected-branch spans in a variable frame without extra framing', () => {
    const s = schema([
        { id: 'items', name: 'items', type: 'repeat', byteLength: 0, lengthFrom: 'contents', count: 2,
            fields: [{ id: 'item', name: 'value', type: 'uint8', byteLength: 1 }] },
        { id: 'kind', name: 'kind', type: 'uint8', byteLength: 1 },
        { id: 'payload', name: 'payload', type: 'choice', byteLength: 0, lengthFrom: 'contents', selector: 'kind', branches: [
            { id: 'short', equals: 1, fields: [{ id: 'small', name: 'value', type: 'uint16', byteLength: 2 }] },
            { id: 'long', equals: 2, fields: [{ id: 'big', name: 'value', type: 'uint32', byteLength: 4 }] }
        ] },
        { id: 'copy', name: 'copy', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(items) + LEN(payload)' }
    ], 0);
    const wire = [8,9,1,52,18,1,2,3,4];
    assert.deepEqual([...P.encode(s, 'frame', { items: [{ value: 8 }, { value: 9 }], kind: 1, payload: { value: 4660 }, copy: [1,2,3,4] })], wire);
    assert.equal(P.decode(wire, s).valid, true);
    const parser = new P.StreamParser(s), received = []; parser.onFrameParsed = record => received.push(record);
    for (const byte of wire) parser.appendData([byte]);
    assert.equal(received.length, 1); assert.equal(received[0].fields.copy.length, 4);
});

test('the worker factory carries LEN semantics without DOM or additional imports', () => {
    const context = { console }; context.globalThis = context;
    vm.runInNewContext('(' + P.createFactorySource() + ')(globalThis)', context);
    const worker = context.SerialPlotter.Protocol;
    const s = schema([
        { id: 'source', name: 'source', type: 'uint16', byteLength: 2 },
        { id: 'copy', name: 'copy', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(source)' }
    ], 4);
    assert.deepEqual([...worker.encode(s, 'frame', { source: 4660, copy: [1,2] })], [52,18,1,2]);
    assert.equal(worker.decode([52,18,1,2], s).valid, true);
});

test('frame LEN chooses the actual branch width and derives fixed-count repeated contents', () => {
    const s = schema([
        { id: 'kind', name: 'kind', type: 'uint8', byteLength: 1 },
        { id: 'payload', name: 'payload', type: 'choice', byteLength: 0, lengthFrom: 'contents', selector: 'kind', branches: [
            { id: 'short', equals: 1, fields: [{ id: 'small', name: 'value', type: 'uint16', byteLength: 2 }] },
            { id: 'long', equals: 2, fields: [{ id: 'big', name: 'value', type: 'uint32', byteLength: 4 }] }
        ] },
        { id: 'items', name: 'items', type: 'repeat', byteLength: 0, lengthFrom: 'contents', count: 2,
            fields: [{ id: 'item', name: 'value', type: 'uint8', byteLength: 1 }] }
    ], 0);
    s.messages[0].lengthFrom = '1 + LEN(payload) + LEN(items)';
    const first = [1,52,18,8,9], second = [2,120,86,52,18,6,7];
    assert.deepEqual([...P.encode(s, 'frame', { kind: 1, payload: { value: 4660 }, items: [{ value: 8 }, { value: 9 }] })], first);
    assert.deepEqual([...P.encode(s, 'frame', { kind: 2, payload: { value: 305419896 }, items: [{ value: 6 }, { value: 7 }] })], second);
    const parser = new P.StreamParser(s), received = []; parser.onFrameParsed = record => received.push(record);
    for (const byte of [...first, ...second]) parser.appendData([byte]);
    assert.deepEqual(received.map(record => record.fields.payload.value), [4660, 305419896]);
});
