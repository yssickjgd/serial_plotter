const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol: P } = require('../protocolEngine');
const { ProtocolModel: M } = require('../protocolModel');
const { RoboMasterProtocol: R } = require('../robomasterProtocol');

function relationSchema() {
    return { id: 'relation', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 256 }, messages: [{ id: 'frame', byteLength: 0, fields: [
        { id: 'sync', name: 'sync', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
        { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
        { id: 'cmd', name: 'cmd', type: 'uint8', byteLength: 1 },
        { id: 'body', name: 'body', type: 'choice', byteLength: 0, lengthFrom: 'contents', selector: 'cmd', branches: [
            { id: 'fixed', equals: 1, fields: [{ id: 'v', name: 'value', type: 'uint16', byteLength: 2 }] },
            { id: 'raw', default: true, fields: [{ id: 'raw.data', name: 'data', type: 'bytes', byteLength: 0, lengthFrom: 'REMAINING' }] }
        ] },
        { id: 'tail', name: 'tail', type: 'uint8', byteLength: 1 }
    ] }], rules: [{ id: 'size-rule', type: 'length', targetFieldId: 'size', value: 'LEN(body) + LEN(tail)',
        expression: 'size == LEN(body) + LEN(tail)', boundaryFallback: true, send: 'fill' }] };
}

test('value expressions bound only unresolved branches and backfill from actual wire spans', () => {
    const s = relationSchema();
    const known = Uint8Array.from([170, 255, 1, 23, 0, 9]);
    const variable = P.encode(s, 'frame', { cmd: 2, body: { data: [11,12,13] }, tail: 9 });
    assert.deepEqual([...variable], [170,4,2,11,12,13,9]);
    for (let split = 1; split < known.length + variable.length; split++) {
        const all = Uint8Array.from([...known, ...variable]), got = [], parser = new P.StreamParser(s);
        parser.onFrameParsed = record => got.push(record);
        parser.appendData(all.subarray(0, split)); parser.appendData(all.subarray(split));
        assert.equal(got.length, 2); assert.equal(got[0].fields.body.value, 23);
        assert.equal(got[0].ruleResults[0].status, 'failed'); assert.equal(got[0].valid, true);
        assert.deepEqual([...got[1].fields.body.data], [11,12,13]); assert.equal(got[1].valid, true);
    }
});

test('length equations support algebra and reject ambiguous or invalid solutions', () => {
    const s = relationSchema(), rule = s.rules[0];
    rule.value = '(LEN(body) + LEN(tail)) * 2 + 3'; rule.expression = 'size == (' + rule.value + ')';
    const wire = P.encode(s, 'frame', { cmd: 2, body: { data: [11,12] }, tail: 9 });
    assert.equal(wire[1], 9); assert.equal(P.decode(wire, s).valid, true);
    for (const value of ['LEN(body) * LEN(body)', 'LEN(body) - LEN(body)', 'LEN(body) + size']) {
        const bad = structuredClone(s); bad.rules[0].value = value;
        assert.throws(() => P.compile(bad), /唯一|循环|求解|自身/);
    }
    const bad = structuredClone(s); bad.messages[0].fields.at(-1).type = 'bytes';
    bad.messages[0].fields.at(-1).byteLength = 0; bad.messages[0].fields.at(-1).lengthFrom = 'REMAINING';
    assert.throws(() => P.compile(bad), /多个|未知|唯一/);
    const invalid = wire.slice(); invalid[1] = 8;
    assert.throws(() => P.decode(invalid, s), /整数|length|Length|边界/);
});

test('a single unknown segment leaves fixed trailing fields; multiple unknown segments are rejected', () => {
    const s = relationSchema(), branch = s.messages[0].fields[3].branches[1];
    branch.fields.push({ id: 'marker', name: 'marker', type: 'uint8', byteLength: 1 });
    const wire = P.encode(s, 'frame', { cmd: 2, body: { data: [11,12], marker: 99 }, tail: 9 });
    assert.deepEqual([...wire], [170,4,2,11,12,99,9]);
    const record = P.decode(wire,s); assert.deepEqual([...record.fields.body.data],[11,12]);
    assert.equal(record.fields.body.marker,99);
    branch.fields.push({ id: 'other', name: 'other', type: 'bytes', byteLength: 0, lengthFrom: 'REMAINING' });
    assert.throws(()=>P.compile(s),/多个|唯一/);
});

test('repeat-until-end can consume the single expression-bounded byte span', () => {
    const s = relationSchema(), body = s.messages[0].fields[3];
    body.type = 'repeat'; body.until = 'end'; delete body.selector; delete body.branches;
    body.fields = [{ id: 'value', name: 'value', type: 'uint8', byteLength: 1 }];
    const wire = P.encode(s,'frame',{cmd:2,body:[{value:11},{value:12}],tail:9});
    assert.deepEqual([...wire],[170,3,2,11,12,9]);
    assert.deepEqual(P.decode(wire,s).fields.body,[{value:11},{value:12}]);
});

test('a raw zero-byte field can obtain its only boundary from a length value expression', () => {
    const s = relationSchema(), body = s.messages[0].fields[3];
    body.type = 'bytes'; delete body.lengthFrom; delete body.selector; delete body.branches;
    const wire = P.encode(s, 'frame', { cmd: 2, body: [11,12], tail: 9 });
    assert.deepEqual([...wire], [170,3,2,11,12,9]);
    assert.deepEqual([...P.decode(wire,s).fields.body], [11,12]);
});

test('length equations resolve sources and known scalar terms in enclosing structures', () => {
    const s = { id:'nested-relation',schemaVersion:3,symbolVersion:2,messages:[{id:'frame',byteLength:0,fields:[
        {id:'packet',name:'packet',type:'struct',byteLength:0,lengthFrom:'contents',fields:[
            {id:'size',name:'size',type:'uint8',byteLength:1},
            {id:'overhead',name:'overhead',type:'uint8',byteLength:1},
            {id:'body',name:'body',type:'bytes',byteLength:0,lengthFrom:'REMAINING'}
        ]}
    ]}],rules:[{id:'size-rule',type:'length',targetFieldId:'size',value:'LEN(packet.body) + packet.overhead',boundaryFallback:true,send:'fill',expression:'packet.size == LEN(packet.body) + packet.overhead'}]};
    const wire=P.encode(s,'frame',{packet:{overhead:1,body:[11,12]}});
    assert.deepEqual([...wire],[3,1,11,12]);
    assert.deepEqual([...P.decode(wire,s).fields.packet.body],[11,12]);
    const records=[], parser=new P.StreamParser(s);parser.onFrameParsed=record=>records.push(record);
    for(const byte of wire)parser.appendData([byte]);assert.equal(records.length,1);assert.equal(records[0].valid,true);
});

// Isolate known layouts so invalid length values cannot mask structural parsing.
function knownLayout() {
    const s = R.createSchema(), root = s.messages[0];
    const payload = root.fields.find(field => field.name === 'payload');
    const header = root.fields.find(field => field.name === 'header');
    const size = header.fields.find(field => field.name === 'data_length');
    delete root.lengthFrom; delete root.lengthSource;
    delete payload.lengthSource; payload.lengthFrom = 'contents';
    payload.branches = payload.branches.filter(branch => ['rm2026.0002', 'rm2026.0001'].includes(branch.id));
    Object.assign(s.rules.find(rule => rule.type === 'length'), { send: 'fill', targetFieldId: size.id,
        value: 'LEN(payload) + LEN(checksum_0)' });
    return s;
}

test('command structures determine the boundary and actual payload length before rule backfill', () => {
    const s = knownLayout(), bytes = P.encode(s, 'rm2026.0002', { winner: 1 });
    assert.equal(bytes.length, 10); assert.equal(bytes[1], 3);
    const record = P.decode(bytes, s);
    assert.equal(record.payloadLength, 1);
    assert.deepEqual([...record.rawPayload], [1]);
    assert.equal(record.valid, true);
    assert.equal(record.ruleResults.every(rule => rule.status === 'passed'), true);
});

test('wrong data_length never controls known-branch parsing or concatenated stream advancement', () => {
    const s = knownLayout();
    // Isolate the length rule: CRC checks are independently covered by preset tests.
    s.rules = s.rules.filter(rule => rule.type === 'length');
    const a = Uint8Array.from([165, 255, 255, 0, 0, 2, 0, 7, 0, 0]);
    for (const strength of ['weak', 'strong']) for (let split = 1; split < a.length; split++) {
        s.rules[0].strength = strength;
        const parser = new P.StreamParser(s), records = [];
        parser.onFrameParsed = record => records.push(record);
        parser.appendData(a.subarray(0, split)); parser.appendData([...a.subarray(split), ...a]);
        assert.equal(records.length, 2);
        for (const record of records) {
            assert.equal(record.fields.winner, 7);
            assert.equal(record.valid, strength === 'weak');
            assert.equal(record.ruleResults[0].actual, 65535);
            assert.equal(record.ruleResults[0].expected, 3);
            assert.equal(record.flatFields.find(field => field.name === 'winner').numeric, strength === 'weak' ? 7 : null);
        }
    }
});

test('unbinding a container selects structural length and removes orphaned length roles', () => {
    const s = knownLayout(), size = s.messages[0].fields[0].fields.find(field => field.name === 'data_length');
    const payload = s.messages[0].fields.find(field => field.name === 'payload');
    s.rules[0].send = 'verify'; delete s.rules[0].value; delete s.rules[0].targetFieldId;
    delete s.rules[0].boundaryFallback;
    const bound = M.bindLengthTarget(s, size.id, payload.id, { adjustment: -2 });
    const unbound = M.unbindLengthTarget(bound, size.id, payload.id);
    assert.equal(M.findField(unbound, payload.id).lengthFrom, 'contents');
    assert.equal(M.findField(unbound, size.id).role, undefined);
    assert.ok(P.compile(unbound));
});

test('all independently bounded command and interaction layouts retain bytes and field references', () => {
    const s = R.createSchema(), root = s.messages[0], payload = root.fields.find(field => field.name === 'payload');
    const size = root.fields[0].fields.find(field => field.name === 'data_length');
    delete root.lengthFrom; delete payload.lengthSource; payload.lengthFrom = 'contents';
    const independent = fields => {
        for (const field of fields ?? []) {
            if (['struct', 'choice'].includes(field.type) && field.lengthFrom === 'REMAINING') field.lengthFrom = 'contents';
            if (field.branches) {
                field.branches = field.branches.filter(branch => !branch.default && !branch.range &&
                    !['rm2026.0f02.query', 'rm2026.0f02.reply'].includes(branch.id));
                for (const branch of field.branches) independent(branch.fields);
            }
            independent(field.fields);
        }
    };
    independent(root.fields);
    Object.assign(s.rules.find(rule => rule.type === 'length'), { send: 'fill', targetFieldId: size.id,
        value: 'LEN(payload)' });
    const compiled = P.compile(s);
    const packets = [];
    for (const message of P.compile(R.legacySchema).messages) {
        if (message.dispatch || message.commandRange || !compiled.frameAliases.has(message.id)) continue;
        const fields = message.parent ? { sender_id: 1, receiver_id: 257, content: {} } : {};
        const bytes = P.encode(compiled, message.id, fields, { layout: 'detail' });
        assert.deepEqual(bytes, P.encode(R.legacySchema, message.id, fields, { layout: 'detail' }), message.id);
        const record = P.decode(bytes, compiled);
        assert.equal(record.valid, true, message.id);
        assert.equal(record.payloadLength, bytes.length - 9, message.id);
        const previous = P.decode(bytes, R.legacySchema);
        for (const old of previous.flatFields) {
            const actual = record.flatFields.find(field => field.fieldId === old.fieldId && field.path === old.path);
            assert.ok(actual, old.path); assert.equal(actual.byteOffset, old.byteOffset);
            assert.equal(actual.numeric, old.numeric);
        }
        packets.push(bytes);
    }
    assert.ok(packets.length > 30);
    const records = [], parser = new P.StreamParser(compiled);
    parser.onFrameParsed = record => records.push(record);
    for (const packet of packets) for (const byte of packet) parser.appendData([byte]);
    assert.equal(records.length, packets.length);
    assert.equal(records.every(record => record.valid), true);
});
