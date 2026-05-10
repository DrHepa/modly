import type { ViewMode } from '../models'
import { resolveAnimationToggleState } from './viewerAnimation'
export type { ViewMode }

interface ViewerToolbarProps {
  viewMode: ViewMode
  autoRotate: boolean
  animationPlaying: boolean
  hasAnimations: boolean
  hasRig: boolean
  onViewMode: (mode: ViewMode) => void
  onAutoRotate: () => void
  onAnimationToggle: () => void
  onScreenshot: () => void
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

export function ViewerToolbar({
  viewMode,
  autoRotate,
  animationPlaying,
  hasAnimations,
  hasRig,
  onViewMode,
  onAutoRotate,
  onAnimationToggle,
  onScreenshot,
}: ViewerToolbarProps): JSX.Element {
  const animationState = resolveAnimationToggleState({ hasAnimations, animationPlaying })

  return (
    <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-1 bg-zinc-900/75 border border-zinc-700/50 backdrop-blur-sm rounded-2xl p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.24)]">
      {MODES.map(({ mode, icon, label, requiresRig }) => {
        const disabled = Boolean(requiresRig && !hasRig)
        const effectiveLabel = disabled ? `${label} (rig only)` : label

        return (
        <ToolbarButton
          key={mode}
          active={viewMode === mode}
          label={effectiveLabel}
          disabled={disabled}
          onClick={() => onViewMode(mode)}
        >
          {icon}
        </ToolbarButton>
        )
      })}

      <div className="my-1 border-t border-zinc-700/50" />

      <ToolbarButton
        active={autoRotate}
        label="Auto-rotate"
        onClick={onAutoRotate}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </ToolbarButton>

      <ToolbarButton
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
      </ToolbarButton>

      <ToolbarButton
        active={false}
        label="Screenshot"
        onClick={onScreenshot}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </ToolbarButton>
    </div>
  )
}

interface ToolbarButtonProps {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
  ariaPressed?: boolean
  disabled?: boolean
}

function ToolbarButton({ active, label, onClick, children, ariaPressed, disabled = false }: ToolbarButtonProps): JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      aria-pressed={ariaPressed}
      disabled={disabled}
      onClick={onClick}
      className={`
        relative w-8 h-8 flex items-center justify-center rounded-lg transition-colors
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
