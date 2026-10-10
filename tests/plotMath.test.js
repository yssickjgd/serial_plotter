const test = require('node:test');
const assert = require('node:assert/strict');

test('spectral pixel buckets retain gaps even when both segments occupy one pixel', () => {
    const points = bucketAxisExtrema([1, NaN, 2, 3], [0, 0.1, 0.2, 1]);
    assert.ok(points.find(point => point.index === 2)?.break);
    assert.deepEqual(points.map(point => point.index), [0, 2, 3]);
});
const { axisFraction, axisValueAtFraction, bucketAxisExtrema,
    bucketExtrema, csvField } = require('../plotMath');

test('rectangle selection maps screen pixels to sample and Y ranges', () => {
    const { zoomRectToBounds } = require('../plotMath');
    const result = zoomRectToBounds({ x0: 200, y0: 300, x1: 600, y1: 100,
        plotWidth: 800, plotHeight: 400, startIndex: 100,
        visibleCount: 101, min: -10, max: 10 });
    assert.deepEqual(result, { scrollOffset: 125, displayCount: 51, yMin: -5, yMax: 5 });
    assert.equal(zoomRectToBounds({ x0: 1, y0: 1, x1: 4, y1: 200,
        plotWidth: 800, plotHeight: 400, startIndex: 0,
        visibleCount: 101, min: 0, max: 1 }), null);
});

test('log axes map decades evenly and rectangle zoom uses the same transform', () => {
    assert.ok(Math.abs(axisFraction(10, 1, 100, 'log') - 0.5) < 1e-12);
    assert.ok(Math.abs(axisValueAtFraction(0.5, 1, 100, 'log') - 10) < 1e-12);
    assert.ok(Number.isNaN(axisFraction(0, 1, 100, 'log')));
    const { zoomRectToBounds } = require('../plotMath');
    const zoom = zoomRectToBounds({ x0: 0, x1: 400, y0: 100, y1: 300,
        plotWidth: 800, plotHeight: 400, startIndex: 1, visibleCount: 1000,
        min: 0.01, max: 100, xScale: 'log', yScale: 'log' });
    assert.equal(zoom.scrollOffset, 1);
    assert.equal(zoom.displayCount, 31);
    assert.ok(Math.abs(zoom.yMin - 0.1) < 1e-12);
    assert.ok(Math.abs(zoom.yMax - 10) < 1e-12);
});

test('zero-inclusive log axes are linear near zero and preserve amplitude round trips', () => {
    const { adaptiveLogScale, axisToDomain, axisFromDomain } = require('../plotMath');
    const scale = adaptiveLogScale(0.2, 1);
    assert.equal(scale.linearThreshold, 0.002);
    assert.equal(axisToDomain(0, scale), 0);
    assert.equal(axisToDomain(0.001, scale), 0.5);
    assert.equal(axisToDomain(0.002, scale), 1);
    assert.ok(Math.abs(axisToDomain(0.02, scale) - (1 + Math.log(10))) < 1e-12);
    assert.equal(axisFromDomain(0, scale), 0);
    assert.equal(axisFraction(0, 0, 1, scale), 0);
    assert.equal(axisValueAtFraction(1, 0, 1, scale), 1);
    for (const amplitude of [0, 0.0001, 0.001, 0.002, 0.01, 0.1, 1]) {
        const position = axisFraction(amplitude, 0, 1, scale);
        assert.ok(Number.isFinite(position));
        assert.ok(Math.abs(axisValueAtFraction(position, 0, 1, scale) - amplitude) < 1e-12);
    }
    assert.ok(Math.abs(axisFraction(0.002, 0, 1, scale) -
        2 * axisFraction(0.001, 0, 1, scale)) < 1e-12);
});

test('zero-inclusive log threshold adapts to data, bounded ranges and silent spectra', () => {
    const { adaptiveLogScale } = require('../plotMath');
    assert.equal(adaptiveLogScale(2, 10).linearThreshold, 0.02);
    assert.equal(adaptiveLogScale(200, 1).linearThreshold, 0.01);
    const silent = adaptiveLogScale(0, 2);
    assert.equal(silent.linearThreshold, 2);
    assert.equal(axisFraction(1, 0, 2, silent), 0.5);
    for (const max of [Number.MIN_VALUE, 1e-280, 1e200]) {
        const scale = adaptiveLogScale(max, max);
        assert.ok(scale.linearThreshold > 0);
        assert.ok(Number.isFinite(axisFraction(max, 0, max, scale)));
        assert.equal(axisValueAtFraction(0, 0, max, scale), 0);
        assert.equal(axisValueAtFraction(1, 0, max, scale), max);
    }
});

test('pixel buckets retain both narrow positive and negative spikes', () => {
    const points = bucketExtrema([0, 0, 9, 0, -7, 0, 0, 0], 2);
    assert.deepEqual(points, [
        { index: 0, value: 0 }, { index: 2, value: 9 },
        { index: 4, value: -7 }, { index: 5, value: 0 },
        { index: 7, value: 0 }
    ]);
});

test('frequency pixel buckets preserve peak, trough and axis endpoints', () => {
    const result = bucketAxisExtrema([0, 9, -7, 0, 0], [0, 0.2, 0.4, 1.1, 2]);
    assert.deepEqual(result, [
        { index: 0, value: 0 }, { index: 1, value: 9 },
        { index: 2, value: -7 }, { index: 3, value: 0 },
        { index: 4, value: 0 }
    ]);
});

test('decimated trace still reaches its latest sample', () => {
    assert.deepEqual(bucketExtrema([0, 4, 1, 2], 1).at(-1), { index: 3, value: 2 });
});

test('invalid sensor values do not become canvas coordinates', () => {
    assert.deepEqual(bucketExtrema([0, NaN, Infinity, 2], 2), [
        { index: 0, value: 0 }, { index: 3, value: 2 }
    ]);
});

test('decimated trace retains breaks inside a pixel bucket', () => {
    const { bucketTraceExtrema } = require('../plotMath');
    assert.equal(typeof bucketTraceExtrema, 'function');
    const points = bucketTraceExtrema([1, 2, NaN, 3, 4, NaN, 5], 1);
    assert.deepEqual(points.filter(point => point.break).map(point => point.index), [3, 6]);
    assert.ok(points.every(point => Number.isFinite(point.value)));
});

test('CSV channel names with separators, quotes or line breaks are escaped', () => {
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('a"b'), '"a""b"');
    assert.equal(csvField('a\nb'), '"a\nb"');
});
