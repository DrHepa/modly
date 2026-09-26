import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const BASE_TYPESCRIPT_TESTS = [
  'src/shared/types/assetLibrary.test.ts',
  'src/shared/types/worldProjects.test.ts',
  'src/shared/types/worldRenderHost.test.ts',
  'src/shared/types/worldRenders.test.ts',
  'src/shared/utils/agentModels.test.ts',
  'src/shared/stores/agentSessionsStore.test.ts',
  'src/shared/stores/navStore.test.ts',
  'src/areas/generate/agentDirectActions.test.ts',
  'src/areas/generate/assetLibraryProjection.test.ts',
  'src/areas/generate/assetLibraryService.test.ts',
  'src/areas/generate/assetLibraryUi.test.ts',
  'src/areas/generate/components/ChatPanel.test.ts',
  'src/areas/settings/components/AgentSection.test.ts',
  'src/areas/workflows/preflight.test.ts',
  'electron/main/agent-actions-ipc.test.ts',
  'electron/main/agent-actions-service.test.ts',
  'electron/main/agent-artifact-verifier.test.ts',
  'electron/main/agent-capability-discovery.test.ts',
  'electron/main/automation-capabilities.test.ts',
  'electron/main/automation-http-bridge.test.ts',
  'electron/main/agent-mcp-broker.test.ts',
  'electron/main/agent-mcp-manifest.test.ts',
  'electron/main/agent-model-access-gateway.test.ts',
  'electron/main/agent-model-access-runtime.test.ts',
  'electron/main/agent-model-free-process-composition.test.ts',
  'electron/main/agent-ollama-gpu-device-authority.test.ts',
  'electron/main/agent-ollama-model-store.test.ts',
  'electron/main/agent-ollama-runtime-tree.test.ts',
  'electron/main/agent-ollama-private-daemon.test.ts',
  'electron/main/agent-owned-process.test.ts',
  'electron/main/agent-process-executor.test.ts',
  'electron/main/agent-process-python-discovery.test.ts',
  'electron/main/agent-process-python-executor.test.ts',
  'electron/main/agent-process-python-runtime.test.ts',
  'electron/main/agent-skills-manifest.test.ts',
  'electron/main/agent-skill-context-authority.test.ts',
  'electron/main/agent-skill-contexts-ipc.test.ts',
  'electron/main/agent-workflow-authority.test.ts',
  'electron/main/agent-workflows-ipc.test.ts',
  'electron/main/renderer-filesystem-access.test.ts',
  'electron/main/agent-session-store.test.ts',
  'electron/main/agent-trust-contracts.test.ts',
  'electron/main/artifact-registry-service.test.ts',
  'electron/main/extension-path-guard.test.ts',
  'electron/preload/agent-actions-preload.test.ts',
  'electron/preload/agent-capabilities-preload.test.ts',
  'electron/preload/agent-sessions-preload.test.ts',
  'electron/preload/agent-workflows-preload.test.ts',
  'electron/preload/artifact-registry-preload.test.ts',
]

const WORLDS_BOUNDARY_TYPESCRIPT_TESTS = [
  'electron/main/worlds-scene-manifest-ipc.test.ts',
  'electron/main/world-repository-io.test.ts',
  'electron/main/world-ai-resource-observations.test.ts',
  'electron/main/world-project-repository-backup-semantic-bridge.test.ts',
  'electron/main/world-project-repository-backup-write-rejection.test.ts',
  'electron/main/world-project-repository.test.ts',
  'electron/main/worlds-cli-direct-edit-broker.test.ts',
  'electron/main/worlds-cli-direct-edit-dispatch.test.ts',
  'electron/main/worlds-cli-direct-edit-intents.test.ts',
  'electron/main/worlds-cli-ipc.test.ts',
  'electron/main/worlds-cli-plan-propose.test.ts',
  'electron/main/worlds-cli-readiness-broker.test.ts',
  'electron/main/worlds-cli-review-ipc.test.ts',
  'electron/main/worlds-cli-review.test.ts',
  'electron/main/worlds-cli-reviewed-apply.test.ts',
  'electron/main/worlds-cli-window-trust.test.ts',
  'electron/main/worlds-cli-transport.test.ts',
  'electron/main/world-render-browser-executor.test.ts',
  'electron/main/world-render-composition.test.ts',
  'electron/main/world-render-ffmpeg-encoder.test.ts',
  'electron/main/world-render-ffmpeg-runtime.test.ts',
  'electron/main/world-render-job-service.test.ts',
  'electron/main/world-render-output-repository.test.ts',
  'electron/main/world-render-webm-sink.test.ts',
  'electron/main/world-renders-ipc.test.ts',
  'electron/main/world-projects-ipc.test.ts',
  'electron/preload/world-projects-preload.test.ts',
  'electron/preload/world-renders-preload.test.ts',
  'src/areas/workflows/nodes/AddToWorldsIntegration.test.ts',
  'src/areas/workflows/nodes/AddToWorldsNode.test.ts',
  'src/areas/workflows/workflowArtifacts.test.ts',
  'src/areas/workflows/workflowSceneSource.test.ts',
  'src/areas/workflows/workflowRunStoreDispatch.test.ts',
  'src/areas/workflows/workflowWorldsOutput.worldsculpt.test.ts',
  'src/areas/workflows/nodes/AddToSceneNode.test.ts',
  'src/areas/workflows/workflowBuiltinNodes.test.ts',
  'src/areas/workflows/workflowBuiltinNodeCatalog.test.ts',
  'src/shared/components/layout/Sidebar.test.ts',
  'src/shared/router/routes.test.ts',
  'src/shared/types/artifacts.test.ts',
]

const EXPECTED_WORLDS_TYPESCRIPT_TESTS = [
  'src/areas/worlds/WorldsPage.test.ts',
  'src/areas/worlds/cinematic/worldRationalTime.test.ts',
  'src/areas/worlds/cinematic/worldSequenceEvaluator.test.ts',
  'src/areas/worlds/cinematic/worldSequencePreflight.test.ts',
  'src/areas/worlds/components/WorldAssetSelector.test.ts',
  'src/areas/worlds/components/WorldCollisionSurfaceLayer.test.ts',
  'src/areas/worlds/components/WorldRuntimeViewport.test.ts',
  'src/areas/worlds/components/WorldViewportBoundary.test.ts',
  'src/areas/worlds/components/WorldViewportGraphics.mounted.test.ts',
  'src/areas/worlds/components/WorldViewportGraphics.test.ts',
  'src/areas/worlds/components/WorldsAiDrawer.test.ts',
  'src/areas/worlds/components/WorldsAssetsDock.test.ts',
  'src/areas/worlds/components/WorldsAuthoringUi.test.ts',
  'src/areas/worlds/components/WorldsGaussianPlyObject.test.ts',
  'src/areas/worlds/components/WorldsInspector.primitiveAuthoring.mounted.test.ts',
  'src/areas/worlds/components/WorldsLegacyExportDialog.test.ts',
  'src/areas/worlds/components/WorldsPlayControls.test.ts',
  'src/areas/worlds/components/WorldsProjectBar.test.ts',
  'src/areas/worlds/components/WorldsRenderPanel.test.ts',
  'src/areas/worlds/components/WorldsTimelineDrawer.test.ts',
  'src/areas/worlds/components/WorldsViewer.test.ts',
  'src/areas/worlds/components/WorldsWorkbench.diskWorkflow.test.ts',
  'src/areas/worlds/components/WorldsWorkbench.graphics.test.ts',
  'src/areas/worlds/components/WorldsWorkbench.meshAuthoring.disk.test.ts',
  'src/areas/worlds/components/WorldsWorkbench.playablePortalLoop.mounted.test.ts',
  'src/areas/worlds/components/worldsCliUiState.test.ts',
  'src/areas/worlds/core/legacySceneManifestAdapter.test.ts',
  'src/areas/worlds/core/worldAiContract.test.ts',
  'src/areas/worlds/core/worldAiCreationCompiler.test.ts',
  'src/areas/worlds/core/worldAiSemanticReview.test.ts',
  'src/areas/worlds/core/worldCommands.test.ts',
  'src/areas/worlds/core/worldComponentRegistry.test.ts',
  'src/areas/worlds/core/worldDocuments.test.ts',
  'src/areas/worlds/core/worldSessions.test.ts',
  'src/areas/worlds/core/worldWireValidation.test.ts',
  'src/areas/worlds/editor/legacyWorldsCommandBridge.test.ts',
  'src/areas/worlds/editor/useWorldEditorProjectionBridge.test.ts',
  'src/areas/worlds/editor/workflowWorldsBridge.test.ts',
  'src/areas/worlds/editor/worldAiChatAdapter.test.ts',
  'src/areas/worlds/editor/worldAiCommandBridge.test.ts',
  'src/areas/worlds/editor/worldAuthoringModel.test.ts',
  'src/areas/worlds/editor/worldEditorCommandBuilders.test.ts',
  'src/areas/worlds/editor/worldEditorCommandPort.test.ts',
  'src/areas/worlds/editor/worldEditorController.test.ts',
  'src/areas/worlds/editor/worldEditorProjection.test.ts',
  'src/areas/worlds/editor/worldEditorRepositoryIntegration.test.ts',
  'src/areas/worlds/editor/worldGraphicsProfileCommands.test.ts',
  'src/areas/worlds/editor/worldProjectPickerModel.test.ts',
  'src/areas/worlds/editor/worldRenderUiController.test.ts',
  'src/areas/worlds/editor/worldTimelineModel.test.ts',
  'src/areas/worlds/editor/worldTimelinePreview.test.ts',
  'src/areas/worlds/editor/worldsCliReadinessResponder.test.ts',
  'src/areas/worlds/editor/worldsOverlayFocus.test.ts',
  'src/areas/worlds/editor/worldsViewportSelection.test.ts',
  'src/areas/worlds/editor/worldsWorkbenchModel.test.ts',
  'src/areas/worlds/graphics/worldGraphicsProfilePolicy.test.ts',
  'src/areas/worlds/plyClassification.test.ts',
  'src/areas/worlds/render/worldOfflineAudio.test.ts',
  'src/areas/worlds/render/worldRenderScene.test.ts',
  'src/areas/worlds/render/worldWebmAssembler.test.ts',
  'src/areas/worlds/render/worldWebmProtocol.test.ts',
  'src/areas/worlds/runtime/worldAudioRuntime.test.ts',
  'src/areas/worlds/runtime/worldBehaviorRuntime.test.ts',
  'src/areas/worlds/runtime/worldGeometryPreparation.test.ts',
  'src/areas/worlds/runtime/worldInputRuntime.test.ts',
  'src/areas/worlds/runtime/worldPhysicsProtocol.test.ts',
  'src/areas/worlds/runtime/worldPhysicsRuntime.test.ts',
  'src/areas/worlds/runtime/worldPlayController.test.ts',
  'src/areas/worlds/runtime/worldRapierRuntime.test.ts',
  'src/areas/worlds/runtime/worldRuntimeClock.test.ts',
  'src/areas/worlds/runtime/worldRuntimeProjection.test.ts',
  'src/areas/worlds/worldAssetLibraryService.test.ts',
  'src/areas/worlds/worldCameraNavigation.test.ts',
  'src/areas/worlds/worldProjectService.test.ts',
  'src/areas/worlds/worldRenderService.test.ts',
  'src/areas/worlds/worldRenderableResolver.test.ts',
  'src/areas/worlds/worldsBaseScenePlacementSurface.test.ts',
  'src/areas/worlds/worldsBaseSceneRaycast.test.ts',
  'src/areas/worlds/worldsBaseSceneSupport.test.ts',
  'src/areas/worlds/worldsCollisionMath.test.ts',
  'src/areas/worlds/worldsCollisionSurfaceEditor.test.ts',
  'src/areas/worlds/worldsCollisionSurfaceManifest.test.ts',
  'src/areas/worlds/worldsCollisionSurfaces.test.ts',
  'src/areas/worlds/worldsLegacyCollisionSurfaceConversion.test.ts',
  'src/areas/worlds/worldsObjectBounds.test.ts',
  'src/areas/worlds/worldsPoseClipPlayback.test.ts',
  'src/areas/worlds/worldsSceneManifest.test.ts',
  'src/areas/worlds/worldsScenePlacement.test.ts',
  'src/areas/worlds/worldsSurfaceMath.test.ts',
  'src/areas/worlds/worldsSurfaceNavigation.test.ts',
  'src/areas/worlds/worldsSurfacePlacement.test.ts',
]

const EXPECTED_WORLDS_SCRIPT_TYPESCRIPT_TESTS = [
  'scripts/worlds-character-electron-fixture/nativeKeyboard.test.ts',
]

const EXPECTED_WORLDS_SCRIPT_MJS_TESTS = [
  'scripts/worlds-ai-electron-fixture.test.mjs',
  'scripts/worlds-authoring-electron-fixture/guards.test.mjs',
  'scripts/world-ffmpeg-custody-convergence.test.mjs',
  'scripts/world-ffmpeg-linux-arm64.test.mjs',
  'scripts/world-ffmpeg-recovery-preflight.test.mjs',
  'scripts/world-ffmpeg-supply-chain.test.mjs',
  'scripts/worlds-character-electron-fixture.test.mjs',
  'scripts/worlds-character-electron-fixture/observer.test.mjs',
  'scripts/worlds-command-latency.test.mjs',
  'scripts/worlds-command-profile.test.mjs',
  'scripts/worlds-command-profile.contract.test.mjs',
  'scripts/worlds-command-storage-ab.test.mjs',
  'scripts/worlds-codex-cli-package.test.mjs',
  'scripts/worlds-codex-direct-edit-electron-fixture.test.mjs',
  'scripts/worlds-graphics-electron-fixture.test.mjs',
  'scripts/worlds-physics-electron-fixture.test.mjs',
]

const REQUIRED_CANONICAL_CHANGED_TESTS = [
  { phase: 'typescript', file: 'electron/main/automation-http-bridge.test.ts' },
  { phase: 'typescript', file: 'electron/main/worlds-cli-review-ipc.test.ts' },
  { phase: 'typescript', file: 'electron/main/worlds-cli-review.test.ts' },
  { phase: 'typescript', file: 'electron/main/worlds-cli-reviewed-apply.test.ts' },
  { phase: 'typescript', file: 'src/areas/workflows/workflowWorldsOutput.worldsculpt.test.ts' },
  { phase: 'typescript', file: 'src/shared/stores/navStore.test.ts' },
  { phase: 'mjs', file: 'scripts/platform-contract.test.mjs' },
  { phase: 'mjs', file: 'scripts/run-typechecks.test.mjs' },
  { phase: 'mjs', file: 'scripts/world-ffmpeg-linux-arm64.test.mjs' },
  { phase: 'mjs', file: 'scripts/worlds-codex-direct-edit-electron-fixture.test.mjs' },
  { phase: 'mjs', file: 'scripts/worlds-command-storage-ab.test.mjs' },
  { phase: 'mjs', file: 'tests/index-html-csp.test.mjs' },
]

const EXPECTED_TYPESCRIPT_TESTS = [
  ...BASE_TYPESCRIPT_TESTS,
  ...WORLDS_BOUNDARY_TYPESCRIPT_TESTS,
  ...EXPECTED_WORLDS_SCRIPT_TYPESCRIPT_TESTS,
  ...EXPECTED_WORLDS_TYPESCRIPT_TESTS,
]

test('Worlds runner accepts the complete current canonical inventory within finite bounds', async (t) => {
  const { createNodeTestPlan, collectWorldsTypeScriptTests } = await import('./run-node-tests.mjs')
  const worlds = await collectWorldsTypeScriptTests()
  const plan = await createNodeTestPlan()
  assert.equal(worlds.length, 91)
  assert.ok(plan.length <= 256)
  for (const file of worlds) assert.equal(plan.filter((entry) => entry.file === file).length, 1, file)
  t.diagnostic(`Canonical inventory: total=${plan.length}, typescript=${plan.filter(({ phase }) => phase === 'typescript').length}, mjs=${plan.filter(({ phase }) => phase === 'mjs').length}, worlds=${worlds.length}`)
})

test('Worlds workflow scene ingress and compatibility suites are canonical exactly once', async (t) => {
  const { createNodeTestPlan } = await import('./run-node-tests.mjs')
  const plan = await createNodeTestPlan()
  const required = [
    'src/areas/workflows/workflowSceneSource.test.ts',
    'src/areas/workflows/workflowRunStoreDispatch.test.ts',
    'src/areas/workflows/nodes/AddToSceneNode.test.ts',
    'src/areas/workflows/workflowBuiltinNodes.test.ts',
    'src/areas/workflows/workflowBuiltinNodeCatalog.test.ts',
  ]
  t.diagnostic(`Workflow registration counts: ${JSON.stringify(required.map((file) => ({
    file, count: plan.filter((entry) => entry.file === file).length,
  })))}`)
  for (const file of required) {
    const matches = plan.filter((entry) => entry.file === file)
    assert.equal(matches.length, 1, file)
    assert.equal(matches[0].phase, 'typescript', file)
    assert.deepEqual(matches[0].args, [
      '--test', '--test-concurrency=1', '--experimental-strip-types',
      '--experimental-loader', './scripts/node-ts-extensionless-loader.mjs', file,
    ], file)
  }
})

test('Worlds runner registers semantic bridge and authoring guard suites exactly once', async (t) => {
  const { createNodeTestPlan } = await import('./run-node-tests.mjs')
  const root = await mkdtemp(join(tmpdir(), 'modly-worlds-runner-registration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'electron', 'main'), { recursive: true })
  for (const file of EXPECTED_WORLDS_TYPESCRIPT_TESTS) {
    const target = join(root, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, '')
  }
  const plan = await createNodeTestPlan(pathToFileURL(`${root}/`))
  const required = [
    'electron/main/world-project-repository-backup-semantic-bridge.test.ts',
    'scripts/worlds-authoring-electron-fixture/guards.test.mjs',
  ]
  assert.deepEqual(required.filter((file) => plan.filter((entry) => entry.file === file).length !== 1), [])
  const guard = plan.find((entry) => entry.file === required[1])
  assert.deepEqual(guard.args, ['--test', '--test-concurrency=1', '--experimental-strip-types', '--experimental-loader', './scripts/node-ts-extensionless-loader.mjs', '--test-reporter=tap', required[1]])
})

test('canonical Node test command delegates to the bounded deterministic runner', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const command = packageJson.scripts?.['test:node']

  assert.equal(command, 'node scripts/run-node-tests.mjs')
})

test('canonical runner includes every required changed test exactly once', async () => {
  const { createNodeTestPlan } = await import('./run-node-tests.mjs')
  const plan = await createNodeTestPlan()

  for (const required of REQUIRED_CANONICAL_CHANGED_TESTS) {
    const matches = plan.filter(({ file }) => file === required.file)
    assert.equal(matches.length, 1, required.file)
    assert.equal(matches[0].phase, required.phase, required.file)
    assert.equal(matches[0].args.at(-1), required.file, required.file)
  }
})

test('canonical main requires an ordinary-Node full proof before per-file dispatch', async (t) => {
  const { createNodeTestPlan, runNodeTestPlan, runNodeTests } = await import('./run-node-tests.mjs')
  const { runNodeTestDispatchProof } = await import('./node-test-dispatch-proof.mjs')
  assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined, 'Exercise the actual node:test child boundary')
  let starts = 0
  const events = [], output = []
  const runnerOptions = {
    write: (value) => output.push(value),
    spawnProcess(executable, args, options) {
      starts += 1; events.push(args.at(-1))
      assert.equal(executable, process.execPath)
      assert.equal(options.cwd, dirname(fileURLToPath(new URL('../package.json', import.meta.url))))
      assert.equal(options.env, process.env)
      assert.equal(options.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined)
      assert.equal(options.stdio, 'inherit')
      const child = new EventEmitter()
      setImmediate(() => child.emit('exit', 0, null))
      return child
    },
  }
  await assert.rejects(runNodeTests(undefined, { runnerOptions }), /requires ordinary Node before node:test/)
  await assert.rejects(runNodeTestDispatchProof({ createNodeTestPlan() { throw new Error('must not create plan') } }),
    /requires ordinary Node before node:test/)
  assert.equal(starts, 0, 'The default full-proof refusal happens before any child')
  const proofError = new Error('mock-only proof refusal')
  await assert.rejects(runNodeTests(undefined, { runnerOptions, dispatchProof: async () => { throw proofError } }),
    (error) => error === proofError)
  assert.equal(starts, 0)
  // Trusted injected seam: verify routing/order only. These fake processes are NOT real dispatch proof.
  await runNodeTests(undefined, { runnerOptions, dispatchProof: async (dependencies) => {
    assert.equal(dependencies.createNodeTestPlan, createNodeTestPlan)
    assert.equal(dependencies.runNodeTestPlan, runNodeTestPlan)
    assert.equal(process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined)
    events.push('mock-proof-start')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(starts, 0)
    assert.equal(process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined)
    events.push('mock-proof-end')
  } })
  const plan = await createNodeTestPlan()
  assert.equal(plan.length, 213)
  assert.deepEqual(events, ['mock-proof-start', 'mock-proof-end', ...plan.map(({ file }) => file)])
  assert.equal(starts, plan.length)
  assert.equal(output.length, plan.length)
  t.diagnostic('Mock-only main routing: default nested refusal, proof error blocks children, awaited prelude precedes all selected files; standalone real proof is separate')
})

test('deterministic runner awaits each process, inherits output, and propagates the exact failure code', async () => {
  const { runNodeTestPlan } = await import('./run-node-tests.mjs')
  const plan = [
    { phase: 'typescript', file: 'first.test.ts', args: ['--test', 'first.test.ts'] },
    { phase: 'mjs', file: 'second.test.mjs', args: ['--test', 'second.test.mjs'] },
  ]
  const starts = []
  let active = 0
  let maximumActive = 0
  const spawnProcess = (executable, args, options) => {
    assert.equal(executable, process.execPath)
    assert.equal(options.cwd, '/repo')
    assert.equal(options.stdio, 'inherit')
    const child = new EventEmitter()
    starts.push(args.at(-1))
    active += 1
    maximumActive = Math.max(maximumActive, active)
    setImmediate(() => {
      active -= 1
      child.emit('exit', 0, null)
    })
    return child
  }
  const output = []
  await runNodeTestPlan(plan, '/repo', { spawnProcess, write: (value) => output.push(value) })
  assert.deepEqual(starts, ['first.test.ts', 'second.test.mjs'])
  assert.equal(maximumActive, 1)
  assert.equal(output.length, 2)

  await assert.rejects(
    runNodeTestPlan([plan[0]], '/repo', {
      spawnProcess: () => {
        const child = new EventEmitter()
        setImmediate(() => child.emit('exit', 7, null))
        return child
      },
      write: () => undefined,
    }),
    (error) => {
      assert.equal(error.exitCode, 7)
      assert.match(error.message, /first\.test\.ts failed with exit code 7/)
      return true
    },
  )
})

test('deterministic runner includes every canonical suite once and runs both phases serially per file', async () => {
  const {
    createNodeTestPlan,
    REQUIRED_WORLDS_CINEMATIC_TYPESCRIPT_TESTS,
    REQUIRED_WORLDS_PLAY_TYPESCRIPT_TESTS,
    REQUIRED_WORLDS_RENDER_TYPESCRIPT_TESTS,
  } = await import('./run-node-tests.mjs')
  const plan = await createNodeTestPlan(new URL('..', import.meta.url))
  const typescriptFiles = plan.filter((invocation) => invocation.phase === 'typescript')
    .map((invocation) => invocation.file)
  assert.deepEqual(typescriptFiles, EXPECTED_TYPESCRIPT_TESTS)
  assert.deepEqual(REQUIRED_WORLDS_PLAY_TYPESCRIPT_TESTS, [
    'src/areas/worlds/components/WorldRuntimeViewport.test.ts',
    'src/areas/worlds/components/WorldsPlayControls.test.ts',
    'src/areas/worlds/runtime/worldAudioRuntime.test.ts',
    'src/areas/worlds/runtime/worldBehaviorRuntime.test.ts',
    'src/areas/worlds/runtime/worldInputRuntime.test.ts',
    'src/areas/worlds/runtime/worldPhysicsProtocol.test.ts',
    'src/areas/worlds/runtime/worldPhysicsRuntime.test.ts',
    'src/areas/worlds/runtime/worldPlayController.test.ts',
    'src/areas/worlds/runtime/worldRapierRuntime.test.ts',
    'src/areas/worlds/runtime/worldRuntimeClock.test.ts',
    'src/areas/worlds/runtime/worldRuntimeProjection.test.ts',
  ])
  for (const file of REQUIRED_WORLDS_PLAY_TYPESCRIPT_TESTS) {
    assert.equal(typescriptFiles.filter((candidate) => candidate === file).length, 1)
  }
  assert.deepEqual(REQUIRED_WORLDS_CINEMATIC_TYPESCRIPT_TESTS, [
    'src/areas/worlds/cinematic/worldRationalTime.test.ts',
    'src/areas/worlds/cinematic/worldSequenceEvaluator.test.ts',
    'src/areas/worlds/cinematic/worldSequencePreflight.test.ts',
    'src/areas/worlds/components/WorldsTimelineDrawer.test.ts',
    'src/areas/worlds/editor/worldTimelineModel.test.ts',
    'src/areas/worlds/editor/worldTimelinePreview.test.ts',
  ])
  for (const file of REQUIRED_WORLDS_CINEMATIC_TYPESCRIPT_TESTS) {
    assert.equal(typescriptFiles.filter((candidate) => candidate === file).length, 1)
  }
  assert.deepEqual(REQUIRED_WORLDS_RENDER_TYPESCRIPT_TESTS, [
    'src/shared/types/worldRenderHost.test.ts',
    'src/shared/types/worldRenders.test.ts',
    'electron/main/world-render-browser-executor.test.ts',
    'electron/main/world-render-composition.test.ts',
    'electron/main/world-render-ffmpeg-encoder.test.ts',
    'electron/main/world-render-ffmpeg-runtime.test.ts',
    'electron/main/world-render-job-service.test.ts',
    'electron/main/world-render-output-repository.test.ts',
    'electron/main/world-render-webm-sink.test.ts',
    'electron/main/world-renders-ipc.test.ts',
    'electron/preload/world-renders-preload.test.ts',
    'src/areas/worlds/components/WorldsRenderPanel.test.ts',
    'src/areas/worlds/editor/worldRenderUiController.test.ts',
    'src/areas/worlds/render/worldOfflineAudio.test.ts',
    'src/areas/worlds/render/worldRenderScene.test.ts',
    'src/areas/worlds/render/worldWebmAssembler.test.ts',
    'src/areas/worlds/render/worldWebmProtocol.test.ts',
    'src/areas/worlds/worldRenderService.test.ts',
  ])
  for (const file of REQUIRED_WORLDS_RENDER_TYPESCRIPT_TESTS) {
    assert.equal(typescriptFiles.filter((candidate) => candidate === file).length, 1)
  }

  const mjsFiles = plan.filter((invocation) => invocation.phase === 'mjs')
    .map((invocation) => invocation.file)
  assert.equal(mjsFiles.filter((file) => file === 'scripts/platform-contract.test.mjs').length, 1)
  assert.equal(mjsFiles.filter((file) => file === 'scripts/test-runner-contract.test.mjs').length, 1)
  assert.equal(mjsFiles.filter((file) => file === 'scripts/run-typechecks.test.mjs').length, 1)
  assert.equal(mjsFiles.filter((file) => file === 'scripts/world-ffmpeg-custody-convergence.test.mjs').length, 1)
  assert.equal(mjsFiles.filter((file) => file === 'scripts/world-ffmpeg-supply-chain.test.mjs').length, 1)
  assert.equal(mjsFiles.filter((file) => file === 'scripts/worlds-codex-cli-package.test.mjs').length, 1)
  assert.equal(mjsFiles.filter((file) => file === 'tests/index-html-csp.test.mjs').length, 1)
  assert.equal(new Set(mjsFiles).size, mjsFiles.length)
  assert.deepEqual(mjsFiles, [...mjsFiles].sort((left, right) => left < right ? -1 : left > right ? 1 : 0))

  assert.equal(plan.length, typescriptFiles.length + mjsFiles.length)
  for (const invocation of plan) {
    assert.deepEqual(invocation.args.slice(0, 2), ['--test', '--test-concurrency=1'])
    assert.equal(invocation.args.some((argument) => argument.startsWith('--test-isolation')), false)
    assert.equal(invocation.args.at(-1), invocation.file)
    assert.equal(invocation.args.filter((argument) => argument === invocation.file).length, 1)
    if (invocation.phase === 'typescript') {
      assert.deepEqual(invocation.args.slice(3, 5), [
        '--experimental-loader',
        './scripts/node-ts-extensionless-loader.mjs',
      ])
    }
  }
})

test('Worlds script registration preserves canonical membership and includes Node-only authoring guards', async () => {
  const { createNodeTestPlan, collectWorldsTypeScriptTests } = await import('./run-node-tests.mjs')
  const plan = await createNodeTestPlan()
  const expectedScripts = [...EXPECTED_WORLDS_SCRIPT_TYPESCRIPT_TESTS, ...EXPECTED_WORLDS_SCRIPT_MJS_TESTS]
  const scriptFiles = plan.filter(({ file }) => /^scripts\/worlds?[-/]/.test(file)).map(({ file }) => file)
  assert.deepEqual(scriptFiles.toSorted(), expectedScripts.toSorted())
  for (const file of expectedScripts) {
    assert.equal(plan.filter((invocation) => invocation.file === file).length, 1, file)
  }
  const aiFiles = ['src/areas/worlds/core/worldAiContract.test.ts', 'src/areas/worlds/editor/worldAiChatAdapter.test.ts',
    'src/areas/worlds/components/WorldsAiDrawer.test.ts', 'electron/main/automation-http-bridge.test.ts', 'scripts/worlds-ai-electron-fixture.test.mjs']
  for (const file of aiFiles) assert.equal(plan.filter((entry) => entry.file === file).length, 1, file)
  assert.equal(plan.filter(({ file }) => !aiFiles.includes(file)).length, 208)
  assert.equal(plan.filter(({ file }) => file !== 'scripts/worlds-ai-electron-fixture.test.mjs').length, 212)
  assert.equal(plan.length, 213)
  assert.equal(plan.filter(({ phase }) => phase === 'typescript').length, 181)
  assert.equal(plan.filter(({ phase }) => phase === 'mjs').length, 32)
  assert.equal(new Set(plan.map(({ file }) => file)).size, plan.length)
  assert.equal((await collectWorldsTypeScriptTests()).length, 91)
})

test('Worlds MJS fixture entries receive TypeScript loader arguments without changing other entries or isolation', async () => {
  const { createNodeTestPlan } = await import('./run-node-tests.mjs')
  const plan = await createNodeTestPlan()
  const typescriptMjsFixtures = [
    'scripts/worlds-ai-electron-fixture.test.mjs',
    'scripts/worlds-authoring-electron-fixture/guards.test.mjs',
    'scripts/worlds-character-electron-fixture.test.mjs',
    'scripts/worlds-graphics-electron-fixture.test.mjs',
    'scripts/worlds-physics-electron-fixture.test.mjs',
  ]
  for (const file of typescriptMjsFixtures) {
    assert.equal(plan.filter((invocation) => invocation.phase === 'mjs' && invocation.file === file).length, 1, file)
  }
  for (const invocation of plan) {
    const commonArgs = ['--test', '--test-concurrency=1']
    const loaderArgs = invocation.phase === 'typescript' || typescriptMjsFixtures.includes(invocation.file)
      ? ['--experimental-strip-types', '--experimental-loader', './scripts/node-ts-extensionless-loader.mjs']
      : []
    const guardArgs = invocation.file === 'scripts/worlds-authoring-electron-fixture/guards.test.mjs'
      ? ['--test-reporter=tap'] : []
    assert.deepEqual(invocation.args, [...commonArgs, ...loaderArgs, ...guardArgs, invocation.file], invocation.file)
  }
})

test('node dispatch proof expects expanded authoring guard inventory instead of stale four-case fixture', async () => {
  const {
    assertAuthoringGuardInventory,
    createAuthoringGuardChildEnvironment,
    EXPECTED_AUTHORING_GUARD_TEST_COUNT,
    REQUIRED_AUTHORING_GUARD_TEST_NAMES,
  } = await import('./node-test-dispatch-proof.mjs')
  const tap = [
    'TAP version 13',
    ...REQUIRED_AUTHORING_GUARD_TEST_NAMES.map((name, index) => `ok ${index + 1} - ${name}`),
    ...Array.from(
      { length: EXPECTED_AUTHORING_GUARD_TEST_COUNT - REQUIRED_AUTHORING_GUARD_TEST_NAMES.length },
      (_, index) => `ok ${index + REQUIRED_AUTHORING_GUARD_TEST_NAMES.length + 1} - additional guard ${index + 1}`,
    ),
    `# tests ${EXPECTED_AUTHORING_GUARD_TEST_COUNT}`,
    `# pass ${EXPECTED_AUTHORING_GUARD_TEST_COUNT}`,
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
  ].join('\n')
  const spec = [
    ...REQUIRED_AUTHORING_GUARD_TEST_NAMES.map((name) => `✔ ${name} (1.0ms)`),
    ...Array.from(
      { length: EXPECTED_AUTHORING_GUARD_TEST_COUNT - REQUIRED_AUTHORING_GUARD_TEST_NAMES.length - 3 },
      (_, index) => `✔ additional guard ${index + 1} (1.0ms)`,
    ),
    '﹣ skipped guard 1 (0.1ms) # no-network',
    '﹣ skipped guard 2 (0.1ms) # no-network',
    '﹣ skipped guard 3 (0.1ms) # no-network',
    `ℹ tests ${EXPECTED_AUTHORING_GUARD_TEST_COUNT}`,
    `ℹ pass ${EXPECTED_AUTHORING_GUARD_TEST_COUNT - 3}`,
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ skipped 3',
  ].join('\n')

  const actualTapNames = assertAuthoringGuardInventory(tap)
  const actualSpecNames = assertAuthoringGuardInventory(spec)

  assert.equal(actualTapNames.length, EXPECTED_AUTHORING_GUARD_TEST_COUNT)
  assert.equal(actualSpecNames.length, EXPECTED_AUTHORING_GUARD_TEST_COUNT)
  for (const name of REQUIRED_AUTHORING_GUARD_TEST_NAMES) assert.ok(actualSpecNames.includes(name), name)
  assert.throws(() => assertAuthoringGuardInventory(tap.replace('N4 both authored scenes', 'N4 stale authored scenes')))
  assert.throws(() => assertAuthoringGuardInventory(REQUIRED_AUTHORING_GUARD_TEST_NAMES.map((name) => `✔ ${name} (1.0ms)`).join('\n')), /297/)

  const parentEnv = { PATH: '/bin', WORLD_AUTHORING_GUARD_TEST_ROOT: '/tmp/leaked-root' }
  const childEnv = createAuthoringGuardChildEnvironment(parentEnv)
  assert.deepEqual(parentEnv, { PATH: '/bin', WORLD_AUTHORING_GUARD_TEST_ROOT: '/tmp/leaked-root' })
  assert.equal(childEnv.WORLD_AUTHORING_GUARD_SKIP_NETWORK, '1')
  assert.equal(childEnv.WORLD_AUTHORING_GUARD_TEST_ROOT, undefined)
  const rootedChildEnv = createAuthoringGuardChildEnvironment(parentEnv, '/tmp/owned-root')
  assert.equal(rootedChildEnv.WORLD_AUTHORING_GUARD_TEST_ROOT, '/tmp/owned-root')
})

test('Node test discovery accepts 256 files and rejects 257 without bypassing the Worlds limit', async (t) => {
  const { createNodeTestPlan } = await import('./run-node-tests.mjs')
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'modly-node-runner-cap-'))
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }))
  await mkdir(join(repositoryRoot, 'electron', 'main'), { recursive: true })
  for (const file of EXPECTED_WORLDS_TYPESCRIPT_TESTS) {
    const target = join(repositoryRoot, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, '')
  }
  const repositoryUrl = pathToFileURL(`${repositoryRoot}/`)
  const baseline = await createNodeTestPlan(repositoryUrl)
  const additionalFiles = 256 - baseline.length
  assert.ok(additionalFiles > 0, 'The synthetic fixture must exercise the global limit through discovered files.')
  const overflowDirectory = join(repositoryRoot, 'src', 'runner-cap-contract')
  await mkdir(overflowDirectory, { recursive: true })
  for (let index = 0; index < additionalFiles; index += 1) {
    await writeFile(join(overflowDirectory, `case-${String(index).padStart(3, '0')}.test.mjs`), '')
  }
  assert.equal((await createNodeTestPlan(repositoryUrl)).length, 256)
  await writeFile(join(overflowDirectory, 'one-too-many.test.mjs'), '')
  await assert.rejects(createNodeTestPlan(repositoryUrl), /Node test plan exceeds its 256-file safety bound/)
})

test('Worlds TypeScript discovery is recursive, sorted, scoped, and accepts 128 but rejects 129 files', async (t) => {
  const { collectWorldsTypeScriptTests } = await import('./run-node-tests.mjs')
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'modly-node-runner-'))
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }))

  const worldsDirectory = join(repositoryRoot, 'src', 'areas', 'worlds')
  const adjacentDirectory = join(repositoryRoot, 'src', 'areas', 'generate')
  await mkdir(join(worldsDirectory, 'nested'), { recursive: true })
  await mkdir(adjacentDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(worldsDirectory, 'zeta.test.ts'), ''),
    writeFile(join(worldsDirectory, 'alpha.test.ts'), ''),
    writeFile(join(worldsDirectory, 'nested', 'beta.test.ts'), ''),
    writeFile(join(worldsDirectory, 'ignored.ts'), ''),
    writeFile(join(adjacentDirectory, 'must-not-be-discovered.test.ts'), ''),
  ])

  assert.deepEqual(
    await collectWorldsTypeScriptTests(pathToFileURL(`${repositoryRoot}/`)),
    [
      'src/areas/worlds/alpha.test.ts',
      'src/areas/worlds/nested/beta.test.ts',
      'src/areas/worlds/zeta.test.ts',
    ],
  )

  await Promise.all(Array.from({ length: 125 }, (_, index) => (
    writeFile(join(worldsDirectory, `overflow-${String(index).padStart(2, '0')}.test.ts`), '')
  )))
  assert.equal((await collectWorldsTypeScriptTests(pathToFileURL(`${repositoryRoot}/`))).length, 128)
  await writeFile(join(worldsDirectory, 'one-too-many.test.ts'), '')
  await assert.rejects(
    collectWorldsTypeScriptTests(pathToFileURL(`${repositoryRoot}/`)),
    /Worlds test discovery exceeds its 128-file safety bound/,
  )
})
