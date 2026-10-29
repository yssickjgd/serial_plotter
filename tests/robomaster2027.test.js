const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol } = require('../protocolEngine');
const { ProtocolModel } = require('../protocolModel');
const { RoboMasterProtocol: RM } = require('../robomasterProtocol');

// Independent bit-at-a-time implementation of the PDF appendix algorithms.
function packet(command, payload, sequence = 17) {
    const crc = (bytes, initial, polynomial) => {
        let value = initial;
        for (const byte of bytes) {
            value ^= byte;
            for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ polynomial : value >>> 1;
        }
        return value;
    };
    const bytes = Uint8Array.from([0xa5, payload.length & 255, payload.length >>> 8, sequence, 0,
        command & 255, command >>> 8, ...payload, 0, 0]);
    bytes[4] = crc(bytes.subarray(0, 4), 255, 0x8c);
    const sum = crc(bytes.subarray(0, -2), 65535, 0x8408);
    bytes[bytes.length - 2] = sum & 255; bytes[bytes.length - 1] = sum >>> 8;
    return bytes;
}
function sample(command, size, write) {
    const payload = new Uint8Array(size), view = new DataView(payload.buffer);
    write(view, payload);
    const bytes = packet(command, payload), record = Protocol.decode(bytes, RM.compiled);
    assert.equal(record.valid, true); assert.deepEqual(record.warnings, []);
    return { record, bytes, payload };
}

test('2027 preset catalog has every serial command and the documented payload sizes', () => {
    const schema = RM.createSchema();
    assert.equal(schema.source.title, 'RoboMaster 2027 机甲大师高校系列赛通信协议');
    assert.equal(schema.source.version, 'V1.0.0（20261029）'); assert.equal(schema.source.pages, '3–45');
    assert.equal(schema.id, 'robomaster-2026-v1', 'saved protocol identity is not a document date');
    const expected = [[1,11],[2,1],[3,24],[0x101,8],[0x104,3],[0x105,3],[0x201,17],[0x202,14],
        [0x203,12],[0x204,7],[0x206,7],[0x207,7],[0x208,8],[0x209,6],[0x20a,6],[0x20b,40],
        [0x20c,2],[0x20d,14],[0x20e,8],[0x301,undefined],[0x303,12],[0x305,48],[0x307,105],
        [0x308,34],[0x310,300],[0x311,60],[0xa01,24],[0xa02,12],[0xa03,10],[0xa04,12],[0xa05,47],[0xa06,6]];
    assert.deepEqual(RM.legacySchema.messages.map(message => [message.command, message.length]), expected);
    for (const [command, length] of expected) {
        if (length === undefined) continue;
        const bytes = Protocol.encode(schema, `rm2026.${command.toString(16).padStart(4, '0')}`, {});
        assert.equal(bytes.length, length + 9); assert.deepEqual(bytes, packet(command, bytes.subarray(7,-2), 0));
    }
    const choices = ProtocolModel.flattenFields(schema).filter(row => row.field.type === 'choice');
    assert.ok(choices.every(row => row.field.displayBase === 'hex'));
    for (const command of [0x302,0x306,0x309]) {
        const bytes = packet(command, [0xff,0x80,3]);
        const record = Protocol.decode(bytes, schema);
        assert.equal(record.known, false); assert.deepEqual(record.fields.rawPayload, Uint8Array.of(0xff,0x80,3));
    }
});

test('2027 HP control degrees, signed impact coordinates and enlarged terminal packets use exact offsets', () => {
    const hp = sample(3,24,v=>{v.setInt16(8,-2345,true);v.setUint16(12,1001,true);v.setUint16(16,2002,true);
        v.setUint16(20,60000,true);v.setUint16(22,50000,true);}).record;
    for (const [path, value] of [['damage_difference',-2345],['outpost_R_HP',1001],['outpost_B_HP',2002],
        ['ally_control_degree',60000],['enemy_control_degree',50000]]) assert.equal(hp.values[path],value,path);
    const hit = sample(0x206,7,v=>{v.setUint8(0,0x23);v.setUint16(1,65534,true);
        v.setInt16(3,-32768,true);v.setInt16(5,32767,true);});
    for (const [path, value] of [['hurt.armor_id',3],['hurt.HP_deduction_reason',2],['hit_sequence',65534],
        ['hit_position_x',-32768],['hit_position_y',32767]]) assert.equal(hit.record.values[path],value,path);
    assert.deepEqual(Protocol.encode(RM.compiled,'rm2026.0206',hit.record.fields,{sequence:17}),hit.bytes);
    const raw = sample(0x311,60,(v,b)=>b.set(Uint8Array.from({length:60},(_,i)=>255-i)));
    assert.deepEqual(raw.record.fields.data,raw.payload);
});

test('2027 double event words and 16-bit RFID preserve crossing slices and unknown high bits', () => {
    const event = sample(0x101,8,v=>{v.setUint32(0,(4<<5)|(3<<18)|(3<<28),true);
        v.setUint32(4,((6<<13)|(3<<24)|0xf0000000)>>>0,true);}).record;
    assert.equal(event.values['event_data.R_fortress_buff'],4);
    assert.equal(event.values['event_data.R_central_highland'],3);
    assert.equal(event.values['event_data.R_outpost_control'],3);
    assert.equal(event.values['event_data_2.enemy_dart_target'],6);
    assert.equal(event.flatFields.find(f=>f.path==='event_data.R_outpost_control').label,undefined);
    assert.equal(event.values['event_data_2']>>>28,15);
    const rfid = sample(0x209,6,v=>{v.setUint32(0,(1<<22)|(1<<30),true);v.setUint16(4,0x8104,true);}).record;
    assert.equal(rfid.values['rfid_status.ally_tunnel_highway_lower'],true);
    assert.equal(rfid.values['rfid_status.ally_tunnel_trapezoid_far_upper'],true);
    assert.equal(rfid.values['rfid_status_2.enemy_tunnel_highway_upper'],true);
    assert.equal(rfid.values['rfid_status_2.enemy_tunnel_trapezoid_far_upper'],true);
    assert.equal(rfid.values.rfid_status_2,0x8104);
    assert.equal(rfid.flatFields.find(f=>f.path==='rfid_status_2.unspecified').numeric,null);
});

test('2027 armor fortification covers feedback, outgoing radar command and wireless state', () => {
    const feedback = sample(0x20e,8,v=>{v.setUint8(0,0x3a);v.setUint8(1,15);
        v.setUint16(2,60000,true);v.setUint16(4,50000,true);v.setUint16(6,40000,true);});
    assert.equal(feedback.record.values['radar_info_2.fortify_active'],true);
    assert.equal(feedback.record.values['radar_info_2.fortify_chances'],7);
    assert.equal(feedback.record.values.fortify_center_x,60000);assert.equal(feedback.record.values.fortify_radius,40000);
    const outgoing = sample(0x301,19,(v,b)=>{v.setUint16(0,0x121,true);v.setUint16(2,9,true);v.setUint16(4,257,true);
        v.setUint8(6,2);v.setUint8(7,1);b.set(Buffer.from('Ab9Z07'),8);v.setUint8(14,3);
        v.setUint16(15,65000,true);v.setUint16(17,64000,true);});
    assert.equal(outgoing.record.values['content.password'],'Ab9Z07');
    assert.equal(outgoing.record.values['content.armor_fortify_cmd'],3);
    assert.equal(outgoing.record.values['content.fortify_center_x'],65000);
    assert.equal(outgoing.record.values['content.fortify_center_y'],64000);
    assert.deepEqual(Protocol.encode(RM.compiled,'rm2026.0301.0121',outgoing.record.fields,{sequence:17}),outgoing.bytes);
    const wireless = sample(0xa04,12,v=>{v.setUint32(4,(4<<1)|(3<<14)|0xff000000,true);
        v.setUint32(8,((1<<21)|(2<<22)|(1<<28)|0xc0000000)>>>0,true);}).record;
    assert.equal(wireless.values['opponent_status.R_fortress_buff'],4);
    assert.equal(wireless.values['opponent_status.R_central_highland'],3);
    assert.equal(wireless.values['opponent_status_2.ally_tunnel_trapezoid_far_upper'],true);
    assert.equal(wireless.values['opponent_status_2.R_outpost_control'],2);
    assert.equal(wireless.values['opponent_status_2.B_base_control'],1);
    const buffs = sample(0xa05,47,v=>{v.setUint16(1,12345,true);v.setUint8(36,3);
        v.setUint16(41,60000,true);v.setUint16(43,50000,true);v.setUint16(45,40000,true);}).record;
    assert.equal(buffs.values.heavyengineer_cooling_buff,12345);
    assert.equal(buffs.values.heavyengineer_status,3);assert.equal(buffs.values.fortify_radius,40000);
});

test('2027 mixed revised messages parse at every split and stable unchanged fields retain references', () => {
    const frames = [packet(3,new Uint8Array(24)),packet(0x206,[1,2,3,4,5,6,7]),packet(0x209,new Uint8Array(6)),
        packet(0x20e,new Uint8Array(8)),packet(0xa04,new Uint8Array(12)),packet(0xa05,new Uint8Array(47))];
    const stream = Uint8Array.from(frames.flatMap(bytes=>[...bytes]));
    for (let split=0;split<=stream.length;split++) {
        const output=[], parser=RM.createParser();parser.onFrameParsed=record=>{
            assert.equal(record.valid,true);assert.deepEqual(record.warnings,[]);output.push(record.messageId);
        };
        parser.appendData(stream.subarray(0,split));parser.appendData(stream.subarray(split));parser.flushPending();
        assert.deepEqual(output,['rm2026.0003','rm2026.0206','rm2026.0209','rm2026.020e','rm2026.0a04','rm2026.0a05']);
    }
    const fields=ProtocolModel.flattenFields(RM.createSchema());
    for(const id of ['rm2026.0001.SyncTimeStamp','rm2026.0201.current_HP','rm2026.020d.sentry_info_3'])
        assert.ok(fields.some(row=>row.field.id===id),id);
    const event=fields.find(row=>row.field.name==='event_data_2').field;
    assert.equal(event.bits.find(bit=>bit.name==='enemy_dart_hit_time').id,'rm2026.0101.event_data.enemy_dart_hit_time');
    assert.equal(event.bits.find(bit=>bit.name==='enemy_dart_target').id,'rm2026.0101.event_data.enemy_dart_target');
});

test('saved previous-season protocol definitions keep their own old field widths and commands', () => {
    // A saved 2026-style protocol remains usable even though the default factory is 2027.
    const saved={id:'robomaster-2026-v1',name:'我的旧协议',version:'2026-custom',endian:'little',
        framing:{header:[0xa5],length:{offset:1,type:'uint16',adjustment:9},maxLength:1024},
        command:{offset:5,type:'uint16'},payloadOffset:7,payloadEnd:-2,
        messages:[{id:'saved-hit',name:'旧伤害',command:0x206,length:1,fields:[{id:'saved-hurt',name:'hurt',type:'uint8'}]},
            {id:'saved-controller',name:'旧控制器',command:0x306,length:8,fields:[{id:'saved-raw',name:'raw',type:'bytes',length:8}]}]};
    const text=JSON.stringify(saved),imported=Protocol.compile(JSON.parse(text));
    assert.equal(imported.schema.name,'我的旧协议');assert.equal(imported.schema.version,'2026-custom');
    assert.equal(Protocol.decode(packet(0x206,[0x51]),imported).fields.hurt,0x51);
    const bytes=Uint8Array.of(1,2,3,4,5,6,7,8);
    assert.deepEqual(Protocol.decode(packet(0x306,bytes),imported).fields.raw,bytes);
    RM.createSchema();assert.equal(JSON.stringify(saved),text);
});
