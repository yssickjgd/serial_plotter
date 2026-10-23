const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol } = require('../protocolEngine');
const packet = (fields, size = 8) => ({ schemaVersion: 2, id: 'nested', endian: 'little', framing: { fixedLength: size }, messages: [{ id: 'msg', fields }] });
test('bounded structures inherit endian and preserve following siblings', () => {
 const schema = packet([{name:'block',type:'struct',length:3,endian:'big',fields:[{name:'n',type:'uint16'}]},{name:'last',type:'uint8'}],4);
 const rec = Protocol.decode([1,2,99,7],schema);
 assert.equal(rec.fields.block.n,258); assert.equal(rec.fields.last,7); assert.equal(rec.valid,true);
 assert.deepEqual([...Protocol.encode(schema,'msg',{block:{n:258},last:7})],[1,2,0,7]);
 const bad = Protocol.decode([1,2],packet([{name:'s',type:'struct',length:1,fields:[{name:'n',type:'uint16'}]},{name:'last',type:'uint8'}],2));
 assert.equal(bad.valid,false); assert.ok(bad.flatFields.every(f=>f.numeric===null));
});
test('choice is exclusive, exact64 and compile diagnostics identify ambiguity', () => {
 const fields=[{name:'tag',type:'uint64'},{name:'body',type:'choice',selector:'tag',branches:[{id:'yes',equals:'9007199254740993',fields:[{name:'n',type:'uint8'}]},{id:'no',default:true,fields:[{name:'raw',type:'bytes',length:1}]}]}];
 const schema=packet(fields,9), bytes=Protocol.encode(schema,'msg',{tag:9007199254740993n,body:{n:17}});
 assert.equal(Protocol.decode(bytes,schema).fields.body.n,17);
 assert.equal(Protocol.evaluateExpression('x == 9007199254740993',{x:9007199254740993n}),true);
 fields[1].branches.push({id:'overlap',range:['9007199254740993','9007199254740994'],fields:[]});
 assert.throws(()=>Protocol.compile(packet(fields,9)),e=>e.code==='ambiguity'&&e.nodeId==='overlap');
});
test('repeat uses a fresh local scope and bounded items make progress', () => {
 const schema=packet([{name:'items',type:'repeat',until:'end',fields:[{name:'n',type:'uint8'},{name:'v',type:'bytes',length:'n'}]}],5);
 const rec=Protocol.decode([1,8,2,9,10],schema); assert.equal(rec.valid,true);
 assert.deepEqual(rec.fields.items.map(v=>[...v.v]),[[8],[9,10]]);
 assert.deepEqual([...Protocol.encode(schema,'msg',rec.fields)],[1,8,2,9,10]);
 assert.throws(()=>Protocol.compile(packet([{name:'empty',type:'repeat',until:'end',fields:[]}])));
});
test('TLV honors header lengths, skips unknown values, and stops at corrupt boundaries', () => {
 const fields=[{name:'items',type:'tlv',until:'end',headerFields:[{name:'kind',type:'uint8'},{name:'size',type:'uint8'}],lengthField:'size',selector:'kind',branches:[{id:'number',equals:1,fields:[{name:'n',type:'uint16',endian:'big'}]}]}];
 const schema=packet(fields,9), bytes=[1,2,1,2,77,3,8,9,10], rec=Protocol.decode(bytes,schema);
 assert.equal(rec.valid,true); assert.equal(rec.fields.items[0].n,258); assert.deepEqual([...rec.fields.items[1].rawPayload],[8,9,10]);
 assert.deepEqual([...Protocol.encode(schema,'msg',rec.fields)],bytes);
 const bad=Protocol.decode([1,20,1,2,77,3,8,9,10],schema); assert.equal(bad.valid,false); assert.deepEqual([...bad.fields._unknownTail],[1,20,1,2,77,3,8,9,10]);
});
test('fixed validation runs for deferred frames and compile rejects forward references and writers', () => {
 const schema=packet([{name:'head',type:'fixed',bytes:[170]},{name:'n',type:'uint8'},{name:'mark',type:'fixed',bytes:[85]}],3);
 const parser=new Protocol.StreamParser(schema,{deferDecode:true}), frames=[]; parser.onFrameParsed=r=>frames.push(r); parser.appendData([170,2,84]);
 assert.equal(frames.length,1); assert.equal(frames[0].valid,false); assert.equal(frames[0].warnings[0].code,'fixed');
 assert.throws(()=>Protocol.compile(packet([{id:'bad',name:'data',type:'bytes',length:'later'},{name:'later',type:'uint8'}])),e=>e.nodeId==='bad');
 assert.throws(()=>Protocol.compile(packet([{name:'a',type:'uint16',offset:0},{name:'b',type:'uint8',offset:1}])));
});
test('deferred parsing retains invalid layouts and does not expand numeric payloads', () => {
 const tlv=packet([{name:'items',type:'tlv',until:'end',headerFields:[{name:'tag',type:'uint8'},{name:'len',type:'uint8'}],lengthField:'len',selector:'tag',branches:[]}],3);
 for(const deferred of [false,true]) { const parser=new Protocol.StreamParser(tlv,{deferDecode:deferred}),frames=[],errors=[];parser.onFrameParsed=(r,t,b)=>frames.push({r,b});parser.onFrameError=(r,t,b)=>errors.push(...b);parser.appendData([1,8,9]);parser.flushPending();assert.equal(frames.length,1);assert.deepEqual([...frames[0].b],[1,8,9]);assert.deepEqual(errors,[]);if(!deferred)assert.equal(frames[0].r.valid,false); }
 const parser=new Protocol.StreamParser(packet([{name:'values',type:'uint8',count:100}],100),{deferDecode:true,maxDecodedFields:1}),frames=[];parser.onFrameParsed=r=>frames.push(r);parser.appendData(new Uint8Array(100));assert.equal(frames.length,1);assert.equal(frames[0].fields,undefined);
});
test('count-bounded repeat tails obey preserve exact and padding policies', () => {
 for(const type of ['repeat','tlv'])for(const leftover of ['preserve','exact','padding']) {
  const field=type==='repeat'?{name:'items',type,count:1,length:3,leftover,paddingByte:255,fields:[{name:'v',type:'uint8'}]}:{name:'items',type,count:1,length:4,leftover,paddingByte:255,headerFields:[{name:'tag',type:'uint8'},{name:'len',type:'uint8'}],lengthField:'len',selector:'tag',branches:[]};
  const bytes=type==='repeat'?[7,8,9,10]:[7,0,8,9,10],schema=packet([field,{name:'last',type:'uint8'}],bytes.length),record=Protocol.decode(bytes,schema);
  assert.equal(record.valid,leftover==='preserve');if(leftover==='preserve'){assert.deepEqual([...record.fields._segmentTails.items],[8,9]);assert.deepEqual([...Protocol.encode(schema,'msg',record.fields)],bytes);}
 }
});
test('automatic framing writers and conditional framing roles cannot contradict the layout', () => {
 const collision={schemaVersion:2,id:'header',framing:{fixedLength:2,header:[170]},command:{offset:0,type:'uint8'},payloadOffset:1,messages:[{id:'m',command:1,fields:[{name:'v',type:'uint8'}]}]};
 assert.throws(()=>Protocol.compile(collision),e=>e.code==='overlap');
 const conditional=packet([{name:'flag',type:'uint8'},{name:'optional',type:'struct',condition:'flag == 1',fields:[{name:'sync',type:'fixed',bytes:[170],framingRole:'sync'}]}],2);
 assert.throws(()=>Protocol.compile(conditional),e=>e.code==='schema');
});
test('known-offset synchronization and end fixed nodes frame streams without consuming their fields', () => {
 const schema=packet([{name:'prefix',type:'uint8'},{name:'sync',type:'fixed',offset:1,bytes:[170,187],framingRole:'sync'},{name:'n',type:'uint8'},{name:'end',type:'fixed',bytes:[13],framingRole:'end'}],5);
 const bytes=Protocol.encode(schema,'msg',{prefix:9,n:7});
 assert.deepEqual([...bytes],[9,170,187,7,13]);
 const parser=new Protocol.StreamParser(schema),records=[];parser.onFrameParsed=r=>records.push(r);
 parser.appendData([99,9,170]);parser.appendData([187,7,13]);
 assert.equal(records.length,1);assert.equal(records[0].valid,true);assert.equal(records[0].fields.n,7);
 assert.deepEqual([...records[0].fields.end],[13]);
});
test('runtime ambiguous choices and total-length TLV never publish partial numeric values', () => {
 const schema=packet([{name:'tag',type:'uint8'},{name:'body',type:'choice',selector:'tag',branches:[{id:'a',mask:{mask:1,value:1},fields:[{name:'a',type:'uint8'}]},{id:'b',expression:'tag > 0',fields:[{name:'b',type:'uint8'}]}]}],2);
 const rec=Protocol.decode([1,8],schema); assert.equal(rec.valid,false);assert.equal(rec.flatFields[0].numeric,null);
 assert.throws(()=>Protocol.encode(schema,'msg',{tag:1,body:{a:8}}),e=>e.code==='ambiguity');
 const tlv=packet([{name:'items',type:'tlv',until:'end',lengthIncludesHeader:true,lengthUnit:2,headerFields:[{name:'kind',type:'uint8'},{name:'size',type:'uint8'}],lengthField:'size',selector:'kind',branches:[]}],4);
 assert.deepEqual([...Protocol.encode(tlv,'msg',{items:[{kind:8,rawPayload:[1,2]}]})],[8,2,1,2]);
 assert.equal(Protocol.decode([8,2,1,2],tlv).valid,true);
});
test('checksum dependencies are topologically written and cycles or overlaps are rejected', () => {
 const schema=packet([{name:'n',type:'uint8'}],3);schema.payloadEnd=1;
 schema.checksums=[{id:'outer',type:'sum',width:8,start:0,end:2,offset:2},{id:'inner',type:'sum',width:8,start:0,end:1,offset:1}];
 const bytes=Protocol.encode(schema,'msg',{n:7});assert.deepEqual([...bytes],[7,7,14]);assert.equal(Protocol.decode(bytes,schema).valid,true);
 const cycle=structuredClone(schema);cycle.checksums[1].start=2;cycle.checksums[1].end=3;
 assert.throws(()=>Protocol.compile(cycle),e=>e.code==='dependency');
 const overlap=structuredClone(schema);overlap.messages[0].fields.push({name:'collision',type:'uint8'});
 assert.throws(()=>Protocol.compile(overlap),e=>e.code==='overlap');
});
test('TLV retains completed items on a partial header, empty unknown V, and skips short known V', () => {
 const field={name:'items',type:'tlv',until:'end',headerFields:[{name:'tag',type:'uint8'},{name:'size',type:'uint8'}],selector:'tag',lengthField:'size',branches:[{id:'known',equals:1,fields:[{name:'n',type:'uint16'}]},{id:'raw',default:true,fields:[]}]};
 const partial=Protocol.decode([9,0,7],packet([field],3));assert.equal(partial.valid,false);assert.equal(partial.fields.items.length,1);assert.equal(partial.fields.items[0].rawPayload.length,0);assert.deepEqual([...partial.fields._unknownTail],[7]);
 const short=Protocol.decode([1,1,8,9,0],packet([{...field,invalidItem:'skip'}],5));assert.equal(short.valid,false);assert.equal(short.fields.items.length,2);assert.equal(short.fields.items[1].tag,9);assert.ok(short.flatFields.every(f=>f.numeric===null));
 assert.deepEqual([...Protocol.encode(packet([field],2),'msg',{items:[{tag:9,rawPayload:[]} ]})],[9,0]);
});
test('nested leftover policies and parent scope respect bounded segments', () => {
 const schema=packet([{name:'n',type:'uint8'},{name:'s',type:'struct',length:3,leftover:'padding',paddingByte:255,fields:[{name:'v',type:'bytes',length:'parent.n'}]},{name:'end',type:'uint8'}],5);
 const bytes=Protocol.encode(schema,'msg',{n:1,s:{v:[7]},end:8});assert.deepEqual([...bytes],[1,7,255,255,8]);assert.equal(Protocol.decode(bytes,schema).valid,true);
 const bad=bytes.slice();bad[2]=0;assert.equal(Protocol.decode(bad,schema).valid,false);
 assert.throws(()=>Protocol.compile(packet([{name:'items',type:'repeat',until:'end',fields:[{name:'v',type:'uint8'}]},{name:'tail',type:'uint8'}])));
});
test('dynamic writers cannot overwrite automatic length or checksum storage', () => {
 const schema={schemaVersion:2,id:'writers',framing:{fixedLength:4,length:{offset:1,type:'uint8'}},payloadOffset:0,messages:[{id:'m',fields:[{name:'offset',type:'uint8'},{name:'value',type:'uint8',offset:'offset'}]}]};
 assert.throws(()=>Protocol.encode(schema,'m',{offset:1,value:99}),e=>e.code==='overlap');
});
test('TLV stop policy preserves remainder when known value is short', () => {
 const field={name:'items',type:'tlv',until:'end',invalidItem:'stop',headerFields:[{name:'tag',type:'uint8'},{name:'size',type:'uint8'}],selector:'tag',lengthField:'size',branches:[{id:'known',equals:1,fields:[{name:'n',type:'uint16'}]}]};
 const rec=Protocol.decode([1,1,8,9,0],packet([field],5));assert.equal(rec.valid,false);assert.equal(rec.fields.items.length,0);assert.deepEqual([...rec.fields._unknownTail],[1,1,8,9,0]);
});
test('canonical schemas keep framing bindings editable without persisting derived markers', () => {
 const schema=packet([{name:'sync',type:'fixed',bytes:[170],framingRole:'sync'},{name:'n',type:'uint8'},{name:'end',type:'fixed',bytes:[13],framingRole:'end'}],3);
 const compiled=Protocol.compile(schema);assert.equal(compiled.schema.framing.header,undefined);assert.equal(compiled.schema.framing.footer,undefined);
 const edited=structuredClone(compiled.schema);delete edited.messages[0].fields[0].framingRole;delete edited.messages[0].fields[2].framingRole;
 const changed=Protocol.compile(edited);assert.equal(changed.sync,undefined);assert.equal(changed.framing.footer,undefined);
});
