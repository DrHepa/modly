import type { RigBoneId, RigSelectionOverlayViewModel } from '../rigSkeleton.ts'
import type { CSSProperties } from 'react'

export interface RigOverlayProps {
  overlay: RigSelectionOverlayViewModel | null
  onSelectBone: (boneId: RigBoneId) => void
}

const SELECTED_MARKER_STYLE: CSSProperties = {
  backgroundColor: 'rgba(34, 211, 238, 0.14)',
  color: '#cffafe',
  transform: 'none',
  opacity: 1,
  zIndex: 1,
  boxShadow: 'none',
}

const RELATED_MARKER_STYLE: CSSProperties = {
  backgroundColor: 'rgba(24, 24, 27, 0.72)',
  transform: 'none',
  opacity: 0.72,
  zIndex: 1,
}

const SELECTED_CONNECTION_STYLE: CSSProperties = {
  color: '#67e8f9',
  fontWeight: 700,
  opacity: 1,
  textShadow: '0 0 14px rgba(34, 211, 238, 0.75)',
}

const RELATED_CONNECTION_STYLE: CSSProperties = {
  color: '#a1a1aa',
  opacity: 0.55,
}

/**
 * View-only React overlay rendered outside the Three/GLTF scene graph.
 * It is not added to exportable scene data and exposes no transform/save/export controls.
 */
export function RigOverlay({ overlay, onSelectBone }: RigOverlayProps): JSX.Element | null {
  if (!overlay) return null

  return (
    <aside aria-label="Rig selection overlay" className="pointer-events-auto rounded-2xl border border-violet-400/40 bg-zinc-950/85 p-3 text-xs text-zinc-100 shadow-xl backdrop-blur-sm">
      <p className="font-medium text-violet-100">Selected bone: {overlay.selectedLabel}</p>
      <div className="mt-3 flex flex-wrap gap-2" aria-label="Highlighted rig bones">
        {overlay.highlightedBoneIds.map((boneId) => {
          const markerTone = boneId === overlay.selectedBoneId ? 'selected' : 'related'
          return (
            <button
              key={boneId}
              type="button"
              aria-label={`Select highlighted bone ${resolveMarkerLabel(overlay, boneId)}`}
              aria-current={markerTone === 'selected' ? 'true' : undefined}
              data-rig-highlight={markerTone}
              data-rig-visual-tone={markerTone === 'selected' ? 'selected-informational' : 'related-muted'}
              style={markerTone === 'selected' ? SELECTED_MARKER_STYLE : RELATED_MARKER_STYLE}
              className={markerTone === 'selected'
                ? 'relative inline-flex items-center gap-1 rounded-full border border-cyan-400/50 px-2.5 py-1 text-xs font-semibold transition-colors'
                : 'relative rounded-full border border-zinc-700/70 px-2.5 py-1 text-zinc-300 transition-opacity hover:border-violet-300/60 hover:text-white hover:opacity-90'}
              onClick={() => onSelectBone(boneId)}
            >
              <span>{resolveMarkerLabel(overlay, boneId)}</span>
            </button>
          )
        })}
      </div>
      <ul className="mt-3 space-y-1" aria-label="Immediate rig connections">
        {overlay.connections.map((connection, index) => (
          <li
            key={`${connection.fromBoneId}->${connection.toBoneId}`}
            data-rig-connection-highlight={connection.relation === 'parent' ? 'selected' : 'related'}
            data-rig-visual-tone={connection.relation === 'parent' ? 'selected-connection-dominant' : 'related-connection-muted'}
            style={connection.relation === 'parent' ? SELECTED_CONNECTION_STYLE : RELATED_CONNECTION_STYLE}
            className={connection.relation === 'parent' ? 'rounded-md bg-cyan-400/10 px-2 py-1 text-cyan-100' : 'px-2 py-0.5 text-zinc-400'}
          >
            {connection.relation === 'parent' ? 'Parent connection' : `Child connection ${resolveChildConnectionIndex(overlay, connection.toBoneId, index)}`}
          </li>
        ))}
      </ul>
    </aside>
  )
}

function resolveMarkerLabel(overlay: RigSelectionOverlayViewModel, boneId: RigBoneId): string {
  if (boneId === overlay.selectedBoneId) return overlay.selectedLabel
  if (boneId === overlay.parentBoneId) return 'Parent'
  const childIndex = overlay.childBoneIds.indexOf(boneId)
  if (childIndex >= 0) return `Child ${childIndex + 1}`
  return 'Related bone'
}

function resolveChildConnectionIndex(overlay: RigSelectionOverlayViewModel, boneId: RigBoneId, fallbackIndex: number): number {
  const childIndex = overlay.childBoneIds.indexOf(boneId)
  return childIndex >= 0 ? childIndex + 1 : fallbackIndex + 1
}
