/** Real-time Node acquisition benchmark. Defaults: two engines, 23 channels, 5000 frames/s, 60 seconds. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay, setImmediate: immediate } = require('node:timers/promises');
const { CaptureService } = require('../captureService');
const { DataEngine } = require('../dataEngine');

const round = value => +value.toFixed(3);
function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function arrayFormat(channels) {
    return { dataType: 'float32', endianness: 'little', channelsCount: String(channels),
        enableHeader: true, headerHex: 'AB CD', enableFooter: false, footerHex: '', enableChecksum: false };
}
function mixedProtocol(channels) {
    const split = Math.ceil(channels / 2);
    return { id: 'benchmark.mixed', endian: 'little', framing: { header: [170],
        length: { offset: 2, type: 'uint16', adjustment: 0 }, maxLength: 4 * split + 5 },
        command: { offset: 1, type: 'uint8' }, payloadOffset: 4, payloadEnd: -1,
        checksums: [{ type: 'sum', width: 8, start: 0, end: -1, offset: -1 }],
        messages: [{ id: 'A', command: 1, fields: [{ name: 'values', type: 'float32', count: split }] },
            { id: 'B', command: 2, fields: [{ name: 'values', type: 'float32', count: channels - split }] }] };
}
function arrayBatch(first, count, channels) {
    const size = channels * 4 + 2, bytes = new Uint8Array(size * count), view = new DataView(bytes.buffer);
    for (let index = 0; index < count; index++) {
        const offset = index * size; bytes[offset] = 171; bytes[offset + 1] = 205;
        for (let channel = 0; channel < channels; channel++) view.setFloat32(offset + 2 + channel * 4, first + index + channel / 32, true);
    }
    return bytes;
}
function protocolBatch(first, count, channels) {
    const split = Math.ceil(channels / 2), lengthA = split * 4 + 5, lengthB = (channels - split) * 4 + 5;
    const countA = Math.floor(count / 2) + (count % 2 && first % 2 === 0 ? 1 : 0);
    const bytes = new Uint8Array(countA * lengthA + (count - countA) * lengthB), view = new DataView(bytes.buffer);
    let offset = 0;
    for (let index = 0; index < count; index++) {
        const sequence = first + index, a = sequence % 2 === 0, from = a ? 0 : split, end = a ? split : channels;
        const size = a ? lengthA : lengthB;
        bytes[offset] = 170; bytes[offset + 1] = a ? 1 : 2; view.setUint16(offset + 2, size, true);
        for (let channel = from; channel < end; channel++) view.setFloat32(offset + 4 + (channel - from) * 4, sequence + channel / 32, true);
        let sum = 0; for (let byte = offset; byte < offset + size - 1; byte++) sum += bytes[byte];
        bytes[offset + size - 1] = sum & 255; offset += size;
    }
    return bytes;
}
async function prepare(mode, settings) {
    const format = arrayFormat(settings.channels), errors = [];
    const service = new CaptureService({ capacity: settings.capacity, numericFormat: format,
        catalogCount: settings.channels, maxRawFrameBytes: 4096, memoryLimitBytes: settings.budgetBytes,
        workerOptions: { maxWorkers: 0 }, onError: error => errors.push(error.message ?? String(error)),
        onMemoryPressure: state => { if (state.blocked) errors.push(state.blockedReason); } });
    const globals = { ...format, channelDefinitions: [], channelNames: [], maxPoints: String(settings.capacity), rebuildHistory: false };
    const split = Math.ceil(settings.channels / 2), schema = mixedProtocol(settings.channels);
    const config = { mode, array: format, protocols: mode === 'Self_Defined_Frame' ? [schema] : [],
        protocolId: mode === 'Self_Defined_Frame' ? schema.id : null,
        mappings: mode === 'Self_Defined_Frame' ? Array.from({ length: settings.channels }, (_, channel) =>
            ({ messageId: channel < split ? 'A' : 'B', path: `values[${channel < split ? channel : channel - split}]`, channel })) : [],
        synchronization: { sampleRate: 1000, expiry: {} } };
    const engine = new DataEngine(service, config, globals);
    await Promise.all([...service.sources].map(source => source.ready));
    const source = mode === 'Data_Array' ? service.numericSource : engine.recordsSource;
    const inputHash = createHash('sha256'), parsedHash = createHash('sha256');
    const state = { service, engine, source, errors, inputHash, parsedHash, received: 0,
        inputBytes: 0, parsedBytes: 0, processingMs: 0, peakEstimatedBytes: 0 };
    const parsed = source.parser.onFrameParsed;
    source.parser.onFrameParsed = (...args) => {
        const bytes = args[2]; state.received++; state.parsedBytes += bytes.length; parsedHash.update(bytes); parsed(...args);
    };
    return state;
}
function verifyArray(state, settings, expectedFrames) {
    const { source } = state, frames = source.frames, retained = Math.min(settings.capacity, expectedFrames);
    assert.equal(source.parser.frameCount, expectedFrames, 'Data_Array parser frame count');
    assert.equal(frames.length, retained, 'Data_Array retained frame count');
    for (let index = 0; index < retained; index++) {
        const sequence = expectedFrames - retained + index, bytes = frames.rawBytesAt(index);
        assert.deepEqual(bytes, arrayBatch(sequence, 1, settings.channels), 'Data_Array retained source bytes');
        for (let channel = 0; channel < settings.channels; channel++)
            assert.equal(frames.getValue(channel, index), Math.fround(sequence + channel / 32), `Data_Array ${sequence}/${channel}`);
    }
    return { retainedFrames: retained, allRetainedValuesVerified: true, allRetainedBytesVerified: true };
}
function verifyProtocol(state, settings, expectedFrames) {
    const { engine, source } = state, frames = source.frames, retained = Math.min(settings.capacity, expectedFrames);
    const split = Math.ceil(settings.channels / 2), lengthA = split * 4 + 5, lengthB = (settings.channels - split) * 4 + 5;
    assert.equal(source.parser.frameCount, expectedFrames, 'Protocol parser frame count');
    assert.equal(frames.length, retained, 'Protocol retained frame count');
    for (let index = 0; index < retained; index++) {
        const sequence = expectedFrames - retained + index;
        assert.deepEqual(frames.rawBytesAt(index), protocolBatch(sequence, 1, settings.channels), 'Protocol retained source bytes');
        const record = engine.decode(index).record, from = sequence % 2 ? split : 0, end = sequence % 2 ? settings.channels : split;
        assert.equal(record.messageId, sequence % 2 ? 'B' : 'A');
        for (let channel = from; channel < end; channel++) assert.equal(record.fields.values[channel - from], Math.fround(sequence + channel / 32));
    }
    const messageFrames = {};
    for (const [id, parity] of [['A', 0], ['B', 1]]) {
        const message = engine.outputs.get('message:' + id), total = parity ? Math.floor(expectedFrames / 2) : Math.ceil(expectedFrames / 2);
        messageFrames[id] = message.parser.frameCount;
        assert.equal(message.parser.frameCount, total, id + ' message count');
        assert.equal(message.frames.length, Math.min(total, settings.capacity));
        for (let index = 0; index < message.frames.length; index++) {
            const sequence = (total - message.frames.length + index) * 2 + parity;
            for (let channel = 0; channel < settings.channels; channel++) {
                const expected = (channel < split) === (parity === 0) ? Math.fround(sequence + channel / 32) : NaN;
                assert.equal(message.frames.getValue(channel, index), expected, `${id} retained ${index}/${channel}`);
            }
        }
    }
    const sync = engine.syncSource.frames;
    assert.equal(sync.length, Math.min(sync.next, settings.capacity), 'Synchronized retained sample count');
    for (let index = 0; index < sync.length; index++) for (let channel = 0; channel < settings.channels; channel++) {
        const origin = sync.provenanceAt(channel, index);
        if (!origin) { assert.ok(Number.isNaN(sync.getValue(channel, index))); continue; }
        const pair = Math.floor(origin.byteOffset / (lengthA + lengthB)), remainder = origin.byteOffset % (lengthA + lengthB);
        assert.ok(remainder === 0 || remainder === lengthA, 'Synchronized provenance must point to a complete source packet');
        const sequence = pair * 2 + (remainder ? 1 : 0);
        assert.equal(sequence % 2, channel < split ? 0 : 1, 'Synchronized provenance must belong to the channel message');
        assert.equal(sync.getValue(channel, index), Math.fround(sequence + channel / 32), `Synchronized ${index}/${channel}`);
        assert.ok(origin.timestamp <= sync.timestampAt(index) + .001, 'Synchronized output cannot read future messages');
    }
    for (let channel = 0; channel < settings.channels; channel++) {
        const parity = channel < split ? 0 : 1;
        const lastSequence = expectedFrames - 1 - ((expectedFrames - 1) % 2 !== parity ? 1 : 0);
        assert.equal(sync.getValue(channel, sync.length - 1), Math.fround(lastSequence + channel / 32), 'Final synchronized channel value');
    }
    return { retainedFrames: retained, messageFrames, allRetainedValuesVerified: true, allRetainedBytesVerified: true,
        synchronization: { sampleRateHz: 1000, generatedSamples: sync.next, retainedFrames: sync.length,
            allRetainedValuesAndProvenanceVerified: true, allFinalChannelValuesVerified: true } };
}

async function runBenchmark(options = {}) {
    const settings = { durationSeconds: options.durationSeconds ?? 60, framesPerSecond: options.framesPerSecond ?? 5000,
        channels: options.channels ?? 23, capacity: options.capacity ?? 5000, budgetBytes: (options.budgetMiB ?? 128) * 1048576,
        batchMs: 10 };
    assert.ok(Number.isFinite(settings.durationSeconds) && settings.durationSeconds > 0, 'Duration must be positive');
    for (const key of ['framesPerSecond', 'channels', 'capacity', 'budgetBytes']) assert.ok(Number.isSafeInteger(settings[key]) && settings[key] > 0, key + ' must be a positive integer');
    assert.ok(settings.channels >= 2 && settings.channels <= 4096, 'Channels must be between 2 and 4096');
    const target = Math.round(settings.durationSeconds * settings.framesPerSecond), totalBatches = Math.ceil(settings.durationSeconds * 1000 / settings.batchMs);
    assert.ok(target >= 2 && Number.isSafeInteger(target), 'The benchmark requires at least two frames');
    const states = await Promise.all([prepare('Data_Array', settings), prepare('Self_Defined_Frame', settings)]);
    const [array, custom] = states, lagSamples = [], schedulerSamples = [], progress = [];
    const onProgress = options.onProgress ?? (row => process.stderr.write(JSON.stringify({ progress: row }) + '\n'));
    let lateBatches = 0, lateFrames = 0, sent = 0, nextProgress = 15000;
    const peakProcess = { rss: 0, heapUsed: 0, arrayBuffers: 0 }, cpuStart = process.cpuUsage(), began = performance.now(), wall = Date.now();
    const sampleMemory = () => {
        for (const state of states) {
            const memory = state.service.memoryUsage(); state.peakEstimatedBytes = Math.max(state.peakEstimatedBytes, memory.usedBytes);
            assert.ok(memory.usedBytes <= settings.budgetBytes, 'Capture estimate exceeds its engine budget');
        }
        const memory = process.memoryUsage(); for (const key of Object.keys(peakProcess)) peakProcess[key] = Math.max(peakProcess[key], memory[key]);
    };
    let lastLoopSample = performance.now();
    const lagTimer = setInterval(() => { const now = performance.now(); lagSamples.push(Math.max(0, now - lastLoopSample - 10)); lastLoopSample = now; }, 10);
    const memoryTimer = setInterval(sampleMemory, 100);
    let captureEnded;
    try {
        sampleMemory();
        for (let batch = 0; batch < totalBatches; batch++) {
            const deadline = began + Math.min(settings.durationSeconds * 1000, (batch + 1) * settings.batchMs);
            while (performance.now() < deadline) {
                const remaining = deadline - performance.now();
                if (remaining > 2) await delay(Math.max(1, Math.floor(remaining - 1))); else await immediate();
            }
            const lateness = Math.max(0, performance.now() - deadline), end = batch + 1 === totalBatches ? target
                : Math.min(target, Math.floor((batch + 1) * settings.batchMs * settings.framesPerSecond / 1000));
            const count = end - sent; schedulerSamples.push(lateness);
            if (lateness > settings.batchMs) { lateBatches++; lateFrames += count; }
            if (count) {
                const blocks = [arrayBatch(sent, count, settings.channels), protocolBatch(sent, count, settings.channels)];
                const arrival = performance.now(), timestamp = wall + arrival - began;
                // Alternate the first engine each batch so neither always receives the scheduling advantage.
                for (const index of batch % 2 ? [1, 0] : [0, 1]) {
                    const state = states[index], bytes = blocks[index]; state.inputHash.update(bytes); state.inputBytes += bytes.length;
                    const started = performance.now(); state.service.receive(bytes, { arrival, timestamp }); state.processingMs += performance.now() - started;
                }
                sent = end;
            }
            const elapsed = performance.now() - began;
            if (elapsed >= nextProgress) {
                sampleMemory(); const row = { elapsedSeconds: round(elapsed / 1000), inputFramesPerEngine: sent,
                    dataArrayFrames: array.received, protocolFrames: custom.received, synchronizedSamples: custom.engine.syncSource.frames.next,
                    eventLoopP95Ms: round(percentile(lagSamples, .95)), estimatedMiB: states.map(state => round(state.service.memoryUsage().usedBytes / 1048576)) };
                progress.push(row); onProgress(row); nextProgress += 15000;
            }
            await immediate();
        }
        // Give the 1000 Hz table one full tick after the final mixed packet batch.
        await delay(3);
        for (const state of states) state.service.pause(true);
        captureEnded = performance.now(); sampleMemory();
        const cpu = process.cpuUsage(cpuStart), verificationBegan = performance.now();
        const base = state => {
            assert.equal(state.errors.length, 0, state.errors.join('; '));
            assert.equal(state.received, target, 'No parsed frames may be lost');
            assert.equal(state.parsedBytes, state.inputBytes, 'Every input byte must belong to a parsed frame');
            assert.equal(state.service.stats.rxBytes, state.inputBytes);
            const inputSha256 = state.inputHash.digest('hex'), parsedSha256 = state.parsedHash.digest('hex');
            assert.equal(parsedSha256, inputSha256, 'The entire parsed byte stream must exactly match the generated input');
            return { expectedFrames: target, receivedFrames: state.received, droppedFrames: target - state.received,
                inputBytes: state.inputBytes, parsedBytes: state.parsedBytes, inputSha256, parsedSha256,
                processingMs: round(state.processingMs), averageFramesPerSecond: round(state.received / ((captureEnded - began) / 1000)),
                peakEstimatedBytes: state.peakEstimatedBytes, finalEstimatedBytes: state.service.memoryUsage().usedBytes,
                budgetEvictedFrames: state.service.memoryUsage().evictedFrames };
        };
        const result = { scope: 'Node acquisition only; no browser or drawing FPS', verified: true,
            node: process.version, platform: process.platform, completedAt: new Date().toISOString(),
            settings: { ...settings, budgetBytesPerEngine: settings.budgetBytes },
            actualCaptureSeconds: round((captureEnded - began) / 1000), captureCpuMs: round((cpu.user + cpu.system) / 1000),
            eventLoopDelay: { samplingIntervalMs: 10, samples: lagSamples.length,
                p50Ms: round(percentile(lagSamples, .5)), p95Ms: round(percentile(lagSamples, .95)), maxMs: round(Math.max(0, ...lagSamples)) },
            scheduler: { batchIntervalMs: 10, batches: totalBatches, lateThresholdMs: settings.batchMs, lateBatches, lateFrames,
                p95LatenessMs: round(percentile(schedulerSamples, .95)), maxLatenessMs: round(Math.max(0, ...schedulerSamples)),
                note: 'Late frames are delivered in catch-up batches; they are not counted as dropped frames.' },
            memorySamplingIntervalMs: 100, peakProcessBytes: peakProcess,
            dataArray: { ...base(array), ...verifyArray(array, settings, target) },
            customProtocol: { ...base(custom), ...verifyProtocol(custom, settings, target) }, progress };
        result.verificationMs = round(performance.now() - verificationBegan);
        return result;
    } finally {
        clearInterval(lagTimer); clearInterval(memoryTimer);
        for (const state of states) state.service.dispose();
    }
}

function parseArguments(argv) {
    const options = {}, keys = { '--duration': 'durationSeconds', '--rate': 'framesPerSecond', '--channels': 'channels', '--capacity': 'capacity', '--budget-mib': 'budgetMiB' };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--output') { if (!argv[index + 1]) throw new Error('--output requires a path'); options.output = argv[++index]; }
        else if (keys[argument]) { if (!argv[index + 1]) throw new Error(argument + ' requires a value'); options[keys[argument]] = Number(argv[++index]); }
        else throw new Error('Unknown argument: ' + argument);
    }
    return options;
}
if (require.main === module) {
    const options = parseArguments(process.argv.slice(2));
    runBenchmark(options).then(result => {
        const json = JSON.stringify(result, null, 2) + '\n';
        if (options.output) { const output = path.resolve(options.output); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, json); }
        process.stdout.write(json);
    }).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
module.exports = { runBenchmark };
