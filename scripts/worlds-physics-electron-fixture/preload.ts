// Reuse the frozen sandboxed production-project bridge without adding fixture IPC privileges.
import '../worlds-character-electron-fixture/preload.ts'
import { contextBridge, ipcRenderer } from 'electron'
import { ACCEPTANCE_CHANNELS, type PhysicsAcceptanceFacade } from './shared.ts'
import type { AcceptanceContext } from './acceptance-entry.ts'

let ownedContext: Promise<AcceptanceContext | null> | null = null
let sequence = 0, pending = false, terminal = false
const claim = () => ownedContext ??= ipcRenderer.invoke(ACCEPTANCE_CHANNELS.context)
const encode = (context: AcceptanceContext, type: string, payload: unknown) => JSON.stringify({ token: context.token, phase: context.phase, sequence, type, payload })
async function request(type: string, payload: unknown) {
  const context = await claim()
  if (!context || pending || terminal) throw new Error('Acceptance authority is absent, pending or terminal.')
  pending = true
  try {
    const result = await ipcRenderer.invoke(ACCEPTANCE_CHANNELS.request, encode(context, type, payload))
    sequence += 1
    if (type === 'terminal') {
      terminal = true
      if (!result.persisted) throw new Error('Acceptance terminal lacks durable receipt.')
      await ipcRenderer.invoke(ACCEPTANCE_CHANNELS.receipt, encode(context, 'receipt', null))
      sequence += 1
    }
    return result
  } finally { pending = false }
}
const facade: PhysicsAcceptanceFacade = Object.freeze<PhysicsAcceptanceFacade>({
  async context() { const context = await claim(); if (!context) return null; const { token: _privateToken, ...declaration } = context; return Object.freeze(declaration) },
  baseline: payload => request('baseline', payload), progress: payload => request('progress', payload), terminal: payload => request('terminal', payload),
  onCancel(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: { token?: unknown; phase?: unknown }) => {
      void claim().then(context => { if (context && value?.token === context.token && value.phase === context.phase && !terminal) callback() })
    }
    ipcRenderer.on(ACCEPTANCE_CHANNELS.cancel, listener)
    return () => ipcRenderer.removeListener(ACCEPTANCE_CHANNELS.cancel, listener)
  },
})
contextBridge.exposeInMainWorld('worldsPhysicsAcceptance', facade)
