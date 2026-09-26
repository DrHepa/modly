import { useMemo, useRef } from 'react'

import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import type { WorldSceneDocumentV1 } from '../core/worldModel.ts'
import type { WorldTreeMutation } from '../editor/worldsWorkbenchModel.ts'
import {
  createWorldTreeRows,
  isWorldEntityEffectivelyLocked,
  reduceWorldTreeKeyboard,
  selectWorldTreeEntity,
  shouldHandleWorldTreeRowKeyEvent,
} from '../editor/worldsWorkbenchModel.ts'
import { createWorldUiTransactionId } from '../editor/useWorldEditorController.ts'

export interface WorldsSceneDockProps {
  scene: WorldSceneDocumentV1
  selectedEntityIds: readonly string[]
  activeEntityId: string | null
  expandedEntityIds: readonly string[]
  focusedEntityId: string | null
  onSelection(entityIds: string[], activeEntityId: string | null): void
  onExpanded(entityIds: string[]): void
  onFocused(entityId: string | null): void
  onMutation(mutation: WorldTreeMutation): void
  onAddEntity(kind: 'empty' | 'camera' | 'light'): void
}

export function WorldsSceneDock({
  scene,
  selectedEntityIds,
  activeEntityId,
  expandedEntityIds,
  focusedEntityId,
  onSelection,
  onExpanded,
  onFocused,
  onMutation,
  onAddEntity,
}: WorldsSceneDockProps): JSX.Element {
  const expanded = useMemo(() => new Set(expandedEntityIds), [expandedEntityIds])
  const rows = useMemo(() => createWorldTreeRows(scene.entities, expanded), [expanded, scene.entities])
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const active = scene.entities.find((entity) => entity.id === activeEntityId) ?? null
  const moveTargets = useMemo(() => createMoveTargets(scene, selectedEntityIds), [scene, selectedEntityIds])
  const selectionLocked = selectedEntityIds.some((entityId) => isWorldEntityEffectivelyLocked(scene.entities, entityId))

  const focusRow = (entityId: string | null) => {
    onFocused(entityId)
    if (entityId) queueMicrotask(() => rowRefs.current.get(entityId)?.focus())
  }

  return (
    <div className="worlds-dock-panel" aria-label="Scene hierarchy">
      <header className="worlds-dock-header">
        <div><span>Scene</span><small>{scene.entities.length}</small></div>
        <div className="worlds-dock-header__actions">
          <Tooltip content="Add empty">
            <button type="button" className="worlds-icon-button worlds-authoring-action" aria-label="Add empty entity" onClick={() => onAddEntity('empty')}>＋</button>
          </Tooltip>
          <Tooltip content="Add camera">
            <button type="button" className="worlds-icon-button" aria-label="Add camera entity" onClick={() => onAddEntity('camera')}>⌾</button>
          </Tooltip>
          <Tooltip content="Add directional light">
            <button type="button" className="worlds-icon-button" aria-label="Add light entity" onClick={() => onAddEntity('light')}>✦</button>
          </Tooltip>
        </div>
      </header>
      {rows.length === 0 ? (
        <p className="worlds-empty-copy">No entities</p>
      ) : (
        <div role="tree" aria-label="Scene entities" className="worlds-tree">
          {rows.map((row) => {
            const selected = selectedEntityIds.includes(row.id)
            const renderable = row.entity.components.find((component) => component.type === 'renderable')
            const parentLocked = row.entity.parentId ? isWorldEntityEffectivelyLocked(scene.entities, row.entity.parentId) : false
            const actionEntityIds = selected ? selectedEntityIds : [row.id]
            return (
              <div
                key={row.id}
                ref={(element) => {
                  if (element) rowRefs.current.set(row.id, element)
                  else rowRefs.current.delete(row.id)
                }}
                role="treeitem"
                aria-level={row.depth}
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                aria-selected={selected}
                aria-disabled={row.effectiveLocked}
                tabIndex={focusedEntityId === row.id || (!focusedEntityId && rows[0]?.id === row.id) ? 0 : -1}
                className={`worlds-tree-row${selected ? ' is-selected' : ''}${row.effectiveEnabled ? '' : ' is-disabled'}`}
                style={{ paddingInlineStart: `${6 + (row.depth - 1) * 14}px` }}
                draggable={!row.effectiveLocked}
                onDragStart={(event) => event.dataTransfer.setData('application/x-modly-world-entity', row.id)}
                onDragOver={(event) => {
                  if (!row.effectiveLocked) event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const entityId = event.dataTransfer.getData('application/x-modly-world-entity')
                  if (entityId && entityId !== row.id) onMutation({ type: 'move', entityIds: [entityId], parentId: row.id })
                }}
                onClick={(event) => {
                  const selection = selectWorldTreeEntity(selectedEntityIds, row.id, event)
                  onSelection(selection, selection.includes(row.id) ? row.id : selection.at(-1) ?? null)
                  focusRow(row.id)
                }}
                onKeyDown={(event) => {
                  if (!shouldHandleWorldTreeRowKeyEvent(event.target, event.currentTarget)) return
                  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
                  event.preventDefault()
                  const result = reduceWorldTreeKeyboard({ rows, focusedId: row.id, expandedIds: expanded }, event.key)
                  onExpanded([...result.expandedIds])
                  focusRow(result.focusedId)
                  if (result.activateId) {
                    const selection = selectWorldTreeEntity(selectedEntityIds, result.activateId, event)
                    onSelection(selection, selection.includes(result.activateId) ? result.activateId : selection.at(-1) ?? null)
                  }
                }}
              >
                <Tooltip content={row.expanded ? `Collapse ${row.entity.name}` : `Expand ${row.entity.name}`}>
                  <button
                    type="button"
                    className="worlds-tree-disclosure"
                    aria-label={row.expanded ? `Collapse ${row.entity.name}` : `Expand ${row.entity.name}`}
                    disabled={!row.hasChildren}
                    onClick={(event) => {
                      event.stopPropagation()
                      const next = new Set(expanded)
                      if (next.has(row.id)) next.delete(row.id)
                      else next.add(row.id)
                      onExpanded([...next])
                    }}
                  >{row.hasChildren ? (row.expanded ? '▾' : '▸') : '·'}</button>
                </Tooltip>
                <span className="worlds-tree-icon" aria-hidden="true">{entityGlyph(row.entity.components.map((component) => component.type))}</span>
                <span className="worlds-tree-name">{row.entity.name}</span>
                <span className="worlds-tree-actions">
                  <Tooltip content={row.entity.enabled ? 'Disable entity' : 'Enable entity'}>
                    <button
                      type="button"
                      className="worlds-tree-action"
                      aria-label={row.entity.enabled ? `Disable ${row.entity.name}` : `Enable ${row.entity.name}`}
                      disabled={row.effectiveLocked}
                      onClick={(event) => {
                        event.stopPropagation()
                        onMutation({ type: 'set-enabled', entityIds: [row.id], enabled: !row.entity.enabled })
                      }}
                    >{row.entity.enabled ? '◉' : '○'}</button>
                  </Tooltip>
                  {renderable?.type === 'renderable' ? (
                    <Tooltip content={renderable.visible ? 'Hide renderable' : 'Show renderable'}>
                      <button
                        type="button"
                        className="worlds-tree-action"
                        aria-label={renderable.visible ? `Hide ${row.entity.name}` : `Show ${row.entity.name}`}
                        disabled={row.effectiveLocked}
                        onClick={(event) => {
                          event.stopPropagation()
                          onMutation({ type: 'set-visible', entityIds: [row.id], visible: !renderable.visible })
                        }}
                      >{renderable.visible ? '◇' : '◆'}</button>
                    </Tooltip>
                  ) : null}
                  <Tooltip content={row.entity.locked ? 'Unlock entity' : 'Lock entity'}>
                    <button
                      type="button"
                      className="worlds-tree-action"
                      aria-label={row.entity.locked ? `Unlock ${row.entity.name}` : `Lock ${row.entity.name}`}
                      disabled={parentLocked}
                      onClick={(event) => {
                        event.stopPropagation()
                        onMutation({ type: 'set-locked', entityIds: [row.id], locked: !row.entity.locked, allowLocked: row.entity.locked && !parentLocked })
                      }}
                    >{row.effectiveLocked ? '▣' : '□'}</button>
                  </Tooltip>
                  <Tooltip content="Duplicate entity">
                    <button
                      type="button"
                      className="worlds-tree-action"
                      aria-label={`Duplicate ${row.entity.name}`}
                      disabled={selected ? selectionLocked : row.effectiveLocked}
                      onClick={(event) => {
                        event.stopPropagation()
                        onMutation({ type: 'duplicate', entityIds: actionEntityIds, identitiesSeed: createWorldUiTransactionId('tree-duplicate') })
                      }}
                    >⧉</button>
                  </Tooltip>
                  <Tooltip content="Delete entity and children">
                    <button
                      type="button"
                      className="worlds-tree-action"
                      aria-label={`Delete ${row.entity.name} and children`}
                      disabled={selected ? selectionLocked : row.effectiveLocked}
                      onClick={(event) => {
                        event.stopPropagation()
                        onMutation({ type: 'delete', entityIds: actionEntityIds })
                      }}
                    >⌫</button>
                  </Tooltip>
                </span>
              </div>
            )
          })}
        </div>
      )}
      <footer className="worlds-dock-footer">
        <label htmlFor="worlds-move-target">Move to</label>
        <select
          id="worlds-move-target"
          disabled={!active || selectedEntityIds.length === 0 || selectionLocked}
          value={active?.parentId ?? ''}
          onChange={(event) => onMutation({
            type: 'move',
            entityIds: selectedEntityIds,
            parentId: event.currentTarget.value || null,
          })}
        >
          <option value="">Scene root</option>
          {moveTargets.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
        </select>
      </footer>
    </div>
  )
}

function createMoveTargets(scene: WorldSceneDocumentV1, selectedIds: readonly string[]): WorldSceneDocumentV1['entities'] {
  const blocked = new Set(selectedIds)
  let changed = true
  while (changed) {
    changed = false
    for (const entity of scene.entities) {
      if (entity.parentId && blocked.has(entity.parentId) && !blocked.has(entity.id)) {
        blocked.add(entity.id)
        changed = true
      }
    }
  }
  return scene.entities.filter((entity) => !blocked.has(entity.id) && !isWorldEntityEffectivelyLocked(scene.entities, entity.id))
}

function entityGlyph(componentTypes: readonly string[]): string {
  if (componentTypes.includes('camera')) return '⌾'
  if (componentTypes.includes('light')) return '✦'
  if (componentTypes.includes('renderable')) return '⬡'
  return '•'
}

export default WorldsSceneDock
