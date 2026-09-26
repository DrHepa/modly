import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { createElectronApi } from '../../electron/preload/electron-api.ts'

// Use the production project bridge, without exposing unrelated application privileges.
const api = createElectronApi({ ipcRenderer, webFrame })
contextBridge.exposeInMainWorld('electron', {
  workspace: { worlds: { projects: api.workspace.worlds.projects } },
})
contextBridge.exposeInMainWorld('worldsFixtureEnvironment', Object.freeze({
  sandboxed: process.sandboxed === true,
  contextIsolated: process.contextIsolated === true,
}))
