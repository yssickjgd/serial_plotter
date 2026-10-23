const test = require('node:test');
const assert = require('node:assert/strict');
const { ProtocolSendView, ProtocolSendSession } = require('../protocolSendView');
const { Protocol } = require('../protocolEngine');

function documentFixture() {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
            this.attributes = {}; this.dataset = {}; this.value = ''; this.textContent = ''; this.checked = false;
            this.hidden = false; this.disabled = false; this.className = '';
            this.classList = { contains: name => this.className.split(' ').includes(name),
                add: (...names) => { this.className += ' ' + names.join(' '); },
                remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
                toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name);
                    this.classList[enabled ? 'add' : 'remove'](name); return enabled; } }; }
        get ownerDocument() { return document; }
        get parentElement() { return this.parentNode; }
        get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
        append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
        appendChild(child) { this.append(child); return child; }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        setAttribute(name, value) { this.attributes[name] = String(value);
            if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
        getAttribute(name) { return this.attributes[name] ?? null; }
        addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
        removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
        dispatchEvent(event) { event.target ??= this; for (const fn of this.listeners.get(event.type) || []) fn(event); }
        click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
        focus() { document.activeElement = this; }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
        matches(selector) {
            if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
            const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
            return match ? match[2] === undefined ? this.getAttribute(match[1]) !== null : this.getAttribute(match[1]) === match[2]
                : this.tagName === selector.toUpperCase();
        }
        querySelectorAll(selector) { const result = [];
            const matches = node => selector.split(',').some(part => node.matches(part.trim()));
            const visit = node => { for (const child of node.children) { if (matches(child)) result.push(child); visit(child); } };
            visit(this); return result; }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }
    const document = new Element('document'); document.createElement = tag => new Element(tag); return document;
}
function schema() {
    return { id: 'view.demo', framing: { header: [170], length: { offset: 1, type: 'uint8', adjustment: 3 }, maxLength: 64 },
        command: { offset: 2, type: 'uint8' }, payloadOffset: 3, messages: [{ id: 'view.state', name: '状态', command: 1,
            fields: [{ name: 'value', type: 'uint16' }, { name: 'ready', type: 'bool' },
                { name: 'mode', type: 'enum', baseType: 'uint8', enum: { 0: '待机', 1: '工作' } },
                { name: 'name', type: 'string', encoding: 'utf-8', length: 6 }] }] };
}
function fixture(extra = {}) {
    const current = schema(), document = documentFixture(), root = document.createElement('div');
    const values = [], session = new ProtocolSendSession({ getProtocol: () => current, getProtocols: () => [current] });
    const view = new ProtocolSendView({ document, root, session, onChange: value => values.push(value), ...extra });
    return { current, document, root, session, view, values,
        control: name => root.querySelector(`[data-control="${name}"]`),
        change(name, value) { const input = this.control(name); assert.ok(input, name);
            if (typeof value === 'boolean') input.checked = value; else input.value = value;
            input.dispatchEvent({ type: input.tagName === 'INPUT' || input.tagName === 'TEXTAREA' ? 'input' : 'change' }); } };
}

test('migrated send forms keep legacy command IDs and hide automatic length and checksum inputs', () => {
    const { ProtocolModel } = require('../protocolModel'), original = schema(), unified = ProtocolModel.toUnified(original);
    const session = new ProtocolSendSession({ getProtocol: () => unified, getProtocols: () => [unified] });
    const f = fixture({ session });
    f.view.setValue({ protocolId: unified.id, messageId: 'view.state', fields: { value: 42, ready: true, mode: 1, name: '中' } });
    assert.ok(f.control('field:value')); assert.equal(f.control('field:header.frame_length'), null);
    assert.deepEqual(f.view.preview(), Protocol.encode(original, 'view.state', { value: 42, ready: true, mode: 1, name: '中' }));
    f.change('field:value', '513'); assert.equal(Protocol.decode(f.view.preview(), unified).fields.value, 513);
    f.view.dispose();
});

test('send form conditions receive uppercase frame sequence header and item-index symbols', () => {
    const f = fixture();
    f.current.symbolVersion = 2; f.current.schemaVersion = 2; f.current.framing = { fixedLength: 5 };
    delete f.current.command; f.current.payloadOffset = 1;
    f.current.headerFields = [{ name: 'rm_seq', type: 'uint8', offset: 0, valueSource: 'SEQ' }];
    f.current.messages[0].fields = [{ name: 'items', type: 'repeat', count: 2, fields: [
        { name: 'value', type: 'uint8' },
        { name: 'marker', type: 'uint8', condition: 'INDEX >= 0 && FRAME_LENGTH == 5 && PAYLOAD_LENGTH == 4 && HEADER.rm_seq == 9 && SEQ == 9' }
    ] }];
    f.view.setValue({ protocolId: f.current.id, messageId: 'view.state', sequence: 9,
        fields: { items: [{ value: 41, marker: 51 }, { value: 42, marker: 52 }] } });
    assert.ok(f.control('field:items[0].marker')); assert.ok(f.control('field:items[1].marker'));
    assert.equal(f.control('field:header.rm_seq'), null);
    assert.deepEqual(f.view.preview(), Uint8Array.of(9, 41, 51, 42, 52));
});

test('migrated send forms retain explicit selection of conflicting document layouts', () => {
    const { ProtocolModel } = require('../protocolModel'), original = schema();
    Object.assign(original.messages[0], { requireLayout: true, layouts: { detail: { name: '详细字段布局' } } });
    const unified = ProtocolModel.toUnified(original), session = new ProtocolSendSession({ getProtocol: () => unified, getProtocols: () => [unified] });
    const f = fixture({ session }); f.view.setValue({ protocolId: unified.id, messageId: 'view.state', fields: { value: 7 } });
    assert.equal(f.control('layout').parentNode.hidden, false); assert.equal(f.view.preview(), null);
    f.change('layout', 'detail'); assert.ok(f.view.preview()); f.view.dispose();
});

test('migrated forms leave hidden numeric synchronization fields at their automatic fixed values', () => {
    const { ProtocolModel } = require('../protocolModel');
    const original = { id: 'fixed-view', framing: { header: [170], fixedLength: 2 }, payloadOffset: 1,
        headerFields: [{ id: 'sof', name: 'sof', type: 'uint8', offset: 0 }],
        messages: [{ id: 'view.state', fields: [{ name: 'value', type: 'uint8' }] }] };
    const unified = ProtocolModel.toUnified(original), session = new ProtocolSendSession({ getProtocol: () => unified, getProtocols: () => [unified] });
    const f = fixture({ session }); f.view.setValue({ protocolId: unified.id, messageId: 'view.state', fields: { value: 7 } });
    assert.equal(f.control('field:header.sof'), null);
    assert.deepEqual(f.view.preview(), Protocol.encode(original, 'view.state', { value: 7 }));
    f.view.dispose();
});

test('integer send fields show and parse the selected base including signed Hex', () => {
    const f = fixture(); f.current.messages[0].fields = [{ name: 'small', type: 'int8', displayBase: 'hex' }, { name: 'wide', type: 'int64', displayBase: 'hex' }];
    f.view.setValue({ protocolId: 'view.demo', messageId: 'view.state', fields: { small: -2, wide: '-9223372036854775808' } });
    assert.equal(f.control('field:small').value, '-0x2'); assert.equal(f.control('field:wide').value, '-0x8000000000000000');
    f.change('field:small', '-0x80'); f.change('field:wide', '0x7FFFFFFFFFFFFFFF');
    const record = Protocol.decode(f.view.preview(), f.current);
    assert.equal(record.fields.small, -128); assert.equal(record.fields.wide, 9223372036854775807n);
    f.change('field:small', '7F'); assert.equal(Protocol.decode(f.view.preview(), f.current).fields.small, 127);
    f.change('field:small', '0x80'); assert.equal(f.view.preview(), null); f.view.dispose();
});

test('bit group sending exposes data slices, hides reserved bits and retains wide exact input', () => {
    const f = fixture();
    f.current.messages[0].fields = [{ name: 'bits', type: 'bitfield', byteLength: 12, bits: [
        { name: 'counter', offset: 0, length: 80, type: 'uint' }, { name: 'reserved', offset: 80, length: 16, type: 'reserved' }
    ] }];
    f.view.refresh();
    assert.ok(f.control('field:bits.counter')); assert.equal(f.control('field:bits.reserved'), null);
    const value = (1n << 79n) + 9n; f.change('field:bits.counter', value.toString());
    assert.equal(f.view.getCommand().fields.bits.counter, value.toString());
    const decoded = Protocol.decode(f.view.preview(), f.current);
    assert.equal(decoded.values['bits.counter'], value); assert.equal(decoded.values['bits.reserved'], 0);
    f.view.dispose();
});

test('nested conditional send forms use the immediate parent segment rather than the root', () => {
    const f = fixture();
    f.current.messages[0].fields = [{ name: 'outer', type: 'struct', fields: [{ name: 'tag', type: 'uint8' },
        { name: 'inner', type: 'struct', fields: [{ name: 'body', type: 'choice', selector: 'parent.tag',
            branches: [{ id: 'known', equals: 1, fields: [{ name: 'v', type: 'uint8' }] }] }] }] }];
    f.view.setValue({ protocolId: 'view.demo', messageId: 'view.state', fields: { outer: { tag: 1, inner: { body: { v: 7 } } } } });
    assert.ok(f.control('field:outer.inner.body.v'));
    assert.equal(f.control('field:outer.inner.body.v').value, '7');
    assert.ok(f.view.preview());
    f.view.dispose();
});

test('protocol editor provides message, typed fields and an exact encoded Hex preview', () => {
    const f = fixture();
    assert.equal(f.control('protocol').value, 'view.demo');
    assert.equal(f.control('message').value, 'view.state');
    f.change('field:value', '513'); f.change('field:ready', true); f.change('field:mode', '1'); f.change('field:name', '中');
    const command = f.view.getCommand();
    assert.equal(command.fields.value, 513); assert.equal(command.fields.ready, true);
    const bytes = f.view.preview();
    const decoded = Protocol.decode(bytes, Protocol.compile(f.current));
    assert.equal(decoded.fields.value, 513); assert.equal(decoded.fields.name, '中');
    assert.match(f.control('preview').value, /^AA /);
    assert.equal(f.control('error').hidden, true);
    f.change('field:value', '8');
    assert.equal(f.view.getCommand().fields.value, 8);
    assert.ok(f.values.length >= 4);
});

test('invalid field JSON stays editable, blocks send and recovers after correction', async () => {
    const sent = [], f = fixture({ onSend: async value => sent.push(value) });
    f.change('fields-json', '{broken');
    assert.equal(f.control('error').hidden, false);
    assert.equal(f.control('fields-json').getAttribute('aria-invalid'), 'true');
    assert.throws(() => f.view.getCommand(), /JSON/);
    f.root.querySelector('[data-action="send-protocol"]').click();
    assert.equal(sent.length, 0); assert.equal(f.values.at(-1).fieldsText, '{broken');
    f.change('fields-json', '{"value": 7, "ready": false, "mode": 0, "name": "ok"}');
    f.root.querySelector('[data-action="send-protocol"]').click();
    await Promise.resolve(); assert.equal(sent.length, 1);
    assert.equal(f.control('error').hidden, true);
    f.view.setBusy(true); assert.equal(f.control('message').disabled, true);
    f.view.dispose(); f.change('fields-json', '{broken');
    assert.equal(f.values.at(-1).fields.value, 7);
});

test('document conflicts demand an explicit layout selection and missing protocols have a recovery message', () => {
    const f = fixture();
    f.current.messages[0].requireLayout = true; f.current.messages[0].conflicts = ['length mismatch'];
    f.current.messages[0].layouts = { detail: { name: '详细定义' } };
    f.view.refresh();
    assert.match(f.control('error').textContent, /layout|布局/i);
    f.change('layout', 'detail');
    assert.ok(f.view.preview().length);
    f.session.getProtocols = () => []; f.session.getProtocol = () => null; f.view.refresh();
    assert.match(f.control('error').textContent, /协议|选择|不存在/);
});

test('one-click protocol mode saves its initial visible choice, reuses the editor and preserves busy state', async () => {
    const { CommandLibrary } = require('../commandLibrary');
    const { CommandRunner } = require('../commandRunner');
    const { CommandSendView } = require('../commandSendView');
    const f = fixture(), nodes = [{ id: 'cmd', type: 'command', name: 'Command', mode: 'hex', content: 'AA' }];
    const library = new CommandLibrary(nodes), writes = [];
    const runner = new CommandRunner({ library, protocolSession: f.session, getEngine: () => true,
        send: async bytes => { writes.push(bytes); return true; } });
    const node = tag => f.document.createElement(tag), tree = node('div');
    const view = new CommandSendView({ library, runner, tree, addButton: node('button'), groupButton: node('button'),
        stopButton: node('button'), status: node('span'), error: node('p'), protocolSession: f.session });
    view.selectedId = 'cmd'; view.render();
    const mode = tree.querySelector('[data-field="mode"]'); mode.value = 'protocol'; mode.dispatchEvent({ type: 'change' });
    assert.equal(library.find('cmd').mode, 'protocol');
    assert.equal(library.find('cmd').protocol.messageId, 'view.state');
    const input = tree.querySelector('[data-control="field:value"]'); input.value = '19'; input.dispatchEvent({ type: 'input' });
    assert.equal(library.find('cmd').protocol.fields.value, 19);
    assert.equal(await runner.start('cmd'), true); assert.equal(writes.length, 1);
    view.setState({ running: true, message: 'Sending', currentId: 'cmd' });
    assert.equal(tree.querySelector('[data-control="message"]').disabled, true);
    view.setState({ running: false, message: 'Done' });
    assert.equal(tree.querySelector('[data-control="message"]').disabled, false);
    view.dispose(); input.value = '20'; input.dispatchEvent({ type: 'input' });
    assert.equal(library.find('cmd').protocol.fields.value, 19);
    runner.dispose(); f.view.dispose();
});

test('reserved fields offer Hex input and default zero bytes with no numeric coercion', () => {
    const f = fixture(); f.current.messages[0].fields = [{ name: 'value', type: 'uint8' },
        { name: 'reserved', type: 'reserved', length: 3 }]; f.view.refresh();
    assert.equal(f.view.getCommand().fields.reserved.length, 0);
    assert.deepEqual([...f.view.preview().subarray(-3)], [0, 0, 0]);
    f.change('field:reserved', 'AA 55 80');
    assert.deepEqual(f.view.getCommand().fields.reserved, [170, 85, 128]);
    assert.deepEqual([...f.view.preview().subarray(-3)], [170, 85, 128]);
    f.view.dispose();
});

test('TLV send forms add and remove bounded items, show branch fields and compute wire lengths', () => {
    const f = fixture();
    f.current.messages[0].fields = [{ id: 'tlv', name: 'items', type: 'tlv', until: 'end',
        headerFields: [{ name: 'tag', type: 'uint8' }, { name: 'size', type: 'uint8' }], lengthField: 'size', selector: 'tag',
        branches: [{ id: 'number', equals: 1, label: '数值', fields: [{ name: 'value', type: 'uint16' }] },
            { id: 'unknown', default: true, label: '其它类型', fields: [] }] }];
    f.view.refresh(); f.root.querySelector('[data-action="add-item:items"]').click();
    f.change('field:items[0].tag', '1');
    f.root.querySelector('[data-action="refresh-branches"]').click();
    f.change('field:items[0].value', '513');
    const bytes = f.view.preview(); assert.ok(bytes);
    assert.deepEqual([...bytes.slice(3)], [1, 2, 1, 2]);
    assert.equal(Protocol.decode(bytes, f.current).fields.items[0].value, 513);
    f.root.querySelector('[data-action="remove-item:items[0]"]').click();
    assert.deepEqual(f.view.getCommand().fields.items, []);
    f.view.dispose();
});

test('structured send inputs preserve unknown TLV payloads and permit nested indexed updates', () => {
    const f = fixture();
    f.current.messages[0].fields = [{ name: 'items', type: 'tlv', until: 'end',
        headerFields: [{ name: 'tag', type: 'uint8' }, { name: 'size', type: 'uint8' }], lengthField: 'size', selector: 'tag',
        branches: [{ id: 'raw', default: true, fields: [] }] }];
    f.view.setValue({ protocolId: 'view.demo', messageId: 'view.state', fields: { items: [{ tag: 9, rawPayload: [170, 85] }] } });
    const bytes = f.view.preview(); assert.ok(bytes);
    assert.deepEqual([...bytes.slice(3)], [9, 2, 170, 85]);
    f.change('field:items[0].tag', '10');
    assert.equal(f.view.getCommand().fields.items[0].tag, 10);
    f.view.dispose();
});


test('send inputs use the field radix for bare integers and byte sequences', () => {
    const f = fixture(); f.current.framing = { fixedLength: 4 }; f.current.payloadOffset = 0; delete f.current.command;
    f.current.messages[0].fields = [{ name: 'value', type: 'uint8', displayBase: 'hex' },
        { name: 'data', type: 'bytes', length: 3, displayBase: 'dec' }];
    f.view.setValue({ protocolId: 'view.demo', messageId: 'view.state', fields: { value: 16, data: [170,85,255] } });
    assert.equal(f.control('field:value').value, '0x10'); assert.equal(f.control('field:data').value, '170 85 255');
    f.change('field:value', 'FF'); f.change('field:data', '1 2 3');
    assert.deepEqual([...f.view.preview()], [255,1,2,3]);
    f.change('field:data', '256 0 0'); assert.equal(f.view.preview(), null);
    f.view.dispose();
});
