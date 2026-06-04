import { RigTargetBrowser, type RigTargetBrowserSelection } from './RigTargetBrowser.tsx'
import type { RigBoneId, RigSkeletonSummary } from '../rigSkeleton.ts'
import type { RigRenamePlan, RigRenameValidationResult } from '../rigRenamePlan.ts'
import type { RigEffectiveNamingResult } from '../rigEffectiveNaming.ts'

type RigEditorHumanoidReviewStateKind = 'trusted' | 'draft' | 'promoted' | 'stale' | 'diagnostics-only'

type RigEditorHumanoidPromotionSaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; sidecarWorkspacePath: string }
  | { status: 'error'; message: string }

type RigEditorHumanoidReviewPresentation = {
  state: RigEditorHumanoidReviewStateKind
  headline: string
  canPromote: boolean
  diagnostics: string[]
}

export interface RigEditorHumanoidReviewProps {
  presentation: RigEditorHumanoidReviewPresentation
  saveState: RigEditorHumanoidPromotionSaveState
  onPromote: () => void
}

export interface RigEditorPanelProps {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  renamePlan: RigRenamePlan
  effectiveNaming?: RigEffectiveNamingResult
  humanoidReview?: RigEditorHumanoidReviewProps
  validation: RigRenameValidationResult
  /** The caller must authorise source-backed writes, including persisted removals. */
  canSaveAliases?: boolean
  aliasesDirty?: boolean
  saveState?: 'idle' | 'saving' | 'saved' | 'error'
  saveError?: string
  loadState?: 'idle' | 'loading' | 'loaded' | 'error'
  loadError?: string
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
  humanoidReview,
  validation,
  hydrationWarning,
  canSaveAliases = false,
  aliasesDirty = false,
  saveState = 'idle',
  saveError,
  loadState = 'idle',
  loadError,
  onSelectBone,
  onAliasChange,
  onCancelAlias,
  onRevertAliases,
  onSaveAliases,
}: RigEditorPanelProps): JSX.Element {
  if (!summary?.hasRig) {
    return <RigEditorEmptyState />
  }

  const busy = saveState === 'saving' || loadState === 'loading'
  const canSave = canSaveAliases && aliasesDirty && validation.valid && !busy
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

      {loadState === 'loading' ? <p role="status">Loading saved aliases…</p> : null}
      {saveState === 'saving' ? <p role="status">Saving aliases…</p> : null}
      {saveState === 'saved' ? <p role="status">Aliases saved.</p> : null}
      {saveState === 'error' ? <p role="alert" className="text-xs text-red-200">{saveError || 'Aliases could not be saved. Try again.'}</p> : null}
      {loadState === 'error' ? <p role="alert" className="text-xs text-red-200">{loadError || 'Saved aliases could not be loaded.'}</p> : null}

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
            busy={busy}
            canSave={canSave}
            humanoidReview={humanoidReview}
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
  busy,
  canSave,
  humanoidReview,
  onAliasChange,
  onCancelAlias,
  onRevertAliases,
  onSaveAliases,
}: {
  selected: RigTargetBrowserSelection
  renamePlan: RigRenamePlan
  validation: RigRenameValidationResult
  pendingAliasCount: number
  busy: boolean
  canSave: boolean
  humanoidReview?: RigEditorHumanoidReviewProps
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
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          value={renamePlan.aliases[selected.boneId]?.alias ?? selected.displayName}
          disabled={busy}
          aria-invalid={validation.errors.some((error) => error.boneId === selected.boneId)}
          onChange={(event) => { if (!busy) onAliasChange(selected.boneId, event.currentTarget.value) }}
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
          className="rounded-lg border border-zinc-700 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:opacity-50"
          title={`Cancel alias for ${selected.displayName}`}
          onClick={() => { if (!busy && renamePlan.aliases[selected.boneId]) onCancelAlias(selected.boneId) }}
          disabled={busy || !renamePlan.aliases[selected.boneId]}
        >
          Cancel alias
        </button>
        <button
          type="button"
          className="rounded-lg border border-zinc-700 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:opacity-50"
          title="Revert all rig aliases"
          onClick={() => { if (!busy && pendingAliasCount > 0) onRevertAliases() }}
          disabled={busy || pendingAliasCount === 0}
        >
          Revert all rig aliases
        </button>
        <button
          type="button"
          className="rounded-lg border border-zinc-700 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:opacity-50"
          title="Save rig aliases"
          onClick={() => { if (canSave) onSaveAliases() }}
          disabled={!canSave}
        >
          Save rig aliases
        </button>
        {humanoidReview?.presentation.canPromote ? (
          <button
            type="button"
            title="Promote humanoid draft"
            onClick={humanoidReview.onPromote}
            disabled={humanoidReview.saveState.status === 'saving'}
          >
            {humanoidReview.saveState.status === 'saving' ? 'Promoting humanoid draft…' : 'Promote humanoid draft'}
          </button>
        ) : null}
      </div>

      {humanoidReview?.saveState.status === 'saved' ? <p className="text-xs text-emerald-300">Promotion saved: {humanoidReview.saveState.sidecarWorkspacePath}</p> : null}
      {humanoidReview?.saveState.status === 'error' ? <p className="text-xs text-red-300">{humanoidReview.saveState.message}</p> : null}
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
