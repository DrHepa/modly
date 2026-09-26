#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Keep discovery finite while covering the complete Worlds inventory; per-file isolation is unchanged.
const MAX_TEST_FILES = 256
const MAX_WORLDS_TYPESCRIPT_TEST_FILES = 128
export const REQUIRED_WORLDS_CINEMATIC_TYPESCRIPT_TESTS = Object.freeze([
  'src/areas/worlds/cinematic/worldRationalTime.test.ts',
  'src/areas/worlds/cinematic/worldSequenceEvaluator.test.ts',
  'src/areas/worlds/cinematic/worldSequencePreflight.test.ts',
  'src/areas/worlds/components/WorldsTimelineDrawer.test.ts',
  'src/areas/worlds/editor/worldTimelineModel.test.ts',
  'src/areas/worlds/editor/worldTimelinePreview.test.ts',
])
export const REQUIRED_WORLDS_PLAY_TYPESCRIPT_TESTS = Object.freeze([
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
export const REQUIRED_WORLDS_RENDER_TYPESCRIPT_TESTS = Object.freeze([
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
const TYPESCRIPT_TEST_FILES = [
  'src/shared/types/assetLibrary.test.ts',
  'src/shared/types/worldProjects.test.ts',
  'src/shared/types/worldRenderHost.test.ts',
  'src/shared/types/worldRenders.test.ts',
  'src/shared/utils/agentModels.test.ts',
  'src/shared/stores/agentSessionsStore.test.ts',
  'src/shared/stores/navStore.test.ts',
  'src/shared/components/ui/Tooltip.test.ts',
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
  'scripts/worlds-character-electron-fixture/nativeKeyboard.test.ts',
]

const TYPESCRIPT_MJS_TEST_FILES = new Set([
  'scripts/worlds-ai-electron-fixture.test.mjs',
  'scripts/worlds-authoring-electron-fixture/guards.test.mjs',
  'scripts/worlds-character-electron-fixture.test.mjs',
  'scripts/worlds-graphics-electron-fixture.test.mjs',
  'scripts/worlds-physics-electron-fixture.test.mjs',
])

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function collectTests(directory, recursive, suffix, options = {}, files = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => codeUnitCompare(left.name, right.name))) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      files.push(path)
      if (files.length > (options.maximum ?? Number.POSITIVE_INFINITY)) {
        throw new Error(options.overflowMessage ?? 'Node test discovery exceeded its safety bound')
      }
    } else if (recursive && entry.isDirectory()) {
      await collectTests(path, true, suffix, options, files)
    }
  }
  return files
}

function toRepositoryPath(repositoryRoot, path) {
  const candidate = relative(repositoryRoot, path).split(sep).join('/')
  if (!candidate || candidate === '..' || candidate.startsWith('../')) {
    throw new Error(`Node test path escaped the repository: ${path}`)
  }
  return candidate
}

export async function collectWorldsTypeScriptTests(
  repositoryRootUrl = new URL('../', import.meta.url),
) {
  const repositoryRoot = resolve(fileURLToPath(repositoryRootUrl))
  const files = (await collectTests(
    join(repositoryRoot, 'src', 'areas', 'worlds'),
    true,
    '.test.ts',
    {
      maximum: MAX_WORLDS_TYPESCRIPT_TEST_FILES,
      overflowMessage:
        `Worlds test discovery exceeds its ${MAX_WORLDS_TYPESCRIPT_TEST_FILES}-file safety bound`,
    },
  ))
    .map((path) => toRepositoryPath(repositoryRoot, path))
    .sort(codeUnitCompare)

  return files
}

export async function createNodeTestPlan(repositoryRootUrl = new URL('../', import.meta.url)) {
  const repositoryRoot = resolve(fileURLToPath(repositoryRootUrl))
  const worldsTypeScriptFiles = await collectWorldsTypeScriptTests(repositoryRootUrl)
  for (const required of [...REQUIRED_WORLDS_PLAY_TYPESCRIPT_TESTS, ...REQUIRED_WORLDS_CINEMATIC_TYPESCRIPT_TESTS]) {
    if (!worldsTypeScriptFiles.includes(required)) {
      throw new Error(`Node test plan is missing required Worlds suite: ${required}`)
    }
  }
  const typescriptFiles = [...TYPESCRIPT_TEST_FILES, ...worldsTypeScriptFiles]
  for (const required of REQUIRED_WORLDS_RENDER_TYPESCRIPT_TESTS) {
    if (!typescriptFiles.includes(required)) {
      throw new Error(`Node test plan is missing required Worlds render suite: ${required}`)
    }
  }
  const mjsFiles = [
    join(repositoryRoot, 'scripts', 'platform-contract.test.mjs'),
    join(repositoryRoot, 'scripts', 'test-runner-contract.test.mjs'),
    join(repositoryRoot, 'scripts', 'run-typechecks.test.mjs'),
    join(repositoryRoot, 'scripts', 'setup-hooks.test.mjs'),
    join(repositoryRoot, 'scripts', 'world-ffmpeg-custody-convergence.test.mjs'),
    join(repositoryRoot, 'scripts', 'world-ffmpeg-linux-arm64.test.mjs'),
    join(repositoryRoot, 'scripts', 'world-ffmpeg-recovery-preflight.test.mjs'),
    join(repositoryRoot, 'scripts', 'world-ffmpeg-supply-chain.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-ai-electron-fixture.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-authoring-electron-fixture', 'guards.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-character-electron-fixture.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-character-electron-fixture', 'observer.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-command-latency.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-command-profile.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-command-profile.contract.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-command-storage-ab.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-codex-cli-package.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-codex-direct-edit-electron-fixture.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-graphics-electron-fixture.test.mjs'),
    join(repositoryRoot, 'scripts', 'worlds-physics-electron-fixture.test.mjs'),
    join(repositoryRoot, 'tests', 'index-html-csp.test.mjs'),
    ...await collectTests(join(repositoryRoot, 'electron', 'main'), false, '.test.mjs'),
    ...await collectTests(join(repositoryRoot, 'src'), true, '.test.mjs'),
  ]
    .map((path) => toRepositoryPath(repositoryRoot, path))
    .sort(codeUnitCompare)

  if (new Set(typescriptFiles).size !== typescriptFiles.length
    || new Set(mjsFiles).size !== mjsFiles.length) {
    throw new Error('Node test plan contains a duplicate file')
  }
  if (typescriptFiles.length + mjsFiles.length > MAX_TEST_FILES) {
    throw new Error(`Node test plan exceeds its ${MAX_TEST_FILES}-file safety bound`)
  }

  const commonArgs = ['--test', '--test-concurrency=1']
  const typescriptArgs = [
    ...commonArgs,
    '--experimental-strip-types',
    '--experimental-loader',
    './scripts/node-ts-extensionless-loader.mjs',
  ]
  return [
    ...typescriptFiles.map((file) => ({
      phase: 'typescript',
      file,
      args: [...typescriptArgs, file],
    })),
    ...mjsFiles.map((file) => ({
      phase: 'mjs',
      file,
      // Keep the guard's named execution evidence machine-readable without changing per-file isolation.
      args: [...(TYPESCRIPT_MJS_TEST_FILES.has(file) ? typescriptArgs : commonArgs),
        ...(file === 'scripts/worlds-authoring-electron-fixture/guards.test.mjs'
          ? ['--test-reporter=tap'] : []), file],
    })),
  ]
}

async function runInvocation(invocation, repositoryRoot, spawnProcess) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(process.execPath, invocation.args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${invocation.file} terminated by ${signal}`))
      } else if (code !== 0) {
        const error = new Error(`${invocation.file} failed with exit code ${String(code)}`)
        error.exitCode = code ?? 1
        rejectPromise(error)
      } else {
        resolvePromise()
      }
    })
  })
}

export async function runNodeTestPlan(plan, repositoryRoot, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn
  const write = options.write ?? ((value) => process.stdout.write(value))
  for (const [index, invocation] of plan.entries()) {
    write(`[test:node] ${index + 1}/${plan.length} ${invocation.phase}: ${invocation.file}\n`)
    await runInvocation(invocation, repositoryRoot, spawnProcess)
  }
}

export async function runNodeTests(repositoryRootUrl = new URL('../', import.meta.url), options = {}) {
  // Trusted unit-test seam only, not CLI flags or environment controls. Production always runs the full proof.
  const dispatchProof = options.dispatchProof ?? (async (dependencies) => {
    const { runNodeTestDispatchProof } = await import('./node-test-dispatch-proof.mjs')
    await runNodeTestDispatchProof(dependencies)
  })
  await dispatchProof({ createNodeTestPlan, runNodeTestPlan })
  const repositoryRoot = resolve(fileURLToPath(repositoryRootUrl))
  const plan = await createNodeTestPlan(repositoryRootUrl)
  await runNodeTestPlan(plan, repositoryRoot, options.runnerOptions)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    await runNodeTests()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = error && typeof error === 'object' && Number.isInteger(error.exitCode)
      ? error.exitCode
      : 1
  }
}
