const test = require('node:test');
const assert = require('node:assert/strict');
const { ProtocolModel: M } = require('../protocolModel');
const { Protocol: P } = require('../protocolEngine');

function schema() {
    return { id: 'relations', schemaVersion: 3, symbolVersion: 2, messages: [{ id: 'frame', byteLength: 0, fields: [
        { id: 'header', name: 'header', type: 'struct', byteLength: 1, fields: [
            { id: 'size', name: 'data_length', type: 'uint8', byteLength: 1 }
        ] },
        { id: 'payload', name: 'payload', type: 'struct', byteLength: 0, lengthSource: { fieldId: 'size' }, fields: [
            { id: 'value', name: 'value', type: 'uint16', byteLength: 2 }
        ] },
        { id: 'sum', name: 'checksum_0', type: 'checksum', byteLength: 1,
            checksum: { type: 'sum', start: { fieldId: 'payload', edge: 'start' }, end: { fieldId: 'payload', edge: 'end' } } },
        { id: 'tail', name: 'tail', type: 'fixed', byteLength: 1, bytes: [13] }
    ] }] };
}
const coverage = (s, id) => M.getChecksumCoverage(s, id).map(row => [row.checksumId, row.coverage]);

test('checksum relations find complete variable segment coverage without relying on direct references only', () => {
    const s = schema(), before = JSON.stringify(s);
    assert.deepEqual(coverage(s, 'payload'), [['sum', 'full']]);
    assert.deepEqual(coverage(s, 'value'), [['sum', 'full']]);
    assert.deepEqual(coverage(s, 'header'), []);
    assert.deepEqual(coverage(s, 'sum'), []);
    assert.deepEqual(coverage(s, 'tail'), []);
    assert.equal(JSON.stringify(s), before);
    s.messages[0].fields[2].checksum.start = 0;
    assert.deepEqual(coverage(s, 'size'), [['sum', 'full']]);
    const renamed = M.renameField(s, 'payload', { name: 'body' }).protocol;
    assert.deepEqual(coverage(renamed, 'value'), [['sum', 'full']]);
});

test('coverage distinguishes partial numeric ranges, excludes disabled checks and does not guess expressions', () => {
    const s = schema(), payload = M.findField(s, 'payload'), sum = M.findField(s, 'sum');
    payload.byteLength = 2; delete payload.lengthSource;
    sum.checksum.start = 2; sum.checksum.end = 3;
    assert.deepEqual(coverage(s, 'payload'), [['sum', 'partial']]);
    sum.checksum.start = 'header.data_length';
    assert.deepEqual(coverage(s, 'payload'), [['sum', 'unknown']]);
    sum.type = 'uint8';
    assert.deepEqual(coverage(s, 'payload'), []);
});

test('mutually exclusive branches never claim to cover one another', () => {
    const s = schema();
    s.messages[0].fields = [{ id: 'choice', name: 'choice', type: 'choice', byteLength: 3, selector: '1', branches: [
        { id: 'a', equals: 1, fields: [
            { id: 'a.value', name: 'value', type: 'uint16', byteLength: 2 },
            { id: 'a.sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: {
                type: 'sum', start: { fieldId: 'a.value', edge: 'start' }, end: { fieldId: 'a.sum', edge: 'start' }
            } }
        ] },
        { id: 'b', equals: 2, fields: [{ id: 'b.value', name: 'value', type: 'bytes', byteLength: 3 }] }
    ] }];
    assert.deepEqual(coverage(s, 'a.value'), [['a.sum', 'full']]);
    assert.deepEqual(coverage(s, 'b.value'), []);
    assert.equal(M.getChecksumCoverage(s, 'choice')[0].conditional, true);
});

test('shared structure definitions report their local checksum in each instance', () => {
    const s = schema();
    s.structures = { Packet: [
        { id: 'value', name: 'value', type: 'uint8', byteLength: 1 },
        { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: {
            type: 'sum', start: { fieldId: 'value', edge: 'start' }, end: { fieldId: 'sum', edge: 'start' }
        } }
    ] };
    s.messages[0].fields = ['one', 'two'].map(id => ({ id, name: id, type: 'struct', ref: 'Packet', byteLength: 2 }));
    assert.deepEqual(M.getChecksumCoverage(s, 'value').map(row => [row.checksumPath, row.coverage]), [
        ['one.sum', 'full'], ['two.sum', 'full']
    ]);
});

test('coverage does not treat the first repeated occurrence or the TLV header as all value bytes', () => {
    const value = { id: 'value', name: 'value', type: 'uint8', byteLength: 1 };
    for (const tlv of [false, true]) {
        const items = tlv ? { id: 'items', name: 'items', type: 'tlv', byteLength: 3, until: 'end', headerFields: [
            { id: 'tag', name: 'tag', type: 'uint8', byteLength: 1 },
            { id: 'size', name: 'size', type: 'uint8', byteLength: 1 }
        ], lengthField: 'size', selector: 'tag', branches: [{ id: 'a', equals: 1, fields: [value] }] }
            : { id: 'items', name: 'items', type: 'repeat', byteLength: 0, lengthFrom: 'contents', count: 2, fields: [value] };
        const s = { id: 'repeated-coverage', schemaVersion: 3, symbolVersion: 2, messages: [{ id: 'frame', byteLength: tlv ? 4 : 3, fields: [
            items, { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: 0, end: tlv ? 2 : 1 } }
        ] }] };
        const wire = P.encode(s, 'frame', { items: tlv ? [{ tag: 1, value: 10 }] : [{ value: 10 }, { value: 20 }] });
        wire[tlv ? 2 : 1] = 99;
        assert.equal(P.decode(wire, s).valid, true, 'these value bytes are not covered by the configured check');
        assert.deepEqual(coverage(s, 'value'), [['sum', 'unknown']]);
    }
});
