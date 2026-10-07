/** Decode a payload into an Array or a caller-owned flat batch of samples. */
function decodeNumericPayload(view, type, littleEndian, channels, out = null, offset = 0) {
    const stride = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4,
        int64: 8, uint64: 8, float32: 4, float64: 8 }[type];
    if (!stride) throw new RangeError('不支持的数据类型');
    const values = out || new Array(channels);
    for (let channel = 0; channel < channels; channel++) {
        const position = channel * stride;
        let value;
        switch (type) {
            case 'int8': value = view.getInt8(position); break;
            case 'uint8': value = view.getUint8(position); break;
            case 'int16': value = view.getInt16(position, littleEndian); break;
            case 'uint16': value = view.getUint16(position, littleEndian); break;
            case 'int32': value = view.getInt32(position, littleEndian); break;
            case 'uint32': value = view.getUint32(position, littleEndian); break;
            case 'float32': value = view.getFloat32(position, littleEndian); break;
            case 'float64': value = view.getFloat64(position, littleEndian); break;
            case 'int64': value = Number(view.getBigInt64(position, littleEndian)); break;
            case 'uint64': value = Number(view.getBigUint64(position, littleEndian)); break;
        }
        values[offset + channel] = value;
    }
    return values;
}

const NumericCodec = { decodeNumericPayload };
globalThis.SerialPlotter ??= {};
Object.assign(globalThis.SerialPlotter, { NumericCodec, decodeNumericPayload });
if (typeof module !== 'undefined') module.exports = NumericCodec;
