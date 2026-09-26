import type {
  LegacyWorldsExportAnalysis,
  LegacyWorldsExportLoss,
} from '../core/legacySceneManifestAdapter.ts'

export interface LegacyExportLossGroup {
  code: LegacyWorldsExportLoss['code']
  losses: LegacyWorldsExportLoss[]
}

export function groupLegacyExportLosses(losses: readonly LegacyWorldsExportLoss[]): LegacyExportLossGroup[] {
  const groups = new Map<LegacyWorldsExportLoss['code'], LegacyWorldsExportLoss[]>()
  for (const loss of losses) {
    const values = groups.get(loss.code) ?? []
    values.push(loss)
    groups.set(loss.code, values)
  }
  return [...groups].map(([code, values]) => ({ code, losses: values }))
}

export function createLegacyExportPlan(
  analysis: LegacyWorldsExportAnalysis,
  acceptedLossIds: ReadonlySet<string>,
  options: { rejected?: boolean } = {},
): { sceneId: string; acceptedLosses: string[] } | null {
  if (options.rejected || !analysis.valid || !analysis.sceneId || analysis.issues.length > 0) return null
  if (analysis.losses.some((loss) => !acceptedLossIds.has(loss.id))) return null
  return { sceneId: analysis.sceneId, acceptedLosses: analysis.losses.map((loss) => loss.id) }
}
