const test = require('node:test');
const assert = require('node:assert/strict');
const { bucketExtrema, csvField } = require('../plotMath');

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

test('pixel buckets retain both narrow positive and negative spikes', () => {
    const points = bucketExtrema([0, 0, 9, 0, -7, 0, 0, 0], 2);
    assert.deepEqual(points, [
        { index: 0, value: 0 }, { index: 2, value: 9 },
        { index: 4, value: -7 }, { index: 5, value: 0 },
        { index: 7, value: 0 }
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
