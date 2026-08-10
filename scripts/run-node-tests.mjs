#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_TEST_FILES = 128
const TYPESCRIPT_TEST_FILES = [
  'src/shared/types/assetLibrary.test.ts',
  'src/shared/utils/agentModels.test.ts',
  'src/shared/stores/agentSessionsStore.test.ts',
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

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function collectTests(directory, recursive) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => codeUnitCompare(left.name, right.name))) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path)
    else if (recursive && entry.isDirectory()) files.push(...await collectTests(path, true))
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

export async function createNodeTestPlan(repositoryRootUrl = new URL('../', import.meta.url)) {
  const repositoryRoot = resolve(fileURLToPath(repositoryRootUrl))
  const mjsFiles = [
    join(repositoryRoot, 'scripts', 'test-runner-contract.test.mjs'),
    ...await collectTests(join(repositoryRoot, 'electron', 'main'), false),
    ...await collectTests(join(repositoryRoot, 'src'), true),
  ]
    .map((path) => toRepositoryPath(repositoryRoot, path))
    .sort(codeUnitCompare)

  if (new Set(TYPESCRIPT_TEST_FILES).size !== TYPESCRIPT_TEST_FILES.length
    || new Set(mjsFiles).size !== mjsFiles.length) {
    throw new Error('Node test plan contains a duplicate file')
  }
  if (TYPESCRIPT_TEST_FILES.length + mjsFiles.length > MAX_TEST_FILES) {
    throw new Error(`Node test plan exceeds its ${MAX_TEST_FILES}-file safety bound`)
  }

  const commonArgs = ['--test', '--test-concurrency=1']
  return [
    ...TYPESCRIPT_TEST_FILES.map((file) => ({
      phase: 'typescript',
      file,
      args: [
        ...commonArgs,
        '--experimental-strip-types',
        '--experimental-loader',
        './scripts/node-ts-extensionless-loader.mjs',
        file,
      ],
    })),
    ...mjsFiles.map((file) => ({ phase: 'mjs', file, args: [...commonArgs, file] })),
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

export async function runNodeTests(repositoryRootUrl = new URL('../', import.meta.url)) {
  const repositoryRoot = resolve(fileURLToPath(repositoryRootUrl))
  const plan = await createNodeTestPlan(repositoryRootUrl)
  await runNodeTestPlan(plan, repositoryRoot)
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
