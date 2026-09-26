import { contextBridge, ipcRenderer, webFrame } from 'electron'

import { createElectronApi } from '../../electron/preload/electron-api.ts'
import { exactRecord, isFixtureScenario, type FixtureScenario } from './shared.ts'

const rawConfig = ipcRenderer.sendSync('worldsC3Fixture:config') as unknown
const configRecord = exactRecord(rawConfig, ['scenario'])
if (!isFixtureScenario(configRecord.scenario)) throw new Error('Invalid fixture scenario configuration.')
const scenario: FixtureScenario = configRecord.scenario
const api = createElectronApi({ ipcRenderer, webFrame })
let lostReplyInjected = false

const cli = {
  ...api.workspace.worlds.cli,
  async commitDirectEdit(value: Parameters<typeof api.workspace.worlds.cli.commitDirectEdit>[0]) {
    ipcRenderer.send('worldsC3Fixture:observe', { type: 'commit-preload-invoke', scenario })
    const reply = await api.workspace.worlds.cli.commitDirectEdit(value)
    ipcRenderer.send('worldsC3Fixture:observe', { type: 'commit-preload-reply', scenario, ok: reply.ok,
      code: reply.ok ? null : reply.code })
    if (scenario === 'duplicate-loss' && reply.ok && !lostReplyInjected) {
      lostReplyInjected = true
      ipcRenderer.send('worldsC3Fixture:observe', { type: 'INJECTED_LOST_COMMIT_REPLY', scenario })
      throw new Error('INJECTED_LOST_COMMIT_REPLY')
    }
    return reply
  },
}

contextBridge.exposeInMainWorld('electron', {
  ...api,
  workspace: {
    ...api.workspace,
    worlds: { ...api.workspace.worlds, cli },
  },
})

contextBridge.exposeInMainWorld('worldsC3Fixture', {
  scenario,
  environment: { sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true },
  recordObservation(value: unknown) {
    const record = exactRecord(value, value && typeof value === 'object' && (value as { type?: unknown }).type === 'navigation-request'
      ? ['type', 'navigationId', 'trusted']
      : ['type', 'navigationId', 'page', 'destinationVisible'])
    if (record.type === 'navigation-request') {
      if (typeof record.navigationId !== 'string' || !/^navigation-[1-9][0-9]{0,5}$/.test(record.navigationId)
        || record.trusted !== true) throw new Error('Invalid navigation request observation.')
    } else if (record.type === 'navigation-complete') {
      if (typeof record.navigationId !== 'string' || !/^navigation-[1-9][0-9]{0,5}$/.test(record.navigationId)
        || record.page !== 'generate' || record.destinationVisible !== true) throw new Error('Invalid navigation completion observation.')
    } else throw new Error('Unsupported renderer observation.')
    ipcRenderer.send('worldsC3Fixture:observe', record)
  },
})
