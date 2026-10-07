/** Build a chronological view without evicting RX frames for TX/error events. */
const monitorByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;
const monitorTextUtils = typeof module !== 'undefined'
    ? require('./textCodec') : globalThis.SerialPlotter.TextCodec;
const monitorNumberUtils = typeof module !== 'undefined'
    ? require('./numberMonitor') : globalThis.SerialPlotter;
const monitorDisplayUtils = typeof module !== 'undefined'
    ? require('./monitorDisplay') : globalThis.SerialPlotter.MonitorDisplay;
const monitorChannelId = typeof module !== 'undefined'
    ? require('./plotMath').formatChannelId : globalThis.SerialPlotter.formatChannelId;

function monitorPrefix(row, options, frames) {
    const direction = row.kind === 'rx' || row.kind === 'error' ? 'RX' : 'TX';
    const reason = row.reason || (row.incomplete ? '帧未完整' : '');
    let time = row.time;
    if (options.timestamp === 'none') time = '';
    else if (options.timestamp === 'relative' && Number.isFinite(row.timestamp) && Number.isFinite(frames?.originTimestamp))
        time = `${((row.timestamp - frames.originTimestamp) / 1000).toFixed(3)} s`;
    else if (options.timestamp === 'absolute' && Number.isFinite(row.timestamp)) {
        const date = new Date(row.timestamp);
        time = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-` +
            `${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:` +
            `${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.` +
            String(date.getMilliseconds()).padStart(3, '0');
    }
    const text = `${time ? `[${time}] ` : ''}${options.showDirection ? direction : ''}${reason ? `[${reason}]` : ''}`;
    return text && !text.endsWith(' ') ? text + ' ' : text;
}

function mergeMonitorRows(frames, extras) {
    const rows = new Array(frames.length + extras.length);
    for (let i = 0; i < frames.length; i++) rows[i] = { ...frames.frameAt(i), frameIndex: i };
    for (let i = 0; i < extras.length; i++) rows[frames.length + i] = extras[i];
    rows.sort((a, b) => a.order - b.order);
    return rows;
}

function bytesToHex(bytes) {
    return monitorByteUtils.bytesToHex(bytes);
}

function textCells(value) {
    let cells = 0;
    for (const char of value) {
        const code = char.codePointAt(0);
        if (code < 128) { cells++; continue; }
        if (/\p{Mark}/u.test(char) || code === 0x200d || code === 0xfe0f) continue;
        cells += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf ||
            code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
            code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 ||
            code >= 0x1f300) ? 2 : 1;
    }
    return cells;
}

function wrapTextTokens(tokens, columns, options = {}) {
    const parts = [];
    let width = 0, lineCount = 1, previousBreak = '';
    for (const token of tokens) {
        for (const char of monitorDisplayUtils.textTokenDisplay(token, options)) {
            if (char === '\r' || char === '\n') {
                if (previousBreak && previousBreak !== char) { previousBreak = ''; continue; }
                previousBreak = char;
                parts.push({ text: '\n', token }); width = 0; lineCount++;
                continue;
            }
            previousBreak = '';
            const cells = textCells(char);
            if (width && width + cells > columns) {
                parts.push({ text: '\n', token: null });
                width = 0;
                lineCount++;
            }
            parts.push({ text: char, token });
            width += cells;
        }
    }
    return { parts, lineCount };
}

function wrappedTextLineCount(tokens, columns, options = {}) {
    let width = 0, lineCount = 1, previousBreak = '';
    for (const token of tokens) {
        for (const char of monitorDisplayUtils.textTokenDisplay(token, options)) {
            if (char === '\r' || char === '\n') {
                if (previousBreak && previousBreak !== char) { previousBreak = ''; continue; }
                previousBreak = char; width = 0; lineCount++;
                continue;
            }
            previousBreak = '';
            const cells = textCells(char);
            if (width && width + cells > columns) { width = 0; lineCount++; }
            width += cells;
        }
    }
    return lineCount;
}

/** Keep long decoded records as strings and typed metadata, rather than per-character DOM parts. */
function appendCompactTokens(data, tokens) {
    const chars = [], offsets = [0], cells = [], starts = [], ends = [], crosses = [], failed = [], breaks = [];
    let stringLength = 0;
    for (const token of tokens) {
        for (let char of monitorDisplayUtils.textTokenDisplay(token, data.displayOptions ?? {})) {
            const lineBreak = char === '\r' || char === '\n';
            if (lineBreak && data.previousBreak && data.previousBreak !== char) { data.previousBreak = ''; continue; }
            data.previousBreak = lineBreak ? char : '';
            if (lineBreak) char = '\n';
            const width = textCells(char);
            if (!lineBreak && data.width && data.width + width > data.columns) {
                data.initialLines.push(data.length + chars.length);
                data.width = 0;
            }
            if (lineBreak) {
                data.initialLines.push(data.length + chars.length + 1);
                data.width = 0;
            } else data.width += width;
            chars.push(char);
            stringLength += char.length;
            offsets.push(stringLength);
            cells.push(lineBreak ? 0 : width);
            breaks.push(lineBreak ? 1 : 0);
            starts.push(token.startByte);
            ends.push(token.endByte);
            crosses.push(token.endFrame > token.startFrame ? 1 : 0);
            failed.push(token.failed ? 1 : 0);
        }
    }
    if (!chars.length) return;
    data.chunks.push({ base: data.length, text: chars.join(''), offsets: Uint32Array.from(offsets),
        cells: Uint8Array.from(cells), starts: Uint32Array.from(starts), ends: Uint32Array.from(ends),
        crosses: Uint8Array.from(crosses), failed: Uint8Array.from(failed), breaks: Uint8Array.from(breaks) });
    data.length += chars.length;
}

function compactLineStarts(data, columns) {
    const cached = data.layouts.get(columns);
    if (cached) return cached;
    const starts = [0];
    let width = 0;
    for (const chunk of data.chunks) {
        for (let i = 0; i < chunk.cells.length; i++) {
            if (chunk.breaks?.[i]) { starts.push(chunk.base + i + 1); width = 0; continue; }
            const cells = chunk.cells[i];
            if (width && width + cells > columns) {
                starts.push(chunk.base + i);
                width = 0;
            }
            width += cells;
        }
    }
    const lines = Uint32Array.from(starts);
    if (data.layouts.size >= 4) data.layouts.delete(data.layouts.keys().next().value);
    data.layouts.set(columns, lines);
    return lines;
}

function compactVisibleParts(data, lineStarts, firstLine, lastLine) {
    const parts = [];
    let low = 0, high = data.chunks.length;
    const firstCharacter = lineStarts[firstLine] ?? data.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (data.chunks[mid].base + data.chunks[mid].cells.length <= firstCharacter) low = mid + 1;
        else high = mid;
    }
    let chunkIndex = low;
    for (let line = firstLine; line < lastLine; line++) {
        if (line > firstLine) {
            const previous = lineStarts[line] - 1;
            let chunk = data.chunks[Math.min(chunkIndex, data.chunks.length - 1)];
            if (chunk?.base > previous) chunk = data.chunks[chunkIndex - 1];
            parts.push({ text: '\n', token: null, softBreak: !chunk?.breaks?.[previous - chunk.base] });
        }
        let position = lineStarts[line];
        const end = lineStarts[line + 1] ?? data.length;
        while (position < end) {
            const chunk = data.chunks[chunkIndex];
            const offset = position - chunk.base;
            const limit = Math.min(end - chunk.base, chunk.cells.length);
            for (let i = offset; i < limit; i++) {
                if (chunk.breaks?.[i]) continue;
                parts.push({ text: chunk.text.slice(chunk.offsets[i], chunk.offsets[i + 1]), token: {
                    startByte: chunk.starts[i], endByte: chunk.ends[i],
                    startFrame: 0, endFrame: chunk.crosses[i], failed: chunk.failed[i] === 1
                } });
            }
            position = chunk.base + limit;
            if (limit === chunk.cells.length) chunkIndex++;
        }
    }
    return parts;
}

/** Compute a row's exact line count without converting offscreen bytes to Hex. */
function decodedRowFields(row, frames, options = monitorDisplayUtils.DEFAULTS) {
    if (row.kind !== 'rx' || row.frameIndex === undefined) return null;
    const fields = [];
    for (let channel = 0; channel < frames.channelCount; channel++)
        fields.push({ text: `${monitorChannelId(channel)}=${monitorNumberUtils.formatScientificValue(
            frames.getValue(channel, row.frameIndex), options.numericSignificantDigits)}`, channel });
    return fields;
}

function displayByte(byte) { return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '·'; }

function monitorRowLayout(row, columns, mode = 'hex', frames = null, textTokens = null,
    options = monitorDisplayUtils.DEFAULTS) {
    const prefix = monitorPrefix(row, options, frames);
    const bodyColumns = Math.max(2, columns - textCells(prefix));
    if (mode === 'text') {
        const wrapped = wrapTextTokens(textTokens ?? [], bodyColumns, options);
        return { prefix, byteMode: 'text', ...wrapped };
    }
    const fields = mode === 'number' && frames ? decodedRowFields(row, frames, options) : null;
    if (fields) return { prefix, byteMode: 'number',
        ...monitorNumberUtils.buildNumericRowLayout(fields, bodyColumns) };
    const byteMode = mode === 'ascii' ? 'ascii' : 'hex';
    if (byteMode === 'hex') return { prefix,
        ...monitorDisplayUtils.hexRowLayout(row.bytes.length, bodyColumns, options,
            row.frameIndex === undefined ? 0 : frames?.rawByteOffsetAt?.(row.frameIndex) ?? 0) };
    const bytesPerLine = Math.max(1, byteMode === 'hex'
        ? Math.floor((bodyColumns + 1) / 3) : bodyColumns);
    return {
        prefix, bytesPerLine, byteMode,
        lineCount: Math.max(1, Math.ceil(row.bytes.length / bytesPerLine))
    };
}

function monitorBodyText(row, layout) {
    if (layout.byteMode === 'text') return layout.parts.map(part => part.text).join('');
    if (layout.byteMode === 'number') return layout.numberText;
    if (layout.hex) return monitorDisplayUtils.hexVisibleParts(row.bytes, layout).map(part => part.text).join('');
    const lines = [];
    let position = (layout.firstLine ?? 0) * layout.bytesPerLine;
    const stop = Math.min(row.bytes.length, (layout.lastLine ?? layout.lineCount) * layout.bytesPerLine);
    while (position < stop) {
        const end = Math.min(stop, position + layout.bytesPerLine);
        lines.push(layout.byteMode === 'ascii'
            ? [...row.bytes.subarray(position, end)].map(displayByte).join('')
            : bytesToHex(row.bytes.subarray(position, end)));
        position = end;
    }
    return lines.join('\n');
}

function firstRowAt(offsets, top) {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (offsets[middle + 1] <= top) low = middle + 1;
        else high = middle;
    }
    return low;
}

function visibleTextParts(parts, firstLine, lastLine) {
    if (firstLine >= lastLine) return [];
    let line = 0, start = 0, end = parts.length;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].text !== '\n') continue;
        line++;
        if (line === firstLine) start = i + 1;
        if (line === lastLine) { end = i; break; }
    }
    return parts.slice(start, end);
}

class MonitorView {
    constructor(container, frames) {
        this.container = container;
        this.frames = frames;
        this.extras = [];
        this.rowHeight = 20;
        this.charWidth = 8;
        this.pending = null;
        this.pendingAnimationFrame = false;
        this.followTail = true;
        this._renderedScrollTop = container.scrollTop;
        this.anchor = null;
        this.lastRows = [];
        this.lastOffsets = [0];
        this.rowPositions = [];
        this.mode = 'hex';
        this.displayOptions = monitorDisplayUtils.normalizeDisplayOptions();
        this.expandedRows = new Set();
        this.revealOrder = null;
        this.encoding = 'utf-8';
        this.textCache = new Map();
        this.textLayouts = new Map();
        this.numberAlignment = null;
        this.textStates = new Map();
        this.textCheckpoints = [];
        this.textOrigin = null;
        this.preparedText = null;
        this.textPreparation = null;
        this.textPreparationVersion = 0;
        this.matches = [];
        this.currentMatch = -1;
        this.cursorOrder = null;
        this.largeThreshold = 2000;
        this.centerPadding = 0;
        this.spacer = document.createElement('div');
        this.spacer.className = 'monitor-spacer';
        // Long virtual rows must not extend the browser's scroll range past the spacer.
        this.spacer.style.overflow = 'clip';
        container.replaceChildren(this.spacer);
        const probe = document.createElement('span');
        if (probe.getBoundingClientRect) {
            probe.className = 'monitor-measure';
            probe.textContent = '0000000000';
            this.spacer.appendChild(probe);
            const width = probe.getBoundingClientRect().width;
            if (width > 0) this.charWidth = width / 10;
            this.spacer.replaceChildren();
        }
        container.addEventListener('scroll', () => {
            if (this._settingScroll ||
                Math.abs(container.scrollTop - this._renderedScrollTop) <= 1) return;
            const bottom = Math.max(0, container.scrollHeight - container.clientHeight);
            this.followTail = bottom - container.scrollTop <= 1;
            if (this.followTail) {
                this.anchor = null;
            } else if (this._usesLargeLayout()) {
                const maxScroll = Math.max(1, bottom);
                const position = Math.max(0, Math.min(this.frames.length - 1,
                    container.scrollTop / maxScroll * (this.frames.length - 1)));
                const index = Math.floor(position);
                this.anchor = {
                    order: this.frames.orderAt(index),
                    fraction: position - index,
                    center: this.anchor?.center ?? false
                };
            } else if (this.lastRows.length) {
                const index = Math.min(this.lastRows.length - 1,
                    firstRowAt(this.lastOffsets, container.scrollTop));
                this.anchor = {
                    order: this.lastRows[index].order,
                    within: container.scrollTop - this.lastOffsets[index]
                };
            }
            this.render();
        });
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.render());
            this.resizeObserver.observe(container);
        }
    }

    appendFrame() { this.schedule(); }

    /** Search from the latest frame or the sample nearest the visible log midpoint. */
    currentFrameIndex() {
        if (!this.frames.length) return -1;
        if (this.followTail) return this.frames.length - 1;
        this.render();
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(this.container) : null;
        const padding = css ? (parseFloat(css.paddingTop) || 0) +
            (parseFloat(css.paddingBottom) || 0) : 0;
        const center = this.container.scrollTop + (this.container.clientHeight - padding) / 2;
        let nearest = -1, distance = Infinity, nearestOrder, orderDistance = Infinity;
        for (const row of this.rowPositions) {
            const difference = Math.max(row.top - center, center - row.top - row.height, 0);
            if (difference < orderDistance) { nearestOrder = row.order; orderDistance = difference; }
            if (row.frameIndex === undefined) continue;
            if (center >= row.top && center < row.top + row.height) return row.frameIndex;
            if (difference < distance) { nearest = row.frameIndex; distance = difference; }
        }
        if (nearest < 0 && Number.isFinite(nearestOrder)) {
            const next = Math.min(this.frames.length - 1, this.frames.indexAtOrAfterOrder(nearestOrder));
            nearest = next > 0 && nearestOrder - this.frames.orderAt(next - 1) <=
                this.frames.orderAt(next) - nearestOrder ? next - 1 : next;
        }
        return nearest;
    }

    _setScrollTop(value) {
        this._settingScroll = true;
        this.container.scrollTop = value;
        this._renderedScrollTop = this.container.scrollTop;
        this._settingScroll = false;
    }

    setMode(mode, { deferRender = false } = {}) {
        if (!['hex', 'ascii', 'number', 'text'].includes(mode)) throw new RangeError('监视台显示格式无效');
        if (this.mode !== mode) this.numberAlignment = null;
        this.mode = mode;
        if (!deferRender) this.render();
    }

    _displayOptions() { return this.displayOptions ?? monitorDisplayUtils.DEFAULTS; }

    _foldColumns(columns) {
        return this._displayOptions().foldLong ? Math.min(24, Math.max(1, Math.floor(columns * .3))) : 0;
    }

    _layoutColumns(columns) { return Math.max(2, columns - this._foldColumns(columns)); }

    _usesLargeLayout() { return this.frames.length > this.largeThreshold && this._displayOptions().showRx; }

    _textDisplayKey(options = this.displayOptions ?? monitorDisplayUtils.DEFAULTS) {
        return `${options.textInvalid}:${options.textNewline}:${options.textTab}`;
    }

    setDisplayOptions(options = {}, { deferRender = false } = {}) {
        monitorDisplayUtils.normalizeDisplayOptions(options);
        const next = monitorDisplayUtils.normalizeDisplayOptions({ ...this.displayOptions, ...options });
        if (next.numericSignificantDigits !== this._displayOptions().numericSignificantDigits)
            this.numberAlignment = null;
        if (this._textDisplayKey(next) !== this._textDisplayKey()) {
            this.textLayouts.clear();
            this.preparedText = null;
            this.textPreparationVersion++;
            this.textPreparation = null;
        }
        this.displayOptions = next;
        this._cancelScheduledRender();
        if (!deferRender) this.render();
    }

    _rowVisible(row) {
        return row.order === this.revealOrder || monitorDisplayUtils.rowIsVisible(row, this._displayOptions());
    }

    _foldLayout(row, layout) {
        const options = this._displayOptions();
        if (!options.foldLong || layout.lineCount <= options.foldLines) return layout;
        const expanded = this.expandedRows.has(row.order);
        return { ...layout, fullLineCount: layout.lineCount, foldControl: true,
            folded: !expanded, lineCount: expanded ? layout.lineCount : options.foldLines,
            contentLineCount: expanded ? layout.lineCount : options.foldLines };
    }

    setEncoding(encoding, { deferRender = false } = {}) {
        this.encoding = monitorTextUtils.normalizeTextEncoding(encoding);
        this.textCache.clear();
        this.textLayouts.clear();
        this.textStates.clear();
        this.textCheckpoints.length = 0;
        this.preparedText = null;
        this.textPreparationVersion++;
        if (!deferRender) this.render();
    }

    _columns() {
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(this.container) : null;
        const padding = css ? (parseFloat(css.paddingLeft) || 0) +
            (parseFloat(css.paddingRight) || 0) : 20;
        return this._layoutColumns(Math.max(2, Math.floor((this.container.clientWidth - padding) / this.charWidth)));
    }

    /** Build text metadata offscreen, leaving the installed display unchanged until commit. */
    async prepareText(frames, encoding, { onProgress = () => {}, isCancelled = () => false,
        yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)), targetIndex = frames.length - 1,
        prepareRecord = null } = {}) {
        encoding = monitorTextUtils.normalizeTextEncoding(encoding);
        const displayOptions = { ...this.displayOptions };
        const state = { encoding, displayKey: this._textDisplayKey(displayOptions),
            firstOrder: frames.orderAt(0), rows: new Map() };
        const columns = this._columns();
        const targets = [];
        const radius = Math.max(32, Math.ceil(this.container.clientHeight / this.rowHeight) + 12);
        const startIndex = Math.max(0, Math.min(frames.length - radius, targetIndex - radius));
        const stopIndex = Math.min(frames.length, targetIndex + radius + 1);
        for (let i = startIndex; i < stopIndex; i++) {
            if (frames.rawBytesAt(i).length >= 65536) targets.push(i);
        }
        targets.sort((a, b) => Math.abs(a - targetIndex) - Math.abs(b - targetIndex));
        targets.length = Math.min(4, targets.length);
        const totalBytes = targets.reduce((sum, index) => sum + frames.rawBytesAt(index).length, 0);
        let completed = 0;
        const pending = [];
        onProgress(0);
        for (const frame of targets) {
            if (isCancelled()) return null;
            const row = frames.frameAt(frame), bytes = frames.rawBytesAt(frame);
            const prefix = monitorPrefix(row, displayOptions, frames);
            const data = { chunks: [], length: 0, width: 0, initialLines: [0], layouts: new Map(),
                columns: Math.max(2, columns - textCells(prefix)), byteLength: bytes.length, displayOptions,
                byteOffset: frames.rawByteOffsetAt?.(frame), nextOrders: [], streamEnded: row.streamEnded === true };
            for (let i = 1; i <= 4; i++) data.nextOrders.push(frames.orderAt(frame + i));
            state.rows.set(row.order, data);
            const consume = tokens => appendCompactTokens(data,
                tokens.filter(token => token.startFrame === frame));
            const before = [];
            const legacy = ['gbk', 'gb18030', 'big5', 'shift_jis'].includes(encoding);
            let needed = 4, anchored = false;
            for (let previous = frame - 1; previous >= 0 && !anchored && (legacy || needed); previous--) {
                if (this._streamEnded(frames, previous)) break;
                const previousBytes = frames.rawBytesAt(previous);
                let start = Math.max(0, previousBytes.length - needed);
                if (legacy) {
                    start = 0;
                    for (let end = previousBytes.length; end > 0 && !anchored; end -= 2048) {
                        if (isCancelled()) return null;
                        const limit = Math.max(0, end - 2048);
                        for (let byte = end - 1; byte >= limit; byte--) {
                            if (previousBytes[byte] < (encoding === 'gb18030' ? 0x30 : 0x40) ||
                                previousBytes[byte] === 0x7f) {
                                start = byte + 1;
                                anchored = true;
                                break;
                            }
                        }
                        if (!anchored) await yieldControl();
                    }
                }
                before.unshift({ frame: previous, bytes: previousBytes.subarray(start), start });
                needed -= previousBytes.length - start;
            }
            if (encoding.startsWith('utf-16') && before.length) {
                const first = before[0];
                if (this._textByteOffset(frames, first.frame, first.start) % 2) {
                    first.bytes = first.bytes.subarray(1);
                    first.start++;
                }
            }
            const first = before[0];
            const byteOffset = first ? this._textByteOffset(frames, first.frame, first.start)
                : this._textByteOffset(frames, frame);
            if (prepareRecord) {
                const following = [];
                needed = data.streamEnded ? 0 : 4;
                for (let index = frame + 1; index < frames.length && needed; index++) {
                    const nextBytes = frames.rawBytesAt(index).subarray(0, needed);
                    following.push({ frame: index, bytes: nextBytes, start: 0 });
                    needed -= nextBytes.length;
                    if (this._streamEnded(frames, index)) break;
                }
                const job = Promise.resolve(prepareRecord({ kind: 'text-prepare', bytes, encoding,
                    frame, byteOffset, before, following, columns: data.columns,
                    rawByteOffset: data.byteOffset, nextOrders: data.nextOrders,
                    streamEnded: data.streamEnded, displayOptions })).then(prepared => {
                    if (isCancelled()) return;
                    state.rows.set(row.order, prepared);
                    completed += bytes.length;
                    onProgress(completed / Math.max(1, totalBytes));
                });
                // Cancellation can exit while other records still run in the shared worker pool.
                job.catch(() => {});
                pending.push(job);
                continue;
            }
            const decoder = new monitorTextUtils.MappedTextDecoder(encoding, {
                byteOffset
            });
            for (const part of before) {
                for (let start = 0; start < part.bytes.length; start += 2048) {
                    if (isCancelled()) return null;
                    decoder.write(part.bytes.subarray(start, start + 2048), part.frame, part.start + start);
                    if (legacy) await yieldControl();
                }
            }
            // Preserve the at-most-three bytes of a character that began in an earlier frame.
            data.initialPending = decoder.pending.map(entry => ({ ...entry }));
            for (let start = 0; start < bytes.length; start += 2048) {
                if (isCancelled()) return null;
                const end = Math.min(bytes.length, start + 2048);
                consume(decoder.write(bytes.subarray(start, end), frame, start));
                completed += end - start;
                onProgress(completed / Math.max(1, totalBytes));
                await yieldControl();
            }
            data.needsFollowing = decoder.pending.some(entry => entry.frame === frame);
            needed = data.streamEnded ? 0 : 4;
            for (let following = frame + 1; following < frames.length && needed; following++) {
                const nextBytes = frames.rawBytesAt(following).subarray(0, needed);
                consume(decoder.write(nextBytes, following));
                needed -= nextBytes.length;
                if (this._streamEnded(frames, following)) break;
            }
            consume(decoder.flush());
            data.layouts.set(data.columns, Uint32Array.from(data.initialLines));
            delete data.initialLines;
        }
        await Promise.all(pending);
        if (isCancelled()) return null;
        onProgress(1);
        return state;
    }

    _streamEnded(frames, index) {
        return frames.streamEndedAt ? frames.streamEndedAt(index) : frames.frameAt(index)?.streamEnded === true;
    }

    _textByteOffset(frames, index, start = 0) {
        if (!Number.isInteger(index)) return start;
        const origin = frames.streamStartByteAt?.(index);
        if (origin !== undefined) return (frames.rawByteOffsetAt?.(index) ?? 0) - origin + start;
        if (index > 0 && this._streamEnded(frames, index - 1)) return start;
        return (frames.rawByteOffsetAt?.(index) ?? 0) + start;
    }

    installPreparedText(state) {
        this.preparedText = state;
        this.textCache.clear();
        this.textLayouts.clear();
    }

    _prepareMissingText(row) {
        if (this.textPreparation) return;
        const version = this.textPreparationVersion, encoding = this.encoding, mode = this.mode;
        const promise = this.prepareText(this.frames, encoding, {
            isCancelled: () => version !== this.textPreparationVersion || this.mode !== mode,
            targetIndex: row.frameIndex
        });
        this.textPreparation = promise;
        promise.then(state => {
            if (state && version === this.textPreparationVersion && this.mode === mode) {
                this.installPreparedText(state);
                this.textPreparation = null;
                this.render();
            }
        }).finally(() => {
            if (this.textPreparation === promise) this.textPreparation = null;
        });
    }

    _textTokens(row, includeCrossing = false) {
        const index = row.frameIndex;
        if (index === undefined || row.kind !== 'rx') {
            const decoder = new monitorTextUtils.MappedTextDecoder(this.encoding);
            return [...decoder.write(row.bytes, 0), ...decoder.flush()];
        }
        const neighbours = [];
        for (let i = 1; i <= 4; i++) neighbours.push(this.frames.orderAt(index + i));
        const key = `${row.order}:${this.frames.orderAt(0)}:${neighbours.join(',')}:${this.encoding}:${row.streamEnded === true}:${includeCrossing}`;
        const cached = this.textCache.get(key);
        if (cached) return cached;
        if (['gbk', 'gb18030', 'big5', 'shift_jis'].includes(this.encoding)) {
            const tokens = this._legacyTextTokens(row, includeCrossing);
            if (this.textCache.size >= 256) this.textCache.delete(this.textCache.keys().next().value);
            this.textCache.set(key, tokens);
            return tokens;
        }
        // Every supported encoding has a maximum four-byte character. Decode a tiny
        // neighbourhood rather than walking all retained data to display one row.
        const before = [];
        let needed = 4;
        for (let frame = index - 1; frame >= 0 && needed; frame--) {
            if (this._streamEnded(this.frames, frame)) break;
            const bytes = this.frames.rawBytesAt(frame);
            const start = Math.max(0, bytes.length - needed);
            before.unshift({ frame, bytes: bytes.subarray(start), start });
            needed -= bytes.length - start;
        }
        if (this.encoding.startsWith('utf-16') && before.length) {
            const first = before[0];
            let offset = this._textByteOffset(this.frames, first.frame);
            if (offset === undefined) {
                offset = 0;
                for (let frame = 0; frame < first.frame; frame++) offset += this.frames.rawBytesAt(frame).length;
            }
            if ((offset + first.start) % 2) {
                first.bytes = first.bytes.subarray(1);
                first.start++;
            }
        }
        const firstPart = before[0];
        const decoder = new monitorTextUtils.MappedTextDecoder(this.encoding,
            { byteOffset: firstPart ? this._textByteOffset(this.frames, firstPart.frame, firstPart.start)
                : this._textByteOffset(this.frames, index) });
        const tokens = [];
        for (const part of before) tokens.push(...decoder.write(part.bytes, part.frame, part.start));
        for (const token of decoder.write(row.bytes, index)) tokens.push(token);
        needed = row.streamEnded ? 0 : 4;
        for (let frame = index + 1; frame < this.frames.length && needed; frame++) {
            const bytes = this.frames.rawBytesAt(frame);
            const slice = bytes.subarray(0, needed);
            tokens.push(...decoder.write(slice, frame));
            needed -= slice.length;
            if (this._streamEnded(this.frames, frame)) break;
        }
        tokens.push(...decoder.flush());
        const own = tokens.filter(token => token.startFrame === index ||
            includeCrossing && token.startFrame < index && token.endFrame >= index);
        if (this.textCache.size >= 256) this.textCache.delete(this.textCache.keys().next().value);
        this.textCache.set(key, own);
        return own;
    }

    _legacyTextTokens(row, includeCrossing = false) {
        const frames = this.frames, index = row.frameIndex;
        const firstOrder = frames.orderAt(0);
        if (this.textOrigin !== firstOrder) {
            this.textOrigin = firstOrder;
            this.textStates.clear();
            this.textCheckpoints.length = 0;
        }
        // Ambiguous legacy lead/trail bytes cannot be synchronized from an arbitrary
        // four-byte prefix. Retain tiny decoder states, never decoded history strings.
        while (this.textCheckpoints[0]?.order < firstOrder) this.textCheckpoints.shift();
        for (const order of this.textStates.keys()) if (order < firstOrder) this.textStates.delete(order);
        let decoder = new monitorTextUtils.MappedTextDecoder(this.encoding);
        let start = 0, startByte = 0;
        const previousOrder = frames.orderAt(index - 1);
        let state = this._streamEnded(frames, index - 1) ? [] : this.textStates.get(previousOrder);
        if (state) start = index;
        else {
            let low = 0, high = this.textCheckpoints.length;
            while (low < high) {
                const mid = Math.floor((low + high) / 2);
                if (this.textCheckpoints[mid].order < row.order) low = mid + 1;
                else high = mid;
            }
            const checkpoint = this.textCheckpoints[low - 1];
            if (checkpoint) {
                state = checkpoint.pending;
                start = frames.indexAtOrAfterOrder(checkpoint.order) + 1;
            } else {
                // ASCII controls and low punctuation are unambiguous stream anchors;
                // ordinary ASCII letters can themselves be trailing legacy bytes.
                let found = false;
                for (let frame = index - 1; frame >= 0 && !found; frame--) {
                    if (this._streamEnded(frames, frame)) {
                        start = frame + 1;
                        break;
                    }
                    const bytes = frames.rawBytesAt(frame);
                    for (let byte = bytes.length - 1; byte >= 0; byte--) {
                        if (bytes[byte] < (this.encoding === 'gb18030' ? 0x30 : 0x40) || bytes[byte] === 0x7f) {
                            start = frame;
                            startByte = byte + 1;
                            found = true;
                            break;
                        }
                    }
                }
            }
        }
        if (state) decoder.pending = state.map(entry => ({ ...entry }));
        const own = [];
        const belongs = token => token.startFrame === row.order ||
            includeCrossing && token.startFrame < row.order && token.endFrame >= row.order;
        for (let frame = start; frame <= index; frame++) {
            const order = frames.orderAt(frame);
            const bytes = frames.rawBytesAt(frame);
            const offset = frame === start ? startByte : 0;
            const tokens = decoder.write(bytes.subarray(offset), order, offset);
            for (const token of tokens) if (belongs(token)) own.push(token);
            if (this._streamEnded(frames, frame)) {
                for (const token of decoder.flush()) if (belongs(token)) own.push(token);
                decoder = new monitorTextUtils.MappedTextDecoder(this.encoding);
            }
            const pending = decoder.pending.map(entry => ({ ...entry }));
            if (this.textStates.size >= 256) this.textStates.delete(this.textStates.keys().next().value);
            this.textStates.set(order, pending);
            if (order % 256 === 0) {
                let low = 0, high = this.textCheckpoints.length;
                while (low < high) {
                    const mid = Math.floor((low + high) / 2);
                    if (this.textCheckpoints[mid].order < order) low = mid + 1;
                    else high = mid;
                }
                const checkpoint = { order, pending };
                if (this.textCheckpoints[low]?.order === order) this.textCheckpoints[low] = checkpoint;
                else this.textCheckpoints.splice(low, 0, checkpoint);
            }
        }
        let needed = row.streamEnded ? 0 : 4;
        for (let frame = index + 1; frame < frames.length && needed; frame++) {
            const bytes = frames.rawBytesAt(frame).subarray(0, needed);
            own.push(...decoder.write(bytes, frames.orderAt(frame))
                .filter(belongs));
            needed -= bytes.length;
            if (this._streamEnded(frames, frame)) break;
        }
        own.push(...decoder.flush().filter(belongs));
        return own;
    }

    _textLayoutKey(row, bodyColumns) {
        const context = [];
        let source = '';
        if (row.frameIndex !== undefined) {
            for (let i = -4; i <= 4; i++) {
                const index = row.frameIndex + i;
                context.push(this.frames.orderAt(index), this._streamEnded(this.frames, index));
            }
            source = `${this.frames.rawByteOffsetAt?.(row.frameIndex)}:${this.frames.streamStartByteAt?.(row.frameIndex)}`;
        }
        const legacy = ['gbk', 'gb18030', 'big5', 'shift_jis'].includes(this.encoding);
        return `${row.order}:${row.bytes.length}:${this.encoding}:${bodyColumns}:${this._textDisplayKey()}:` +
            `${row.streamEnded === true}:${legacy ? this.frames.orderAt(0) : ''}:` +
            `${source}:${context.join(',')}`;
    }

    _rowLayout(row, columns, countOnly = false) {
        const options = this._displayOptions();
        if (this.mode === 'text' && row.frameIndex !== undefined && row.kind === 'rx') {
            const state = this.preparedText;
            let data = state?.encoding === this.encoding && state.displayKey === this._textDisplayKey() &&
                state.firstOrder === this.frames.orderAt(0)
                ? state.rows.get(row.order) : null;
            if (data && (data.byteLength !== row.bytes.length ||
                data.byteOffset !== this.frames.rawByteOffsetAt?.(row.frameIndex) ||
                data.streamEnded !== (row.streamEnded === true) ||
                !data.streamEnded && data.needsFollowing && data.nextOrders.some((order, i) =>
                    !Object.is(order, this.frames.orderAt(row.frameIndex + i + 1)))))
                data = null;
            if (data) {
                const base = monitorRowLayout(row, columns, 'hex', this.frames, null, options);
                const bodyColumns = Math.max(2, columns - textCells(base.prefix));
                const lineStarts = compactLineStarts(data, bodyColumns);
                return { prefix: base.prefix, byteMode: 'text', data, lineStarts, lineCount: lineStarts.length };
            }
            if (row.bytes.length >= 65536) {
                const base = monitorRowLayout(row, columns, 'ascii', this.frames, null, options);
                return { prefix: base.prefix, byteMode: 'text', parts: [], lineCount: base.lineCount,
                    unprepared: true };
            }
        }
        if (this.mode === 'text') {
            const prefix = monitorPrefix(row, options, this.frames);
            const bodyColumns = Math.max(2, columns - textCells(prefix));
            const key = this._textLayoutKey(row, bodyColumns);
            const cached = this.textLayouts.get(key);
            const tokens = countOnly && cached ? null : this._textTokens(row);
            const lineCount = cached ?? wrappedTextLineCount(tokens, bodyColumns, options);
            if (cached === undefined) {
                if (this.textLayouts.size >= 4096) this.textLayouts.delete(this.textLayouts.keys().next().value);
                this.textLayouts.set(key, lineCount);
            }
            if (countOnly) return { prefix, byteMode: 'text', lineCount, columns, deferredText: true };
            return { prefix, byteMode: 'text', ...wrapTextTokens(tokens, bodyColumns, options) };
        }
        return monitorRowLayout(row, columns, this.mode, this.frames, null, options);
    }

    _rowLayouts(rows, columns) {
        if (this.mode !== 'number') return rows.map(row => this._foldLayout(row, this._rowLayout(row, columns, true)));
        const key = `${columns}:${this.frames.channelCount}`;
        const sameStorage = this.numberAlignment?.frames === this.frames &&
            this.numberAlignment.storage === this.frames.values;
        if (this.numberAlignment?.key !== key || !sameStorage) {
            this.numberAlignment = { key, frames: this.frames, storage: this.frames.values,
                widths: new Map(), rows: sameStorage ? this.numberAlignment.rows : new Map() };
        }
        const alignment = this.numberAlignment;
        const prepared = rows.map(row => {
            if (row.kind !== 'rx' || row.frameIndex === undefined)
                return { layout: this._rowLayout(row, columns, true) };
            let cached = alignment.rows.get(row.order);
            if (!cached) {
                cached = { fields: decodedRowFields(row, this.frames, this._displayOptions()) };
                if (alignment.rows.size >= this.largeThreshold + 128)
                    alignment.rows.delete(alignment.rows.keys().next().value);
                alignment.rows.set(row.order, cached);
            }
            const prefix = monitorPrefix(row, this._displayOptions(), this.frames);
            const bodyColumns = Math.max(2, columns - textCells(prefix));
            let widths = alignment.widths.get(bodyColumns);
            if (!widths) alignment.widths.set(bodyColumns, widths = []);
            if (cached.widths !== widths) {
                monitorNumberUtils.measureNumericColumns(cached.fields, bodyColumns, widths);
                cached.widths = widths;
            }
            return { cached, prefix, bodyColumns, widths };
        });
        // Measure the entire batch first, so earlier records use the same mantissa positions.
        return prepared.map((item, index) => {
            if (item.layout) return this._foldLayout(rows[index], item.layout);
            const layoutKey = `${item.bodyColumns}:${item.prefix}:${item.widths.join(',')}`;
            if (item.cached.layoutKey !== layoutKey) {
                item.cached.layout = { prefix: item.prefix, byteMode: 'number',
                    ...monitorNumberUtils.buildNumericRowLayout(item.cached.fields, item.bodyColumns, item.widths) };
                item.cached.layoutKey = layoutKey;
            }
            return this._foldLayout(rows[index], item.cached.layout);
        });
    }

    setSearchResults(matches, current = -1) {
        this.matches = matches;
        this.currentMatch = current;
        this.render();
    }

    selectSearchMatch(index) {
        this.currentMatch = index;
        this.render();
    }

    _rangesForRow(row) {
        let low = 0, high = this.matches.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.matches[mid].startOrder <= row.order) low = mid + 1;
            else high = mid;
        }
        const ranges = [];
        for (let i = low - 1; i >= 0 && this.matches[i].endOrder >= row.order; i--) {
            const match = this.matches[i];
            ranges.push({
                start: row.order === match.startOrder ? match.startByte ?? 0 : 0,
                end: row.order === match.endOrder ? match.endByte ?? Infinity : Infinity,
                channel: match.channel,
                current: i === this.currentMatch
            });
        }
        return ranges;
    }

    jumpToFrame(index) {
        if (!this.frames.length) return;
        index = Math.max(0, Math.min(this.frames.length - 1, Math.round(index)));
        this.revealOrder = this.frames.orderAt(index);
        if (this._displayOptions().foldLong) {
            if (this.expandedRows.size >= 256) this.expandedRows.delete(this.expandedRows.values().next().value);
            this.expandedRows.add(this.revealOrder);
        }
        this.followTail = false;
        this.anchor = { order: this.frames.orderAt(index), within: 0, center: true };
        if (this._usesLargeLayout()) {
            this.spacer.style.height = `${Math.min(8_000_000,
                Math.max(this.container.clientHeight, this.frames.length * this.rowHeight))}px`;
            const maxScroll = Math.max(0, this.container.scrollHeight - this.container.clientHeight);
            this._setScrollTop(maxScroll * index / Math.max(1, this.frames.length - 1));
        } else this.centerPadding = Math.ceil(this.container.clientHeight / 2);
        this.render();
    }

    appendExtra(entry) {
        this.extras.push(entry);
        if (this.extras.length > 120) this.extras.shift();
        this.schedule();
    }

    clear({ deferRender = false } = {}) {
        this.extras.length = 0;
        this.followTail = true;
        this.anchor = null;
        this.cursorOrder = null;
        this.revealOrder = null;
        this.expandedRows.clear();
        this.centerPadding = 0;
        this.matches = [];
        this.currentMatch = -1;
        this.textCache.clear();
        this.textLayouts.clear();
        this.numberAlignment = null;
        this.textStates.clear();
        this.textCheckpoints.length = 0;
        this.preparedText = null;
        this.textPreparationVersion++;
        if (!deferRender) this.render();
    }

    _cancelScheduledRender() {
        if (this.pending === null) return;
        if (this.pendingAnimationFrame) cancelAnimationFrame(this.pending);
        else clearTimeout(this.pending);
        this.pending = null;
    }

    /** Coalesce receive bursts into the next browser paint, without a fixed refresh cap. */
    schedule() {
        if (this.pending !== null) return;
        const update = () => { this.pending = null; this.render(); };
        this.pendingAnimationFrame = typeof requestAnimationFrame === 'function' &&
            typeof cancelAnimationFrame === 'function';
        this.pending = this.pendingAnimationFrame ? requestAnimationFrame(update) : setTimeout(update, 0);
    }

    render() {
        this._cancelScheduledRender();
        if (this.followTail) this.centerPadding = 0;
        if (this._usesLargeLayout()) {
            this._renderLarge();
            return;
        }
        let rows;
        if (this._displayOptions().showRx) rows = mergeMonitorRows(this.frames, this.extras);
        else {
            rows = [...this.extras];
            if (this.revealOrder !== null && this.frames.length) {
                const index = this.frames.indexAtOrAfterOrder(this.revealOrder);
                if (this.frames.orderAt(index) === this.revealOrder)
                    rows.push({ ...this.frames.frameAt(index), frameIndex: index });
            }
            rows.sort((a, b) => a.order - b.order);
        }
        rows = rows.filter(row => this._rowVisible(row));
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(this.container) : null;
        const padding = css ? parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) : 20;
        const columns = this._layoutColumns(Math.max(2, Math.floor((this.container.clientWidth - padding) / this.charWidth)));
        const layouts = this._rowLayouts(rows, columns);
        const offsets = new Array(rows.length + 1);
        offsets[0] = this.centerPadding;
        for (let i = 0; i < rows.length; i++)
            offsets[i + 1] = offsets[i] + layouts[i].lineCount * this.rowHeight;
        const totalHeight = offsets[rows.length] + this.centerPadding;
        this.spacer.style.height = `${totalHeight}px`;
        if (this.followTail) {
            this._setScrollTop(Math.max(0, this.container.scrollHeight - this.container.clientHeight));
        } else if (this.anchor && rows.length) {
            let index = rows.findIndex(row => row.order >= this.anchor.order);
            if (index < 0) index = rows.length - 1;
            const within = this.anchor.center
                ? (layouts[index].lineCount * this.rowHeight - this.container.clientHeight) / 2
                : rows[index].order === this.anchor.order
                    ? Math.min(this.anchor.within ?? 0, layouts[index].lineCount * this.rowHeight - 1) : 0;
            this._setScrollTop(Math.max(0, Math.min(offsets[index] + within,
                this.container.scrollHeight - this.container.clientHeight)));
        }
        this.lastRows = rows;
        this.lastOffsets = offsets;
        this.rowPositions = rows.map((row, index) => ({ frameIndex: row.frameIndex, order: row.order,
            top: offsets[index], height: layouts[index].lineCount * this.rowHeight }));
        const first = rows.length ? Math.max(0, firstRowAt(offsets, this.container.scrollTop) - 3) : 0;
        const bottom = this.container.scrollTop + this.container.clientHeight;
        const fragment = document.createDocumentFragment();
        for (let i = first; i < rows.length && (offsets[i] < bottom || i < first + 3); i++) {
            fragment.appendChild(this._makeRow(rows[i], layouts[i], offsets[i]));
        }
        this.spacer.replaceChildren(fragment);
    }

    _makeRow(row, layout, top) {
        if (layout.deferredText) layout = this._foldLayout(row, this._rowLayout(row, layout.columns));
        if (layout.unprepared) this._prepareMissingText(row);
        const rowLineCount = layout.lineCount;
        const fullLineCount = layout.contentLineCount ?? rowLineCount;
        let firstLine = 0, lastLine = fullLineCount;
        if (fullLineCount > 64 && layout.byteMode !== 'number' && this.container && !layout.folded) {
            firstLine = Math.min(fullLineCount, Math.max(0,
                Math.floor((this.container.scrollTop - top) / this.rowHeight) - 3));
            lastLine = Math.min(fullLineCount, Math.max(firstLine,
                Math.ceil((this.container.scrollTop + this.container.clientHeight - top) / this.rowHeight) + 3));
            layout = { ...layout, firstLine, lastLine };
        }
        if (layout.folded) layout = { ...layout, firstLine: 0, lastLine: fullLineCount };
        if (layout.data) layout = { ...layout, parts:
            compactVisibleParts(layout.data, layout.lineStarts, firstLine, lastLine) };
        else if (layout.byteMode === 'text' && !layout.unprepared)
            layout = { ...layout, parts: visibleTextParts(layout.parts, firstLine, lastLine) };
        if (layout.unprepared) layout = { ...layout, parts: [{ text: '正在准备文本…', token: null }] };
        if (layout.byteMode === 'number' && layout.folded) {
            let line = 0;
            const numberSegments = [];
            for (const segment of layout.numberSegments) {
                let start = 0;
                for (let i = 0; i < segment.text.length; i++) {
                    if (segment.text[i] !== '\n') continue;
                    if (++line === fullLineCount) {
                        numberSegments.push({ ...segment, text: segment.text.slice(start, i) });
                        start = segment.text.length;
                        break;
                    }
                }
                if (start < segment.text.length) numberSegments.push(segment);
                if (line >= fullLineCount) break;
            }
            layout = { ...layout, numberSegments, numberText: numberSegments.map(segment => segment.text).join('') };
        }
        const div = document.createElement('div');
        div.className = `monitor-row ${row.kind === 'rx' ? 'log-rx-ok' : row.kind === 'error' ? 'log-rx-error' : row.kind === 'tx-error' ? 'log-tx-error' : 'log-tx-ok'}`;
        const colorKey = row.kind === 'rx' ? 'rxColor' : row.kind === 'error' ? 'rxErrorColor'
            : row.kind === 'tx-error' ? 'txErrorColor' : 'txColor';
        div.style.color = this._displayOptions()[colorKey];
        if (Number.isFinite(row.timestamp)) div.title = new Date(row.timestamp).toLocaleString();
        if (row.order === this.cursorOrder) div.className += ' monitor-cursor';
        if (div.addEventListener) div.addEventListener('click', () => {
            this.cursorOrder = row.order;
            this.render();
        });
        div.style.top = `${top}px`;
        div.style.height = `${rowLineCount * this.rowHeight}px`;
        const prefix = document.createElement('span');
        prefix.className = 'monitor-prefix';
        prefix.textContent = layout.prefix;
        if (firstLine) prefix.style.visibility = 'hidden';
        const body = document.createElement('span');
        body.className = 'monitor-data';
        const bodyLine = layout.unprepared && this.container
            ? Math.min(fullLineCount - 1, Math.max(0,
                Math.ceil((this.container.scrollTop - top) / this.rowHeight))) : firstLine;
        if (bodyLine) body.style.marginTop = `${bodyLine * this.rowHeight}px`;
        const ranges = this._rangesForRow(row);
        const relevant = ranges?.some(range => layout.byteMode === 'number'
            ? range.channel !== undefined : range.channel === undefined);
        const replacements = layout.byteMode === 'text' && layout.parts.some(part => part.token?.failed);
        if (relevant || replacements || this._displayOptions().keyword) this._appendHighlightedBody(body, row, layout, ranges ?? []);
        else body.textContent = monitorBodyText(row, layout);
        div.append(prefix, body);
        if (layout.foldControl) {
            const toggle = document.createElement('button');
            toggle.className = 'monitor-fold-toggle';
            toggle.textContent = layout.folded ? `展开（共 ${layout.fullLineCount} 行）` : '收起长帧';
            toggle.title = toggle.textContent;
            const css = typeof getComputedStyle === 'function' ? getComputedStyle(this.container) : null;
            const padding = css ? (parseFloat(css.paddingLeft) || 0) + (parseFloat(css.paddingRight) || 0) : 20;
            const columns = Math.max(2, Math.floor((this.container.clientWidth - padding) / this.charWidth));
            toggle.style.maxWidth = `${this._foldColumns(columns) * this.charWidth}px`;
            toggle.onclick = event => {
                event.stopPropagation?.();
                if (this.expandedRows.has(row.order)) this.expandedRows.delete(row.order);
                else {
                    if (this.expandedRows.size >= 256) this.expandedRows.delete(this.expandedRows.values().next().value);
                    this.expandedRows.add(row.order);
                }
                this.followTail = false;
                this.anchor = { order: row.order, within: 0 };
                this.render();
            };
            div.appendChild(toggle);
        }
        return div;
    }

    _keywordByteRanges(row, layout, hexParts) {
        const options = this._displayOptions();
        if (!options.keyword || layout.unprepared) return [];
        let firstByte = row.bytes.length, lastByte = 0;
        for (const part of layout.parts ?? hexParts ?? []) {
            const start = part.token?.startByte ?? part.byteIndex;
            if (start === null || start === undefined) continue;
            firstByte = Math.min(firstByte, start);
            lastByte = Math.max(lastByte, part.token
                ? part.token.endFrame > part.token.startFrame ? row.bytes.length : part.token.endByte : start + 1);
        }
        if (layout.byteMode === 'number' || layout.byteMode === 'ascii') {
            firstByte = (layout.firstLine ?? 0) * (layout.bytesPerLine ?? 0);
            lastByte = Math.min(row.bytes.length, (layout.lastLine ?? layout.lineCount) *
                (layout.bytesPerLine ?? row.bytes.length));
        }
        if (firstByte >= lastByte) return [];
        if (options.keywordFormat === 'hex')
            return monitorDisplayUtils.hexKeywordRanges(row.bytes, options, { firstByte, lastByte });
        if (layout.byteMode === 'number') return [];
        let tokens;
        if (row.bytes.length < 65536) tokens = this._textTokens(row, true);
        else {
            const padding = Math.max(...options.keyword.split(/\r\n|\r|\n/).map(value => value.length)) * 4 + 4;
            let start = Math.max(0, firstByte - padding);
            const end = Math.min(row.bytes.length, lastByte + padding);
            const state = this.preparedText;
            const data = layout.data ?? (state?.encoding === this.encoding &&
                state.displayKey === this._textDisplayKey() && state.firstOrder === this.frames.orderAt(0)
                ? state.rows.get(row.order) : null);
            const legacy = ['gbk', 'gb18030', 'big5', 'shift_jis'].includes(this.encoding);
            if (legacy && !data && row.frameIndex !== undefined) {
                this._prepareMissingText(row);
                return [];
            }
            if (data && start > 0) {
                let low = 0, high = data.chunks.length;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    if (data.chunks[middle].starts[0] <= start) low = middle + 1;
                    else high = middle;
                }
                const starts = data.chunks[Math.max(0, low - 1)]?.starts;
                if (starts) {
                    low = 0; high = starts.length;
                    while (low < high) {
                        const middle = Math.floor((low + high) / 2);
                        if (starts[middle] <= start) low = middle + 1;
                        else high = middle;
                    }
                    start = starts[Math.max(0, low - 1)];
                }
            } else if (legacy && !data) start = 0;
            if (this.encoding.startsWith('utf-16'))
                start = Math.max(0, start - (this._textByteOffset(this.frames, row.frameIndex, start) % 2));
            const index = row.frameIndex;
            const before = [];
            if (start === 0 && index !== undefined && !data?.initialPending) {
                let needed = 4;
                for (let frame = index - 1; frame >= 0 && needed; frame--) {
                    if (this._streamEnded(this.frames, frame)) break;
                    const bytes = this.frames.rawBytesAt(frame);
                    const offset = Math.max(0, bytes.length - needed);
                    before.unshift({ frame, bytes: bytes.subarray(offset), start: offset });
                    needed -= bytes.length - offset;
                }
                if (this.encoding.startsWith('utf-16') && before.length) {
                    const first = before[0];
                    if (this._textByteOffset(this.frames, first.frame, first.start) % 2) {
                        first.bytes = first.bytes.subarray(1);
                        first.start++;
                    }
                }
            }
            const first = before[0];
            const decoder = new monitorTextUtils.MappedTextDecoder(this.encoding, {
                byteOffset: first ? this._textByteOffset(this.frames, first.frame, first.start)
                    : this._textByteOffset(this.frames, index, start)
            });
            if (start === 0 && data?.initialPending?.length) {
                decoder.pending = data.initialPending.map(entry => ({ ...entry }));
                decoder.orphanByte = false;
            }
            tokens = [];
            for (const part of before)
                for (const token of decoder.write(part.bytes, part.frame, part.start)) tokens.push(token);
            for (const token of decoder.write(row.bytes.subarray(start, end), index ?? 0, start)) tokens.push(token);
            let needed = end === row.bytes.length && index !== undefined && !row.streamEnded ? 4 : 0;
            for (let frame = index + 1; frame < this.frames.length && needed; frame++) {
                const bytes = this.frames.rawBytesAt(frame).subarray(0, needed);
                for (const token of decoder.write(bytes, frame)) tokens.push(token);
                needed -= bytes.length;
                if (this._streamEnded(this.frames, frame)) break;
            }
            tokens.push(...decoder.flush());
        }
        let source = '';
        const positions = [];
        for (const token of tokens) {
            const text = token.failed ? '\uFFFF' : token.text;
            source += text;
            for (let i = 0; i < text.length; i++) positions.push(token);
        }
        return monitorDisplayUtils.keywordRanges(source, options).flatMap(range => {
            const matching = positions.slice(range.start, range.end);
            if (matching.some(token => token.failed)) return [];
            const first = matching[0], last = matching.at(-1);
            const frame = row.frameIndex !== undefined && ['gbk', 'gb18030', 'big5', 'shift_jis'].includes(this.encoding) && row.bytes.length < 65536
                ? row.order : row.frameIndex ?? 0;
            if (first.startFrame > frame || last.endFrame < frame) return [];
            const start = first.startFrame < frame ? 0 : first.startByte;
            const end = last.endFrame > frame ? row.bytes.length : last.endByte;
            return start < lastByte && end > firstByte ? [{ start, end }] : [];
        });
    }

    _appendHighlightedBody(body, row, layout, ranges) {
        const segments = [];
        const hexParts = layout.hex ? monitorDisplayUtils.hexVisibleParts(row.bytes, layout) : null;
        const byteKeywords = this._keywordByteRanges(row, layout, hexParts);
        const byteKeyword = (start, end) => byteKeywords.some(range => start < range.end && end > range.start);
        const add = (text, state = '', failed = false, softBreak = false, keyword = false) => {
            const last = segments.at(-1);
            if (last && last.state === state && last.failed === failed && last.softBreak === softBreak && last.keyword === keyword) last.text += text;
            else segments.push({ text, state, failed, softBreak, keyword });
        };
        if (layout.byteMode === 'text') {
            for (const part of layout.parts) {
                const token = part.token;
                const matching = token ? ranges.filter(range => range.channel === undefined &&
                    token.startByte < range.end && (token.endFrame > token.startFrame ||
                        token.endByte > range.start)) : [];
                add(part.text, matching.some(range => range.current) ? 'current'
                    : matching.length ? 'match' : '', token?.failed ?? false,
                part.text === '\n' && (part.softBreak ?? token === null),
                token ? byteKeyword(token.startByte, token.endFrame > token.startFrame ? row.bytes.length : token.endByte) : false);
            }
        } else if (layout.byteMode === 'number') {
            for (const segment of layout.numberSegments) {
                const match = segment.channel === null ? null
                    : ranges.find(range => range.channel === segment.channel);
                const parts = segment.text.split('\n');
                parts.forEach((text, index) => {
                    if (index) add('\n', '', false, true);
                    add(text, match ? (match.current ? 'current' : 'match') : '', false, false,
                        this._displayOptions().keywordFormat === 'hex' && byteKeywords.length > 0);
                });
            }
        } else if (layout.hex) {
            for (const part of hexParts) {
                const matching = part.byteIndex === null ? [] : ranges.filter(range => range.channel === undefined &&
                    part.byteIndex >= range.start && part.byteIndex < range.end);
                add(part.text, matching.some(range => range.current) ? 'current' : matching.length ? 'match' : '', false, false,
                    part.byteIndex === null ? false : byteKeyword(part.byteIndex, part.byteIndex + 1));
            }
        } else {
            const firstByte = (layout.firstLine ?? 0) * layout.bytesPerLine;
            const lastByte = Math.min(row.bytes.length,
                (layout.lastLine ?? layout.lineCount) * layout.bytesPerLine);
            for (let i = firstByte; i < lastByte; i++) {
                if (i > firstByte && i % layout.bytesPerLine === 0) add('\n');
                else if (i > firstByte && layout.byteMode === 'hex') add(' ');
                const matching = ranges.filter(range => range.channel === undefined &&
                    i >= range.start && i < range.end);
                const state = matching.some(range => range.current) ? 'current'
                    : matching.length ? 'match' : '';
                add(layout.byteMode === 'ascii' ? displayByte(row.bytes[i])
                    : row.bytes[i].toString(16).padStart(2, '0').toUpperCase(), state, false, false, byteKeyword(i, i + 1));
            }
        }
        const options = this._displayOptions();
        let keywordSource = '', renderedOffset = 0;
        const keywordOffsets = [];
        const numericTextKeywords = layout.byteMode === 'number' && options.keywordFormat === 'text';
        if (options.keyword && numericTextKeywords) for (const segment of segments) {
            if (!segment.softBreak) {
                keywordSource += segment.text;
                for (let i = 0; i < segment.text.length; i++) keywordOffsets.push(renderedOffset + i);
            }
            renderedOffset += segment.text.length;
        }
        const keywords = options.keyword && numericTextKeywords ? monitorDisplayUtils.keywordRanges(keywordSource, options)
            .map(range => ({ start: keywordOffsets[range.start], end: keywordOffsets[range.end - 1] + 1 })) : [];
        let position = 0;
        for (const segment of segments) {
            const end = position + segment.text.length;
            const cuts = [position, end];
            for (const range of keywords) {
                if (range.start > position && range.start < end) cuts.push(range.start);
                if (range.end > position && range.end < end) cuts.push(range.end);
            }
            cuts.sort((a, b) => a - b);
            for (let i = 1; i < cuts.length; i++) {
                if (cuts[i] === cuts[i - 1]) continue;
                const keyword = !segment.state && !segment.softBreak &&
                    (segment.keyword || keywords.some(range => range.start <= cuts[i - 1] && range.end >= cuts[i]));
                const span = document.createElement('span');
                span.textContent = segment.text.slice(cuts[i - 1] - position, cuts[i] - position);
                if (segment.state) {
                    span.className = `monitor-search-${segment.state}`;
                    span.style.backgroundColor = segment.state === 'current' ? options.searchCurrentColor : options.searchMatchColor;
                }
                else if (keyword) { span.className = 'monitor-keyword'; span.style.color = options.keywordColor; }
                if (segment.failed) span.style.color = '#fff';
                body.appendChild(span);
            }
            position = end;
        }
    }

    _renderLarge() {
        const { frames, container } = this;
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
        const padding = css ? parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) : 20;
        const verticalPadding = css ? (parseFloat(css.paddingTop) || 0) +
            (parseFloat(css.paddingBottom) || 0) : 0;
        const contentHeight = Math.max(0, container.clientHeight - verticalPadding);
        const columns = this._layoutColumns(Math.max(2, Math.floor((container.clientWidth - padding) / this.charWidth)));
        const sample = { ...frames.frameAt(0), frameIndex: 0 };
        const rowHeight = this._foldLayout(sample, this._rowLayout(sample, columns)).lineCount * this.rowHeight;
        this.spacer.style.height = `${Math.min(8_000_000,
            Math.max(container.clientHeight, frames.length * rowHeight))}px`;
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        if (this.followTail) {
            this._setScrollTop(maxScroll);
        } else if (this.anchor) {
            const index = frames.indexAtOrAfterOrder(this.anchor.order);
            const position = Math.min(frames.length - 1, index + (this.anchor.fraction ?? 0));
            this._setScrollTop(maxScroll * position / Math.max(1, frames.length - 1));
        }
        const position = this.followTail ? frames.length - 1
            : Math.max(0, Math.min(frames.length - 1, container.scrollTop /
                Math.max(1, maxScroll) * (frames.length - 1)));
        const anchorIndex = Math.floor(position);
        const visible = Math.ceil(contentHeight / this.rowHeight) + 12;
        const first = this.followTail ? Math.max(0, frames.length - visible)
            : Math.min(Math.max(0, frames.length - visible),
                Math.max(0, anchorIndex - Math.floor(visible / 2)));
        const last = Math.min(frames.length, first + visible);
        const rows = [];
        for (let i = first; i < last; i++) rows.push({ ...frames.frameAt(i), frameIndex: i });
        const firstOrder = rows[0]?.order ?? Infinity;
        const lastOrder = rows.at(-1)?.order ?? -Infinity;
        for (const extra of this.extras)
            if (extra.order >= firstOrder && (extra.order <= lastOrder || this.followTail)) rows.push(extra);
        rows.sort((a, b) => a.order - b.order);
        const visibleRows = rows.filter(row => this._rowVisible(row));
        rows.length = 0;
        rows.push(...visibleRows);
        const layouts = this._rowLayouts(rows, columns);
        const anchorRow = rows.findIndex(row => row.frameIndex === anchorIndex);
        const beforeAnchor = layouts.slice(0, Math.max(0, anchorRow))
            .reduce((sum, layout) => sum + layout.lineCount * this.rowHeight, 0);
        const anchorHeight = (layouts[anchorRow]?.lineCount ?? 1) * this.rowHeight;
        const nextHeight = (layouts[anchorRow + 1]?.lineCount ?? 1) * this.rowHeight;
        const fraction = position - anchorIndex;
        const centered = !this.followTail && this.anchor?.center;
        let top = this.followTail
            ? container.scrollTop + contentHeight - layouts.reduce((sum, layout) =>
                sum + layout.lineCount * this.rowHeight, 0)
            : container.scrollTop + (centered ? contentHeight / 2 : contentHeight) -
                beforeAnchor - (centered ? anchorHeight / 2 : anchorHeight) -
                fraction * (centered ? (anchorHeight + nextHeight) / 2 : nextHeight);
        if (!this.followTail && !this.anchor?.center && first === 0)
            top = Math.min(top, container.scrollTop);
        const fragment = document.createDocumentFragment();
        this.rowPositions = [];
        for (let i = 0; i < rows.length; i++) {
            const height = layouts[i].lineCount * this.rowHeight;
            this.rowPositions.push({ frameIndex: rows[i].frameIndex, order: rows[i].order, top, height });
            if (top < container.scrollTop + contentHeight && top + height > container.scrollTop)
                fragment.appendChild(this._makeRow(rows[i], layouts[i], top));
            top += height;
        }
        this.lastRows = rows;
        this.lastOffsets = [];
        this.spacer.replaceChildren(fragment);
    }
}

if (typeof module !== 'undefined') module.exports = {
    MonitorView, mergeMonitorRows, bytesToHex, textCells, appendCompactTokens,
    MonitorTextLayout: { textCells, appendCompactTokens }
};
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.MonitorView = MonitorView;
globalThis.SerialPlotter.MonitorTextLayout = { textCells, appendCompactTokens };
