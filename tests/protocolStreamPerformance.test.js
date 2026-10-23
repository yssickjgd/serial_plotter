const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol: P } = require('../protocolEngine');
const { CaptureMemoryBudget } = require('../captureMemory');

function arraySchema() {
    return { id: 'incremental-array', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 16384 }, messages: [{
        id: 'frame', byteLength: 0, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', bytes: [170], byteLength: 1, framingRole: 'sync' },
            { id: 'count', name: 'count', type: 'uint16', byteLength: 2 },
            { id: 'values', name: 'values', type: 'uint16', byteLength: 2, count: 'count' },
            { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1,
                checksum: { type: 'sum', start: { fieldId: 'sync' }, end: { fieldId: 'sum' } } },
            { id: 'end', name: 'end', type: 'fixed', bytes: [13,10], byteLength: 2, framingRole: 'end' }
        ]
    }] };
}
function delimiterSchema() {
    return { id: 'incremental-delimiter', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 16384 }, messages: [{
        id: 'frame', byteLength: 0, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', bytes: [170], byteLength: 1, framingRole: 'sync' },
            { id: 'body', name: 'body', type: 'bytes', byteLength: 0, boundary: { endFieldId: 'end' } },
            { id: 'end', name: 'end', type: 'fixed', bytes: [13,13,10], byteLength: 3, framingRole: 'end' }
        ]
    }] };
}
test('bytewise variable frames retain completed fields and reuse scalar values through checksum and decoding', () => {
    const schema = arraySchema(), values = Array.from({ length: 512 }, (_, index) => index * 3);
    const wire = P.encode(schema, 'frame', { count: values.length, values }), frames = [];
    const parser = new P.StreamParser(schema, { trackWork: true });
    parser.onFrameParsed = (record, time, bytes) => frames.push({ record, bytes });
    for (let index = 0; index < wire.length - 1; index++) {
        parser.appendData(wire.subarray(index, index + 1)); assert.equal(frames.length, 0);
    }
    parser.appendData(wire.subarray(-1));
    assert.deepEqual(frames[0].record, P.decode(wire, schema));
    assert.deepEqual(frames[0].record.fields.values, values);
    assert.ok(parser.work?.layoutFieldVisits <= 6, 'completed fields must not be visited on every incoming chunk');
    assert.ok(parser.work.scalarReads <= values.length + 3, 'layout, validation and decoding must reuse scalar reads');
    assert.ok(parser.work.bufferCopiedBytes < wire.length * 6, 'bytewise appends must grow amortized rather than copy the whole prefix');
});

test('split and overlapping delimiters are searched incrementally with the same public decoded output', () => {
    const schema = delimiterSchema(), body = Uint8Array.from({ length: 2048 }, (_, index) => index % 2 ? 13 : 42);
    const wire = P.encode(schema, 'frame', { body }), records = [];
    const parser = new P.StreamParser(schema, { trackWork: true }); parser.onFrameParsed = record => records.push(record);
    for (const byte of wire) parser.appendData([byte]);
    assert.deepEqual(records, [P.decode(wire, schema)]);
    assert.ok(parser.work?.delimiterBytes <= wire.length * 2, 'a long unclosed field is not rescanned from its start');
    assert.ok(parser.work.layoutFieldVisits <= 4);
});

test('sticky frames consume a cursor without copying their remaining suffix and callbacks own stable bytes', () => {
    const schema = { id: 'sticky', framing: { header: [170], fixedLength: 4, maxLength: 65536 }, payloadOffset: 1,
        messages: [{ id: 'frame', fields: [{ name: 'value', type: 'uint16' }, { name: 'end', type: 'uint8' }] }] };
    const input = Uint8Array.from({ length: 40000 }, (_, index) => [170, 52, 18, 85][index % 4]);
    const parser = new P.StreamParser(schema, { trackWork: true }), retained = [];
    parser.onFrameParsed = (record, time, bytes) => { if (retained.length < 2) retained.push(bytes); };
    parser.appendData(input); assert.equal(parser.frameCount, 10000);
    parser.appendData([170,1,0,85]);
    assert.deepEqual(retained.map(bytes => [...bytes]), [[170,52,18,85], [170,52,18,85]]);
    assert.ok(parser.work?.bufferCopiedBytes <= input.length * 3, 'consuming each frame must not copy the remaining input block');
    assert.equal(parser.length, 0);
});

test('incremental state resets on noise, checksum errors, byte gaps, reset and format changes', () => {
    const schema = arraySchema(), good = P.encode(schema, 'frame', { count: 3, values: [11,22,33] });
    const bad = good.slice(); bad[bad.length - 3] ^= 1;
    const input = Uint8Array.from([0, ...bad, 99, ...good]), covered = [], records = [];
    const parser = new P.StreamParser(schema, { trackWork: true });
    parser.onFrameError = (reason, time, bytes, meta) => covered.push(...Array.from(bytes, (_, index) => meta.byteOffset + index));
    parser.onFrameParsed = (record, time, bytes, timestamp, meta) => {
        records.push({ record, timestamp }); covered.push(...Array.from(bytes, (_, index) => meta.byteOffset + index));
    };
    for (let index = 0; index < input.length; index++) parser.appendData(input.subarray(index, index + 1), { timestamp: index, byteOffset: index });
    assert.equal(records.length, 1); assert.deepEqual(records[0].record.fields.values, [11,22,33]);
    assert.equal(records[0].timestamp, bad.length + 2);
    assert.deepEqual(covered, Array.from({ length: input.length }, (_, index) => index));
    parser.appendData(good.subarray(0, 3)); parser.reset();
    parser.appendData(good); assert.equal(records.length, 2);
    parser.appendData(good.subarray(0, 3)); parser.appendData(good, { byteOffset: parser.nextByte + 10 });
    assert.equal(records.length, 3);
    parser.appendData(good.subarray(0, 3)); parser.setFormat({ protocol: delimiterSchema() });
    parser.appendData([170,42,13,13,10]); assert.equal(records.length, 4);
    assert.deepEqual([...records[3].record.fields.body], [42]);
    assert.throws(() => P.decode(bad, schema), /checksum/i, 'public decode never trusts a previous stream validation');
});

test('buffer capacity and suspended parser state remain visible to the capture memory budget', () => {
    const schema = arraySchema(), parser = new P.StreamParser(schema);
    parser.appendData([170, 2, 0, 1, 0]);
    assert.ok(parser.estimatedMemoryBytes > parser.buffer.byteLength, 'include spare capacity, source metadata and suspended layout');
    const empty = { estimatedMemoryBytes: 0 };
    const service = { history: empty, txFrames: empty, workerPool: {}, sources: new Set([{ parser, frames: empty, errors: [] }]) };
    const budget = new CaptureMemoryBudget(service, 1048576);
    assert.equal(budget.measure().usedBytes, parser.estimatedMemoryBytes);
    parser.reset(); assert.equal(parser.estimatedMemoryBytes, 0); assert.equal(budget.measure().usedBytes, 0);
});

test('nested TLV and repeat layouts retain exact values and spans across every split and worker factory', () => {
    const schema = { id: 'stream-tlv', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 4096 }, messages: [{
        id: 'frame', byteLength: 0, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', bytes: [170,85], byteLength: 2, framingRole: 'sync' },
            { id: 'size', name: 'size', type: 'uint16', byteLength: 2 },
            { id: 'items', name: 'items', type: 'tlv', byteLength: 0, lengthSource: { fieldId: 'size' }, until: 'end',
                headerFields: [{ id: 'tag', name: 'tag', type: 'uint8', byteLength: 1 }, { id: 'n', name: 'n', type: 'uint8', byteLength: 1 }],
                lengthField: 'n', selector: 'tag', branches: [
                    { equals: 1, fields: [{ id: 'wide', name: 'wide', type: 'uint64', byteLength: 8 }] },
                    { equals: 2, fields: [{ id: 'points', name: 'points', type: 'repeat', byteLength: 0, lengthFrom: 'contents', count: 2,
                        fields: [{ id: 'x', name: 'x', type: 'int16', byteLength: 2 }] }] },
                    { default: true, fields: [] }
                ] },
            { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: 0, end: { fieldId: 'sum' } } }
        ]
    }] };
    const wire = P.encode(schema, 'frame', { items: [{ tag: 1, wide: 9007199254740993n },
        { tag: 2, points: [{ x: -7 }, { x: 42 }] }, { tag: 9, rawPayload: [11,22,33] }] });
    const expected = P.decode(wire, schema);
    const factory = require('node:vm').runInNewContext('(' + P.createFactorySource() + ')');
    const worker = factory({}, require('../textCodec').TextCodec);
    for (const api of [P, worker]) for (let split = 0; split <= wire.length; split++) {
        const records = [], parser = new api.StreamParser(schema);
        parser.onFrameParsed = record => records.push(record);
        parser.appendData(wire.subarray(0, split)); parser.appendData(wire.subarray(split));
        assert.equal(records.length, 1, 'split ' + split);
        const normalize = record => require('node:util').inspect(record, { depth: null, sorted: true, breakLength: Infinity });
        assert.equal(normalize(records[0]), normalize(expected));
    }
});

test('a large receive block keeps first-byte timestamps when internal buffering splits the block', () => {
    const schema = arraySchema(); schema.framing.maxLength = 64;
    const wire = P.encode(schema, 'frame', { count: 2, values: [4,5] });
    const input = Uint8Array.from(Array.from({ length: 40 }, () => [...wire]).flat()), records = [];
    const parser = new P.StreamParser(schema);
    parser.onFrameParsed = (record, time, bytes, timestamp, meta) => records.push({ timestamp, offset: meta.byteOffset, bytes });
    parser.appendData(input.subarray(0, 2), { timestamp: 100, byteOffset: 1000 });
    parser.appendData(input.subarray(2), { timestamp: 200, byteOffset: 1002 });
    assert.equal(records.length, 40);
    for (let index = 0; index < records.length; index++) {
        assert.equal(records[index].offset, 1000 + index * wire.length);
        assert.equal(records[index].timestamp, index ? 200 : 100); assert.deepEqual(records[index].bytes, wire);
    }
});

test('long fixed delimiters retain prefix lengths above 255 across arbitrary packet boundaries', () => {
    const schema = delimiterSchema(), ending = [...new Array(300).fill(13), 10];
    schema.messages[0].fields[2].bytes = ending; schema.messages[0].fields[2].byteLength = ending.length;
    const body = Uint8Array.from([42, ...new Array(320).fill(13)]);
    const wire = P.encode(schema, 'frame', { body }), records = [];
    const parser = new P.StreamParser(schema); parser.onFrameParsed = record => records.push(record);
    for (const byte of wire) parser.appendData([byte]);
    assert.equal(records.length, 1); assert.deepEqual(records[0].fields.body, body);
});

test('whole-frame-dependent compatibility scans revalidate the sliced candidate before publishing it', () => {
    const schema = { id: 'frame-dependent', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
        id: 'frame', byteLength: 0, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', bytes: [170], byteLength: 1, framingRole: 'sync' },
            { id: 'n', name: 'n', type: 'uint8', byteLength: 1 },
            { id: 'data', name: 'data', type: 'uint8', byteLength: 1, count: 'n' },
            { id: 'tail', name: 'tail', type: 'uint8', byteLength: 1, condition: 'FRAME_LENGTH > 5' }
        ]
    }] };
    const frames = [], parser = new P.StreamParser(schema);
    parser.onFrameParsed = (record, time, bytes) => { assert.doesNotThrow(() => P.decode(bytes, schema)); frames.push([...bytes]); };
    parser.appendData([170,1,42,170,1,43]); assert.deepEqual(frames, [[170,1,43]]);
});

test('suspended large flat layouts retain linear context storage rather than copies of every prefix', () => {
    const profile = function() {
        const { Protocol } = require('./protocolEngine');
        const fields = [{ id: 'sync', name: 'sync', type: 'fixed', bytes: [170], byteLength: 1, framingRole: 'sync' },
            { id: 'n', name: 'n', type: 'uint8', byteLength: 1 },
            { id: 'skip', name: 'skip', type: 'uint8', byteLength: 1, count: 'n' },
            ...Array.from({ length: 1500 }, (_, index) => ({ id: 'v' + index, name: 'v' + index, type: 'uint8', byteLength: 1 })),
            { id: 'tail', name: 'tail', type: 'uint16', byteLength: 2 }];
        const parser = new Protocol.StreamParser({ id: 'many-fields', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 4096 },
            messages: [{ id: 'frame', byteLength: 0, fields }] });
        global.gc(); const before = process.memoryUsage().heapUsed;
        parser.appendData(Uint8Array.from([170,0,...new Array(1500).fill(0)]));
        global.gc();
        process.stdout.write(JSON.stringify({ retainedHeap: process.memoryUsage().heapUsed - before,
            estimated: parser.estimatedMemoryBytes, frames: parser.frameCount }));
    };
    const result = JSON.parse(require('node:child_process').execFileSync(process.execPath, ['--expose-gc', '-e', '(' + profile.toString() + ')()'],
        { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' }));
    assert.equal(result.frames, 0);
    assert.ok(result.retainedHeap < 16 * 1048576, `suspended state retained ${result.retainedHeap} bytes`);
});

test('projected checksum contexts preserve late CURRENT references and LEN byte spans', () => {
    for (const end of ['CURRENT.n + 3', 'LEN(data) + 3']) {
        const schema = { id: 'forward-checksum', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
            id: 'frame', byteLength: 0, fields: [
                { id: 'sync', name: 'sync', type: 'fixed', bytes: [170], byteLength: 1, framingRole: 'sync' },
                { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: 2, end } },
                { id: 'n', name: 'n', type: 'uint8', byteLength: 1 },
                { id: 'data', name: 'data', type: 'bytes', byteLength: 0, lengthSource: { fieldId: 'n' } }
            ]
        }] };
        const bytes = Uint8Array.from([170,32,2,10,20]);
        assert.deepEqual(P.encode(schema, 'frame', { data: [10,20] }), bytes, end);
        const expected = P.decode(bytes, schema), records = [], parser = new P.StreamParser(schema);
        parser.onFrameParsed = record => records.push(record);
        for (const byte of bytes) parser.appendData([byte]);
        assert.deepEqual(records, [expected], end);
    }
});

module.exports = { arraySchema, delimiterSchema };
