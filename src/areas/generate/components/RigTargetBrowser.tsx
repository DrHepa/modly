import type { ReactNode } from 'react'

import type { RigBoneId, RigBoneNode, RigSkeletonSummary } from '../rigSkeleton.ts'
import type { RigEffectiveNameProvenance, RigEffectiveNamingResult } from '../rigEffectiveNaming.ts'

export interface RigTargetBrowserSelection {
  bone: RigBoneNode
  boneId: RigBoneId
  displayName: string
  provenance: RigEffectiveNameProvenance
}

export interface RigTargetBrowserProps {
  summary: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  effectiveNaming?: RigEffectiveNamingResult
  onSelectBone: (boneId: RigBoneId) => void
  actions?: (selected: RigTargetBrowserSelection) => ReactNode
}

export function RigTargetBrowser({
  summary,
  selectedBoneId,
  effectiveNaming,
  onSelectBone,
  actions,
}: RigTargetBrowserProps): JSX.Element | null {
  const selectedBone = summary.bones.find((bone) => bone.boneId === selectedBoneId) ?? summary.bones[0]
  const selected = selectedBone
    ? {
      bone: selectedBone,
      boneId: selectedBone.boneId,
      displayName: resolveBoneDisplayName(selectedBone, effectiveNaming),
      provenance: resolveBoneProvenance(selectedBone, effectiveNaming),
    }
    : undefined

  return (
    <>
      {selected ? (
        <section aria-label="Selected bone details" className="shrink-0 space-y-3 rounded-xl border border-violet-400/30 bg-violet-950/20 p-3 shadow-inner shadow-violet-950/20">
          <div>
            <h3 className="text-sm font-medium text-white">Selected bone</h3>
            <p className="text-base text-zinc-100">Selected: {selected.displayName}</p>
            <p className="text-xs text-zinc-300">Name source: {formatNameProvenance(selected.provenance)}</p>
            <p className="text-xs text-zinc-300">Parent: {resolveParentLabel(summary.bones, selected.bone, effectiveNaming)}</p>
            <p className="text-xs text-zinc-300">Children ({selected.bone.childIds.length}): {resolveChildrenLabel(summary.bones, selected.bone, effectiveNaming)}</p>
            <p className="text-xs text-zinc-400">Path: {resolvePathLabel(summary.bones, selected.bone, effectiveNaming)}</p>
            <p className="text-xs text-zinc-400">Original name: {selected.bone.originalName || 'Unnamed bone'}</p>
          </div>

          {actions ? actions(selected) : null}
        </section>
      ) : null}

      <section aria-label="Rig bone hierarchy" className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-zinc-100">Bone hierarchy</h3>
            <p className="text-xs text-zinc-500">Scroll to browse all {summary.stats.boneCount} bones.</p>
          </div>
        </div>
        <div aria-label="Scrollable rig bone hierarchy" tabIndex={0} className="max-h-80 overflow-y-auto pr-1 focus:outline-none focus:ring-2 focus:ring-violet-400/60">
          <ul role="tree" className="space-y-1">
            {summary.rootBoneIds.map((rootBoneId) => (
              <RigBoneTreeItem
                key={rootBoneId}
                boneId={rootBoneId}
                bones={summary.bones}
                selectedBoneId={selected?.boneId}
                effectiveNaming={effectiveNaming}
                onSelectBone={onSelectBone}
              />
            ))}
          </ul>
        </div>
      </section>
    </>
  )
}

function resolveParentLabel(bones: RigBoneNode[], selectedBone: RigBoneNode, effectiveNaming?: RigEffectiveNamingResult): string {
  if (!selectedBone.parentId) return 'None — root bone'
  const parent = bones.find((bone) => bone.boneId === selectedBone.parentId)
  return parent ? resolveBoneDisplayName(parent, effectiveNaming) : 'Unknown parent'
}

function resolveChildrenLabel(bones: RigBoneNode[], selectedBone: RigBoneNode, effectiveNaming?: RigEffectiveNamingResult): string {
  if (selectedBone.childIds.length === 0) return 'None'
  return selectedBone.childIds
    .map((childId) => {
      const child = bones.find((bone) => bone.boneId === childId)
      return child ? resolveBoneDisplayName(child, effectiveNaming) : 'Unknown child'
    })
    .join(', ')
}

function resolvePathLabel(bones: RigBoneNode[], selectedBone: RigBoneNode, effectiveNaming?: RigEffectiveNamingResult): string {
  const labels: string[] = []
  let current: RigBoneNode | undefined = selectedBone

  while (current) {
    labels.unshift(resolveBoneDisplayName(current, effectiveNaming))
    current = current.parentId ? bones.find((bone) => bone.boneId === current?.parentId) : undefined
  }

  return labels.length > 0 ? labels.join(' / ') : selectedBone.path.join(' / ')
}

function resolveBoneDisplayName(bone: RigBoneNode, effectiveNaming?: RigEffectiveNamingResult): string {
  return effectiveNaming?.byBoneId[bone.boneId]?.label ?? bone.label
}

function resolveBoneProvenance(bone: RigBoneNode, effectiveNaming?: RigEffectiveNamingResult): RigEffectiveNameProvenance {
  return effectiveNaming?.byBoneId[bone.boneId]?.provenance ?? 'raw'
}

function formatNameProvenance(provenance: RigEffectiveNameProvenance): string {
  return provenance === 'unirig' ? 'UniRig' : provenance
}

function RigBoneTreeItem({
  boneId,
  bones,
  selectedBoneId,
  effectiveNaming,
  onSelectBone,
}: {
  boneId: RigBoneId
  bones: RigBoneNode[]
  selectedBoneId?: RigBoneId
  effectiveNaming?: RigEffectiveNamingResult
  onSelectBone: (boneId: RigBoneId) => void
}): JSX.Element | null {
  const bone = bones.find((candidate) => candidate.boneId === boneId)
  if (!bone) return null

  const isSelected = selectedBoneId === bone.boneId
  const displayName = resolveBoneDisplayName(bone, effectiveNaming)

  return (
    <li role="treeitem" aria-selected={isSelected}>
      <button
        type="button"
        aria-label={`Select bone ${displayName}`}
        aria-selected={isSelected}
        aria-pressed={isSelected}
        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left transition ${isSelected ? 'border border-violet-400/50 bg-violet-500/20 text-violet-50 shadow-sm shadow-violet-950/40' : 'text-zinc-300 hover:bg-zinc-800/80 hover:text-white'}`}
        onClick={() => onSelectBone(bone.boneId)}
      >
        <span>{displayName}</span>
        {isSelected ? <span className="rounded-full bg-violet-400/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-violet-100">Selected</span> : null}
      </button>
      {bone.childIds.length > 0 ? (
        <ul role="group" className="ml-4 mt-1 space-y-1 border-l border-zinc-800 pl-2">
          {bone.childIds.map((childId) => (
            <RigBoneTreeItem
              key={childId}
              boneId={childId}
              bones={bones}
              selectedBoneId={selectedBoneId}
              effectiveNaming={effectiveNaming}
              onSelectBone={onSelectBone}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
