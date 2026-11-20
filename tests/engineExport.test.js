const test = require('node:test');
const assert = require('node:assert/strict');
const { SynchronizedFrames } = require('../engineFrames');
const { synchronizedCsvChunks, widgetExportSelection, parsedTextChunks, parsedByteChunks } = require('../engineExport');
const { structuredCsvChunksAsync } = require('../protocolRecords');
const { FrameBuffer } = require('../frameBuffer');
const { migrateWorkspaceConfig, validateWorkspaceConfig } = require('../widgetConfig');

test('parsed export follows visible wave channels, pose bindings and engine display choices', () => {
    const frames = { channelCount: 4, isSignal: index => index !== 2 };
    const source = { kind: 'numeric', frames };
    const channelNames = ['heading', 'speed', 'kernel', 'angle'];
    const wave = { id: 'wave-1', type: 'wave', source, settings: { plotContent: 'samples',
        channels: [{ visible: true }, { visible: false }, { visible: true }, { visible: true }] } };
    const selection = widgetExportSelection(wave, channelNames);
    assert.equal(selection.source, source);
    assert.deepEqual(selection.channelIndices, [0, 3]);
    assert.equal(selection.channels[3].name, 'angle');
    assert.equal(widgetExportSelection({ ...wave, settings: { plotContent: 'response' } }, channelNames), null);
    const pose = { type: 'pose', source, settings: {
        representation: 'euler', bindings: { euler: [3, 1, 3] },
        overlay: { enabled: false }
    } };
    assert.deepEqual(widgetExportSelection(pose, channelNames).channelIndices, [1, 3]);
    const byte = { type: 'byte', source, settings: { captureMode: 'hex', monitorDisplay: { numericHiddenChannels: [1] } } };
    assert.equal(widgetExportSelection(byte, channelNames), null);
    byte.settings.captureMode = 'engine';
    assert.deepEqual(widgetExportSelection(byte, channelNames).channelIndices, [0, 3]);
    byte.source = { kind: 'protocol', frames: {}, decodeRecord() {} };
    byte.settings.protocolFieldPaths = ['payload.speed'];
    assert.deepEqual(widgetExportSelection(byte, channelNames).fieldPaths, ['payload.speed']);
    assert.equal(widgetExportSelection(byte, channelNames, 'Raw_Data'), null);
});

test('parsed TXT exports selected values instead of interpreting wire bytes as characters', () => {
    const numeric = new FrameBuffer(2, 4);
    numeric.append([4, -2.5], Uint8Array.of(65), 't', 1);
    assert.equal([...parsedTextChunks({ source: { kind: 'numeric', frames: numeric }, channelIndices: [1] },
        { timestamps: true, markers: true })].join(''), '[t] RX CH00002=-2.5\r\n');
    const records = new FrameBuffer(1, 4); records.setRawMode(true);
    for (let i = 0; i < 3; i++) records.appendRaw(Uint8Array.of(i), 't', i);
    const decodeRecord = i => ({ status: ['ok', 'warning', 'error'][i], messageName: 'Test',
        flatFields: [{ path: 'payload.keep', value: 9007199254740993n }, { path: 'payload.drop', value: 'hidden' }] });
    const text = [...parsedTextChunks({ source: { kind: 'protocol', frames: records, decodeRecord }, fieldPaths: ['payload.keep'] })].join('');
    assert.match(text, /payload\.keep=9007199254740993/);
    assert.match(text, /警告/);
    assert.doesNotMatch(text, /payload\.drop|错误/);
    assert.equal((text.match(/payload\.keep=/g) ?? []).length, 2);
});

test('widget CSV includes valid warning frames and excludes failed and unknown records from rows and columns', async () => {
    const frames = new FrameBuffer(1, 5); frames.setRawMode(true);
    const statuses = ['ok', 'error', 'warning', 'unknown'];
    for (let i = 0; i < statuses.length; i++) frames.appendRaw(Uint8Array.of(i), 't', i);
    const decodeRecord = i => ({ status: statuses[i], flatFields: [{ path: statuses[i], value: i }] });
    const chunks = [];
    for await (const chunk of structuredCsvChunksAsync(frames, decodeRecord,
        { successfulOnly: true, yieldControl: async () => {} })) chunks.push(chunk);
    const lines = chunks.join('').trimEnd().split('\r\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /,ok,warning$/);
    assert.match(lines[1], /^0,/);
    assert.match(lines[2], /^2,/);
});

test('synchronized raw export writes contributing accepted original frames in order without duplicates', async () => {
    const retained = new FrameBuffer(1, 6); retained.setRawMode(true);
    for (let i = 0; i < 4; i++) retained.appendRaw(Uint8Array.of(0xaa, i), 't', i + 1, 1000 + i);
    const frames = new SynchronizedFrames(2, 10, { sampleRate: 1000 });
    frames.ingest(1000, new Map([[0, 2]]), { order: 1, byteOffset: 0 });
    frames.ingest(1001, new Map([[1, 3]]), { order: 2, byteOffset: 2 });
    frames.ingest(1002, new Map([[0, 5]]), { order: 3, byteOffset: 4 });
    frames.advance(1004);
    const source = { kind: 'numeric', frames };
    const protocol = { kind: 'protocol', frames: retained, decodeRecord: i => ({ status: i === 1 ? 'error' : 'ok' }) };
    const hex = [];
    for await (const chunk of parsedByteChunks({ source, channelIndices: [0] }, protocol, { format: 'hex-text' })) hex.push(chunk);
    assert.deepEqual(hex, ['AA 00\r\n', 'AA 02\r\n']);
});

test('synchronized binary export ignores expired held values when no valid sample retains them', async () => {
    const retained = new FrameBuffer(1, 2); retained.setRawMode(true);
    retained.appendRaw(Uint8Array.of(0xaa), 't', 1, 1000);
    const frames = new SynchronizedFrames(1, 2, { sampleRate: 1000, expiry: { 0: .001 } });
    frames.ingest(1000, new Map([[0, 2]]), { order: 1, byteOffset: 0 });
    frames.advance(1004);
    assert.equal(frames.statusAt(0, 0), 'expired');
    const protocol = { kind: 'protocol', frames: retained, decodeRecord: () => ({ status: 'ok' }) };
    const chunks = [];
    for await (const chunk of parsedByteChunks({ source: { kind: 'numeric', frames }, channelIndices: [0] }, protocol,
        { format: 'binary' })) chunks.push(chunk);
    assert.deepEqual(chunks, []);
});

test('export provenance can include more than the interactive limit of 64 origins', () => {
    const size = 65;
    const expression = Array.from({ length: size }, (_, index) => `[${index}]=1`).join(',');
    const frames = new SynchronizedFrames(1, size, { sampleRate: 1000, definitions: [
        { number: 2, type: 'constant', expression },
        { number: 3, type: 'formula', expression: 'filter(CH1,CH2)' }
    ] });
    for (let index = 0; index < size; index++)
        frames.ingest(1000 + index, new Map([[0, 1]]), { order: index + 1, byteOffset: index });
    assert.equal(frames.provenanceAt(2, size - 1).truncated, true);
    const origin = frames.provenanceAt(2, size - 1, { allOrigins: true });
    assert.equal(origin.truncated, undefined);
    assert.equal(origin.origins.length, size);
});

test('synchronized CSV honors timestamp choices and exports missing values and provenance state', () => {
    const frames = new SynchronizedFrames(2, 10, { sampleRate: 1000, expiry: { 0: .002 } });
    frames.ingest(1000, new Map([[0, 2]]), { order: 1, byteOffset: 7 }); frames.advance(1002);
    const plain = [...synchronizedCsvChunks(frames, [{ name: '温度' }, { name: '压力' }], { timestamps: false })].join('');
    assert.equal(plain, 'Index,温度,压力\r\n0,2,\r\n1,2,\r\n2,,\r\n');
    const states = [...synchronizedCsvChunks(frames, [{ name: '温度' }], { timestamps: true, channelIndices: [0], syncStates: true })].join('');
    assert.match(states, /Timestamp/); assert.match(states, /new,7/); assert.match(states, /held,7/); assert.match(states, /expired,7/);
});

test('structured CSV discovers columns asynchronously and preserves exact64 values', async () => {
    const frames = new FrameBuffer(1, 300); frames.setRawMode(true);
    for (let index = 0; index < 300; index++) frames.appendRaw(Uint8Array.of(index & 255), 't', index, index);
    let yields = 0, decoded = 0; const chunks = [];
    const decode = index => { decoded++; return { messageId: '值', flatFields: [{ path: index === 299 ? 'last' : 'clock', value: 9007199254740993n }] }; };
    for await (const chunk of structuredCsvChunksAsync(frames, decode, { yieldControl: async () => { yields++; } })) chunks.push(chunk);
    assert.ok(yields >= 2); assert.equal(decoded, 600); assert.match(chunks.join(''), /9007199254740993/); assert.match(chunks[0], /clock,last/);
});

test('Unicode and slash message identifiers can persist as explicit export sources', () => {
    const config = migrateWorkspaceConfig(null);
    config.tools.exportProfiles['engine:message:位置/速度'] = config.tools.exportProfiles.numeric;
    config.tools.exportSourceId = 'engine:message:位置/速度';
    assert.equal(validateWorkspaceConfig(config).tools.exportSourceId, 'engine:message:位置/速度');
});

test('variable arrays including empty arrays use one restorable JSON column', async () => {
    const frames = new FrameBuffer(1, 4); frames.setRawMode(true);
    for (let index = 0; index < 2; index++) frames.appendRaw(Uint8Array.of(0), 't', index, index);
    const decode = index => ({ fields: { points: index ? [{ x: 1 }, { x: 2 }] : [] },
        flatFields: index ? [{ path: 'points[0].x', value: 1 }, { path: 'points[1].x', value: 2 }] : [] });
    const chunks = [];
    for await (const chunk of structuredCsvChunksAsync(frames, decode, { yieldControl: async () => {} })) chunks.push(chunk);
    assert.match(chunks[0], /Warnings,points\r\n/); assert.doesNotMatch(chunks[0], /points\[/);
    assert.match(chunks.join(''), /\[\]/); assert.match(chunks.join(''), /x""/);
});
