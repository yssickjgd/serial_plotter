const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Protocol } = require('../protocolEngine');
const { RoboMasterProtocol } = require('../robomasterProtocol');

test('V2.0.0 preset uses the official payload-only length and latest serial command catalog', () => {
    const s=RoboMasterProtocol.createSchema();
    assert.equal(s.source.version,'V2.0.0（20260626）');assert.equal(s.source.pages,'4–43');assert.equal(s.source.crcPages,'75–78');
    assert.equal(s.rules.find(rule=>rule.type==='length').value,'LEN(payload)');
    const bytes=Protocol.encode(s,'rm2026.0002',{winner:1});
    assert.equal(bytes[1],1);assert.equal(bytes.length,10);
    for(const command of [0x311,0xa01,0xa02,0xa03,0xa04,0xa05,0xa06])assert.ok(RoboMasterProtocol.commands.some(item=>item.command===command),command.toString(16));
    for(const command of [0x304,0xf01,0xf02])assert.ok(!RoboMasterProtocol.commands.some(item=>item.command===command),command.toString(16));
});

test('V2.0.0 HP, firing limit, sentry uint64 status and enlarged raw records follow independent offsets', () => {
    checkPayloadLayout(3,20,v=>{v.setInt16(8,-2345,true);v.setUint16(16,1234,true);v.setUint16(18,4321,true);},
        [['damage_difference',-2345,8,2],['enemy_outpost_HP',1234,16,2],['enemy_base_HP',4321,18,2]]);
    checkPayloadLayout(0x201,17,v=>{v.setFloat32(12,30.5,true);v.setUint8(16,5);},
        [['bullet_speed_limit',30.5,12,4],['power_management.gimbal_output',true,16,1,0,1],['power_management.chassis_output',false,16,1,1,1]]);
    checkPayloadLayout(0x20d,14,v=>v.setBigUint64(6,0xfedcba9876543210n,true),
        [['sentry_info_3',0xfedcba9876543210n,6,8],['sentry_info_3.strengthened_movement_seconds',0xdc,12,1,48,8]]);
    for(const [command,size] of [[0x310,300],[0x311,30]]) {
        const bytes=Uint8Array.from({length:size},(_,i)=>i&255);
        assert.deepEqual(Protocol.decode(frame(command,bytes,0,false),RoboMasterProtocol.compiled).fields.data,bytes);
    }
});

test('V2.0.0 radar wireless messages follow hand-built offsets, unsigned widths and documented enums', () => {
    checkPayloadLayout(0xa01,24,v=>{v.setUint16(16,12500,true);v.setUint16(22,28000,true);},
        [['opponent_aerial_position_x',12500,16,2],['opponent_sentry_position_y',28000,22,2]]);
    checkPayloadLayout(0xa02,12,v=>{v.setUint16(0,12345,true);v.setUint16(10,54321,true);},
        [['opponent_hero_HP',12345,0,2],['opponent_sentry_HP',54321,10,2]]);
    checkPayloadLayout(0xa03,10,v=>{v.setUint16(6,0xffff,true);v.setUint16(8,0x8123,true);},
        [['opponent_aerial_projectile_allowance',65535,6,2],['opponent_sentry_projectile_allowance',0x8123,8,2]]);
    const {record:status}=checkPayloadLayout(0xa04,8,v=>{v.setUint16(0,60000,true);v.setUint32(4,0xabcd0000|(1<<1)|(3<<4)|(2<<6)|(1<<15),true);},
        [['opponent_remaining_gold_coin',60000,0,2],['opponent_status.central_highland',1,4,1,1,2],
            ['opponent_status.fortress_buff',3,4,1,4,2],['opponent_status.outpost_buff',2,4,1,6,2],
            ['opponent_status.crossing_highway_upper',true,5,1,15,1]]);
    assert.equal(status.flatFields.find(f=>f.path==='opponent_status.central_highland').label,'对方占领');
    assert.equal(status.flatFields.find(f=>f.path==='opponent_status.outpost_buff').label,'己方占领');
    assert.equal(status.fields.opponent_status>>>16,0xabcd,'undefined upper bits remain intact');
    const {record:buff}=checkPayloadLayout(0xa05,41,v=>{v.setUint16(1,0x8123,true);v.setUint16(12,0xfedc,true);
        v.setUint16(29,0xabcd,true);v.setUint8(35,6);v.setUint8(36,2);v.setUint8(40,3);},
        [['hero_cooling_buff',0x8123,1,2],['engineer_attack_buff',0xfedc,12,2],['sentry_cooling_buff',0xabcd,29,2],
            ['sentry_stance',6,35,1],['hero_status',2,36,1],['sentry_status',3,40,1]]);
    assert.equal(buff.flatFields.find(f=>f.path==='hero_status').label,'无敌但不虚弱');
    assert.equal(buff.flatFields.find(f=>f.path==='sentry_status').label,'无敌且虚弱');
    checkPayloadLayout(0xa06,6,(v,bytes)=>bytes.set(Buffer.from('A0b9Z7','ascii')),[['password','A0b9Z7',0,6]]);
});

test('V2.0.0 marker bits and relocated RFID references retain their precise meaning', () => {
    const names=['enemy_hero_vulnerable','enemy_engineer_vulnerable','enemy_standard_3_vulnerable','enemy_standard_4_vulnerable',
        'enemy_aerial_marked','enemy_sentry_vulnerable','ally_hero_marked','ally_engineer_marked','ally_standard_3_marked','ally_standard_4_marked',
        'ally_aerial_marked','ally_sentry_marked','enemy_aerial_targeted_by_ally_radar_laser','enemy_aerial_countered',
        'ally_aerial_targeted_by_enemy_radar_laser','ally_aerial_countered'];
    for(let index=0;index<16;index++) {
        const payload=new Uint8Array(2);new DataView(payload.buffer).setUint16(0,2**index,true);
        const record=Protocol.decode(frame(0x20c,payload),RoboMasterProtocol.compiled);
        for(let bit=0;bit<16;bit++)assert.equal(record.values['mark_progress.'+names[bit]],bit===index,names[bit]);
    }
    const schema=RoboMasterProtocol.createSchema(),row=require('../protocolModel').ProtocolModel.flattenFields(schema)
        .find(row=>row.field.id==='rm2026.0209.rfid_status_2');
    for(const [name,index] of [['enemy_tunnel_highway_lower',0],['enemy_tunnel_highway_upper',2]]) {
        const bit=row.field.bits.find(bit=>bit.name===name);
        assert.equal(bit.id,'rm2026.0209.rfid_status.'+name);assert.equal(bit.offset,index);
    }
    for(const id of ['rm2026.0105','rm2026.0204','rm2026.0208','rm2026.0301.0121']) {
        const encoded=Protocol.encode(schema,id,id==='rm2026.0301.0121'?{sender_id:9,receiver_id:257,content:{password:'ABC123'}}:{});
        assert.equal(Protocol.decode(encoded,schema).warnings.length,0,id);
    }
});

// Independent bit-at-a-time reference matching the PDF appendix (0x8c/0x8408
// reflected polynomials), deliberately separate from engine configuration.
function referenceCRC(bytes, initial, polynomial, width) {
    let crc = initial;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ polynomial : crc >>> 1;
    }
    return crc & (width === 8 ? 255 : 65535);
}
function frame(command, payload, sequence = 0, includeChecksumLength = false) {
    const dataLength = payload.length + (includeChecksumLength ? 2 : 0);
    const bytes = Uint8Array.from([165, dataLength & 255, dataLength >>> 8, sequence, 0,
        command & 255, command >>> 8, ...payload, 0, 0]);
    bytes[4] = referenceCRC(bytes.subarray(0, 4), 255, 0x8c, 8);
    const crc = referenceCRC(bytes.subarray(0, -2), 65535, 0x8408, 16);
    bytes[bytes.length - 2] = crc & 255; bytes[bytes.length - 1] = crc >>> 8;
    return bytes;
}

test('default template exposes exclusive length and checksum constraints with explicit inclusive endpoints', () => {
    const s=RoboMasterProtocol.createSchema(), root=s.messages[0], header=root.fields[0], payload=root.fields[1];
    assert.equal(header.fields.find(field=>field.name==='data_length').contentConstraint,'length');
    for(const rule of s.rules.filter(rule=>rule.type==='checksum')) {
        const field=[...header.fields,...root.fields].find(field=>field.id===rule.targetFieldId);
        assert.equal(field.contentConstraint,'checksum');
        assert.equal(rule.checksum.start.edge,'start');assert.equal(rule.checksum.end.edge,'end');
        assert.equal(rule.checksum.end.fieldId,field.name==='CRC8'?header.fields.find(field=>field.name==='rm_seq').id:payload.id);
    }
    const encoded=Protocol.encode(s,'rm2026.0002',{winner:1});
    assert.deepEqual(encoded,frame(2,[1]));assert.equal(Protocol.decode(encoded,s).valid,true);
});

test('custom RM2026 length includes payload and trailing CRC16 across encoding, migration and stream boundaries', () => {
    const { ProtocolModel } = require('../protocolModel');
    const customized = RoboMasterProtocol.createSchema();
    const rule=customized.rules.find(rule=>rule.type==='length');
    rule.value='LEN(payload) + LEN(checksum_0)';rule.expression='header.data_length == LEN(payload) + LEN(checksum_0)';
    customized.framing.maxLength=65542;
    const whole = customized.messages[0], payload = whole.fields.find(field => field.name === 'payload');
    assert.equal(whole.lengthSource, undefined);
    assert.equal(payload.lengthSource, undefined);
    assert.equal(payload.lengthFrom, 'contents');
    assert.equal(customized.framing.maxLength, 65542);
    for (const schema of [customized, ProtocolModel.toUnified(customized)]) {
        const first = frame(2, [1],0,true), second = frame(0x9999, [],0,true);
        assert.deepEqual(Protocol.encode(schema, 'rm2026.0002', { winner: 1 }), first);
        assert.equal(first[1], 3); assert.equal(second[1], 2);
        for (let split = 1; split < first.length; split++) {
            const records = [], parser = new Protocol.StreamParser(schema);
            parser.onFrameParsed = record => records.push(record);
            parser.appendData(first.subarray(0, split));
            assert.equal(records.length, 0);
            parser.appendData(Uint8Array.from([...first.subarray(split), ...second]));
            assert.deepEqual(records.map(record => record.command), [2,0x9999]);
            assert.equal(records[1].payloadLength,0);
            assert.equal(records[0].header.data_length, 3);
            assert.equal(records.every(record => record.valid), true);
        }
    }
});

test('default preset separates payload length and CRC constraints while preserving field identities', () => {
    const { ProtocolModel: M } = require('../protocolModel');
    const s = RoboMasterProtocol.createSchema();
    assert.equal(s.schemaVersion, 3);
    assert.equal(s.rules.length, 3);
    const root = s.messages[0], header = root.fields.find(field => field.name === 'header');
    const payload = root.fields.find(field => field.name === 'payload');
    const crc8 = header.fields.find(field => field.name === 'CRC8'), crc16 = root.fields.find(field => field.name === 'checksum_0');
    const size = header.fields.find(field => field.name === 'data_length');
    assert.equal(payload.lengthSource, undefined);
    assert.equal(root.lengthFrom, undefined);
    assert.equal(crc8.type, 'uint8'); assert.equal(crc16.type, 'uint16');
    assert.equal(crc8.checksum, undefined); assert.equal(crc16.checksum, undefined);
    const lengthRule = s.rules.find(rule => rule.type === 'length');
    assert.equal(lengthRule.expression, 'header.data_length == LEN(payload)');
    assert.equal(lengthRule.strength, 'weak');
    assert.equal(lengthRule.targetFieldId, size.id);
    assert.equal(lengthRule.boundaryFallback, true);
    assert.equal(lengthRule.value, 'LEN(payload)');
    for (const field of [crc8, crc16]) {
        const rule = s.rules.find(rule => rule.targetFieldId === field.id);
        assert.equal(rule.send, 'fill'); assert.equal(rule.strength, 'strong');
        assert.equal(rule.stage, field === crc8 ? 'both' : 'validation');
    }
    const changed = M.renameField(s, payload.id, { name: 'body' }).protocol;
    assert.equal(changed.rules.find(rule => rule.type === 'length').expression, 'header.data_length == LEN(body)');
    assert.deepEqual(Protocol.encode(changed, 'rm2026.0002', { winner: 1 }), frame(2, [1]));
});

test('known root and interaction structures ignore incorrect length values with valid CRCs', () => {
    for (const [command, payload] of [[2,[7]], [0x301,[0,1,1,0,1,1,1,0]]]) for (const claimed of [0,2,65535]) {
        const bytes = frame(command, payload); bytes[1] = claimed & 255; bytes[2] = claimed >>> 8;
        bytes[4] = referenceCRC(bytes.subarray(0,4),255,0x8c,8);
        const crc = referenceCRC(bytes.subarray(0,-2),65535,0x8408,16); bytes[bytes.length-2] = crc & 255; bytes[bytes.length-1] = crc >>> 8;
        const records = [], parser = RoboMasterProtocol.createParser(); parser.onFrameParsed = record => records.push(record);
        for (const byte of [...bytes,...frame(2,[1])]) parser.appendData([byte]);
        assert.equal(records.length,2); assert.equal(records[0].valid,true);
        assert.equal(records[0].payloadLength,payload.length);
        assert.equal(records[0].ruleResults.find(rule => rule.ruleId.endsWith('data-length-rule')).status,'failed');
        assert.equal(records[1].fields.winner,1);
    }
});

test('variable and unknown template branches use the explicit length equation across every split', () => {
    const payloads = [[0x301,[0,2,1,0,1,1,11,12,13]], [0xf02,[]], [0xf02,[4]],
        [0x9999,[11,12,13]], [0x301,[0x99,1,1,0,1,1,11,12,13]]];
    for (const [command,payload] of payloads) {
        const bytes = frame(command,payload);
        for (let split=1;split<bytes.length;split++) {
            const got=[], parser=RoboMasterProtocol.createParser(); parser.onFrameParsed=record=>got.push(record);
            parser.appendData(bytes.subarray(0,split)); assert.equal(got.length,0);
            parser.appendData([...bytes.subarray(split),...frame(2,[1])]);
            assert.equal(got.length,2); assert.equal(got[0].payloadLength,payload.length);
            assert.equal(got[0].valid,true); assert.deepEqual([...got[0].rawPayload],payload);
            assert.equal(got[1].fields.winner,1);
        }
    }
});

test('RM2026 independently constructed game-status frame retains nibble fields and uint64 timestamp', () => {
    const golden = frame(1, [0x41, 0x2c, 1, 1, 0, 0, 0, 0, 0, 32, 0], 7);
    const record = Protocol.decode(golden, RoboMasterProtocol.compiled);
    assert.equal(record.messageId, 'rm2026.0001');
    assert.equal(record.values['game_type_progress.game_type'], 1);
    assert.equal(record.values['game_type_progress.game_progress'], 4);
    assert.equal(record.fields.stage_remain_time, 300);
    assert.equal(record.fields.SyncTimeStamp, 9007199254740993n);
    assert.equal(record.header.rm_seq, 7);
    assert.equal(record.flatFields.find(field => field.path === 'header.rm_seq').fieldId, 'robomaster-2026-v1.header.seq');
    assert.deepEqual(Protocol.encode(RoboMasterProtocol.compiled, record.messageId, record.fields, { sequence: 7 }), golden);
    assert.equal(golden[4], 0x81);
});

test('legacy RoboMaster imports migrate automatic sequence names without changing their wire identity', () => {
    const old = JSON.parse(JSON.stringify(RoboMasterProtocol.legacySchema)); delete old.symbolVersion;
    // Saved official-layout protocols keep their own length convention on import.
    old.framing.length.adjustment = 9; old.framing.maxLength = 65544;
    const seq = old.headerFields.find(field => field.name === 'rm_seq'); seq.name = 'seq'; delete seq.valueSource;
    const migration = Protocol.migrateSymbols(old), compiled = Protocol.compile(old);
    assert.equal(compiled.schema.symbolVersion, 2);
    assert.equal(compiled.headerFields.find(field => field.id === seq.id).valueSource, 'SEQ');
    assert.ok(migration.renames.some(item => item.fieldId === seq.id && item.pathBefore === 'header.seq' && item.pathAfter === 'header.rm_seq'));
    const golden = frame(2, [1], 255, false);
    assert.deepEqual(Protocol.encode(compiled, 'rm2026.0002', { winner: 1 }, { sequence: 255 }), golden);
    assert.equal(Protocol.decode(golden, compiled).header.rm_seq, 255);
});

test('first-chapter catalog covers every root command and documented interaction subcommand', () => {
    const roots = RoboMasterProtocol.legacySchema.messages;
    const expected = [1, 2, 3, 0x101, 0x104, 0x105, 0x201, 0x202, 0x203, 0x204,
        0x206, 0x207, 0x208, 0x209, 0x20a, 0x20b, 0x20c, 0x20d, 0x20e,
        0x301, 0x302, 0x303, 0x305, 0x306, 0x307, 0x308, 0x309, 0x310, 0x311,0xa01,0xa02,0xa03,0xa04,0xa05,0xa06];
    assert.deepEqual([...new Set(roots.map(message => message.command))].sort((a, b) => a - b), expected);
    const children = roots.find(message => message.command === 0x301).dispatch.messages;
    for (const command of [0x100, 0x101, 0x102, 0x103, 0x104, 0x110, 0x120, 0x121])
        assert.ok(children.some(child => child.command === command));
    assert.ok(children.some(child => child.commandRange?.[0] === 0x200 && child.commandRange[1] === 0x2ff));
    assert.equal(RoboMasterProtocol.source.version, 'V2.0.0（20260626）');
});

test('document conflicts use detailed layouts; legacy bounded imports retain extensions', () => {
    for (const [command, length] of [[0x203, 12], [0x303, 12], [0x307, 105]]) {
        const id = `rm2026.${command.toString(16).padStart(4, '0')}`;
        const fields = command === 0x307 ? { delta_x: Array(49).fill(-1), delta_y: Array(49).fill(2) } : {};
        assert.throws(() => Protocol.encode(RoboMasterProtocol.compiled, id, fields), /layout/i);
        const encoded = Protocol.encode(RoboMasterProtocol.compiled, id, fields, { layout: 'detail' });
        assert.equal(encoded.length, length + 9);
        assert.ok(Protocol.decode(encoded, RoboMasterProtocol.compiled).warnings.some(warning => warning.code === 'document-conflict'));
    }
    const extended = frame(0x203, Array(16).fill(0));
    // With structural framing, unconfigured trailing bytes cannot extend a known
    // command using data_length. Explicit legacy imports retain their old policy.
    assert.throws(() => Protocol.decode(extended, RoboMasterProtocol.compiled), /length/i);
    const record = Protocol.decode(extended, RoboMasterProtocol.legacySchema);
    assert.deepEqual(record.fields._unknownTail, Uint8Array.of(0, 0, 0, 0));
    assert.equal(record.fields.angle, 0);
    const truncated = frame(0x208, Array(6).fill(0));
    // Legacy imports retain permissive truncated-record diagnostics. The editor's
    // unified field layout (also used by the new preset) requires fields to fit.
    assert.equal(Protocol.decode(truncated, RoboMasterProtocol.legacySchema).warnings.some(w => w.code === 'truncated'), true);
    assert.throws(() => Protocol.decode(truncated, RoboMasterProtocol.compiled), /containing segment|length/i);
});

test('UI graphic arrays unpack every bit group and can send by child message identity', () => {
    const graphic = { figure_name: [65, 66, 67], config1: { operate_type: 1, figure_type: 4,
        layer: 9, color: 8, details_a: 270, details_b: 360 },
    config2: { width: 20, start_x: 1919, start_y: 1079 },
    config3: { details_c: 100, details_d: 900, details_e: 500 } };
    const bytes = Protocol.encode(RoboMasterProtocol.compiled, 'rm2026.0301.0104',
        { sender_id: 1, receiver_id: 0x101, content: { interaction_figure: Array(7).fill(graphic) } });
    assert.equal(bytes.length, 120);
    assert.equal(referenceCRC(bytes.subarray(0, -2), 65535, 0x8408, 16), bytes.at(-2) | bytes.at(-1) << 8);
    const record = Protocol.decode(bytes, RoboMasterProtocol.compiled);
    assert.equal(record.messageId, 'rm2026.0301.0104');
    assert.equal(record.subcommand, 0x104);
    assert.equal(record.values['content.interaction_figure[6].config2.start_x'], 1919);
    assert.equal(record.values['content.interaction_figure[0].config1.details_b'], 360);
    const span = record.flatFields.find(field => field.path === 'content.interaction_figure[6].config2.start_x');
    assert.equal(span.byteOffset, 111);
    assert.equal(span.bitLength, 11);
});

test('radar command, UTF16 client message and unknown bytes remain lossless', () => {
    const radar = Protocol.encode(RoboMasterProtocol.compiled, 'rm2026.0301.0121',
        { sender_id: 9, receiver_id: 0x8080, content: { radar_cmd: 1, password_cmd: 2,
            password: 'ABC123' } }, { layout: 'detail' });
    const record = Protocol.decode(radar, RoboMasterProtocol.compiled);
    assert.equal(record.fields.content.password, 'ABC123');
    assert.equal(record.payloadLength, 14);
    const custom = Protocol.encode(RoboMasterProtocol.compiled, 'rm2026.0308',
        { sender_id: 1, receiver_id: 0x101, user_data: '能量机关' });
    assert.equal(Protocol.decode(custom, RoboMasterProtocol.compiled).fields.user_data, '能量机关');
    assert.equal(Protocol.decode(frame(0xf02, []), RoboMasterProtocol.compiled).known, false);
    assert.deepEqual(Protocol.decode(frame(0xf02, [4]), RoboMasterProtocol.compiled).fields.rawPayload,Uint8Array.of(4));
    const unknown = Protocol.decode(frame(0x9999, [4, 5]), RoboMasterProtocol.compiled);
    assert.deepEqual(unknown.fields.rawPayload, Uint8Array.of(4, 5));
    assert.equal(unknown.known, false);
    const sub = Protocol.decode(frame(0x301, [0x99, 0x01, 1, 0, 1, 1, 4, 5]), RoboMasterProtocol.compiled);
    assert.deepEqual(sub.fields.content.rawPayload, Uint8Array.of(4, 5));
});

test('RM parser resynchronizes bad headers and retains complete CRC failures without numeric outputs', () => {
    const valid = frame(2, [1], 7), headerBad = valid.slice(), payloadBad = valid.slice();
    headerBad[1] = 200; payloadBad[7] = 2;
    const stream = Uint8Array.from([0, ...headerBad, ...payloadBad, ...valid, ...valid]);
    const parser = RoboMasterProtocol.createParser(), outputs = [];
    parser.onFrameParsed = (record, time, bytes, timestamp, meta) => outputs.push({ known: record.valid, record, bytes, timestamp, ...meta });
    parser.onFrameError = (reason, time, bytes, meta) => outputs.push({ reason, bytes, ...meta });
    for (let i = 0; i < stream.length; i++) parser.appendData(stream.subarray(i, i + 1), { byteOffset: 100 + i, timestamp: i * 10 });
    parser.flushPending();
    assert.equal(outputs.filter(part => part.known).length, 2);
    const invalid = outputs.filter(part => part.record && !part.record.valid);
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].record.flatFields.every(field => field.numeric === null), true);
    assert.ok(invalid[0].record.ruleResults.some(rule => rule.strength === 'strong' && rule.status === 'failed'));
    assert.deepEqual(outputs.flatMap(part => [...part.bytes]), [...stream]);
    assert.deepEqual(outputs.flatMap(part => Array.from({ length: part.bytes.length }, (_, i) => part.byteOffset + i)),
        Array.from({ length: stream.length }, (_, i) => 100 + i));
});

test('every fixed first-chapter command layout encodes, independently checks, and decodes', () => {
    for (const message of Protocol.compile(RoboMasterProtocol.legacySchema).messages) {
        if (message.dispatch || message.commandRange) continue;
        const fields = message.parent ? { sender_id: 1, receiver_id: 0x101, content: {} } : {};
        const bytes = Protocol.encode(RoboMasterProtocol.compiled, message.id, fields,
            { sequence: 254, layout: 'detail' });
        assert.equal(bytes.length, message.length + (message.parent ? 15 : 9), message.id);
        assert.equal(referenceCRC(bytes.subarray(0, 4), 255, 0x8c, 8), bytes[4]);
        assert.equal(referenceCRC(bytes.subarray(0, -2), 65535, 0x8408, 16), bytes.at(-2) | bytes.at(-1) << 8);
        const record = Protocol.decode(bytes, RoboMasterProtocol.compiled);
        assert.equal(record.messageId, message.id);
        assert.equal(record.warnings.filter(warning => warning.code !== 'document-conflict').length, 0, message.id);
    }
});

test('event enums distinguish unspecified occupation state 3 from documented shared occupation', () => {
    // PDF p11, table 1-8: only bits 23–24 and 25–26 define state 3.
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, (3 << 7) | (3 << 23) | (3 << 25) | (3 << 27), true);
    const record = Protocol.decode(frame(0x101, payload), RoboMasterProtocol.compiled);
    for (const name of ['central_highland', 'outpost_buff']) {
        const field = record.flatFields.find(item => item.path === `event_data.${name}`);
        assert.equal(field.value, 3);
        assert.equal(field.label, undefined, `${name}: state 3 has no PDF definition`);
    }
    for (const name of ['central_buff', 'fortress_buff'])
        assert.equal(record.flatFields.find(item => item.path === `event_data.${name}`).label, '双方占领');
});

// Independently written payloads follow the PDF tables/packed definitions, not
// Protocol.encode or compiled field offsets. All offsets below are relative to
// the root payload; interaction content begins after the six-byte shared header.
// The nonzero seed and explicit boundary values expose shifted or narrow fields.
function checkPayloadLayout(command, length, write, expected, child) {
    const payload = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255);
    const view = new DataView(payload.buffer);
    if (child !== undefined) {
        view.setUint16(0, child, true); view.setUint16(2, 9, true); view.setUint16(4, 0x109, true);
    }
    write(view, payload);
    const record = Protocol.decode(frame(command, payload, 251), RoboMasterProtocol.compiled);
    const rootId = command.toString(16).padStart(4, '0');
    assert.equal(record.messageId, `rm2026.${rootId}${child === undefined ? '' : `.${child.toString(16).padStart(4, '0')}`}`);
    assert.equal(record.payloadLength, length);
    assert.deepEqual(record.rawPayload, payload);
    assert.deepEqual(record.warnings.filter(item => item.code !== 'document-conflict'), []);
    for (const [path, value, offset, width, bitOffset, bitLength] of expected) {
        const field = record.flatFields.find(item => item.path === path);
        assert.ok(field, path);
        assert.deepEqual(field.value, value, path);
        assert.equal(field.byteOffset, 7 + offset, `${path} offset`);
        assert.equal(field.endByte, 7 + offset + width, `${path} width`);
        if (bitOffset !== undefined) {
            assert.equal(field.bitOffset, bitOffset, `${path} bit offset`);
            assert.equal(field.bitLength, bitLength, `${path} bit width`);
        }
    }
    return { record, payload };
}

test('V2 PDF pp9–11: packed nibbles, unaligned uint64 and last HP slots', () => {
    checkPayloadLayout(1, 11, view => {
        view.setUint8(0, 0x45); view.setUint16(1, 0xff01, true);
        view.setBigUint64(3, 0xfedcba9876543210n, true);
    }, [['game_type_progress.game_type', 5, 0, 1, 0, 4],
        ['game_type_progress.game_progress', 4, 0, 1, 4, 4],
        ['stage_remain_time', 0xff01, 1, 2], ['SyncTimeStamp', 0xfedcba9876543210n, 3, 8]]);
    checkPayloadLayout(3, 20, view => {
        view.setUint16(10, 0xff00, true); view.setUint16(14, 0x8001, true);
    }, [['ally_7_robot_HP', 0xff00, 10, 2], ['ally_base_HP', 0x8001, 14, 2]]);
});

test('V2 PDF pp11–16: event bit ranges, robot status, reserved float, position and unaligned buffs', () => {
    checkPayloadLayout(0x101, 4, view => view.setUint32(0, (2 << 3) | (5 << 20) | (3 << 25), true),
        [['event_data.small_rune', 2, 0, 1, 3, 2], ['event_data.enemy_dart_target', 5, 2, 1, 20, 3],
            ['event_data.fortress_buff', 3, 3, 1, 25, 2]]);
    checkPayloadLayout(0x201, 17, view => {
        view.setUint16(2, 0xf001, true); view.setUint16(10, 0x8123, true); view.setUint8(16, 5);
    }, [['current_HP', 0xf001, 2, 2], ['chassis_power_limit', 0x8123, 10, 2],
        ['power_management.shooter_output', true, 16, 1, 2, 1]]);
    checkPayloadLayout(0x202, 14, view => {
        view.setFloat32(4, -12.5, true); view.setUint16(8, 0x8765, true); view.setUint16(12, 0xfffe, true);
    }, [['reserved_3', -12.5, 4, 4], ['buffer_energy', 0x8765, 8, 2], ['shooter_42mm_barrel_heat', 0xfffe, 12, 2]]);
    checkPayloadLayout(0x203, 12, view => {
        view.setFloat32(0, -1.25, true); view.setFloat32(8, 359.5, true);
    }, [['x', -1.25, 0, 4], ['angle', 359.5, 8, 4]]);
    checkPayloadLayout(0x204, 8, view => {
        view.setUint16(1, 0x8123, true); view.setUint16(5, 0xfedc, true); view.setUint8(7, 0x81);
    }, [['cooling_buff', 0x8123, 1, 2], ['attack_buff', 0xfedc, 5, 2],
        ['remaining_energy', 0x81, 7, 1], ['remaining_energy.at_least_125_percent', true, 7, 1, 0, 1]]);
});

test('V2 PDF pp17–24: firing float and 2026 fortress, tunnel RFID, sentry stance and radar bits', () => {
    checkPayloadLayout(0x207, 7, view => {
        view.setUint8(0, 2); view.setFloat32(3, 30.25, true);
    }, [['bullet_type', 2, 0, 1], ['initial_speed', 30.25, 3, 4]]);
    checkPayloadLayout(0x208, 8, view => view.setUint16(6, 0xffff, true),
        [['projectile_allowance_fortress', 0xffff, 6, 2]]);
    checkPayloadLayout(0x209, 5, view => {
        view.setUint32(0, 0x84000000, true); view.setUint8(4, 0x24);
    }, [['rfid_status.ally_tunnel_highway_lower', true, 3, 1, 26, 1],
        ['rfid_status.ally_tunnel_trapezoid_upper', true, 3, 1, 31, 1],
        ['rfid_status_2.enemy_tunnel_highway_upper', true, 4, 1, 2, 1],
        ['rfid_status_2.enemy_tunnel_trapezoid_upper', true, 4, 1, 5, 1]]);
    checkPayloadLayout(0x20d, 14, view => {
        view.setUint32(0, 0x7fe00000, true); view.setUint16(4, 0x7a55, true);
    }, [['sentry_info.instant_respawn_gold_cost', 1023, 2, 2, 21, 10],
        ['sentry_info_2.is_disengaged', true, 4, 1, 0, 1],
        ['sentry_info_2.remaining_team_17mm_exchange_allowance', 0x52a, 4, 2, 1, 11],
        ['sentry_info_2.stance', 3, 5, 1, 12, 2], ['sentry_info_2.can_activate_rune', true, 5, 1, 14, 1]]);
    checkPayloadLayout(0x20e, 1, view => view.setUint8(0, 0x3b),
        [['radar_info.double_vulnerability_chances', 3, 0, 1, 0, 2],
            ['radar_info.encryption_level', 3, 0, 1, 3, 2], ['radar_info.can_change_password', true, 0, 1, 5, 1]]);
});

test('V2 PDF pp26–32: seventh graphic, opaque character bytes and new interaction command bits', () => {
    checkPayloadLayout(0x301, 111, view => view.setUint32(103, 20 | (1919 << 10) | (1079 << 21), true),
        [['content.interaction_figure[6].config2.start_x', 1919, 104, 2, 10, 11],
            ['content.interaction_figure[6].config2.start_y', 1079, 105, 2, 21, 11]], 0x104);
    // p29 table 1-32 / packed definition: uint8_t data[30], no charset specified.
    const opaque = Uint8Array.from({ length: 30 }, (_, index) => [0xff, 0x80, 0, 0xc0, 0x41][index % 5]);
    const { record, payload } = checkPayloadLayout(0x301, 51, (view, bytes) => bytes.set(opaque, 21),
        [['content.data', opaque, 21, 30]], 0x110);
    const encoded = Protocol.encode(RoboMasterProtocol.compiled, record.messageId, record.fields, { sequence: 251 });
    assert.deepEqual(encoded.subarray(7, -2), payload, 'opaque data survives decode/edit/send without text replacement');
    checkPayloadLayout(0x301, 10, view => view.setUint32(6, (6 << 21) | (1 << 24), true),
        [['content.sentry_cmd.stance', 6, 8, 1, 21, 3],
            ['content.sentry_cmd.confirm_rune_activation', true, 9, 1, 24, 1]], 0x120);
    checkPayloadLayout(0x301, 14, (view, bytes) => {
        view.setUint8(6, 254); view.setUint8(7, 2); bytes.set(Buffer.from('Z9a0Q7', 'ascii'), 8);
    }, [['content.radar_cmd', 254, 6, 1], ['content.password_cmd', 2, 7, 1],
        ['content.password', 'Z9a0Q7', 8, 6]], 0x121);
});

test('V2 PDF pp32–38: map targets, array ends, UTF16 and packed controller keys', () => {
    checkPayloadLayout(0x303, 12, view => {
        view.setFloat32(0, -3.5, true); view.setUint8(8, 0xff); view.setUint8(9, 107); view.setUint16(10, 0x8001, true);
    }, [['target_position_x', -3.5, 0, 4], ['cmd_keyboard', 255, 8, 1],
        ['target_robot_id', 107, 9, 1], ['cmd_source', 0x8001, 10, 2]]);
    checkPayloadLayout(0x305, 48, view => {
        view.setUint16(16, 0xfedc, true); view.setUint16(22, 0x8001, true);view.setUint16(46,0x1234,true);
    }, [['opponent_aerial_position_x', 0xfedc, 16, 2], ['opponent_sentry_position_y', 0x8001, 22, 2],['ally_sentry_position_y',0x1234,46,2]]);
    checkPayloadLayout(0x307, 105, view => {
        view.setInt8(53, -128); view.setInt8(102, 127); view.setUint16(103, 0x8069, true);
    }, [['delta_x[48]', -128, 53, 1], ['delta_y[48]', 127, 102, 1], ['sender_id', 0x8069, 103, 2]]);
    checkPayloadLayout(0x308, 34, (view, bytes) => {
        bytes.fill(0); view.setUint16(0, 0x8001, true); view.setUint16(2, 0x8101, true);
        view.setUint16(4, 0x4e2d, true); view.setUint16(6, 0x03a9, true);
    }, [['sender_id', 0x8001, 0, 2], ['receiver_id', 0x8101, 2, 2], ['user_data', '中Ω', 4, 30]]);
    checkPayloadLayout(0x306, 8, view => {
        view.setUint16(0, 0xfe81, true); view.setUint16(2, (1 << 12) | 1919, true); view.setUint16(4, 1079, true);
    }, [['key_value.key_1', 0x81, 0, 1, 0, 8], ['key_value.key_2', 0xfe, 1, 1, 8, 8],
        ['mouse_x.x_position', 1919, 2, 2, 0, 12], ['mouse_x.mouse_left', 1, 3, 1, 12, 4],
        ['mouse_y.y_position', 1079, 4, 2, 0, 12]]);
});

test('V2 PDF pp75–78 CRC tables and independently computed vectors match the preset', () => {
    const checksums = RoboMasterProtocol.compiled.rules.filter(rule => rule.type === 'checksum').map(rule => rule.config);
    // SHA256 of the freshly extracted 256-entry appendix tables (CRC16 entries
    // serialized little endian). Retain fingerprints, not the copyrighted tables.
    const expectedHashes = ['04265e73941eab6a72b646fd8e3c782233e3065931a282f35018e405e9d8cf67',
        '638dbc5f735cced09b3d0d767a72a8800baeb1b3bb399a514af61b3ea7be8a01'];
    for (const [index, config] of checksums.entries()) {
        const table = Buffer.alloc(256 * (index + 1));
        for (let byte = 0; byte < 256; byte++) {
            const value = Protocol.checksum(Uint8Array.of(byte), { ...config, init: 0 });
            if (index === 0) table[byte] = value;
            else table.writeUInt16LE(value, byte * 2);
        }
        assert.equal(createHash('sha256').update(table).digest('hex'), expectedHashes[index]);
    }
    // Expected results came from the PDF lookup-table algorithms, independently
    // of both Protocol.checksum and referenceCRC. Input byte i = (73*i+19)&255.
    for (const [length, crc8, crc16] of [[0, 255, 65535], [1, 74, 11677], [2, 64, 55208],
        [4, 124, 7226], [7, 137, 5199], [32, 28, 1329], [128, 52, 31645],
        [1024, 23, 45663], [65535, 53, 9372]]) {
        const bytes = Uint8Array.from({ length }, (_, i) => (i * 73 + 19) & 255);
        assert.equal(Protocol.checksum(bytes, checksums[0]), crc8, `CRC8 ${length}`);
        assert.equal(Protocol.checksum(bytes, checksums[1]), crc16, `CRC16 ${length}`);
    }
});
