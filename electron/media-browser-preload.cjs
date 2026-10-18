const {contextBridge,ipcRenderer}=require('electron');
if(process.isMainFrame)contextBridge.exposeInMainWorld('mediaBrowser',{
    run:(action,value)=>ipcRenderer.invoke('lowcord:media-browser',action,value),
    onState:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('lowcord:media-browser-state',listener);return()=>ipcRenderer.removeListener('lowcord:media-browser-state',listener);},
});
