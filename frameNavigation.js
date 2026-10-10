/** Map independently framed views by original receive byte positions, without copying their payload. */
function frameIndexAtByteOffset(frames, byteOffset) {
    if (!frames.length || !Number.isFinite(byteOffset)) return -1;
    let low = 0, high = frames.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (frames.rawByteOffsetAt(mid) < byteOffset) low = mid + 1;
        else high = mid;
    }
    if (low === 0) return 0;
    if (low === frames.length) return frames.length - 1;
    if (frames.rawByteOffsetAt(low) === byteOffset) return low;
    const previous = frames.rawByteOffsetAt(low - 1);
    if (byteOffset < previous + frames.rawBytesAt(low - 1).length) return low - 1;
    return byteOffset - previous <= frames.rawByteOffsetAt(low) - byteOffset ? low - 1 : low;
}

function mapFrameIndex(source, target, index) {
    if (!source.length || !target.length || !Number.isFinite(index) || index < 0 || index > source.length - 1) return -1;
    if (source === target) return index;
    return frameIndexAtByteOffset(target, byteOffsetAtIndex(source, index));
}

function byteOffsetAtIndex(source, index) {
    if (!Number.isFinite(index) || index < 0 || index > source.length - 1) return null;
    const first = Math.floor(index), fraction = index - first;
    const start = source.rawByteOffsetAt(first);
    return fraction ? start + fraction * (source.rawByteOffsetAt(first + 1) - start) : start;
}

/** Independent views can contain several matches in one raw record; compare their actual source bytes. */
function nearestMatchIndexByByteOffset(source, matches, byteOffset) {
    if (!matches.length || !Number.isFinite(byteOffset)) return -1;
    const offsetAt = index => source.rawByteOffsetAt(matches[index].startFrame) + (matches[index].startByte ?? 0);
    const insertionIndex = offset => {
        let low = 0, high = matches.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (offsetAt(mid) < offset) low = mid + 1;
            else high = mid;
        }
        return low;
    };
    const next = insertionIndex(byteOffset);
    const candidate = next >= matches.length ? matches.length - 1
        : next > 0 && byteOffset - offsetAt(next - 1) <= offsetAt(next) - byteOffset ? next - 1 : next;
    return insertionIndex(offsetAt(candidate));
}

function mapMatchOrders(source, target, matches) {
    if (source === target) return matches;
    return matches.map(match => {
        const index = frameIndexAtByteOffset(target, source.rawByteOffsetAt(match.startFrame) + (match.startByte ?? 0));
        return { ...match, startOrder: index < 0 ? -Infinity : target.orderAt(index) };
    });
}

const FrameNavigation = { frameIndexAtByteOffset, byteOffsetAtIndex, mapFrameIndex, mapMatchOrders,
    nearestMatchIndexByByteOffset };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.FrameNavigation = FrameNavigation;
if (typeof module !== 'undefined') module.exports = FrameNavigation;
