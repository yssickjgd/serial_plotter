const PROJECT_LIMITS = Object.freeze({
    minChannels: 1,
    maxChannels: 50,
    minPoints: 2,
    maxPoints: 3600000,
    maxPlotWindowPoints: 65536,
    minPort: 1,
    maxPort: 65535
});

globalThis.SerialPlotter ??= {};
globalThis.SerialPlotter.Limits = PROJECT_LIMITS;
if (typeof module !== 'undefined') module.exports = { PROJECT_LIMITS };
