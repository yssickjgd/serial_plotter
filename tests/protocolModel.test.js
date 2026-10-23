'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProtocolModel: M } = require('../protocolModel');

test('qualified references also follow a renamed intermediate segment', () => {
    const source = { id: 'nested-path', framing: { fixedLength: 3 }, messages: [{ id: 'm', fields: [
        { id: 'outer', name: 'outer', type: 'struct', fields: [{ id: 'middle', name: 'segment', type: 'struct', fields: [{ id: 'leaf', name: 'n', type: 'uint8' }] }] },
        { id: 'payload', name: 'payload', type: 'bytes', length: 'outer.segment.n' }
    ] }] };
    const result = M.renameField(source, 'middle', { name: 'block' }).protocol;
    assert.equal(M.findField(result, 'payload').length, 'outer.block.n');
    const { Protocol } = require('../protocolEngine');
    assert.equal(Protocol.decode([2, 7, 8], result).valid, true);
});

test('nested shadowing retains local identifiers while renaming explicit outer parent references', () => {
    const source = { id: 'scope', framing: { fixedLength: 4 }, messages: [{ id: 'm', fields: [
        { id: 'outer', name: 'n', type: 'uint8' },
        { id: 'segment', name: 'segment', type: 'struct', fields: [
            { id: 'inner', name: 'n', type: 'uint8', condition: 'n > 0' },
            { id: 'value', name: 'value', type: 'bytes', length: 'parent.n', condition: 'n > 0' }
        ] }
    ] }] };
    const result = M.renameField(source, 'outer', { name: 'count' }).protocol;
    assert.equal(M.findField(result, 'inner').condition, 'count > 0', 'a field condition is evaluated before its value shadows the outer variable');
    assert.equal(M.findField(result, 'value').length, 'parent.count');
    assert.equal(M.findField(result, 'value').condition, 'n > 0', 'bare n still belongs to the nested local');
    const { Protocol } = require('../protocolEngine');
    assert.equal(Protocol.decode([2, 1, 7, 8], result).valid, true);
});

test('renaming TLV header variables updates the selector, automatic length binding and value expressions', () => {
    const source = { id: 'tlv', framing: { fixedLength: 4 }, messages: [{ id: 'm', fields: [{ id: 'items', name: 'items', type: 'tlv', until: 'end',
        headerFields: [{ id: 'tag', name: 'tag', type: 'uint8' }, { id: 'size', name: 'size', type: 'uint8' }],
        selector: 'tag', lengthField: 'size', branches: [{ id: 'value', expression: 'tag == 1', fields: [{ id: 'raw', name: 'raw', type: 'bytes', length: 'parent.size', condition: 'size > 0' }] }] }] }] };
    const renamedTag = M.renameField(source, 'tag', { name: 'kind' });
    const owner = M.findField(renamedTag.protocol, 'items');
    assert.equal(owner.selector, 'kind'); assert.equal(owner.branches[0].expression, 'kind == 1');
    assert.ok(renamedTag.references.some(reference => reference.nodeId === 'items' && reference.property === 'selector'));
    const renamedSize = M.renameField(renamedTag.protocol, 'size', { name: 'bytes' });
    const changed = M.findField(renamedSize.protocol, 'items');
    assert.equal(changed.lengthField, 'bytes'); assert.equal(changed.branches[0].fields[0].length, 'parent.bytes');
    assert.equal(changed.branches[0].fields[0].condition, 'bytes > 0');
    assert.equal(M.findField(source, 'items').selector, 'tag', 'source snapshot remains unchanged');
});

test('renaming a nested field follows its stable identity through later qualified paths', () => {
    const source = { id: 'qualified', framing: { fixedLength: 4 }, messages: [{ id: 'm', fields: [
        { id: 'segment', name: 'segment', type: 'struct', fields: [{ id: 'leaf', name: 'n', type: 'uint8' }] },
        { id: 'other', name: 'other', type: 'struct', fields: [{ id: 'other-leaf', name: 'n', type: 'uint8' }] },
        { id: 'payload', name: 'payload', type: 'bytes', length: 'segment.n' }
    ] }] };
    const result = M.renameField(source, 'leaf', { name: 'count' });
    assert.equal(M.findField(result.protocol, 'payload').length, 'segment.count');
    assert.equal(M.findField(result.protocol, 'other-leaf').name, 'n');
    assert.ok(result.references.some(ref => ref.nodeId === 'payload' && ref.property === 'length'));
    const { Protocol } = require('../protocolEngine');
    assert.equal(Protocol.decode([2, 1, 7, 8], result.protocol).valid, true);
});

test('qualified paths resolve indexed repeats and explicit parent scope without replacing another leaf', () => {
    const source = { id: 'indexed', framing: { fixedLength: 4 }, messages: [{ id: 'm', fields: [
        { id: 'items', name: 'items', type: 'repeat', count: 1,
            fields: [{ id: 'item-leaf', name: 'n', type: 'uint8' }] },
        { id: 'other', name: 'other', type: 'struct', fields: [{ id: 'other-leaf', name: 'n', type: 'uint8' }] },
        { id: 'wrapper', name: 'wrapper', type: 'struct', fields: [
            { id: 'data', name: 'data', type: 'bytes', length: 'parent.items[0].n + other.n - other.n' }
        ] }
    ] }] };
    const { protocol } = M.renameField(source, 'item-leaf', { name: 'size' });
    assert.equal(M.findField(protocol, 'data').length, 'parent.items[0].size + other.n - other.n');
    assert.equal(M.findField(protocol, 'other-leaf').name, 'n');
});

test('shared structure definitions rename only paths reaching that definition', () => {
    const source = { id: 'shared-path', framing: { fixedLength: 5 },
        structures: { Pair: [{ id: 'shared-leaf', name: 'n', type: 'uint8' }] },
        messages: [{ id: 'm', fields: [
            { id: 'left', name: 'left', type: 'struct', ref: 'Pair' },
            { id: 'right', name: 'right', type: 'struct', ref: 'Pair' },
            { id: 'independent', name: 'independent', type: 'struct', fields: [{ id: 'local-leaf', name: 'n', type: 'uint8' }] },
            { id: 'value', name: 'value', type: 'bytes', length: 'left.n + right.n - independent.n' }
        ] }] };
    const { protocol } = M.renameField(source, 'shared-leaf', { name: 'count' });
    assert.equal(M.findField(protocol, 'value').length, 'left.count + right.count - independent.n');
    assert.equal(M.findField(protocol, 'local-leaf').name, 'n');
});

test('ambiguous branch paths stay unchanged and produce one unresolved diagnostic', () => {
    const source = { id: 'ambiguous-path', messages: [{ id: 'm', fields: [
        { id: 'choice', name: 'choice', type: 'choice', selector: 'kind', branches: [
            { id: 'a', equals: 1, fields: [{ id: 'a-n', name: 'n', type: 'uint8' }] },
            { id: 'b', default: true, fields: [{ id: 'b-n', name: 'n', type: 'uint8' }] }
        ] },
        { id: 'next', name: 'next', type: 'bytes', length: 'choice.n' }
    ] }] };
    const result = M.renameField(source, 'a-n', { name: 'count' });
    assert.equal(M.findField(result.protocol, 'next').length, 'choice.n');
    assert.equal(result.references.filter(ref => ref.kind === 'unresolved' && ref.nodeId === 'next').length, 1);
});

function schema() {
    return { id: 'demo', name: 'Demo', framing: { fixedLength: 9 }, payloadOffset: 2,
        headerFields: [{ id: 'sync', name: 'sync', type: 'fixed', bytes: [170], framingRole: 'sync' }],
        structures: { Pair: [{ id: 'sx', name: 'x', type: 'uint8' }] },
        messages: [{ id: 'm1', name: 'Read', command: 1, fields: [
            { id: 'n', name: 'n', label: 'Count', type: 'uint8' },
            { id: 'body', name: 'body', type: 'struct', fields: [
                { id: 'inner', name: 'inner', type: 'uint16' }
            ] },
            { id: 'choice', name: 'choice', type: 'choice', selector: 'n', branches: [
                { id: 'b1', label: 'One', equals: 1, fields: [{ id: 'v1', name: 'v1', type: 'uint8' }] },
                { id: 'b2', label: 'Other', default: true, fields: [] }
            ] },
            { id: 'shared', name: 'shared', type: 'struct', ref: 'Pair' }
        ] }] };
}

test('traversal finds stable IDs across header, reusable structures and branches', () => {
    const source = schema();
    assert.equal(M.findNode(source, 'sync').name, 'sync');
    assert.equal(M.findNode(source, 'sx').name, 'x');
    assert.equal(M.findField(source, 'v1').name, 'v1');
    assert.equal(M.findNode(source, 'b1').label, 'One');
    assert.deepEqual(M.flattenFields(source).filter(row => ['inner', 'v1'].includes(row.field.id))
        .map(row => [row.field.id, row.parentId]), [['inner', 'body'], ['v1', 'b1']]);
});

test('moving a field preserves identity and rejects cycles while allowing cross-segment moves', () => {
    const source = schema();
    const moved = M.moveField(source, 'inner', 'header', 1);
    assert.deepEqual(moved.headerFields.map(field => field.id), ['sync', 'inner']);
    assert.equal(M.findField(moved, 'inner').name, 'inner');
    assert.equal(source.messages[0].fields[1].fields[0].id, 'inner');
    assert.throws(() => M.moveField(source, 'body', 'body', 0), /cycle/i);
    assert.throws(() => M.moveField(source, 'body', 'inner', 0), /cycle/i);
    const reordered = M.moveField(source, 'n', 'm1', 3);
    assert.deepEqual(reordered.messages[0].fields.map(field => field.id), ['body', 'choice', 'n', 'shared']);
});

test('duplication assigns fresh IDs and rewrites internal node references only', () => {
    const source = schema();
    source.messages[0].fields[1].fields.push({ id: 'link', name: 'link', type: 'uint8', sourceFieldId: 'inner', externalId: 'outside' });
    const copy = M.duplicateField(source, 'body');
    const [original, duplicate] = copy.messages[0].fields.slice(1, 3);
    assert.notEqual(duplicate.id, original.id);
    assert.notEqual(duplicate.fields[0].id, 'inner');
    assert.equal(duplicate.fields[1].sourceFieldId, duplicate.fields[0].id);
    assert.equal(duplicate.fields[1].externalId, 'outside');
    assert.equal(source.messages[0].fields.length, 4);
});

test('reusable structure instance becomes independent and leaves definition unchanged', () => {
    const source = schema();
    source.structures.Pair.push({ id: 'sy', name: 'y', type: 'uint8', sourceFieldId: 'sx' });
    const changed = M.makeStructureIndependent(source, 'shared');
    const instance = M.findField(changed, 'shared');
    assert.equal(instance.ref, undefined);
    assert.equal(instance.fields[0].name, 'x');
    assert.notEqual(instance.fields[0].id, 'sx');
    assert.equal(instance.fields[1].sourceFieldId, instance.fields[0].id);
    assert.equal(changed.structures.Pair[0].id, 'sx');
    instance.fields[0].name = 'changed';
    assert.equal(changed.structures.Pair[0].name, 'x');
});

test('rename rewrites exact previous-field identifiers in scope and reports references', () => {
    const source = schema();
    source.messages[0].fields.splice(1, 0,
        { id: 'later', name: 'later', type: 'bytes', length: 'n + nn', condition: 'n > 0', sourceFieldId: 'n' },
        { id: 'nn', name: 'nn', type: 'uint8' });
    source.messages.push({ id: 'm2', command: 2, fields: [{ id: 'other', name: 'other', type: 'bytes', length: 'n + 1' }] });
    const { protocol, references } = M.renameField(source, 'n', { name: 'count', label: 'Number' });
    assert.equal(M.findField(protocol, 'n').label, 'Number');
    assert.equal(M.findField(protocol, 'later').length, 'count + nn');
    assert.equal(M.findField(protocol, 'later').condition, 'count > 0');
    assert.equal(M.findField(protocol, 'later').sourceFieldId, 'n');
    assert.equal(M.findField(protocol, 'other').length, 'n + 1');
    assert.equal(references.some(ref => ref.nodeId === 'later' && ref.property === 'length'), true);
    assert.equal(source.messages[0].fields[1].length, 'n + nn');
});

test('history snapshots are independent and undo/redo discard redo on a new edit', () => {
    const source = schema();
    const h0 = M.createHistory(source);
    const h1 = M.pushHistory(h0, M.renameField(source, 'n', { name: 'count' }).protocol);
    source.name = 'mutated';
    assert.throws(() => { h1.present.name = 'also mutated'; }, TypeError);
    const h2 = M.undo(h1);
    assert.equal(h2.present.name, 'Demo');
    assert.equal(M.findField(h2.present, 'n').name, 'n');
    const h3 = M.redo(h2);
    assert.equal(M.findField(h3.present, 'n').name, 'count');
    const h4 = M.pushHistory(h2, M.removeField(h2.present, 'n'));
    assert.equal(h4.future.length, 0);
    assert.equal(M.undo(h2).future.length, 1);
});

test('renaming an outer field respects a nested field that shadows its name', () => {
    const source = schema();
    source.messages[0].fields[1].fields = [
        { id: 'first', name: 'first', type: 'bytes', length: 'n' },
        { id: 'shadow', name: 'n', type: 'uint8' },
        { id: 'after', name: 'after', type: 'bytes', length: 'n' }
    ];
    const renamed = M.renameField(source, 'n', { name: 'count' }).protocol;
    assert.equal(M.findField(renamed, 'first').length, 'count');
    assert.equal(M.findField(renamed, 'after').length, 'n');
    assert.equal(M.inspectReferences(source, 'n').some(ref => ref.nodeId === 'after'), false);
});

test('rename resolves current and parent qualifiers by lexical field scope', () => {
    const source = schema();
    source.messages[0].fields.splice(1, 0, { id: 'same', name: 'same', type: 'bytes',
        length: 'current.n + parent.n + other.n + nn' });
    source.messages[0].fields[2].fields = [{ id: 'nested', name: 'nested', type: 'bytes',
        length: 'parent.n + current.n + other.n' }];
    const { protocol, references } = M.renameField(source, 'n', { name: 'count' });
    assert.equal(M.findField(protocol, 'same').length, 'current.count + parent.n + other.n + nn');
    assert.equal(M.findField(protocol, 'nested').length, 'parent.count + current.n + other.n');
    assert.equal(references.some(ref => ref.nodeId === 'nested' && ref.property === 'length'), true);
    assert.equal(references.some(ref => ref.kind === 'unresolved' && ref.nodeId === 'nested'), true);
});

test('reference inspection reports explicit node links and external mappings', () => {
    const source = schema();
    source.messages[0].fields.unshift({ id: 'early', name: 'early', type: 'uint8', sourceFieldId: 'n' });
    const external = [{ protocolId: 'demo', fieldId: 'n', path: 'n[0]', channelId: 'plot' },
        { protocolId: 'demo', path: 'n[1]', channelId: 'legacy' }];
    const refs = M.inspectReferences(source, 'n', external);
    assert.equal(refs.some(ref => ref.kind === 'node' && ref.nodeId === 'early'), true);
    assert.equal(refs.some(ref => ref.kind === 'external' && ref.reference.channelId === 'plot'), true);
    assert.equal(refs.find(ref => ref.reference?.channelId === 'plot').proposedPath, 'n[0]');
    const renamed = M.renameField(source, 'n', { name: 'count' }, external);
    assert.equal(renamed.references.some(ref => ref.kind === 'external'), true);
    assert.equal(renamed.references.find(ref => ref.reference?.channelId === 'plot').proposedPath, 'count[0]');
    assert.equal(renamed.references.find(ref => ref.reference?.channelId === 'legacy').certainty, 'path');
    assert.equal(source.messages[0].fields[0].sourceFieldId, 'n');
});

test('TLV header fields are editable without changing branch fields', () => {
    const source = M.createTLVTemplate();
    const tlv = source.messages[0].fields[0];
    const edited = M.insertField(source, `tlv-header:${tlv.id}`, 1,
        { name: 'flags', type: 'uint8' });
    assert.deepEqual(edited.messages[0].fields[0].headerFields.map(field => field.name), ['tag', 'flags', 'size']);
    assert.equal(source.messages[0].fields[0].headerFields.length, 2);
});

test('TLV template exposes an explicit default branch for raw unknown values', () => {
    const source = M.createTLVTemplate(), branches = source.messages[0].fields[0].branches;
    assert.equal(branches.at(-1).default, true);
    assert.deepEqual(branches.at(-1).fields, []);
    assert.match(branches.at(-1).label, /其它类型|原始字节/);
});

test('library deletion can leave an empty library and never mutates applied snapshot', () => {
    const applied = { protocols: [schema()], protocolId: 'demo', mappings: [{ protocolId: 'demo', fieldId: 'n' }] };
    const result = M.deleteProtocol(applied.protocols, 'demo');
    assert.deepEqual(result.protocols, []);
    assert.equal(applied.protocols.length, 1);
    assert.deepEqual(applied.mappings, [{ protocolId: 'demo', fieldId: 'n' }]);
    assert.equal(result.deleted.id, 'demo');
});

test('library duplicate/import resolve collisions and reordering preserves IDs', () => {
    const source = schema();
    const copied = M.duplicateProtocol([source], 'demo');
    assert.equal(copied.protocols.length, 2);
    assert.notEqual(copied.protocol.id, 'demo');
    assert.notEqual(copied.protocol.messages[0].id, 'm1');
    const templated = M.createProtocol([], source);
    assert.notEqual(templated.protocol.id, source.id);
    assert.notEqual(templated.protocol.messages[0].id, source.messages[0].id);
    const imported = M.importProtocol(copied.protocols, source);
    assert.equal(imported.protocols.length, 3);
    assert.equal(new Set(imported.protocols.map(p => p.id)).size, 3);
    assert.deepEqual(M.reorderProtocol(imported.protocols, imported.protocol.id, 0)
        .map(p => p.id)[0], imported.protocol.id);
});

test('layout summary gives zero-based offsets and marks dynamic spans honestly', () => {
    const source = schema();
    source.messages[0].fields.push({ id: 'tail', name: 'tail', type: 'bytes', length: 'n' });
    const rows = M.layoutSummary(source, 'm1');
    assert.deepEqual(rows.slice(0, 2).map(row => [row.id, row.localOffset, row.frameOffset, row.width]),
        [['n', 0, 2, 1], ['body', 1, 3, 2]]);
    assert.equal(rows.find(row => row.id === 'tail').width, null);
});

test('layout summary treats repeat length as the entire segment bound', () => {
    const source = schema();
    source.messages[0].fields = [{ id: 'items', name: 'items', type: 'repeat', count: 2, length: 4,
        fields: [{ id: 'item', name: 'item', type: 'uint8' }] },
    { id: 'after-items', name: 'after', type: 'uint8' }];
    assert.deepEqual(M.layoutSummary(source, 'm1').map(row => [row.id, row.frameOffset, row.width]),
        [['items', 2, 4], ['after-items', 6, 1]]);
});

test('unified layout summaries keep dynamic array widths and following offsets unknown', () => {
    const protocol = { schemaVersion: 3, id: 'dynamic', messages: [{ id: 'frame', byteLength: 0, fields: [
        { id: 'n', name: 'n', type: 'uint8', byteLength: 1 },
        { id: 'items', name: 'items', type: 'uint16', byteLength: 2, count: 'n' },
        { id: 'tail', name: 'tail', type: 'uint8', byteLength: 1 }
    ] }] };
    const rows = M.layoutSummary(protocol, 'frame');
    assert.equal(rows[1].width, null); assert.equal(rows[2].frameOffset, null);
});

test('branch sorting preserves nested fields and stable ID references without changing the input schema', () => {
    const source = { id: 'sorting', messages: [{ id: 'frame', fields: [{ id: 'choice', name: 'choice', type: 'choice', selector: '0', branches: [
        { id: 'a', equals: 1, fields: [{ id: 'length', name: 'length', type: 'uint8' }, { id: 'bytes', name: 'bytes', type: 'bytes', lengthSource: { fieldId: 'length' } }] },
        { id: 'b', default: true, fields: [] }
    ] }] }] };
    const changed = M.reorderBranch(source, 'choice', 'b', 0), branch = M.findField(changed, 'choice').branches[1];
    assert.equal(branch.id, 'a'); assert.equal(branch.fields[1].lengthSource.fieldId, 'length');
    assert.equal(M.findField(source, 'choice').branches[0].id, 'a');
    assert.throws(() => M.reorderBranch(source, 'choice', 'missing', 0), /branch/i);
});


test('uppercase scopes and ordinary lowercase parent fields keep separate identities during rename', () => {
    const source = { id: 'case-scope', symbolVersion: 2, framing: { fixedLength: 5 }, messages: [{ id: 'm', fields: [
        { id: 'outer-size', name: 'size', type: 'uint8' },
        { id: 'lower-parent', name: 'parent', type: 'struct', fields: [{ id: 'inner-size', name: 'size', type: 'uint8' }] },
        { id: 'wrapper', name: 'wrapper', type: 'struct', fields: [
            { id: 'data', name: 'data', type: 'bytes', length: 'PARENT.size + parent.size' }
        ] }
    ] }] };
    const first = M.renameField(source, 'outer-size', { name: 'outer_size' }).protocol;
    assert.equal(M.findField(first, 'data').length, 'PARENT.outer_size + parent.size');
    const second = M.renameField(first, 'inner-size', { name: 'inner_size' }).protocol;
    assert.equal(M.findField(second, 'data').length, 'PARENT.outer_size + parent.inner_size');
    const { Protocol } = require('../protocolEngine');
    assert.equal(Protocol.decode([1,2,7,8,9], second).valid, true);
});
