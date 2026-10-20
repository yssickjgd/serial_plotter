/** node --expose-gc scripts/memoryStress.js [durationSeconds]; no browser or serial hardware required. */
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { CaptureService } = require('../captureService');

async function main() {
    const duration = Number(process.argv[2] ?? 0);
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError('Duration must be nonnegative');
    const limit = 64 * 1048576, batches = 1200, batchSize = 250, frameLength = 96;
    const service = new CaptureService({ capacity: 3600000, memoryLimitBytes: limit, maxRawFrameBytes: 1024,
        numericFormat: { captureMode: 'number', enableHeader: false, enableFooter: true,
            footerHex: '00 00 80 7F', channelsCount: 23, dataType: 'float32', isLittleEndian: true },
        setTimeout: () => 0, clearTimeout() {} });
    const text = service.acquireSource({ captureMode: 'text', textBoundary: 'lf' });
    const block = new Uint8Array(batchSize * frameLength), view = new DataView(block.buffer);
    const began = performance.now(), samples = [];
    try {
        await text.ready;
        for (let batch = 0; batch < batches; batch++) {
            for (let i = 0; i < batchSize; i++) {
                const frame = batch * batchSize + i, offset = i * frameLength;
                for (let c = 0; c < 23; c++) view.setFloat32(offset + c * 4, frame + c / 32, true);
                block.set([0, 0, 128, 127], offset + 92);
            }
            service.receive(block, { arrival: batch * 50, timestamp: 1700000000000 + batch * 50 });
            if ((batch + 1) % 200 === 0) {
                global.gc?.();
                const memory = service.memoryUsage(), processMemory = process.memoryUsage();
                assert.equal(service.paused, false);
                assert.ok(memory.usedBytes <= limit);
                const row = { receivedFrames: (batch + 1) * batchSize,
                    retainedFrames: service.numericSource.frames.length,
                    captureMiB: +(memory.usedBytes / 1048576).toFixed(1),
                    heapMiB: +(processMemory.heapUsed / 1048576).toFixed(1),
                    arrayBuffersMiB: +(processMemory.arrayBuffers / 1048576).toFixed(1),
                    rssMiB: +(processMemory.rss / 1048576).toFixed(1) };
                samples.push(row); process.stdout.write(JSON.stringify(row) + '\n');
            }
            if (duration) {
                const remaining = began + (batch + 1) * duration * 1000 / batches - performance.now();
                if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
            }
        }
        service.endStream();
        const frames = service.numericSource.frames;
        assert.equal(service.numericSource.parser.frameCount, 300000);
        assert.ok(frames.length >= 5000);
        for (let i = frames.length - 5000; i < frames.length; i++) {
            const bytes = frames.rawBytesAt(i), values = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
            const expected = 300000 - frames.length + i;
            for (let c = 0; c < 23; c++) {
                assert.equal(frames.getValue(c, i), expected + c / 32);
                assert.equal(values.getFloat32(c * 4, true), expected + c / 32);
            }
        }
        process.stdout.write(JSON.stringify({ verified: true, elapsedSeconds: +(performance.now() - began).toFixed(0) / 1000,
            retainedFrames: frames.length, evictedSourceRecords: service.memoryUsage().evictedFrames,
            latest5000FramesMatch: true, samples: samples.length }) + '\n');
    } finally { service.dispose(); }
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
