/** Build a chronological view without evicting RX frames for TX/error events. */
const monitorByteUtils = typeof module !== 'undefined'
    ? require('./byteUtils').ByteUtils : globalThis.SerialPlotter.ByteUtils;

function mergeMonitorRows(frames, extras) {
    const rows = new Array(frames.length + extras.length);
    for (let i = 0; i < frames.length; i++) rows[i] = frames.frameAt(i);
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
function monitorRowLayout(row, columns) {
    const direction = row.kind === 'rx' || row.kind === 'error' ? 'RX' : 'TX';
    const prefix = `[${row.time}] ${direction}${row.reason ? `[${row.reason}]` : ''} `;
    const bodyColumns = Math.max(2, columns - textCells(prefix));
    const bytesPerLine = Math.max(1, Math.floor((bodyColumns + 1) / 3));
    return {
        prefix, bytesPerLine,
        lineCount: Math.max(1, Math.ceil(row.bytes.length / bytesPerLine))
    };
}

function monitorBodyText(row, layout) {
    const lines = [];
    let position = 0;
    while (position < row.bytes.length) {
        const end = Math.min(row.bytes.length, position + layout.bytesPerLine);
        lines.push(bytesToHex(row.bytes.subarray(position, end)));
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
        this.anchor = null;
        this.lastRows = [];
        this.lastOffsets = [0];
        this.spacer = document.createElement('div');
        this.spacer.className = 'monitor-spacer';
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
            const bottom = Math.max(0, container.scrollHeight - container.clientHeight);
            this.followTail = bottom - container.scrollTop <= 1;
            if (this.followTail) {
                this.anchor = null;
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

    appendExtra(entry) {
        this.extras.push(entry);
        if (this.extras.length > 120) this.extras.shift();
        this.schedule();
    }

    clear() {
        this.extras.length = 0;
        this.followTail = true;
        this.anchor = null;
        this.render();
    }

    schedule() {
        if (this.pending !== null) return;
        this.pending = setTimeout(() => { this.pending = null; this.render(); }, 100);
    }

    render() {
        const rows = mergeMonitorRows(this.frames, this.extras);
        const css = typeof getComputedStyle === 'function' ? getComputedStyle(this.container) : null;
        const padding = css ? parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) : 20;
        const columns = Math.max(2, Math.floor((this.container.clientWidth - padding) / this.charWidth));
        const layouts = rows.map(row => monitorRowLayout(row, columns));
        const offsets = new Array(rows.length + 1);
        offsets[0] = 0;
        for (let i = 0; i < rows.length; i++)
            offsets[i + 1] = offsets[i] + layouts[i].lineCount * this.rowHeight;
        const totalHeight = offsets[rows.length];
        this.spacer.style.height = `${totalHeight}px`;
        if (this.followTail) {
            this.container.scrollTop = Math.max(0, this.container.scrollHeight - this.container.clientHeight);
        } else if (this.anchor && rows.length) {
            let index = rows.findIndex(row => row.order >= this.anchor.order);
            if (index < 0) index = rows.length - 1;
            const within = rows[index].order === this.anchor.order
                ? Math.min(this.anchor.within, layouts[index].lineCount * this.rowHeight - 1) : 0;
            this.container.scrollTop = Math.max(0, Math.min(offsets[index] + within,
                this.container.scrollHeight - this.container.clientHeight));
        }
        this.lastRows = rows;
        this.lastOffsets = offsets;
        const first = rows.length ? Math.max(0, firstRowAt(offsets, this.container.scrollTop) - 3) : 0;
        const bottom = this.container.scrollTop + this.container.clientHeight;
        const fragment = document.createDocumentFragment();
        for (let i = first; i < rows.length && (offsets[i] < bottom || i < first + 3); i++) {
            const row = rows[i];
            const div = document.createElement('div');
            div.className = `monitor-row ${row.kind === 'rx' ? 'log-rx-ok' : row.kind === 'error' ? 'log-rx-error' : row.kind === 'tx-error' ? 'log-tx-error' : 'log-tx-ok'}`;
            div.style.top = `${offsets[i]}px`;
            div.style.height = `${layouts[i].lineCount * this.rowHeight}px`;
            const prefix = document.createElement('span');
            prefix.className = 'monitor-prefix';
            prefix.textContent = layouts[i].prefix;
            const body = document.createElement('span');
            body.className = 'monitor-data';
            body.textContent = monitorBodyText(row, layouts[i]);
            div.append(prefix, body);
            fragment.appendChild(div);
        }
        this.spacer.replaceChildren(fragment);
    }
}

if (typeof module !== 'undefined') module.exports = { MonitorView, mergeMonitorRows, bytesToHex };
globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.MonitorView = MonitorView;
