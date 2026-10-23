const test = require('node:test');
const assert = require('node:assert/strict');
const { ProtocolModel: M } = require('../protocolModel');
const { Protocol: P } = require('../protocolEngine');
function schema() {
    return { id: 'source-length', symbolVersion: 2, schemaVersion: 3, framing: { maxLength: 128 }, messages: [{ id: 'frame', name: 'frame', fields: [
        { id: 'size', name: 'data_length', type: 'uint8', byteLength: 1 },
        { id: 'data', name: 'data', type: 'bytes', byteLength: 2 },
        { id: 'tail', name: 'tail', type: 'fixed', byteLength: 1, bytes: [13] }
    ] }] };
}
test('source length role binds payload and whole frame with separate adjustments and exact wire bytes', () => {
    const original = schema();
    let s = M.bindLengthTarget(original, 'size', 'data', { unit: 2, adjustment: 0 });
    s = M.bindLengthTarget(s, 'size', 'frame', { unit: 2, adjustment: 2 });
    assert.equal(M.findField(s, 'size').role, 'length');
    assert.deepEqual(M.findField(s, 'data').lengthSource, { fieldId: 'size', unit: 2, adjustment: 0 });
    assert.equal(M.findField(s, 'data').byteLength, 0);
    assert.equal(M.getLengthBindings(s, 'size').length, 2);
    const bytes = P.encode(P.compile(s), 'frame', { data: [1,2,3,4] });
    assert.deepEqual([...bytes], [2,1,2,3,4,13]);
    assert.equal(P.decode(bytes, s).valid, true);
    assert.equal(original.messages[0].fields[1].byteLength, 2);
    const renamed = M.renameField(s, 'size', { name: 'payload_size' }).protocol;
    assert.equal(M.findField(renamed, 'data').lengthSource.fieldId, 'size');
    assert.equal(M.getLengthBindings(renamed, 'size')[0].targetId, 'frame');
});
test('length target candidates prevent future, branch, scalar and conflicting source bindings', () => {
    const source = schema();
    assert.ok(M.getLengthTargets(source, 'size').some(row => row.id === 'data'));
    assert.ok(!M.getLengthTargets(source, 'size').some(row => row.id === 'tail' || row.id === 'size'));
    assert.throws(() => M.bindLengthTarget(source, 'tail', 'data'), /unsigned|无符号|长度源/);
    assert.throws(() => M.bindLengthTarget(source, 'size', 'tail'), /长度目标|variable|固定/);
    assert.throws(() => M.bindLengthTarget(source, 'size', 'data', { unit: 0 }), /unit|单位/);
    source.messages[0].fields.push({ id: 'later', name: 'later', type: 'uint8', byteLength: 1 });
    assert.throws(() => M.bindLengthTarget(source, 'later', 'data'), /之前|先|before|因果/);
    source.messages[0].fields.splice(1, 0, { id: 'other', name: 'other', type: 'uint8', byteLength: 1 });
    const bound = M.bindLengthTarget(source, 'size', 'data');
    assert.throws(() => M.bindLengthTarget(bound, 'other', 'data'), /已|already/);
    assert.equal(M.findField(bound, 'data').lengthSource.fieldId, 'size');
});
test('length source removal is explicit and undo snapshots retain identity', () => {
    const bound = M.bindLengthTarget(schema(), 'size', 'data');
    const changed = M.unbindLengthTarget(bound, 'size', 'data');
    assert.equal(M.getLengthBindings(changed, 'size').length, 0);
    assert.equal(M.findField(changed, 'data').lengthSource, undefined);
    assert.equal(M.findField(changed, 'data').lengthFrom, '');
    const history = M.pushHistory(M.createHistory(bound), changed);
    assert.deepEqual(M.undo(history).present, bound);
});

function nestedLengthSchema() {
    return { id: 'nested-header-length', symbolVersion: 2, schemaVersion: 3, framing: { maxLength: 128 }, messages: [
        { id: 'frame', name: 'frame', byteLength: 0, fields: [
            { id: 'header', name: 'header', type: 'struct', byteLength: 2, fields: [
                { id: 'size', name: 'data_length', type: 'uint16', byteLength: 2 }
            ] },
            { id: 'payload', name: 'payload', type: 'bytes', byteLength: 2 },
            { id: 'sum', name: 'checksum_0', type: 'checksum', byteLength: 1,
                checksum: { type: 'sum', start: { fieldId: 'payload', edge: 'start' }, end: { fieldId: 'sum', edge: 'start' } } }
        ] }
    ] };
}

test('a nested header length can control later payload including a fixed checksum allowance', () => {
    const source = nestedLengthSchema();
    assert.ok(M.getLengthTargets(source, 'size').some(row => row.id === 'payload'));
    const bound = M.bindLengthTarget(source, 'size', 'payload', { adjustment: -1 });
    const bytes = P.encode(bound, 'frame', { payload: [10,20,30] });
    assert.deepEqual([...bytes], [4,0,10,20,30,60]);
    const decoded = P.decode(bytes, bound);
    assert.equal(decoded.valid, true);
    assert.equal(decoded.fields.header.data_length, 4);
    assert.deepEqual([...decoded.fields.payload], [10,20,30]);
    const frames = [], parser = new P.StreamParser(bound);
    parser.onFrameParsed = record => frames.push(record);
    for (const byte of bytes) parser.appendData([byte]);
    assert.equal(frames.length, 1);
    const renamed = M.renameField(bound, 'header', { name: 'prefix' }).protocol;
    assert.deepEqual([...P.encode(renamed, 'frame', { payload: [10,20,30] })], [...bytes]);
    assert.equal(M.findField(renamed, 'payload').lengthSource.fieldId, 'size');
});

test('nested length candidates allow later descendant targets but reject reverse or unavailable sources', () => {
    const source = nestedLengthSchema();
    source.messages[0].fields[1] = { id: 'body', name: 'body', type: 'struct', byteLength: 2, fields: [
        { id: 'payload', name: 'payload', type: 'bytes', byteLength: 2 }
    ] };
    assert.ok(M.getLengthTargets(source, 'size').some(row => row.id === 'payload'));
    assert.ok(!M.getLengthTargets(source, 'size').some(row => row.id === 'header'));
    const reverse = structuredClone(source);
    reverse.messages[0].fields.reverse();
    assert.ok(!M.getLengthTargets(reverse, 'size').some(row => row.id === 'payload'));
    for (const patch of [{ condition: '1' }, { count: 2 }, { type: 'repeat', count: 2 }]) {
        const unavailable = structuredClone(source);
        Object.assign(unavailable.messages[0].fields[0], patch);
        assert.ok(!M.getLengthTargets(unavailable, 'size').some(row => row.id === 'payload'), JSON.stringify(patch));
    }
    const optional = structuredClone(source);
    optional.messages[0].fields[0].fields[0].condition = '1';
    assert.ok(!M.getLengthTargets(optional, 'size').some(row => row.id === 'payload'));
    const branched = structuredClone(source);
    branched.messages[0].fields[0] = { id: 'choice', name: 'choice', type: 'choice', byteLength: 2, selector: '1', branches: [
        { id: 'branch', equals: 1, fields: source.messages[0].fields[0].fields }
    ] };
    assert.ok(!M.getLengthTargets(branched, 'size').some(row => row.id === 'payload'));
});
test('new protocol variable names reject reserved symbols but ordinary lower case names stay valid', () => {
    for (const name of ['FRAME_LENGTH','CH1','DIFF','X','SEQ','ABS','_raw']) assert.throws(() => M.renameField(schema(), 'size', { name }), /保留|reserved/i, name);
    assert.equal(M.findField(M.renameField(schema(), 'size', { name: 'seq' }).protocol, 'size').name, 'seq');
});


test('a reusable structure can configure its own causal length binding once for every instance', () => {
    const source = { id: 'shared-length', symbolVersion: 2, schemaVersion: 3, structures: { Packet: [
        { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
        { id: 'data', name: 'data', type: 'bytes', byteLength: 2 }
    ] }, messages: [{ id: 'frame', byteLength: 6, fields: [
        { id: 'one', name: 'one', type: 'struct', ref: 'Packet', byteLength: 3 },
        { id: 'two', name: 'two', type: 'struct', ref: 'Packet', byteLength: 3 }
    ] }] };
    const bound = M.bindLengthTarget(source, 'size', 'data');
    const bytes = P.encode(bound, 'frame', { one: { data: [11,12] }, two: { data: [21,22] } });
    assert.deepEqual([...bytes], [2,11,12,2,21,22]);
    assert.equal(P.decode(bytes, bound).valid, true);
    const independent = P.encode(bound, 'frame', { one: { data: [11] }, two: { data: [21,22] } });
    assert.deepEqual([...independent], [1,11,0,2,21,22]);
    const decoded = P.decode(independent, bound);
    assert.equal(decoded.fields.one.size, 1); assert.equal(decoded.fields.two.size, 2);
    assert.equal(bound.structures.Packet[1].lengthSource.fieldId, 'size');
});
