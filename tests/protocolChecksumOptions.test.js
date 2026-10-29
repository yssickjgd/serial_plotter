const test=require('node:test');
const assert=require('node:assert/strict');
const {Protocol}=require('../protocolEngine');

test('checksum initial values, width-limited inversion and output XOR match independent expected values',()=>{
    const cases=[
        [[1,2,3],{type:'sum',width:8,init:16,invertResult:true,xorOut:15},230],
        [[1,2,3],{type:'xor',width:8,init:170,invertResult:true,xorOut:15},90],
        [[255,2],{type:'sum',width:16,init:65280,invertResult:true,xorOut:240},65294],
        [[1,2],{type:'sum',width:32,init:4294967294,invertResult:true},4294967294],
        [new TextEncoder().encode('123456789'),{type:'crc16',width:16,polynomial:0x1021,init:0xffff,invertResult:true},0xd64e]
    ];
    for(const [bytes,options,expected] of cases)assert.equal(Protocol.checksum(bytes,options),expected,options.type+'/'+options.width);
    assert.equal(Protocol.checksum([1,2,3],{type:'sum',width:8}),6);
});

test('field and standalone checksum rules generate and verify the same inverted wire bytes',()=>{
    for(const ruleBased of [false,true]){
        const checksum={type:'sum',init:16,invertResult:true,xorOut:15,start:{fieldId:'data',edge:'start'},end:{fieldId:'data',edge:'end'}};
        const config={id:'checksum-options',schemaVersion:3,messages:[{id:'frame',byteLength:4,fields:[
            {id:'data',name:'data',type:'bytes',byteLength:3},
            {id:'check',name:'check',type:ruleBased?'uint8':'checksum',byteLength:1,...(!ruleBased?{checksum}:{})}
        ]}],...(ruleBased?{rules:[{id:'verify',type:'checksum',targetFieldId:'check',checksum,send:'fill',strength:'strong'}]}:{})};
        const wire=[1,2,3,230];assert.deepEqual([...Protocol.encode(config,'frame',{data:[1,2,3]})],wire);
        assert.equal(Protocol.decode(wire,config).valid,true);
        const frames=[],parser=new Protocol.StreamParser(config);parser.onFrameParsed=frame=>frames.push(frame);
        for(const byte of wire)parser.appendData([byte]);assert.equal(frames.length,1);assert.equal(frames[0].valid,true);
        const invalid=structuredClone(config);
        (ruleBased?invalid.rules[0].checksum:invalid.messages[0].fields[1].checksum).invertResult='false';
        assert.throws(()=>Protocol.compile(invalid),/取反|boolean|布尔/i);
    }
});

test('serialized workers use the same checksum options and migrate the retired sequence alias',()=>{
    const vm=require('node:vm'),context=vm.createContext({Uint8Array,DataView,ArrayBuffer,TextEncoder,TextDecoder});
    const worker=vm.runInContext(`(${Protocol.createFactorySource()})(globalThis)`,context);
    assert.equal(worker.checksum([1,2,3],{type:'sum',width:8,init:16,invertResult:true,xorOut:15}),230);
    const config={id:'worker-sequence',symbolVersion:2,framing:{fixedLength:2},messages:[{id:'frame',fields:[
        {name:'counter',type:'uint8',valueSource:'SEQ'},{name:'value',type:'uint8',condition:'SEQUENCE == 7'}
    ]}]};
    assert.equal(worker.compile(config).schema.messages[0].fields[1].condition,'SEQ == 7');
    assert.equal(worker.decode([7,9],config).fields.value,9);
});
