import type { ViewMode } from '../models'
import { resolveAnimationToggleState } from './viewerAnimation'
export type { ViewMode }

interface ViewerViewToolbarProps {
  viewMode: ViewMode
  autoRotate: boolean
  animationPlaying: boolean
  hasAnimations: boolean
  hasRig: boolean
  onViewMode: (mode: ViewMode) => void
  onAutoRotate: () => void
  onAnimationToggle: () => void
  onScreenshot: () => void
  showViewModes?: boolean   // view modes are mesh-only; hidden for splats
}

interface ViewerToolbarProps extends ViewerViewToolbarProps {
  sceneEditControls?: ViewerToolbarSceneEditControls
  rigEditorControls?: ViewerToolbarRigEditorControls
  poseClipControls?: ViewerToolbarPoseClipControls
}

interface ViewerEditToolbarProps {
  sceneEditControls?: ViewerToolbarSceneEditControls
  rigEditorControls?: ViewerToolbarRigEditorControls
  poseClipControls?: ViewerToolbarPoseClipControls
}

export interface ViewerToolbarRigEditorControls {
  active: boolean
  summary: {
    hasRig: boolean
    stats: {
      boneCount: number
      skinnedMeshCount: number
    }
    warnings: string[]
  }
  onOpenRigEditor: () => void
}

export interface ViewerToolbarPoseClipControls {
  active: boolean
  summary: ViewerToolbarRigEditorControls['summary']
  onOpenPoseClip: () => void
}

export interface ViewerToolbarSceneEditControls {
  mode: 'available' | 'editing'
  selectedPartLabel?: string
  excludedCount: number
  canSave: boolean
  saving: boolean
  onEditCheckpoint: () => void
  onHideSelected: () => void
  onReset: () => void
  onClear: () => void
  onSave: () => void
}

const MODES: { mode: ViewMode; icon: React.ReactNode; label: string; requiresRig?: boolean }[] = [
  {
    mode: 'solid',
    label: 'Solid',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    mode: 'wireframe',
    label: 'Wireframe',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    ),
  },
  {
    mode: 'normals',
    label: 'Normals',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <line x1="3" y1="12" x2="21" y2="12" />
      </svg>
    ),
  },
  {
    mode: 'matcap',
    label: 'Matcap',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 10 Q10 7 12 10 Q14 13 16 10" />
      </svg>
    ),
  },
  {
    mode: 'uv',
    label: 'UV Checker',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <rect x="3" y="3" width="9" height="9" fill="currentColor" fillOpacity="0.3" />
        <rect x="12" y="12" width="9" height="9" fill="currentColor" fillOpacity="0.3" />
      </svg>
    ),
  },
  {
    mode: 'bones',
    label: 'Rig bones',
    requiresRig: true,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 18L12 12L18 6" />
        <circle cx="6" cy="18" r="1.75" />
        <circle cx="12" cy="12" r="1.75" />
        <circle cx="18" cy="6" r="1.75" />
      </svg>
    ),
  },
  {
    mode: 'joints',
    label: 'Rig joints',
    requiresRig: true,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 4L16 8L12 12L8 8L12 4Z" />
        <path d="M12 12L16 16L12 20L8 16L12 12Z" />
      </svg>
    ),
  },
  {
    mode: 'influence',
    label: 'Bone influence',
    requiresRig: true,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="12" r="2" />
        <circle cx="17" cy="7" r="2" />
        <circle cx="17" cy="17" r="2" />
        <path d="M8.8 11.1L15.2 7.9" />
        <path d="M8.8 12.9L15.2 16.1" />
      </svg>
    ),
  },
]

export function ViewerToolbar(props: ViewerToolbarProps): JSX.Element {
  return (
    <>
      <ViewerViewToolbar {...props} />
      <ViewerEditToolbar sceneEditControls={props.sceneEditControls} rigEditorControls={props.rigEditorControls} poseClipControls={props.poseClipControls} />
    </>
  )
}

export function ViewerViewToolbar({
  viewMode,
  autoRotate,
  animationPlaying,
  hasAnimations,
  hasRig,
  onViewMode,
  onAutoRotate,
  onAnimationToggle,
  onScreenshot,
}: ViewerViewToolbarProps): JSX.Element {
  const animationState = resolveAnimationToggleState({ hasAnimations, animationPlaying })

  return (
    <CanvasToolbar side="left" ariaLabel="Viewer view controls">
      {MODES.map(({ mode, icon, label, requiresRig }) => {
        const disabled = Boolean(requiresRig && !hasRig)
        const effectiveLabel = disabled ? `${label} (rig only)` : label

        return (
        <CanvasToolbarButton
          key={mode}
          active={viewMode === mode}
          label={effectiveLabel}
          ariaPressed={viewMode === mode}
          disabled={disabled}
          onClick={() => onViewMode(mode)}
        >
          {icon}
        </CanvasToolbarButton>
        )
      })}

      <CanvasToolbarSeparator />

      <CanvasToolbarButton
        active={autoRotate}
        label="Auto-rotate"
        ariaPressed={autoRotate}
        onClick={onAutoRotate}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </CanvasToolbarButton>

      <CanvasToolbarButton
        active={animationPlaying && hasAnimations}
        disabled={animationState.disabled}
        label={animationState.label}
        ariaPressed={animationState.pressed}
        onClick={onAnimationToggle}
      >
        {animationPlaying && hasAnimations ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </CanvasToolbarButton>

      <CanvasToolbarButton
        active={false}
        label="Screenshot"
        onClick={onScreenshot}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </CanvasToolbarButton>
    </CanvasToolbar>
  )
}

export function ViewerEditToolbar({ sceneEditControls, rigEditorControls, poseClipControls }: ViewerEditToolbarProps): JSX.Element | null {
  if (!sceneEditControls && !rigEditorControls && !poseClipControls) return null

  return (
    <CanvasToolbar side="right" ariaLabel="Viewer edit controls">
      {sceneEditControls ? (
        <>
          <CanvasToolbarButton
            active={sceneEditControls.mode === 'editing'}
            label="Edit checkpoint"
            ariaPressed={sceneEditControls.mode === 'editing'}
            onClick={sceneEditControls.onEditCheckpoint}
          >
            <span aria-hidden="true">✎</span>
          </CanvasToolbarButton>
          <CanvasToolbarButton
            active={false}
            disabled={!sceneEditControls.selectedPartLabel || sceneEditControls.saving}
            label={sceneEditControls.selectedPartLabel ? `Hide from edited copy: ${sceneEditControls.selectedPartLabel}` : 'Hide from edited copy'}
            onClick={sceneEditControls.onHideSelected}
          >
            <span aria-hidden="true">⊘</span>
          </CanvasToolbarButton>
          <CanvasToolbarButton
            active={false}
            disabled={sceneEditControls.excludedCount === 0 || sceneEditControls.saving}
            label={`Reset edit plan (${sceneEditControls.excludedCount} excluded)`}
            onClick={sceneEditControls.onReset}
          >
            <span aria-hidden="true">↺</span>
          </CanvasToolbarButton>
          <CanvasToolbarButton
            active={false}
            disabled={sceneEditControls.saving}
            label="Clear selection"
            onClick={sceneEditControls.onClear}
          >
            <span aria-hidden="true">×</span>
          </CanvasToolbarButton>
          <CanvasToolbarButton
            active={false}
            disabled={!sceneEditControls.canSave || sceneEditControls.saving}
            label={sceneEditControls.saving ? 'Saving edited copy' : 'Save edited copy'}
            onClick={sceneEditControls.onSave}
          >
            <span aria-hidden="true">⇩</span>
          </CanvasToolbarButton>
          <CanvasToolbarSeparator />
          <CanvasToolbarButton
            active={false}
            label="Advanced Options"
            disabled
            ariaDisabled
            onClick={() => undefined}
          >
            <span aria-hidden="true">⚙</span>
          </CanvasToolbarButton>
        </>
      ) : null}

      {sceneEditControls && (rigEditorControls || poseClipControls) ? <CanvasToolbarSeparator /> : null}

      {rigEditorControls ? <RigEditorToolbarEntry controls={rigEditorControls} /> : null}

      {rigEditorControls && poseClipControls ? <CanvasToolbarSeparator /> : null}

      {poseClipControls ? <PoseClipToolbarEntry controls={poseClipControls} /> : null}
    </CanvasToolbar>
  )
}

function RigEditorToolbarEntry({ controls }: { controls: ViewerToolbarRigEditorControls }): JSX.Element {
  if (!controls.summary.hasRig) {
    return (
      <div className="w-44 px-2 py-1.5 text-xs text-zinc-300" aria-label="Rig Editor empty state">
        <p className="font-medium text-zinc-100">No rig detected</p>
        <p>Load a rigged character to inspect bones and aliases.</p>
      </div>
    )
  }

  const boneCount = controls.summary.stats.boneCount
  const boneLabel = boneCount === 1 ? '1 bone' : `${boneCount} bones`
  const actionLabel = controls.active ? 'Close Rig Editor' : 'Open Rig Editor'

  return (
    <CanvasToolbarButton
      active={controls.active}
      label={`${actionLabel} (${boneLabel})`}
      ariaPressed={controls.active}
      onClick={controls.onOpenRigEditor}
    >
      <span aria-hidden="true">☊</span>
      <span className="sr-only">Rig Editor — {boneLabel}</span>
    </CanvasToolbarButton>
  )
}

function PoseClipToolbarEntry({ controls }: { controls: ViewerToolbarPoseClipControls }): JSX.Element {
  if (!controls.summary.hasRig) {
    return (
      <div className="w-44 px-2 py-1.5 text-xs text-zinc-300" aria-label="Pose/Clip empty state">
        <p className="font-medium text-zinc-100">No rig for Pose/Clip</p>
        <p>Load a rigged character to author pose clips.</p>
      </div>
    )
  }

  const boneCount = controls.summary.stats.boneCount
  const boneLabel = boneCount === 1 ? '1 bone' : `${boneCount} bones`
  const actionLabel = controls.active ? 'Close Pose/Clip' : 'Open Pose/Clip'

  return (
    <CanvasToolbarButton
      active={controls.active}
      label={`${actionLabel} (${boneLabel})`}
      ariaPressed={controls.active}
      onClick={controls.onOpenPoseClip}
    >
      <span aria-hidden="true">◇</span>
      <span className="sr-only">Pose/Clip — {boneLabel}</span>
    </CanvasToolbarButton>
  )
}

interface CanvasToolbarProps {
  side: 'left' | 'right'
  ariaLabel: string
  children: React.ReactNode
}

export function CanvasToolbar({ side, ariaLabel, children }: CanvasToolbarProps): JSX.Element {
  const placement = side === 'left' ? 'left-4' : 'right-4'

  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className={`absolute ${placement} top-1/2 -translate-y-1/2 z-20 flex flex-col gap-1 bg-zinc-900/75 border border-zinc-700/50 backdrop-blur-sm rounded-2xl p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.24)]`}
    >
      {children}
    </div>
  )
}

export function CanvasToolbarSeparator(): JSX.Element {
  return <div role="separator" aria-orientation="horizontal" className="my-1 border-t border-zinc-700/50" />
}

interface CanvasToolbarButtonProps {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
  ariaPressed?: boolean
  ariaDisabled?: boolean
  disabled?: boolean
}

export function CanvasToolbarButton({ active, label, onClick, children, ariaPressed, ariaDisabled, disabled = false }: CanvasToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={ariaPressed}
      aria-disabled={ariaDisabled}
      disabled={disabled}
      onClick={onClick}
      className={`
        relative w-8 h-8 flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950
        ${disabled
          ? 'text-zinc-600 cursor-not-allowed opacity-60'
          : active
          ? 'bg-violet-600 text-white'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60'
        }
      `}
    >
      {children}
    </button>
  )
}
