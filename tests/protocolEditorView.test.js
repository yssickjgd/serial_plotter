const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol } = require('../protocolEngine');
const { ProtocolEditorView } = require('../protocolEditorView');
const { ProtocolModel } = require('../protocolModel');
const named = (schema, name) => ProtocolModel.flattenFields(schema).find(row => row.field.name === name)?.field;

test('sum and XOR checksum forms expose initial output XOR and inversion options in the field radix',()=>{
    const f=fixture();f.view.open({id:'checksum-form',schemaVersion:3,messages:[{id:'frame',byteLength:4,fields:[
        {id:'data',name:'data',type:'bytes',byteLength:3},
        {id:'check',name:'check',type:'checksum',byteLength:1,displayBase:'hex',checksum:{type:'sum',start:{fieldId:'data',edge:'start'},end:{fieldId:'data',edge:'end'}}}
    ]}]});f.view._selectField(named(f.view.draft,'check'));
    f.change('field.checksum.init','10');f.change('field.checksum.xorOut','0F');f.change('field.checksum.invertResult',true);
    assert.deepEqual([...Protocol.encode(f.view.draft,'frame',{data:[1,2,3]})],[1,2,3,230]);
    assert.equal(f.control('field.checksum.init').value,'0x10');assert.ok(!f.control('field.checksum.polynomial'));
    f.change('field.checksum.type','xor');assert.equal(f.control('field.checksum.invertResult').checked,true);
    assert.equal(named(f.view.draft,'check').checksum.init,16);
});

test('field actions omit movement buttons and keep the template in a separate bottom dock', () => {
    const f=fixture();f.view.open();f.view.selectLeft('edit');
    assert.ok(!f.action('field-up'),'field-up removed');assert.ok(!f.action('field-down'),'field-down removed');
    const button=f.action('add-robomaster-template'),footer=button.closest('.protocol-template-footer');
    assert.ok(footer);assert.ok(!button.closest('.protocol-edit-actions'),'template outside scrolling actions');
    assert.equal(footer.parentNode,f.view.libraryPanel);assert.equal(f.view.libraryPanel.children.at(-1),footer);
    assert.equal(f.view.libraryHost.parentNode,f.view.libraryPanel);
    f.view.libraryHost.scrollTop=100;assert.equal(f.action('add-robomaster-template').parentNode,footer);
    f.view.selectLeft('outline');assert.equal(f.view.libraryPanel.hidden,true);
    f.view.selectLeft('edit');assert.equal(f.view.libraryPanel.hidden,false);
});

test('new child field explains disabled states and only inserts inside a supported container', () => {
    const f=fixture();f.view.open();f.view._selectField(named(f.view.draft,'value'));
    assert.equal(f.action('new-child-field').disabled,true);assert.match(f.action('new-child-field').title,/结构体|分支/);
    f.view._addField('struct');assert.equal(f.action('new-child-field').disabled,false);
    const container=f.view.selectedField;f.action('new-child-field').click();
    assert.equal(container.fields.length,1);assert.equal(f.view.selectedField,container.fields[0]);
    f.view.open({id:'empty-choice',schemaVersion:3,messages:[{id:'frame',byteLength:0,fields:[
        {id:'choice',name:'choice',type:'choice',byteLength:0,lengthFrom:'contents',selector:'0',branches:[]}
    ]}]});
    assert.equal(f.action('new-child-field').disabled,true);assert.match(f.action('new-child-field').title,/先.*分支/);
});

test('editor translates validation errors in the banner, field details and issue list', () => {
    const f=fixture();f.view.open({id:'invalid-width',schemaVersion:3,messages:[{id:'frame',byteLength:1,fields:[
        {id:'bad',name:'payload',type:'float32',byteLength:1}
    ]}]});
    assert.match(f.view.alert.textContent,/字节数/);
    assert.doesNotMatch(f.view.alert.textContent,/Byte length/);
    assert.match(f.view.validationError.message,/Byte length/);
    assert.equal(f.view.validationError.nodeId,'bad');
    assert.match(f.root.querySelector('.protocol-field-error').textContent,/字节数/);
    assert.match(f.view.bottomPanels.get('issues').textContent,/payload/);
    assert.doesNotMatch(f.view.bottomPanels.get('issues').textContent,/Byte length/);
});

test('editor translates preview warnings, rule details, sample results and JSON syntax errors', () => {
    const f=fixture();f.view.open();f.view.previewBytes=new Uint8Array(1);
    f.view.previewRecord={messageId:'test',flatFields:[],warnings:[{message:'Truncated payload'}],
        ruleResults:[{ruleId:'rule',name:'长度验证',stage:'validation',strength:'weak',status:'not-run',message:'Division by zero'}]};
    f.view._renderPreviewResults();assert.match(f.view.previewHost.textContent,/数据不完整：payload/);
    assert.match(f.view.previewHost.textContent,/除数不能为零/);
    f.view.sampleResults=[{name:'样例',ok:false,message:'Invalid frame footer'}];f.view._renderSampleResults();
    assert.match(f.view.sampleResultsHost.textContent,/帧尾/);assert.doesNotMatch(f.view.sampleResultsHost.textContent,/Invalid frame footer/);
    f.change('schema-json','{','input');assert.match(f.view.alert.textContent,/JSON 格式错误/);
});

test('outline is a folder tree with persistent collapse and temporary search expansion', () => {
    let state;const f=fixture({onEditorState:value=>{state=value;}});
    f.view.open({id:'tree-navigation',schemaVersion:3,messages:[{id:'frame',byteLength:2,fields:[
        {id:'group',name:'group',type:'struct',byteLength:2,fields:[{id:'v',name:'value',type:'uint16',byteLength:2}]}
    ]}]});
    assert.equal(f.view.leftTab,'outline');
    const before=JSON.stringify(f.view.draft);
    const toggle=()=>f.root.querySelector('[data-outline-toggle="group"]');
    toggle().click();assert.equal(f.root.querySelector('[data-outline-node="group"]').getAttribute('aria-expanded'),'false');
    f.change('outline-search','value','input');assert.ok(f.root.querySelector('[data-outline-id="v"]'));
    f.change('outline-search','','input');assert.equal(f.root.querySelector('[data-outline-node="group"]').getAttribute('aria-expanded'),'false');
    f.view._selectField(named(f.view.draft,'value'));assert.equal(f.root.querySelector('[data-outline-node="group"]').getAttribute('aria-expanded'),'true');
    assert.equal(JSON.stringify(f.view.draft),before);assert.ok(state.navigation['tree-navigation']);
});

test('editor restores per-protocol navigation tabs and their scroll positions on reopen', () => {
    let state={};const f=fixture({getEditorState:()=>state,onEditorState:value=>{state=value;}});
    f.view.open();f.view.selectLeft('edit');f.view.selectProperty('advanced');
    f.view.libraryHost.scrollTop=83;f.view.libraryHost.dispatchEvent({type:'scroll'});
    f.view.propertyScroll.scrollTop=57;f.view.propertyScroll.dispatchEvent({type:'scroll'});
    f.view.close();f.view.libraryHost.scrollTop=0;f.view.propertyScroll.scrollTop=0;f.view.open();
    assert.equal(f.view.leftTab,'edit');assert.equal(f.view.propertyTab,'advanced');
    assert.equal(f.view.libraryHost.scrollTop,83);assert.equal(f.view.propertyScroll.scrollTop,57);
});

test('protocol actions share the left editing tab and the field name stays above property tabs', () => {
    const f=fixture();f.view.open();
    const leftTabs=f.root.querySelectorAll('[data-left-tab]');
    assert.deepEqual(leftTabs.map(node=>node.textContent),['结构大纲','协议与字段编辑']);
    assert.ok(f.action('new-protocol').closest('.protocol-editor-components'));
    assert.equal(f.action('new-protocol').textContent,'新建协议');
    assert.ok(f.action('new-field').closest('.protocol-editor-components'));
    assert.equal(f.root.querySelector('.protocol-component'),null);
    assert.ok(f.control('field.name').closest('.protocol-property-name'));
    assert.deepEqual(f.root.querySelectorAll('[data-property-tab]').map(node=>node.textContent),['基础设置','高级设置','关联信息']);
    assert.ok(f.control('field.count').closest('[data-property-panel="basic"]'));
    assert.ok(f.control('field.type').closest('[data-property-panel="basic"]'));
    f.view.framingSelected=true; f.view.selectedField=null; f.view._renderMessages();
    assert.ok(f.control('protocol.id').closest('[data-property-panel="advanced"]'));
    assert.ok(f.action('protocol-up').closest('.protocol-edit-actions'));
});

test('imported defaults require deletion confirmation even when identical to a fresh protocol', () => {
    const f=fixture();f.view.open();f.action('new-protocol').click();
    f.view.importJson(f.view.exportJson());
    f.action('delete-protocol').click();
    assert.equal(f.view.deleteDialog.open,true);
    f.action('cancel-delete').click();
    f.view._selectField(f.view.draft.messages[0].fields[0]);f.action('delete-field').click();
    assert.equal(f.view.deleteDialog.open,true);
});

test('branch and bit-field deletion confirm before removing saved child data and remain undoable', () => {
    const f=fixture();f.view.open(branchingSchema());f.view._selectField(named(f.view.draft,'payload'));
    const before=JSON.stringify(f.view.draft),count=named(f.view.draft,'payload').branches.length;f.action('branch-0-delete').click();
    assert.equal(f.view.deleteDialog.open,true);assert.equal(JSON.stringify(f.view.draft),before);
    f.action('confirm-delete').click();assert.equal(named(f.view.draft,'payload').branches.length,count-1);
    f.action('undo').click();assert.equal(JSON.stringify(f.view.draft),before);
    f.view.open({id:'delete-bits',schemaVersion:3,messages:[{id:'frame',byteLength:1,fields:[
        {id:'flags',name:'flags',type:'bitfield',byteLength:1,bits:[{id:'bit-a',name:'a',offset:0,length:8,type:'uint'}]}
    ]}]});
    f.action('delete-bit-0').click();assert.equal(f.view.deleteDialog.open,true);
    assert.equal(named(f.view.draft,'flags').bits.length,1);f.action('confirm-delete').click();
    assert.equal(named(f.view.draft,'flags').bits.length,0);
});

test('editing JSON and then restoring its text does not restore the pristine deletion exemption', () => {
    const f=fixture();f.view.open();f.action('new-field').click();const id=f.view.selectedField.id;
    const original=JSON.parse(f.view.exportJson()),edited=JSON.parse(JSON.stringify(original));
    ProtocolModel.findField(edited,id).name='renamed';
    f.change('schema-json',JSON.stringify(edited),'input');f.change('schema-json',JSON.stringify(original),'input');
    f.view._selectField(ProtocolModel.findField(f.view.draft,id));f.action('delete-field').click();
    assert.equal(f.view.deleteDialog.open,true);
});

test('TLV header selection edits the selected header field without changing a different field', () => {
    const f=fixture();f.view.open(ProtocolModel.createTLVTemplate());
    const first=JSON.stringify(f.view.draft.messages[0].fields[0]);
    f.root.querySelector('[data-outline-id="tlv-tag"]').click();
    assert.equal(f.view.selectedField.id,'tlv-tag');assert.equal(f.control('field.name').value,'tag');
    f.change('field.name','record_tag');
    assert.equal(ProtocolModel.findField(f.view.draft,'tlv-tag').name,'record_tag');
    assert.equal(ProtocolModel.findField(f.view.draft,'tlv-items').selector,'record_tag');
    assert.equal(JSON.stringify(f.view.draft.messages[0].fields[0]),first);
});

test('RoboMaster outline and property navigation preserve every field identity and rule', () => {
    const f=fixture(),schema=require('../robomasterProtocol').RoboMasterProtocol.createSchema();f.view.open(schema);
    const before=JSON.stringify(f.view.draft);
    for(const name of ['header','data_length','payload','checksum_0']){
        f.view._selectField(named(f.view.draft,name));
        for(const tab of ['advanced','relations','basic']) f.view.selectProperty(tab);
    }
    assert.equal(JSON.stringify(f.view.draft),before);
    const sync=named(schema,'SOF');
    assert.equal(sync?.contentConstraint,'fixed');
});

test('existing field deletion is confirmed in the modal and preserves referenced IDs on cancel and undo', () => {
    const f=fixture();f.view.open();const field=named(f.view.draft,'value');f.view._selectField(field);
    const before=JSON.stringify(f.view.draft);f.action('delete-field').click();
    assert.equal(JSON.stringify(f.view.draft),before);assert.equal(f.view.deleteDialog.open,true);
    f.action('cancel-delete').click();assert.equal(JSON.stringify(f.view.draft),before);
    f.action('delete-field').click();f.action('confirm-delete').click();
    assert.equal(ProtocolModel.findField(f.view.draft,field.id),null);
    f.action('undo').click();assert.equal(JSON.stringify(f.view.draft),before);
});

test('fresh untouched fields delete immediately while edited or copied fields require confirmation', () => {
    const f=fixture();f.view.open();f.action('new-field').click();const id=f.view.selectedField.id;
    f.action('delete-field').click();assert.equal(Boolean(f.view.deleteDialog.open),false);assert.equal(ProtocolModel.findField(f.view.draft,id),null);
    f.action('new-field').click();f.change('field.name','edited_new');f.action('delete-field').click();
    assert.equal(f.view.deleteDialog.open,true);f.action('cancel-delete').click();
    f.action('copy-field').click();f.action('delete-field').click();assert.equal(f.view.deleteDialog.open,true);
});

function constraint(f, kind) {
    f.change('field.role', kind);
    f.action('confirm-content-constraint')?.click();
}

test('RoboMaster field constraints edit their shared length and checksum rules in place', () => {
    const f = fixture(); f.view.open(require('../robomasterProtocol').RoboMasterProtocol.createSchema());
    f.view._selectField(named(f.view.draft, 'data_length'));
    assert.equal(f.control('field.role').value, 'length');
    assert.deepEqual(f.control('field.role').children.map(option => option.value), ['data','fixed','length','checksum']);
    assert.ok(f.control('length.value').closest('.protocol-content-constraints'));
    assert.equal(f.control('field.checksum.enabled'), null);
    f.view._selectField(named(f.view.draft, 'checksum_0'));
    assert.equal(f.control('field.role').value, 'checksum');
    assert.ok(f.control('field.checksum.type').closest('.protocol-content-constraints'));
    f.change('field.checksum.init', '123');
    const rule = f.view.draft.rules.find(rule => rule.targetFieldId === f.view.selectedField.id);
    assert.equal(rule.checksum.init, 123);
    f.view._openRule(rule.id); assert.equal(f.control('rule.checksum.init').value, '123');
});

test('changing a primary constraint requires confirmation and retains disabled rules and stable references', () => {
    const f = fixture(); f.view.open({id:'constraint-switch',schemaVersion:3,messages:[{id:'frame',byteLength:2,fields:[
        {id:'a',name:'size',type:'uint8',byteLength:1},{id:'b',name:'value',type:'uint8',byteLength:1}
    ]}]});
    f.view._selectField(named(f.view.draft,'size')); constraint(f,'length');
    f.change('length.value','LEN(value)');
    const rule = f.view.draft.rules.find(rule => rule.targetFieldId === 'a');
    f.change('field.role','checksum');
    assert.equal(rule.enabled,true); assert.ok(f.action('confirm-content-constraint'));
    f.action('cancel-content-constraint').click(); assert.equal(f.control('field.role').value,'length');
    constraint(f,'checksum');
    assert.equal(f.view.draft.rules.find(item => item.id === rule.id).enabled,false);
    assert.equal(f.view.selectedField.id,'a'); assert.equal(f.control('field.role').value,'checksum');
    f.action('undo').click(); assert.equal(f.control('field.role').value,'length');
    assert.equal(f.view.draft.rules.find(item => item.id === rule.id).enabled,true);
});

test('checksum start and end inclusion independently select actual covered bytes in both rule editors', () => {
    const s={id:'coverage-options',schemaVersion:3,messages:[{id:'frame',byteLength:4,fields:[
        {id:'a',name:'a',type:'uint8',byteLength:1},{id:'b',name:'b',type:'uint8',byteLength:1},
        {id:'c',name:'c',type:'uint8',byteLength:1},{id:'sum',name:'sum',type:'uint8',byteLength:1}
    ]}],rules:[{id:'sum-rule',type:'checksum',targetFieldId:'sum',send:'fill',checksum:{type:'sum',
        start:{fieldId:'a',edge:'start'},end:{fieldId:'c',edge:'end'}}}]};
    const f=fixture();f.view.open(s);f.view._selectField(named(f.view.draft,'sum'));
    for(const [start,end,expected] of [[true,true,7],[true,false,3],[false,true,6],[false,false,2]]) {
        f.change('field.checksum.start.include',start);f.change('field.checksum.end.include',end);
        const rule=f.view.draft.rules[0];
        assert.equal(rule.checksum.start.edge,start?'start':'end');assert.equal(rule.checksum.end.edge,end?'end':'start');
        const wire=Protocol.encode(f.view.draft,'frame',{a:1,b:2,c:4});assert.equal(wire[3],expected);
        assert.equal(Protocol.decode(wire,f.view.draft).valid,true);
    }
    f.view._openRule('sum-rule');assert.equal(f.control('rule.checksum.start.include').checked,false);
    f.change('rule.checksum.start.include',true);f.change('rule.checksum.end.include',true);
    f.view.selectTab('messages');f.view._selectField(named(f.view.draft,'sum'));
    assert.equal(f.control('field.checksum.start.include').checked,true);assert.equal(f.control('field.checksum.end.include').checked,true);
});

test('legacy combined constraints stay unchanged until explicitly choosing one and retain its fixed bytes', () => {
    const f=fixture();f.view.open({id:'legacy-combination',schemaVersion:3,messages:[{id:'frame',byteLength:2,fields:[
        {id:'size',name:'size',type:'uint8',byteLength:1,expectedBytes:[1]},
        {id:'body',name:'body',type:'uint8',byteLength:1}
    ]}],rules:[{id:'length-check',type:'length',targetFieldId:'size',boundaryFallback:false,value:'LEN(body)',expression:'size == LEN(body)',send:'verify'}]});
    f.view._selectField(named(f.view.draft,'size'));const before=JSON.stringify(f.view.draft);
    assert.equal(f.control('field.role').value,'legacy');assert.equal(JSON.stringify(f.view.draft),before);
    constraint(f,'fixed');assert.deepEqual(f.view.selectedField.expectedBytes,[1]);
    assert.equal(f.view.draft.rules[0].enabled,false);
    assert.deepEqual([...Protocol.encode(f.view.draft,'frame',{body:3})],[1,3]);
});

test('deleting a rule removes its field constraint instead of retaining a stale template marker', () => {
    const f=fixture();f.view.open(require('../robomasterProtocol').RoboMasterProtocol.createSchema());
    const checksum=named(f.view.draft,'checksum_0');f.view.draft.rules=f.view.draft.rules.filter(rule=>rule.targetFieldId!==checksum.id);
    f.view._render();f.view._selectField(checksum);assert.equal(f.control('field.role').value,'data');
});

test('existing RoboMaster drafts can explicitly load the newest template and undo the replacement', () => {
    const old=require('../robomasterProtocol').RoboMasterProtocol.createSchema();old.name='我编辑的模板';
    delete named(old,'data_length').contentConstraint;
    const f=fixture({getProtocols:()=>[old]});f.view.open(old);
    f.action('add-robomaster-template').click();assert.equal(f.view.draft.name,'我编辑的模板');
    assert.ok(f.action('confirm-latest-template'));f.action('confirm-latest-template').click();
    assert.equal(named(f.view.draft,'data_length').contentConstraint,'length');
    assert.equal(f.applied.length,0,'template replacement remains a draft');
    f.action('undo').click();assert.equal(f.view.draft.name,'我编辑的模板');
    assert.equal(named(f.view.draft,'data_length').contentConstraint,undefined);
});

test('choosing length from a legacy combination retains the existing segment length binding', () => {
    const f=fixture();f.view.open({id:'legacy-length-choice',schemaVersion:3,messages:[{id:'frame',byteLength:0,fields:[
        {id:'size',name:'size',type:'uint8',byteLength:1},
        {id:'body',name:'body',type:'bytes',byteLength:0,lengthSource:{fieldId:'size',unit:1,adjustment:0}}
    ]}],rules:[{id:'extra-check',type:'checksum',targetFieldId:'size',send:'verify',checksum:{type:'sum',
        start:{fieldId:'body',edge:'start'},end:{fieldId:'body',edge:'end'}}}]});
    f.view._selectField(named(f.view.draft,'size'));assert.equal(f.control('field.role').value,'legacy');
    const binding=structuredClone(named(f.view.draft,'body').lengthSource);constraint(f,'length');
    assert.deepEqual(named(f.view.draft,'body').lengthSource,binding);
    assert.equal(f.view.draft.rules[0].enabled,false);assert.equal(f.view.applyButton.disabled,false);
    assert.deepEqual([...Protocol.encode(f.view.draft,'frame',{body:[11,12]})],[2,11,12]);
});

test('reselecting checksum restores the previous active rule instead of an earlier inactive rule', () => {
    const range={start:{fieldId:'body',edge:'start'},end:{fieldId:'body',edge:'end'}};
    const f=fixture();f.view.open({id:'restore-checksum-rule',schemaVersion:3,messages:[{id:'frame',byteLength:3,fields:[
        {id:'body',name:'body',type:'bytes',byteLength:2},{id:'sum',name:'sum',type:'uint8',byteLength:1}
    ]}],rules:[{id:'old-xor',type:'checksum',targetFieldId:'sum',send:'fill',enabled:false,checksum:{type:'xor',...range}},
        {id:'active-sum',type:'checksum',targetFieldId:'sum',send:'fill',enabled:true,checksum:{type:'sum',...range}}]});
    f.view._selectField(named(f.view.draft,'sum'));
    const before=Protocol.encode(f.view.draft,'frame',{body:[1,3]});assert.equal(before[2],4);
    constraint(f,'data');constraint(f,'checksum');
    assert.equal(f.view.draft.rules.find(rule=>rule.id==='active-sum').enabled,true);
    assert.equal(f.view.draft.rules.find(rule=>rule.id==='old-xor').enabled,false);
    assert.deepEqual(Protocol.encode(f.view.draft,'frame',{body:[1,3]}),before);
});

test('changing content constraints preserves an enum data type and its labels', () => {
    const f=fixture();f.view.open({id:'enum-constraint',schemaVersion:3,messages:[{id:'frame',byteLength:1,fields:[
        {id:'mode',name:'mode',type:'enum',baseType:'uint8',byteLength:1,enum:{0:'关闭',1:'开启'}}
    ]}]});
    constraint(f,'fixed');assert.equal(f.view.selectedField.type,'enum');
    constraint(f,'data');assert.equal(f.view.selectedField.type,'enum');
    assert.equal(Protocol.decode([1],f.view.draft).flatFields[0].label,'开启');
});

test('three editor columns contain the central editing and verification split', () => {
    const f = fixture(); f.view.open();
    const column = f.root.querySelector('.protocol-editor-center-column');
    assert.ok(column);
    assert.equal(column.parentNode, f.view.workspace);
    assert.equal(f.view.bottom.parentNode, column);
    assert.equal(f.root.querySelector('.protocol-splitter-bottom').parentNode, column);
    assert.equal(f.view.leftHost.parentNode, f.view.workspace);
    assert.equal(f.view.propertyHost.parentNode, f.view.workspace);
    assert.equal(f.view.body.closest('.protocol-editor-center-column'), column);
});

test('diagnostics identify and activate the nested field instead of showing only an error message', () => {
    const f = fixture(); f.view.open({id:'diagnostic-fields',schemaVersion:3,messages:[{id:'frame',byteLength:1,fields:[
        {id:'packet',name:'packet',type:'struct',byteLength:1,fields:[{id:'packet.value',name:'value',type:'uint8',byteLength:1}]}
    ]}]});
    const field = ProtocolModel.findField(f.view.draft, 'packet.value');
    field.type = 'bad-type'; f.view._render();
    const issue = f.root.querySelector('.protocol-diagnostic');
    assert.ok(issue); assert.match(issue.textContent, /packet\.value/);
    issue.click(); assert.equal(f.view.selectedField.id, 'packet.value');
    assert.equal(f.view.activeTab, 'messages');
    assert.equal(f.view.framingSelected, false);
});

test('rule diagnostics show their target field and navigate to the rule properties', () => {
    const f = fixture();
    f.view.open({id:'diagnostic-rules',schemaVersion:3,messages:[{id:'frame',byteLength:1,fields:[
        {id:'size',name:'data_length',type:'uint8',byteLength:1}
    ]}],rules:[{id:'invalid-length',name:'长度检查',type:'length',targetFieldId:'size',send:'fill',expression:'TRUE',value:''}]});
    const issue = f.root.querySelector('.protocol-diagnostic');
    assert.match(issue.textContent, /规则：长度检查/); assert.match(issue.textContent, /字段：data_length/);
    issue.click(); assert.equal(f.view.activeTab, 'rules'); assert.equal(f.view.selectedRuleId, 'invalid-length');
    assert.ok(f.control('rule.value'));
});

test('length field edits a shared value equation with explicit boundary fallback and stable references', () => {
    const f = fixture(); f.view.open(require('../robomasterProtocol').RoboMasterProtocol.createSchema());
    f.view._selectField(named(f.view.draft, 'data_length'));
    assert.equal(f.control('length.value').value, 'LEN(payload)');
    assert.equal(f.control('length.usage').value, 'boundary');
    assert.equal(f.control('length.0.unit'), null);
    f.change('length.value', 'LEN(payload) + 2');
    const rule = f.view.draft.rules.find(rule => rule.type === 'length');
    assert.equal(rule.value, 'LEN(payload) + 2');
    assert.equal(rule.expression, 'header.data_length == (LEN(payload) + 2)');
    assert.equal(f.view.applyButton.disabled, false);
    f.action('jump-length-rule').click(); assert.equal(f.view.activeTab, 'rules');
    assert.equal(f.control('rule.boundaryFallback').value, 'boundary');
    f.change('rule.value', 'LEN(payload) + LEN(checksum_0)');
    f.view.selectTab('messages'); f.view._selectField(named(f.view.draft, 'data_length'));
    assert.equal(f.control('length.value').value, 'LEN(payload) + LEN(checksum_0)');
    f.change('length.usage', 'verify');
    assert.equal(rule.boundaryFallback, false);
    assert.equal(f.view.applyButton.disabled, true, 'unresolved branches must request a boundary instead of guessing');
});

test('card descriptions and blank areas select their own field without selecting ancestors', () => {
    const f = fixture(); f.view.open(branchingSchema());
    const card = id => f.root.querySelector(`[data-field-id="${id}"]`);
    card('a.value').querySelector('.protocol-field-meta-line').click();
    assert.equal(f.view.selectedField.id, 'a.value');
    card('payload').querySelector('.protocol-field-meta').click();
    assert.equal(f.view.selectedField.id, 'payload');
    card('b.value').click(); assert.equal(f.view.selectedField.id, 'b.value');
    f.root.querySelector('[data-branch-id="a"]').querySelector('.protocol-branch-title').click();
    assert.equal(f.root.querySelector('.protocol-property-name').querySelector('input').value,'第一个较长名称的条件分支');
    assert.ok(!f.control('field.type'),'a branch heading opens its own inspector');
    f.root.querySelector('[data-frame-root]').click(); assert.equal(f.view.framingSelected, true);
    card('a.value').click(); assert.equal(f.view.selectedField.id, 'a.value');
    assert.equal(f.view.framingSelected, false);
    assert.equal(f.view.history.length, 0, 'navigation does not modify the protocol');
});

test('branch cards open an independent inspector and edits retain branch and child identities', () => {
    const f=fixture();f.view.open(branchingSchema());
    const before=JSON.stringify(f.view.draft);
    f.root.querySelector('[data-branch-id="a"]').querySelector('.protocol-branch-rule').click();
    assert.equal(f.view.propertyHost.querySelectorAll('[data-property-branch]').length,1);
    assert.equal(f.view.propertyHost.querySelector('[data-property-branch]').getAttribute('data-property-branch'),'a');
    assert.ok(f.control('branch.0.label').closest('.protocol-property-name'));
    assert.ok(!f.control('field.type'));assert.equal(JSON.stringify(f.view.draft),before);
    assert.equal(f.root.querySelector('[data-branch-id="a"]').classList.contains('is-selected'),true);
    assert.equal(f.root.querySelector('[data-field-id="payload"]').classList.contains('is-selected'),false);
    f.change('branch.0.label','选手端删除图层');f.change('branch.0.equals','3');
    const branch=ProtocolModel.findNode(f.view.draft,'a');
    assert.equal(branch.label,'选手端删除图层');assert.equal(branch.equals,3);assert.equal(branch.fields[0].id,'a.value');
    assert.equal(ProtocolModel.findNode(f.view.draft,'b').equals,2);
    assert.equal(Protocol.decode([3,1,2],f.view.draft).fields.payload.value,513);
    f.action('undo').click();assert.equal(f.control('branch.0.equals').value,'1');
    f.action('open-branch-parent').click();assert.ok(f.control('field.selector'));
    assert.equal(f.view.propertyHost.querySelectorAll('[data-property-branch]').length,3);
});

test('outline and keyboard branch selection agree and child clicks select only the child', () => {
    const f=fixture();f.view.open(branchingSchema());
    f.root.querySelector('[data-outline-id="b"]').click();
    assert.ok(f.control('branch.1.mode'));assert.ok(!f.control('branch.0.mode'));
    const branch=f.root.querySelector('[data-branch-id="a"]');
    branch.dispatchEvent({type:'keydown',key:'Enter',bubbles:true});
    assert.ok(f.control('branch.0.mode'));assert.ok(!f.control('branch.1.mode'));
    f.root.querySelector('[data-field-id="b.value"]').querySelector('.protocol-field-meta').click();
    assert.equal(f.control('field.name').value,'value');assert.ok(!f.control('branch.0.mode'));
    f.root.querySelector('[data-branch-id="b"]').querySelector('.protocol-branch-fields').click();
    assert.ok(f.control('branch.1.mode'));assert.ok(!f.control('field.name'));
});

test('selected branch survives sorting and deletion confirmation targets the branch rather than its parent', () => {
    const f=fixture();f.view.open(branchingSchema());
    f.root.querySelector('[data-branch-id="a"]').click();
    f.view.propertyHost.querySelector('[data-branch-drag="a"]').dispatchEvent({type:'keydown',key:'ArrowDown',altKey:true,bubbles:true});
    assert.equal(ProtocolModel.findField(f.view.draft,'payload').branches[1].id,'a');
    assert.ok(f.control('branch.1.label'));assert.ok(!f.control('branch.0.label'));
    f.action('delete-branch').click();assert.equal(f.view.deleteDialog.open,true);
    assert.match(f.view.deleteMessage.textContent,/分支.*第一个/);
    f.action('confirm-delete').click();
    assert.ok(ProtocolModel.findField(f.view.draft,'payload'));assert.ok(!ProtocolModel.findNode(f.view.draft,'a'));
    assert.ok(ProtocolModel.findNode(f.view.draft,'b'));assert.ok(f.control('field.selector'));
    f.action('undo').click();assert.ok(ProtocolModel.findNode(f.view.draft,'a'));
});

test('optional conditions and offset origins explain their effect next to the advanced controls', () => {
    const f=fixture();f.view.open();f.view.selectProperty('advanced');
    for(const key of ['field.condition','field.offsetBase']){
        const control=f.control(key),id=control.getAttribute('aria-describedby');assert.ok(id,key);
        const help=f.root.querySelector(`[id="${id}"]`);assert.ok(help);assert.ok(control.parentNode.contains(help));
        assert.match(help.textContent,key==='field.condition'?/不消耗.*字节/:/从 0.*偏移.*留空/);
    }
});

test('nested RoboMaster branch selection does not activate its outer command or mutate the template', () => {
    const {RoboMasterProtocol}=require('../robomasterProtocol'),f=fixture();f.view.open(RoboMasterProtocol.compiled.schema);
    const before=JSON.stringify(f.view.draft);
    const owner=ProtocolModel.flattenFields(f.view.draft).find(row=>row.field.name==='subcommands').field;
    const branch=owner.branches.find(item=>item.equals===0x100),index=owner.branches.indexOf(branch);assert.ok(branch);
    f.root.querySelector(`[data-branch-id="${branch.id}"]`).querySelector('.protocol-branch-title').click();
    assert.equal(f.view.propertyHost.querySelectorAll('[data-property-branch]').length,1);
    assert.equal(f.control(`branch.${index}.label`).value,branch.label);
    assert.equal(Number(f.control(`branch.${index}.equals`).value),256);
    assert.equal(JSON.stringify(f.view.draft),before);
    f.root.querySelector(`[data-field-id="${branch.fields[0].id}"]`).querySelector('.protocol-field-meta').click();
    assert.equal(f.control('field.name').value,branch.fields[0].name);
    assert.ok(!f.control(`branch.${index}.mode`));
});

test('RoboMaster branch clicks retain focus on the branch instead of jumping to payload', () => {
    const {RoboMasterProtocol}=require('../robomasterProtocol'),f=fixture();f.view.open(RoboMasterProtocol.compiled.schema);
    // Model the browser's default focus scrolling, absent from the lightweight DOM fixture.
    const create=f.document.createElement;
    f.document.createElement=tag=>{
        const node=create(tag),focus=node.focus.bind(node);
        node.focus=options=>{focus();if(!options?.preventScroll)f.view.body.scrollTop=0;};
        return node;
    };
    const payload=ProtocolModel.flattenFields(f.view.draft).find(row=>row.field.name==='payload').field;
    const branch=payload.branches[0],before=JSON.stringify(f.view.draft);
    const group=f.root.querySelector(`[data-branch-id="${branch.id}"]`);
    group.focus();f.view.body.scrollTop=360;
    group.querySelector('.protocol-branch-title').click();
    assert.equal(f.document.activeElement?.getAttribute('data-branch-id'),branch.id);
    assert.equal(f.view.body.scrollTop,360);
    assert.equal(f.view.propertyHost.querySelector('[data-property-branch]').getAttribute('data-property-branch'),branch.id);
    assert.equal(f.root.querySelector(`[data-field-id="${payload.id}"]`).classList.contains('is-selected'),false);
    assert.equal(JSON.stringify(f.view.draft),before);
    f.view._renderMessages();
    assert.equal(f.document.activeElement?.getAttribute('data-branch-id'),branch.id,'subsequent redraws keep branch focus');
});

test('navigating to another card description restores focus to that field rather than the previous card', () => {
    const f=fixture();f.view.open(branchingSchema());
    f.root.querySelector('[data-field-id="tag"]').querySelector('.protocol-field-select').focus();
    f.root.querySelector('[data-field-id="b.value"]').querySelector('.protocol-field-meta').click();
    assert.equal(f.document.activeElement?.closest('[data-field-id]')?.getAttribute('data-field-id'),'b.value');
    assert.equal(f.view.selectedField.id,'b.value');
});

test('property edits and undo redo preserve inspector scroll and text caret without native focus scrolling', () => {
    const f=fixture();simulateFocusScrolling(f);f.view.open(branchingSchema());f.view._selectField(named(f.view.draft,'payload'));
    const input=f.control('field.selector');input.focus();input.setSelectionRange(1,2);
    f.view.propertyScroll.scrollTop=120;f.view.body.scrollTop=200;f.view.outlineHost.scrollTop=45;
    f.change('field.endian','big');
    for(const action of [null,'undo','redo']){
        if(action)f.action(action).click();
        assert.equal(f.view.propertyScroll.scrollTop,120,action||'edit');assert.equal(f.view.body.scrollTop,200);
        assert.equal(f.view.outlineHost.scrollTop,45);assert.equal(f.document.activeElement?.getAttribute('data-control'),'field.selector');
        assert.equal(f.document.activeElement.selectionStart,1);assert.equal(f.document.activeElement.selectionEnd,2);
    }
});

test('branch input focus follows its stable identity through reorder undo and redo', () => {
    for(const standalone of [false,true]){
        const f=fixture();simulateFocusScrolling(f);f.view.open(branchingSchema());
        if(standalone)f.root.querySelector('[data-branch-id="a"]').click();else f.view._selectField(named(f.view.draft,'payload'));
        f.control('branch.0.label').focus();f.view.propertyScroll.scrollTop=90;f.view.body.scrollTop=220;
        f.view._reorderBranch(named(f.view.draft,'payload'),ProtocolModel.findNode(f.view.draft,'a'),1);
        assert.equal(f.document.activeElement?.getAttribute('data-control'),'branch.1.label');
        assert.equal(f.document.activeElement.value,'第一个较长名称的条件分支');assert.equal(f.view.propertyScroll.scrollTop,90);
        f.action('undo').click();assert.equal(f.document.activeElement?.getAttribute('data-control'),'branch.0.label');
        f.action('redo').click();assert.equal(f.document.activeElement?.getAttribute('data-control'),'branch.1.label');
        assert.equal(f.view.body.scrollTop,220);assert.equal(f.view.propertyScroll.scrollTop,90);
    }
});

test('field drag handles retain focus and canvas scroll through sorting undo and redo', () => {
    const f=fixture();simulateFocusScrolling(f);f.view.open({id:'drag-focus',schemaVersion:3,messages:[{id:'frame',byteLength:2,fields:[
        {id:'first',name:'first',type:'uint8',byteLength:1},{id:'second',name:'second',type:'uint8',byteLength:1}
    ]}]});
    const handle=f.root.querySelector('[data-drag-id="first"]');handle.focus();f.view.body.scrollTop=150;
    handle.dispatchEvent({type:'dragstart',bubbles:true,dataTransfer:{setData(){}}});
    const target=f.root.querySelector('[data-field-id="second"]');target.getBoundingClientRect=()=>({left:0,right:100,top:0,bottom:100,width:100,height:100});
    target.dispatchEvent({type:'dragover',bubbles:true,clientX:90,clientY:90});target.dispatchEvent({type:'drop',bubbles:true});
    for(const action of [null,'undo','redo']){
        if(action)f.action(action).click();
        assert.equal(f.document.activeElement?.getAttribute('data-drag-id'),'first',action||'drop');
        assert.equal(f.view.body.scrollTop,150);
    }
});

test('undoing a newly inserted nested field selects its surviving parent rather than the first frame field', () => {
    const f=fixture();f.view.open({id:'undo-parent',schemaVersion:3,messages:[{id:'frame',byteLength:0,fields:[
        {id:'tag',name:'tag',type:'uint8',byteLength:1},
        {id:'group',name:'group',type:'struct',byteLength:0,lengthFrom:'contents',fields:[]}
    ]}]});
    f.view._addField('uint8',named(f.view.draft,'group'));
    f.root.querySelector(`[data-field-id="${f.view.selectedField.id}"]`).querySelector('.protocol-field-select').focus();
    f.view.body.scrollTop=175;f.action('undo').click();
    assert.equal(f.view.selectedField.id,'group');assert.equal(f.view.body.scrollTop,175);
    assert.equal(f.document.activeElement?.closest('[data-field-id]')?.getAttribute('data-field-id'),'group');
});

test('undo and redo toolbar focus survives button replacement and moves to the enabled counterpart',()=>{
    const f=fixture();simulateFocusScrolling(f);f.view.open(branchingSchema());
    f.view._selectField(named(f.view.draft,'tag'));f.change('field.endian','big');f.change('field.endian','little');
    f.action('undo').focus();f.view.body.scrollTop=205;f.view.libraryHost.scrollTop=75;f.action('undo').click();
    assert.equal(f.document.activeElement?.getAttribute('data-action'),'undo');
    assert.ok(f.root.contains(f.document.activeElement));
    f.action('undo').click();assert.equal(f.document.activeElement?.getAttribute('data-action'),'redo');
    f.action('redo').click();f.action('redo').click();assert.equal(f.document.activeElement?.getAttribute('data-action'),'undo');
    assert.equal(f.view.body.scrollTop,205);assert.equal(f.view.libraryHost.scrollTop,75);
});

test('data types are always complete and scalar selection fills and locks the storage width', () => {
    const f = fixture(); f.view.open(); f.root.querySelector('[data-field-path="value"]').click();
    const values = () => f.control('field.type').children.map(option => option.value);
    const all=['bitfield','uint8','int8','uint16','int16','uint32','int32','uint64','int64','float32','float64','bool',
        'bytes','reserved','string','struct','choice','tlv'];
    assert.deepEqual(values(),all);
    const id=f.view.selectedField.id;
    for(const [type,width] of [['uint8',1],['int8',1],['uint16',2],['int16',2],['uint32',4],['int32',4],
        ['uint64',8],['int64',8],['float32',4],['float64',8],['bool',1]]){
        f.change('field.type',type);assert.equal(f.view.selectedField.byteLength,width,type);
        assert.equal(f.control('field.byteLength').value,String(width));assert.equal(f.control('field.byteLength').disabled,true);
        assert.equal(f.view.selectedField.id,id);assert.deepEqual(values(),all);
    }
    f.change('field.byteLength','99');assert.equal(f.view.selectedField.byteLength,1,'locked width cannot be changed');
    f.change('field.type','bytes');assert.equal(f.control('field.byteLength').disabled,false);
    f.change('field.byteLength','0');assert.ok(f.control('field.lengthMode'));assert.deepEqual(values(),all);
    assert.equal(f.control('field.type').children.find(option => option.value === 'struct').textContent, '结构体');
});

test('all field kinds use one repetition count and cards show per-item size and count on the same line', () => {
    const f=fixture();f.view.open({id:'repeat-card',schemaVersion:3,messages:[{id:'frame',byteLength:6,fields:[
        {id:'values',name:'values',type:'uint16',byteLength:2,count:3}
    ]}]});
    assert.equal(f.control('field.count').getAttribute('aria-label'),'重复次数');
    assert.equal(f.root.querySelector('[data-field-id="values"]').querySelector('.protocol-field-size').textContent,'2 字节 · 重复 3 次');
    for(const type of ['uint8','bool','bytes','string','bitfield','struct','choice','tlv']){
        f.view._addField(type);
        assert.equal(f.root.querySelectorAll('[data-control="field.count"]').length,1,type);
        assert.equal(f.control('field.count').getAttribute('aria-label'),'重复次数');
        assert.ok(!f.control('field.type').children.some(option=>option.value==='repeat'));
    }
});

test('old repeated segments display as structures without changing their wire scope or references', () => {
    const f=fixture();f.view.open({id:'old-repeat-view',schemaVersion:3,messages:[{id:'frame',byteLength:6,fields:[
        {id:'items',name:'items',type:'repeat',byteLength:6,count:3,fields:[{id:'value',name:'value',type:'uint16',byteLength:2}]}
    ]}]});
    const before=JSON.stringify(f.view.draft);
    assert.equal(f.control('field.type').value,'struct');assert.equal(f.control('field.count').value,'3');
    assert.ok(!f.control('field.repeatCount'));assert.match(f.view.propertyHost.textContent,/旧.*整个重复区域/);
    assert.equal(JSON.stringify(f.view.draft),before);
    assert.deepEqual([...Protocol.encode(f.view.draft,'frame',{items:[{value:1},{value:2},{value:3}]})],[1,0,2,0,3,0]);
});

test('new structures switch to segment-end repetition without changing their element width', () => {
    const f=fixture();f.view.open({id:'struct-to-end',schemaVersion:3,messages:[{id:'frame',byteLength:6,fields:[
        {id:'items',name:'items',type:'struct',byteLength:2,count:3,fields:[{id:'value',name:'value',type:'uint16',byteLength:2}]}
    ]}]});
    f.change('field.count','-1');assert.equal(f.view.selectedField.type,'struct');
    assert.equal(f.view.selectedField.byteLength,2);assert.equal(f.view.selectedField.until,'end');assert.equal(f.control('field.count').value,'-1');
    assert.match(f.root.querySelector('[data-field-id="items"]').querySelector('.protocol-field-size').textContent,/2 字节.*至段末/);
    assert.equal(f.view.applyButton.disabled,false);
    assert.deepEqual(Protocol.decode([1,0,2,0,3,0],f.view.draft).fields.items,[{value:1},{value:2},{value:3}]);
});

test('one count input preserves numeric and expression configurations and enables literal minus-one repetition',()=>{
    for(const count of [3,'3','item_count']){
        const f=fixture();f.view.open({id:'count-mode',schemaVersion:3,messages:[{id:'frame',byteLength:7,fields:[
            {id:'n',name:'item_count',type:'uint8',byteLength:1},
            {id:'values',name:'values',type:'uint16',byteLength:2,count}
        ]}]});f.view._selectField(named(f.view.draft,'values'));
        const before=JSON.stringify(f.view.draft);
        assert.ok(!f.control('field.repeatMode'));
        assert.equal(f.control('field.count').value,String(count));assert.equal(JSON.stringify(f.view.draft),before);
        f.change('field.count',String(count));assert.equal(named(f.view.draft,'values').count,count);
        f.change('field.count','-1');assert.equal(named(f.view.draft,'values').until,'end');
        assert.equal(f.control('field.count').value,'-1');assert.equal(named(f.view.draft,'values').id,'values');
        assert.deepEqual(Protocol.decode([3,1,0,2,0,3,0],f.view.draft).fields.values,[1,2,3]);
        const endSnapshot=JSON.stringify(f.view.draft);f.view._render();assert.equal(JSON.stringify(f.view.draft),endSnapshot);
        assert.equal(f.control('field.count').value,'-1');
        f.change('field.count','0');assert.equal(named(f.view.draft,'values').count,0);assert.equal(named(f.view.draft,'values').until,undefined);
    }
});

test('unavailable segment-end modes explain the conflicting field and never change a saved framing role',()=>{
    const f=fixture();f.view.open({id:'end-conflict',schemaVersion:3,messages:[{id:'frame',byteLength:2,fields:[
        {id:'sync',name:'sync_bytes',type:'fixed',bytes:[170],byteLength:1,framingRole:'sync'},
        {id:'tail',name:'tail',type:'uint8',byteLength:1}
    ]}]});f.view._selectField(named(f.view.draft,'sync_bytes'));
    const before=JSON.stringify(f.view.draft);
    assert.ok(!f.control('field.repeatMode'));
    assert.match(f.control('field.repeatReason').textContent,/帧头|同步/);
    assert.equal(JSON.stringify(f.view.draft),before);
    f.change('field.count','-1');assert.equal(JSON.stringify(f.view.draft),before);
    assert.equal(f.control('field.count').getAttribute('aria-invalid'),'true');
    assert.deepEqual(f.control('field.framingRole').children.map(option=>option.textContent),['仅验证固定字节','帧头','帧尾']);
    f.view.open({id:'missing-item-size',schemaVersion:3,messages:[{id:'frame',byteLength:4,fields:[{id:'data',name:'data',type:'bytes',byteLength:0}]}]});
    assert.ok(!f.control('field.repeatMode'));
    assert.match(f.control('field.repeatReason').textContent,/长度|边界/);
});

test('negative and fractional count expressions are rejected without changing field references or becoming until-end',()=>{
    const f=fixture();f.view.open({id:'count-errors',schemaVersion:3,messages:[{id:'frame',byteLength:6,fields:[
        {id:'values',name:'values',type:'uint16',byteLength:2,count:3}
    ]}]});
    const before=JSON.stringify(f.view.draft);
    for(const text of ['1 - 2','(-1)','-2','-1.0','1.5']){
        f.change('field.count',text);assert.equal(JSON.stringify(f.view.draft),before,text);
        assert.equal(f.control('field.count').getAttribute('aria-invalid'),'true',text);
        assert.match(f.control('field.repeatReason').textContent,/非负整数|负数/);
    }
    f.change('field.count','3');assert.equal(JSON.stringify(f.view.draft),before);
    assert.equal(f.control('field.repeatReason').hidden,true);
    assert.equal(f.view.alert.hidden,true);
    f.change('field.count','2 + 1');assert.equal(named(f.view.draft,'values').count,'2 + 1');
    assert.equal(f.control('field.count').getAttribute('aria-invalid'),'false');
    assert.equal(named(f.view.draft,'values').until,undefined);
});

test('non-scalar types keep editable widths and length controls while arrays retain per-element widths', () => {
    for(const type of ['bytes','reserved','string','struct','choice','repeat','tlv','bitfield']){
        const f=fixture();f.view.open();f.view._addField(type);
        assert.equal(f.control('field.byteLength').disabled,false,type);f.change('field.byteLength','3');
        assert.equal(f.view.selectedField.byteLength,3,type);
    }
    const f=fixture();f.view.open({id:'array-width',schemaVersion:3,messages:[{id:'frame',byteLength:0,fields:[
        {id:'values',name:'values',type:'uint8',byteLength:1}
    ]}]});
    assert.ok(f.control('field.count').closest('[data-property-panel="basic"]'));
    f.change('field.count','3');
    f.change('field.type','uint16');assert.equal(f.view.selectedField.count,3);
    assert.deepEqual([...Protocol.encode(f.view.draft,'frame',{values:[1,2,3]})],[1,0,2,0,3,0]);
});

test('old invalid scalar widths are preserved on open and repaired only by explicit confirmation', () => {
    const f=fixture();f.view.open({id:'old-width',schemaVersion:3,messages:[{id:'frame',byteLength:4,fields:[
        {id:'reading',name:'reading',type:'float32',byteLength:1}
    ]}]});
    assert.equal(f.view.selectedField.byteLength,1);assert.equal(f.control('field.type').value,'float32');
    assert.equal(f.control('field.byteLength').value,'4');assert.equal(f.control('field.byteLength').disabled,true);
    assert.match(f.control('field.width-conflict').textContent,/旧配置.*1.*4/);assert.equal(f.view.applyButton.disabled,true);
    assert.ok(f.action('fix-field-width'),'legacy mismatch offers an explicit repair without selecting a different type');
    f.action('fix-field-width').click();assert.equal(f.view.selectedField.byteLength,4);assert.equal(f.view.applyButton.disabled,false);
});

test('selecting TLV retains the field identity and decodes its own type and length header', () => {
    const f=fixture();f.view.open({id:'select-tlv',schemaVersion:3,messages:[{id:'frame',byteLength:3,fields:[
        {id:'items',name:'items',type:'uint8',byteLength:1}
    ]}]});
    f.change('field.type','tlv');f.change('field.byteLength','3');
    const field=f.view.selectedField;
    assert.equal(field.id,'items');assert.equal(field.name,'items');assert.equal(field.lengthField,'size');
    assert.equal(field.fields,undefined);assert.equal(field.legacyHeader,undefined);
    assert.deepEqual(field.headerFields.map(entry=>[entry.name,entry.type]),[['tag','uint8'],['size','uint8']]);
    assert.equal(f.view.applyButton.disabled,false);
    const record=Protocol.decode([1,1,7],f.view.draft);
    assert.equal(record.fields.items[0].tag,1);assert.equal(record.fields.items[0].size,1);
    assert.deepEqual([...record.fields.items[0].rawPayload],[7]);
});

test('type changes preserve enum labels and field references and refuse to discard nested or length configuration', () => {
    const f=fixture();f.view.open({id:'preserve-types',schemaVersion:3,messages:[{id:'frame',byteLength:0,fields:[
        {id:'size',name:'size',type:'enum',baseType:'uint8',byteLength:1,enum:{1:'一个'}},
        {id:'payload',name:'payload',type:'bytes',byteLength:0,lengthSource:{fieldId:'size'}},
        {id:'group',name:'group',type:'struct',byteLength:1,fields:[{id:'child',name:'child',type:'uint8',byteLength:1}]}
    ]}]});
    f.change('field.type','uint16');assert.equal(f.view.selectedField.type,'enum');assert.equal(f.view.selectedField.baseType,'uint16');
    assert.equal(f.view.selectedField.byteLength,2);assert.equal(f.view.selectedField.enum[1],'一个');
    assert.equal(ProtocolModel.findField(f.view.draft,'payload').lengthSource.fieldId,'size');
    const before=JSON.stringify(f.view.draft);f.change('field.type','float32');
    assert.equal(JSON.stringify(f.view.draft),before);assert.match(f.view.alert.textContent,/约束|枚举|长度/);
    f.view._selectField(ProtocolModel.findField(f.view.draft,'group'));f.change('field.type','uint32');
    assert.equal(ProtocolModel.findField(f.view.draft,'child').id,'child');assert.equal(f.view.selectedField.type,'struct');
    assert.match(f.view.alert.textContent,/子字段|结构/);
    f.view._selectField(ProtocolModel.findField(f.view.draft,'payload'));f.change('field.type','uint16');
    assert.equal(f.view.selectedField.type,'bytes');assert.equal(f.view.selectedField.lengthSource.fieldId,'size');
});

test('field roles project existing fixed and checksum schemas without changing identities or references', () => {
    const f = fixture(); f.view.open();
    const sync = f.view._fieldRows().find(row => row.field.type === 'fixed').field;
    f.root.querySelector(`[data-field-id="${sync.id}"]`).click();
    assert.equal(f.control('field.type').value, 'bytes'); assert.equal(f.control('field.role').value, 'fixed');
    constraint(f, 'data'); assert.equal(f.view.selectedField.type, 'bytes');
    assert.equal(f.view.selectedField.framingRole, undefined);
    f.action('undo').click(); assert.equal(f.view.selectedField.id, sync.id);
    assert.equal(f.view.selectedField.type, 'fixed');
    f.view._addField('checksum'); const id = f.view.selectedField.id;
    assert.equal(f.control('field.type').value, 'uint16'); assert.equal(f.control('field.role').value, 'checksum');
    assert.equal(f.control('field.checksum.enabled'), null);
    constraint(f, 'data'); assert.equal(f.view.selectedField.id, id); assert.equal(f.view.selectedField.type, 'uint16');
    constraint(f, 'checksum'); assert.equal(f.view.selectedField.type, 'checksum');
    f.change('field.type', 'int16'); assert.equal(f.view.selectedField.type, 'checksum', 'changing a type cannot silently remove checksum rules');
    constraint(f, 'data');
    f.change('field.type', 'int16');
    assert.equal(f.view.selectedField.type, 'int16');
    assert.equal(f.control('field.checksum.enabled'), null);
    assert.ok(!f.control('field.role').children.some(option => ['checksum', 'length'].includes(option.value)), 'signed integers cannot store a length or checksum');
});

test('changing the data type of fixed content preserves its wire bytes and rejects partial scalar constants', () => {
    const f = fixture(); f.view.open({ schemaVersion: 3, id: 'fixed-values', messages: [{ id: 'frame', byteLength: 1,
        fields: [{ id: 'value', name: 'value', type: 'fixed', byteLength: 1, bytes: [170] }] }] });
    f.change('field.type', 'uint8');
    assert.deepEqual(f.view.selectedField.expectedBytes, [170]);
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', {})], [170]);
    assert.equal(Protocol.decode([170], f.view.draft).fields.value, 170);
    f.change('field.type', 'bytes');
    assert.deepEqual(f.view.selectedField.bytes, [170]);
    f.change('field.byteLength', '4'); f.change('field.type', 'uint32');
    assert.equal(f.view.applyButton.disabled, true);
    f.change('field.bytes', 'AA 00 00 00');
    f.change('field.type', 'uint32');
    f.view.draft.messages[0].byteLength = 4; f.view._render();
    assert.equal(f.view.applyButton.disabled, false);
});

test('fixed framing markers retain synchronization and end boundaries when an incompatible type is attempted', () => {
    for (const role of ['sync', 'end']) {
        const f = fixture(); f.view.open({ schemaVersion: 3, id: 'marker-' + role, messages: [{ id: 'frame', byteLength: 1,
            fields: [{ id: 'marker', name: 'marker', type: 'fixed', byteLength: 1, bytes: [170], framingRole: role }] }] });
        assert.ok(f.control('field.type').children.some(option => option.value === 'uint8'));
        f.change('field.type', 'uint8');
        assert.equal(f.view.selectedField.type, 'fixed'); assert.equal(f.view.selectedField.framingRole, role);
        const compiled = Protocol.compile(f.view.draft);
        assert.deepEqual(role === 'sync' ? compiled.sync.bytes : compiled.framing.footer, [170]);
        f.change('field.framingRole', '');
        assert.ok(f.control('field.type').children.some(option => option.value === 'uint8'));
        f.change('field.type', 'uint8'); assert.deepEqual(f.view.selectedField.expectedBytes, [170]);
    }
});

test('enum labels use add edit delete rows and validate duplicate or out of range values', () => {
    const input = { schemaVersion: 3, id: 'enum', messages: [{ id: 'frame', byteLength: 1, fields: [
        { id: 'mode', name: 'mode', type: 'uint8', byteLength: 1 }
    ] }] };
    const f = fixture(); f.view.open(input);
    assert.ok(!f.control('field.enum'), 'users do not need to edit a JSON object');
    assert.ok(f.action('field.enum-add'));
    f.action('field.enum-add').click(); f.change('field.enum.0.label', '停止');
    f.action('field.enum-add').click(); f.change('field.enum.1.value', '0x02'); f.change('field.enum.1.label', '运行');
    assert.deepEqual(f.view.selectedField.enum, { 0: '停止', 2: '运行' });
    assert.equal(Protocol.decode([2], f.view.draft).flatFields[0].label, '运行');
    f.change('field.enum.1.value', '0'); assert.match(f.view.alert.textContent, /重复/);
    assert.deepEqual(f.view.selectedField.enum, { 0: '停止', 2: '运行' });
    f.change('field.enum.1.value', '256'); assert.match(f.view.alert.textContent, /范围/);
    f.action('field.enum.0-delete').click();
    assert.deepEqual(f.view.selectedField.enum, { 2: '运行' });
    f.action('undo').click(); assert.equal(f.view.selectedField.enum[0], '停止');
});

test('legacy enum storage and exact uint64 labels remain editable without losing precision', () => {
    const input = { schemaVersion: 3, id: 'enum64', messages: [{ id: 'frame', byteLength: 8, fields: [
        { id: 'mode', name: 'mode', type: 'enum', baseType: 'uint64', byteLength: 8, enum: { '18446744073709551615': '最大值' } }
    ] }] };
    const f = fixture(); f.view.open(input);
    assert.equal(f.control('field.type').value, 'uint64');
    f.change('field.enum.0.label', '完整值');
    assert.equal(f.view.selectedField.type, 'enum');
    assert.equal(Protocol.decode(new Array(8).fill(255), f.view.draft).flatFields[0].label, '完整值');
    assert.equal(f.control('field.enum.0.value').value, '18446744073709551615');
    f.change('field.enum.0.value', '18446744073709551616'); assert.match(f.view.alert.textContent, /范围/);
});

test('legacy scalar byte lengths are not mistaken for bit slice widths in enum validation', () => {
    for (const [type, width, value] of [['uint16', 2, '65535'], ['uint64', 8, '18446744073709551615']]) {
        const f = fixture(); f.view.open({ schemaVersion: 3, id: 'legacy-' + type, messages: [{ id: 'frame', byteLength: width,
            fields: [{ id: 'value', name: 'value', type: 'enum', baseType: type, byteLength: width, length: width, enum: { 0: '初始' } }] }] });
        f.change('field.enum.0.value', value);
        assert.equal(f.view.selectedField.enum[value], '初始');
        assert.equal(f.view.alert.hidden, true);
    }
});

test('legacy boolean enum storage only accepts zero one or legacy boolean keys', () => {
    const f = fixture(); f.view.open({ schemaVersion: 3, id: 'bool-label', messages: [{ id: 'frame', byteLength: 1,
        fields: [{ id: 'value', name: 'value', type: 'enum', baseType: 'bool', byteLength: 1, enum: { 0: '关闭', 1: '开启' } }] }] });
    f.change('field.enum.1.value', '2');
    assert.match(f.view.alert.textContent, /范围/);
    assert.deepEqual(f.view.selectedField.enum, { 0: '关闭', 1: '开启' });
    f.change('field.enum.1.value', 'true');
    assert.equal(Protocol.decode([1], f.view.draft).flatFields[0].label, '开启');
});

test('bit value labels also use visual rows and keep legacy boolean keys', () => {
    const f = fixture(); f.view.open(); f.view._addField('bitfield'); f.action('add-bit').click();
    f.change('bit.0.type', 'bool');
    f.view.selectedField.bits[0].enum = { false: '关', true: '开' }; f.view._renderMessages();
    assert.ok(!f.control('bit.0.enum'));
    f.change('bit.0.enum.1.label', '开启');
    assert.deepEqual(f.view.selectedField.bits[0].enum, { false: '关', true: '开启' });
    f.change('bit.0.enum.1.value', '2'); assert.match(f.view.alert.textContent, /范围/);
});

test('referenced fields list length conditions and root consumers with stable jump targets', () => {
    const input = { schemaVersion: 3, id: 'links', messages: [{ id: 'frame', name: '整帧', byteLength: 0,
        lengthSource: { fieldId: 'size', adjustment: 2 }, fields: [
            { id: 'size', name: 'data_length', type: 'uint8', byteLength: 1 },
            { id: 'payload', name: 'payload', type: 'bytes', byteLength: 0, lengthSource: { fieldId: 'size' } },
            { id: 'optional', name: 'extra', type: 'uint8', byteLength: 1, condition: 'data_length > 0' }
        ] }] };
    const f = fixture(); f.view.open(input);
    const link = id => f.root.querySelector(`[data-reference-node="${id}"]`);
    assert.match(link('payload').textContent, /payload.*长度/);
    assert.match(link('optional').textContent, /extra.*条件/);
    link('optional').click();
    assert.equal(f.view.selectedField.id, 'optional');
    assert.equal(f.view.propertyTab,'advanced');assert.equal(f.control('field.condition').closest('[data-property-panel]').hidden,false);
    assert.ok(f.document.activeElement === f.control('field.condition'));
    f.root.querySelector('[data-field-id="size"]').click();
    link('payload').click(); assert.equal(f.view.selectedField.id, 'payload');
    f.root.querySelector('[data-field-id="size"]').click();
    f.change('field.name', 'size_bytes');
    assert.ok(link('payload')); assert.match(link('optional').textContent, /条件/);
    link('frame').click(); assert.equal(f.view.framingSelected, true);
    assert.ok(f.document.activeElement === f.control('frame.lengthFrom'));
    assert.ok(f.action('jump-length-source'));
    f.action('jump-length-source').click(); assert.equal(f.view.selectedField.id, 'size');
});

test('bit component configures whole-byte length, single and reserved slices in visible properties', () => {
    const f = fixture(); f.view.open();
    f.view._addField('bitfield');
    f.change('field.byteLength', '3');
    f.action('add-bit').click();
    f.change('bit.0.name', 'enabled'); f.change('bit.0.type', 'bool');
    f.action('add-reserved-bit').click();
    const bitfield = f.view.selectedField;
    assert.equal(bitfield.type, 'bitfield'); assert.equal(bitfield.byteLength, 3);
    assert.deepEqual(bitfield.bits.map(bit => [bit.offset, bit.length, bit.type]), [[0, 1, 'bool'], [1, 23, 'reserved']]);
    assert.equal(f.control('field.width').textContent, '存储宽度：3 字节');
    assert.ok(f.control('bit.1.name').closest('.protocol-bit-fields'));
    assert.match(f.root.querySelector('.protocol-bit-fields').textContent, /24 bit/);
    f.change('field.byteLength', '1.5'); assert.equal(f.view.applyButton.disabled, true);
    f.change('field.byteLength', '3');
    f.view.draft.messages[0].byteLength = 9;
    const compiled = Protocol.compile(f.view.draft);
    assert.ok(compiled.rootMessages[0].fields.some(field => field.type === 'bitfield'));
});

test('all bit definitions remain editable in one scrolling property list', () => {
    const f = fixture(); f.view.open(); f.view._addField('bitfield'); f.change('field.byteLength', '8');
    f.view.selectedField.bits = Array.from({ length: 61 }, (_, index) => ({ id: 'bit.' + index, name: 'bit' + index, offset: index, length: 1, type: 'uint' }));
    f.view._renderMessages();
    assert.equal(f.root.querySelectorAll('.protocol-bit-row').length, 61);
    assert.ok(f.control('bit.30.name')); assert.equal(f.action('bits-next'), null);
    f.action('add-reserved-bit').click();
    assert.ok(f.control('bit.61.name')); assert.equal(f.view.selectedField.bits[61].offset, 61);
    assert.equal(f.view.selectedField.bits[61].length, 3);
    assert.equal(f.root.querySelectorAll('.protocol-bit-row').length, 62);
});

test('field cards split type, byte count and offsets into short independent lines', () => {
    const f = fixture(); f.view.open();
    const field = named(f.view.draft, 'value');
    const card = f.root.querySelector(`[data-field-id="${field.id}"]`);
    const lines = card.querySelector('.protocol-field-meta').children.map(line => line.textContent);
    assert.deepEqual(lines, ['无符号整数', '2 字节', '整帧 3', '段内 1']);
});

test('wrapped card drop handles a bottom-edge insertion on a new row and preserves stable IDs', () => {
    const f = fixture(); f.view.open();
    const rows = f.view._fieldRows(), row = rows.find(item => item.field.name === 'flags'), source = row.field, last = row.owner.at(-1);
    const handle = f.root.querySelector(`[data-drag-id="${source.id}"]`);
    handle.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    const destination = f.root.querySelector(`[data-field-id="${last.id}"]`);
    destination.getBoundingClientRect = () => ({ left: 0, right: 160, top: 120, bottom: 210, width: 160, height: 90 });
    destination.dispatchEvent({ type: 'dragover', clientX: 5, clientY: 209 });
    assert.equal(f.view.dropTarget.after, true);
    destination.dispatchEvent({ type: 'drop' });
    assert.equal(row.owner.at(-1).id, source.id);
});

function documentFixture() {
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {};
            this.dataset = {}; this.style = {}; this.listeners = new Map(); this.className = ''; this._text = '';
            this.value = ''; this.disabled = false; this.hidden = false; this.checked = false;
            this.classList = { contains: name => this.className.split(' ').includes(name),
                add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
                remove: name => { this.className = this.className.split(' ').filter(part => part !== name).join(' '); },
                toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name);
                    this.classList[enabled ? 'add' : 'remove'](name); return enabled; } };
        }
        set textContent(value) { this._text = String(value ?? ''); this.children.forEach(child => { child.parentNode = null; }); this.children = []; }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
        appendChild(child) { this.append(child); return child; }
        replaceChildren(...children) { this.textContent = ''; this.append(...children); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
        setAttribute(name, value) {
            this.attributes[name] = String(value);
            if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
            if (name === 'id') this.id = String(value);
        }
        getAttribute(name) { return this.attributes[name] ?? null; }
        removeAttribute(name) { delete this.attributes[name]; }
        addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
        removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
        dispatchEvent(event) {
            event.target ??= this;
            event.preventDefault ??= () => { event.defaultPrevented = true; };
            event.stopPropagation ??= () => { event.stopped = true; };
            for (const listener of this.listeners.get(event.type) ?? []) listener(event);
            if (event.bubbles && !event.stopped) this.parentNode?.dispatchEvent(event);
        }
        click() { if (!this.disabled) this.dispatchEvent({ type: 'click', bubbles: true }); }
        focus() { document.activeElement = this; }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
        showModal() { this.open = true; }
        close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        matches(selector) {
            if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
            const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
            if (match) return match[2] === undefined ? this.getAttribute(match[1]) !== null : this.getAttribute(match[1]) === match[2];
            return this.tagName === selector.toUpperCase();
        }
        querySelectorAll(selector) {
            const result = [], choices = selector.split(',').map(part => part.trim());
            const visit = node => { for (const child of node.children) { if (choices.some(choice => child.matches(choice))) result.push(child); visit(child); } };
            visit(this); return result;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
        closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
    }
    const document = { createElement: tag => Object.assign(new Element(tag), { ownerDocument: document }), activeElement: null,
        defaultView: { innerWidth: 1280, innerHeight: 800, Event: class {
            constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
            preventDefault() { this.defaultPrevented = true; }
            stopPropagation() { this.stopped = true; }
        } } };
    document.body = new Element('body');
    return document;
}
function schema() {
    return { id: 'editor.demo', endian: 'little', framing: { header: [170], fixedLength: 6, maxLength: 256 },
        command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
        messages: [{ id: 'state', name: '状态', command: 1, fields: [
            { name: 'flags', type: 'uint8', bits: [{ name: 'mode', offset: 1, length: 3 }] },
            { name: 'value', type: 'uint16' }, { name: 'tail', type: 'uint8' }
        ] }] };
}
function fixture(options = {}) {
    const document = documentFixture(), root = document.createElement('div'); document.body.append(root);
    const drafts = [], applied = [], current = schema();
    const view = new ProtocolEditorView({ document, root, getProtocol: () => current,
        onDraft: value => drafts.push(value), onApply: async value => applied.push(value), ...options });
    return { document, root, drafts, applied, current, view,
        control: name => root.querySelector(`[data-control="${name}"]`),
        action: name => root.querySelector(`[data-action="${name}"]`),
        change(name, value, type = 'change') { const node = this.control(name); assert.ok(node, name);
            if (typeof value === 'boolean') node.checked = value; else node.value = value;
            node.dispatchEvent({ type, bubbles: true }); }
    };
}
function simulateFocusScrolling(f) {
    const create=f.document.createElement;
    f.document.createElement=tag=>{
        const node=create(tag),focus=node.focus.bind(node);
        node.focus=options=>{
            focus();if(options?.preventScroll)return;
            for(let parent=node.parentNode;parent;parent=parent.parentNode)
                if(parent===f.view.propertyScroll||parent===f.view.body||parent===f.view.outlineHost)parent.scrollTop=0;
        };
        return node;
    };
}
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

test('constraint page edits weak defaults, stages and backfill without changing the wire structure', () => {
    const f = fixture(); f.view.open(branchingSchema());
    const fields = JSON.stringify(f.view.draft.messages);
    f.view.selectTab('rules'); f.action('add-rule-length').click();
    assert.equal(f.control('rule.strength').value, 'weak');
    f.change('rule.expression', 'tag == LEN(payload)');
    f.change('rule.stage', 'both'); f.change('rule.strength', 'strong');
    f.change('rule.send', 'fill'); f.change('rule.targetFieldId', 'tag'); f.change('rule.value', 'LEN(payload)');
    assert.equal(f.view.draft.rules[0].stage, 'both');
    assert.equal(f.view.draft.rules[0].value, 'LEN(payload)');
    assert.equal(JSON.stringify(f.view.draft.messages), fields);
    assert.equal(f.view.applyButton.disabled, true, 'command fields cannot be silently backfilled to a different branch');
    f.change('rule.send', 'verify'); assert.equal(f.view.applyButton.disabled, false);
    f.view.selectTab('messages'); f.view._selectField(named(f.view.draft, 'tag'));
    f.root.querySelector('[data-reference-node="rule-1"]').click();
    assert.equal(f.view.activeTab, 'rules'); assert.equal(f.control('rule.expression').value, 'tag == LEN(payload)');
    const saved = JSON.parse(f.view.exportJson()); assert.equal(saved.rules[0].id, 'rule-1');
});

test('new checksum coverage links and sample results are visible without legacy checksum fields', () => {
    const f = fixture();
    const s = { id: 'new-check', schemaVersion: 3, symbolVersion: 2, messages: [{ id: 'frame', byteLength: 2, fields: [
        { id: 'payload', name: 'payload', type: 'uint8', byteLength: 1 },
        { id: 'sum', name: 'sum', type: 'uint8', byteLength: 1 }
    ] }], rules: [{ id: 'check', name: '数据求和', type: 'checksum', targetFieldId: 'sum',
        checksum: { type: 'sum', start: { fieldId: 'payload', edge: 'start' }, end: { fieldId: 'payload', edge: 'end' } } }] };
    f.view.open(s); f.view._selectField(named(f.view.draft, 'payload'));
    assert.ok(f.root.querySelector('.protocol-checksum-coverage').textContent.includes('数据求和'));
    assert.ok(!f.root.querySelector('.protocol-checksum-coverage').textContent.includes('未被校验覆盖'));
    f.view.hexInput.value = '01 02'; f.view.decode();
    assert.equal(f.view.previewRecord.valid, true);
    assert.ok(f.root.querySelector('[data-rule-result="check"]').textContent.includes('失败'));
});

test('legacy checksum conversion is explicit, preserves IDs and supports weak receive rules', () => {
    const f = fixture(); const s = { id: 'legacy-check', schemaVersion: 3, symbolVersion: 2, messages: [{ id: 'frame', byteLength: 2, fields: [
        { id: 'data', name: 'data', type: 'uint8', byteLength: 1 },
        { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum', start: 0, end: 1 } }
    ] }] };
    f.view.open(s); assert.throws(() => Protocol.decode([1, 2], f.view.draft), /checksum/);
    f.view.selectTab('rules'); f.action('convert-rule-sum').click();
    assert.equal(named(f.view.draft, 'sum').id, 'sum'); assert.equal(named(f.view.draft, 'sum').type, 'uint8');
    assert.equal(f.control('rule.stage').value, 'both'); assert.equal(f.control('rule.strength').value, 'strong');
    assert.equal(f.control('rule.send').value, 'fill');
    f.change('rule.strength', 'weak');
    assert.equal(Protocol.decode([1, 2], f.view.draft).valid, true);
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', { data: 2 })], [2, 2]);
    f.action('undo').click(); assert.equal(f.view.draft.rules[0].strength, 'strong');
    f.action('undo').click(); assert.equal(named(f.view.draft, 'sum').type, 'checksum');
});

function branchingSchema() {
    return { schemaVersion: 3, id: 'branches', messages: [{ id: 'frame', byteLength: 3, fields: [
        { id: 'tag', name: 'tag', type: 'uint8', byteLength: 1 },
        { id: 'payload', name: 'payload', type: 'choice', byteLength: 2, selector: 'tag', branches: [
            { id: 'a', label: '第一个较长名称的条件分支', equals: 1, fields: [{ id: 'a.value', name: 'value', type: 'uint16', byteLength: 2 }] },
            { id: 'b', equals: 2, fields: [{ id: 'b.value', name: 'value', type: 'uint16', byteLength: 2 }] },
            { id: 'fallback', default: true, fields: [] }
        ] }
    ] }] };
}

test('nested robot interaction fields stay inside their branch with a separate header and content flow', () => {
    const { RoboMasterProtocol } = require('../robomasterProtocol'), f = fixture(); f.view.open(RoboMasterProtocol.compiled.schema);
    const branch = f.root.querySelector('[data-branch-id="rm2026.0301"]'); assert.ok(branch);
    assert.ok(branch.querySelector('.protocol-branch-header'));
    assert.ok(branch.querySelector('.protocol-branch-fields'));
    assert.ok(branch.querySelector('[data-branch-id="rm2026.0301.robot-communication"]'));
    const field = branch.querySelector('[data-field-path="data_cmd_id"]'); assert.ok(field);
    assert.equal(field.closest('.protocol-branch-fields').parentNode, branch);
});

test('canvas branch dragging reorders identities without moving fields between branches and supports undo', () => {
    const f = fixture(); f.view.open(branchingSchema());
    const before = Protocol.encode(f.view.draft, 'frame', { tag: 1, payload: { value: 513 } });
    const handle = f.root.querySelector('[data-branch-drag="a"]'); assert.ok(handle);
    handle.dispatchEvent({ type: 'dragstart', bubbles: true, dataTransfer: { setData() {} } });
    const target = f.root.querySelector('[data-branch-id="b"]'); target.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100 });
    target.dispatchEvent({ type: 'dragover', clientY: 90, bubbles: true }); target.dispatchEvent({ type: 'drop', bubbles: true });
    assert.deepEqual(ProtocolModel.findField(f.view.draft, 'payload').branches.map(branch => branch.id), ['b','a','fallback']);
    assert.deepEqual(Protocol.encode(f.view.draft, 'frame', { tag: 1, payload: { value: 513 } }), before);
    assert.equal(ProtocolModel.findField(f.view.draft, 'a.value').id, 'a.value');
    f.action('undo').click(); assert.equal(ProtocolModel.findField(f.view.draft, 'payload').branches[0].id, 'a');
});

test('property branch dragging and keyboard reordering share stable identities and cancel safely', () => {
    const f = fixture(); f.view.open(branchingSchema()); f.root.querySelector('[data-field-path="payload"]').click();
    let editors = f.view.propertyHost.querySelectorAll('.protocol-branch-editor');
    editors[1].querySelector('[data-branch-drag="b"]').dispatchEvent({ type: 'dragstart', bubbles: true, dataTransfer: { setData() {} } });
    editors[0].getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100 });
    editors[0].dispatchEvent({ type: 'dragover', clientY: 1, bubbles: true }); editors[0].dispatchEvent({ type: 'drop', bubbles: true });
    assert.deepEqual(ProtocolModel.findField(f.view.draft, 'payload').branches.map(branch => branch.id), ['b','a','fallback']);
    editors = f.view.propertyHost.querySelectorAll('.protocol-branch-editor');
    editors[0].querySelector('[data-branch-drag="b"]').dispatchEvent({ type: 'keydown', key: 'ArrowDown', altKey: true, bubbles: true });
    assert.equal(ProtocolModel.findField(f.view.draft, 'payload').branches[0].id, 'a');
    f.view.propertyHost.querySelector('[data-branch-drag="a"]').dispatchEvent({ type: 'dragstart', bubbles: true, dataTransfer: { setData() {} } });
    f.view.dialog.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(f.view.draggedBranch, null); assert.equal(f.view.opened, true);
});

test('returning a dragged branch to itself cannot apply an earlier drop target', () => {
    const f = fixture(); f.view.open(branchingSchema());
    f.root.querySelector('[data-branch-drag="a"]').dispatchEvent({ type: 'dragstart', bubbles: true, dataTransfer: { setData() {} } });
    const next = f.root.querySelector('[data-branch-id="b"]'); next.getBoundingClientRect = () => ({ top: 0, height: 100 });
    next.dispatchEvent({ type: 'dragover', clientY: 90, bubbles: true });
    const original = f.root.querySelector('[data-branch-id="a"]');
    original.dispatchEvent({ type: 'dragover', clientY: 20, bubbles: true }); original.dispatchEvent({ type: 'drop', bubbles: true });
    assert.deepEqual(ProtocolModel.findField(f.view.draft, 'payload').branches.map(branch => branch.id), ['a','b','fallback']);
});

test('dragging onto a child card or a nested branch still reorders the intended outer branch', () => {
    for (const nested of [false, true]) {
        const input = branchingSchema();
        if (nested) input.messages[0].fields[1].branches[1].fields = [{ id: 'nested', name: 'nested', type: 'choice', selector: '0', byteLength: 2,
            branches: [{ id: 'inner', default: true, fields: [{ id: 'b.value', name: 'value', type: 'uint16', byteLength: 2 }] }] }];
        const f = fixture(); f.view.open(input);
        f.root.querySelector('[data-branch-drag="a"]').dispatchEvent({ type: 'dragstart', bubbles: true, dataTransfer: { setData() {} } });
        f.root.querySelector('[data-branch-id="b"]').getBoundingClientRect = () => ({ top: 0, height: 200 });
        const card = f.root.querySelector('[data-field-id="b.value"]');
        card.dispatchEvent({ type: 'dragover', clientY: 180, bubbles: true }); card.dispatchEvent({ type: 'drop', bubbles: true });
        assert.deepEqual(ProtocolModel.findField(f.view.draft, 'payload').branches.map(branch => branch.id), ['b','a','fallback']);
        assert.equal(ProtocolModel.findField(f.view.draft, 'b.value').id, 'b.value');
    }
});

test('consecutive keyboard moves retain the same branch handle in either editor surface', () => {
    for (const properties of [false, true]) {
        const input = branchingSchema(); input.messages[0].byteLength = 4; input.messages[0].fields.push({ id: 'tail', name: 'tail', type: 'uint8', byteLength: 1 });
        const f = fixture(); f.view.open(input);
        if (properties) f.root.querySelector('[data-field-path="payload"]').click();
        const host = properties ? f.view.propertyHost : f.view.canvas;
        host.querySelector('[data-branch-drag="a"]').focus();
        for (let index = 0; index < 2; index++) {
            f.document.activeElement.dispatchEvent({ type: 'keydown', key: 'ArrowDown', altKey: true, bubbles: true });
            assert.equal(f.document.activeElement.getAttribute('data-branch-drag'), 'a');
            assert.equal((properties ? f.view.propertyHost : f.view.canvas).contains(f.document.activeElement), true);
        }
        assert.deepEqual(ProtocolModel.findField(f.view.draft, 'payload').branches.map(branch => branch.id), ['b','fallback','a']);
        assert.deepEqual(f.view.draft.messages[0].fields.map(field => field.id), ['tag','payload','tail']);
    }
});

test('integer display bases persist per field and format exact preview values without changing bytes', async () => {
    const f = fixture(); f.view.open(); f.root.querySelector('[data-field-path="value"]').click();
    f.change('field.displayBase', 'hex');
    f.change('preview-hex', 'AA 01 0A 34 12 07'); f.action('decode').click();
    assert.match(f.root.querySelector('[data-preview-path="value"]').textContent, /= 0x1234/);
    f.change('field.displayBase', 'dec');
    assert.match(f.root.querySelector('[data-preview-path="value"]').textContent, /= 4660/);
    f.change('field.displayBase', 'hex'); await f.view.apply();
    assert.equal(named(f.applied[0], 'value').displayBase, 'hex');
    assert.equal(Protocol.decode([170,1,10,52,18,7], f.applied[0]).fields.value, 4660);
});

test('the editor presents one real frame tree with type-first properties and checksum components', () => {
    const f = fixture(); f.view.open();
    assert.equal(f.view.draft.schemaVersion, 3);
    assert.equal(f.view.draft.messages.length, 1);
    assert.equal(f.root.querySelector('[data-tab="checksums"]'), null);
    assert.equal(f.action('edit-framing'), null);
    assert.equal(f.action('add-message'), null);
    assert.ok(f.root.querySelector('[data-frame-root]'));
    f.view._addField('checksum');
    assert.equal(f.control('field.type').value, 'uint16');
    assert.equal(f.control('field.role').value, 'checksum');
    assert.equal(f.control('field.checksum.enabled'), null);
    assert.ok(f.control('field.checksum.type'));
    const controls = f.view.propertyHost.querySelectorAll('[data-control]').map(node => node.getAttribute('data-control'));
    assert.ok(controls.indexOf('field.type') < controls.indexOf('field.byteLength'));
    f.change('field.type', 'uint8'); f.change('field.checksum.type', 'sum');
    assert.equal(f.view.selectedField.byteLength, 1);
    assert.equal(f.view.selectedField.checksum.type, 'sum');
});

test('zero-byte field properties require a visible length source and support stable fixed-field boundaries', () => {
    const f = fixture(); f.view.open(); f.view._addField('bytes');
    f.change('field.byteLength', '0');
    assert.match(f.view.propertyHost.textContent, /变长/);
    f.change('field.lengthMode', 'boundary');
    assert.ok(f.control('field.boundary.endFieldId'));
    assert.equal(f.action('apply').disabled, true);
    f.change('field.lengthMode', 'expression'); f.change('field.lengthFrom', 'remaining');
    assert.equal(f.view.selectedField.lengthFrom, 'remaining');
    assert.ok(!f.control('field.lengthMode').children.some(option => option.value === 'field'));
    assert.equal(f.control('field.lengthSource.fieldId'), null);
    assert.match(f.view.propertyHost.textContent, /长度字段的“内容约束 → 长度关联”/);
});

test('counted TLV containers can explicitly derive their variable size from internal items', () => {
    const f = fixture(); f.view.open(); f.view._addField('tlv');
    f.change('field.count', '2');
    assert.ok(f.control('field.lengthMode').children.some(option => option.value === 'contents'));
    f.change('field.lengthMode', 'contents');
    assert.equal(f.view.selectedField.lengthFrom, 'contents');
});

test('editor opens a named modal with independent workspace and verification tabs', () => {
    const f = fixture(); f.view.open();
    const dialog = f.root.querySelector('dialog');
    assert.equal(dialog.open, true); assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.deepEqual([...f.view.tabButtons.values()].map(node => node.textContent.replace(/ \(.*$/, '')), ['整帧结构', '规则约束', 'JSON']);
    assert.deepEqual([...f.view.bottomButtons.values()].map(node=>node.textContent.replace(/ \(.*$/, '')),['字节布局','样例解析','问题列表']);
    f.action('select-frame').click(); assert.equal(f.control('frame.lengthFrom').value, '6');
    f.root.querySelector('[data-tab="messages"]').dispatchEvent({ type: 'keydown', key: 'ArrowRight', bubbles: true });
    assert.equal(f.root.querySelector('[data-tab="rules"]').getAttribute('aria-selected'), 'true');
});

test('whole-frame selection edits the real root without duplicating wire rules', () => {
    const f = fixture(); f.view.open(); const before = JSON.stringify(f.view.draft);
    assert.ok(f.action('select-frame').closest('.protocol-field-canvas'));
    f.action('select-frame').click();
    assert.equal(f.view.activeTab, 'messages'); assert.equal(f.action('select-frame').getAttribute('aria-pressed'), 'true');
    assert.ok(f.control('frame.lengthFrom').closest('.protocol-editor-properties'));
    assert.equal(f.control('frame.byteLength'), null); assert.equal(f.control('frame.lengthMode'), null);
    assert.equal(JSON.stringify(f.view.draft), before);
    f.root.querySelector('[data-field-path="value"]').click(); assert.equal(f.control('field.type').value, 'uint16');
    assert.equal(f.control('frame.lengthFrom'), null);
    f.action('select-frame').click(); f.change('frame.lengthFrom', '8');
    assert.equal(f.view.draft.messages[0].byteLength, 0);
    assert.equal(f.view.draft.messages[0].lengthFrom, '8');
    f.action('undo').click(); assert.equal(f.control('frame.lengthFrom').value, '6');
    assert.equal(JSON.stringify(f.view.draft), before);
});

test('frame length sources and field selection remain editable after invalid rules', () => {
    const f = fixture(); f.view.open(); f.action('select-frame').click(); f.change('frame.lengthFrom', '0');
    assert.equal(f.view.draft.messages[0].lengthFrom, undefined);
    f.change('frame.lengthFrom', 'value * 2 + 3');
    assert.equal(f.view.draft.messages[0].lengthFrom, 'value * 2 + 3');
    f.change('framing.maxLength', '0'); assert.equal(f.action('apply').disabled, true);
    f.action('new-field').click(); assert.equal(f.control('field.type').value, 'uint8');
    f.action('select-frame').click(); assert.equal(f.control('framing.maxLength').value, '0');
});

test('legacy frame length bindings are readonly at the consumer and editable at the source', () => {
    const s = { id: 'frame-source', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
        id: 'frame', byteLength: 0, lengthSource: { fieldId: 'size', unit: 2, adjustment: 3 }, fields: [
            { id: 'size', name: 'size', type: 'uint8', byteLength: 1, role: 'length' },
            { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'FRAME_LENGTH - 1' }
        ]
    }] };
    const f = fixture(); f.view.open(s); const before = JSON.stringify(f.view.draft);
    f.action('select-frame').click();
    assert.equal(f.control('frame.lengthMode'), null);
    assert.equal(Protocol.evaluateExpression(f.control('frame.lengthFrom').value, { size: 2 }), 7);
    assert.equal(f.control('frame.lengthSource.fieldId'), null);
    assert.equal(JSON.stringify(f.view.draft), before);
    assert.equal(f.control('frame.lengthFrom').readOnly, true);
    f.change('frame.lengthFrom', 'size + 1');
    assert.equal(JSON.stringify(f.view.draft), before);
    f.action('jump-length-source').click();
    assert.equal(f.control('length.0.unit'), null);
    assert.match(f.view.propertyHost.textContent, /兼容保留/);
    assert.deepEqual(f.view.draft.messages[0].lengthSource, { fieldId: 'size', unit: 2, adjustment: 3 });
    assert.equal(f.action('apply').disabled, false);
    assert.equal(JSON.stringify(f.view.draft), before);
    f.action('remove-length-target-0').click();
    assert.equal(f.view.draft.messages[0].lengthSource, undefined);
    assert.equal(ProtocolModel.findField(f.view.draft, 'size').role, undefined);
    f.action('select-frame').click(); f.change('frame.lengthFrom', '0');
    f.change('frame.lengthFrom', '3'); assert.equal(f.action('apply').disabled, false);
});

test('removing the frame expression preserves a length source still controlling a data segment', () => {
    const s = { id: 'shared-length-controls', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
        id: 'frame', byteLength: 0, lengthSource: { fieldId: 'size', adjustment: 1 }, fields: [
            { id: 'size', name: 'size', type: 'uint8', byteLength: 1, role: 'length' },
            { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthSource: { fieldId: 'size' } }
        ]
    }] };
    const f = fixture(); f.view.open(s); f.action('select-frame').click();
    f.change('frame.lengthFrom', '0');
    assert.equal(ProtocolModel.findField(f.view.draft, 'size').role, 'length');
    assert.equal(ProtocolModel.findField(f.view.draft, 'body').lengthSource.fieldId, 'size');
    assert.equal(f.action('apply').disabled, false);
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', { body: [11, 22] })], [2, 11, 22]);
});

test('fixed byte roles are configured on the actual fields and preserve identities', () => {
    const input = { id: 'fixed-frame', framing: { fixedLength: 5 }, messages: [{ id: 'data', fields: [
        { name: 'sync', type: 'fixed', bytes: [170, 85], framingRole: 'sync' },
        { name: 'payload', type: 'bytes', length: 1 },
        { name: 'end', type: 'fixed', bytes: [13, 10], framingRole: 'end' }
    ] }] };
    const f = fixture({ getProtocol: () => input }); f.view.open(); const before = JSON.stringify(f.view.draft);
    f.root.querySelector('[data-field-path="end"]').click(); assert.equal(f.control('field.framingRole').value, 'end');
    f.change('field.bytes', 'FE EF'); assert.deepEqual(named(f.view.draft, 'end').bytes, [254, 239]);
    f.action('undo').click(); assert.equal(JSON.stringify(f.view.draft), before);
    assert.equal(f.view.draft.framing.footer, undefined);
});

test('field-based boundary edits publish independent drafts without applying', () => {
    const f = fixture(); f.view.open(); const sync = f.view._fieldRows().find(row => row.field.type === 'fixed');
    f.view.selectedField = sync.field; f.view._renderMessages(); f.change('field.bytes', 'AB');
    const saved = JSON.parse(f.control('schema-json').value);
    assert.deepEqual(ProtocolModel.findField(saved, sync.field.id).bytes, [171]); assert.equal(f.applied.length, 0);
    assert.deepEqual(f.current.framing.header, [170]);
    ProtocolModel.findField(f.drafts.at(-1), sync.field.id).bytes[0] = 0;
    assert.deepEqual(ProtocolModel.findField(JSON.parse(f.control('schema-json').value), sync.field.id).bytes, [171]);
});

test('field tree adds nested structures and arrays, edits conditions, and removes selected fields', () => {
    const f = fixture(); f.view.open();
    f.view._addField('struct');
    f.change('field.name', 'position');
    f.change('field.count', '2');
    f.change('field.condition', '1 > 0');
    f.action('new-child-field').click();
    f.change('field.name', 'x');
    f.change('field.byteLength', '4'); f.change('field.type', 'float32');
    let saved = JSON.parse(f.control('schema-json').value);
    const position = named(saved, 'position');
    assert.equal(position.name, 'position'); assert.equal(position.type, 'struct'); assert.equal(position.count, 2);
    assert.equal(position.condition, '1 > 0'); assert.equal(position.fields[0].name, 'x'); assert.equal(position.fields[0].type, 'float32');
    f.action('delete-field').click();
    f.action('confirm-delete').click();
    saved = JSON.parse(f.control('schema-json').value);
    assert.deepEqual(named(saved, 'position').fields, []);
});

test('visual bit slices and checksum rules retain all edited protocol parameters', () => {
    const f = fixture(); f.view.open();
    f.root.querySelector('[data-field-path="flags"]').click();
    f.action('add-bit').click();
    f.change('bit.1.name', 'alarm'); f.change('bit.1.offset', '4'); f.change('bit.1.length', '1'); f.change('bit.1.type', 'bool');
    f.view._addField('checksum');
    f.change('field.checksum.type', 'crc16');
    f.change('field.checksum.polynomial', '0x1021'); f.change('field.checksum.reflectIn', true);
    const saved = JSON.parse(f.control('schema-json').value);
    const alarm = named(saved, 'flags').bits[1];
    assert.equal(alarm.name, 'alarm'); assert.equal(alarm.offset, 4); assert.equal(alarm.length, 1); assert.equal(alarm.type, 'bool');
    assert.equal(named(saved, f.view.selectedField.name).checksum.polynomial, 4129);
    assert.equal(named(saved, f.view.selectedField.name).byteLength, 2);
    assert.equal(named(saved, f.view.selectedField.name).checksum.reflectIn, true);
});

test('JSON edits update visual fields and invalid JSON or invalid schemas block apply safely', async () => {
    const f = fixture(); f.view.open();
    const next = schema(); next.messages[0].fields[1].name = 'temperature';
    f.change('schema-json', JSON.stringify(next), 'input');
    assert.ok(f.root.querySelector('[data-field-path="temperature"]'));
    f.change('schema-json', '{broken', 'input');
    f.action('apply').click(); await settle();
    assert.equal(f.applied.length, 0);
    assert.ok(f.root.querySelector('[role="alert"]').textContent.length > 0);
    next.messages[0].fields[0].type = '<img src=x onerror=alert(1)>';
    f.change('schema-json', JSON.stringify(next), 'input');
    await f.view.apply();
    assert.equal(f.applied.length, 0);
    assert.equal(f.root.querySelectorAll('img').length, 0);
    assert.match(f.root.querySelector('[role="alert"]').textContent, /不支持该字段数据类型/);
});

test('Hex preview uses real decoding and selected bit fields highlight the precise source bits', () => {
    const f = fixture(); f.view.open();
    f.change('preview-hex', 'AA 01 0A 34 12 07'); f.action('decode').click();
    const target = f.root.querySelector('[data-preview-path="flags.mode"]');
    assert.ok(target); assert.match(target.textContent, /5/);
    target.click();
    const selected = f.root.querySelectorAll('.protocol-preview-byte').filter(node => node.classList.contains('is-selected'));
    assert.deepEqual(selected.map(node => node.dataset.byteIndex), ['2']);
    assert.deepEqual(f.root.querySelectorAll('.protocol-preview-bit').filter(node => node.classList.contains('is-selected')).map(node => node.dataset.bitIndex), ['3', '2', '1']);
    assert.match(f.control('preview-location').textContent, /2/);
});

test('structured sample values encode through the protocol engine and populate the Hex preview', () => {
    const f = fixture(); f.view.open();
    f.change('preview-values', '{"flags":10,"value":4660,"tail":7}');
    f.action('encode').click();
    assert.equal(f.control('preview-hex').value, 'AA 01 0A 34 12 07');
    assert.ok(f.root.querySelector('[data-preview-path="value"]'));
    assert.deepEqual(Protocol.decode(Uint8Array.of(170, 1, 10, 52, 18, 7), Protocol.compile(schema())).fields,
        { flags: 10, value: 4660, tail: 7 });
});

test('whole frame fields are complete on one page while the byte preview remains bounded', () => {
    const f = fixture(), large = schema(); large.framing.fixedLength = 202;
    large.messages[0].fields = Array.from({ length: 200 }, (_, index) => ({ name: 'value' + index, type: 'uint8' }));
    f.view.open(large);
    assert.ok(f.root.querySelector('[data-field-path="value199"]'));
    assert.equal(f.root.querySelectorAll('[data-field-path]').filter(node => /^value\d+$/.test(node.dataset.fieldPath)).length, 200);
    assert.equal(f.action('fields-next'), null);
    f.change('preview-hex', 'AA 01 ' + '00 '.repeat(200)); f.action('decode').click();
    assert.equal(f.root.querySelectorAll('[data-preview-path]').length, 80);
    f.action('preview-next').click();
    assert.ok(f.root.querySelector('[data-preview-path="value80"]'));
});

test('apply awaits the callback, reports rejection without closing, and blocks duplicate submissions', async () => {
    let rejectApply, calls = 0;
    const f = fixture({ onApply: () => { calls++; return new Promise((_, reject) => { rejectApply = reject; }); } });
    f.view.open(); const first = f.view.apply(); const second = f.view.apply();
    assert.equal(calls, 1); assert.equal(f.action('apply').disabled, true);
    rejectApply(new Error('Cannot persist protocol')); await first; await second;
    assert.equal(f.root.querySelector('dialog').open, true);
    assert.match(f.root.querySelector('[role="alert"]').textContent, /协议配置保存失败/);
});

test('modal shortcuts stop at the editor and disposal detaches owned UI callbacks', async () => {
    let closes = 0;
    const f = fixture({ onClose: () => closes++ }); f.view.open();
    const event = { type: 'keydown', key: 'p', ctrlKey: true, bubbles: true };
    f.control('schema-json').dispatchEvent(event); assert.equal(event.stopped, true);
    const button = f.action('new-field'), drafts = f.drafts.length;
    f.view.close(); assert.equal(closes, 1);
    f.view.open(); f.view.dispose(); button.click(); await settle();
    assert.equal(f.drafts.length, drafts);
    assert.equal(f.root.children.length, 0);
});

test('field renames preserve the stable identity produced by compilation in the applied schema', async () => {
    const f = fixture(); f.view.open();
    const id = f.view.selectedField.id;
    assert.equal(typeof id, 'string');
    f.change('field.name', 'statusFlags'); await f.view.apply();
    assert.equal(ProtocolModel.findField(f.applied[0], id).id, id);
    assert.equal(ProtocolModel.findField(f.applied[0], id).name, 'statusFlags');
});

test('successful apply and reopening keep the complete frame without page controls', async () => {
    const f = fixture(); f.view.open(); await f.view.apply();
    assert.equal(f.action('fields-next'), null);
    assert.equal(f.action('fields-previous'), null);
    f.action('select-frame').click(); f.view.close(); f.view.open();
    assert.ok(f.root.querySelector('[data-field-path="flags"]'));
});

test('big-endian multi-byte bit slices highlight the physical low byte and exact bits', () => {
    const f = fixture(), input = schema();
    input.endian = 'big'; input.messages[0].fields = [{ name: 'flags', type: 'uint16', bits: [{ name: 'mode', offset: 1, length: 3 }] },
        { name: 'rest', type: 'uint16' }];
    f.view.open(input); f.change('preview-hex', 'AA 01 12 0A 00 00'); f.action('decode').click();
    f.root.querySelector('[data-preview-path="flags.mode"]').click();
    assert.deepEqual(f.root.querySelectorAll('.protocol-preview-byte').filter(node => node.classList.contains('is-selected')).map(node => node.dataset.byteIndex), ['3']);
    assert.deepEqual(f.root.querySelectorAll('.protocol-preview-bit').filter(node => node.classList.contains('is-selected')).map(node => node.dataset.bitIndex), ['3', '2', '1']);
});

test('editing visual controls during an invalid JSON draft reports the repair without throwing', () => {
    const f = fixture(); f.view.open(); f.change('schema-json', '{broken', 'input');
    assert.doesNotThrow(() => f.action('new-field').click());
    assert.match(f.root.querySelector('[role="alert"]').textContent, /JSON/);
});

test('protocol JSON import and export preserve stable identities and reject invalid imports before changing drafts', () => {
    const f = fixture(); f.view.open();
    const exported = f.view.exportJson(), original = JSON.parse(exported);
    assert.ok(original.messages[0].fields[0].id);
    assert.throws(() => f.view.importJson('{broken'));
    assert.equal(f.view.exportJson(), exported);
    original.name = '导入协议'; f.view.importJson(JSON.stringify(original));
    assert.equal(f.view.draft.name, '导入协议'); assert.equal(f.applied.length, 0);
    assert.equal(f.view.activeTab, 'json'); assert.match(f.view.status.textContent, /尚未应用/);
    assert.equal(f.drafts.at(-1).messages[0].fields[0].id, original.messages[0].fields[0].id);
});

test('editor library actions, undo and redo retain isolated drafts and stable field identities', () => {
    const libraries = [], f = fixture({ getProtocols: () => [schema()], onLibraryChange: (items, id) => libraries.push({ items, id }) });
    f.view.open();
    const id = f.view.selectedField.id;
    const beforeName = ProtocolModel.findField(f.view.draft, id).name;
    f.change('field.name', 'status_flag');
    assert.equal(ProtocolModel.findField(f.view.draft, id).name, 'status_flag');
    f.action('undo').click(); assert.equal(ProtocolModel.findField(f.view.draft, id).name, beforeName);
    f.action('redo').click(); assert.equal(ProtocolModel.findField(f.view.draft, id).name, 'status_flag');
    assert.equal(ProtocolModel.findField(f.view.draft, id).id, id);
    f.action('copy-protocol').click();
    assert.equal(libraries.at(-1).items.length, 2);
    assert.notEqual(libraries.at(-1).id, 'editor.demo');
    assert.equal(f.applied.length, 0);
});

test('properties show readonly identity and inferred scalar width, cards support keyboard movement and copy', () => {
    const f = fixture(); f.view.open();
    assert.equal(f.control('field.id').readOnly, true);
    assert.match(f.control('field.width').textContent, /1/);
    const card = f.root.querySelector('[data-field-path="flags"]');
    card.dispatchEvent({ type: 'keydown', key: 'ArrowDown', altKey: true, bubbles: true });
    assert.equal(f.view._fieldRows().find(row => row.field.name === 'flags').owner[1].name, 'flags');
    f.action('copy-field').click();
    const fields = f.view._fieldRows().find(row => row.field.name === 'flags').owner;
    assert.equal(fields.length, 4); assert.notEqual(fields[1].id, fields[2].id);
});

test('named samples and pane state stay outside protocol JSON and survive reopening', () => {
    let state;
    const f = fixture({ getEditorState: () => state, onEditorState: value => { state = value; } });
    f.view.open(); f.change('sample-name', '正常帧'); f.change('preview-hex', 'AA 01 0A 34 12 07');
    f.action('save-sample').click();
    assert.equal(state.samples['editor.demo'][0].name, '正常帧');
    assert.equal(JSON.parse(f.view.exportJson()).samples, undefined);
    f.view.close(); f.view.open();
    assert.equal(f.control('sample-select').children.length, 2);
});

test('opening legacy schemas preserves compiler-generated IDs used by existing mappings', () => {
    const expected = Protocol.compile(schema()).schema.messages[0].fields[0].id;
    const f = fixture(); f.view.open(); assert.equal(named(f.view.draft, 'flags').id, expected);
});

test('empty libraries remain empty until new or import and can be deleted back to empty', () => {
    const changes = [], f = fixture({ getProtocol: () => null, getProtocols: () => [], onLibraryChange: (items, id) => changes.push({ items, id }) });
    f.view.open(); assert.equal(f.action('apply').disabled, true);
    assert.match(f.root.textContent, /还没有协议/);
    f.action('new-protocol').click(); assert.equal(changes.at(-1).items.length, 1);
    f.action('delete-protocol').click(); assert.deepEqual(changes.at(-1), { items: [], id: null });
    assert.equal(f.action('apply').disabled, true);
});

test('branch, repeat, TLV and leftover controls write canonical schema attributes', () => {
    const f = fixture(); f.view.open();
    f.view._addField('choice'); f.change('field.selector', 'flags');
    f.change('branch.0.mode', 'range'); f.change('branch.0.range.0', '2'); f.change('branch.0.range.1', '5');
    f.action('branch-0-add').click(); f.change('field.name', 'branch_payload');
    let choice = f.view.draft.messages[0].fields.at(-1);
    assert.deepEqual(choice.branches[0].range, [2, 5]); assert.equal(choice.branches[0].fields[0].name, 'branch_payload');
    f.view.open({id:'old-repeat-controls',schemaVersion:3,messages:[{id:'frame',byteLength:6,fields:[
        {id:'repeated',name:'repeated',type:'repeat',byteLength:6,count:3,fields:[{id:'item',name:'item',type:'uint16',byteLength:2}]}
    ]}]});f.change('field.count', '-1');
    assert.equal(f.view.draft.messages[0].fields.at(-1).until, 'end');
    f.view._addField('tlv'); f.change('tlv.0.type', 'uint16'); f.change('tlv.1.endian', 'big'); f.change('field.lengthIncludesHeader', true);
    f.change('field.leftover', 'padding'); f.change('field.paddingByte', '255'); f.change('field.invalidItem', 'skip');
    const tlv = f.view.draft.messages[0].fields.at(-1);
    assert.equal(tlv.headerFields[0].type, 'uint16'); assert.equal(tlv.headerFields[1].endian, 'big');
    assert.equal(tlv.lengthIncludesHeader, true); assert.equal(tlv.paddingByte, 255); assert.equal(tlv.invalidItem, 'skip');
});

test('dragging into an empty choice branch reparents a field with its identity and undo restores it', () => {
    const f = fixture(); f.view.open(); const id = f.view.selectedField.id;
    f.view._addField('choice'); const choice = f.view.draft.messages[0].fields.at(-1);
    const handle = f.root.querySelector('[data-drag-id="' + id + '"]');
    handle.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    const branch = f.root.querySelector('[data-branch-id="' + choice.branches[0].id + '"]');
    branch.dispatchEvent({ type: 'dragover' }); branch.dispatchEvent({ type: 'drop' });
    assert.equal(f.view.draft.messages[0].fields.at(-1).branches[0].fields[0].id, id);
    f.action('undo').click(); assert.equal(ProtocolModel.findField(f.view.draft, id).id, id);
});

test('pane keyboard resize persists across configuration and verification tab changes', () => {
    let state; const f = fixture({ onEditorState: value => { state = value; } }); f.view.open();
    const separator = f.root.querySelector('.protocol-splitter-left');
    separator.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
    const size = state.sizes.left; f.view.selectTab('checksums'); f.view.selectBottom('preview');
    assert.equal(state.sizes.left, size); assert.equal(state.bottomTab, 'preview');
});

test('batch and stream checks use real decoding and discard results after a draft change', async () => {
    const f = fixture(); f.view.open(); f.change('sample-name', '完整帧'); f.change('preview-hex', 'AA 01 0A 34 12 07'); f.action('save-sample').click();
    await f.view.checkSamples(); assert.equal(f.view.sampleResults[0].ok, true);
    await f.view.checkSamples(true); assert.match(f.view.sampleResults[0].message, /1 帧通过/);
    const pending = f.view.checkSamples(); f.change('field.name', 'edited_flags'); await pending;
    assert.notEqual(f.view.status.textContent, '1 / 1 样例通过');
});


test('field cards report real offsets and preserve the single vertical viewport, details and input caret', () => {
    const f = fixture(); f.view.open();
    assert.equal(f.root.querySelector('[data-field-id="' + named(f.view.draft, 'value').id + '"]').getAttribute('data-byte-offset'), '3');
    assert.match(f.root.querySelector('.protocol-canvas-ruler').textContent, /卡片宽度不代表字节数/);
    f.view.body.scrollTop = 180; f.view.selectProperty('advanced');f.view.propertyScroll.scrollTop=120;
    const name = f.control('field.name'); name.focus(); name.setSelectionRange(2, 3);
    f.change('field.name', 'status_flag');
    assert.equal(f.view.body.scrollTop, 180); assert.equal(f.view.propertyScroll.scrollTop, 120);
    assert.equal(f.view.propertyTab,'advanced');
    assert.equal(f.document.activeElement, f.control('field.name'));
    assert.equal(f.document.activeElement.selectionStart, 2); assert.equal(f.document.activeElement.selectionEnd, 3);
    const sameInput = f.control('field.name'); f.change('field.name', 'next_name', 'input');
    assert.equal(f.control('field.name'), sameInput);
});

test('undoing protocol deletion restores the deleted draft without overwriting the next protocol', () => {
    const a = schema(), b = schema(); b.id = 'protocol.b'; b.name = '协议 B';
    const f = fixture({ getProtocols: () => [a, b] }); f.view.open(a);
    f.action('select-frame').click(); f.change('protocol.name', '编辑过的 A'); f.action('delete-protocol').click();
    assert.equal(f.view.deleteDialog.open,true);f.action('confirm-delete').click();
    assert.equal(f.view.draft.id, b.id); f.action('undo').click();
    assert.equal(f.view.draft.name,'编辑过的 A');assert.equal(f.view.library.find(item=>item.id===b.id).name,'协议 B');
    f.action('redo').click();
    assert.deepEqual(f.view.library.map(item => item.id), [b.id]);
    assert.equal(f.view.library[0].name, '协议 B'); assert.equal(f.view.draft.id, b.id);
    assert.equal(f.action('undo').disabled, false); assert.equal(f.action('redo').disabled, true);
});

test('deleting the final protocol prevents direct and keyboard apply of the removed draft', async () => {
    const f = fixture({ getProtocols: () => [schema()] }); f.view.open(); f.action('delete-protocol').click();
    f.action('confirm-delete').click();
    assert.equal(await f.view.apply(), false);
    f.root.querySelector('dialog').dispatchEvent({ type: 'keydown', key: 'Enter', ctrlKey: true }); await settle();
    assert.equal(f.applied.length, 0); assert.equal(f.action('apply').disabled, true);
});

test('branch equality, ranges and masks retain exact 64-bit decimal and hexadecimal input', () => {
    const f = fixture(); f.view.open(); f.view._addField('choice');
    f.change('branch.0.equals', '9007199254740993');
    assert.equal(f.view.draft.messages[0].fields.at(-1).branches[0].equals, '9007199254740993');
    f.change('branch.0.mode', 'range'); f.change('branch.0.range.0', '0x20000000000001'); f.change('branch.0.range.1', '18446744073709551615');
    assert.deepEqual(f.view.draft.messages[0].fields.at(-1).branches[0].range, ['9007199254740993', '18446744073709551615']);
    f.change('branch.0.mode', 'mask'); f.change('branch.0.mask.mask', '0xffffffffffffffff'); f.change('branch.0.mask.value', '0x20000000000001');
    assert.deepEqual(f.view.draft.messages[0].fields.at(-1).branches[0].mask, { mask: '18446744073709551615', value: '9007199254740993' });
    f.change('branch.0.mode', 'equals'); f.change('branch.0.equals', '-0x20000000000001');
    assert.equal(f.view.draft.messages[0].fields.at(-1).branches[0].equals, '-9007199254740993');
    f.change('branch.0.equals', '42'); assert.equal(f.view.draft.messages[0].fields.at(-1).branches[0].equals, 42);
});

test('blocked deletion identifies referencing rules and bounds the displayed list', () => {
    const references = Array.from({ length: 12 }, (_, index) => ({ label: '使用协议的规则 ' + (index + 1) }));
    const f = fixture({ getReferences: () => references }); f.view.open(); f.action('delete-protocol').click();
    const message = f.root.querySelector('[role="alert"]').textContent;
    assert.match(message, /使用协议的规则 1/); assert.match(message, /使用协议的规则 10/);
    assert.doesNotMatch(message, /使用协议的规则 11/); assert.match(message, /另 2/);
    assert.equal(f.view.library.length, 1);
});

test('protocol order controls update immediately so a move can be reversed', () => {
    const a = schema(), b = schema(); b.id = 'protocol.b';
    const f = fixture({ getProtocols: () => [a, b] }); f.view.open(a);
    f.action('select-frame').click();
    assert.equal(f.action('protocol-up').disabled, true); f.action('protocol-down').click();
    assert.equal(f.action('protocol-up').disabled, false); f.action('protocol-up').click();
    assert.deepEqual(f.view.library.map(item => item.id), [a.id, b.id]);
});

test('editing an exact uint64 selector match keeps the protocol compilable and decodes the intended branch', () => {
    const input = { id: 'wide-match', framing: { fixedLength: 9 }, messages: [{ id: 'wide-message', fields: [
        { name: 'tag', type: 'uint64' },
        { name: 'payload', type: 'choice', selector: 'tag', branches: [{ equals: '9007199254740993', fields: [{ name: 'value', type: 'uint8' }] }] }
    ] }] };
    const f = fixture(); f.view.open(input); f.root.querySelector('[data-field-path="payload"]').click();
    f.change('branch.0.equals', '9007199254740993');
    assert.ok(f.view.compiled); assert.equal(f.action('apply').disabled, false);
    const record = Protocol.decode(Uint8Array.of(1, 0, 0, 0, 0, 0, 32, 0, 7), f.view.compiled);
    assert.equal(record.valid, true); assert.ok(record.flatFields.some(field => field.path === 'payload.value' && field.value === 7));
});

test('sample checks use the shared worker pool for decode and stream tasks without owning its lifetime', async () => {
    const tasks = []; let disposed = 0;
    const pool = { maxWorkers: 2, runTask: async task => { tasks.push(task); return task.kind === 'protocol-stream-check' ? { frames: 2, errors: 1, pending: 2, invalidFrames: 1 } : [{ valid: true, flatFields: [] }]; }, dispose() { disposed++; } };
    const f = fixture({ getWorkerPool: () => pool }); f.view.open(); f.change('sample-name', '池内样例'); f.change('preview-hex', 'AA 01 0A 34 12 07'); f.action('save-sample').click();
    await f.view.checkSamples(); await f.view.checkSamples(true);
    assert.deepEqual(tasks.map(task => task.kind), ['protocol-decode', 'protocol-stream-check']);
    assert.equal(tasks[0].schema.id, 'editor.demo'); assert.equal(tasks[0].maxDecodedFields, 32768);
    assert.ok(tasks[0].records[0] instanceof Uint8Array); assert.ok(tasks[1].bytes instanceof Uint8Array);
    assert.equal(f.view.sampleResults[0].ok, false); assert.match(f.view.sampleResults[0].message, /1 帧通过 · 1 处异常 · 剩余 2 字节/);
    f.view.dispose(); assert.equal(disposed, 0);
});

test('sample worker results are ignored after the draft changes', async () => {
    let finish, submitted;
    const taskStarted = new Promise(resolve => { submitted = resolve; });
    const pool = { maxWorkers: 1, runTask: () => new Promise(resolve => { finish = resolve; submitted(); }) };
    const f = fixture({ getWorkerPool: () => pool }); f.view.open(); f.change('sample-name', '旧草稿'); f.change('preview-hex', 'AA 01 0A 34 12 07'); f.action('save-sample').click();
    const checking = f.view.checkSamples();
    await Promise.race([taskStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('worker task was not submitted')), 250))]);
    f.change('field.name', 'updated_flags'); finish([{ valid: true, flatFields: [] }]); await checking;
    assert.deepEqual(f.view.sampleResults, []); assert.match(f.view.status.textContent, /草稿已修改/);
});

test('standalone stream checking yields real tasks between bounded byte chunks', async () => {
    const f = fixture(); f.view.open(); f.change('preview-hex', 'AA 01 0A 34 12 07 '.repeat(3000));
    let rendered = false; const checking = f.view.checkSamples(true);
    setTimeout(() => { rendered = true; }, 0); await checking;
    assert.equal(rendered, true); assert.equal(f.view.sampleResults[0].ok, true);
    assert.match(f.view.sampleResults[0].message, /3000 帧通过/);
});


test('TLV creation includes a visible explicit default branch that preserves other types', () => {
    const f = fixture(); f.view.open(); f.view._addField('tlv');
    const tlv = f.view.draft.messages[0].fields.at(-1), branch = tlv.branches[0];
    assert.equal(branch.default, true); assert.deepEqual(branch.fields, []);
    assert.equal(branch.label, '其它类型（保留原始字节）');
    assert.match(f.root.querySelector('[data-branch-id="' + branch.id + '"]').textContent, /其它类型/);
    assert.equal(JSON.parse(f.view.exportJson()).messages[0].fields.at(-1).branches[0].default, true);
});

test('standalone stream checks count invalid decoded frames and stop on an edited generation', async () => {
    const OriginalParser = Protocol.StreamParser; let appended = 0, cancel;
    Protocol.StreamParser = class {
        get length() { return 0; }
        appendData() { appended++; this.onFrameParsed({ valid: false }); cancel?.(); }
    };
    try {
        const f = fixture(); f.view.open(); f.change('preview-hex', 'AA 01 0A 34 12 07');
        await f.view.checkSamples(true);
        assert.equal(f.view.sampleResults[0].ok, false); assert.match(f.view.sampleResults[0].message, /0 帧通过 · 1 处异常/);
        appended = 0; f.view.sampleResults = []; f.change('preview-hex', 'AA 01 0A 34 12 07 '.repeat(6000));
        cancel = () => f.change('field.name', 'stream_flags');
        await f.view.checkSamples(true);
        assert.equal(appended, 1); assert.deepEqual(f.view.sampleResults, []); assert.match(f.view.status.textContent, /草稿已修改/);
    } finally { Protocol.StreamParser = OriginalParser; }
});


test('valid protocol IDs matching object prototype names support sample persistence', () => {
    for (const id of ['constructor', '__proto__']) {
        let state; const input = schema(); input.id = id;
        const f = fixture({ getEditorState: () => state, onEditorState: value => { state = value; } });
        assert.doesNotThrow(() => f.view.open(input));
        f.change('sample-name', '特殊 ID 样例'); f.change('preview-hex', 'AA 01 0A 34 12 07'); f.action('save-sample').click();
        assert.equal(Object.hasOwn(state.samples, id), true); assert.equal(state.samples[id][0].name, '特殊 ID 样例');
        f.view.close(); assert.doesNotThrow(() => f.view.open(input));
        assert.equal(f.control('sample-select').children.length, 2);
        assert.equal(Object.getPrototypeOf(state.samples), Object.prototype);
    }
});


test('nested header length properties offer the following payload and preserve checksum-inclusive lengths', async () => {
    const f = fixture(); f.view.open({ id: 'nested-length-ui', symbolVersion: 2, schemaVersion: 3, messages: [
        { id: 'frame', byteLength: 0, fields: [
            { id: 'header', name: 'header', type: 'struct', byteLength: 1, fields: [
                { id: 'size', name: 'data_length', type: 'uint8', byteLength: 1 }
            ] },
            { id: 'payload', name: 'payload', type: 'bytes', byteLength: 2 },
            { id: 'sum', name: 'checksum_0', type: 'checksum', byteLength: 1,
                checksum: { type: 'sum', start: { fieldId: 'payload', edge: 'start' }, end: { fieldId: 'sum', edge: 'start' } } }
        ] }
    ] });
    f.root.querySelector('[data-field-id="size"]').click();
    assert.equal(f.control('length.newTarget'), null);
    constraint(f,'length');
    f.change('length.value', 'LEN(payload) + LEN(checksum_0)');
    assert.equal(f.view.applyButton.disabled, false);
    await f.view.apply();
    const bytes = Protocol.encode(f.applied[0], 'frame', { payload: [10,20] });
    assert.deepEqual([...bytes], [3,10,20,30]);
    assert.equal(Protocol.decode(bytes, f.applied[0]).valid, true);
});

test('bound payload length is readonly and jumps directly to the source rule without changing the draft', () => {
    const f = fixture(); f.view.open(rulesSchema());
    f.view._selectField(named(f.view.draft, 'payload'));
    const before = JSON.stringify(f.view.draft), history = f.view.history.length;
    assert.equal(f.control('field.lengthMode'), null);
    assert.equal(f.control('field.lengthSource.fieldId'), null);
    assert.match(f.view.propertyHost.textContent, /长度来源.*data_length/s);
    f.action('jump-length-source').click();
    assert.equal(f.view.selectedField.id, 'size');
    assert.ok(f.document.activeElement.closest('[data-rule-group="length"]'));
    assert.equal(JSON.stringify(f.view.draft), before);
    assert.equal(f.view.history.length, history);
});

test('payload lists covering checksum fields and jumps directly to their rule without changing legacy settings', async () => {
    const f = fixture(); f.view.open(rulesSchema());
    const before = JSON.stringify(f.view.draft);
    f.view._selectField(named(f.view.draft, 'payload'));
    const coverage = f.root.querySelector('[data-checksum-coverage="sum"]');
    assert.ok(coverage); assert.match(coverage.textContent, /完整覆盖/);
    coverage.querySelector('button').click();
    assert.equal(f.view.selectedField.id, 'sum');
    assert.ok(f.document.activeElement.closest('[data-rule-group="checksum"]'));
    assert.equal(JSON.stringify(f.view.draft), before);
    await f.view.apply(); assert.equal(JSON.stringify(f.applied[0]), before);
    constraint(f, 'data');
    f.view._selectField(named(f.view.draft, 'payload'));
    assert.equal(f.root.querySelector('[data-checksum-coverage="sum"]'), null);
    assert.match(f.view.propertyHost.textContent, /暂无关联规则/);
});

test('legacy nested length expressions are edited at their numerical source with target-scoped completion', () => {
    const f = fixture(); f.view.open({ id: 'legacy-nested-expression', schemaVersion: 3, symbolVersion: 2, messages: [{
        id: 'frame', byteLength: 0, fields: [
            { id: 'header', name: 'header', type: 'struct', byteLength: 1, fields: [
                { id: 'size', name: 'size', type: 'uint8', byteLength: 1 }
            ] },
            { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'header.size - 1' }
        ]
    }] });
    const before = JSON.stringify(f.view.draft);
    f.view._selectField(named(f.view.draft, 'body'));
    assert.equal(f.control('field.lengthFrom'), null);
    f.action('jump-length-source').click();
    assert.equal(f.view.selectedField.id, 'size');
    const input = f.control('length.expression.body'); assert.ok(input);
    input.value = ''; input.setSelectionRange(0, 0);
    input.dispatchEvent({ type: 'keydown', key: ' ', ctrlKey: true });
    const list = f.root.querySelectorAll('.protocol-autocomplete').find(node => !node.hidden);
    assert.ok(list); assert.match(list.textContent, /header.size/);
    assert.equal(JSON.stringify(f.view.draft), before);
    f.change('length.expression.body', 'header.size - 2');
    assert.equal(f.view.applyButton.disabled, false);
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', { header: { size: 4 }, body: [10,20] })], [4,10,20]);
    f.action('undo').click(); assert.equal(JSON.stringify(f.view.draft), before);
});

test('legacy duplicate length attributes expose only the effective expression and preserve inactive compatibility data', () => {
    const f = fixture(); f.view.open({ id: 'legacy-length-properties', framing: { fixedLength: 4 }, messages: [{ id: 'frame', fields: [
        { id: 'size', name: 'size', type: 'uint8' }, { id: 'body', name: 'body', type: 'bytes', length: 'size' }
    ] }] });
    f.view._selectField(named(f.view.draft, 'size'));
    assert.equal(f.view.propertyHost.querySelectorAll('[data-control="length.expression.body"]').length, 1);
    assert.equal(named(f.view.draft, 'body').length, 'size');
    f.change('length.expression.body', 'size - 1');
    assert.equal(named(f.view.draft, 'body').lengthFrom, 'size - 1');
    assert.equal(named(f.view.draft, 'body').length, 'size');
    const wire = Protocol.encode(f.view.draft, 'frame', { size: 4, body: [10,20,30] });
    assert.deepEqual([...wire], [4,10,20,30]);
    assert.equal(Protocol.decode(wire, f.view.draft).valid, true);
});

test('length source config owns bindings and consumers link back without a second selector', () => {
    const f = fixture(); f.view.open(ProtocolModel.bindLengthTarget({ id: 'length-ui', symbolVersion: 2, schemaVersion: 3, messages: [{ id: 'frame', byteLength: 4, fields: [
        { id: 'size', name: 'data_length', type: 'uint8', byteLength: 1 },
        { id: 'payload', name: 'payload', type: 'bytes', byteLength: 3 }
    ] }] }, 'size', 'payload', { adjustment: -1 }));
    f.root.querySelector('[data-field-id="size"]').click();
    assert.equal(f.control('field.role').getAttribute('aria-label'), '内容约束');
    assert.deepEqual(f.control('field.role').children.map(option => option.value), ['data', 'fixed', 'length', 'checksum']);
    assert.ok(f.root.querySelector('.protocol-length-targets'));
    assert.equal(f.view.applyButton.disabled, false, 'showing length association does not create an incomplete source');
    assert.equal(f.view.selectedField.id, 'size');
    assert.equal(f.view.applyButton.disabled, false);
    assert.equal(f.control('length.0.unit'), null);
    assert.equal(ProtocolModel.findField(f.view.draft, 'payload').lengthSource.adjustment, -1);
    f.change('field.role', 'fixed'); assert.ok(f.action('confirm-content-constraint')); f.action('cancel-content-constraint').click();
    f.root.querySelector('[data-field-id="payload"]').click();
    assert.ok(!f.root.querySelector('[data-control="field.lengthSource.fieldId"]'));
    assert.match(f.root.textContent, /data_length/);
    f.action('jump-length-source').click(); assert.equal(f.view.selectedField.id, 'size');
    assert.ok(f.root.querySelector('.reserved-names-help'));
    f.change('field.name', 'FRAME_LENGTH'); assert.match(f.view.alert.textContent, /保留/);
    assert.equal(f.view.selectedField.name, 'data_length');
});

function rulesSchema() {
    return { id: 'independent-rules', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
        id: 'frame', byteLength: 0, lengthSource: { fieldId: 'size', unit: 1, adjustment: 4 }, fields: [
            { id: 'sync', name: 'sync', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
            { id: 'size', name: 'data_length', type: 'uint8', byteLength: 1, role: 'length' },
            { id: 'body', name: 'payload', type: 'bytes', byteLength: 0, lengthSource: { fieldId: 'size', unit: 1, adjustment: 0 } },
            { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1, checksum: { type: 'sum',
                start: { fieldId: 'sync', edge: 'start' }, end: { fieldId: 'sum', edge: 'start' } } },
            { id: 'end', name: 'end', type: 'fixed', byteLength: 1, bytes: [13], framingRole: 'end' }
        ]
    }] };
}

test('content constraints and independent rules show legacy state without rewriting protocol references', async () => {
    const f = fixture(); f.view.open(rulesSchema()); const before = JSON.stringify(f.view.draft);
    f.view._selectField(named(f.view.draft, 'data_length'));
    assert.equal(f.control('field.role').value, 'length');
    assert.ok(f.root.querySelector('.protocol-length-targets').closest('.protocol-content-constraints'));
    assert.equal(f.control('length.0.adjustment'), null);
    assert.match(f.view.propertyHost.textContent, /本字段值 × 1 \+ \(4\)/);
    f.view._selectField(named(f.view.draft, 'sum'));
    assert.equal(f.control('field.role').value, 'checksum'); assert.equal(f.control('field.checksum.enabled'), null);
    assert.ok(f.control('field.checksum.type').closest('.protocol-checksum-rules'));
    assert.equal(f.control('field.checksum.end.fieldId').value, 'sum');
    assert.equal(JSON.stringify(f.view.draft), before, 'display-only navigation preserves the saved rule representation');
    await f.view.apply(); assert.equal(JSON.stringify(f.applied[0]), before);
    const wire = Protocol.encode(f.applied[0], 'frame', { payload: [10,20] });
    assert.deepEqual([...wire], [170,2,10,20,202,13]);
    assert.equal(Protocol.decode(wire, f.applied[0]).valid, true);
});

test('canvas usage hints identify real rules and jump to their own property groups', () => {
    const f = fixture(); f.view.open(rulesSchema());
    const source = f.root.querySelector('[data-field-id="size"]');
    const length = source.querySelector('[data-field-usage="length"]');
    assert.match(length.textContent, /长度.*payload/); length.click();
    assert.equal(f.view.selectedField.id, 'size');
    assert.ok(f.document.activeElement.closest('.protocol-length-targets'));
    const checksum = f.root.querySelector('[data-field-id="sum"]').querySelector('[data-field-usage="checksum"]');
    assert.equal(checksum.textContent, '校验 · SUM8'); checksum.click();
    assert.equal(f.view.selectedField.id, 'sum'); assert.ok(f.document.activeElement.closest('.protocol-checksum-rules'));
    assert.match(f.root.querySelector('[data-field-id="sync"]').querySelector('[data-field-usage="fixed"]').textContent, /固定/);
    constraint(f, 'data');
    assert.equal(f.root.querySelector('[data-field-id="sum"]').querySelector('[data-field-usage="checksum"]'), null);
    f.action('undo').click(); assert.ok(f.root.querySelector('[data-field-id="sum"]').querySelector('[data-field-usage="checksum"]'));
});

test('checksum toggles preserve identity and external boundary references and reject incompatible content', () => {
    const f = fixture(); f.view.open(rulesSchema()); f.view._selectField(named(f.view.draft, 'sum'));
    f.change('field.role', 'fixed'); assert.equal(f.view.selectedField.type, 'checksum'); assert.ok(f.action('confirm-content-constraint')); f.action('cancel-content-constraint').click();
    constraint(f, 'data');
    assert.equal(f.view.selectedField.id, 'sum'); assert.equal(f.view.selectedField.name, 'sum');
    assert.equal(f.view.selectedField.type, 'uint8');
    assert.equal(ProtocolModel.findField(f.view.draft, 'body').lengthSource.fieldId, 'size');
    f.action('undo').click(); assert.equal(f.view.selectedField.type, 'checksum');
    assert.equal(f.view.selectedField.checksum.end.fieldId, 'sum');
    f.view._selectField(named(f.view.draft, 'data_length'));
    f.change('field.role', 'checksum'); assert.equal(f.view.selectedField.type, 'uint8');
    f.action('cancel-content-constraint').click(); assert.equal(ProtocolModel.findField(f.view.draft, 'body').lengthSource.fieldId, 'size');
});

test('disabled checksum settings survive re-enabling and renaming without changing byte-boundary identities', () => {
    const f = fixture(); f.view.open(rulesSchema()); f.view._selectField(named(f.view.draft, 'sum'));
    f.change('field.checksum.type', 'xor');
    constraint(f, 'data'); assert.equal(f.control('field.checksum.type'), null);
    f.change('field.name', 'check_value');
    constraint(f, 'checksum');
    assert.equal(f.control('field.checksum.type').value, 'xor');
    assert.equal(f.view.selectedField.id, 'sum'); assert.equal(f.view.selectedField.checksum.end.fieldId, 'sum');
    f.view._selectField(named(f.view.draft, 'data_length')); f.change('field.name', 'payload_size');
    assert.equal(ProtocolModel.findField(f.view.draft, 'body').lengthSource.fieldId, 'size');
    const bytes = Protocol.encode(f.view.draft, 'frame', { payload: [10,20] });
    assert.deepEqual([...bytes], [170,2,10,20,182,13]);
    const record = Protocol.decode(bytes, f.view.draft);
    assert.equal(record.fields.payload_size, 2); assert.equal(record.fields.check_value, 182);
});

test('removing the final length association clears its legacy role without touching other references', () => {
    const schema = ProtocolModel.bindLengthTarget({ id: 'remove-length', symbolVersion: 2, schemaVersion: 3, messages: [{
        id: 'frame', byteLength: 0, fields: [{ id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
            { id: 'body', name: 'body', type: 'bytes', byteLength: 2 }]
    }] }, 'size', 'body');
    const f = fixture(); f.view.open(schema); f.view._selectField(named(f.view.draft, 'size'));
    f.action('remove-length-target-0').click();
    assert.equal(f.view.selectedField.role, undefined);
    assert.equal(f.root.querySelector('[data-field-id="size"]').querySelector('[data-field-usage="length"]'), null);
    f.view._selectField(named(f.view.draft, 'body')); f.change('field.byteLength', '2');
    assert.equal(f.view.applyButton.disabled, false);
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', { size: 9, body: [1,2] })], [9,1,2]);
    f.action('undo').click(); f.action('undo').click();
    assert.equal(ProtocolModel.findField(f.view.draft, 'body').lengthSource.fieldId, 'size');
});

test('length usage hints include expression consumers and nested scoped references', () => {
    const f = fixture(); f.view.open({ id: 'expression-usage', schemaVersion: 3, symbolVersion: 2, messages: [{
        id: 'frame', byteLength: 4, fields: [{ id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
            { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'size' }]
    }] });
    const hint = f.root.querySelector('[data-field-id="size"]').querySelector('[data-field-usage="length"]');
    assert.equal(hint.textContent, '长度 → body'); hint.click();
    assert.match(f.root.querySelector('.protocol-length-targets').textContent, /查看长度表达式.*body/);
    const nested = { id: 'nested-usage', schemaVersion: 3, symbolVersion: 2, messages: [{ id: 'frame', byteLength: 5, fields: [
        { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
        { id: 'group', name: 'group', type: 'struct', byteLength: 4, fields: [
            { id: 'body', name: 'body', type: 'bytes', byteLength: 0, lengthFrom: 'PARENT.size' },
            { id: 'copy', name: 'copy', type: 'bytes', byteLength: 0, lengthFrom: 'LEN(CURRENT.body)' }
        ] }
    ] }] };
    f.view.open(nested);
    assert.match(f.root.querySelector('[data-field-id="size"]').querySelector('[data-field-usage="length"]').textContent, /body/);
    f.root.querySelector('[data-field-id="body"]').querySelector('[data-field-usage="length"]').click();
    assert.equal(f.view.selectedField.id, 'body');
    assert.equal(f.view.propertyHost.querySelectorAll('[data-rule-group="length"]').length, 1, 'a variable field has one group for its own length and its consumers');
    assert.equal(f.control('field.lengthMode'), null);
    assert.ok(f.action('jump-length-source'));
});

test('viewing legacy implicit checksum defaults does not create a draft edit or rewrite configuration', () => {
    const f = fixture(); f.view.open({ id: 'implicit-checksum', schemaVersion: 3, symbolVersion: 2, messages: [{ id: 'frame', byteLength: 2,
        fields: [{ id: 'value', name: 'value', type: 'uint8', byteLength: 1 }, { id: 'sum', name: 'sum', type: 'checksum', byteLength: 1 }]
    }] });
    const before = JSON.stringify(f.view.draft), count = f.drafts.length;
    f.view._selectField(named(f.view.draft, 'sum'));
    assert.equal(f.control('field.checksum.type').value, 'sum'); assert.equal(JSON.stringify(f.view.draft), before);
    assert.equal(f.drafts.length, count);
    f.change('field.checksum.end.include', false);
    assert.equal(f.view.selectedField.checksum.end.fieldId, 'sum');
    f.action('undo').click(); assert.equal(JSON.stringify(f.view.draft), before);
});


test('data segment and frame bindings remain protected until explicitly removed at the source', () => {
    const f = fixture(); f.view.open(ProtocolModel.bindLengthTarget({ id: 'bound-width', symbolVersion: 2, schemaVersion: 3,
        messages: [{ id: 'frame', fields: [{ id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
            { id: 'data', name: 'data', type: 'bytes', byteLength: 2 }] }] }, 'size', 'data'));
    f.root.querySelector('[data-field-id="data"]').click();
    f.change('field.byteLength', '2'); assert.equal(f.view.selectedField.byteLength, 0);
    assert.match(f.view.alert.textContent, /解除/);
    f.view.draft = ProtocolModel.bindLengthTarget(f.view.draft, 'size', 'frame', { adjustment: 1 });
    f.view.framingSelected = true; f.view.selectedField = null; f.view._renderMessages();
    f.change('frame.lengthFrom', '3');
    assert.equal(f.view.draft.messages[0].lengthSource.fieldId, 'size');
    f.action('jump-length-source').click();
    const frameBinding = ProtocolModel.getLengthBindings(f.view.draft, 'size').findIndex(binding => binding.targetId === 'frame');
    f.action('remove-length-target-' + frameBinding).click();
    f.action('select-frame').click();
    f.change('frame.lengthFrom', '3'); assert.equal(f.view.draft.messages[0].byteLength, 0);
    assert.equal(f.view.draft.messages[0].lengthFrom, '3');
    assert.equal(f.view.draft.messages[0].lengthSource, undefined);
    assert.equal(ProtocolModel.findField(f.view.draft, 'data').lengthSource.fieldId, 'size');
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', { data: [11,22] })], [2,11,22]);
});

test('one frame expression supports fixed arithmetic auto sizing and invalid input without changing fixed-frame bytes', () => {
    const s = { id: 'single-length', schemaVersion: 3, symbolVersion: 2, framing: { maxLength: 64 }, messages: [{
        id: 'frame', byteLength: 4, fields: [{ id: 'value', name: 'value', type: 'uint32', byteLength: 4 }]
    }] };
    const f = fixture(); f.view.open(s); f.action('select-frame').click();
    assert.equal(f.control('frame.lengthFrom').value, '4');
    const original = [...Protocol.encode(f.view.draft, 'frame', { value: 4660 })];
    assert.deepEqual(original, [52,18,0,0]);
    f.change('frame.lengthFrom', '2 + 2');
    assert.equal(f.action('apply').disabled, false);
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', { value: 4660 })], original);
    f.change('frame.lengthFrom', '0');
    assert.equal(f.view.draft.messages[0].lengthFrom, undefined);
    assert.equal(f.control('frame.lengthFrom').value, '0');
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', { value: 4660 })], original);
    for (const value of ['', '  ', '-1', '1.5', '65', 'missing + 1']) {
        f.change('frame.lengthFrom', value); assert.equal(f.action('apply').disabled, true, value);
    }
    f.change('frame.lengthFrom', '4'); assert.equal(f.action('apply').disabled, false);
});

test('protocol expression completion inserts functions and dotted field paths with keyboard and mouse', () => {
    const f = fixture(); f.view.open({ id: 'completion', schemaVersion: 3, symbolVersion: 2, messages: [{
        id: 'frame', byteLength: 3, fields: [
            { id: 'header', name: 'header', type: 'struct', byteLength: 1, fields: [{ id: 'count', name: 'count', type: 'uint8', byteLength: 1 }] },
            { id: 'payload', name: 'payload', type: 'bytes', byteLength: 2 }
        ]
    }] });
    f.action('select-frame').click();
    const input = f.control('frame.lengthFrom');
    const type = (value, caret = value.length) => { input.value = value; input.setSelectionRange(caret, caret); input.dispatchEvent({ type: 'input' }); };
    const popup = () => f.root.querySelectorAll('.protocol-autocomplete').find(node => !node.hidden);
    type('32'); assert.equal(popup(), undefined, 'numeric literals do not offer identifier completion');
    type('LEN(payload)', 2); input.dispatchEvent({ type: 'keydown', key: 'Tab' });
    assert.equal(input.value, 'LEN(payload)', 'an existing parenthesis is reused');
    type('LE'); assert.ok(popup(), 'completion is visible inside the modal');
    input.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true });
    assert.equal(input.value, 'LEN()'); assert.equal(input.selectionStart, 4);
    type('LEN(pay) + 1', 7);
    const choice = popup().querySelector('[role="option"]'); assert.ok(choice.textContent.includes('payload'));
    assert.equal(popup().textContent.includes('MIN'), false, 'LEN arguments only suggest field paths');
    choice.click(); assert.equal(input.value, 'LEN(payload) + 1');
    type('header.coun + 2', 11);
    input.dispatchEvent({ type: 'keydown', key: 'Tab' });
    assert.equal(input.value, 'header.count + 2', 'the whole dotted token is replaced');
    assert.equal(f.view.draft.messages[0].byteLength, 3, 'typing suggestions does not commit incomplete drafts');
    input.dispatchEvent({ type: 'change' }); assert.equal(f.action('apply').disabled, false);
    assert.equal(f.view.draft.messages[0].lengthFrom, 'header.count + 2');
});

test('expression suggestions refresh after renaming and omit unrelated name and data controls', () => {
    const f = fixture(); f.view.open(branchingSchema()); f.view._selectField(named(f.view.draft, 'tag'));
    assert.equal(f.control('field.name').getAttribute('aria-autocomplete'), null);
    f.change('field.name', 'command_id');
    f.view._selectField(named(f.view.draft, 'payload'));
    const input = f.control('field.selector'); input.value = 'comm'; input.setSelectionRange(4, 4);
    input.dispatchEvent({ type: 'input' });
    const popup = f.root.querySelectorAll('.protocol-autocomplete').find(node => !node.hidden);
    assert.ok(popup.textContent.includes('command_id'));
    input.dispatchEvent({ type: 'keydown', key: 'Tab' }); assert.equal(input.value, 'command_id');
    input.dispatchEvent({ type: 'change' }); assert.equal(f.action('apply').disabled, false);
});

test('nested expression completion offers decoded current and parent fields without later siblings', () => {
    const f = fixture(); f.view.open({ id: 'nested-completion', schemaVersion: 3, symbolVersion: 2, messages: [{
        id: 'frame', byteLength: 5, fields: [
            { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
            { id: 'payload', name: 'payload', type: 'struct', byteLength: 3, fields: [
                { id: 'count', name: 'count', type: 'uint8', byteLength: 1 },
                { id: 'body', name: 'body', type: 'bytes', byteLength: 2 }
            ] },
            { id: 'tail', name: 'tail', type: 'uint8', byteLength: 1 }
        ]
    }] });
    f.view._selectField(named(f.view.draft, 'body'));
    const input = f.control('field.condition');
    input.value = ''; input.setSelectionRange(0, 0); input.dispatchEvent({ type: 'input' });
    const popup = () => f.root.querySelectorAll('.protocol-autocomplete').find(node => !node.hidden);
    const text = popup().textContent;
    assert.ok(text.includes('CURRENT.count')); assert.ok(text.includes('PARENT.size'));
    assert.equal(text.includes('tail'), false); assert.equal(text.includes('body'), false);
    input.value = 'CURRENT.c'; input.setSelectionRange(9, 9); input.dispatchEvent({ type: 'input' });
    input.dispatchEvent({ type: 'keydown', key: 'Tab' }); assert.equal(input.value, 'CURRENT.count');
    input.dispatchEvent({ type: 'change' }); assert.equal(f.action('apply').disabled, false);
});

test('protocol completions follow scope, edits and lifecycle without intercepting application shortcuts', async () => {
    const f = fixture(); f.view.open(branchingSchema());
    f.view._selectField(named(f.view.draft, 'payload'));
    const input = f.control('field.selector');
    input.value = ''; input.setSelectionRange(0, 0);
    input.dispatchEvent({ type: 'keydown', key: ' ', ctrlKey: true });
    const visible = () => f.root.querySelectorAll('.protocol-autocomplete').filter(node => !node.hidden);
    assert.equal(visible().length, 1);
    assert.ok(visible()[0].textContent.includes('tag'));
    assert.equal(visible()[0].textContent.includes('value'), false, 'unread branch children are not in selector scope');
    input.dispatchEvent({ type: 'compositionstart' }); assert.equal(visible().length, 0);
    input.value = 'ta'; input.setSelectionRange(2, 2); input.dispatchEvent({ type: 'input', isComposing: true });
    assert.equal(visible().length, 0);
    input.dispatchEvent({ type: 'compositionend' }); assert.equal(visible().length, 1);
    input.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    assert.equal(visible().length, 0); assert.equal(f.view.opened, true);
    input.dispatchEvent({ type: 'input' });
    f.view.propertyHost.dispatchEvent({ type: 'scroll' }); assert.equal(visible().length, 0);
    input.value = 'tag'; input.setSelectionRange(3, 3); input.dispatchEvent({ type: 'input' });
    input.dispatchEvent({ type: 'keydown', key: 'Enter', ctrlKey: true, bubbles: true });
    await settle(); assert.equal(f.applied.length, 1, 'Ctrl+Enter still applies the protocol');
    f.view._renderMessages();
    assert.equal(input.getAttribute('aria-controls'), null, 'replaced inputs release autocomplete bindings');
    f.view.close(); assert.equal(visible().length, 0);
    f.view.dispose(); assert.equal(f.root.querySelectorAll('.protocol-autocomplete').length, 0);
});


test('one field radix controls branch literals and canvas rules while structural parameters stay decimal', () => {
    const f = fixture(); f.view.open({ id: 'radix-branch', schemaVersion: 3, messages: [{ id: 'frame', byteLength: 2, fields: [
        { id: 'tag', name: 'tag', type: 'uint8', byteLength: 1 },
        { id: 'payload', name: 'payload', type: 'choice', byteLength: 1, selector: 'tag', branches: [
            { id: 'branch', equals: 10, fields: [{ id: 'value', name: 'value', type: 'uint8', byteLength: 1 }] }
        ] }
    ] }] });
    f.root.querySelector('[data-field-id="payload"]').click();
    f.change('field.displayBase', 'hex');
    assert.equal(f.control('branch.0.equals').value, '0xA');
    assert.equal(f.control('field.byteLength').value, '1');
    f.change('branch.0.equals', '10');
    assert.equal(ProtocolModel.findField(f.view.draft, 'payload').branches[0].equals, 16);
    assert.match(f.root.querySelector('.protocol-branch-rule').textContent, /0x10/);
    f.change('branch.0.mode', 'range'); f.change('branch.0.range.0', 'F'); f.change('branch.0.range.1', '1F');
    assert.deepEqual(ProtocolModel.findField(f.view.draft, 'payload').branches[0].range, [15,31]);
    f.change('branch.0.mode', 'mask'); f.change('branch.0.mask.mask', 'FF'); f.change('branch.0.mask.value', '1A');
    f.change('field.displayBase', 'dec');
    assert.equal(f.control('branch.0.mask.mask').value, '255'); assert.equal(f.control('branch.0.mask.value').value, '26');
    f.change('branch.0.mode', 'expression'); f.change('branch.0.expression', 'tag == 0x10'); f.change('field.displayBase', 'hex');
    assert.equal(f.control('branch.0.expression').value, 'tag == 0x10');
    f.root.querySelector('[data-field-id="value"]').click(); assert.equal(f.control('field.displayBase').value, 'dec');
});

test('fixed byte editing follows the field radix without changing bytes on presentation switches', () => {
    const f = fixture(); f.view.open({ id: 'radix-fixed', schemaVersion: 3, messages: [{ id: 'frame', byteLength: 2, fields: [
        { id: 'marker', name: 'marker', type: 'fixed', byteLength: 2, bytes: [170,85] }
    ] }] });
    assert.equal(f.control('field.displayBase').value, 'hex');
    assert.equal(f.control('field.bytes').value, 'AA 55');
    f.change('field.displayBase', 'dec'); assert.equal(f.control('field.bytes').value, '170 85');
    f.change('field.bytes', '255 0'); assert.deepEqual(f.view.selectedField.bytes, [255,0]);
    f.change('field.bytes', '256 0'); assert.match(f.view.alert.textContent, /255|范围/);
    assert.deepEqual(f.view.selectedField.bytes, [255,0]);
    f.change('field.displayBase', 'hex'); assert.equal(f.control('field.bytes').value, 'FF 00');
    assert.deepEqual([...Protocol.encode(f.view.draft, 'frame', {})], [255,0]);
});

test('radix changes preserve exact64 enum keys and bit enums follow their owning field', () => {
    const f = fixture(); f.view.open({ id: 'radix-wide', schemaVersion: 3, messages: [{ id: 'frame', byteLength: 9, fields: [
        { id: 'wide', name: 'wide', type: 'uint64', byteLength: 8, enum: { '18446744073709551615': '最大值' } },
        { id: 'bits', name: 'flags', type: 'bitfield', byteLength: 1, bits: [{ name: 'low', type: 'uint', offset: 0, length: 4, enum: { 10: '低位' } }] }
    ] }] });
    f.change('field.displayBase', 'hex'); assert.equal(f.control('field.enum.0.value').value, '0xFFFFFFFFFFFFFFFF');
    f.change('field.enum.0.value', '10000000000000000'); assert.match(f.view.alert.textContent, /范围/);
    f.change('field.enum.0.value', '8000000000000000'); assert.equal(f.view.selectedField.enum['9223372036854775808'], '最大值');
    f.root.querySelector('[data-field-id="bits"]').click(); f.change('field.displayBase', 'hex');
    assert.equal(f.control('bit.0.enum.0.value').value, '0xA');
    f.change('bit.0.enum.0.value', 'F'); assert.equal(f.view.selectedField.bits[0].enum[15], '低位');
    assert.equal(f.control('bit.0.offset').value, '0'); assert.equal(f.control('bit.0.length').value, '4');
});

test('CRC literal configuration follows the field radix while checksum boundaries stay decimal', () => {
    const f = fixture(); f.view.open({ id: 'radix-crc', schemaVersion: 3, messages: [{ id: 'frame', byteLength: 3, fields: [
        { id: 'v', name: 'value', type: 'uint8', byteLength: 1 },
        { id: 'crc', name: 'crc', type: 'checksum', byteLength: 2, checksum: { type: 'crc16', polynomial: 4129, init: 65535,
            xorOut: 0, start: 0, end: { fieldId: 'crc', edge: 'start' } } }
    ] }] });
    f.root.querySelector('[data-field-id="crc"]').click(); f.change('field.displayBase', 'hex');
    assert.equal(f.control('field.checksum.polynomial').value, '0x1021');
    assert.equal(f.control('field.checksum.init').value, '0xFFFF');
    f.change('field.checksum.xorOut', 'FF'); assert.equal(f.view.selectedField.checksum.xorOut, 255);
    f.change('field.displayBase', 'dec'); assert.equal(f.control('field.checksum.xorOut').value, '255');
    assert.equal(f.control('field.byteLength').value, '2');
});

test('field names are the only visible names and legacy display labels survive save and rename', async () => {
    const f = fixture(); f.view.open({ id: 'names-only', schemaVersion: 3, messages: [{ id: 'frame', byteLength: 1, fields: [
        { id: 'v', name: 'value', label: '旧的显示名称', type: 'uint8', byteLength: 1 }
    ] }] });
    assert.ok(!f.control('field.label'));
    assert.equal(f.root.querySelector('.protocol-field-select').textContent, 'value');
    assert.ok(!f.view.propertyHost.textContent.includes('旧的显示名称'));
    f.change('field.name', 'reading');
    assert.equal(f.root.querySelector('.protocol-field-select').textContent, 'reading');
    assert.equal(f.view.selectedField.label, '旧的显示名称');
    await f.view.apply(); assert.equal(f.applied[0].messages[0].fields[0].label, '旧的显示名称');
});


test('imported exact Hex literals reformat as decimal without changing their stored value', () => {
    const f = fixture(); f.view.open({ id: 'imported-radix', schemaVersion: 3, messages: [{ id: 'frame', byteLength: 9, fields: [
        { id: 'tag', name: 'tag', type: 'uint64', byteLength: 8 },
        { id: 'choice', name: 'choice', type: 'choice', byteLength: 1, selector: 'tag', displayBase: 'hex', branches: [
            { id: 'branch', equals: '0xFFFFFFFFFFFFFFFF', fields: [{ id: 'v', name: 'v', type: 'uint8', byteLength: 1 }] }
        ] }
    ] }] });
    f.root.querySelector('[data-field-id="choice"]').click(); f.change('field.displayBase', 'dec');
    assert.equal(f.control('branch.0.equals').value, '18446744073709551615');
    assert.equal(f.view.selectedField.branches[0].equals, '0xFFFFFFFFFFFFFFFF');
    assert.match(f.root.querySelector('.protocol-branch-rule').textContent, /18446744073709551615/);
});
