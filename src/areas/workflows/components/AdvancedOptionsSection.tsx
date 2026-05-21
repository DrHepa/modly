import { Children, type ReactNode, useId, useState } from 'react'

interface AdvancedOptionsSectionProps {
  children?: ReactNode
}

export function AdvancedOptionsSection({ children }: AdvancedOptionsSectionProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()

  if (Children.count(children) === 0) return null

  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/35">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-zinc-800/40"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">Advanced Options</span>
          <span className="text-[10px] font-medium text-zinc-600">Fine tune only when you need more control.</span>
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`shrink-0 text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded ? (
        <div id={contentId} className="flex flex-col gap-2 border-t border-zinc-800/70 px-3 py-3">
          {children}
        </div>
      ) : null}
    </section>
  )
}

export default AdvancedOptionsSection
