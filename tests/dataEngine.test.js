const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptureService } = require('../captureService');
const { DataEngine, normalizeDataEngine, preflightDataEngine, resolveProtocolMappingField } = require('../dataEngine');
const { Protocol } = require('../protocolEngine');

test('bit groups feed numeric slice channels while reserved bits remain unmappable across replay', async t => {
    const f = setup(t), protocol = { id: 'bits', framing: { fixedLength: 3 }, messages: [{ id: 'bits.state', fields: [
        { name: 'flags', type: 'bitfield', byteLength: 3, bits: [
            { name: 'ready', offset: 0, length: 1, type: 'bool' }, { name: 'rate', offset: 1, length: 15, type: 'int' },
            { name: 'reserved', offset: 16, length: 8, type: 'reserved' }
        ] }
    ] }] };
    const settings = { ...f.settings, protocols: [protocol], protocolId: protocol.id, mappings: [
        { protocolId: 'bits', messageId: 'bits.state', path: 'flags.ready', channel: 0 },
        { protocolId: 'bits', messageId: 'bits.state', path: 'flags.rate', channel: 1 }
    ] };
    await f.engine.apply(settings, { rebuild: false });
    f.service.receive(Protocol.encode(protocol, 'bits.state', { flags: { _raw: 0x120000, ready: true, rate: -100 } }));
    assert.equal(f.engine.syncSource.frames.getValue(0, 0), 1); assert.equal(f.engine.syncSource.frames.getValue(1, 0), -100);
    await f.engine.rebuild();
    assert.equal(f.engine.outputs.get('message:bits.state').frames.getValue(1, 0), -100);
    assert.throws(() => normalizeDataEngine({ ...settings, mappings: [{ protocolId: 'bits', messageId: 'bits.state', path: 'flags.reserved', channel: 0 }] }, f.globals), /数值|位字段/);
});

const schema = { id: 'engine.test', endian: 'little', framing: { header: [170], fixedLength: 4 },
    command: { offset: 1, type: 'uint8' }, payloadOffset: 2, messages: [
        { id: 'a', name: '电压', command: 1, fields: [{ name: 'voltage', type: 'uint16' }] },
        { id: 'b', name: '温度', command: 2, fields: [{ name: 'temperature', type: 'uint16' }] }
    ] };
const array = { dataType: 'uint8', endianness: 'little', channelsCount: '2', enableHeader: false,
    headerHex: 'AB', enableFooter: false, footerHex: '0D 0A', enableChecksum: false };

test('invalid saved protocol reports its identity and byte range without losing compiler diagnostics', () => {
    const invalid = { id: 'old.conflict', name: '旧测试协议', framing: { header: [170], fixedLength: 4,
        length: { offset: 0, type: 'uint8' } }, payloadOffset: 1,
        messages: [{ id: 'data', fields: [{ name: 'v', type: 'uint8' }] }] };
    assert.throws(() => normalizeDataEngine({ mode: 'Data_Array', array, protocols: [invalid] }, array), error => {
        assert.match(error.message, /旧测试协议.*old\.conflict/);
        assert.match(error.message, /\[0, 1\)/);
        assert.match(error.message, /自动写入.*重叠/);
        assert.equal(error.code, 'overlap');
        assert.equal(error.nodeId, 'header');
        assert.equal(error.byteOffset, 0);
        assert.equal(error.endByte, 1);
        return true;
    });
});

function setup(t, options = {}) {
    let now = 0;
    const globals = { ...array, channelsCount: options.catalogCount ?? 2, channelNames: [], channelDefinitions: options.definitions ?? [] };
    const settings = { mode: options.mode ?? 'Self_Defined_Frame', array: { ...array, ...options.array }, protocols: [schema], protocolId: schema.id,
        mappings: [{ messageId: 'a', path: 'voltage', channel: 0 }, { messageId: 'b', path: 'temperature', channel: 1 }],
        synchronization: { sampleRate: 1000, expiry: { 0: .002 } } };
    const service = new CaptureService({ numericFormat: settings.array, channelDefinitions: globals.channelDefinitions,
        catalogCount: globals.channelsCount, capacity: options.capacity ?? 10000, now: () => now, wallNow: () => 1000 + now,
        setTimeout: () => 0, clearTimeout() {}, ...options.service });
    const engine = new DataEngine(service, settings, globals); t.after(() => service.dispose());
    const compiled = Protocol.compile(schema), packet = (id, value) => Protocol.encode(compiled, id,
        id === 'a' ? { voltage: value } : { temperature: value });
    const receive = (id, value, time) => { now = time; service.receive(packet(id, value)); };
    return { service, engine, globals, settings, packet, receive, setNow(value) { now = value; } };
}

test('strong and weak constraints retain records while controlling numeric output across rebuild', async t => {
    const f = setup(t);
    const schema = { id: 'rules', schemaVersion: 3, symbolVersion: 2, messages: [{ id: 'frame', byteLength: 3, fields: [
        { id: 'sync', name: 'sync', type: 'fixed', byteLength: 1, bytes: [170], framingRole: 'sync' },
        { id: 'size', name: 'size', type: 'uint8', byteLength: 1 },
        { id: 'value', name: 'value', type: 'uint8', byteLength: 1 }
    ] }], rules: [{ id: 'size-check', type: 'length', expression: 'size == LEN(value)', strength: 'weak' }] };
    const settings = { ...f.settings, protocols: [schema], protocolId: 'rules', mappings: [{ protocolId: 'rules', messageId: 'frame', fieldId: 'value', path: 'value', channel: 0 }] };
    await f.engine.apply(settings, { rebuild: false });
    f.service.receive(Uint8Array.of(170, 2, 42));
    assert.equal(f.engine.outputs.get('message:frame').frames.getValue(0, 0), 42);
    assert.equal(f.engine.decode(0).record.ruleResults[0].status, 'failed');
    await f.engine.rebuild();
    assert.equal(f.engine.outputs.get('message:frame').frames.getValue(0, 0), 42);
    const strict = JSON.parse(JSON.stringify(settings)); strict.protocols[0].rules[0].strength = 'strong';
    await f.engine.apply(strict, { rebuild: true });
    assert.equal(f.engine.recordsSource.frames.length, 1);
    assert.equal(f.engine.outputs.get('message:frame').frames.length, 0);
    assert.equal(f.engine.decode(0).record.valid, false);
    f.service.receive(Uint8Array.of(170, 1, 43));
    assert.equal(f.engine.outputs.get('message:frame').frames.getValue(0, 0), 43);
});

test('data engine edits require uppercase channel functions before replacing shared definitions', async t => {
    const f = setup(t);
    assert.throws(() => f.engine.updateChannelDefinitions([{ number: 3, type: 'formula', expression: 'diff(CH1)' }]), /DIFF/);
    assert.deepEqual(f.globals.channelDefinitions, []);
    await f.engine.updateChannelDefinitions([{ number: 3, type: 'formula', expression: 'INT(CH1)' }]);
    assert.equal(f.globals.channelDefinitions[0].expression, 'INT(CH00001)');
});

test('migrated whole-frame command branches preserve existing ID mappings through capture and rebuilding', async t => {
    const { ProtocolModel } = require('../protocolModel'), f = setup(t);
    const previous = Protocol.compile(schema), next = ProtocolModel.toUnified(previous.schema);
    const mappings = f.settings.mappings.map(mapping => ({ ...mapping, protocolId: schema.id,
        fieldId: previous.messageById.get(mapping.messageId).fields[0].id }));
    await f.engine.apply({ ...f.settings, protocols: [next], mappings }, { rebuild: false });
    f.receive('a', 23, 0); f.receive('b', 42, 1);
    assert.equal(f.engine.outputs.get('message:a').frames.getValue(0, 0), 23);
    assert.equal(f.engine.outputs.get('message:b').frames.getValue(1, 0), 42);
    await f.engine.rebuild();
    assert.equal(f.engine.outputs.get('message:a').frames.getValue(0, 0), 23);
    assert.equal(f.engine.outputs.get('message:b').frames.getValue(1, 0), 42);
});

test('the applied engine runs without widgets, parses split mixed commands, holds and expires causally, and preserves origins', t => {
    const f = setup(t), a = f.packet('a', 2), b = f.packet('b', 7);
    f.service.receive(a.subarray(0, 2)); assert.equal(f.engine.recordsSource.frames.length, 0);
    f.service.receive(a.subarray(2)); f.receive('b', 7, 1); f.setNow(3); f.engine.advance();
    const sync = f.engine.syncSource.frames;
    assert.equal(sync.length, 4); assert.equal(sync.getValue(0, 0), 2); assert.ok(Number.isNaN(sync.getValue(1, 0)));
    assert.equal(sync.getValue(0, 1), 2); assert.equal(sync.statusAt(0, 1), 'held'); assert.equal(sync.statusAt(0, 2), 'expired');
    assert.equal(sync.getValue(1, 3), 7); assert.equal(sync.provenanceAt(1, 3).byteOffset, 4);
    assert.deepEqual([...sync.rawBytesAt(1)], [...b]); assert.equal(sync.originTimestamp, 1000);
    assert.equal(f.engine.outputs.get('message:a').frames.length, 1); assert.equal(f.engine.outputs.get('message:b').frames.length, 1);
    assert.equal(f.engine.recordsSource.kind, 'protocol'); assert.equal(f.engine.decode(0).record.fields.voltage, 2);
    assert.ok([...f.engine.managed].every(source => source.engineManaged));
    f.setNow(4); f.service.pause(true); const before = sync.length;
    f.setNow(1000); f.engine.advance(); assert.equal(sync.length, before);
    f.service.pause(false); f.receive('a', 5, 1001); assert.equal(sync.length, before + 1);
    assert.equal(sync.timestampAt(sync.length - 1), 2001);
});

test('Raw_Data produces no numeric records and leaves independent raw pipelines running', async t => {
    const f = setup(t, { mode: 'Raw_Data' }), line = f.service.acquireSource({ captureMode: 'text', textBoundary: 'lf' }, { rebuild: false });
    f.service.receive(Uint8Array.of(65, 10)); f.service.endStream();
    assert.equal(f.engine.output().frames.length, 0); assert.equal(f.engine.arraySource.frames.length, 0);
    assert.deepEqual([...line.frames.rawBytesAt(0)], [65, 10]); assert.equal(f.service.history.endByte, 2);
    f.engine.config.draft = { ...f.engine.serialize(), mode: 'Data_Array', array: { ...array, channelsCount: '1' } };
    assert.equal(f.engine.mode, 'Raw_Data'); await f.engine.apply(undefined, { rebuild: false });
    assert.equal(f.engine.mode, 'Data_Array'); assert.equal(f.engine.config.draft, null);
    f.service.receive(Uint8Array.of(3, 4));
    assert.equal(f.service.numericSource.frames.length, 2); assert.equal(f.service.numericSource.frames.rawChannelCount, 2);
    assert.equal(f.service.numericSource.frames.getValue(0, 1), 4); assert.ok(Number.isNaN(f.service.numericSource.frames.getValue(1, 1)));
    assert.equal(Number(f.globals.channelsCount), 2); assert.deepEqual([...f.service.numericSource.frames.rawBytesAt(1)], [4]);
});

test('historical protocol rebuilding matches live samples, original byte origins and archived pause boundaries', async t => {
    const f = setup(t); f.receive('a', 2, 0); f.receive('b', 7, 1); f.setNow(3); f.service.pause(true);
    const raw = f.service.baseSource, rawFrames = raw.frames, beforeRaw = rawFrames.length;
    const before = [0, 1].map(channel => f.engine.syncSource.frames.channelSlice(channel));
    const origin = f.engine.syncSource.frames.provenanceAt(1, 2);
    await f.engine.rebuild();
    assert.deepEqual([0, 1].map(channel => f.engine.syncSource.frames.channelSlice(channel)), before);
    assert.deepEqual(f.engine.syncSource.frames.provenanceAt(1, 2), origin);
    assert.equal(f.engine.recordsSource.frames.length, 2); assert.equal(f.service.baseSource, raw); assert.equal(raw.frames, rawFrames);
    assert.equal(rawFrames.length, beforeRaw); assert.equal(f.engine.syncSource.frames.active, null);
});

test('protocol replay catches live arrivals and boundary-only revisions while another source receives normally', async t => {
    let replayYield;
    const f = setup(t, { service: { yieldControl: async () => replayYield?.() } });
    f.receive('a', 2, 0);
    let once = false;
    replayYield = () => { if (!once) { once = true; f.receive('b', 7, 1); f.setNow(2); f.service.pause(true); } };
    await f.engine.rebuild();
    assert.equal(f.engine.recordsSource.frames.length, 2); assert.equal(f.engine.syncSource.frames.length, 3);
    assert.equal(f.engine.syncSource.frames.active, null); assert.equal(f.service.history.endByte, 8);
    assert.equal(Array.from({ length: f.service.baseSource.frames.length }, (_, index) => f.service.baseSource.frames.rawBytesAt(index).length)
        .reduce((sum, length) => sum + length, 0), 8);
    assert.equal(f.engine.recordsSource.frames.rawByteOffsetAt(1), 4);
});

test('a newer applied mode cancels an awaiting protocol rebuild without restoring its outputs', async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = setup(t, { service: { yieldControl: () => gate } }); f.receive('a', 2, 0);
    const old = f.engine.rebuild(); assert.equal(f.engine.rebuilding, true);
    await f.engine.apply({ ...f.settings, mode: 'Raw_Data' }, { rebuild: false }); release(); await old;
    assert.equal(f.engine.mode, 'Raw_Data'); assert.equal(f.engine.output().frames.length, 0);
    assert.ok([...f.service.sources].every(source => !source.engineManaged || source === f.engine.emptySource));
});

test('formula edits reach the synchronized table, every message output and the inactive array source', async t => {
    const f = setup(t, { definitions: [{ number: 3, type: 'formula', expression: 'int(CH1)' }, { number: 4, type: 'formula', expression: 'CH1+1' }] });
    f.receive('a', 2, 0); f.setNow(1); f.engine.advance();
    const sync = f.engine.syncSource.frames, message = f.engine.outputs.get('message:a').frames;
    assert.deepEqual(sync.channelSlice(2), [2, 4]);
    await f.service.updateChannelDefinitions([{ number: 3, type: 'formula', expression: 'INT(CH1)' }, { number: 4, type: 'formula', expression: 'CH1+10' }], { rebuild: false });
    assert.deepEqual(sync.channelSlice(3), [3, 3]); f.receive('a', 3, 2);
    assert.equal(sync.getValue(3, sync.length - 1), 13); assert.equal(message.getValue(3, message.length - 1), 13);
    assert.equal(f.engine.arraySource.frames.definitions[1].expression, 'CH00001+10');
    await f.service.updateChannelDefinitions(f.service.channelDefinitions, { rebuild: true, reapply: [4] });
    assert.deepEqual(sync.channelSlice(3), [12, 12, 13]); assert.deepEqual(sync.channelSlice(2), [2, 4, 7]);
});

test('mapping validation rejects nonexistent, duplicate, nonnumeric or out-of-catalog fields before changing an applied mode', t => {
    const f = setup(t);
    for (const mapping of [{ channel: 2, messageId: 'a', path: 'voltage' }, { channel: 0, messageId: 'missing', path: 'voltage' },
        { channel: 0, messageId: 'a', path: 'missing' }]) assert.throws(() => normalizeDataEngine({ ...f.settings, mappings: [mapping] }, f.globals), /字段|目录/);
    assert.throws(() => normalizeDataEngine({ ...f.settings, mappings: [f.settings.mappings[0], f.settings.mappings[0]] }, f.globals), /重复/);
    assert.equal(f.engine.mode, 'Self_Defined_Frame');
});

test('65535 catalog channels keep a narrow array wire format sparse and preserve its original bytes through replay', async t => {
    const f = setup(t, { mode: 'Data_Array', catalogCount: 65535, array: { channelsCount: '1' }, capacity: 20 });
    f.service.receive(Uint8Array.of(4, 5, 6)); f.service.endStream();
    const frames = f.service.numericSource.frames;
    assert.equal(frames.rawChannelCount, 65535); assert.equal(frames.length, 3); assert.equal(frames.getValue(0, 1), 5);
    assert.ok(Number.isNaN(frames.getValue(65534, 1))); assert.ok(frames.estimatedMemoryBytes < 10000);
    await f.service.updateNumericFormat({ dataType: 'int8' }, { rebuild: true });
    assert.equal(frames.length, 3); assert.equal(frames.getValue(0, 2), 6); assert.deepEqual([...frames.rawBytesAt(2)], [6]);
    assert.equal(Number(f.globals.channelsCount), 65535);
});

test('editing an unused protocol library keeps an applied array source, pending bytes and retained samples intact', async t => {
    const f = setup(t, { mode: 'Data_Array' }); f.service.receive(Uint8Array.of(2, 3, 4));
    const frames = f.engine.arraySource.frames, parser = f.engine.arraySource.parser, version = frames.version;
    const next = f.engine.serialize(); next.protocols[0].messages[0].name = '修改草稿库';
    await f.engine.apply(next, { rebuild: true });
    assert.equal(f.engine.arraySource.frames, frames); assert.equal(f.engine.arraySource.parser, parser); assert.equal(frames.version, version);
    f.service.receive(Uint8Array.of(5)); assert.equal(frames.getValue(0, 1), 4); assert.equal(frames.getValue(1, 1), 5);
});

test('mapping and synchronization edits rebuild only numeric outputs while keeping the protocol record source identity', async t => {
    const f = setup(t); f.receive('a', 2, 0); f.receive('b', 7, 1); f.setNow(2); f.service.pause(true);
    const source = f.engine.recordsSource, frames = source.frames, raw = [...frames.rawBytesAt(0)];
    const next = f.engine.serialize(); next.mappings = next.mappings.map(mapping => ({ ...mapping, channel: 1 - mapping.channel }));
    await f.engine.apply(next, { rebuild: true });
    assert.equal(f.engine.recordsSource, source); assert.equal(source.frames, frames); assert.equal(frames.length, 2);
    assert.deepEqual([...frames.rawBytesAt(0)], raw); assert.equal(f.engine.syncSource.frames.getValue(1, 0), 2);
    assert.equal(f.engine.syncSource.frames.getValue(0, 1), 7);
});

test('protocol pending buffers, decoded caches and sparse synchronized events participate in the shared byte budget', t => {
    const f = setup(t, { service: { memoryLimitBytes: 2 * 1048576 }, capacity: 100000 });
    for (let index = 0; index < 3500; index++) f.receive(index % 2 ? 'b' : 'a', index, index);
    assert.equal(f.service.paused, false); assert.ok(f.service.memoryUsage().usedBytes <= f.service.memory.limitBytes);
    assert.ok(f.service.history.startByte > 0); assert.ok(f.engine.estimatedMemoryBytes < f.service.memory.limitBytes / 16);
    f.receive('a', 42, 3500);
    const message = f.engine.outputs.get('message:a').frames;
    assert.equal(message.getValue(0, message.length - 1), 42);
});

test('bounded protocol worker batches execute concurrently and commit in source order', async t => {
    let active = 0, maximum = 0, jobs = 0;
    const workerPool = { maxWorkers: 3, workerLimit: 3, available: true, jobs: [], setWorkerLimit() {}, setFftCacheLimit() {},
        clearFftCache() {}, dispose() {}, runTask(task) {
            const order = jobs++; active++; maximum = Math.max(maximum, active);
            return new Promise(resolve => setTimeout(() => {
                active--; resolve(task.records.map(record => Protocol.decode(record.bytes, task.schema)));
            }, order % 3 === 0 ? 20 : 0));
        } };
    const f = setup(t, { service: { workerPool } }), bytes = new Uint8Array(900 * 4);
    for (let index = 0; index < 900; index++) bytes.set(f.packet('a', index), index * 4);
    f.service.receive(bytes); f.service.endStream(); await f.engine.rebuild();
    assert.equal(maximum, 3); assert.equal(jobs, 4); assert.equal(f.engine.recordsSource.frames.length, 900);
    const frames = f.engine.outputs.get('message:a').frames;
    assert.deepEqual([frames.getValue(0, 0), frames.getValue(0, 255), frames.getValue(0, 899)], [0, 255, 899]);
    assert.equal(frames.rawByteOffsetAt(899), 899 * 4); assert.equal(f.engine.recordsSource.parser.deferDecode, false);
});

test('pause boundaries arriving during worker decoding flush pending tails before live catchup and add no pause samples', async t => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
    const workerPool = { maxWorkers: 1, workerLimit: 1, available: true, jobs: [], setWorkerLimit() {}, setFftCacheLimit() {}, clearFftCache() {}, dispose() {},
        async runTask(task) { started(); await gate; return task.records.map(record => Protocol.decode(record.bytes, task.schema)); } };
    const f = setup(t, { service: { workerPool } }); f.receive('a', 2, 0);
    f.service.receive(f.packet('b', 5).subarray(0, 2));
    const pending = f.engine.rebuild(); await began;
    f.setNow(3); f.service.pause(true); f.setNow(1000); f.service.pause(false); f.receive('b', 7, 1001);
    release(); await pending;
    assert.equal(f.engine.recordsSource.frames.length, 2); assert.equal(f.engine.recordsSource.frames.rawByteOffsetAt(1), 6);
    assert.equal(f.engine.syncSource.frames.length, 5); assert.equal(f.engine.syncSource.frames.timestampAt(4), 2001);
    assert.ok(f.engine.recordsSource.errors.some(error => error.reason === 'incomplete'));
});

test('clearing a suspended protocol rebuild restores the live decoder instead of leaving a deferred callback', async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = setup(t, { service: { yieldControl: () => gate } }); f.receive('a', 2, 0);
    const pending = f.engine.rebuild(); f.service.clear(); release(); await pending;
    f.receive('a', 7, 1); assert.equal(f.engine.recordsSource.frames.length, 1);
    assert.equal(f.engine.syncSource.frames.getValue(0, 0), 7); assert.equal(f.engine.recordsSource.parser.deferDecode, false);
});

test('unsafe uint64 stays exact in protocol records and becomes a numeric gap while safe uint64 maps normally', async t => {
    const f = setup(t), wide = { id: 'wide', endian: 'little', framing: { header: [170], fixedLength: 10 },
        command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
        messages: [{ id: 'wide.value', command: 1, fields: [{ name: 'clock', type: 'uint64' }] }] };
    await f.engine.apply({ ...f.settings, protocols: [wide], protocolId: 'wide', mappings: [{ messageId: 'wide.value', path: 'clock', channel: 0 }] }, { rebuild: false });
    const compiled = Protocol.compile(wide);
    f.service.receive(Protocol.encode(compiled, 'wide.value', { clock: 18446744073709551615n }));
    assert.equal(f.engine.decode(0).record.fields.clock, 18446744073709551615n);
    assert.ok(Number.isNaN(f.engine.syncSource.frames.getValue(0, 0)));
    f.setNow(1); f.service.receive(Protocol.encode(compiled, 'wide.value', { clock: 42n }));
    assert.equal(f.engine.syncSource.frames.getValue(0, 1), 42);
});

test('preflight checks aggregate state memory and raw catalog conflicts before applied outputs can change', async t => {
    const f = setup(t), original = f.engine.recordsSource;
    const globals = { ...f.globals, channelDefinitions: [{ number: 3, type: 'formula', expression: 'CH1[-65536]' }] };
    const result = preflightDataEngine(f.settings, globals);
    assert.equal(result.outputCount, 5); assert.equal(result.requiredMemoryBytes, 5 * 65536 * 8);
    assert.throws(() => preflightDataEngine(f.settings, globals, { memoryLimitBytes: 2 * 1048576 }), /内存预算/);
    assert.throws(() => preflightDataEngine({ ...f.settings, mode: 'Data_Array', array: { ...array, channelsCount: '3' } }, globals), /冲突/);
    const invalid = { ...f.settings, mappings: [{ messageId: 'a', path: 'missing', channel: 0 }] };
    await assert.rejects(f.engine.apply(invalid), /字段/); assert.equal(f.engine.recordsSource, original);
    assert.equal(f.engine.output('message:missing'), f.engine.emptySource); assert.equal(f.engine.output(null), f.engine.syncSource);
});

test('dispatched child records can map ancestor fields and update both parent and child numeric outputs', async t => {
    const f = setup(t), dispatched = { id: 'dispatch', endian: 'little', framing: { header: [170], fixedLength: 6 },
        command: { offset: 1, type: 'uint8' }, payloadOffset: 2, messages: [{ id: 'parent', command: 3,
            fields: [{ name: 'sender', type: 'uint8' }, { name: 'sub', type: 'uint8' }],
            dispatch: { field: 'sub', offset: 2, name: 'content', messages: [{ id: 'child', command: 9, fields: [{ name: 'value', type: 'uint16' }] }] }
        }] };
    const next = { ...f.settings, protocols: [dispatched], protocolId: 'dispatch', mappings: [
        { messageId: 'parent', path: 'sender', channel: 1 }, { messageId: 'child', path: 'sender', channel: 0 }
    ] };
    await f.engine.apply(next, { rebuild: false });
    f.service.receive(Protocol.encode(Protocol.compile(dispatched), 'child', { sender: 7, sub: 9, content: { value: 22 } }));
    assert.equal(f.engine.syncSource.frames.getValue(0, 0), 7); assert.equal(f.engine.syncSource.frames.getValue(1, 0), 7);
    assert.equal(f.engine.outputs.get('message:parent').frames.length, 1); assert.equal(f.engine.outputs.get('message:child').frames.length, 1);
});

test('forced complete configuration replacement applies incoming formulas even when the array wire format is unchanged', async t => {
    const f = setup(t, { mode: 'Data_Array' }); f.service.receive(Uint8Array.of(2, 3)); f.service.endStream();
    f.globals.channelDefinitions = [{ number: 3, type: 'formula', expression: 'CH1*10' }];
    await f.engine.apply(f.engine.serialize(), { rebuild: true, force: true });
    assert.equal(f.engine.arraySource.frames.channelCount, 3); assert.equal(f.engine.arraySource.frames.getValue(2, 0), 20);
});

test('protocol scoped mappings never attach to another library protocol with the same message ID', async t => {
    const f = setup(t), other = { ...schema, id: 'other.protocol' };
    const next = f.engine.serialize(); next.protocols.push(other); await f.engine.apply(next, { rebuild: false });
    const switchProtocol = f.engine.serialize(); switchProtocol.protocolId = other.id;
    await f.engine.apply(switchProtocol, { rebuild: false }); f.receive('a', 7, 0);
    assert.ok(Number.isNaN(f.engine.syncSource.frames.getValue(0, 0)));
    const ambiguous = { ...next, mappings: [{ messageId: 'a', path: 'voltage', channel: 0 }] };
    assert.throws(() => normalizeDataEngine(ambiguous, f.globals), /明确协议编号/);
});

test('stable field IDs preserve indexed mappings after a schema field rename', async t => {
    const f = setup(t), renamed = { id: 'stable', endian: 'little', framing: { header: [170], fixedLength: 6 },
        command: { offset: 1, type: 'uint8' }, payloadOffset: 2, messages: [{ id: 'samples', command: 1,
            fields: [{ id: 'stable.samples', name: 'renamed', type: 'uint16', count: 2 }] }] };
    const mapping = { protocolId: 'stable', messageId: 'samples', path: 'old[0]', fieldId: 'stable.samples', channel: 0 };
    const compiled = Protocol.compile(renamed); assert.equal(resolveProtocolMappingField(compiled, mapping).name, 'renamed');
    await f.engine.apply({ ...f.settings, protocols: [renamed], protocolId: 'stable', mappings: [mapping] }, { rebuild: false });
    f.service.receive(Protocol.encode(compiled, 'samples', { renamed: [7, 99] }));
    assert.equal(f.engine.syncSource.frames.getValue(0, 0), 7);
});

test('leaving array mode releases its inactive frames, pending bytes and archive pin', async t => {
    const f = setup(t, { mode: 'Data_Array' }); f.service.receive(Uint8Array.of(2, 3, 4));
    assert.equal(f.engine.arraySource.frames.length, 1); assert.ok(f.engine.arraySource.parser.writeOffset > f.engine.arraySource.parser.readOffset);
    await f.engine.apply({ ...f.settings, mode: 'Raw_Data' }, { rebuild: false });
    assert.equal(f.engine.arraySource.frames.length, 0);
    assert.equal(f.engine.arraySource.parser.writeOffset, f.engine.arraySource.parser.readOffset);
    assert.equal(f.engine.arraySource.pin, null);
    await f.engine.apply({ ...f.settings, mode: 'Data_Array' }, { rebuild: true });
    assert.equal(f.engine.arraySource.frames.getValue(0, 0), 2); assert.equal(f.engine.arraySource.frames.getValue(1, 0), 3);
});

test('protocol worker field budgets split rejected batches in order and restore live parsing after a single-record rejection', async t => {
    let jobs = 0, rejectRecord = false;
    const workerPool = { maxWorkers: 1, workerLimit: 1, available: true, jobs: [], setWorkerLimit() {}, setFftCacheLimit() {}, clearFftCache() {}, dispose() {},
        async runTask(task) {
            jobs++; assert.ok(task.maxDecodedFields > 0);
            if (rejectRecord || task.records.length > 2) {
                const error = new RangeError('field budget'); error.code = rejectRecord ? 'protocol-record-limit' : 'protocol-batch-limit'; throw error;
            }
            return task.records.map(record => Protocol.decode(record.bytes, task.schema));
        } };
    const f = setup(t, { service: { workerPool } }), bytes = new Uint8Array(10 * 4);
    for (let index = 0; index < 10; index++) bytes.set(f.packet('a', index), index * 4);
    f.service.receive(bytes); await f.engine.rebuild(); assert.ok(jobs > 1);
    assert.deepEqual(f.engine.outputs.get('message:a').frames.channelSlice(0), Array.from({ length: 10 }, (_, index) => index));
    rejectRecord = true; await assert.rejects(f.engine.rebuild(), /内存预算/);
    assert.equal(f.engine.recordsSource.parser.deferDecode, false); assert.equal(f.service.paused, false);
    f.receive('a', 42, 1); assert.equal(f.engine.decode(0).record.fields.voltage, 42);
});

test('synchronization sample-rate edits update the exported source rate with and without history rebuilding', async t => {
    const f = setup(t); f.receive('a', 2, 0); f.setNow(3); f.engine.advance();
    for (const [sampleRate, rebuild] of [[500, false], [2000, true]]) {
        const next = f.engine.serialize(); next.synchronization.sampleRate = sampleRate;
        await f.engine.apply(next, { rebuild });
        assert.equal(f.engine.syncSource.frames.sampleRate, sampleRate); assert.equal(f.engine.syncSource.sampleRate.rate, sampleRate);
    }
});

test('invalid structured records remain inspectable without advancing message samples or held values', t => {
    const f = setup(t); f.receive('a', 12, 0);
    const message = f.engine.outputs.get('message:a'), before = message.frames.length;
    f.engine._record({ protocolId: schema.id, messageId: 'a', known: true, valid: false,
        flatFields: [{ path: 'voltage', value: 999 }], warnings: [{ code: 'bounds', message: '子段越界' }] },
    1, Uint8Array.of(170, 1, 231, 3), 1001, { order: 100, byteOffset: 4, endByte: 8, arrival: 1 });
    assert.equal(f.engine.recordsSource.frames.length, 2);
    assert.equal(message.frames.length, before);
    assert.equal(f.engine.syncSource.frames.getValue(0, f.engine.syncSource.frames.length - 1), 12);
    assert.equal(f.engine.decode(1).record.valid, false);
});

test('library ordering and presentation edits retain pending protocol bytes and retained samples', async t => {
    const f = setup(t); f.receive('a', 12, 0);
    const source = f.engine.recordsSource, message = f.engine.outputs.get('message:a');
    const packet = f.packet('a', 42); f.service.receive(packet.subarray(0, 2));
    const next = f.engine.serialize();
    next.protocols[0].name = '新显示名称'; next.protocols[0].messages.reverse();
    next.protocols[0].messages.find(item => item.id === 'a').name = '新的电压';
    next.protocols[0].messages.find(item => item.id === 'a').fields[0].label = '电压显示名';
    next.editorState = { samples: { [schema.id]: [{ name: '样例', hex: 'AA 01 00 00' }] } };
    await f.engine.apply(next, { rebuild: true });
    assert.ok(f.engine.recordsSource === source);
    assert.ok(f.engine.outputs.get('message:a') === message);
    assert.equal(source.parser.length, 2);
    f.service.receive(packet.subarray(2));
    assert.deepEqual(message.frames.channelSlice(0), [12, 42]);
    assert.equal(f.engine.decode(1).record.messageName, '新的电压');
});

test('TLV items map explicit array indexes and rebuild identically without multiplying physical frames', async t => {
    const f = setup(t), tlv = { schemaVersion: 2, id: 'tlv.capture', framing: { header: [170], fixedLength: 9 }, payloadOffset: 1,
        messages: [{ id: 'items.message', fields: [{ id: 'items', name: 'items', type: 'tlv', until: 'end',
            headerFields: [{ id: 'tag', name: 'tag', type: 'uint8' }, { id: 'size', name: 'size', type: 'uint8' }],
            selector: 'tag', lengthField: 'size', branches: [{ id: 'sample.branch', equals: 1, fields: [{ id: 'sample.value', name: 'value', type: 'uint16' }] },
                { id: 'other.branch', default: true, fields: [] }] }] }] };
    await f.engine.apply({ ...f.settings, protocols: [tlv], protocolId: tlv.id, mappings: [
        { protocolId: tlv.id, messageId: 'items.message', path: 'items[0].value', fieldId: 'sample.value', channel: 0 },
        { protocolId: tlv.id, messageId: 'items.message', path: 'items[1].value', fieldId: 'sample.value', channel: 1 }
    ] }, { rebuild: false });
    const bytes = Uint8Array.of(170, 1, 2, 42, 0, 1, 2, 99, 0);
    f.service.receive(bytes.subarray(0, 5)); f.service.receive(bytes.subarray(5)); f.service.endStream();
    const source = f.engine.outputs.get('message:items.message');
    assert.equal(f.engine.recordsSource.frames.length, 1); assert.equal(source.frames.length, 1);
    assert.equal(source.frames.getValue(0, 0), 42); assert.equal(source.frames.getValue(1, 0), 99);
    await f.engine.rebuild();
    const rebuilt = f.engine.outputs.get('message:items.message').frames;
    assert.equal(f.engine.recordsSource.frames.length, 1); assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt.getValue(0, 0), 42); assert.equal(rebuilt.getValue(1, 0), 99);
    assert.equal(f.service.history.byteLength, bytes.length);
});

test('until-end structures map explicit item indexes and preserve values through history rebuild',async t=>{
    const f=setup(t),config={id:'capture-to-end',schemaVersion:3,messages:[{id:'frame',byteLength:6,fields:[
        {id:'items',name:'items',type:'struct',byteLength:2,until:'end',fields:[{id:'value',name:'value',type:'uint16',byteLength:2}]}
    ]}]};
    await f.engine.apply({...f.settings,protocols:[config],protocolId:config.id,mappings:[
        {protocolId:config.id,messageId:'frame',path:'items[0].value',fieldId:'value',channel:0},
        {protocolId:config.id,messageId:'frame',path:'items[2].value',fieldId:'value',channel:1}
    ]},{rebuild:false});
    f.service.receive(Uint8Array.of(1,0,2));f.service.receive(Uint8Array.of(0,3,0));f.service.endStream();
    const frames=()=>f.engine.outputs.get('message:frame').frames;
    assert.equal(frames().length,1);assert.equal(frames().getValue(0,0),1);assert.equal(frames().getValue(1,0),3);
    await f.engine.rebuild();assert.equal(frames().length,1);assert.equal(frames().getValue(1,0),3);
});
