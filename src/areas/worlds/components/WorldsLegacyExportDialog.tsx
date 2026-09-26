import { useEffect, useMemo, useRef, useState } from 'react'

import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import {
  analyzeLegacyWorldsSceneExport,
  exportLegacyWorldsSceneManifest,
} from '../core/legacySceneManifestAdapter.ts'
import {
  createDefaultWorldsSceneManifestPath,
  parseWorldsSceneManifest,
} from '../worldsSceneManifest.ts'
import { createLegacyExportPlan, groupLegacyExportLosses } from './worldsLegacyExportModel.ts'

export interface WorldsLegacyExportDialogProps {
  open: boolean
  snapshot: WorldProjectSnapshotV1 | null
  sceneId: string | null
  onClose(): void
  onStatus(message: string): void
  onError(message: string): void
}

export function WorldsLegacyExportDialog({
  open,
  snapshot,
  sceneId,
  onClose,
  onStatus,
  onError,
}: WorldsLegacyExportDialogProps): JSX.Element | null {
  const analysis = useMemo(
    () => snapshot ? analyzeLegacyWorldsSceneExport(snapshot, sceneId ? { sceneId } : {}) : null,
    [sceneId, snapshot],
  )
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set())
  const [writing, setWriting] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open) setAccepted(new Set())
  }, [open, sceneId, snapshot])

  useEffect(() => {
    if (!open || !analysis) return
    const dialog = dialogRef.current
    if (!dialog) return
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    queueMicrotask(() => dialog.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus())
    return () => {
      if (dialog.open) dialog.close()
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [analysis, open])

  if (!open || !analysis) return null
  const groups = groupLegacyExportLosses(analysis.losses)
  const plan = createLegacyExportPlan(analysis, accepted)

  const exportManifest = async () => {
    if (!snapshot || !plan) return
    setWriting(true)
    try {
      const exported = exportLegacyWorldsSceneManifest(snapshot, plan)
      if (!exported.success) throw new Error(exported.issues[0]?.message ?? 'Legacy export is incomplete.')
      const reparsed = parseWorldsSceneManifest(exported.manifest)
      if (!reparsed.success) throw new Error(reparsed.error)
      const workspacePath = createDefaultWorldsSceneManifestPath()
      const result = await window.electron.workspace.worlds.writeSceneManifest({
        workspacePath,
        manifest: reparsed.manifest,
      })
      if (!result.success) throw new Error(result.error)
      onStatus(`Exported ${result.workspacePath}`)
      onClose()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Legacy export failed.')
    } finally {
      setWriting(false)
    }
  }

  return (
    <dialog ref={dialogRef} aria-modal="true" aria-labelledby="worlds-legacy-export-heading" className="worlds-dialog" onCancel={(event) => { event.preventDefault(); onClose() }}>
      <div className="worlds-dialog__surface">
        <header className="worlds-dialog__header">
          <div>
            <h2 id="worlds-legacy-export-heading">Legacy export</h2>
            <p>Accept every listed loss before export.</p>
          </div>
          <Tooltip content="Close legacy export">
            <button type="button" className="worlds-icon-button" aria-label="Close legacy export" onClick={onClose}>×</button>
          </Tooltip>
        </header>
        <div className="worlds-dialog__body">
          {!analysis.valid || analysis.issues.length > 0 ? (
            <p role="alert" className="worlds-inline-error">{analysis.issues[0]?.message ?? 'This scene cannot be exported.'}</p>
          ) : groups.length === 0 ? (
            <p className="worlds-muted">No compatibility losses.</p>
          ) : groups.map((group) => (
            <section key={group.code} className="worlds-loss-group" aria-label={`${group.code} losses`}>
              <h3>{formatLossCode(group.code)}</h3>
              {group.losses.map((loss) => (
                <label key={loss.id} className="worlds-loss-row">
                  <input
                    type="checkbox"
                    checked={accepted.has(loss.id)}
                    onChange={(event) => setAccepted((current) => {
                      const next = new Set(current)
                      if (event.currentTarget.checked) next.add(loss.id)
                      else next.delete(loss.id)
                      return next
                    })}
                  />
                  <span><strong>{loss.path}</strong>{loss.message}</span>
                </label>
              ))}
            </section>
          ))}
        </div>
        <footer className="worlds-dialog__footer">
          <button type="button" className="worlds-button" onClick={onClose}>Cancel</button>
          <button type="button" className="worlds-button worlds-button--primary" disabled={!plan || writing} onClick={() => { void exportManifest() }}>
            {writing ? 'Exporting…' : 'Export'}
          </button>
        </footer>
      </div>
    </dialog>
  )
}

function formatLossCode(code: string): string {
  return code.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

export default WorldsLegacyExportDialog
