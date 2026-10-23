const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol: P } = require('../protocolEngine');

function schema(rules = []) {
    return { id: 'constraints', schemaVersion: 3, symbolVersion: 2, rules,
        messages: [{ id: 'frame', byteLength: 0, fields: [
            { id: 'start', name: 'start', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
            { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
            { id: 'payload', name: 'payload', type: 'struct', byteLength: 2, fields: [
                { id: 'value', name: 'value', type: 'uint16', byteLength: 2 }
            ] },
            { id: 'sum', name: 'sum', type: 'uint8', byteLength: 1 }
        ] }] };
}
const lengthRule = options => ({ id: 'length-check', type: 'length', expression: 'size == LEN(payload) + LEN(sum)', ...options });

test('additional length rules default weak and preserve numeric values', () => {
    const record = P.decode([170, 9, 1, 0, 0], schema([lengthRule()]));
    assert.equal(record.valid, true);
    assert.equal(record.ruleResults[0].status, 'failed');
    assert.equal(record.warnings[0].severity, 'warning');
    assert.equal(record.flatFields.find(f => f.fieldId === 'value').numeric, 1);
});
test('strong validation retains complete failed frame and consumes its reliable boundary', () => {
    const parser = new P.StreamParser(schema([lengthRule({ strength: 'strong' })]));
    const frames = []; parser.onFrameParsed = (record, time, bytes) => frames.push({ record, bytes: [...bytes] });
    parser.appendData(Uint8Array.from([170, 9, 170, 0, 0, 170, 3, 2, 0, 0]));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].record.valid, false);
    assert.equal(frames[0].record.flatFields.every(f => f.numeric === null), true);
    assert.equal(frames[1].record.valid, true);
});
test('explicit length and checksum backfill are ordered and independently validated', () => {
    const s = schema([lengthRule({ send: 'fill', targetFieldId: 'size', value: 'LEN(payload) + LEN(sum)' }),
        { id: 'sum-check', type: 'checksum', strength: 'strong', send: 'fill', targetFieldId: 'sum',
            checksum: { type: 'sum', start: { fieldId: 'start', edge: 'start' }, end: { fieldId: 'sum', edge: 'start' } } }]);
    const bytes = P.encode(s, 'frame', { payload: { value: 1 } });
    assert.deepEqual([...bytes], [170, 3, 1, 0, 174]);
    assert.equal(P.decode(bytes, s).ruleResults.every(r => r.status === 'passed'), true);
});
test('rule compiler rejects missing references, invalid stages and duplicate writers', () => {
    assert.throws(() => P.compile(schema([lengthRule({ expression: 'missing == 2' })])), /reference|引用/i);
    assert.throws(() => P.compile(schema([lengthRule({ stage: 'later' })])), /stage|阶段/i);
    assert.throws(() => P.compile(schema([lengthRule({ send: 'fill', targetFieldId: 'size', value: '3' }),
        { id: 'other', type: 'assert', expression: 'size == 3', send: 'fill', targetFieldId: 'size', value: '3' }])), /writer|回填/i);
});

test('rule expressions and stable field references survive nested field rename', () => {
    const { ProtocolModel: M } = require('../protocolModel');
    const s = schema([lengthRule({ send: 'fill', targetFieldId: 'size', value: 'LEN(payload) + LEN(sum)' })]);
    const changed = M.renameField(s, 'payload', { name: 'body' }).protocol;
    assert.equal(changed.rules[0].expression, 'size == LEN(body) + LEN(sum)');
    assert.equal(changed.rules[0].value, 'LEN(body) + LEN(sum)');
    assert.equal(changed.rules[0].targetFieldId, 'size');
    assert.ok(M.inspectReferences(s, 'payload').some(ref => ref.nodeId === 'length-check'));
    assert.deepEqual([...P.encode(changed, 'frame', { body: { value: 2 } })], [170, 3, 2, 0, 0]);
});

test('parsing checks reject incomplete false candidates and recover on the next header', () => {
    const s = schema([{ id: 'size-range', type: 'assert', expression: 'size <= 3', stage: 'parsing', strength: 'strong' }]);
    const parser = new P.StreamParser(s), frames = [], discarded = [];
    parser.onFrameParsed = record => frames.push(record);
    parser.onFrameError = (type, time, bytes) => discarded.push(...bytes);
    parser.appendData(Uint8Array.from([170, 9]));
    assert.equal(parser.pending.length, 0);
    parser.appendData(Uint8Array.from([170, 3, 1, 0, 0]));
    assert.equal(frames.length, 1); assert.equal(frames[0].valid, true);
    assert.deepEqual(discarded, [170, 9]);
});
test('both-stage weak checks preserve outputs across every split and deferred replay', () => {
    const s = schema([lengthRule({ stage: 'both' })]), bytes = Uint8Array.from([170, 9, 1, 0, 0]);
    for (let split = 1; split < bytes.length; split++) for (const deferDecode of [false, true]) {
        const records = [], parser = new P.StreamParser(s, { deferDecode });
        parser.onFrameParsed = record => records.push(record);
        parser.appendData(bytes.subarray(0, split)); parser.appendData(bytes.subarray(split));
        assert.equal(records.length, 1); assert.equal(records[0].valid, true);
        assert.deepEqual(records[0].ruleResults.map(r => [r.stage, r.status]), [['parsing', 'failed'], ['validation', 'failed']]);
    }
});

test('backfill orders new and legacy checksums by real byte coverage', () => {
    const s = schema([lengthRule({ send: 'fill', targetFieldId: 'size', value: 'LEN(payload) + LEN(sum)' }),
        { id: 'final-check', type: 'checksum', strength: 'strong', send: 'fill', targetFieldId: 'final',
            checksum: { type: 'sum', start: 0, end: { fieldId: 'final', edge: 'start' } } }]);
    Object.assign(s.messages[0].fields[3], { type: 'checksum', checksum: { type: 'sum', start: 0, end: { fieldId: 'sum', edge: 'start' } } });
    s.messages[0].fields.push({ id: 'final', name: 'final', type: 'uint8', byteLength: 1 });
    assert.deepEqual([...P.encode(s, 'frame', { payload: { value: 1 } })], [170, 3, 1, 0, 174, 92]);
});
test('conditional constraints report not-run and disabled rules do not suppress data', () => {
    const s = schema([lengthRule({ strength: 'strong', condition: 'size == 3' }),
        { id: 'disabled', type: 'assert', enabled: false, expression: '' }]);
    const r = P.decode([170, 9, 1, 0, 0], s);
    assert.equal(r.valid, true);
    assert.deepEqual(r.ruleResults.map(r => r.status), ['not-run', 'not-run']);
});
test('backfill cannot alter a command selecting a different wire structure', () => {
    const s = schema([{ id: 'fill-command', type: 'assert', expression: 'size == 1', targetFieldId: 'size', value: '1', send: 'fill' }]);
    s.messages[0].fields[2] = { id: 'payload', name: 'payload', type: 'choice', byteLength: 2, selector: 'size', branches: [
        { id: 'a', equals: 0, fields: [{ id: 'a.val', name: 'a', type: 'uint16', byteLength: 2 }] },
        { id: 'b', equals: 1, fields: [{ id: 'b.val', name: 'b', type: 'uint16', byteLength: 2 }] }
    ] };
    assert.throws(() => P.compile(s), /解析|layout/);
});

test('rule paths include bit slices, indexed values and actual repeat-item byte lengths', () => {
    const s = schema([{ id: 'bits', type: 'assert', expression: 'size.ready == TRUE && LEN(payload[1]) == 2 && payload[1].value == 2', strength: 'strong' }]);
    s.messages[0].fields[1].bits = [{ name: 'ready', type: 'bool', offset: 0, length: 1 }];
    Object.assign(s.messages[0].fields[2], { type: 'repeat', byteLength: 0, lengthFrom: 'contents', count: 2 });
    assert.equal(P.decode([170, 1, 1, 0, 2, 0, 0], s).valid, true);
});
test('new checksum expressions and nested moves preserve referenced fields', () => {
    const { ProtocolModel: M } = require('../protocolModel');
    const s = schema([{ id: 'check', type: 'checksum', targetFieldId: 'sum', checksum: { type: 'sum', start: 'size - 3', end: 'LEN(payload) + 2' } },
        { id: 'value-check', type: 'assert', expression: 'payload.value > 0' }]);
    const renamed = M.renameField(s, 'size', { name: 'length_value' }).protocol;
    assert.equal(renamed.rules[0].checksum.start, 'length_value - 3');
    assert.ok(M.inspectReferences(s, 'size').some(ref => ref.property === 'checksum.start'));
    const moved = M.moveField(s, 'value', 'frame', 3);
    assert.equal(moved.rules[1].expression, 'value > 0');
    assert.equal(moved.rules[0].targetFieldId, 'sum');
});
test('wire rules survive worker factories and exact integers remain exact in diagnostics', () => {
    const worker = Function('return (' + P.createFactorySource() + ')(globalThis)')();
    const s = schema([{ id: 'exact', type: 'assert', expression: 'payload.value == 9007199254740993', strength: 'strong' }]);
    Object.assign(s.messages[0].fields[2], { byteLength: 8 });
    Object.assign(s.messages[0].fields[2].fields[0], { type: 'uint64', byteLength: 8 });
    const bytes = P.encode(s, 'frame', { size: 0, payload: { value: '9007199254740993' } });
    const record = worker.decode(bytes, s);
    assert.equal(record.ruleResults[0].actual, 9007199254740993n);
    assert.equal(record.valid, true);
});

test('backfill dependencies include the storage field of referenced bit slices', () => {
    const s = schema([
        { id: 'fill-out', type: 'assert', expression: 'out == flags.n + 1', send: 'fill', targetFieldId: 'out', value: 'flags.n + 1' },
        { id: 'fill-flags', type: 'assert', expression: 'flags == 3', send: 'fill', targetFieldId: 'flags', value: '3' }
    ]);
    s.messages[0].fields = [
        { id: 'out', name: 'out', type: 'uint8', byteLength: 1 },
        { id: 'flags', name: 'flags', type: 'uint8', byteLength: 1, bits: [{ name: 'n', offset: 0, length: 4 }] }
    ];
    assert.deepEqual([...P.encode(s, 'frame', {})], [4, 3]);
});

test('moving indexed fields preserves indices on retained ancestors and rejects ambiguous relocation', () => {
    const { ProtocolModel: M } = require('../protocolModel');
    const s = schema([{ id: 'value-check', type: 'assert', expression: 'payload[1].value == 2' }]);
    Object.assign(s.messages[0].fields[2], { type: 'repeat', byteLength: 0, lengthFrom: 'contents', count: 2 });
    s.messages[0].fields[2].fields.push({ id: 'body', name: 'body', type: 'struct', byteLength: 0, lengthFrom: 'contents', fields: [] });
    const moved = M.moveField(s, 'value', 'body', 0);
    assert.equal(moved.rules[0].expression, 'payload[1].body.value == 2');
    assert.ok(P.compile(moved));
    assert.throws(() => M.moveField(s, 'value', 'frame', 0), /索引|index|重复/);
});

test('new backfill updates legacy checksum coverage expressions before calculating the checksum', () => {
    const s = schema([{ id: 'fill-offset', type: 'assert', expression: 'offset == 1', value: '1', send: 'fill', targetFieldId: 'offset' }]);
    s.messages[0].fields = [
        { id: 'offset', name: 'offset', type: 'uint8', byteLength: 1 },
        { id: 'data', name: 'data', type: 'uint8', byteLength: 1 },
        { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: 'offset', end: 2 } }
    ];
    assert.deepEqual([...P.encode(s, 'frame', { data: 5 })], [1, 5, 5]);
});

test('independent checksum rules cover and fill each occurrence in repeated structures', () => {
    const s = schema([{ id: 'item-check', type: 'checksum', send: 'fill', targetFieldId: 'item-sum',
        checksum: { type: 'sum', start: { fieldId: 'item-value', edge: 'start' }, end: { fieldId: 'item-sum', edge: 'start' } } }]);
    s.messages[0].fields = [{ id: 'items', name: 'items', type: 'repeat', byteLength: 0, lengthFrom: 'contents', count: 2, fields: [
        { id: 'item-value', name: 'value', type: 'uint8', byteLength: 1 },
        { id: 'item-sum', name: 'sum', type: 'uint8', byteLength: 1 }
    ] }];
    const bytes = P.encode(s, 'frame', { items: [{ value: 3 }, { value: 7 }] });
    assert.deepEqual([...bytes], [3, 3, 7, 7]);
    assert.deepEqual(P.decode(bytes, s).ruleResults.map(r => r.path), ['items[0].sum', 'items[1].sum']);
    assert.deepEqual(P.decode([3, 3, 7, 0], s).ruleResults.map(r => r.status), ['passed', 'failed']);
});
