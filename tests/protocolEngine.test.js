const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol } = require('../protocolEngine');

test('uppercase protocol expressions use bounded scopes and preserve case-sensitive data fields', () => {
    const compiled = Protocol.compile({ id: 'symbols.v2', symbolVersion: 2, schemaVersion: 2,
        framing: { fixedLength: 6 }, messages: [{ id: 'packet', fields: [
            { name: 'frameLength', type: 'uint8' },
            { name: 'segment', type: 'struct', length: 4, fields: [
                { name: 'count', type: 'uint8' },
                { name: 'bytes', type: 'bytes', length: 'MIN(CURRENT.count, PARENT.frameLength, REMAINING)', condition: 'TRUE && !FALSE' }
            ] }, { name: 'tail', type: 'uint8', condition: 'FRAME_LENGTH == 6 && PAYLOAD_LENGTH == 6' }
        ] }] });
    const golden = Uint8Array.of(3, 3, 8, 9, 10, 77);
    assert.deepEqual(Protocol.encode(compiled, 'packet', { frameLength: 3, segment: { count: 3, bytes: [8, 9, 10] }, tail: 77 }), golden);
    const record = Protocol.decode(golden, compiled);
    assert.equal(record.fields.tail, 77); assert.equal(record.fields.frameLength, 3);
    assert.deepEqual(record.fields.segment.bytes, Uint8Array.of(8, 9, 10));
    assert.equal(Protocol.evaluateExpression('ABS(-7) + MAX(2, 5)', {}), 12);
    assert.throws(() => Protocol.evaluateExpression('min(2, 3)'), /function/i);
    assert.throws(() => Protocol.evaluateExpression('true'), /identifier/i);
});

test('symbol v2 rejects reserved data names but keeps lowercase lookalikes as real fields', () => {
    for (const name of ['FRAME_LENGTH', 'CURRENT', 'SEQ', 'CH1', 'X', 'MIN', '_unknownTail', 'rawPayload']) {
        assert.throws(() => Protocol.compile({ id: 'reserved', symbolVersion: 2, framing: { fixedLength: 1 },
            messages: [{ id: 'm', fields: [{ name, type: 'uint8' }] }] }), /保留|reserved|conflict/i, name);
    }
    const compiled = Protocol.compile({ id: 'lower', symbolVersion: 2, framing: { fixedLength: 3 },
        messages: [{ id: 'm', fields: [{ name: 'seq', type: 'uint8' }, { name: 'frameLength', type: 'uint8' },
            { name: 'last', type: 'uint8', condition: 'seq == 4 && frameLength == 2' }] }] });
    assert.deepEqual(Protocol.encode(compiled, 'm', { seq: 4, frameLength: 2, last: 9 }, { sequence: 88 }), Uint8Array.of(4, 2, 9));
    assert.throws(() => Protocol.compile({ id: 'strict.lower', symbolVersion: 2, framing: { fixedLength: 1 },
        messages: [{ id: 'm', fields: [{ name: 'data', type: 'bytes', length: 'remaining' }] }] }), /reference|scope|remaining/i);
    assert.throws(() => Protocol.compile({ id: 'strict.structure', symbolVersion: 2, framing: { fixedLength: 1 },
        structures: { unused: [{ name: 'SEQ', type: 'uint8' }] }, messages: [{ id: 'm', fields: [] }] }), /保留|reserved|conflict/i);
});

test('legacy symbol migration resolves field scopes and preserves original identities and references', () => {
    const input = { id: 'legacy.symbols', schemaVersion: 2, framing: { fixedLength: 8 }, headerFields: [], messages: [{ id: 'm', fields: [
        { id: 'real.length', name: 'frameLength', type: 'uint8' },
        { id: 'real.seq', name: 'seq', type: 'uint8' },
        { name: 'nested', type: 'struct', length: 5, fields: [
            { name: 'sequence', type: 'uint8' }, { name: 'length', type: 'uint8' },
            { name: 'data', type: 'bytes', length: 'min(parent.frameLength, current.length, remaining)', condition: 'parent.seq == 5 && sequence == 6 && true' }
        ] }, { name: 'tail', type: 'uint8', condition: 'payloadLength == 8' }
    ] }] };
    const result = Protocol.migrateSymbols(input), migrated = result.schema;
    assert.equal(migrated.symbolVersion, 3); assert.equal(input.symbolVersion, undefined);
    assert.equal(migrated.messages[0].fields[0].name, 'frameLength');
    assert.equal(migrated.messages[0].fields[1].name, 'seq');
    assert.equal(migrated.messages[0].fields[1].id, 'real.seq');
    const nested = migrated.messages[0].fields[2].fields;
    assert.equal(nested[2].length, 'MIN(PARENT.frameLength, CURRENT.length, REMAINING)');
    assert.equal(nested[2].condition, 'PARENT.seq == 5 && sequence == 6 && TRUE');
    assert.ok(!result.renames.some(item => item.fieldId === 'real.seq'));
    const golden = Uint8Array.of(3, 5, 6, 3, 11, 12, 13, 19), compiled = Protocol.compile(input);
    assert.deepEqual(Protocol.encode(compiled, 'm', { frameLength: 3, seq: 5, nested: { sequence: 6, length: 3, data: [11, 12, 13] }, tail: 19 }), golden);
    assert.equal(Protocol.decode(golden, compiled).fields.nested.sequence, 6);
    assert.deepEqual(Protocol.migrateSymbols(migrated), { schema: migrated, renames: [] });
});

test('legacy reserved field migration avoids collisions and tracks nested array and bit paths', () => {
    const old = { id: 'conflicts', framing: { fixedLength: 5 }, messages: [{ id: 'm', fields: [
        { name: 'field_SEQ', type: 'uint8' }, { id: 'seq.upper', name: 'SEQ', type: 'uint8' },
        { name: 'group', type: 'struct', count: 1, fields: [{ name: 'flags', type: 'bitfield', byteLength: 1, bits: [{ name: 'X', offset: 0, length: 1 }] }] },
        { name: 'seq', type: 'uint8' }, { name: 'last', type: 'uint8', condition: 'SEQ == 4 && seq == 6' }
    ] }] };
    const { schema, renames } = Protocol.migrateSymbols(old), fields = schema.messages[0].fields;
    assert.equal(fields[1].name, 'field_SEQ_2');
    assert.equal(fields[4].condition, 'field_SEQ_2 == 4 && seq == 6');
    assert.equal(fields[2].fields[0].bits[0].name, 'field_X');
    assert.ok(renames.some(item => item.fieldId === 'seq.upper' && item.pathAfter === 'field_SEQ_2'));
    const compiled = Protocol.compile(schema), golden = Uint8Array.of(1, 4, 1, 6, 9);
    assert.deepEqual(Protocol.encode(compiled, 'm', { field_SEQ: 1, field_SEQ_2: 4, group: [{ flags: { field_X: 1 } }], seq: 6, last: 9 }), golden);
    const record = Protocol.decode(golden, compiled);
    assert.equal(record.fields.last, 9); assert.equal(record.values['group[0].flags.field_X'], 1);
});

test('legacy TLV selectors resolve renamed item header fields in their item scope', () => {
    const schema = { id: 'tlv.symbols', schemaVersion: 2, framing: { fixedLength: 3 }, messages: [{ id: 'm', fields: [
        { name: 'items', type: 'tlv', until: 'end', selector: 'seq', lengthField: 'length', headerFields: [
            { name: 'seq', type: 'uint8' }, { name: 'length', type: 'uint8' }
        ], branches: [{ equals: 1, fields: [{ name: 'value', type: 'uint8' }] }] }
    ] }] };
    const compiled = Protocol.compile(schema), golden = Uint8Array.of(1, 1, 42);
    assert.equal(compiled.schema.messages[0].fields[0].selector, 'seq');
    assert.deepEqual(Protocol.encode(compiled, 'm', { items: [{ seq: 1, value: 42 }] }), golden);
    assert.equal(Protocol.decode(golden, compiled).fields.items[0].value, 42);
});

test('legacy choice member references follow consistent branch field renames', () => {
    const schema = { id: 'choice.symbols', schemaVersion: 2, framing: { fixedLength: 3 }, messages: [{ id: 'm', fields: [
        { name: 'tag', type: 'uint8' }, { name: 'payload', type: 'choice', length: 1, selector: 'tag', branches: [
            { equals: 1, fields: [{ name: 'seq', type: 'uint8' }] },
            { equals: 2, fields: [{ name: 'seq', type: 'uint8' }] }
        ] }, { name: 'tail', type: 'uint8', condition: 'payload.seq == 7' }
    ] }] };
    const compiled = Protocol.compile(schema);
    assert.equal(compiled.schema.messages[0].fields[2].condition, 'payload.seq == 7');
    for (const tag of [1, 2]) {
        const golden = Uint8Array.of(tag, 7, 9);
        assert.deepEqual(Protocol.encode(compiled, 'm', { tag, payload: { seq: 7 }, tail: 9 }), golden);
        const record = Protocol.decode(golden, compiled);
        assert.equal(record.valid, true); assert.equal(record.fields.tail, 9);
    }
    const ambiguous = structuredClone(schema);
    for(const branch of ambiguous.messages[0].fields[1].branches)branch.fields[0].name='SEQ';
    ambiguous.messages[0].fields[2].condition='payload.SEQ == 7';
    ambiguous.messages[0].fields[1].branches[1].fields.unshift({ name: 'field_SEQ', type: 'uint8' });
    assert.throws(() => Protocol.migrateSymbols(ambiguous), /ambiguous.*branch|branch.*ambiguous/i);
});

test('legacy dispatch scope names migrate with their child paths and stable identities', () => {
    for (const [before, after] of [['SEQ', 'field_SEQ'], ['seq', 'seq']]) {
        const schema = { id: 'dispatch.symbols', framing: { fixedLength: 3 }, payloadOffset: 1,
            command: { offset: 0, type: 'uint8' }, messages: [{ id: 'parent', command: 1,
                fields: [{ name: 'kind', type: 'uint8' }], dispatch: { name: before, field: 'kind', offset: 1,
                    messages: [{ id: 'child', command: 2, fields: [{ id: 'wire.seq', name: 'seq', type: 'uint8' }] }] } }] };
        const { schema: migrated, renames } = Protocol.migrateSymbols(schema);
        assert.equal(migrated.messages[0].dispatch.name, after);
        if(before!==after)assert.ok(renames.some(item => item.fieldId === 'wire.seq' && item.pathBefore === before + '.seq' && item.pathAfter === after + '.seq'));
        else assert.ok(!renames.some(item=>item.fieldId==='wire.seq'));
        const golden = Uint8Array.of(1, 2, 7), compiled = Protocol.compile(migrated);
        assert.deepEqual(Protocol.encode(compiled, 'child', { [after]: { seq: 7 } }), golden);
        const record = Protocol.decode(golden, compiled);
        assert.equal(record.fields[after].seq, 7); assert.equal(record.flatFields.find(field => field.fieldId === 'wire.seq').path, after + '.seq');
    }
});

test('legacy shared structures reject incompatible parent symbol meanings before rewriting data', () => {
    const schema = { id: 'shared.symbols', framing: { fixedLength: 4 }, structures: { shared: [
        { name: 'data', type: 'bytes', length: 'frameLength' }
    ] }, messages: [{ id: 'm', fields: [
        { name: 'first', type: 'struct', fields: [{ name: 'frameLength', type: 'uint8' }, { name: 'value', type: 'struct', ref: 'shared' }] },
        { name: 'second', type: 'struct', ref: 'shared' }
    ] }] };
    assert.throws(() => Protocol.migrateSymbols(schema), /ambiguous scopes/i);
    assert.equal(schema.structures.shared[0].length, 'frameLength'); assert.equal(schema.symbolVersion, undefined);
});

test('explicit sequence sources write the global sequence without occupying data names', () => {
    const compiled = Protocol.compile({ id: 'sequence.source', symbolVersion: 2, schemaVersion: 2,
        framing: { fixedLength: 4 }, messages: [{ id: 'm', fields: [
            { name: 'rm_seq', type: 'uint16', valueSource: 'SEQ' }, { name: 'seq', type: 'uint8' },
            { name: 'value', type: 'uint8', condition: 'SEQ == 4660 && SEQUENCE == 4660 && seq == 7' }
        ] }] });
    assert.deepEqual(Protocol.encode(compiled, 'm', { rm_seq: 999, seq: 7, value: 8 }, { sequence: 4660 }), Uint8Array.of(0x34, 0x12, 7, 8));
    assert.deepEqual(Protocol.encode(compiled, 'm', { SEQ: 22, SEQUENCE: 23, seq: 7, value: 8 }, { sequence: 4660 }), Uint8Array.of(0x34, 0x12, 7, 8));
    assert.equal(Protocol.decode([0x34, 0x12, 7, 8], compiled).fields.value, 8);
});

test('HEADER exposes common header sources to sending and decoding repeated segments', () => {
    const compiled = Protocol.compile({ id: 'header.scope', symbolVersion: 2, schemaVersion: 2, framing: { fixedLength: 5 },
        headerFields: [{ name: 'rm_seq', type: 'uint8', valueSource: 'SEQ', offset: 0 }], payloadOffset: 1,
        messages: [{ id: 'm', fields: [{ name: 'items', type: 'repeat', count: 2, fields: [
            { name: 'value', type: 'uint8' },
            { name: 'marker', type: 'uint8', condition: 'INDEX >= 0 && HEADER.rm_seq == 9 && PARENT_REMAINING >= 2' }
        ] }] }] });
    const golden = Uint8Array.of(9, 41, 51, 42, 52);
    assert.deepEqual(Protocol.encode(compiled, 'm', { items: [{ value: 41, marker: 51 }, { value: 42, marker: 52 }] }, { sequence: 9 }), golden);
    assert.equal(Protocol.decode(golden, compiled).fields.items[1].value, 42);
});

test('INDEX is available while scanning whole-frame repeated items', () => {
    const schema = { id: 'item.index', symbolVersion: 2, schemaVersion: 3, framing: { maxLength: 32 },
        messages: [{ id: 'm', byteLength: 4, fields: [{ name: 'items', type: 'repeat', byteLength: 4, count: 2, fields: [
            { name: 'value', type: 'uint8', byteLength: 1 },
            { name: 'marker', type: 'uint8', byteLength: 1, condition: 'INDEX == 0 || INDEX == 1' }
        ] }] }] };
    const golden = Uint8Array.of(11, 21, 12, 22);
    assert.deepEqual(Protocol.encode(schema, 'm', { items: [{ value: 11, marker: 21 }, { value: 12, marker: 22 }] }), golden);
    assert.equal(Protocol.decode(golden, schema).fields.items[1].marker, 22);
});

test('serialized protocol factory migrates old symbols and validates new symbols without script dependencies', () => {
    const vm = require('node:vm'), context = vm.createContext({ Uint8Array, DataView, ArrayBuffer, TextEncoder, TextDecoder });
    const workerProtocol = vm.runInContext(`(${Protocol.createFactorySource()})(globalThis)`, context);
    const old = { id: 'factory.old', framing: { fixedLength: 2 }, messages: [{ id: 'm', fields: [
        { name: 'n', type: 'uint8' }, { name: 'data', type: 'bytes', length: 'min(n, remaining)' }
    ] }] };
    const record = workerProtocol.decode([1, 42], old);
    assert.equal(record.fields.data[0], 42);
    assert.equal(workerProtocol.compile(old).schema.messages[0].fields[1].length, 'MIN(n, REMAINING)');
    assert.throws(() => workerProtocol.compile({ ...old, symbolVersion: 2 }), /function/i);
});

test('declared length roles require consumers and unsigned single-value storage', () => {
    const fields = [{ id: 'length.source', name: 'n', type: 'uint8', byteLength: 1, role: 'length' },
        { name: 'data', type: 'bytes', byteLength: 0, lengthSource: { fieldId: 'length.source' } }];
    const schema = { id: 'length.roles', symbolVersion: 2, schemaVersion: 3, framing: { maxLength: 32 },
        messages: [{ id: 'frame', byteLength: 0, fields }] };
    assert.deepEqual(Protocol.encode(schema, 'frame', { data: [1, 2] }), Uint8Array.of(2, 1, 2));
    const noTarget = structuredClone(schema); noTarget.messages[0].fields.pop();
    assert.throws(() => Protocol.compile(noTarget), /length|长度|consumer/i);
    for (const change of [{ type: 'int8' }, { count: 1 }, { expectedBytes: [1] }]) {
        const invalid = structuredClone(schema); Object.assign(invalid.messages[0].fields[0], change);
        assert.throws(() => Protocol.compile(invalid), /length|unsigned|长度|source/i);
    }
});

test('fixed byte lengths cannot silently disable explicit length-source bindings', () => {
    const schema = { id: 'bound.fixed', symbolVersion: 2, schemaVersion: 3, framing: { maxLength: 32 }, messages: [{
        id: 'm', byteLength: 0, fields: [{ id: 'n', name: 'n', type: 'uint8', byteLength: 1, role: 'length' },
            { name: 'data', type: 'bytes', byteLength: 2, lengthSource: { fieldId: 'n' } }]
    }] };
    assert.throws(() => Protocol.encode(schema, 'm', { data: [1, 2] }), /length|长度|binding/i);
    const frame = structuredClone(schema); frame.messages[0].fields[1].byteLength = 0;
    frame.messages[0].byteLength = 3; frame.messages[0].lengthSource = { fieldId: 'n', adjustment: 1 };
    assert.throws(() => Protocol.compile(frame), /length|长度|binding/i);
});

test('legacy fixed frames retain their independent automatic wire-length storage after migration', () => {
    const { ProtocolModel } = require('../protocolModel');
    const old = { id: 'legacy.fixed.length', framing: { fixedLength: 4, length: { offset: 0, type: 'uint8', adjustment: 1 } },
        payloadOffset: 1, messages: [{ id: 'm', fields: [{ name: 'data', type: 'bytes', length: 3 }] }] };
    const golden = Uint8Array.of(3, 11, 12, 13), unified = ProtocolModel.toUnified(old);
    assert.deepEqual(Protocol.encode(old, 'm', { data: [11, 12, 13] }), golden);
    assert.deepEqual(Protocol.encode(unified, 'm', { data: [11, 12, 13] }), golden);
    assert.deepEqual(Protocol.decode(golden, unified).fields.data, Uint8Array.of(11, 12, 13));
});

function schema(extra = {}) {
    return { id: 'test.packet', endian: 'little', framing: { header: [170],
        length: { offset: 1, type: 'uint8', adjustment: 4 }, maxLength: 256 },
    command: { offset: 2, type: 'uint8' }, payloadOffset: 3, payloadEnd: -1,
    checksums: [{ type: 'sum', width: 8, start: 0, end: -1, offset: -1 }],
    messages: [{ id: 'test.values', command: 1, name: 'Values', fields: [
        { name: 'count', type: 'uint8' },
        { name: 'items', type: 'uint16', endian: 'big', count: 'count' },
        { name: 'flags', type: 'uint8', bits: [{ name: 'ready', offset: 0, length: 1, type: 'bool' },
            { name: 'mode', offset: 1, length: 3 }] },
        { name: 'clock', type: 'uint64' },
        { name: 'name', type: 'string', length: 4, encoding: 'utf-8' }
    ] }], ...extra };
}

test('schema engine decodes endian fields, dynamic arrays, bits, exact64 and source spans', () => {
    const compiled = Protocol.compile(schema());
    const bytes = Protocol.encode(compiled, 'test.values', { count: 2, items: [258, 772],
        flags: { ready: true, mode: 5 }, clock: 9007199254740993n, name: '温' });
    const decoded = Protocol.decode(bytes, compiled);
    assert.deepEqual(decoded.fields.items, [258, 772]);
    assert.equal(decoded.fields.clock, 9007199254740993n);
    assert.equal(decoded.values['flags.ready'], true);
    assert.equal(decoded.fields.name, '温');
    const item = decoded.flatFields.find(field => field.path === 'items[1]');
    assert.deepEqual([item.byteOffset, item.endByte, item.numeric], [6, 8, 772]);
    assert.equal(decoded.flatFields.find(field => field.path === 'clock').numeric, null);
    assert.equal(compiled.schema.id, 'test.packet');
    assert.deepEqual(Protocol.encode(compiled, decoded.messageId, decoded.fields), bytes);
});

test('expressions reject code execution, prototype access, cycles and excessive allocation', () => {
    for (const count of ['process.exit()', 'constructor.constructor', 'count;evil()', 'count = 2']) {
        const input = schema(); input.messages[0].fields[1].count = count;
        assert.throws(() => Protocol.compile(input), /expression|表达式|identifier|标识/i);
    }
    const cycle = schema({ structures: { recursive: [{ name: 'self', type: 'struct', ref: 'recursive' }] } });
    cycle.messages[0].fields = [{ name: 'root', type: 'struct', ref: 'recursive' }];
    assert.throws(() => Protocol.compile(cycle), /cycl|循环/i);
    const tooMany = schema(); tooMany.messages[0].fields[1].count = 100000000;
    assert.throws(() => Protocol.compile(tooMany), /count|limit|数量|范围/i);
});

test('generic CRC configurations match independent published check values', () => {
    const bytes = new TextEncoder().encode('123456789');
    assert.equal(Protocol.checksum(bytes, { type: 'crc', width: 8, polynomial: 0x07 }), 0xf4);
    assert.equal(Protocol.checksum(bytes, { type: 'crc', width: 16, polynomial: 0x1021, init: 0xffff }), 0x29b1);
    assert.equal(Protocol.checksum(bytes, { type: 'crc', width: 32, polynomial: 0x04c11db7,
        init: 0xffffffff, reflectIn: true, reflectOut: true, xorOut: 0xffffffff }), 0xcbf43926);
    assert.equal(Protocol.checksum(bytes, { type: 'xor', width: 8 }), 0x31);
});

test('stream parser resynchronizes across blocks without losing or duplicating discarded bytes', () => {
    const compiled = Protocol.compile(schema());
    const good = Protocol.encode(compiled, 'test.values', { count: 0, flags: 0, clock: 2n, name: 'ok' });
    const bad = good.slice(); bad[bad.length - 1] ^= 1;
    const input = Uint8Array.from([1, 2, ...bad, 3, ...good, ...good.subarray(0, 4)]);
    const parser = new Protocol.StreamParser(compiled), errors = [], frames = [];
    parser.onFrameError = (reason, time, bytes, metadata) => errors.push({ reason, bytes, ...metadata });
    parser.onFrameParsed = (record, time, bytes, timestamp, metadata) => frames.push({ record, bytes, timestamp, ...metadata });
    parser.appendData(input.subarray(0, 5), { timestamp: 100, byteOffset: 20, order: 2 });
    parser.appendData(input.subarray(5), { timestamp: 200, byteOffset: 25, order: 3 });
    parser.flushPending();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].timestamp, 200);
    const covered = [...errors, ...frames].flatMap(part => Array.from({ length: part.bytes.length }, (_, i) => part.byteOffset + i));
    assert.equal(new Set(covered).size, input.length);
    assert.equal(covered.length, input.length);
    assert.equal(Math.min(...covered), 20);
    assert.equal(parser.nextByte, 20 + input.length);
});

test('fixed and footer framing preserve unknown messages and nested reusable structures', () => {
    const input = schema({ framing: { header: [170], footer: [13, 10], fixedLength: 7 },
        payloadOffset: 2, payloadEnd: -2, checksums: [], command: { offset: 1, type: 'uint8' },
        structures: { point: [{ name: 'x', type: 'int8' }, { name: 'y', type: 'int8' }] },
        messages: [{ id: 'point', command: 1, fields: [{ name: 'position', type: 'struct', ref: 'point' },
            { name: 'active', type: 'bool' }] }] });
    const compiled = Protocol.compile(input);
    const good = Protocol.encode(compiled, 'point', { position: { x: -2, y: 4 }, active: true });
    assert.equal(Protocol.decode(good, compiled).values['position.x'], -2);
    const unknown = good.slice(); unknown[1] = 98;
    const decoded = Protocol.decode(unknown, compiled);
    assert.equal(decoded.known, false);
    assert.deepEqual(decoded.rawPayload, unknown.slice(2, 5));
    const footerOnly = Protocol.compile({ ...input, framing: { header: [170], footer: [13, 10], maxLength: 64 } });
    const parser = new Protocol.StreamParser(footerOnly), records = [];
    parser.onFrameParsed = record => records.push(record);
    parser.appendData(good);
    assert.equal(records.length, 1);
});

test('malformed checksums, floats, enum labels and unknown trailing bytes are explicit', () => {
    const input = schema(); input.messages[0].fields = [{ name: 'temperature', type: 'float32' },
        { name: 'state', type: 'enum', baseType: 'uint8', enum: { 1: 'ready', 2: 'busy' } }];
    const compiled = Protocol.compile(input);
    const bytes = Protocol.encode(compiled, 'test.values', { temperature: -12.5, state: 'busy', _unknownTail: [7, 8] });
    const record = Protocol.decode(bytes, compiled);
    assert.equal(record.fields.state, 2);
    assert.equal(record.flatFields.find(field => field.path === 'state').label, 'busy');
    assert.equal(record.fields.temperature, -12.5);
    assert.deepEqual(record.fields._unknownTail, Uint8Array.of(7, 8));
    assert.ok(record.warnings.some(warning => warning.code === 'extra-bytes'));
    bytes[3] ^= 1;
    assert.throws(() => Protocol.decode(bytes, compiled), /checksum/i);
});

test('schema budgets bound zero-byte arrays and variable message payloads', () => {
    const excessive = schema();
    excessive.messages[0].fields = Array.from({ length: 9 }, (_, i) =>
        ({ name: `empty${i}`, type: 'bytes', count: 4096, length: 0 }));
    const compiled = Protocol.compile(excessive);
    assert.throws(() => Protocol.encode(compiled, 'test.values', {}), /count|budget|limit/i);
    const variable = schema(); variable.messages[0].maxLength = 4;
    variable.messages[0].fields = [{ name: 'data', type: 'bytes' }];
    const bounded = Protocol.compile(variable);
    assert.throws(() => Protocol.encode(bounded, 'test.values', { data: [1, 2, 3, 4, 5] }), /length|limit/i);
    const unbounded = Protocol.compile(schema({ messages: variable.messages.map(message => ({ ...message, maxLength: 10 })) }));
    const longer = Protocol.encode(unbounded, 'test.values', { data: [1, 2, 3, 4, 5] });
    assert.ok(Protocol.decode(longer, bounded).warnings.some(warning => warning.code === 'payload-limit'));
});

test('CRC aliases, signed exact64 and schema checksum validation are consistent', () => {
    const input = schema({ checksums: [{ type: 'crc16', polynomial: 0x1021,
        init: 0xffff, start: 0, end: -2, offset: -2 }], payloadEnd: -2 });
    input.framing.length.adjustment = 5;
    input.messages[0].fields = [{ name: 'clock', type: 'int64' }];
    const compiled = Protocol.compile(input);
    const bytes = Protocol.encode(compiled, 'test.values', { clock: '-9223372036854775808' });
    assert.equal(Protocol.decode(bytes, compiled).fields.clock, -9223372036854775808n);
    assert.equal(compiled.checksums[0].width, 16);
    assert.throws(() => Protocol.encode(compiled, 'test.values', { clock: 9007199254740993 }), /exact/i);
    const invalid = schema({ checksums: [{ type: 'crc', polynomial: 'bad', width: 16 }] });
    assert.throws(() => Protocol.compile(invalid), /polynomial/i);
});

test('legacy text fields encode the same character repertoire as the shared decoder', () => {
    for (const [encoding, value] of [['gbk', '中文'], ['gb18030', '中文😀'], ['big5', '繁體'],
        ['shift_jis', '日本語'], ['windows-1252', '€é'], ['utf-16be', '中文😀']]) {
        const input = schema(); input.messages[0].fields = [{ name: 'text', type: 'string', encoding }];
        const compiled = Protocol.compile(input);
        const encoded = Protocol.encode(compiled, 'test.values', { text: value });
        assert.equal(Protocol.decode(encoded, compiled).fields.text, value, encoding);
    }
});

test('canonical JSON preserves explicit field identity through renames and structure instances', () => {
    const input = schema();
    input.structures = { point: [{ name: 'x', type: 'uint8' }] };
    input.messages[0].fields = [{ name: 'left', type: 'struct', ref: 'point' },
        { name: 'right', type: 'struct', ref: 'point' }];
    const first = Protocol.compile(input);
    const saved = JSON.parse(JSON.stringify(first.schema));
    assert.ok(saved.messages[0].fields[0].id);
    const original = first.messages[0].fields[0].id;
    saved.messages[0].fields[0].name = 'renamed';
    const second = Protocol.compile(saved);
    assert.equal(second.messages[0].fields[0].id, original);
    const record = Protocol.decode(Protocol.encode(second, 'test.values',
        { renamed: { x: 3 }, right: { x: 4 } }), second);
    assert.notEqual(record.flatFields[0].fieldId, record.flatFields[1].fieldId);
});

test('nested message dispatch encodes a leaf identity through each ancestor discriminator', () => {
    const input = schema({ messages: [{ id: 'outer', command: 1, fields: [{ name: 'kind', type: 'uint8' }],
        dispatch: { field: 'kind', offset: 1, name: 'content', messages: [
            { id: 'middle', command: 2, fields: [{ name: 'kind', type: 'uint8' }],
                dispatch: { field: 'kind', offset: 1, name: 'content', messages: [
                    { id: 'leaf', command: 3, fields: [{ name: 'value', type: 'uint8' }] }
                ] } }
        ] } }] });
    const compiled = Protocol.compile(input);
    const bytes = Protocol.encode(compiled, 'leaf', { content: { content: { value: 42 } } });
    const record = Protocol.decode(bytes, compiled);
    assert.equal(record.messageId, 'leaf');
    assert.equal(record.values['content.content.value'], 42);
});

test('deferred stream decoding finds validated boundaries without interpreting payload fields', () => {
    const compiled = Protocol.compile(schema()), bytes = Protocol.encode(compiled, 'test.values',
        { count: 0, flags: 0, clock: 9007199254740993n, name: 'ok' });
    const parser = new Protocol.StreamParser(compiled, { deferDecode: true }), frames = [], errors = [];
    parser.onFrameParsed = (record, time, raw, timestamp, metadata) => frames.push({ record, raw, metadata });
    parser.onFrameError = (reason, time, raw) => errors.push(...raw);
    const bad = bytes.slice(); bad[bad.length - 1] ^= 1;
    parser.appendData(Uint8Array.from([0, ...bad, ...bytes]), { byteOffset: 100, timestamp: 500 });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].record.deferred, true);
    assert.equal(frames[0].record.fields, undefined);
    assert.deepEqual(frames[0].raw, bytes);
    assert.equal(frames[0].metadata.byteOffset, 101 + bytes.length);
    assert.equal(Protocol.decode(frames[0].raw, compiled).fields.clock, 9007199254740993n);
    assert.deepEqual(errors, [0, ...bad]);
    parser.setFormat({ protocol: compiled, deferDecode: false });
    parser.appendData(bytes);
    assert.equal(frames.at(-1).record.fields.clock, 9007199254740993n);
});

test('encoding rejects empty numeric drafts, floating overflow and invalid raw bytes', () => {
    const input = schema(); input.messages[0].fields = [{ name: 'value', type: 'float32' }, { name: 'raw', type: 'bytes' }];
    const compiled = Protocol.compile(input);
    assert.throws(() => Protocol.encode(compiled, 'test.values', { value: '' }), /value|数值|empty/i);
    assert.throws(() => Protocol.encode(compiled, 'test.values', { value: 1e100 }), /overflow/i);
    for (const raw of [[256], [-1], [1.5], 'AA'])
        assert.throws(() => Protocol.encode(compiled, 'test.values', { value: 1, raw }), /byte|字节/i);
    assert.throws(() => Protocol.encode(compiled, 'test.values', { value: 1, _unknownTail: [999] }), /byte|字节/i);
});

test('schema JSON cannot impersonate a compiled protocol and live decode budgets report discarded bytes', () => {
    const fake = { ...schema(), _compiledProtocol: true };
    fake.messages[0].fields[1].count = 'process.exit()';
    assert.throws(() => Protocol.compile(fake), /expression/i);
    const compiled = Protocol.compile(schema()), bytes = Protocol.encode(compiled, 'test.values',
        { count: 0, flags: 0, clock: 2n, name: 'ok' });
    const parser = new Protocol.StreamParser(compiled, { maxDecodedFields: 2 }), errors = [];
    parser.onFrameError = (reason, time, raw) => errors.push({ reason, raw });
    parser.appendData(bytes); parser.flushPending();
    assert.equal(parser.frameCount, 0);
    assert.equal(errors[0].reason, 'field-limit');
    assert.deepEqual(errors.flatMap(error => [...error.raw]), [...bytes]);
});

test('length units invert whole-frame length and reserved fields preserve explicit byte spans', () => {
    const input = schema({ framing: { header: [170], length: { offset: 1, type: 'uint8', unit: 2, adjustment: 5 } },
        payloadEnd: -2, checksums: [{ type: 'crc16', polynomial: 0x1021, init: 0xffff,
            start: 0, end: -2, offset: -2, endian: 'little' }],
        messages: [{ id: 'unit.reserved', command: 1, fields: [
            { name: 'value', type: 'uint16' }, { name: 'spare', type: 'reserved', length: 2 }
        ] }] });
    const compiled = Protocol.compile(input);
    // Independent CRC16/CCITT bit loop over seven literal bytes.
    const golden = Uint8Array.of(170, 2, 1, 0x34, 0x12, 0, 0, 0, 0);
    let crc = 0xffff;
    for (const byte of golden.subarray(0, -2)) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000 ? crc << 1 ^ 0x1021 : crc << 1) & 0xffff;
    }
    golden[7] = crc & 255; golden[8] = crc >>> 8;
    assert.deepEqual(Protocol.encode(compiled, 'unit.reserved', { value: 0x1234 }), golden);
    const record = Protocol.decode(golden, compiled), spare = record.flatFields.find(field => field.path === 'spare');
    assert.deepEqual(record.fields.spare, Uint8Array.of(0, 0));
    assert.deepEqual([spare.numeric, spare.byteOffset, spare.endByte], [null, 5, 7]);
    const nonzero = Protocol.encode(compiled, 'unit.reserved', { value: 0x1234, spare: [0xde, 0xad] });
    assert.deepEqual(Protocol.decode(nonzero, compiled).fields.spare, Uint8Array.of(0xde, 0xad));
    const odd = structuredClone(input); odd.messages[0].fields[1].length = 1;
    assert.throws(() => Protocol.encode(Protocol.compile(odd), 'unit.reserved', { value: 1 }), /divis|unit|整除/i);
    for (const unit of [0, -1, 1.5]) assert.throws(() => Protocol.compile({ ...input,
        framing: { ...input.framing, length: { ...input.framing.length, unit } } }), /unit|range|范围/i);
});
