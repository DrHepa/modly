import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'

export function createRuntimeWorldSnapshot(): WorldProjectSnapshotV1 {
  return {
    project: {
      schema: 'modly.world-project.v1',
      projectId: 'project:runtime',
      name: 'Runtime world',
      revision: 7,
      resources: [
        { id: 'resource:hero', type: 'model', name: 'Hero', workspacePath: 'Assets/hero.glb', format: 'glb' },
        { id: 'resource:walk', type: 'animation', name: 'Walk', workspacePath: 'Assets/hero.glb', sourceWorkspacePath: 'Assets/hero.glb', format: 'gltf-clip', clipName: 'Walk' },
        { id: 'resource:beep', type: 'audio', name: 'Beep', workspacePath: 'Audio/beep.wav', format: 'wav' },
      ],
      scenes: [
        { id: 'scene:one', name: 'Runtime one', documentPath: 'Worlds/runtime/scenes/one.world-scene.json' },
        { id: 'scene:two', name: 'Runtime two', documentPath: 'Worlds/runtime/scenes/two.world-scene.json' },
      ],
      startSceneId: 'scene:one',
      inputActions: [
        {
          id: 'input:move',
          name: 'Move',
          valueType: 'axis2d',
          bindings: [
            { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'x', scale: -1 },
            { kind: 'axis2d', device: 'keyboard', control: 'KeyD', targetAxis: 'x', scale: 1 },
            { kind: 'axis2d', device: 'keyboard', control: 'KeyW', targetAxis: 'y', scale: 1 },
            { kind: 'axis2d', device: 'keyboard', control: 'KeyS', targetAxis: 'y', scale: -1 },
          ],
        },
        { id: 'input:jump', name: 'Jump', valueType: 'button', bindings: [{ kind: 'button', device: 'keyboard', control: 'Space' }] },
      ],
      graphicsProfiles: [{ id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'msaa' }],
      activeGraphicsProfileId: 'graphics:balanced',
    },
    scenes: [
      {
        schema: 'modly.world-scene.v1',
        projectId: 'project:runtime',
        sceneId: 'scene:one',
        name: 'Runtime one',
        environment: { backgroundColor: '#20242b', ambientIntensity: 0.35 },
        entities: [
          {
            id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: ['camera'],
            transform: { position: [0, 2, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
            components: [
              { id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 500, fieldOfView: 60 },
              { id: 'component:listener', type: 'audio-listener', enabled: true, primary: true },
              { id: 'component:beep', type: 'audio-source', enabled: true, resourceId: 'resource:beep', autoplay: false, loop: false, volume: 0.8, spatial: false, maxDistance: 20 },
              {
                id: 'component:camera-behavior', type: 'behavior', enabled: true,
                bindings: [
                  { id: 'binding:start', event: { type: 'start' }, actions: [{ type: 'set-visibility', entityId: 'entity:hero', visible: true }] },
                  { id: 'binding:jump', event: { type: 'input', actionId: 'input:jump', phase: 'pressed' }, actions: [{ type: 'play-audio', entityId: 'entity:camera', componentId: 'component:beep' }] },
                  { id: 'binding:timer', event: { type: 'timer', delaySeconds: 0.5, repeat: true }, actions: [{ type: 'play-animation', entityId: 'entity:hero', componentId: 'component:hero-animation' }] },
                  { id: 'binding:trigger', event: { type: 'trigger-enter', triggerComponentId: 'component:zone-trigger' }, actions: [{ type: 'change-scene', sceneId: 'scene:two' }, { type: 'change-scene', sceneId: 'scene:one' }] },
                ],
              },
            ],
          },
          {
            id: 'entity:hero', name: 'Hero', parentId: null, enabled: true, locked: false, tags: ['player'],
            transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            components: [
              { id: 'component:hero-renderable', type: 'renderable', enabled: true, resourceId: 'resource:hero', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
              { id: 'component:hero-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'capsule', radius: 0.35, halfHeight: 0.55, sensor: false, friction: 0.4, restitution: 0, collisionLayer: 2, collisionMask: 0xffff },
              { id: 'component:hero-body', type: 'rigid-body', enabled: true, bodyType: 'kinematic-position', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: false },
              { id: 'component:hero-controller', type: 'character-controller', enabled: true, colliderComponentId: 'component:hero-collider', moveActionId: 'input:move', jumpActionId: 'input:jump', speed: 5, jumpSpeed: 6, maxSlopeDegrees: 45 },
              { id: 'component:hero-animation', type: 'animation-player', enabled: true, resourceId: 'resource:walk', autoplay: true, loop: true, speed: 1 },
            ],
          },
          {
            id: 'entity:crate', name: 'Crate', parentId: null, enabled: true, locked: false, tags: ['prop'],
            transform: { position: [2, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            components: [
              { id: 'component:crate-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [0.5, 0.5, 0.5], sensor: false, friction: 0.5, restitution: 0.1, collisionLayer: 4, collisionMask: 0xffff },
              { id: 'component:crate-body', type: 'rigid-body', enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0.1, angularDamping: 0.1, canSleep: true },
            ],
          },
          {
            id: 'entity:ground', name: 'Ground', parentId: null, enabled: true, locked: false, tags: ['ground'],
            transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            components: [
              { id: 'component:ground-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [10, 0.5, 10], sensor: false, friction: 0.8, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
            ],
          },
          {
            id: 'entity:zone', name: 'Zone', parentId: null, enabled: true, locked: false, tags: ['zone'],
            transform: { position: [0, 1, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
            components: [
              { id: 'component:zone-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'sphere', radius: 1, sensor: true, friction: 0, restitution: 0, collisionLayer: 8, collisionMask: 2 },
              { id: 'component:zone-trigger', type: 'trigger', enabled: true, colliderComponentId: 'component:zone-collider', once: true, targetTags: ['player'] },
            ],
          },
        ],
        sequences: [],
      },
      {
        schema: 'modly.world-scene.v1', projectId: 'project:runtime', sceneId: 'scene:two', name: 'Runtime two',
        environment: { backgroundColor: '#101114', ambientIntensity: 0.2 },
        entities: [{
          id: 'entity:camera-two', name: 'Camera two', parentId: null, enabled: true, locked: false, tags: ['camera'],
          transform: { position: [0, 3, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
          components: [
            { id: 'component:camera-two', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 500, fieldOfView: 55 },
            { id: 'component:listener-two', type: 'audio-listener', enabled: true, primary: true },
          ],
        }],
        sequences: [],
      },
    ],
  }
}

export function nestRuntimeCameraUnderDisabledParent(snapshot: WorldProjectSnapshotV1): void {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === 'scene:one')
  const camera = scene?.entities.find((entity) => entity.id === 'entity:camera')
  if (!scene || !camera) throw new Error('Runtime camera fixture is unavailable.')
  scene.entities.unshift({
    id: 'entity:disabled-parent',
    name: 'Disabled parent',
    parentId: null,
    enabled: false,
    locked: false,
    tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [],
  })
  camera.parentId = 'entity:disabled-parent'
}
