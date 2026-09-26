import {
  assertWorldAiSnapshot, parseWorldAiProposal, validateWorldAiCommands,
  worldAiBodyComponent, worldAiCameraComponent, worldAiColliderComponent, worldAiLightComponent,
  WORLD_AI_COMMAND_BYTES, WorldAiContractError,
  type WorldAiReference, type WorldAiProposal,
} from './worldAiContract.ts'
import { applyWorldCommandBatch, canonicalWorldCommandBatchPayload, type WorldCommand, type WorldCommandBatchV1 } from './worldCommands.ts'
import type { WorldModelResource, WorldProjectSnapshotV1 } from './worldModel.ts'
import {
  buildAddCameraCommands, buildAddLightCommands, buildAddModelEntityCommands, buildAddSceneCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from '../editor/worldEditorCommandBuilders.ts'
import { buildAddEmptyEntityCommands } from '../editor/worldAuthoringModel.ts'

/** Resolved host-only source evidence. This is never an AI DTO. */
export interface WorldAiResolvedResource { workspacePath: string; format: WorldModelResource['format'] }
export interface WorldAiCreationObservations {
  resources: ReadonlyMap<string, WorldAiResolvedResource>
  assertObserved(kind: 'entity' | 'component', id: string, entityId?: string): void
}
interface LocalBinding { kind: 'scene' | 'entity' | 'component'; id: string; sceneId?: string; entityId?: string }

/** Compile exactly once at the host from one captured revision; do not recompile on Apply. */
export function compileWorldAiProposal(
  snapshot: WorldProjectSnapshotV1, value: unknown, observations: WorldAiCreationObservations,
): { proposal: WorldAiProposal; batch: WorldCommandBatchV1; candidate: WorldProjectSnapshotV1; resourceHandles: string[] } {
  const proposal = parseWorldAiProposal(value)
  const { context } = proposal
  assertWorldAiSnapshot(snapshot, context)
  let draft = structuredClone(snapshot)
  const locals = new Map<string, LocalBinding>()
  const commands: WorldCommand[] = []
  const resources = new Set<string>()
  const generated = createDeterministicWorldEditorIdentityGenerator(JSON.stringify(context))
  const identities = {
    nextId: generated.nextId,
    nextSceneDocumentKey(hint: string) {
      const used = new Set(draft.project.scenes.map((reference) => reference.documentPath))
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const key = generated.nextSceneDocumentKey(hint)
        if (!used.has(`Worlds/${context.projectKey}/scenes/scene-${key}.world-scene.json`)) return key
      }
      reject('Scene document identity allocation failed.')
    },
  }
  const bind = (name: string | undefined, binding: LocalBinding) => {
    if (!name) return
    if (locals.has(name)) reject('A local reference is defined more than once.')
    locals.set(name, binding)
  }
  const resolveRef = (ref: WorldAiReference, kind: LocalBinding['kind'], sceneId?: string, entityId?: string): string => {
    if (ref.kind === 'local') {
      const binding = locals.get(ref.localRef)
      if (!binding || binding.kind !== kind || (sceneId && binding.sceneId !== sceneId) || (entityId && binding.entityId !== entityId)) reject('Unknown, forward, or incompatible local reference.')
      return binding.id
    }
    if (kind === 'scene') {
      if (ref.id !== context.activeSceneId) reject('Only the captured existing active scene is writable.')
      return ref.id
    }
    const scene = snapshot.scenes.find((entry) => entry.sceneId === sceneId)
    const owner = scene?.entities.find((entry) => kind === 'entity' ? entry.id === ref.id : entry.id === entityId && entry.components.some((component) => component.id === ref.id))
    if (!owner) reject('The existing reference has the wrong owner or scene.')
    observations.assertObserved(kind, ref.id, kind === 'component' ? owner.id : undefined)
    return ref.id
  }
  const makeBatch = (): WorldCommandBatchV1 => ({ schema: 'modly.world-command-batch.v1', transactionId: context.requestId,
    projectId: context.projectId, baseRevision: context.baseRevision, origin: 'ai', commands: structuredClone(commands) })
  const append = (next: readonly WorldCommand[]) => {
    commands.push(...next)
    const batch = makeBatch()
    if (commands.length > 16 || new TextEncoder().encode(canonicalWorldCommandBatchPayload(batch)).length > WORLD_AI_COMMAND_BYTES) reject('The expanded canonical batch exceeds its command or byte limits.')
    const applied = applyWorldCommandBatch(snapshot, batch)
    if (!applied.success) reject('The canonical creation plan is invalid or locked.')
    draft = structuredClone(applied.snapshot)
    // Planning only: all published commands still run once from the original revision.
    draft.project.revision = context.baseRevision
  }
  const nextComponentId = (hint: string) => {
    const used = new Set<string>()
    const collect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'id' || key === 'projectId' || key === 'sceneId') && typeof child === 'string') used.add(child)
        else if (typeof child === 'object') collect(child)
      }
    }
    collect(draft)
    for (let attempt = 0; attempt < 32; attempt += 1) { const id = identities.nextId('component', `${hint}:${attempt}`); if (!used.has(id)) return id }
    reject('Component identity allocation failed.')
  }
  for (const recipe of proposal.commands) {
    if (recipe.type === 'patch-entity' || recipe.type === 'replace-component') {
      observations.assertObserved('entity', recipe.entityId)
      if (recipe.type === 'replace-component') observations.assertObserved('component', recipe.componentId, recipe.entityId)
      // Preserve historical Light edits against captured, not previously modified, current values.
      append(validateWorldAiCommands(snapshot, context, [recipe])); continue
    }
    if (recipe.type === 'create-scene') {
      const next = buildAddSceneCommands({ snapshot: draft, projectKey: context.projectKey, identities }, { name: recipe.name })
      bind(recipe.localRef, { kind: 'scene', id: next[0].scene.sceneId })
      append(next); continue
    }
    if (recipe.type === 'set-active-scene-environment') {
      const active = draft.scenes.find((entry) => entry.sceneId === context.activeSceneId)
      if (!active) reject('The captured active scene no longer exists.')
      append([{ type: 'set-scene-environment', sceneId: context.activeSceneId,
        environment: { ...active.environment, ...recipe.environment } }]); continue
    }
    const sceneId = resolveRef(recipe.sceneRef, 'scene')
    const builder = { snapshot: draft, projectKey: context.projectKey, activeSceneId: sceneId, identities }
    if (recipe.type === 'create-entity') {
      const parentId = recipe.parentRef ? resolveRef(recipe.parentRef, 'entity', sceneId) : null
      let next: WorldCommand[]
      if (recipe.kind === 'group') {
        next = buildAddEmptyEntityCommands(builder, { name: recipe.name, parentId })
      } else if (recipe.kind === 'observed-model') {
        const resource = observations.resources.get(recipe.resourceHandle)
        if (!resource) reject('The resource was not observed in this request.')
        resources.add(recipe.resourceHandle)
        next = buildAddModelEntityCommands(builder, { ...resource, name: recipe.name, parentId, ...(recipe.transform ? { transform: recipe.transform } : {}) })
      } else if (recipe.kind === 'camera') {
        next = buildAddCameraCommands(builder, { name: recipe.name, ...(recipe.transform ? { transform: recipe.transform } : {}) })
      } else {
        next = buildAddLightCommands(builder, { name: recipe.name, lightKind: recipe.light.lightKind, ...(recipe.transform ? { transform: recipe.transform } : {}) })
      }
      const added = next.find((entry): entry is Extract<WorldCommand, { type: 'add-entity' }> => entry.type === 'add-entity')!
      added.entity.parentId = parentId
      if (recipe.transform) added.entity.transform = structuredClone(recipe.transform)
      if (recipe.kind === 'camera') {
        const current = added.entity.components[0]
        added.entity.components = [{ ...worldAiCameraComponent(current.id, recipe.camera ?? {}), primary: current.type === 'camera' && current.primary }]
      } else if (recipe.kind === 'light') added.entity.components = [worldAiLightComponent(added.entity.components[0].id, recipe.light)]
      else if (recipe.kind === 'observed-model' && recipe.material) {
        const renderable = added.entity.components[0]
        if (renderable.type !== 'renderable') reject('The observed model did not produce a Renderable.')
        renderable.material = structuredClone(recipe.material)
      }
      bind(recipe.localRef, { kind: 'entity', id: added.entity.id, sceneId })
      append(next); continue
    }
    const entityId = resolveRef(recipe.entityRef, 'entity', sceneId)
    if (recipe.type === 'reparent') {
      const parentId = recipe.parentRef ? resolveRef(recipe.parentRef, 'entity', sceneId) : null
      append([{ type: 'reparent-entity', sceneId, entityId, parentId }]); continue
    }
    const entity = draft.scenes.find((entry) => entry.sceneId === sceneId)!.entities.find((entry) => entry.id === entityId)!
    const componentId = recipe.componentRef ? resolveRef(recipe.componentRef, 'component', sceneId, entityId) : nextComponentId(`${recipe.type}:${entityId}`)
    const current = recipe.componentRef ? entity.components.find((component) => component.id === componentId) : undefined
    const expectedType = recipe.type === 'configure-collider' ? 'collider' : 'rigid-body'
    if (recipe.componentRef && (!current || current.type !== expectedType
      || (current.type === 'collider' && (current.purpose !== 'simulation' || !['box', 'sphere', 'capsule'].includes(current.shape))))) reject('The existing component is not an admitted primitive or body.')
    const component = recipe.type === 'configure-collider' ? worldAiColliderComponent(componentId, recipe.collider) : worldAiBodyComponent(componentId, recipe.body)
    if (current) component.enabled = current.enabled
    bind(recipe.localRef, { kind: 'component', id: componentId, sceneId, entityId })
    append([current ? { type: 'replace-component', sceneId, entityId, componentId, component } : { type: 'add-component', sceneId, entityId, component }])
  }
  const batch = makeBatch()
  const result = applyWorldCommandBatch(snapshot, batch)
  if (!result.success) reject('The canonical creation plan is invalid.')
  return { proposal, batch, candidate: result.snapshot, resourceHandles: [...resources] }
}
function reject(message: string): never { throw new WorldAiContractError('invalid_command', message) }
