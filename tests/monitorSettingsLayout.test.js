const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

function panel(id) {
    const startTag = new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`).exec(html);
    assert.ok(startTag, `${id} exists`);
    const tags = /<div\b[^>]*>|<\/div>/g;
    tags.lastIndex = startTag.index;
    let depth = 0, tag;
    while ((tag = tags.exec(html))) {
        depth += tag[0].startsWith('</') ? -1 : 1;
        if (depth === 0) return html.slice(startTag.index, tags.lastIndex);
    }
    throw new Error(`Unclosed ${id}`);
}

test('monitor properties stay on the right while export is a peer left sidebar category', () => {
    assert.match(html, /id="tab-monitor-config-button"[^>]*data-tab="tab-monitor-config">显示方式<\/button>/);
    assert.match(html, /id="tab-waveform-config-button"[^>]*data-tab="tab-waveform-config">显示方式<\/button>/);
    const bytes = panel('tab-monitor-config');
    const wave = panel('tab-waveform-config');
    const exportPanel = panel('tab-export');
    assert.ok(bytes.includes('id="monitor-display-panel"'));
    assert.ok(bytes.includes('id="monitor-config-panel"'));
    assert.ok(bytes.includes('id="monitor-color-panel"'));
    assert.ok(bytes.indexOf('id="monitor-config-panel"') < bytes.indexOf('id="monitor-color-panel"'));
    assert.ok(!bytes.includes('id="channels-list-panel"'));
    assert.ok(wave.includes('id="channels-display-panel"'));
    assert.ok(!wave.includes('id="channels-list-panel"'));
    assert.ok(panel('tab-waveform-channels').includes('id="channels-list-panel"'));
    assert.ok(panel('tab-monitor-channels').includes('id="monitor-channel-list"'));
    assert.ok(bytes.includes('id="capture-mode"'));
    assert.ok(bytes.includes('id="frame-text-settings"'));
    assert.doesNotMatch(panel('monitor-settings-tabs'), /tab-(?:byte|waveform|pose)-frame/);
    assert.ok(panel('engine-parsing').includes('id="rebuild-history"'));
    assert.ok(panel('engine-parsing').includes('id="frame-numeric-settings"'));
    assert.ok(panel('engine-parsing').includes('id="engine-apply"'));
    assert.ok(!panel('sidebar-top').includes('id="data-type"'));
    assert.doesNotMatch(html, /id="tab-frame"|data-tab="tab-frame"/);
    assert.ok(!wave.includes('tab-bar'));
    assert.ok(exportPanel.includes('id="export-panel"'));
    assert.ok(panel('sidebar-top').includes('data-tab="tab-export"'));
    assert.ok(panel('sidebar-top').includes('id="export-panel"'));
    assert.doesNotMatch(panel('monitor-settings-tabs'), /tab-export|export-panel/);
    assert.ok(!html.includes('id="tab-channel-config"'));
});

test('export and shared parsing settings make their scope visible without changing controls', () => {
    const exportPanel = panel('export-panel');
    assert.match(exportPanel, /格式与范围/);
    assert.match(exportPanel, /导出文件/);
    assert.match(panel('frame-numeric-settings'), /scope-badge[^>]*>全局共用/);
    assert.match(panel('frame-raw-settings'), /scope-badge[^>]*>全局共用/);
});

test('sidebar export settings use peer cards with conditional format settings and compact controls', () => {
    const exportPanel = panel('export-panel');
    for (const id of ['wrap-export-text-parsing', 'wrap-export-numeric-parsing', 'export-channels-wrap']) {
        assert.match(exportPanel, new RegExp(`<div id="${id}" class="control-group(?: [^"]+)?"`));
    }
    assert.match(exportPanel, /id="export-scope-panel"[^>]*>[\s\S]*?class="section-title">格式与范围/);
    assert.match(exportPanel, /class="section-title">文本帧解析/);
    assert.match(exportPanel, /class="section-title">数值帧解析/);
    assert.match(exportPanel, /id="export-confirm-panel"[^>]*>[\s\S]*?class="section-title">导出文件/);
    assert.match(panel('export-confirm-panel'), /id="export-text-metadata"/);
    assert.match(panel('export-confirm-panel'), /id="export-parse-status"/);
    assert.match(panel('frame-text-settings'), /id="frame-text-settings"[^>]*class="sidebar-stack"/);
    assert.match(panel('wrap-response-options'), /id="wrap-response-options"[^>]*class="sidebar-stack"/);
    assert.match(panel('config-serial'), /id="config-serial"[^>]*class="sidebar-stack"/);
    assert.match(panel('config-net'), /id="config-net"[^>]*class="sidebar-stack"/);
    assert.doesNotMatch(html, /margin-top:\s*-4px/);
    assert.match(css, /--ui-group-gap:\s*6px/);
    assert.match(css, /--ui-section-gap:\s*8px/);
    assert.match(css, /\.chk-label\s*\{[^}]*font-size:\s*var\(--ui-label-size\)/);
    assert.match(css, /\.sidebar \.btn, \.channel-sidebar \.btn\s*\{[^}]*font-size:\s*var\(--ui-label-size\)/);
    assert.match(css, /\.widget-library-item\s*>\s*small\s*\{[^}]*font-size:\s*var\(--ui-note-size\)/);
});

test('sidebar checkbox groups show one choice per line', () => {
    const metadata = panel('export-text-metadata');
    assert.match(metadata, /id="export-timestamps"/);
    assert.match(metadata, /id="export-markers"/);
    assert.match(css, /\.export-metadata\s*\{[^}]*flex-direction:\s*column/);
    assert.match(css, /\.monitor-checkboxes\s*\{[^}]*flex-direction:\s*column/);
    assert.match(css, /\.export-channel-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('byte display settings have no configurable refresh rate', () => {
    assert.doesNotMatch(html, /monitor-refresh-rate/);
    assert.doesNotMatch(panel('monitor-display-panel'), /刷新率/);
});

test('sidebar includes keyword type, record colors and a checked text-search case control', () => {
    assert.match(html, /<select id="monitor-keyword-format">[\s\S]*?<option value="text"[^>]*>文本/);
    assert.match(html, /id="monitor-keyword-case-wrap"/);
    const colors = panel('monitor-color-panel');
    assert.match(colors, /class="section-title">颜色配置<\/div>/);
    for (const id of ['keyword', 'rx', 'tx', 'rx-error', 'tx-error', 'search-current', 'search-match']) {
        const pattern = new RegExp(`type="color" id="monitor-${id}-color"`);
        assert.match(colors, pattern);
        assert.doesNotMatch(panel('monitor-config-panel'), pattern);
    }
    assert.match(html, /id="monitor-search-case-wrap"[^>]*>[\s\S]*?id="monitor-search-case-sensitive" checked/);
    assert.match(css, /\.monitor-color-grid\s*\{[^}]*display:\s*grid/);
});

test('long-frame toggle stays at the first row right edge without a separate layout row', () => {
    const toggle = /\.monitor-fold-toggle\s*\{([^}]*)\}/.exec(css)?.[1];
    assert.ok(toggle);
    assert.match(toggle, /position:\s*absolute/);
    assert.match(toggle, /right:\s*0/);
    assert.match(toggle, /top:\s*0/);
    assert.match(toggle, /height:\s*20px/);
    assert.match(toggle, /white-space:\s*nowrap/);
});
