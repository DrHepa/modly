const WORLD_CAPABILITIES = [
  'HY-World scene manifests',
  'SPZ / Gaussian world exports',
  'PLY world meshes and point clouds',
  'Camera, depth, and trajectory priors'
]

const FOUNDATION_STEPS = [
  'Open generated scene manifests without routing through Generate Viewer3D.',
  'Inspect world assets and provenance from the workspace library.',
  'Add a dedicated world-aware viewer surface inside Worlds before navigation/editing.',
  'Persist future edits as new versioned artifacts, never mutating originals.'
]

export default function WorldsPage(): JSX.Element {
  return (
    <main className="relative flex h-full min-h-0 overflow-hidden bg-[#090a0d] text-zinc-100">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <div className="absolute left-16 top-10 h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute bottom-0 right-20 h-80 w-80 rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/30 to-transparent" />
      </div>

      <section className="relative z-10 flex flex-1 flex-col overflow-hidden p-8">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.34em] text-cyan-300/80">
              World workspace
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
              Worlds
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              A dedicated home for generated worlds, scene manifests, camera priors, and future navigation.
              This surface is intentionally separate from Generate&apos;s Viewer3D path and will own its own world viewer.
            </p>
          </div>

          <div className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-cyan-200">
            Foundation
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] gap-6">
          <div className="flex min-h-0 flex-col rounded-2xl border border-zinc-800/80 bg-zinc-950/70 shadow-2xl shadow-black/30">
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 className="text-sm font-semibold text-zinc-100">World library</h2>
              <p className="mt-1 text-xs text-zinc-500">
                Scene/world discovery will land here first; rendering and navigation come after the contract is explicit.
              </p>
            </div>

            <div className="flex flex-1 items-center justify-center p-8">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-900 text-cyan-200">
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
                    <path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z" />
                    <path d="M4 10h16M4 14h16M12 3.5c2 2.4 3 5.2 3 8.5s-1 6.1-3 8.5M12 3.5c-2 2.4-3 5.2-3 8.5s1 6.1 3 8.5" />
                  </svg>
                </div>
                <h3 className="text-base font-semibold text-zinc-100">No world selected</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500">
                  Next step: connect this tab to workspace assets classified as generated worlds and scene manifests, then render them through a Worlds-owned viewer.
                </p>
              </div>
            </div>
          </div>

          <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/70 p-5">
              <h2 className="text-sm font-semibold text-zinc-100">Initial world inputs</h2>
              <div className="mt-4 space-y-2">
                {WORLD_CAPABILITIES.map((capability) => (
                  <div key={capability} className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-300">
                    {capability}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/70 p-5">
              <h2 className="text-sm font-semibold text-zinc-100">Architecture guardrails</h2>
              <ol className="mt-4 space-y-3">
                {FOUNDATION_STEPS.map((step, index) => (
                  <li key={step} className="flex gap-3 text-sm leading-5 text-zinc-400">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-300/10 text-[11px] font-semibold text-cyan-200">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </section>
          </aside>
        </div>
      </section>
    </main>
  )
}
