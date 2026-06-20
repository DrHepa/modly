import assert from 'node:assert/strict'
import test from 'node:test'

const { createElectronApi } = await import(new URL('./electron-api.ts', import.meta.url).href)

test('preload workspace artifact registry invokes minimal sidecar IPC channels', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      if (channel === 'workspace:artifact:writeSidecar') {
        return {
          success: true,
          sidecarPath: 'collection/model.glb.artifact.json',
          sidecar: {
            artifactId: 'artifact-1',
            workspacePath: 'collection/model.glb',
            metadata: { author: 'renderer' },
          },
        }
      }
      return {
        success: true,
        sidecar: {
          artifactId: 'artifact-1',
          workspacePath: 'collection/model.glb',
          metadata: { author: 'renderer' },
        },
      }
    },
  })

  const writeResult = await api.workspace.artifacts.writeSidecar({
    workspacePath: 'collection/model.glb',
    artifactId: 'artifact-1',
    metadata: { author: 'renderer' },
  })
  const readResult = await api.workspace.artifacts.readSidecar({ workspacePath: 'collection/model.glb' })

  assert.deepEqual(writeResult, {
    success: true,
    sidecarPath: 'collection/model.glb.artifact.json',
    sidecar: {
      artifactId: 'artifact-1',
      workspacePath: 'collection/model.glb',
      metadata: { author: 'renderer' },
    },
  })
  assert.deepEqual(readResult, {
    success: true,
    sidecar: {
      artifactId: 'artifact-1',
      workspacePath: 'collection/model.glb',
      metadata: { author: 'renderer' },
    },
  })
  assert.deepEqual(invocations, [
    {
      channel: 'workspace:artifact:writeSidecar',
      args: [{ workspacePath: 'collection/model.glb', artifactId: 'artifact-1', metadata: { author: 'renderer' } }],
    },
    {
      channel: 'workspace:artifact:readSidecar',
      args: [{ workspacePath: 'collection/model.glb' }],
    },
  ])
})

test('preload workspace artifact registry invokes edited scene artifact IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return {
        success: true,
        glbWorkspacePath: 'Workflows/edited/source-edited.glb',
        sidecarWorkspacePath: 'Workflows/edited/source-edited.json',
        metadata: { kind: 'scene-edit' },
      }
    },
  })

  const request = {
    glbWorkspacePath: 'Workflows/edited/source-edited.glb',
    sidecarWorkspacePath: 'Workflows/edited/source-edited.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    bytes: new Uint8Array([1, 2, 3]),
    metadata: { kind: 'scene-edit' },
  }
  const result = await api.workspace.artifacts.writeEditedSceneArtifact(request)

  assert.deepEqual(result, {
    success: true,
    glbWorkspacePath: 'Workflows/edited/source-edited.glb',
    sidecarWorkspacePath: 'Workflows/edited/source-edited.json',
    metadata: { kind: 'scene-edit' },
  })
  assert.deepEqual(invocations, [{ channel: 'workspace:artifact:writeEditedSceneArtifact', args: [request] }])
})

test('preload exposes scoped Worlds scene manifest writer IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return { success: true, workspacePath: 'Exports/Worlds/scene-manifest.json' }
    },
  })

  const request = {
    workspacePath: 'Exports/Worlds/scene-manifest.json',
    manifest: { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] },
  } as const
  const result = await api.workspace.worlds.writeSceneManifest(request)

  assert.deepEqual(result, { success: true, workspacePath: 'Exports/Worlds/scene-manifest.json' })
  assert.deepEqual(invocations, [{ channel: 'workspace:worlds:writeSceneManifest', args: [request] }])
})

test('preload workspace artifact registry exposes landmark sidecar writer IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return {
        success: true,
        sidecarWorkspacePath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json',
        sidecar: args[0] && typeof args[0] === 'object' && 'sidecar' in args[0]
          ? (args[0] as { sidecar: unknown }).sidecar
          : undefined,
      }
    },
  })

  const sidecar = {
    schema: 'modly.landmarks',
    version: 1,
    createdAt: '2026-05-17T00:00:00.000Z',
    runId: 'run-1',
    nodeId: 'node-1',
    sidecarPath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json',
    target: { artifactId: 'mesh-artifact-1', versionId: 'mesh-version-1', kind: 'mesh', meshPath: 'Workflows/checkpoints/source.glb' },
    artifacts: { sidecarRole: 'landmarks-sidecar', targetArtifactId: 'mesh-artifact-1', targetVersionId: 'mesh-version-1' },
    landmarks: [
      { id: 'left_shoulder', name: 'Left shoulder', world: { x: 1, y: 2, z: 3 }, confidence: 1, source: 'manual' },
      { id: 'right_shoulder', name: 'Right shoulder', world: { x: 4, y: 5, z: 6 }, confidence: 1, source: 'manual' },
      { id: 'hip', name: 'Hip', world: { x: 7, y: 8, z: 9 }, confidence: 1, source: 'manual' },
      { id: 'left_knee', name: 'Left knee', world: { x: 10, y: 11, z: 12 }, confidence: 1, source: 'manual' },
      { id: 'right_knee', name: 'Right knee', world: { x: 13, y: 14, z: 15 }, confidence: 1, source: 'manual' },
    ],
  } as const
  const request = {
    sidecarWorkspacePath: sidecar.sidecarPath,
    sourceWorkspacePath: sidecar.target.meshPath,
    sidecar,
  }

  const result = await api.workspace.artifacts.writeLandmarkSidecar(request)

  assert.deepEqual(result, { success: true, sidecarWorkspacePath: sidecar.sidecarPath, sidecar })
  assert.deepEqual(invocations, [{ channel: 'workspace:artifact:writeLandmarkSidecar', args: [request] }])
})

test('preload workspace artifact registry exposes pose clip sidecar writer IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return {
        success: true,
        sidecarWorkspacePath: 'Workflows/pose-clips/source-walk.pose-clip.v1.json',
        sidecar: args[0] && typeof args[0] === 'object' && 'sidecar' in args[0]
          ? (args[0] as { sidecar: unknown }).sidecar
          : undefined,
      }
    },
  })

  const sidecar = {
    schema: 'modly.pose-clip',
    version: 1,
    createdAt: '2026-05-20T00:00:00.000Z',
    source: { workspacePath: 'Workflows/checkpoints/source.glb', artifactId: 'mesh-artifact-1', versionId: 'mesh-version-1' },
    skeletonContextId: 'rig:Body|skeleton:0',
    clip: { id: 'walk-cycle', name: 'Walk Cycle', durationSeconds: 2, fps: 30 },
    skeleton: {
      rootBoneIds: ['rig:Body|skeleton:0|bone:Hips#0'],
      boneCount: 1,
      bones: [
        {
          boneId: 'rig:Body|skeleton:0|bone:Hips#0',
          label: 'Hips',
          originalName: 'Hips',
          path: ['Hips'],
        },
      ],
    },
    keyframes: [
      {
        id: 'kf-1',
        timeSeconds: 0,
        boneId: 'rig:Body|skeleton:0|bone:Hips#0',
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ],
  } as const
  const request = {
    sidecarWorkspacePath: 'Workflows/pose-clips/source-walk.pose-clip.v1.json',
    sourceWorkspacePath: sidecar.source.workspacePath,
    sidecar,
  }

  assert.equal(typeof api.workspace.artifacts.writePoseClipSidecar, 'function')
  const result = await api.workspace.artifacts.writePoseClipSidecar(request)

  assert.deepEqual(result, { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar })
  assert.deepEqual(invocations, [{ channel: 'workspace:artifact:writePoseClipSidecar', args: [request] }])
})

test('preload workspace artifact registry exposes pose clip sidecar reader IPC channel and preserves result envelopes', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const foundSidecar = {
    schema: 'modly.pose-clip',
    version: 1,
    createdAt: '2026-05-20T00:00:00.000Z',
    source: { workspacePath: 'Workflows/checkpoints/source.glb' },
    skeletonContextId: 'rig:Body|skeleton:0',
    clip: { id: 'walk-cycle', name: 'Walk Cycle', durationSeconds: 2, fps: 30 },
    skeleton: {
      rootBoneIds: ['rig:Body|skeleton:0|bone:Hips#0'],
      boneCount: 1,
      bones: [{ boneId: 'rig:Body|skeleton:0|bone:Hips#0', label: 'Hips', originalName: 'Hips', path: ['Hips'] }],
    },
    keyframes: [{ id: 'kf-1', timeSeconds: 0, boneId: 'rig:Body|skeleton:0|bone:Hips#0', rotation: { x: 0, y: 0, z: 0, w: 1 } }],
  } as const
  const results = [
    {
      success: true,
      status: 'found',
      sidecarWorkspacePath: 'Workflows/pose-clips/source-walk.pose-clip.v1.json',
      sidecar: foundSidecar,
    },
    {
      success: true,
      status: 'not-found',
      sidecarWorkspacePath: 'Workflows/pose-clips/missing.pose-clip.v1.json',
    },
    {
      success: false,
      status: 'invalid',
      sidecarWorkspacePath: 'Workflows/pose-clips/invalid.pose-clip.v1.json',
      error: 'Invalid pose clip sidecar: invalid_schema',
    },
  ] as const
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return results[invocations.length - 1]
    },
  })

  const foundRequest = {
    sidecarWorkspacePath: 'Workflows/pose-clips/source-walk.pose-clip.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }
  const notFoundRequest = {
    sidecarWorkspacePath: 'Workflows/pose-clips/missing.pose-clip.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }
  const invalidRequest = {
    sidecarWorkspacePath: 'Workflows/pose-clips/invalid.pose-clip.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }

  assert.equal(typeof api.workspace.artifacts.readPoseClipSidecar, 'function')
  const foundResult = await api.workspace.artifacts.readPoseClipSidecar(foundRequest)
  const notFoundResult = await api.workspace.artifacts.readPoseClipSidecar(notFoundRequest)
  const invalidResult = await api.workspace.artifacts.readPoseClipSidecar(invalidRequest)

  assert.deepEqual(foundResult, results[0])
  assert.deepEqual(notFoundResult, results[1])
  assert.deepEqual(invalidResult, results[2])
  assert.deepEqual(invocations, [
    { channel: 'workspace:artifact:readPoseClipSidecar', args: [foundRequest] },
    { channel: 'workspace:artifact:readPoseClipSidecar', args: [notFoundRequest] },
    { channel: 'workspace:artifact:readPoseClipSidecar', args: [invalidRequest] },
  ])
})

test('preload workspace artifact registry exposes motion retarget sidecar writer IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return {
        success: true,
        sidecarWorkspacePath: 'Workflows/motion-retarget/source.motion-retarget.v1.json',
        sidecar: args[0] && typeof args[0] === 'object' && 'sidecar' in args[0]
          ? (args[0] as { sidecar: unknown }).sidecar
          : undefined,
      }
    },
  })

  const sidecar = {
    schema: 'modly.motion-retarget',
    version: 1,
    createdAt: '2026-05-21T00:00:00.000Z',
    source: { workspacePath: 'Workflows/checkpoints/source.glb' },
    artifact: {
      extensionId: 'kimodo-soma-rp',
      nodeId: 'animate-rigged-mesh',
      bundleWorkspacePath: 'Workflows/generated/kimodo/source-motion',
      metadataWorkspacePath: 'Workflows/generated/kimodo/source-motion/metadata.json',
      diagnostics: {
        runtimeStatus: 'ok',
        retargetStatus: 'degraded',
        animationMappingStatus: 'ok',
        stabilizationStatus: 'ok',
        visualQualityStatus: 'warning',
        sourceKind: 'kimodo-motion-bundle',
        mappingConfidence: 'medium',
        retargetErrorCode: null,
        retargetErrorAliases: [],
        retargetErrorMessage: null,
        warnings: ['Root translation is deferred in MVP.'],
        raw: {},
      },
    },
    sourceBones: [{ sourceBoneId: 'source:Hips', label: 'Hips', rawLabel: 'Hips', path: ['Hips'] }],
    session: { selectedPreview: 'preview-glb', mappings: { 'source:Hips': { targetBoneId: 'bone-1' } } },
    warnings: ['Root translation is deferred in MVP.'],
    poseClip: { id: 'walk-cycle', name: 'Walk Cycle', durationSeconds: 1.5, fps: 24 },
  } as const
  const request = {
    sidecarWorkspacePath: 'Workflows/motion-retarget/source.motion-retarget.v1.json',
    sourceWorkspacePath: sidecar.source.workspacePath,
    sidecar,
  }

  assert.equal(typeof api.workspace.artifacts.writeMotionRetargetSidecar, 'function')
  const result = await api.workspace.artifacts.writeMotionRetargetSidecar(request)

  assert.deepEqual(result, { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar })
  assert.deepEqual(invocations, [{ channel: 'workspace:artifact:writeMotionRetargetSidecar', args: [request] }])
})

test('preload workspace artifact registry exposes motion retarget sidecar reader IPC channel and preserves result envelopes', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const foundSidecar = {
    schema: 'modly.motion-retarget',
    version: 1,
    createdAt: '2026-05-21T00:00:00.000Z',
    source: { workspacePath: 'Workflows/checkpoints/source.glb' },
    artifact: {
      extensionId: 'kimodo-soma-rp',
      nodeId: 'animate-rigged-mesh',
      bundleWorkspacePath: 'Workflows/generated/kimodo/source-motion',
      metadataWorkspacePath: 'Workflows/generated/kimodo/source-motion/metadata.json',
      diagnostics: {
        runtimeStatus: 'ok',
        retargetStatus: 'degraded',
        animationMappingStatus: 'ok',
        stabilizationStatus: 'ok',
        visualQualityStatus: 'warning',
        sourceKind: 'kimodo-motion-bundle',
        mappingConfidence: 'medium',
        retargetErrorCode: null,
        retargetErrorAliases: [],
        retargetErrorMessage: null,
        warnings: ['Root translation is deferred in MVP.'],
        raw: {},
      },
    },
    sourceBones: [{ sourceBoneId: 'source:Hips', label: 'Hips', rawLabel: 'Hips', path: ['Hips'] }],
    session: { selectedPreview: 'preview-glb', mappings: { 'source:Hips': { targetBoneId: 'bone-1' } } },
    warnings: ['Root translation is deferred in MVP.'],
  } as const
  const results = [
    {
      success: true,
      status: 'found',
      sidecarWorkspacePath: 'Workflows/motion-retarget/source.motion-retarget.v1.json',
      sidecar: foundSidecar,
    },
    {
      success: true,
      status: 'not-found',
      sidecarWorkspacePath: 'Workflows/motion-retarget/missing.motion-retarget.v1.json',
    },
    {
      success: false,
      status: 'invalid',
      sidecarWorkspacePath: 'Workflows/motion-retarget/invalid.motion-retarget.v1.json',
      error: 'Invalid motion retarget sidecar: invalid_schema',
    },
  ] as const
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return results[invocations.length - 1]
    },
  })

  const foundRequest = {
    sidecarWorkspacePath: 'Workflows/motion-retarget/source.motion-retarget.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }
  const notFoundRequest = {
    sidecarWorkspacePath: 'Workflows/motion-retarget/missing.motion-retarget.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }
  const invalidRequest = {
    sidecarWorkspacePath: 'Workflows/motion-retarget/invalid.motion-retarget.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }

  assert.equal(typeof api.workspace.artifacts.readMotionRetargetSidecar, 'function')
  const foundResult = await api.workspace.artifacts.readMotionRetargetSidecar(foundRequest)
  const notFoundResult = await api.workspace.artifacts.readMotionRetargetSidecar(notFoundRequest)
  const invalidResult = await api.workspace.artifacts.readMotionRetargetSidecar(invalidRequest)

  assert.deepEqual(foundResult, results[0])
  assert.deepEqual(notFoundResult, results[1])
  assert.deepEqual(invalidResult, results[2])
  assert.deepEqual(invocations, [
    { channel: 'workspace:artifact:readMotionRetargetSidecar', args: [foundRequest] },
    { channel: 'workspace:artifact:readMotionRetargetSidecar', args: [notFoundRequest] },
    { channel: 'workspace:artifact:readMotionRetargetSidecar', args: [invalidRequest] },
  ])
})

test('preload workspace artifact registry exposes workspace artifact preview and download IPC channels', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      if (channel === 'workspace:artifact:previewWorkspaceArtifact') {
        return {
          success: true,
          status: 'text',
          workspacePath: 'Workflows/kimodo/run-1/metadata.json',
          displayName: 'metadata.json',
          content: '{"ok":true}',
          byteLength: 11,
          truncated: false,
        }
      }
      return {
        success: true,
        status: 'saved',
        workspacePath: 'Workflows/kimodo/run-1/metadata.json',
        targetPath: '/tmp/metadata.json',
      }
    },
  })

  const previewRequest = { workspacePath: 'Workflows/kimodo/run-1/metadata.json' }
  const downloadRequest = { workspacePath: 'Workflows/kimodo/run-1/metadata.json', suggestedName: 'metadata.json' }

  assert.equal(typeof api.workspace.artifacts.previewWorkspaceArtifact, 'function')
  assert.equal(typeof api.workspace.artifacts.downloadWorkspaceArtifact, 'function')

  const previewResult = await api.workspace.artifacts.previewWorkspaceArtifact(previewRequest)
  const downloadResult = await api.workspace.artifacts.downloadWorkspaceArtifact(downloadRequest)

  assert.deepEqual(previewResult, {
    success: true,
    status: 'text',
    workspacePath: 'Workflows/kimodo/run-1/metadata.json',
    displayName: 'metadata.json',
    content: '{"ok":true}',
    byteLength: 11,
    truncated: false,
  })
  assert.deepEqual(downloadResult, {
    success: true,
    status: 'saved',
    workspacePath: 'Workflows/kimodo/run-1/metadata.json',
    targetPath: '/tmp/metadata.json',
  })
  assert.deepEqual(invocations, [
    { channel: 'workspace:artifact:previewWorkspaceArtifact', args: [previewRequest] },
    { channel: 'workspace:artifact:downloadWorkspaceArtifact', args: [downloadRequest] },
  ])
})

test('preload workspace artifact registry exposes dedicated rig rename sidecar writer IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return {
        success: true,
        sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.rig.v1.json',
        sidecar: args[0] && typeof args[0] === 'object' && 'sidecar' in args[0]
          ? (args[0] as { sidecar: unknown }).sidecar
          : undefined,
      }
    },
  })

  const sidecar = {
    schema: 'modly.rig.rename-plan',
    version: 1,
    createdAt: '2026-05-19T00:00:00.000Z',
    source: { workspacePath: 'Workflows/checkpoints/source.glb', artifactId: 'mesh-artifact-1', versionId: 'mesh-version-1' },
    skeletonContextId: 'rig:Body|skeleton:0',
    skeleton: {
      rootBoneIds: ['rig:Body|skeleton:0|bone:Hips#0'],
      boneCount: 1,
      bones: [
        {
          boneId: 'rig:Body|skeleton:0|bone:Hips#0',
          oldLabel: 'Hips',
          originalName: 'Hips',
          path: ['Hips'],
        },
      ],
    },
    aliases: {
      'rig:Body|skeleton:0|bone:Hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' },
    },
  } as const
  const request = {
    sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.rig.v1.json',
    sourceWorkspacePath: sidecar.source.workspacePath,
    sidecar,
  }

  assert.equal(typeof api.workspace.artifacts.writeRigRenameSidecar, 'function')
  const result = await api.workspace.artifacts.writeRigRenameSidecar(request)

  assert.deepEqual(result, { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar })
  assert.deepEqual(invocations, [{ channel: 'workspace:artifact:writeRigRenameSidecar', args: [request] }])
})

test('preload rig rename sidecar writer does not route through generic sidecar or GLB export IPC', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.rig.v1.json', sidecar: (args[0] as { sidecar?: unknown }).sidecar }
    },
  })

  const request = {
    sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.rig.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    sidecar: {
      schema: 'modly.rig.rename-plan',
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      source: { workspacePath: 'Workflows/checkpoints/source.glb' },
      skeletonContextId: 'rig:Body|skeleton:0',
      skeleton: { rootBoneIds: ['bone-1'], boneCount: 1, bones: [{ boneId: 'bone-1', oldLabel: 'Hips', originalName: 'Hips', path: ['Hips'] }] },
      aliases: { 'bone-1': { oldLabel: 'Hips', alias: 'Pelvis Control' } },
    },
  }

  assert.equal(typeof api.workspace.artifacts.writeRigRenameSidecar, 'function')
  await api.workspace.artifacts.writeRigRenameSidecar(request)

  assert.deepEqual(invocations.map((invocation) => invocation.channel), ['workspace:artifact:writeRigRenameSidecar'])
  assert.equal(invocations.some((invocation) => invocation.channel === 'workspace:artifact:writeSidecar'), false)
  assert.equal(invocations.some((invocation) => invocation.channel === 'workspace:artifact:writeEditedSceneArtifact'), false)
})

test('preload workspace artifact registry exposes dedicated rig rename sidecar reader IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const foundSidecar = {
    schema: 'modly.rig.rename-plan',
    version: 1,
    createdAt: '2026-05-19T00:00:00.000Z',
    source: { workspacePath: 'Workflows/checkpoints/source.glb', artifactId: 'mesh-artifact-1', versionId: 'mesh-version-1' },
    skeletonContextId: 'rig:Body|skeleton:0',
    skeleton: {
      rootBoneIds: ['rig:Body|skeleton:0|bone:Hips#0'],
      boneCount: 1,
      bones: [
        {
          boneId: 'rig:Body|skeleton:0|bone:Hips#0',
          oldLabel: 'Hips',
          originalName: 'Hips',
          path: ['Hips'],
        },
      ],
    },
    aliases: {
      'rig:Body|skeleton:0|bone:Hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' },
    },
  } as const
  const results = [
    {
      success: true,
      status: 'found',
      sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.rig.v1.json',
      sidecar: foundSidecar,
    },
    {
      success: true,
      status: 'not-found',
      sidecarWorkspacePath: 'Workflows/rig-edits/missing-rig-aliases.rig.v1.json',
    },
    {
      success: false,
      status: 'invalid',
      error: 'sourceWorkspacePath mismatch',
      sidecarWorkspacePath: 'Workflows/rig-edits/invalid-rig-aliases.rig.v1.json',
    },
  ] as const
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return results[invocations.length - 1]
    },
  })

  const foundRequest = {
    sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.rig.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }
  const notFoundRequest = {
    sidecarWorkspacePath: 'Workflows/rig-edits/missing-rig-aliases.rig.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/missing.glb',
  }
  const invalidRequest = {
    sidecarWorkspacePath: 'Workflows/rig-edits/invalid-rig-aliases.rig.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/other.glb',
  }

  assert.equal(typeof api.workspace.artifacts.readRigRenameSidecar, 'function')
  const foundResult = await api.workspace.artifacts.readRigRenameSidecar(foundRequest)
  const notFoundResult = await api.workspace.artifacts.readRigRenameSidecar(notFoundRequest)
  const invalidResult = await api.workspace.artifacts.readRigRenameSidecar(invalidRequest)

  assert.deepEqual(foundResult, results[0])
  assert.deepEqual(notFoundResult, results[1])
  assert.deepEqual(invalidResult, results[2])
  assert.deepEqual(invocations, [
    { channel: 'workspace:artifact:readRigRenameSidecar', args: [foundRequest] },
    { channel: 'workspace:artifact:readRigRenameSidecar', args: [notFoundRequest] },
    { channel: 'workspace:artifact:readRigRenameSidecar', args: [invalidRequest] },
  ])
})

test('preload workspace artifact registry exposes read-only UniRig rigmeta sidecar reader IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const foundRigMeta = {
    schema: 'modly.unirig.rigmeta',
    output_mesh: 'foo_unirig.glb',
    semantic_candidates: {
      'rig:Body|skeleton:0|bone:Hips#0': { label: 'Pelvis' },
    },
  }
  const results = [
    {
      success: true,
      status: 'found',
      rigMetaWorkspacePath: 'Workflows/foo_unirig.rigmeta.json',
      rigMeta: foundRigMeta,
      namingByBoneId: {
        'rig:Body|skeleton:0|bone:Hips#0': { label: 'Pelvis', source: 'semantic_candidates' },
      },
      warnings: [],
    },
    {
      success: true,
      status: 'not-found',
      rigMetaWorkspacePath: 'Workflows/missing_unirig.rigmeta.json',
    },
    {
      success: false,
      status: 'invalid',
      rigMetaWorkspacePath: 'Workflows/invalid_unirig.rigmeta.json',
      message: 'Invalid rigmeta JSON: Unexpected token',
    },
  ] as const
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return results[invocations.length - 1]
    },
  })

  const foundRequest = { sourceWorkspacePath: 'Workflows/foo_unirig.glb' }
  const notFoundRequest = { sourceWorkspacePath: 'Workflows/missing_unirig.glb' }
  const invalidRequest = { sourceWorkspacePath: 'Workflows/invalid_unirig.glb' }

  assert.equal(typeof api.workspace.artifacts.readRigMetaSidecar, 'function')
  const foundResult = await api.workspace.artifacts.readRigMetaSidecar(foundRequest)
  const notFoundResult = await api.workspace.artifacts.readRigMetaSidecar(notFoundRequest)
  const invalidResult = await api.workspace.artifacts.readRigMetaSidecar(invalidRequest)

  assert.deepEqual(foundResult, results[0])
  assert.deepEqual(notFoundResult, results[1])
  assert.deepEqual(invalidResult, results[2])
  assert.deepEqual(invocations, [
    { channel: 'workspace:artifact:readRigMetaSidecar', args: [foundRequest] },
    { channel: 'workspace:artifact:readRigMetaSidecar', args: [notFoundRequest] },
    { channel: 'workspace:artifact:readRigMetaSidecar', args: [invalidRequest] },
  ])
})

test('preload workspace artifact registry exposes humanoid draft discovery and promotion persistence IPC channels', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      if (channel === 'workspace:artifact:readHumanoidDraftSidecar') {
        return {
          success: true,
          status: 'found',
          sidecarWorkspacePath: 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json',
          sidecar: { schema: 'modly.humanoid-draft.v1', version: 1 },
        }
      }
      if (channel === 'workspace:artifact:writeHumanoidPromotionSidecar') {
        return {
          success: true,
          sidecarWorkspacePath: 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json',
          sidecar: { schema: 'modly.humanoid-promotion.v1', version: 1 },
        }
      }
      return {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json',
        sidecar: { schema: 'modly.humanoid-promotion.v1', version: 1 },
      }
    },
  })

  const draftRequest = { meshWorkspacePath: 'Workflows/outputs/hero_unirig.glb' }
  const promotionWriteRequest = {
    meshWorkspacePath: 'Workflows/outputs/hero_unirig.glb',
    sidecar: { schema: 'modly.humanoid-promotion.v1', version: 1 },
  }
  const promotionReadRequest = { meshWorkspacePath: 'Workflows/outputs/hero_unirig.glb' }

  assert.equal(typeof api.workspace.artifacts.readHumanoidDraftSidecar, 'function')
  assert.equal(typeof api.workspace.artifacts.writeHumanoidPromotionSidecar, 'function')
  assert.equal(typeof api.workspace.artifacts.readHumanoidPromotionSidecar, 'function')

  const draftResult = await api.workspace.artifacts.readHumanoidDraftSidecar(draftRequest)
  const promotionWriteResult = await api.workspace.artifacts.writeHumanoidPromotionSidecar(promotionWriteRequest)
  const promotionReadResult = await api.workspace.artifacts.readHumanoidPromotionSidecar(promotionReadRequest)

  assert.deepEqual(draftResult, {
    success: true,
    status: 'found',
    sidecarWorkspacePath: 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json',
    sidecar: { schema: 'modly.humanoid-draft.v1', version: 1 },
  })
  assert.deepEqual(promotionWriteResult, {
    success: true,
    sidecarWorkspacePath: 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json',
    sidecar: { schema: 'modly.humanoid-promotion.v1', version: 1 },
  })
  assert.deepEqual(promotionReadResult, {
    success: true,
    status: 'found',
    sidecarWorkspacePath: 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json',
    sidecar: { schema: 'modly.humanoid-promotion.v1', version: 1 },
  })
  assert.deepEqual(invocations, [
    { channel: 'workspace:artifact:readHumanoidDraftSidecar', args: [draftRequest] },
    { channel: 'workspace:artifact:writeHumanoidPromotionSidecar', args: [promotionWriteRequest] },
    { channel: 'workspace:artifact:readHumanoidPromotionSidecar', args: [promotionReadRequest] },
  ])
})

test('preload workspace asset library exposes list, read, and open IPC channels', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const listResult = {
    success: true,
    entries: [
      {
        id: 'artifact-hero',
        workspacePath: 'Workflows/generated/hero.glb',
        displayName: 'Hero Mesh',
        capability: 'rigged-mesh',
        state: 'ready',
        previewKind: '3d-model',
        warnings: [],
      },
    ],
  } as const
  const readResult = {
    success: true,
    entry: listResult.entries[0],
    preview: { kind: '3d-model', viewerKind: 'glb' },
  } as const
  const openResult = {
    success: true,
    entry: listResult.entries[0],
  } as const
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      if (channel === 'workspace:library:list') return listResult
      if (channel === 'workspace:library:read') return readResult
      if (channel === 'workspace:library:open') return openResult
      throw new Error(`Unexpected channel: ${channel}`)
    },
  })

  assert.equal(typeof api.workspace.library.list, 'function')
  assert.equal(typeof api.workspace.library.read, 'function')
  assert.equal(typeof api.workspace.library.open, 'function')

  const readRequest = {
    workspacePath: 'Workflows/generated/hero.glb',
    sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
  }
  const openRequest = {
    workspacePath: 'Workflows/generated/hero.glb',
  }

  assert.deepEqual(await api.workspace.library.list(), listResult)
  assert.deepEqual(await api.workspace.library.read(readRequest), readResult)
  assert.deepEqual(await api.workspace.library.open(openRequest), openResult)
  assert.deepEqual(invocations, [
    { channel: 'workspace:library:list', args: [] },
    { channel: 'workspace:library:read', args: [readRequest] },
    { channel: 'workspace:library:open', args: [openRequest] },
  ])
})
