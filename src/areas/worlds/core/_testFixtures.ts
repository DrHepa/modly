import type { WorldProjectSnapshotV1 } from './worldModel.ts'

export function createValidWorldSnapshot(): WorldProjectSnapshotV1 {
  return {
    project: {
      schema: 'modly.world-project.v1',
      projectId: 'project:demo',
      name: 'Demo world',
      revision: 4,
      startSceneId: 'scene:one',
      activeGraphicsProfileId: 'graphics:balanced',
      resources: [
        { id: 'resource:hero', type: 'model', name: 'Hero', workspacePath: 'Assets/hero.glb', format: 'glb' },
      ],
      scenes: [
        { id: 'scene:one', name: 'First scene', documentPath: 'Worlds/demo/scenes/one.world-scene.json' },
        { id: 'scene:two', name: 'Second scene', documentPath: 'Worlds/demo/scenes/two.world-scene.json' },
      ],
      inputActions: [
        { id: 'input:jump', name: 'Jump', valueType: 'button', bindings: [{ kind: 'button', device: 'keyboard', control: 'Space' }] },
      ],
      graphicsProfiles: [
        { id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'msaa' },
      ],
    },
    scenes: [
      {
        schema: 'modly.world-scene.v1',
        projectId: 'project:demo',
        sceneId: 'scene:one',
        name: 'First scene',
        environment: { backgroundColor: '#20242b', ambientIntensity: 0.35 },
        editor: {
          initialView: { position: [8, 5, 12], target: [0, 1, 0], up: [0, 1, 0] },
        },
        entities: [
          {
            id: 'entity:hero',
            name: 'Hero',
            parentId: null,
            enabled: true,
            locked: false,
            tags: [],
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            components: [
              {
                id: 'component:hero-renderable',
                type: 'renderable',
                enabled: true,
                resourceId: 'resource:hero',
                visible: true,
                castShadow: true,
                receiveShadow: true,
                material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
              },
            ],
          },
        ],
        sequences: [],
      },
      {
        schema: 'modly.world-scene.v1',
        projectId: 'project:demo',
        sceneId: 'scene:two',
        name: 'Second scene',
        environment: { backgroundColor: '#101114', ambientIntensity: 0.2 },
        entities: [],
        sequences: [],
      },
    ],
  }
}
