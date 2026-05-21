import { resolveLandmarkGuideRenderPoints, type LandmarksGuideModel, type LandmarksNodePrimaryAction } from '../landmarkGuideModel'
import guideCharacterSrc from '../../../assets/landmarks/guide-character.webp'

const GUIDE_CHARACTER_SRC = guideCharacterSrc

function resolveConnectorStyle(anchor: { x: number; y: number }, badge: { x: number; y: number }) {
  const dx = badge.x - anchor.x
  const dy = badge.y - anchor.y
  return {
    left: `${anchor.x}%`,
    top: `${anchor.y}%`,
    width: `${Math.hypot(dx, dy)}%`,
    transform: `rotate(${Math.atan2(dy, dx)}rad)`,
  }
}

export type LandmarksNodeGuideProps = {
  guide: LandmarksGuideModel
  primaryAction?: LandmarksNodePrimaryAction
  onPrimaryAction?: () => void
}

export function LandmarksNodeGuide({ guide, primaryAction, onPrimaryAction }: LandmarksNodeGuideProps) {
  return (
    <div className="px-3 pb-3 pt-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-[9px] uppercase tracking-[0.18em] text-emerald-300 font-semibold">Landmarks guide</p>
          <p className="mt-0.5 text-[10px] text-zinc-500 leading-relaxed">Pick the 5 required landmarks on the paused mesh checkpoint.</p>
        </div>
        <div className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold text-emerald-200" aria-label={`Landmark progress ${guide.progressLabel}`}>
          {guide.progressLabel}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/70 px-2 py-2 shadow-inner" data-asset-source="Clean character reference">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(16,185,129,0.14),transparent_58%)]" aria-hidden="true" />
        <div className="relative mx-auto h-36 max-w-[156px] rounded-lg border border-white/5 bg-zinc-900/45" aria-label="Landmark positions">
          <img
            src={GUIDE_CHARACTER_SRC}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-36 w-auto max-w-none select-none object-contain opacity-90 drop-shadow-[0_14px_26px_rgba(0,0,0,0.55)]"
          />
          {guide.items.map((item) => {
            const { anchor, badge } = resolveLandmarkGuideRenderPoints(item)
            return (
              <span key={item.id}>
                <span
                  aria-hidden="true"
                  style={resolveConnectorStyle(anchor, badge)}
                  className="absolute h-px origin-left bg-zinc-200/35"
                />
                <span
                  aria-hidden="true"
                  style={{ left: `${anchor.x}%`, top: `${anchor.y}%`, backgroundColor: item.color }}
                  className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-zinc-950/80 shadow-[0_0_8px_rgba(255,255,255,0.22)]"
                />
                <span
                  aria-label={`${item.token} ${item.label} ${item.completed ? 'marked' : 'pending'}`}
                  title={`${item.token} ${item.label}`}
                  className={`absolute flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border px-1 text-[8px] font-black shadow-lg transition-colors ${item.completed ? 'border-white/80 text-zinc-950' : 'border-zinc-500/70 bg-zinc-950/85 text-zinc-200'}`}
                  style={{
                    left: `${badge.x}%`,
                    top: `${badge.y}%`,
                    backgroundColor: item.completed ? item.color : 'rgba(24,24,27,0.88)',
                    boxShadow: item.completed ? `0 0 14px ${item.color}66` : undefined,
                  }}
                >
                  {item.token}
                </span>
              </span>
            )
          })}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1" aria-label="Landmark legend">
        {guide.items.map((item) => (
          <div key={item.id} className="flex items-center gap-1.5 rounded-md border border-zinc-800/70 bg-zinc-950/40 px-1.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: item.color }} aria-hidden="true" />
            <span className="text-[9px] font-bold text-zinc-300">{item.token}</span>
            <span className="min-w-0 truncate text-[9px] text-zinc-500">{item.label}</span>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[10px] text-zinc-400 leading-relaxed">{guide.instruction}</p>
      <p className="mt-1 text-[9px] text-zinc-600 leading-relaxed">Use Generate / 3D viewer controls to clear or re-mark points.</p>

      {primaryAction && (
        <button
          type="button"
          onClick={onPrimaryAction}
          disabled={primaryAction.disabled}
          className="mt-2 w-full rounded-md border border-amber-400/30 bg-amber-400/15 px-2.5 py-1.5 text-[10px] font-semibold text-amber-200 transition-colors hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {primaryAction.label}
        </button>
      )}
    </div>
  )
}

export { GUIDE_CHARACTER_SRC }
