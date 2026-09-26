import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { createElectronApi } from '../../electron/preload/electron-api.ts'

const api = createElectronApi({ ipcRenderer, webFrame })
contextBridge.exposeInMainWorld('electron', {
  workspace: { worlds: { projects: api.workspace.worlds.projects, cli: {
    status: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    beginPairing: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    revoke: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    listPending: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    getReview: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    reject: async () => ({ ok: false, code: 'UNAVAILABLE' }),
    apply: async () => ({ ok: false, code: 'UNAVAILABLE' }),
  } } },
  agentSessions: api.agentSessions,
})
contextBridge.exposeInMainWorld('worldsAiFixture', {
  getConfig: () => ipcRenderer.invoke('worldsAiFixture:config'),
  environment: { sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true },
})
