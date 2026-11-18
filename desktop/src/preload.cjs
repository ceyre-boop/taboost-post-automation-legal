// Bridge between the license screen and the main process. contextIsolation is on,
// so the renderer only ever sees these two narrow functions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("poster", {
  activate: (key) => ipcRenderer.invoke("license:activate", key),
  current: () => ipcRenderer.invoke("license:current"),
});
