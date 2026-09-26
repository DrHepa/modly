export interface WorldProjectPickerEntry {
  projectKey: string
  status: string
}

export interface WorldProjectPickerResolutionInput {
  currentPickerKey: string
  currentProjectKey: string | null
  previousProjectKey: string | null
  projects: readonly WorldProjectPickerEntry[]
}

export function resolveWorldProjectPickerKey({
  currentPickerKey,
  currentProjectKey,
  previousProjectKey,
  projects,
}: WorldProjectPickerResolutionInput): string {
  const readyKeys = new Set(
    projects
      .filter((project) => project.status === 'ready')
      .map((project) => project.projectKey),
  )

  if (currentProjectKey !== previousProjectKey && currentProjectKey) {
    return currentProjectKey
  }
  if (readyKeys.has(currentPickerKey)) return currentPickerKey
  if (currentProjectKey && readyKeys.has(currentProjectKey)) return currentProjectKey
  return readyKeys.values().next().value ?? ''
}
