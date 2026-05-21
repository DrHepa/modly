import { RigTargetBrowser, type RigTargetBrowserSelection } from './RigTargetBrowser.tsx'
import type { RigBoneId, RigSkeletonSummary } from '../rigSkeleton.ts'
import type { RigRenamePlan, RigRenameValidationResult } from '../rigRenamePlan.ts'
import type { RigEffectiveNamingResult } from '../rigEffectiveNaming.ts'

export interface RigEditorPanelProps {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  renamePlan: RigRenamePlan
  effectiveNaming?: RigEffectiveNamingResult
  validation: RigRenameValidationResult
  hydrationWarning?: {
    status: 'warning'
    messages: readonly string[]
  } | null
  onSelectBone: (boneId: RigBoneId) => void
  onAliasChange: (boneId: RigBoneId, alias: string) => void
  onCancelAlias: (boneId: RigBoneId) => void
  onRevertAliases: () => void
  onSaveAliases: () => void
}

export function RigEditorPanel({
  summary,
  selectedBoneId,
  renamePlan,
  effectiveNaming,
  validation,
  hydrationWarning,
  onSelectBone,
  onAliasChange,
  onCancelAlias,
  onRevertAliases,
  onSaveAliases,
}: RigEditorPanelProps): JSX.Element {
  if (!summary?.hasRig) {
    return <RigEditorEmptyState />
  }

  const pendingAliasCount = Object.keys(renamePlan.aliases).length

  return (
    <aside aria-label="Rig Editor panel" className="flex max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 text-sm text-zinc-200 shadow-2xl shadow-black/40">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-violet-300">Rig Editor</p>
        <h2 className="text-lg font-semibold text-white">Rig Editor</h2>
        <p className="text-xs text-zinc-400">
          {summary.stats.boneCount === 1 ? '1 bone' : `${summary.stats.boneCount} bones`} · {summary.stats.skinnedMeshCount} skinned mesh
        </p>
      </header>

      {summary.warnings.length > 0 ? (
        <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
          {summary.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      ) : null}

      {hydrationWarning?.messages.length ? (
        <div role="status" className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
          <p className="font-medium text-amber-50">Saved aliases could not be loaded, but the rig is still usable.</p>
          {hydrationWarning.messages.map((message) => <p key={message}>{message}</p>)}
        </div>
      ) : null}

      <RigTargetBrowser
        summary={summary}
        selectedBoneId={selectedBoneId}
        effectiveNaming={effectiveNaming}
        onSelectBone={onSelectBone}
        actions={(selected) => (
          <RigAliasActions
            selected={selected}
            renamePlan={renamePlan}
            validation={validation}
            pendingAliasCount={pendingAliasCount}
            onAliasChange={onAliasChange}
            onCancelAlias={onCancelAlias}
            onRevertAliases={onRevertAliases}
            onSaveAliases={onSaveAliases}
          />
        )}
      />
    </aside>
  )
}

function RigAliasActions({
  selected,
  renamePlan,
  validation,
  pendingAliasCount,
  onAliasChange,
  onCancelAlias,
  onRevertAliases,
  onSaveAliases,
}: {
  selected: RigTargetBrowserSelection
  renamePlan: RigRenamePlan
  validation: RigRenameValidationResult
  pendingAliasCount: number
  onAliasChange: (boneId: RigBoneId, alias: string) => void
  onCancelAlias: (boneId: RigBoneId) => void
  onRevertAliases: () => void
  onSaveAliases: () => void
}): JSX.Element {
  return (
    <>
      <label className="block text-xs font-medium text-zinc-300">
        Safe alias
        <input
          aria-label={`Alias for ${selected.displayName}`}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          value={renamePlan.aliases[selected.boneId]?.alias ?? selected.displayName}
          onChange={(event) => onAliasChange(selected.boneId, event.currentTarget.value)}
        />
      </label>

      {validation.errors.length > 0 ? (
        <div role="alert" className="space-y-1 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-100">
          {validation.errors.map((error) => <p key={`${error.boneId}:${error.code}:${error.message}`}>{error.message}</p>)}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          title={`Cancel alias for ${selected.displayName}`}
          onClick={() => onCancelAlias(selected.boneId)}
          disabled={!renamePlan.aliases[selected.boneId]}
        >
          Cancel alias
        </button>
        <button
          type="button"
          title="Revert all rig aliases"
          onClick={onRevertAliases}
          disabled={pendingAliasCount === 0}
        >
          Revert all rig aliases
        </button>
        <button
          type="button"
          title="Save rig aliases"
          onClick={onSaveAliases}
          disabled={!validation.valid || pendingAliasCount === 0}
        >
          Save rig aliases
        </button>
      </div>
    </>
  )
}

function RigEditorEmptyState(): JSX.Element {
  return (
    <aside aria-label="Rig Editor empty state" className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 text-sm text-zinc-300">
      <h2 className="text-lg font-semibold text-white">No rig detected</h2>
      <p>This model does not expose skeleton bones yet.</p>
      <p>Try a rigged character GLB to inspect bones and plan safe aliases.</p>
    </aside>
  )
}
