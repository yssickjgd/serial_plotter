const test = require('node:test');
const assert = require('node:assert/strict');
const { waveletPalette, heatmapPaths, paintHeatmap, waveletCell, waveletCsv } = require('../waveletPlot');

test('signed coefficients use opposite RGB hues at equal strength, with a neutral zero', () => {
    for (const [channel, positive, negative] of [
        ['#800000', [255, 0, 0], [0, 255, 255]],
        ['#00ff00', [0, 255, 0], [255, 0, 255]],
        ['#00ffff', [0, 255, 255], [255, 0, 0]],
        ['#808080', [255, 255, 255], [0, 170, 255]]
    ]) {
        const palette = waveletPalette(channel, 'signed');
        assert.deepEqual(palette[0], negative);
        assert.deepEqual(palette[63], [17, 17, 17]);
        assert.deepEqual(palette.at(-1), positive);
    }
});

test('signed canvas, SVG tiles, hover and CSV agree, including zero and missing cells', () => {
    const magnitude = [3, 0, 3, NaN];
    const result = { first: 0, hop: 1, columns: 4, frequencies: [10, 20], peak: 3, minMagnitude: 0,
        magnitude: [...magnitude, ...magnitude], sign: Int8Array.of(-1, 0, 1, 0, -1, 0, 1, 0),
        reference: new Uint8Array(8), runs: [{ start: 0, end: 4, from: 0, until: 4 }] };
    const snapshot = { result, t0: 0, rate: 1, lastTime: 3 };
    const plot = { area: { top: 0, left: 0, width: 4, height: 1 }, range: [0, 3.5, 10, 20],
        px: x => x, py: y => 20 - y, yAt: () => 12 };
    const palette = waveletPalette('#ff0000', 'signed'), scale = { min: 0, max: 3 };
    const context = { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(image) { this.colors = Array.from(image.data); } };
    paintHeatmap(plot, snapshot, 'signed', palette, { getContext: () => context }, scale);
    assert.deepEqual(context.colors, [0, 255, 255, 255, 17, 17, 17, 255, 255, 0, 0, 255, 0, 0, 0, 0]);
    assert.deepEqual(heatmapPaths(plot, snapshot, 'signed', palette).map(([rgb]) => rgb),
        [[0, 255, 255], [17, 17, 17], [255, 0, 0]]);
    assert.deepEqual([0, 1, 2].map(t => waveletCell(snapshot, t, 10).signed), [-3, 0, 3]);
    const csv = [...waveletCsv(snapshot)].join('').trimEnd().split('\r\n');
    assert.equal(csv[0].split(',').at(-1), 'signed_coefficient');
    assert.deepEqual(csv.slice(1, 5).map(row => row.split(',').at(-1)), ['-3', '0', '3', '']);
});
