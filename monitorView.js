/** Build a chronological view without evicting RX frames for TX/error events. */
const monitorByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;

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
    for (const char of value) cells += char.codePointAt(0) > 0xff ? 2 : 1;
    return cells;
}

/** Compute a row's exact line count without converting offscreen bytes to Hex. */
function decodedRowText(row, frames) {
    if (row.kind !== 'rx' || row.frameIndex === undefined) return null;
    const fields = [];
    for (let channel = 0; channel < frames.channelCount; channel++)
        fields.push(`CH${channel + 1}=${frames.getValue(channel, row.frameIndex)}`);
    return fields.join('  ');
}

function displayByte(byte) { return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '·'; }

function monitorRowLayout(row, columns, mode = 'hex', frames = null) {
    const direction = row.kind === 'rx' || row.kind === 'error' ? 'RX' : 'TX';
    const prefix = `[${row.time}] ${direction}${row.reason ? `[${row.reason}]` : ''} `;
    const bodyColumns = Math.max(2, columns - textCells(prefix));
    const numberText = mode === 'number' && frames ? decodedRowText(row, frames) : null;
    const byteMode = numberText === null ? (mode === 'ascii' ? 'ascii' : 'hex') : 'number';
    const bytesPerLine = Math.max(1, byteMode === 'hex'
        ? Math.floor((bodyColumns + 1) / 3) : bodyColumns);
    return {
        prefix, bytesPerLine, byteMode, numberText,
        lineCount: Math.max(1, Math.ceil((numberText?.length ?? row.bytes.length) / bytesPerLine))
    };
}

function monitorBodyText(row, layout) {
    if (layout.byteMode === 'number') {
        const lines = [];
        for (let i = 0; i < layout.numberText.length; i += layout.bytesPerLine)
            lines.push(layout.numberText.slice(i, i + layout.bytesPerLine));
        return lines.join('\n');
    }
    const lines = [];
    let position = 0;
    while (position < row.bytes.length) {
        const end = Math.min(row.bytes.length, position + layout.bytesPerLine);
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

class MonitorView {
    constructor(container, frames) {
        this.container = container;
        this.frames = frames;
        this.extras = [];
        this.rowHeight = 20;
        this.charWidth = 8;
        this.pending = null;
        this.followTail = true;
        this._renderedScrollTop = container.scrollTop;
        this.anchor = null;
        this.lastRows = [];
        this.lastOffsets = [0];
        this.rowPositions = [];
        this.mode = 'hex';
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
            } else if (this.frames.length > this.largeThreshold) {
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
        let nearest = -1, distance = Infinity;
        for (const row of this.rowPositions) {
            if (row.frameIndex === undefined) continue;
            if (center >= row.top && center < row.top + row.height) return row.frameIndex;
            const difference = Math.max(row.top - center, center - row.top - row.height, 0);
            if (difference < distance) { nearest = row.frameIndex; distance = difference; }
        }
        return nearest;
    }

    _setScrollTop(value) {
        this._settingScroll = true;
        this.container.scrollTop = value;
        this._renderedScrollTop = this.container.scrollTop;
        this._settingScroll = false;
    }

    setMode(mode) {
        if (!['hex', 'ascii', 'number'].includes(mode)) throw new RangeError('监视台显示格式无效');
        this.mode = mode;
        this.render();
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
        this.followTail = false;
        this.anchor = { order: this.frames.orderAt(index), within: 0, center: true };
        if (this.frames.length > this.largeThreshold) {
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

    clear() {
        this.extras.length = 0;
        this.followTail = true;
        this.anchor = null;
        this.cursorOrder = null;
        this.centerPadding = 0;
        this.matches = [];
        this.currentMatch = -1;
        this.render();
    }

    schedule() {
        if (this.pending !== null) return;
        this.pending = setTimeout(() => { this.pending = null; this.render(); }, 100);
    }

    render() {
        if (this.frames.length > this.largeThreshold) {
            this._renderLarge();
            return;
        }
        const rows = mergeMonitorRows(this.frames, this.extras);
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(this.container) : null;
        const padding = css ? parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) : 20;
        const columns = Math.max(2, Math.floor((this.container.clientWidth - padding) / this.charWidth));
        const layouts = rows.map(row => monitorRowLayout(row, columns, this.mode, this.frames));
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
                    ? Math.min(this.anchor.within, layouts[index].lineCount * this.rowHeight - 1) : 0;
            this._setScrollTop(Math.max(0, Math.min(offsets[index] + within,
                this.container.scrollHeight - this.container.clientHeight)));
        }
        this.lastRows = rows;
        this.lastOffsets = offsets;
        this.rowPositions = rows.map((row, index) => ({ frameIndex: row.frameIndex,
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
        const div = document.createElement('div');
        div.className = `monitor-row ${row.kind === 'rx' ? 'log-rx-ok' : row.kind === 'error' ? 'log-rx-error' : row.kind === 'tx-error' ? 'log-tx-error' : 'log-tx-ok'}`;
        if (Number.isFinite(row.timestamp)) div.title = new Date(row.timestamp).toLocaleString();
        if (row.order === this.cursorOrder) div.className += ' monitor-cursor';
        if (div.addEventListener) div.addEventListener('click', () => {
            this.cursorOrder = row.order;
            this.render();
        });
        div.style.top = `${top}px`;
        div.style.height = `${layout.lineCount * this.rowHeight}px`;
        const prefix = document.createElement('span');
        prefix.className = 'monitor-prefix';
        prefix.textContent = layout.prefix;
        const body = document.createElement('span');
        body.className = 'monitor-data';
        const ranges = this._rangesForRow(row);
        const relevant = ranges?.some(range => layout.byteMode === 'number'
            ? range.channel !== undefined : range.channel === undefined);
        if (relevant) this._appendHighlightedBody(body, row, layout, ranges);
        else body.textContent = monitorBodyText(row, layout);
        div.append(prefix, body);
        return div;
    }

    _appendHighlightedBody(body, row, layout, ranges) {
        const segments = [];
        const add = (text, state = '') => {
            const last = segments.at(-1);
            if (last && last.state === state) last.text += text;
            else segments.push({ text, state });
        };
        if (layout.byteMode === 'number') {
            let position = 0;
            for (let channel = 0; channel < this.frames.channelCount; channel++) {
                const text = `CH${channel + 1}=${this.frames.getValue(channel, row.frameIndex)}`;
                const match = ranges.find(range => range.channel === channel);
                for (const char of text) {
                    if (position && position % layout.bytesPerLine === 0) add('\n');
                    add(char, match ? (match.current ? 'current' : 'match') : '');
                    position++;
                }
                if (channel < this.frames.channelCount - 1) {
                    for (const char of '  ') {
                        if (position && position % layout.bytesPerLine === 0) add('\n');
                        add(char);
                        position++;
                    }
                }
            }
        } else {
            for (let i = 0; i < row.bytes.length; i++) {
                if (i && i % layout.bytesPerLine === 0) add('\n');
                else if (i && layout.byteMode === 'hex') add(' ');
                const matching = ranges.filter(range => range.channel === undefined &&
                    i >= range.start && i < range.end);
                const state = matching.some(range => range.current) ? 'current'
                    : matching.length ? 'match' : '';
                add(layout.byteMode === 'ascii' ? displayByte(row.bytes[i])
                    : row.bytes[i].toString(16).padStart(2, '0').toUpperCase(), state);
            }
        }
        for (const segment of segments) {
            const span = document.createElement('span');
            span.textContent = segment.text;
            if (segment.state) span.className = `monitor-search-${segment.state}`;
            body.appendChild(span);
        }
    }

    _renderLarge() {
        const { frames, container } = this;
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
        const padding = css ? parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) : 20;
        const verticalPadding = css ? (parseFloat(css.paddingTop) || 0) +
            (parseFloat(css.paddingBottom) || 0) : 0;
        const contentHeight = Math.max(0, container.clientHeight - verticalPadding);
        const columns = Math.max(2, Math.floor((container.clientWidth - padding) / this.charWidth));
        const sample = { ...frames.frameAt(0), frameIndex: 0 };
        const rowHeight = monitorRowLayout(sample, columns, this.mode, frames).lineCount * this.rowHeight;
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
        const layouts = rows.map(row => monitorRowLayout(row, columns, this.mode, frames));
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
            this.rowPositions.push({ frameIndex: rows[i].frameIndex, top, height });
            if (top < container.scrollTop + contentHeight && top + height > container.scrollTop)
                fragment.appendChild(this._makeRow(rows[i], layouts[i], top));
            top += height;
        }
        this.lastRows = rows;
        this.lastOffsets = [];
        this.spacer.replaceChildren(fragment);
    }
}

if (typeof module !== 'undefined') module.exports = { MonitorView, mergeMonitorRows, bytesToHex };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.MonitorView = MonitorView;
