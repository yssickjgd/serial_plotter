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
    assert.ok(panel('tab-byte-frame').includes('id="capture-mode"'));
    assert.ok(panel('tab-byte-frame').includes('id="rebuild-history-byte"'));
    assert.ok(panel('tab-waveform-frame').includes('id="rebuild-history"'));
    assert.ok(panel('tab-waveform-frame').indexOf('id="rebuild-history"') <
        panel('tab-waveform-frame').indexOf('id="frame-numeric-settings"'));
    assert.doesNotMatch(html, /id="tab-frame"|data-tab="tab-frame"/);
    assert.ok(!wave.includes('tab-bar'));
    assert.ok(exportPanel.includes('id="export-panel"'));
    assert.ok(panel('sidebar-top').includes('data-tab="tab-export"'));
    assert.ok(panel('sidebar-top').includes('id="export-panel"'));
    assert.doesNotMatch(panel('monitor-settings-tabs'), /tab-export|export-panel/);
    assert.ok(!html.includes('id="tab-channel-config"'));
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
