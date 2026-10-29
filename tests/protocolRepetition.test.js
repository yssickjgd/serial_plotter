const test=require('node:test');
const assert=require('node:assert/strict');
const {Protocol}=require('../protocolEngine');
const {ProtocolModel}=require('../protocolModel');

const schema=(field,size=6)=>({id:'struct-repetition',schemaVersion:3,endian:'little',messages:[{id:'frame',byteLength:size,fields:[field]}]});
const fixed=()=>({id:'items',name:'items',type:'struct',byteLength:2,until:'end',leftover:'padding',paddingByte:0,fields:[{id:'value',name:'value',type:'uint8',byteLength:1}]});

test('structures repeated to segment end keep per-item widths, arrays, LEN and source spans',()=>{
    const config=schema(fixed());config.rules=[{id:'length-check',type:'assert',expression:'LEN(items) == 6',stage:'validation',strength:'strong'}];
    const before=JSON.stringify(config),bytes=[1,0,2,0,3,0],record=Protocol.decode(bytes,config);
    assert.equal(record.valid,true);assert.deepEqual(record.fields.items.map(item=>item.value),[1,2,3]);
    assert.ok(record.fields.items.every(item=>item._unknownTail.length===1&&item._unknownTail[0]===0));
    assert.deepEqual(record.flatFields.filter(item=>item.fieldId==='value').map(item=>[item.path,item.byteOffset]),[['items[0].value',0],['items[1].value',2],['items[2].value',4]]);
    assert.deepEqual([...Protocol.encode(config,'frame',{items:[{value:1},{value:2},{value:3}]})],bytes);
    assert.equal(JSON.stringify(config),before);assert.equal(ProtocolModel.layoutSummary(config,'frame')[0].width,null);
});

test('structures with variable internal layouts repeat independently and preserve the following outer field',()=>{
    const items={id:'items',name:'items',type:'struct',byteLength:0,lengthFrom:'contents',until:'end',fields:[
        {id:'size',name:'size',type:'uint8',byteLength:1},{id:'data',name:'data',type:'bytes',byteLength:0,lengthFrom:'size'}
    ]};
    const config=schema({id:'group',name:'group',type:'struct',byteLength:6,fields:[items]},7);
    config.messages[0].fields.push({id:'tail',name:'tail',type:'uint8',byteLength:1});
    const bytes=[1,170,2,187,204,0,9],record=Protocol.decode(bytes,config);
    assert.equal(record.valid,true);assert.equal(record.fields.group.items.length,3);assert.equal(record.fields.tail,9);
    assert.deepEqual([...record.fields.group.items[1].data],[187,204]);
    assert.deepEqual([...Protocol.encode(config,'frame',record.fields)],bytes);
});

test('until-end structures reject zero progress, conflicting counts and an unbounded following sibling',()=>{
    assert.throws(()=>Protocol.compile(schema({id:'empty',name:'empty',type:'struct',byteLength:0,lengthFrom:'contents',until:'end',fields:[]})),error=>error.code==='progress');
    assert.throws(()=>Protocol.compile(schema({...fixed(),count:2})),/count|until/i);
    const config=schema(fixed(),7);config.messages[0].fields.push({id:'tail',name:'tail',type:'uint8',byteLength:1});
    assert.throws(()=>Protocol.compile(config),/last field|boundary/i);
    assert.equal(Protocol.decode([1,0,2,0,3],schema(fixed(),5)).valid,false);
    assert.throws(()=>Protocol.compile(schema(fixed(),0)),/bound|边界|定界/i);
    const selfLength=schema(fixed(),0);selfLength.messages[0].lengthFrom='LEN(items)';
    assert.throws(()=>Protocol.compile(selfLength),/LEN|长度|length/i);
});

test('until-end structures handle empty arrays and reject a short encoded array',()=>{
    const config=schema({id:'group',name:'group',type:'struct',byteLength:0,lengthFrom:'contents',fields:[fixed()]},1);
    config.messages[0].fields.unshift({id:'tag',name:'tag',type:'uint8',byteLength:1});
    const record=Protocol.decode([9],config);assert.equal(record.valid,true);assert.deepEqual(record.fields.group.items,[]);
    assert.deepEqual([...Protocol.encode(config,'frame',{tag:9,group:{items:[]}})],[9]);
    assert.throws(()=>Protocol.encode(schema(fixed()),'frame',{items:[{value:1}]}),/fill|length|segment/i);
    assert.throws(()=>Protocol.encode(schema({...fixed(),byteLength:0,lengthFrom:'contents'}),'frame',{items:[{value:1}]}),/fill|length|segment/i);
});

test('nested until-end structures require a reliable enclosing item boundary',()=>{
    const items={...fixed(),byteLength:1,fields:[{id:'value',name:'value',type:'uint8',byteLength:1}]};
    const group={id:'group',name:'group',type:'struct',byteLength:0,lengthFrom:'contents',fields:[items]};
    const config=schema(group,4);config.messages[0].fields.push({id:'tail',name:'tail',type:'uint8',byteLength:1});
    assert.throws(()=>Protocol.compile(config),/边界|boundary/i);
    const branch=schema({id:'choice',name:'choice',type:'choice',byteLength:0,lengthFrom:'contents',selector:'1',branches:[{id:'branch',equals:1,fields:[group]}]},4);
    branch.messages[0].fields.push({id:'tail',name:'tail',type:'uint8',byteLength:1});
    assert.throws(()=>Protocol.compile(branch),/边界|boundary/i);
    const legacy=schema({id:'outer',name:'outer',type:'repeat',byteLength:6,count:2,fields:[
        {id:'tag',name:'tag',type:'uint8',byteLength:1},items
    ]});
    assert.throws(()=>Protocol.compile(legacy),/边界|boundary/i);
    const bounded=schema({id:'outer',name:'outer',type:'struct',byteLength:3,count:2,fields:[
        {id:'tag',name:'tag',type:'uint8',byteLength:1},items
    ]});
    const record=Protocol.decode([10,1,2,20,3,4],bounded);
    assert.equal(record.valid,true);assert.deepEqual(record.fields.outer.map(item=>item.items.map(entry=>entry.value)),[[1,2],[3,4]]);
    assert.deepEqual([...Protocol.encode(bounded,'frame',record.fields)],[10,1,2,20,3,4]);
    for(const lengthFrom of ['FRAME_LENGTH - 1','REMAINING - 1','PARENT_REMAINING - 1']){
        const derived=schema({...group,lengthFrom},4);derived.messages[0].fields.push({id:'tail',name:'tail',type:'uint8',byteLength:1});
        const decoded=Protocol.decode([1,2,3,9],derived);
        assert.equal(decoded.valid,true,lengthFrom);assert.equal(decoded.fields.tail,9);
        assert.deepEqual(decoded.fields.group.items.map(item=>item.value),[1,2,3]);
        assert.deepEqual([...Protocol.encode(derived,'frame',decoded.fields)],[1,2,3,9]);
    }
});

test('repeated structures survive bytewise fragmented and concatenated frames without consuming the next frame',()=>{
    const config=schema(fixed()),records=[],parser=new Protocol.StreamParser(config);
    parser.onFrameParsed=record=>records.push(record);
    const wire=Uint8Array.of(1,0,2,0,3,0,4,0,5,0,6,0);
    for(let index=0;index<6;index++){
        parser.appendData(wire.subarray(index,index+1));assert.equal(records.length,index===5?1:0);
    }
    parser.appendData(wire.subarray(6));assert.equal(records.length,2);
    assert.deepEqual(records.map(record=>record.fields.items.map(item=>item.value)),[[1,2,3],[4,5,6]]);
});

test('scalar and byte-valued fields repeat to their bounded end with indexed values and exact bytes',()=>{
    const cases=[
        [{type:'uint16',byteLength:2},[1,0,2,0,3,0],[1,2,3]],
        [{type:'float32',byteLength:4},[0,0,128,63,0,0,0,192],[1,-2]],
        [{type:'bool',byteLength:1},[1,0,1],[true,false,true]],
        [{type:'enum',baseType:'uint8',byteLength:1,enum:{0:'off',1:'on'}},[0,1],[0,1]],
        [{type:'uint64',byteLength:8},[1,0,0,0,0,0,32,0,2,0,0,0,0,0,0,0],[9007199254740993n,2n]],
        [{type:'bitfield',byteLength:1,bits:[{id:'flag',name:'flag',offset:0,length:1,type:'bool'}]},[1,2],[1,2]],
        [{type:'bytes',byteLength:2},[1,2,3,4],[[1,2],[3,4]]],
        [{type:'reserved',byteLength:2},[0,1,0,2],[[0,1],[0,2]]],
        [{type:'fixed',byteLength:1,bytes:[170]},[170,170],[[170],[170]]],
        [{type:'string',byteLength:2,encoding:'ascii'},[97,98,99,100],['ab','cd']]
    ];
    for(const [definition,wire,expected] of cases){
        const config=schema({id:'values',name:'values',...definition,until:'end'},wire.length),before=JSON.stringify(config);
        const record=Protocol.decode(wire,config);
        assert.equal(record.valid,true,definition.type);
        const actual=record.fields.values.map(value=>value instanceof Uint8Array?[...value]:value);
        assert.deepEqual(actual,expected,definition.type);
        assert.deepEqual([...Protocol.encode(config,'frame',{values:expected})],wire,definition.type);
        assert.equal(ProtocolModel.layoutSummary(config,'frame')[0].width,null,definition.type);
        assert.equal(JSON.stringify(config),before);
        assert.deepEqual(record.flatFields.filter(field=>field.fieldId==='values').map(field=>field.path),expected.map((_,index)=>`values[${index}]`));
        const records=[],parser=new Protocol.StreamParser(config);parser.onFrameParsed=frame=>records.push(frame);
        for(const byte of wire)parser.appendData([byte]);
        parser.appendData(wire);assert.equal(records.length,2,definition.type);
        assert.ok(records.every(frame=>frame.valid),definition.type);
    }
});

test('repeated choices select per-item branches and retain each item length',()=>{
    const config=schema({id:'items',name:'items',type:'choice',byteLength:0,lengthFrom:'contents',until:'end',selector:'INDEX % 2',branches:[
        {id:'short-case',equals:0,fields:[{id:'small',name:'small',type:'uint8',byteLength:1}]},
        {id:'wide-case',equals:1,fields:[{id:'wide',name:'wide',type:'uint16',byteLength:2}]}
    ]},4);
    config.rules=[{id:'length-check',type:'assert',expression:'LEN(items) == 4 && LEN(items[1]) == 2',strength:'strong'}];
    const record=Protocol.decode([1,3,2,4],config);
    assert.equal(record.valid,true);assert.deepEqual(record.fields.items,[{small:1},{wide:515},{small:4}]);
    assert.deepEqual([...Protocol.encode(config,'frame',record.fields)],[1,3,2,4]);
    const frames=[],parser=new Protocol.StreamParser(config);parser.onFrameParsed=frame=>frames.push(frame);
    for(const byte of [1,3,2,4])parser.appendData([byte]);
    assert.equal(frames.length,1);assert.equal(frames[0].valid,true);
});

test('until-end numeric LEN expressions and nested mapping never use a single element as the total width',()=>{
    const config=schema({id:'values',name:'values',type:'uint16',byteLength:2,until:'end'});
    config.rules=[{id:'length-check',type:'assert',expression:'LEN(values) == 6 && LEN(values[1]) == 2 && values[2] == 3',strength:'strong'}];
    assert.equal(Protocol.decode([1,0,2,0,3,0],config).valid,true);
    assert.equal(Protocol.decode([1,0,2],schema(config.messages[0].fields[0],3)).valid,false);
    const dependent=schema(config.messages[0].fields[0],0);dependent.messages[0].lengthFrom='LEN(values)';
    assert.throws(()=>Protocol.compile(dependent),/LEN|长度|length/i);
    const empty=schema({id:'tag',name:'tag',type:'uint8',byteLength:1},1);
    empty.messages[0].fields.push(config.messages[0].fields[0]);
    assert.deepEqual(Protocol.decode([9],empty).fields.values,[]);
    assert.deepEqual([...Protocol.encode(empty,'frame',{tag:9,values:[]})],[9]);
});

test('invalid until-end fields report missing item boundaries, zero progress and automatic-source conflicts',()=>{
    for(const field of [
        {type:'bytes',byteLength:0},
        {type:'string',byteLength:0,lengthFrom:'0'},
        {type:'choice',byteLength:0,lengthFrom:'contents',selector:'1',branches:[{id:'empty-case',equals:1,fields:[]}]},
        {type:'uint8',byteLength:1,valueSource:'SEQ'},
        {type:'fixed',byteLength:1,bytes:[170],framingRole:'sync'}
    ]){
        assert.throws(()=>Protocol.compile(schema({id:'values',name:'values',...field,until:'end'})),/边界|长度|消耗|序号|帧头|length|progress|boundary|SEQ|Framing|position/i,field.type);
    }
});

test('variable item lengths are evaluated at each until-end item and cannot silently change during encoding',()=>{
    const config=schema({id:'values',name:'values',type:'bytes',byteLength:0,lengthFrom:'INDEX + 1',until:'end'});
    const wire=[1,2,3,4,5,6],record=Protocol.decode(wire,config);
    assert.equal(record.valid,true);assert.deepEqual(record.fields.values.map(value=>[...value]),[[1],[2,3],[4,5,6]]);
    assert.deepEqual([...Protocol.encode(config,'frame',record.fields)],wire);
    const frames=[],parser=new Protocol.StreamParser(config);parser.onFrameParsed=frame=>frames.push(frame);
    for(const byte of wire)parser.appendData([byte]);
    assert.equal(frames.length,1);assert.equal(frames[0].valid,true);
    const remaining=schema({...config.messages[0].fields[0],lengthFrom:'REMAINING'});
    assert.throws(()=>Protocol.encode(remaining,'frame',{values:[[1,2],[3,4,5,6]]}),/boundary|length|progress|段|字节/i);
});

test('an item length source is backfilled with each-item width rather than the entire repetition region',()=>{
    const config=schema({id:'values',name:'values',type:'bytes',byteLength:0,lengthSource:{fieldId:'size'},until:'end'},7);
    config.messages[0].fields.unshift({id:'size',name:'size',type:'uint8',byteLength:1});
    const wire=[2,1,2,3,4,5,6],record=Protocol.decode(wire,config);
    assert.equal(record.valid,true);assert.equal(record.fields.values.length,3);
    assert.deepEqual([...Protocol.encode(config,'frame',record.fields)],wire);
    assert.throws(()=>Protocol.encode(config,'frame',{values:[[1],[2,3,4,5,6]]}),/相同|长度|length/i);
});

test('repeated values inside each TLV item use the item boundary during encoding',()=>{
    const config=schema({id:'items',name:'items',type:'tlv',byteLength:6,until:'end',
        headerFields:[{id:'tag',name:'tag',type:'uint8',byteLength:1},{id:'size',name:'size',type:'uint8',byteLength:1}],
        lengthField:'size',selector:'tag',branches:[{id:'known',equals:1,fields:[{id:'values',name:'values',type:'uint8',byteLength:1,until:'end'}]}]
    });
    const wire=[1,1,7,1,1,8],record=Protocol.decode(wire,config);
    assert.equal(record.valid,true);assert.deepEqual(record.fields.items.map(item=>item.values),[[7],[8]]);
    assert.deepEqual([...Protocol.encode(config,'frame',record.fields)],wire);
});

test('deferred parsing preserves an empty repeated fixed region instead of checking a nonexistent first item',()=>{
    const config=schema({id:'tag',name:'tag',type:'uint8',byteLength:1},1);
    config.messages[0].fields.push({id:'values',name:'values',type:'fixed',bytes:[170],byteLength:1,until:'end'});
    assert.equal(Protocol.decode([9],config).valid,true);
    const frames=[],parser=new Protocol.StreamParser(config,{deferDecode:true});parser.onFrameParsed=frame=>frames.push(frame);
    parser.appendData([9]);assert.equal(frames.length,1);assert.notEqual(frames[0].valid,false);
    assert.deepEqual(frames[0].warnings,[]);
});

test('a count expression evaluating to minus one never selects until-end repetition',()=>{
    const config=schema({id:'counter',name:'counter',type:'uint8',byteLength:1},3);
    config.messages[0].fields.push({id:'values',name:'values',type:'uint8',byteLength:1,count:'counter - 2'});
    const record=Protocol.decode([1,7,9],config);
    assert.equal(record.valid,false);assert.equal(record.fields.values,undefined);
    assert.ok(!record.flatFields.some(field=>field.fieldId==='values'));
    assert.equal(config.messages[0].fields[1].until,undefined);
    assert.throws(()=>Protocol.encode(config,'frame',{counter:1,values:[7,9]}),/count|次数/i);
});
