// The desktop trial's preload (docs/cross-platform-plan.md §5.2). It runs sandboxed, so it is
// CommonJS and may require only 'electron'. The trial needs no IPC: it exposes one frozen object so
// a page can tell it runs in the desktop app. saveFile and the notification calls come later.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('plannrDesktop', Object.freeze({ runtime: 'desktop' }));
