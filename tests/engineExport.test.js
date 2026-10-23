const test = require('node:test');
const assert = require('node:assert/strict');
const { SynchronizedFrames } = require('../engineFrames');
const { synchronizedCsvChunks } = require('../engineExport');
const { structuredCsvChunksAsync } = require('../protocolRecords');
const { FrameBuffer } = require('../frameBuffer');
const { migrateWorkspaceConfig, validateWorkspaceConfig } = require('../widgetConfig');

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
