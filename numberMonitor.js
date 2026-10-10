/** Lay out numeric channels in stable cells using the current monitor body width. */
function formatScientificValue(value, significantDigits = 6) {
    if (!Number.isInteger(significantDigits) || significantDigits < 1 || significantDigits > 17)
        throw new RangeError('Significant digits must be an integer from 1 to 17');
    if (!Number.isFinite(value)) return String(value);
    const text = value.toExponential(significantDigits - 1);
    return Object.is(value, -0) ? '-' + text : text;
}

function numericCharacterWidth(char) {
    const code = char.codePointAt(0);
    if (code < 0x80) return 1;
    if (/\p{Mark}/u.test(char) || code === 0x200d || code === 0xfe0f) return 0;
    return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf ||
        code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
        code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 ||
        code >= 0x1f300) ? 2 : 1;
}

function wrapNumericField(text, columns, labelPadding) {
    const lines = [];
    let part = '', width = 0, padding = labelPadding;
    for (const char of text) {
        const cells = numericCharacterWidth(char);
        if (part && padding + width + cells > columns) {
            lines.push({ text: part, width, padding });
            part = '';
            width = padding = 0;
        }
        part += char;
        width += cells;
    }
    lines.push({ text: part, width, padding });
    return lines;
}

function numericGrid(fields, bodyColumns, significantDigits = null) {
    const columns = Number.isFinite(bodyColumns) ? Math.max(2, Math.floor(bodyColumns)) : 2;
    const labelDigits = Math.max(2, String(fields.length).length, ...fields.map(field => numericFieldParts(field)?.id.length ?? 0));
    const scientific = Number.isInteger(significantDigits) && significantDigits >= 1 && significantDigits <= 17;
    // Reserve a sign, every significant digit, e± and a three-digit exponent.
    // The same grid also fits -Infinity, so invalid samples cannot change row heights.
    const gap = 2, minimumCellWidth = scientific ? labelDigits + 3 + Math.max(9,
        1 + significantDigits + (significantDigits > 1 ? 1 : 0) + 2 + 3) : 36;
    const fieldsPerRow = Math.min(fields.length,
        Math.max(1, Math.floor((columns + (scientific ? gap : 0)) / (minimumCellWidth + gap))));
    const slotWidth = Math.floor((columns + (scientific && fieldsPerRow > 1 ? gap : 0)) / fieldsPerRow);
    const cellWidth = fieldsPerRow > 1 ? slotWidth - gap : slotWidth;
    return { fieldsPerRow, slotWidth, cellWidth, labelDigits };
}

function numericFieldParts(field) {
    const label = /^CH(\d+)=(.*)$/s.exec(field.text);
    if (!label) return null;
    const value = label[2];
    const number = /^([+-]?)(\d+)(?:\.\d*)?(?:[eE][+-]?\d+)?$/.exec(value);
    return { id: label[1], value, sign: number?.[1], integer: number?.[2] };
}

/** Share widths across records without rescanning the full acquisition history. */
function measureNumericColumns(fields, bodyColumns, widths = [], significantDigits = null) {
    if (!fields.length) return widths;
    const { fieldsPerRow } = numericGrid(fields, bodyColumns, significantDigits);
    for (let i = 0; i < fields.length; i++) {
        const parts = numericFieldParts(fields[i]);
        if (parts?.integer) {
            const column = i % fieldsPerRow;
            widths[column] = Math.max(widths[column] ?? 1, parts.integer.length);
        }
    }
    return widths;
}

function alignedNumericField(field, labelDigits, integerWidth, cellWidth) {
    const parts = numericFieldParts(field);
    if (!parts) return field.text;
    const label = `CH${parts.id.padStart(labelDigits, '0')}=`;
    if (!parts.integer) return label + (/^(?:NaN|Infinity)$/.test(parts.value) ? ' ' : '') + parts.value;
    // In a narrow cell, preserve every digit and wrap rather than add an empty padding line.
    const width = Math.min(integerWidth ?? parts.integer.length,
        Math.max(1, cellWidth - label.length - 2));
    const padding = Math.max(parts.sign ? 0 : 1, width + 1 - parts.sign.length - parts.integer.length);
    return label + ' '.repeat(padding) + parts.value;
}

function buildNumericRowLayout(fields, bodyColumns, integerWidths = null, significantDigits = null) {
    if (!fields.length) return { numberText: '', lineCount: 1, numberSegments: [] };
    const { fieldsPerRow, slotWidth, cellWidth, labelDigits } = numericGrid(fields, bodyColumns, significantDigits);
    integerWidths ??= measureNumericColumns(fields, bodyColumns, [], significantDigits);
    const numberSegments = [];
    let lineCount = 0;
    const append = (text, channel) => {
        if (!text) return;
        const last = numberSegments.at(-1);
        if (last?.channel === channel) last.text += text;
        else numberSegments.push({ text, channel });
    };

    for (let start = 0; start < fields.length; start += fieldsPerRow) {
        const row = fields.slice(start, start + fieldsPerRow);
        const wrapped = row.map((field, column) => wrapNumericField(
            alignedNumericField(field, labelDigits, integerWidths[column], cellWidth), cellWidth, 0));
        const rowLines = Math.max(...wrapped.map(lines => lines.length));
        for (let line = 0; line < rowLines; line++) {
            if (lineCount++) append('\n', null);
            let last = row.length - 1;
            while (last >= 0 && !wrapped[last][line]) last--;
            let position = 0;
            for (let cell = 0; cell <= last; cell++) {
                const part = wrapped[cell][line];
                if (!part) continue;
                const padding = cell * slotWidth - position + part.padding;
                append(' '.repeat(padding), null);
                append(part.text, row[cell].channel ?? null);
                position = cell * slotWidth + part.padding + part.width;
            }
        }
    }
    return { numberText: numberSegments.map(segment => segment.text).join(''),
        lineCount, numberSegments };
}

if (typeof module !== 'undefined') module.exports = { buildNumericRowLayout, measureNumericColumns, formatScientificValue };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { buildNumericRowLayout, measureNumericColumns, formatScientificValue });
