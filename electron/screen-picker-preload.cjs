const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('screenPicker', {
    run: (action, value) => ipcRenderer.invoke('lowcord:screen-picker', action, value),
});
