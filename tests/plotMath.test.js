const test = require('node:test');
const assert = require('node:assert/strict');
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

test('CSV channel names with separators, quotes or line breaks are escaped', () => {
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('a"b'), '"a""b"');
    assert.equal(csvField('a\nb'), '"a\nb"');
});
