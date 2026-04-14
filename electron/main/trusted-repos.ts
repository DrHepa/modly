import { net } from 'electron'

const REGISTRY_URL = 'https://raw.githubusercontent.com/liightnig125/modly-official-extension/main/registry.json'
const REGISTRY_TTL = 5 * 60 * 1000 // 5 minutes

let registryCache: { repos: Set<string>; fetchedAt: number } | null = null

export async function fetchTrustedRepos(): Promise<Set<string>> {
  const now = Date.now()
  if (registryCache && now - registryCache.fetchedAt < REGISTRY_TTL) {
    return registryCache.repos
  }

  try {
    const res = await net.fetch(REGISTRY_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json() as { trusted_repos?: string[] }
    const repos = new Set(
      (data.trusted_repos ?? []).map((repo: string) => repo.toLowerCase().replace(/\/$/, '')),
    )

    registryCache = { repos, fetchedAt: now }
    return repos
  } catch {
    // Offline or fetch failed — keep previous cache, or empty
    return registryCache?.repos ?? new Set()
  }
}
