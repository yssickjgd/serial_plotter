const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNumericRowLayout, measureNumericColumns, formatScientificValue } = require('../numberMonitor');

test('scientific display uses the configured significant digits and preserves signs', () => {
    assert.equal(formatScientificValue(123.456789), '1.23457e+2');
    assert.equal(formatScientificValue(-0.001234567, 4), '-1.235e-3');
    assert.equal(formatScientificValue(9.99999, 3), '1.00e+1');
    assert.equal(formatScientificValue(1.23456, 1), '1e+0');
    assert.equal(formatScientificValue(0), '0.00000e+0');
    assert.equal(formatScientificValue(-0), '-0.00000e+0');
    assert.equal(formatScientificValue(Number.MAX_VALUE, 17), '1.7976931348623157e+308');
    assert.equal(formatScientificValue(Number.MIN_VALUE, 17), '4.9406564584124654e-324');
    assert.equal(formatScientificValue(NaN), 'NaN');
    assert.equal(formatScientificValue(Infinity), 'Infinity');
    assert.equal(formatScientificValue(-Infinity), '-Infinity');
    for (const invalid of [0, 18, 1.5, NaN, '6'])
        assert.throws(() => formatScientificValue(1, invalid), RangeError);
});

test('scientific mantissas align at e with a reserved sign column across magnitudes', () => {
    const values = [1, -0.001234567, Number.MAX_VALUE, -0, Number.MIN_VALUE, 0];
    for (const digits of [1, 6, 17]) {
        const fields = fieldsFor(values.map(value => formatScientificValue(value, digits)));
        const layout = buildNumericRowLayout(fields, 80);
        const lines = layout.numberText.split('\n');
        assert.equal(layout.lineCount, 3);
        for (const line of lines) {
            assert.equal(line.indexOf('e'), digits === 1 ? 7 : digits + 7);
            assert.equal(line.lastIndexOf('e') - line.indexOf('e'), 40);
            assert.equal(line[5], ' ');
            assert.equal(line[45], Object.is(values[lines.indexOf(line) * 2 + 1], -0) ||
                values[lines.indexOf(line) * 2 + 1] < 0 ? '-' : ' ');
        }
        assertChannelText(layout, fields);
    }
});

const fieldsFor = values => values.map((value, channel) => ({
    text: `CH${channel + 1}=${value}`, channel
}));

test('scientific columns fill available width and keep the grid stable across finite and invalid values', () => {
    for (const digits of [1, 6, 17]) {
        const valueWidth = Math.max(9, 1 + digits + (digits > 1 ? 1 : 0) + 2 + 3);
        const cell = 5 + valueWidth, columns = cell * 2 + 2;
        const values = [1, -2, Number.MAX_VALUE, Number.MIN_VALUE, Infinity, NaN];
        const layout = buildNumericRowLayout(fieldsFor(values.map(value => formatScientificValue(value, digits))), columns, null, digits);
        assert.equal(layout.lineCount, 3);
        assert.ok(layout.numberText.split('\n').every(line => line.length <= columns));
        assert.ok(layout.numberText.split('\n').every(line => line.indexOf('CH', 1) === cell + 2));
        const small = buildNumericRowLayout(fieldsFor(Array(6).fill(formatScientificValue(0, digits))), columns, null, digits);
        assert.equal(small.lineCount, layout.lineCount);
        assert.equal(small.numberText.split('\n')[0].indexOf('CH02='), cell + 2);
    }
});

function assertChannelText(layout, fields) {
    assert.equal(layout.numberSegments.map(segment => segment.text).join(''), layout.numberText);
    for (const field of fields) {
        const actual = layout.numberSegments.filter(segment => segment.channel === field.channel)
            .map(segment => segment.text).join('');
        const [, label, value] = /^CH(\d+)=(.*)$/s.exec(actual);
        const [, expectedLabel, expectedValue] = /^CH(\d+)=(.*)$/s.exec(field.text);
        assert.equal(Number(label), Number(expectedLabel));
        assert.ok(label.length >= 2);
        assert.equal(value.trimStart(), expectedValue);
    }
    assert.equal(layout.lineCount, layout.numberText.split('\n').length);
    assert.ok(layout.numberText.split('\n').every(line => !/[ \t]$/.test(line)));
}

test('numeric channel columns stay fixed as values change digits and signs', () => {
    const short = fieldsFor([1, 2, 3, 4, 5, 6, 7, 8]);
    const varied = fieldsFor([1.2345678901234567, -1.7976931348623157e+308,
        5e-324, -0.000000000123456789, NaN, Infinity, -Infinity, 123456789012345]);
    for (const [columns, count, step] of [[64, 1, 64], [200, 5, 40]]) {
        const before = buildNumericRowLayout(short, columns);
        const after = buildNumericRowLayout(varied, columns);
        assert.equal(before.lineCount, columns === 64 ? 8 : 2);
        assert.equal(after.lineCount, before.lineCount);
        const beforeLines = before.numberText.split('\n');
        const afterLines = after.numberText.split('\n');
        for (let channel = 0; channel < short.length; channel++) {
            const line = Math.floor(channel / count);
            const position = channel % count * step;
            const label = `CH${String(channel + 1).padStart(2, '0')}=`;
            assert.equal(beforeLines[line].indexOf(label), position);
            assert.equal(afterLines.find(row => row.includes(label)).indexOf(label), position);
        }
        assertChannelText(after, varied);
    }
});

test('decimal columns reserve signs and align different integer and fractional lengths', () => {
    const fields = fieldsFor([123.45, -1.2, -2.345, +23.4567, 0.5, -456.78]);
    const layout = buildNumericRowLayout(fields, 80);
    const lines = layout.numberText.split('\n');
    assert.equal(lines.length, 3);
    for (let column = 0; column < 2; column++) {
        const points = lines.map(line => line.indexOf('.', column * 40));
        assert.equal(new Set(points).size, 1);
    }
    assert.ok(lines[0].startsWith('CH01= 123.45'));
    assert.ok(lines[1].startsWith('CH03=  -2.345'));
    assertChannelText(layout, fields);
});

test('scientific mantissas, signed zero and integers share the same decimal position', () => {
    const fields = fieldsFor(['1.2345678901234567e+308', '-12.5', '-0.0', '+7.25', '123', '3e-324']);
    const layout = buildNumericRowLayout(fields, 40);
    const lines = layout.numberText.split('\n');
    const point = lines[0].indexOf('.');
    assert.ok(lines.slice(0, 4).every(line => line.indexOf('.') === point));
    assert.equal(lines[4].length, point, 'integers use their implicit trailing decimal point');
    assert.equal(lines[5].indexOf('e'), point, 'integer mantissas align before the exponent');
    assertChannelText(layout, fields);
});

test('a shared decimal profile aligns separate frames and never shrinks as values change', () => {
    const first = fieldsFor([1.25, -2.5, 3.75, 4]);
    const second = fieldsFor([-123.456, 20.25, 99.5, -30.75]);
    const widths = [];
    measureNumericColumns(first, 80, widths);
    measureNumericColumns(second, 80, widths);
    const before = buildNumericRowLayout(first, 80, widths).numberText.split('\n');
    const after = buildNumericRowLayout(second, 80, widths).numberText.split('\n');
    assert.equal(before[0].indexOf('.'), after[0].indexOf('.'));
    assert.equal(before[0].indexOf('.', 40), after[0].indexOf('.', 40));
    const measured = [...widths];
    measureNumericColumns(fieldsFor([0, 0, 0, 0]), 80, widths);
    assert.deepEqual(widths, measured);
});

test('resizing fifty channels recomputes rows and aligns single and double digit labels', () => {
    const fields = fieldsFor(Array.from({ length: 50 }, (_, index) => index + 0.5));
    const narrow = buildNumericRowLayout(fields, 80);
    const wide = buildNumericRowLayout(fields, 200);
    assert.equal(narrow.lineCount, 25);
    assert.equal(wide.lineCount, 10);
    assert.equal(narrow.numberText.split('\n')[0].indexOf('CH01='), 0);
    assert.equal(narrow.numberText.split('\n')[0].indexOf('CH02='), 40);
    assert.equal(narrow.numberText.split('\n')[4].indexOf('CH10='), 40);
    assert.equal(wide.numberText.split('\n')[1].indexOf('CH10='), 160);
    assert.equal(wide.numberText.split('\n')[9].indexOf('CH50='), 160);
    for (const [layout, columns] of [[narrow, 80], [wide, 200]]) {
        assert.ok(layout.numberText.split('\n').every(line => line.length <= columns));
        assertChannelText(layout, fields);
    }
    assert.deepEqual(buildNumericRowLayout(fields, 80), narrow);
});

test('narrow numeric rows wrap complete values without losing channel ownership', () => {
    const fields = fieldsFor(['1234567890123456789', 5]);
    const layout = buildNumericRowLayout(fields, 12);
    assert.equal(layout.numberText, 'CH01= 123456\n789012345678\n9\nCH02=     5');
    assert.equal(layout.lineCount, 4);
    assertChannelText(layout, fields);
});

test('a long value wraps within its cell while adjacent and following channels stay aligned', () => {
    const fields = fieldsFor(['1234567890123456789012345678901234567890', 2, 3, 4]);
    const layout = buildNumericRowLayout(fields, 80);
    const lines = layout.numberText.split('\n');
    assert.equal(layout.lineCount, 3);
    assert.equal(lines[0].indexOf('CH02='), 40);
    assert.equal(lines[1], '34567890');
    assert.equal(lines[2].indexOf('CH03='), 0);
    assert.equal(lines[2].indexOf('CH04='), 40);
    assertChannelText(layout, fields);
});

test('one channel pads its label and reserves the sign without changing numeric precision', () => {
    assert.deepEqual(buildNumericRowLayout(fieldsFor([1.5]), 200), {
        numberText: 'CH01= 1.5', lineCount: 1,
        numberSegments: [{ text: 'CH01= 1.5', channel: 0 }]
    });
});

test('numeric layout does not split Unicode characters when wrapping a supplied value', () => {
    const fields = fieldsFor(['中😀末']);
    const layout = buildNumericRowLayout(fields, 8);
    assert.equal(layout.numberText, 'CH01=中\n😀末');
    assertChannelText(layout, fields);
});

test('empty numeric fields produce one empty line', () => {
    assert.deepEqual(buildNumericRowLayout([], 64), {
        numberText: '', lineCount: 1, numberSegments: []
    });
});
