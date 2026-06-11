import type { ReactNode } from 'react'

export type ViewerTransformMode = 'translate' | 'rotate' | 'scale' | null

export interface ViewerTransformToolbarProps {
  mode: ViewerTransformMode
  onModeChange: (mode: ViewerTransformMode) => void
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex items-center justify-center w-7 h-7 rounded-lg border transition-colors
        ${active
          ? 'bg-zinc-700 border-zinc-600 text-zinc-200'
          : 'bg-zinc-800 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
        }`}
    >
      {children}
    </button>
  )
}

export default function ViewerTransformToolbar({
  mode,
  onModeChange,
}: ViewerTransformToolbarProps): JSX.Element {
  const toggleMode = (nextMode: Exclude<ViewerTransformMode, null>) => {
    onModeChange(mode === nextMode ? null : nextMode)
  }

  return (
    <>
      <ToolButton
        label="Move"
        active={mode === 'translate'}
        onClick={() => toggleMode('translate')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <polyline points="5 9 2 12 5 15" />
          <polyline points="9 5 12 2 15 5" />
          <polyline points="15 19 12 22 9 19" />
          <polyline points="19 9 22 12 19 15" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <line x1="12" y1="2" x2="12" y2="22" />
        </svg>
      </ToolButton>
      <ToolButton
        label="Rotate"
        active={mode === 'rotate'}
        onClick={() => toggleMode('rotate')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M21 2v6h-6" />
          <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
        </svg>
      </ToolButton>
      <ToolButton
        label="Scale"
        active={mode === 'scale'}
        onClick={() => toggleMode('scale')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M15 3h6v6" />
          <path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" />
          <path d="M3 21l7-7" />
        </svg>
      </ToolButton>
    </>
  )
}
