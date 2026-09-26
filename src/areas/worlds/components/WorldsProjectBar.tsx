import type { WorldGraphicsProfile, WorldSceneReference } from '../core/worldModel.ts'
import type { WorldGraphicsProfileChoice } from '../editor/worldGraphicsProfileCommands.ts'
import type { WorldPlayState } from '../core/worldSessions.ts'
import type { WorldProjectReadySummary, WorldProjectSummary } from '../../../shared/types/worldProjects.ts'
import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import type { WorldsWorkbenchDock } from '../editor/worldsUiStore.ts'

export interface WorldsProjectBarProps {
  projects: readonly WorldProjectSummary[]
  projectKey: string | null
  projectPickerKey: string
  scenes: readonly WorldSceneReference[]
  activeSceneId: string | null
  saveStatus: 'saved' | 'saving' | 'conflict' | 'error'
  canUndo: boolean
  canRedo: boolean
  selectionCount: number
  busy: boolean
  playState: WorldPlayState
  canPlay: boolean
  graphicsProfiles: readonly WorldGraphicsProfile[]
  activeGraphicsProfileId: string | null
  graphicsProfilePending: boolean
  graphicsUnavailable: boolean
  onGraphicsProfileChoice(choice: WorldGraphicsProfileChoice): void
  onProjectPickerKey(key: string): void
  onOpenProject(): void
  onNewProject(): void
  onScene(sceneId: string): void
  onAddScene(): void
  onUndo(): void
  onRedo(): void
  onDuplicate(): void
  onDelete(): void
  onLegacyExport(): void
  onRecoverConflict(): void
  onPlayIntent(): void
  onPlay(): void
  onPause(): void
  onResume(): void
  onStop(): void
  onDock(dock: WorldsWorkbenchDock, trigger: HTMLButtonElement): void
}

export function WorldsProjectBar({
  projects,
  projectKey,
  projectPickerKey,
  scenes,
  activeSceneId,
  saveStatus,
  canUndo,
  canRedo,
  selectionCount,
  busy,
  playState,
  canPlay,
  graphicsProfiles,
  activeGraphicsProfileId,
  graphicsProfilePending,
  graphicsUnavailable,
  onGraphicsProfileChoice,
  onProjectPickerKey,
  onOpenProject,
  onNewProject,
  onScene,
  onAddScene,
  onUndo,
  onRedo,
  onDuplicate,
  onDelete,
  onLegacyExport,
  onRecoverConflict,
  onPlayIntent,
  onPlay,
  onPause,
  onResume,
  onStop,
  onDock,
}: WorldsProjectBarProps): JSX.Element {
  const readyProjects = projects.filter((project): project is WorldProjectReadySummary => project.status === 'ready')
  return (
    <header className="worlds-project-bar" aria-label="World project controls">
      <div className="worlds-project-bar__group worlds-project-bar__project">
        <label className="worlds-visually-hidden" htmlFor="worlds-project-picker">Project</label>
        <select
          id="worlds-project-picker"
          aria-label="World project"
          value={projectPickerKey}
          disabled={busy || readyProjects.length === 0}
          onChange={(event) => onProjectPickerKey(event.currentTarget.value)}
        >
          {readyProjects.length === 0 ? <option value="">No projects</option> : null}
          {readyProjects.map((project) => <option key={project.projectKey} value={project.projectKey}>{project.name}</option>)}
        </select>
        <Tooltip content="Open selected World project">
          <button type="button" className="worlds-compact-button" aria-label="Open selected World project" disabled={busy || !projectPickerKey || projectPickerKey === projectKey} onClick={onOpenProject}>
            <span aria-hidden="true">↗</span><span className="worlds-action-label">Open</span>
          </button>
        </Tooltip>
        <Tooltip content="Create a World project">
          <button type="button" className="worlds-icon-button" aria-label="New World project" disabled={busy} onClick={onNewProject}>＋</button>
        </Tooltip>
      </div>

      <div className="worlds-project-bar__divider" aria-hidden="true" />
      <div className="worlds-project-bar__group worlds-project-bar__scene">
        <label className="worlds-visually-hidden" htmlFor="worlds-scene-picker">Scene</label>
        <select id="worlds-scene-picker" aria-label="Active scene" value={activeSceneId ?? ''} disabled={busy || scenes.length === 0} onChange={(event) => onScene(event.currentTarget.value)}>
          {scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
        </select>
        <Tooltip content="Add scene">
          <button type="button" className="worlds-icon-button" aria-label="Add scene" disabled={busy || !projectKey} onClick={onAddScene}>＋</button>
        </Tooltip>
      </div>

      <div className="worlds-project-bar__divider" aria-hidden="true" />
      <div className="worlds-project-bar__group worlds-project-bar__quality" role="group" aria-label="Rendering quality">
        <label htmlFor="worlds-quality-picker">Quality</label>
        <Tooltip content="Choose an editor and Play rendering profile">
          <select
            id="worlds-quality-picker"
            aria-label="Rendering quality"
            value={activeGraphicsProfileId ? `profile:${activeGraphicsProfileId}` : ''}
            aria-busy={graphicsProfilePending ? 'true' : undefined}
            disabled={busy || graphicsProfilePending || graphicsUnavailable || playState !== 'edit' || graphicsProfiles.length === 0}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value.startsWith('profile:')) onGraphicsProfileChoice({ kind: 'profile', profileId: value.slice('profile:'.length) })
              else if (value === 'preset:integrated') onGraphicsProfileChoice({ kind: 'preset', preset: 'integrated' })
              else if (value === 'preset:dedicated') onGraphicsProfileChoice({ kind: 'preset', preset: 'dedicated' })
            }}
          >
            {graphicsProfiles.map((profile) => <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>)}
            <option value="preset:integrated">Integrated preset</option>
            <option value="preset:dedicated">Dedicated preset</option>
          </select>
        </Tooltip>
      </div>

      <div className="worlds-project-bar__divider" aria-hidden="true" />
      <div className="worlds-project-bar__group worlds-play-controls" role="group" aria-label="Play controls">
        {playState === 'edit' ? (
          <Tooltip content="Play">
            <button type="button" className="worlds-icon-button worlds-play-button" aria-label="Play World" disabled={busy || graphicsProfilePending || graphicsUnavailable || !canPlay} onPointerDown={onPlayIntent} onClick={onPlay}>▶</button>
          </Tooltip>
        ) : null}
        {playState === 'playing' ? (
          <Tooltip content="Pause">
            <button type="button" className="worlds-icon-button" aria-label="Pause World" onClick={onPause}>Ⅱ</button>
          </Tooltip>
        ) : null}
        {playState === 'paused' ? (
          <Tooltip content="Resume">
            <button type="button" className="worlds-icon-button worlds-play-button" aria-label="Resume World" onClick={onResume}>▶</button>
          </Tooltip>
        ) : null}
        {playState !== 'edit' ? (
          <Tooltip content="Stop">
            <button type="button" className="worlds-icon-button" aria-label="Stop World" disabled={playState === 'stopping'} onClick={onStop}>■</button>
          </Tooltip>
        ) : null}
      </div>

      <div className="worlds-project-bar__divider" aria-hidden="true" />
      <div className="worlds-project-bar__group">
        <Tooltip content="Undo last edit">
          <button type="button" className="worlds-icon-button" aria-label="Undo" disabled={busy || !canUndo} onClick={onUndo}>↶</button>
        </Tooltip>
        <Tooltip content="Redo last edit">
          <button type="button" className="worlds-icon-button" aria-label="Redo" disabled={busy || !canRedo} onClick={onRedo}>↷</button>
        </Tooltip>
        <Tooltip content="Duplicate selection">
          <button type="button" className="worlds-icon-button" aria-label="Duplicate selected entities" disabled={busy || selectionCount === 0} onClick={onDuplicate}>⧉</button>
        </Tooltip>
        <Tooltip content="Delete selection">
          <button type="button" className="worlds-icon-button" aria-label="Delete selected entities" disabled={busy || selectionCount === 0} onClick={onDelete}>⌫</button>
        </Tooltip>
        <Tooltip content="Export the active scene for legacy Worlds">
          <button type="button" className="worlds-compact-button" aria-label="Export active scene for legacy Worlds" disabled={busy || !projectKey} onClick={onLegacyExport}>
            <span aria-hidden="true">⇩</span><span className="worlds-action-label">Legacy</span>
          </button>
        </Tooltip>
      </div>

      <div className="worlds-project-bar__spacer" />
      <span className={`worlds-save-state is-${saveStatus}`} role="status" aria-live="polite">
        {saveStatus === 'saving' ? 'Saving' : saveStatus === 'conflict' ? 'Conflict' : saveStatus === 'error' ? 'Error' : 'Saved'}
      </span>
      {saveStatus === 'conflict' ? (
        <Tooltip content="Refresh the project after a revision conflict">
          <button type="button" className="worlds-icon-button" aria-label="Refresh conflicted World project" disabled={busy} onClick={onRecoverConflict}>↻</button>
        </Tooltip>
      ) : null}
      <div className="worlds-project-bar__group worlds-project-bar__dock-toggles" aria-label="Editor docks">
        <Tooltip content="Scene dock"><button type="button" className="worlds-icon-button" aria-label="Toggle Scene dock" disabled={busy} onClick={(event) => onDock('scene', event.currentTarget)}>☷</button></Tooltip>
        <Tooltip content="Assets dock"><button type="button" className="worlds-icon-button" aria-label="Toggle Assets dock" disabled={busy} onClick={(event) => onDock('assets', event.currentTarget)}>⬡</button></Tooltip>
        <Tooltip content="Inspector dock"><button type="button" className="worlds-icon-button" aria-label="Toggle Inspector dock" disabled={busy} onClick={(event) => onDock('inspector', event.currentTarget)}>⚙</button></Tooltip>
      </div>
    </header>
  )
}

export default WorldsProjectBar
