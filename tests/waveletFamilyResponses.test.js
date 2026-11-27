const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdditionalWaveletFamilies } = require('../waveletFamilies');

const families = createAdditionalWaveletFamilies();
function weight(basis, ratio) {
    const result = [0, 0];
    families[basis].weight(ratio, result);
    return result;
}

test('continuous QMF mothers match the signed real and imaginary parts of a direct refinement product', () => {
    // Independent references evaluated directly as conj(G(f/2) * H(f/4) * ...),
    // with 26 refinement levels. The last frequency tests the high-frequency
    // path beyond the lookup table and protects against truncation of sidelobes.
    const ratios = [.5, 1.7, 13.5];
    const reference = {
        db4: [[.07268177, .31639022], [.18693415, .44385576], [.00198819, .00092502]],
        coif2: [[-.30728040, -.02982397], [-.47263949, -.04147462], [-.00204778, -.00020401]],
        sym4: [[-.30965458, -.09746514], [-.44310544, -.18870579], [-.00192556, -.00104919]]
    };
    for (const [basis, expected] of Object.entries(reference)) {
        for (const [i, ratio] of ratios.entries()) {
            const [re, im] = weight(basis, ratio);
            assert.ok(Math.hypot(re - expected[i][0], im - expected[i][1]) < 3e-5, basis + ' at ' + ratio);
        }
        assert.ok(Math.abs(Math.hypot(...weight(basis, 1)) - 1) < 1e-5);
        assert.deepEqual(weight(basis, 0), [0, 0]);
    }
});

test('centered Haar and DOG1 use the sign of the conventional positive-left mother', () => {
    for (const basis of ['haar', 'gaus1']) {
        const [re, im] = weight(basis, 1);
        assert.equal(re, 0);
        assert.ok(Math.abs(im + 1) < 2e-15);
        assert.equal(Math.hypot(...weight(basis, 0)), 0);
    }
    // Haar's first spectral zero occurs at two cycles per mother width.
    assert.ok(Math.hypot(...weight('haar', Math.PI / 1.1655611852072113)) < 1e-25);
    assert.ok(Math.hypot(...weight('haar', 9.5)) > .1);
});

test('Shannon has a flat analytic passband and Meyer has smooth compact support', () => {
    assert.equal(families.shannon.complex, true);
    assert.equal(families.meyer.complex, false);
    for (const ratio of [.49, 1.51]) assert.deepEqual(weight('shannon', ratio), [0, 0]);
    for (const ratio of [.6, 1, 1.4]) assert.deepEqual(weight('shannon', ratio), [1, 0]);
    for (const ratio of [.5, 1.5]) assert.deepEqual(weight('shannon', ratio), [.5, 0]);
    assert.deepEqual(weight('meyer', .5), [0, 0]);
    assert.deepEqual(weight('meyer', 1), [1, 0]);
    assert.deepEqual(weight('meyer', 2), [0, 0]);
    for (const ratio of [.75, 1.5]) assert.ok(Math.abs(weight('meyer', ratio)[0] - Math.SQRT1_2) < 1e-14);
});
