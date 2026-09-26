import type { WorldCommand } from '../core/worldCommands.ts'
import type { WorldGraphicsProfile, WorldProjectSnapshotV1 } from '../core/worldModel.ts'

export type WorldGraphicsProfileChoice =
  | { kind: 'profile'; profileId: string }
  | { kind: 'preset'; preset: 'integrated' | 'dedicated' }

const WORLD_GRAPHICS_PRESETS = Object.freeze({
  integrated: { name: 'Integrated', renderScale: 0.75, shadowQuality: 'off', antialiasing: 'fxaa' },
  dedicated: { name: 'Dedicated', renderScale: 1, shadowQuality: 'high', antialiasing: 'msaa' },
} satisfies Record<'integrated' | 'dedicated', Omit<WorldGraphicsProfile, 'id'>>)

export function buildWorldGraphicsProfileSelectionCommands(
  snapshot: WorldProjectSnapshotV1,
  choice: WorldGraphicsProfileChoice,
): WorldCommand[] {
  if (choice.kind === 'profile') {
    if (snapshot.project.activeGraphicsProfileId === choice.profileId) return []
    if (!snapshot.project.graphicsProfiles.some((profile) => profile.id === choice.profileId)) {
      throw new Error(`Graphics profile ${choice.profileId} does not exist.`)
    }
    return [{
      type: 'replace-graphics-profiles',
      graphicsProfiles: structuredClone(snapshot.project.graphicsProfiles),
      activeGraphicsProfileId: choice.profileId,
    }]
  }

  const preset = WORLD_GRAPHICS_PRESETS[choice.preset]
  const matching = snapshot.project.graphicsProfiles.find((profile) => isPresetProfile(profile, preset))
  if (matching) {
    if (snapshot.project.activeGraphicsProfileId === matching.id) return []
    return [{
      type: 'replace-graphics-profiles',
      graphicsProfiles: structuredClone(snapshot.project.graphicsProfiles),
      activeGraphicsProfileId: matching.id,
    }]
  }

  const profile: WorldGraphicsProfile = {
    id: allocateGraphicsProfileId(snapshot, `graphics:${choice.preset}`),
    ...preset,
  }
  return [{
    type: 'replace-graphics-profiles',
    graphicsProfiles: [...structuredClone(snapshot.project.graphicsProfiles), profile],
    activeGraphicsProfileId: profile.id,
  }]
}

export function getWorldGraphicsPresetProfiles(): Record<'integrated' | 'dedicated', Omit<WorldGraphicsProfile, 'id'>> {
  return structuredClone(WORLD_GRAPHICS_PRESETS)
}

function isPresetProfile(profile: WorldGraphicsProfile, preset: Omit<WorldGraphicsProfile, 'id'>): boolean {
  return profile.name === preset.name
    && profile.renderScale === preset.renderScale
    && profile.shadowQuality === preset.shadowQuality
    && profile.antialiasing === preset.antialiasing
}

function allocateGraphicsProfileId(snapshot: WorldProjectSnapshotV1, baseId: string): string {
  const used = collectSnapshotIds(snapshot)
  if (!used.has(baseId)) return baseId
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${baseId}-${index}`
    if (!used.has(candidate)) return candidate
  }
  throw new Error(`Unable to allocate a unique ${baseId} graphics profile id.`)
}

function collectSnapshotIds(snapshot: WorldProjectSnapshotV1): Set<string> {
  const ids = new Set<string>([
    snapshot.project.projectId,
    snapshot.project.startSceneId,
    snapshot.project.activeGraphicsProfileId,
  ])
  for (const resource of snapshot.project.resources) ids.add(resource.id)
  for (const scene of snapshot.scenes) {
    ids.add(scene.sceneId)
    for (const entity of scene.entities) {
      ids.add(entity.id)
      for (const component of entity.components) ids.add(component.id)
    }
    for (const sequence of scene.sequences) {
      ids.add(sequence.id)
      for (const track of sequence.tracks) {
        ids.add(track.id)
        for (const keyframe of track.keyframes) ids.add(keyframe.id)
      }
    }
  }
  for (const action of snapshot.project.inputActions) ids.add(action.id)
  for (const profile of snapshot.project.graphicsProfiles) ids.add(profile.id)
  return ids
}
