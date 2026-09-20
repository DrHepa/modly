import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { assertPrivateDataPath } from './api-endpoint'

export interface AppSettings {
  modelsDir:        string
  workspaceDir:     string
  workflowsDir:     string
  extensionsDir:    string
  dependenciesDir:  string
  hfToken?:         string
}

function validateIsolatedSettings(settings: AppSettings, userData: string): AppSettings {
  if (process.env['MODLY_ISOLATED_DEV'] === '1') {
    for (const key of ['modelsDir', 'workspaceDir', 'workflowsDir', 'extensionsDir', 'dependenciesDir'] as const) {
      assertPrivateDataPath(settings[key], userData)
    }
  }
  return settings
}

function settingsPath(userData: string): string {
  return join(userData, 'settings.json')
}

export function getSettings(userData: string): AppSettings {
  const defaults: AppSettings = {
    modelsDir:        join(userData, 'models'),
    workspaceDir:     join(userData, 'workspace'),
    workflowsDir:     join(userData, 'workflows'),
    extensionsDir:    join(userData, 'extensions'),
    dependenciesDir:  join(userData, 'dependencies'),
  }

  const file = settingsPath(userData)
  if (!existsSync(file)) return validateIsolatedSettings(defaults, userData)

  try {
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
    // Migrate legacy outputsDir key
    if (saved['outputsDir'] && !saved['workspaceDir']) {
      saved['workspaceDir'] = saved['outputsDir']
      delete saved['outputsDir']
    }
    return validateIsolatedSettings({ ...defaults, ...saved }, userData)
  } catch {
    return validateIsolatedSettings(defaults, userData)
  }
}

export function setSettings(userData: string, patch: Partial<AppSettings>): AppSettings {
  const updated = validateIsolatedSettings({ ...getSettings(userData), ...patch }, userData)
  writeFileSync(settingsPath(userData), JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
