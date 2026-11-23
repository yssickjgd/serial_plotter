/** Commit a configuration group when leaving it or pressing Enter in a field. */
function bindAutoApply(group, apply, listen = (target, event, handler) => target.addEventListener(event, handler)) {
    listen(group, 'pointerleave', () => apply());
    listen(group, 'keydown', event => {
        if (event.defaultPrevented || event.isComposing || event.repeat || event.key !== 'Enter' ||
            event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
            !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return;
        event.preventDefault();
        apply(true);
    });
}

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.bindAutoApply = bindAutoApply;
if (typeof module !== 'undefined') module.exports = { bindAutoApply };
