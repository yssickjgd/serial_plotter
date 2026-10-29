const test=require('node:test');
const assert=require('node:assert/strict');
const {Protocol}=require('../protocolEngine');
const {ReservedNames}=require('../reservedNames');

test('SEQ is the sole sequence builtin while ordinary SEQUENCE and lowercase field names remain case-sensitive',()=>{
    assert.ok(ReservedNames.protocolVariables.includes('SEQ'));
    assert.ok(!ReservedNames.protocolVariables.includes('SEQUENCE'));
    assert.equal(ReservedNames.error('SEQUENCE','field'),null);
    const config={id:'single-seq',symbolVersion:3,framing:{fixedLength:2},messages:[{id:'frame',fields:[
        {id:'ordinary',name:'SEQUENCE',type:'uint8'},
        {id:'value',name:'value',type:'uint8',condition:'SEQUENCE == 5'}
    ]}]};
    assert.deepEqual([...Protocol.encode(config,'frame',{SEQUENCE:5,value:9})],[5,9]);
    const missing=structuredClone(config);missing.messages[0].fields.shift();
    assert.throws(()=>Protocol.compile(missing),/reference|scope|identifier/i);
});

test('v2 sequence aliases migrate in expressions and rules without rewriting real member fields',()=>{
    const config={id:'sequence-upgrade',symbolVersion:2,schemaVersion:3,messages:[{id:'frame',byteLength:4,fields:[
        {id:'wire',name:'packet_seq',type:'uint8',valueSource:'SEQ'},
        {id:'data',name:'data',type:'uint8'},
        {id:'group',name:'group',type:'struct',length:1,fields:[{id:'member',name:'SEQUENCE',type:'uint8'}]},
        {id:'tail',name:'tail',type:'uint8',condition:'SEQUENCE == 7 && group.SEQUENCE == 9'}
    ]}],rules:[{id:'check',type:'assert',expression:'SEQUENCE == 7 && group.SEQUENCE == 9',strength:'strong'}]};
    const before=JSON.stringify(config),migrated=Protocol.migrateSymbols(config).schema;
    assert.equal(migrated.symbolVersion,3);assert.equal(migrated.messages[0].fields[3].condition,'SEQ == 7 && group.SEQUENCE == 9');
    assert.equal(migrated.rules[0].expression,'SEQ == 7 && group.SEQUENCE == 9');
    assert.equal(migrated.messages[0].fields[2].fields[0].id,'member');
    assert.equal(JSON.stringify(config),before);
    const wire=[7,2,9,4];assert.deepEqual([...Protocol.encode(config,'frame',{data:2,group:{SEQUENCE:9},tail:4},{sequence:7})],wire);
    assert.equal(Protocol.decode(wire,config).valid,true);
});

test('legacy ordinary sequence fields and dispatch names receive no protocol-specific prefix',()=>{
    const config={id:'generic',framing:{fixedLength:3},messages:[{id:'frame',fields:[
        {id:'a',name:'seq',type:'uint8'},{id:'b',name:'sequence',type:'uint8'},
        {id:'c',name:'value',type:'uint8',condition:'seq == 1 && sequence == 2'}
    ]}]};
    const {schema,renames}=Protocol.migrateSymbols(config);
    assert.deepEqual(schema.messages[0].fields.map(field=>field.name),['seq','sequence','value']);assert.deepEqual(renames,[]);
    assert.deepEqual([...Protocol.encode(config,'frame',{seq:1,sequence:2,value:3})],[1,2,3]);
});
