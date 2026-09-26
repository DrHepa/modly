import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { createElectronApi, type IpcRendererLike } from '../../electron/preload/electron-api.ts'
import { WORLD_PROJECT_CHANNELS } from '../../src/shared/types/worldProjects.ts'
import { LOCAL_AI_SESSION_METHODS } from './shared.ts'

const known = new Set<string>([...Object.values(WORLD_PROJECT_CHANNELS), ...LOCAL_AI_SESSION_METHODS.map((method) => `agentSessions:${method}`), 'app:info', 'workspace:library:list', 'workspace:library:read', 'workspace:library:open'])
function violation(operation: string, channel: string): never {
  ipcRenderer.send('worlds-authoring:violation', { operation, channel })
  throw new Error(`Authoring fixture refuses ${operation} ${channel}`)
}
const ports: IpcRendererLike = {
  invoke(channel, ...args) { return known.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(violation('invoke', channel)) },
  send(channel) { violation('send', channel) },
  on(channel) { violation('on', channel) },
  removeAllListeners(channel) { violation('removeAllListeners', channel) },
}
const api = createElectronApi({ ipcRenderer: ports, webFrame })
// Production implementations and response contracts, deliberately narrowed host privileges.
contextBridge.exposeInMainWorld('electron', { app: { info: api.app.info }, agentSessions: Object.fromEntries(LOCAL_AI_SESSION_METHODS.map((method) => [method, api.agentSessions[method]])), workspace: { library: api.workspace.library, worlds: { projects: api.workspace.worlds.projects } } })
contextBridge.exposeInMainWorld('worldsAuthoringEnvironment', { sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true })
