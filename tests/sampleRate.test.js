const test = require('node:test');
const assert = require('node:assert/strict');
const { SampleRateEstimator } = require('../sampleRate');

test('packet-arrival sampling rate remains stable despite batching and timer jitter', () => {
    const estimate = new SampleRateEstimator();
    let count = 0;
    for (let ms = 0; ms <= 2000; ms += 10) estimate.observe(count += 10, ms);
    assert.equal(estimate.rate, 1000);
    const rates = [];
    for (let ms = 2010; ms < 30000; ms += 10) {
        count += 10;
        estimate.observe(count, ms + (ms % 30 === 0 ? 2 : -2));
        rates.push(estimate.rate);
    }
    assert.deepEqual([...new Set(rates)], [1000]);
    assert.ok(estimate.points.length - estimate.head <= 1002, 'timing history is bounded');
});

test('sampling-rate changes must persist and pause boundaries exclude idle time', () => {
    const estimate = new SampleRateEstimator();
    let count = 0;
    for (let ms = 0; ms <= 12000; ms += 10) estimate.observe(count += 10, ms);
    assert.equal(estimate.rate, 1000);
    estimate.reset({ keepRate: true });
    for (let ms = 30000; ms <= 35000; ms += 10) estimate.observe(count += 10, ms);
    assert.equal(estimate.rate, 1000);
    for (let ms = 35010; ms <= 65000; ms += 10) estimate.observe(count += 20, ms);
    assert.equal(estimate.rate, 2000);
    estimate.reset(); assert.equal(estimate.rate, 0);
    estimate.observe(1, 1); estimate.observe(1, 10000);
    assert.equal(estimate.rate, 0, 'no accepted samples cannot invent a sampling rate');
});

test('sampling rate handles fractional rates, counter reset and non-monotonic input', () => {
    const estimate = new SampleRateEstimator();
    for (let i = 0; i <= 60; i++) estimate.observe(i * 5, i * 400);
    assert.equal(estimate.rate, 12.5);
    estimate.observe(1, 25000);
    assert.equal(estimate.rate, 0, 'a reset counter begins a new measurement');
    estimate.observe(2, 24000); estimate.observe(NaN, 26000); estimate.observe(3, Infinity);
    assert.equal(estimate.rate, 0);
});

test('packets without valid numeric frames do not start the sample clock', () => {
    const estimate = new SampleRateEstimator();
    estimate.observe(0, 0); estimate.observe(0, 50000);
    for (let ms = 60000; ms <= 62000; ms += 10) estimate.observe((ms - 60000) + 10, ms);
    assert.equal(estimate.rate, 1000);
});
