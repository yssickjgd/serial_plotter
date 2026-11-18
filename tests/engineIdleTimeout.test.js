const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptureService } = require('../captureService');
const { DataEngine, normalizeDataEngine } = require('../dataEngine');
const { RawFrameParser } = require('../rawFrameParser');
const { CaptureHistory, replayCaptureHistory } = require('../captureHistory');

const array = { dataType: 'uint16', endianness: 'little', channelsCount: '1', enableHeader: true,
    headerHex: 'AB', enableFooter: false, footerHex: '0D 0A', enableChecksum: false };
const protocol = { id: 'idle-test', framing: { header: [170], fixedLength: 4 },
    command: { offset: 1, type: 'uint8' }, payloadOffset: 2,
    messages: [{ id: 'value', command: 1, fields: [{ name: 'v', type: 'uint16' }] }] };
function setup(t, mode, idleTimeouts = { Raw_Data: 1, Data_Array: 1, Self_Defined_Frame: 1 }) {
    let now = 0, id = 0; const timers = new Map();
    const clock = { now: () => now, wallNow: () => 1000 + now,
        setTimeout: (callback, delay) => { timers.set(++id, { callback, due: now + delay }); return id; },
        clearTimeout: timer => timers.delete(timer) };
    const globals = { ...array, channelsCount: '1', channelNames: [], channelDefinitions: [] };
    const service = new CaptureService({ numericFormat: array, capacity: 100, ...clock });
    const settings = { mode, array, protocols: [protocol], protocolId: protocol.id,
        mappings: [{ protocolId: protocol.id, messageId: 'value', path: 'v', channel: 0 }], idleTimeouts };
    const engine = new DataEngine(service, settings, globals); t.after(() => service.dispose());
    return { service, engine, settings, globals, timers, clock, at: value => { now = value; },
        receive: bytes => service.receive(Uint8Array.from(bytes)),
        fire: () => { for (const [key, timer] of [...timers]) if (timer.due <= now && timers.has(key)) {
            timers.delete(key); timer.callback();
        } } };
}

test('engine idle settings default to fifty milliseconds per mode and preserve explicit saved values', () => {
    assert.deepEqual(normalizeDataEngine(undefined, array).idleTimeouts,
        { Raw_Data: 50, Data_Array: 50, Self_Defined_Frame: 50 });
    assert.deepEqual(normalizeDataEngine({ idleTimeouts: { Raw_Data: 1, Data_Array: 0, Self_Defined_Frame: 100 } }, array).idleTimeouts,
        { Raw_Data: 1, Data_Array: 0, Self_Defined_Frame: 100 });
    const input = { idleTimeouts: { Raw_Data: 0, Data_Array: .5, Self_Defined_Frame: 25 } };
    const text = JSON.stringify(input), saved = normalizeDataEngine(input, array);
    assert.deepEqual(saved.idleTimeouts, input.idleTimeouts);
    assert.deepEqual(saved.rawIdleTimeouts, input.idleTimeouts);
    assert.deepEqual(normalizeDataEngine(undefined, array).rawIdleTimeouts,
        { Raw_Data: 50, Data_Array: 50, Self_Defined_Frame: 50 });
    const legacyDraft = { ...saved, idleTimeouts: { ...saved.idleTimeouts, Data_Array: 10 } };
    delete legacyDraft.rawIdleTimeouts;
    const migrated = normalizeDataEngine({ ...input, rawIdleTimeouts: { Data_Array: 20 }, draft: legacyDraft }, array);
    assert.deepEqual(migrated.rawIdleTimeouts, { ...input.idleTimeouts, Data_Array: 20 });
    assert.equal(migrated.draft.rawIdleTimeouts.Data_Array, 10);
    assert.equal(JSON.stringify(input), text);
    for (const value of [-1, '', null, true, 'NaN', Infinity, 2147483648])
        assert.throws(() => normalizeDataEngine({ idleTimeouts: { Data_Array: value } }, array), /空闲|毫秒|超时/);
});

test('default array timeout tolerates a short delivery gap and expires pending bytes at fifty milliseconds', t => {
    const f = setup(t, 'Data_Array', {});
    f.receive([0xab, 1]); f.at(5); f.fire();
    assert.equal(f.engine.output().errors.length, 0);
    f.receive([2]); assert.equal(f.engine.output().frames.getValue(0, 0), 0x201);
    f.receive([0xab, 3]); f.at(54); f.fire();
    assert.equal(f.engine.output().errors.length, 0);
    f.at(55); f.fire(); assert.equal(f.engine.output().errors[0].type, 'timeout');
});

test('raw zero disables silence framing but preserves size cuts and first-byte timestamps', t => {
    const f = setup(t, 'Raw_Data', { Raw_Data: 0 });
    f.receive([1,2]); f.at(100); f.fire(); f.receive([3]);
    assert.equal(f.service.baseSource.frames.length, 0);
    assert.equal(f.service.baseSource.parser.length, 3);
    f.service.endStream();
    assert.deepEqual([...f.service.baseSource.frames.rawBytesAt(0)], [1,2,3]);
    assert.equal(f.service.baseSource.frames.timestampAt(0), 1000);
    const parser = new RawFrameParser(); parser.setFormat({ idleGapSeconds: 0, maxFrameBytes: 2 });
    const parts=[]; parser.onFrameParsed=bytes=>parts.push([...bytes]);parser.appendData(Uint8Array.of(1,2,3));
    parser.flushPending();assert.deepEqual(parts,[[1,2],[3]]);
});

test('array timeout reports only pending bytes and normal complete frames remain immediate', t => {
    const f=setup(t,'Data_Array');f.receive([0xab,1]);const old=[...f.timers.values()].map(timer=>timer.callback);
    assert.equal(f.engine.output().frames.length,0);f.at(1);f.fire();
    const errors=f.engine.output().errors;assert.equal(errors.length,1);assert.equal(errors[0].type,'timeout');
    assert.deepEqual([...errors[0].bytes],[0xab,1]);assert.equal(errors[0].timestamp,1000);
    f.receive([0xab,0x12,0x34]);assert.equal(f.engine.output().frames.getValue(0,0),0x3412);
    f.at(1.2);f.receive([0xab,2]);old.forEach(callback=>callback());
    assert.equal(f.engine.output().parser.writeOffset-f.engine.output().parser.readOffset,2);
    f.at(1.5);f.receive([3]);assert.equal(f.engine.output().frames.getValue(0,1),0x302);
    f.at(10);f.fire();assert.equal(errors.length,1,'finished frames never become timeout errors');
});

test('array arrival gaps time out residuals even if the timer is late and zero permits long split frames', t => {
    const f=setup(t,'Data_Array');f.receive([0xab,1]);f.at(2);f.receive([0xab,2,3]);
    assert.equal(f.engine.output().errors[0].type,'timeout');assert.equal(f.engine.output().frames.getValue(0,0),0x302);
    const off=setup(t,'Data_Array',{Data_Array:0});off.receive([0xab,1]);off.at(100);off.fire();off.receive([2]);
    assert.equal(off.engine.output().frames.getValue(0,0),0x201);assert.equal(off.engine.output().errors.length,0);
});

test('protocol timeout keeps raw bytes without stopping synchronized sampling or changing completed values', async t => {
    const f=setup(t,'Self_Defined_Frame');f.receive([170,1,7,0]);
    assert.equal(f.engine.outputs.get('message:value').frames.getValue(0,0),7);assert.equal(f.engine.running,true);
    f.at(.2);f.receive([170,1,8]);f.at(1.2);f.fire();
    assert.equal(f.engine.recordsSource.errors[0].type,'timeout');assert.equal(f.engine.running,true);
    assert.equal(f.engine.outputs.get('message:value').frames.length,1);
    assert.deepEqual([...f.engine.recordsSource.errors[0].bytes],[170,1,8]);
    f.at(2);f.receive([170,1,9,0]);assert.equal(f.engine.outputs.get('message:value').frames.getValue(0,1),9);
    await f.engine.rebuild();
    assert.equal(f.engine.recordsSource.errors.filter(error=>error.type==='timeout').length,1);
    assert.equal(f.engine.outputs.get('message:value').frames.length,2);
    assert.equal(f.engine.outputs.get('message:value').frames.getValue(0,1),9);
});

test('protocol zero keeps long split frames and pause still reports a non-timeout incomplete tail', t => {
    const f=setup(t,'Self_Defined_Frame',{Self_Defined_Frame:0});
    f.receive([170,1,7]);f.at(100);f.fire();f.receive([0]);
    assert.equal(f.engine.recordsSource.errors.length,0);
    assert.equal(f.engine.outputs.get('message:value').frames.getValue(0,0),7);
    f.receive([170,1,8]);f.at(200);f.fire();assert.equal(f.engine.recordsSource.errors.length,0);
    f.service.pause(true);assert.equal(f.engine.recordsSource.errors[0].type,'incomplete');
    assert.equal(f.engine.recordsSource.errors[0].timestamp,1100);
});

test('numeric replay uses recorded arrival gaps and carries a disabled timeout across catchup', async () => {
    const history=new CaptureHistory();history.append(Uint8Array.of(0xab,1),{arrival:0,timestamp:1000});
    history.append(Uint8Array.of(0xab,2,3),{arrival:2,timestamp:1002});
    const on=await replayCaptureHistory(history,{...array,captureMode:'number',idleTimeoutMs:1},100,{flushPending:false});
    assert.equal(on.errors.filter(error=>error.type==='timeout').length,1);
    assert.equal(on.frames.length,1);assert.equal(on.frames.getValue(0,0),0x302);on.parser.reset();
    const offHistory=new CaptureHistory();offHistory.append(Uint8Array.of(0xab,1),{arrival:0,timestamp:1000});
    offHistory.append(Uint8Array.of(2),{arrival:100,timestamp:1100});
    const off=await replayCaptureHistory(offHistory,{...array,captureMode:'number',idleTimeoutMs:0},100,{flushPending:false});
    assert.equal(off.frames.getValue(0,0),0x201);assert.equal(off.errors.length,0);off.parser.reset();
});

test('inactive mode idle edits preserve live outputs and switching restores separate saved settings', async t => {
    const f=setup(t,'Data_Array',{Data_Array:5,Raw_Data:0,Self_Defined_Frame:20});
    f.receive([0xab,1,0]);const source=f.engine.output();
    const settings=f.engine.serialize();settings.rawIdleTimeouts.Raw_Data=10;
    await f.engine.apply(settings,{rebuild:false});assert.equal(f.engine.output(),source);assert.equal(source.frames.length,1);
    await f.engine.apply({...f.engine.serialize(),mode:'Raw_Data'},{rebuild:false});
    assert.equal(f.service.baseSource.parser.idleGapSeconds,.01);
    await f.engine.apply({...f.engine.serialize(),mode:'Data_Array'},{rebuild:false});
    assert.equal(f.service.baseSource.parser.idleGapSeconds,.005);
    assert.deepEqual(normalizeDataEngine(JSON.parse(JSON.stringify(f.engine.serialize())),f.globals).rawIdleTimeouts,
        {Raw_Data:10,Data_Array:5,Self_Defined_Frame:20});
});

test('clear and disposal cancel old timeout callbacks before they can write errors', t => {
    const f=setup(t,'Self_Defined_Frame');f.receive([170,1,8]);
    const old=[...f.timers.values()].map(timer=>timer.callback);f.service.clear();f.at(100);old.forEach(callback=>callback());
    assert.equal(f.engine.recordsSource.errors.length,0);assert.equal(f.service.history.byteLength,0);
    f.receive([170,1,8]);const later=[...f.timers.values()].map(timer=>timer.callback);
    f.service.dispose();later.forEach(callback=>callback());assert.equal(f.timers.size,0);
});

test('paused rebuilds keep the timeout reason from before the pause boundary', async t => {
    for (const mode of ['Data_Array','Self_Defined_Frame']) {
        const f=setup(t,mode);f.receive(mode==='Data_Array'?[0xab,1]:[170,1,8]);
        f.at(1);f.fire();const source=mode==='Data_Array'?f.engine.output():f.engine.recordsSource;
        assert.equal(source.errors[0].type,'timeout');f.at(2);f.service.pause(true);
        if(mode==='Data_Array')await f.service.updateNumericFormat(source.format,{rebuild:true});
        else await f.engine.rebuild();
        assert.equal(source.errors.length,1);assert.equal(source.errors[0].type,'timeout',mode);
        assert.equal(source.errors[0].timestamp,1000);
        f.service.pause(false);f.at(3);f.receive(mode==='Data_Array'?[0xab,2]:[170,1,9]);
        f.at(4);f.fire();assert.equal(source.errors.length,2,mode+' restores its live timer after paused replay');
        assert.equal(source.errors[1].type,'timeout');
    }
});

test('raw idle and line-ending sources stay shared and independent while the active engine timeout changes', async t => {
    const f=setup(t,'Raw_Data',{Raw_Data:0});
    const hex=f.service.acquireSource({captureMode:'hex'}), line=f.service.acquireSource({captureMode:'text',textBoundary:'lf'});
    assert.equal(hex,f.service.baseSource);f.receive([65,10,66]);f.at(10);f.fire();
    assert.equal(line.frames.length,1);assert.equal(hex.frames.length,0);
    const settings=f.engine.serialize();settings.rawIdleTimeouts.Raw_Data=2;
    await f.engine.apply(settings,{rebuild:true});
    assert.equal(line.frames.length,1);assert.equal(hex.parser.idleGapSeconds,.002);
    f.at(12);f.fire();assert.equal(hex.frames.length,1);assert.equal(hex.frames.timestampAt(0),1000);
});
