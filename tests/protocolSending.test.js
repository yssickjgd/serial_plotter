const test = require('node:test');
const assert = require('node:assert/strict');
const { Protocol } = require('../protocolEngine');
const { ProtocolSendSession, normalizeProtocolCommand } = require('../protocolSendView');
const { CommandLibrary, normalizeCommands } = require('../commandLibrary');
const { CommandRunner } = require('../commandRunner');
const { SendController } = require('../sendController');

function schema() {
    return { id: 'send.demo', endian: 'little', framing: { header: [165],
        length: { offset: 1, type: 'uint8', adjustment: 5 }, maxLength: 64 },
    headerFields: [{ name: 'seq', type: 'uint8', offset: 2 }],
    command: { offset: 3, type: 'uint8' }, payloadOffset: 4, payloadEnd: -1,
    checksums: [{ type: 'sum', width: 8, start: 0, end: -1, offset: -1 }],
    messages: [{ id: 'send.value', name: 'Value', command: 1, fields: [{ name: 'value', type: 'uint8' }] }] };
}
const binding = (extra = {}) => ({ protocolId: 'send.demo', messageId: 'send.value', fields: { value: 42 }, ...extra });
const command = (id, extra = {}) => ({ id, type: 'command', name: id, mode: 'protocol',
    protocol: binding(), repeat: 1, interval: 0, ...extra });
function element(value = '') {
    const listeners = new Map();
    return { value, textContent: '', className: '', files: [],
        addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
        fire(name) { return listeners.get(name)?.({ target: this }); }, click() { return this.fire('click'); } };
}
function controller(session, options = {}) {
    return new SendController({ mode: element('protocol'), input: element('ignored'), fileInput: element(),
        interval: element('0'), intervalUnit: element('s'), button: element(), loadButton: element(),
        getEngine: () => null, onSent() {}, protocolSession: session, getProtocolCommand: () => binding(), ...options });
}

test('protocol commands persist exact64 strings and invalid drafts without changing raw command formats', () => {
    const normalized = normalizeCommands([command('p', { protocol: binding({ fields: { stamp: 9007199254740993n }, fieldsText: '{broken' }) })]);
    assert.equal(normalized[0].protocol.fields.stamp, '9007199254740993');
    assert.equal(normalized[0].protocol.fieldsText, '{broken');
    assert.doesNotThrow(() => JSON.stringify(normalized));
    assert.throws(() => normalizeProtocolCommand(binding({ fields: { constructor: 1 } })), /字段|key|安全/i);
    const library = new CommandLibrary([command('p')]);
    library.update('p', { protocol: binding({ fields: { value: 8 } }) });
    assert.equal(library.serialize()[0].protocol.fields.value, 8);
    const copied = library.duplicate('p');
    library.update(copied, { protocol: binding({ fields: { value: 9 } }) });
    assert.equal(library.find('p').protocol.fields.value, 8);
    library.update('p', { mode: 'hex', content: 'AA' });
    library.update('p', { mode: 'protocol' });
    assert.equal(library.find('p').protocol.fields.value, 8);
});

test('a protocol task freezes its schema and fields before the first send', async () => {
    const current = schema(), session = new ProtocolSendSession({ getProtocol: () => current });
    const node = command('p', { repeat: 3 });
    const library = new CommandLibrary([node]);
    const frames = [], runner = new CommandRunner({ library, protocolSession: session, getEngine: () => true,
        send: async bytes => { frames.push([...bytes]); current.messages[0].command = 9;
            library.update('p', { protocol: binding({ fields: { value: 99 } }) }); return true; } });
    assert.equal(await runner.start('p'), true);
    assert.deepEqual(frames.map(bytes => [bytes[2], bytes[3], bytes[4]]), [[0, 1, 42], [1, 1, 42], [2, 1, 42]]);
    assert.equal(session.getSequence('send.demo'), 3);
    const next = session.prepare(binding());
    assert.equal(next.bytes[3], 9);
});

test('shared sessions serialize protocol writes, wrap sequences and advance only successful physical writes', async () => {
    const session = new ProtocolSendSession({ getProtocol: () => schema() });
    session.setSequence('send.demo', 255);
    const prepared = session.prepare(binding()), writes = [];
    let finish;
    const first = session.send(prepared, bytes => { writes.push([...bytes]); return new Promise(resolve => { finish = resolve; }); });
    const second = session.send(prepared, async bytes => { writes.push([...bytes]); return true; });
    for (let index = 0; index < 5; index++) await Promise.resolve();
    assert.equal(writes.length, 1);
    finish(true); assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(writes.map(bytes => bytes[2]), [255, 0]);
    assert.equal(session.getSequence('send.demo'), 1);
    assert.equal(await session.send(prepared, async () => false), false);
    assert.equal(session.getSequence('send.demo'), 1);
    assert.equal(await session.send(prepared, async () => { throw new Error('write failed'); }).catch(() => false), false);
    assert.equal(session.getSequence('send.demo'), 1);
    assert.equal(await session.send(prepared, async () => { throw new Error('should not run'); }, () => false), false);
});

test('sequence widths follow explicit source bindings inside nested payloads', async () => {
    for (const [type, last, golden] of [['uint16', 65535, [255, 255]], ['uint32', 4294967295, [255, 255, 255, 255]]]) {
        const current = { id: 'explicit.seq', symbolVersion: 2, framing: { fixedLength: golden.length }, messages: [{ id: 'm', fields: [
            { name: 'data', type: 'struct', fields: [{ name: 'counter', type, valueSource: 'SEQ' }] }
        ] }] };
        const session = new ProtocolSendSession({ getProtocol: () => current }); session.setSequence(current.id, last);
        const prepared = session.prepare({ protocolId: current.id, messageId: 'm', fields: {} }), writes = [];
        assert.deepEqual([...prepared.bytes], golden);
        assert.equal(await session.send(prepared, async bytes => { writes.push([...bytes]); return true; }), true);
        assert.equal(await session.send(prepared, async bytes => { writes.push([...bytes]); return true; }), true);
        assert.deepEqual(writes, [golden, golden.map(() => 0)]); assert.equal(session.getSequence(current.id), 1);
    }
});

test('sequence widths include explicit sources in dispatched child messages', () => {
    const current = { id: 'child.seq', symbolVersion: 2, framing: { fixedLength: 4 }, command: { offset: 0, type: 'uint8' }, payloadOffset: 1,
        messages: [{ id: 'parent', command: 1, fields: [{ name: 'kind', type: 'uint8' }], dispatch: { field: 'kind', offset: 1,
            messages: [{ id: 'child', command: 2, fields: [{ name: 'counter', type: 'uint16', valueSource: 'SEQ' }] }] } }] };
    const session = new ProtocolSendSession({ getProtocol: () => current }); session.setSequence(current.id, 65535);
    assert.deepEqual(session.prepare({ protocolId: current.id, messageId: 'child', fields: {} }).bytes, Uint8Array.of(1, 2, 255, 255));
});

test('invalid protocol groups are rejected before any raw or protocol command is written', async () => {
    const errors = [], writes = [], session = new ProtocolSendSession({ getProtocol: () => schema() });
    const library = new CommandLibrary([{ id: 'g', type: 'group', name: 'Group', children: [
        { id: 'raw', type: 'command', name: 'Raw', mode: 'hex', content: 'AA' },
        command('bad', { protocol: binding({ fields: { value: 300 } }) })] }]);
    const runner = new CommandRunner({ library, protocolSession: session, getEngine: () => true,
        send: async bytes => { writes.push(bytes); return true; }, onError: error => errors.push(error.message) });
    assert.equal(await runner.start('g'), false);
    assert.equal(writes.length, 0); assert.match(errors[0], /bad.*overflow/i);
    library.update('bad', { protocol: binding({ fieldsText: '{invalid' }) });
    assert.equal(await runner.start('g'), false); assert.equal(writes.length, 0);
});

test('regular protocol mode shares TX accounting and ignores file preview bytes', async () => {
    const current = schema(), session = new ProtocolSendSession({ getProtocol: () => current });
    const writes = [], sent = [], engine = { async send(bytes) { writes.push([...bytes]); } };
    const sender = controller(session, { getEngine: () => engine, onSent: bytes => sent.push([...bytes]) });
    sender.loadedBytes = Uint8Array.of(255); sender.previewBytes = Uint8Array.of(128);
    assert.equal(await sender.sendOnce(), true);
    assert.equal(await sender.sendOnce(), true);
    assert.deepEqual(writes.map(bytes => [bytes[2], bytes[4]]), [[0, 42], [1, 42]]);
    assert.deepEqual(sent, writes);
    assert.equal(Protocol.decode(Uint8Array.from(writes[0]), Protocol.compile(current)).fields.value, 42);
    sender.dispose();
});

test('regular encoding errors submit no bytes and a failed physical write does not increment sequence', async () => {
    const session = new ProtocolSendSession({ getProtocol: () => schema() }), errors = [], writes = [];
    const engine = { async send(bytes) { writes.push(bytes); throw new Error('transport'); } };
    const sender = controller(session, { getEngine: () => engine,
        getProtocolCommand: () => binding({ fields: { value: 300 } }), onInputError: error => errors.push(error.message), onSendError() {} });
    assert.equal(await sender.sendOnce(), false); assert.equal(writes.length, 0);
    sender.getProtocolCommand = () => binding();
    assert.equal(await sender.sendOnce(), false); assert.equal(writes.length, 1);
    assert.equal(session.getSequence('send.demo'), 0); assert.equal(errors.length, 1);
    sender.dispose();
});

test('one task resolves each protocol revision once for all commands in a group', async () => {
    let resolutions = 0;
    const session = new ProtocolSendSession({ getProtocol: () => {
        const value = schema(); value.messages[0].command = ++resolutions; return value;
    } });
    const library = new CommandLibrary([{ id: 'g', type: 'group', name: 'Group', children: [command('a'), command('b')] }]);
    const writes = [], runner = new CommandRunner({ library, protocolSession: session, getEngine: () => true,
        send: async bytes => { writes.push([...bytes]); return true; } });
    assert.equal(await runner.start('g'), true);
    assert.equal(resolutions, 1); assert.deepEqual(writes.map(bytes => bytes[3]), [1, 1]);
    assert.equal(await runner.start('g'), true);
    assert.equal(resolutions, 2); assert.deepEqual(writes.slice(2).map(bytes => bytes[3]), [2, 2]);
});

test('a cancelled submitted command advances on success before the next regular protocol write', async () => {
    const session = new ProtocolSendSession({ getProtocol: () => schema() }), writes = [], recorded = [];
    let finish;
    const engine = { send(bytes) { writes.push([...bytes]); return writes.length === 1
        ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(); } };
    const sender = controller(session, { getEngine: () => engine, onSent: bytes => recorded.push([...bytes]) });
    const runner = new CommandRunner({ library: new CommandLibrary([command('p', { repeat: 3 })]),
        protocolSession: session, getEngine: () => engine, beforeStart: () => sender.stop(),
        send: (bytes, current) => sender.sendBytes(bytes, current) });
    const running = runner.start('p');
    for (let index = 0; index < 8; index++) await Promise.resolve();
    assert.equal(writes.length, 1); runner.stop();
    const regular = sender.sendOnce({ queue: true }); finish();
    assert.equal(await running, false); assert.equal(await regular, true);
    assert.deepEqual(writes.map(bytes => bytes[2]), [0, 1]);
    assert.equal(session.getSequence('send.demo'), 2); assert.deepEqual(recorded, writes);
    sender.dispose(); runner.dispose();
});
