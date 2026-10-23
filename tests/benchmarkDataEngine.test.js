const test = require('node:test');
const assert = require('node:assert/strict');
const { runBenchmark } = require('../scripts/benchmarkDataEngine');

test('the wall-clock capture benchmark verifies both independent engines and bounded retained data', async () => {
    const result = await runBenchmark({ durationSeconds: .12, framesPerSecond: 1000, channels: 23,
        capacity: 50, budgetMiB: 32, onProgress: () => {} });
    assert.equal(result.scope, 'Node acquisition only; no browser or drawing FPS');
    assert.equal(result.verified, true);
    assert.equal(result.dataArray.expectedFrames, 120);
    assert.equal(result.dataArray.receivedFrames, 120);
    assert.equal(result.dataArray.retainedFrames, 50);
    assert.equal(result.dataArray.droppedFrames, 0);
    assert.equal(result.customProtocol.receivedFrames, 120);
    assert.equal(result.customProtocol.messageFrames.A, 60);
    assert.equal(result.customProtocol.messageFrames.B, 60);
    assert.equal(result.customProtocol.retainedFrames, 50);
    assert.equal(result.customProtocol.synchronization.retainedFrames, 50);
    assert.equal(result.customProtocol.synchronization.allFinalChannelValuesVerified, true);
    assert.equal(result.dataArray.inputSha256, result.dataArray.parsedSha256);
    assert.equal(result.customProtocol.inputSha256, result.customProtocol.parsedSha256);
    assert.ok(result.eventLoopDelay.p95Ms >= 0);
    assert.ok(result.dataArray.peakEstimatedBytes <= result.settings.budgetBytesPerEngine);
    assert.ok(result.customProtocol.peakEstimatedBytes <= result.settings.budgetBytesPerEngine);
});
