import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const chatPanelEntry = path.join(projectRoot, 'src/areas/generate/components/ChatPanel.tsx')

function aliasPlugin(): Plugin {
  const resolvePath = (basePath: string): string => {
    if (existsSync(basePath) && statSync(basePath).isFile()) return basePath
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = `${basePath}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    return basePath
  }

  return {
    name: 'modly-aliases',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/shared', args.path.slice('@shared/'.length))),
      }))
      buildApi.onResolve({ filter: /^@areas\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/areas', args.path.slice('@areas/'.length))),
      }))
    },
  }
}

function localStorageMock(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key) { return values.get(key) ?? null },
    key(index) { return [...values.keys()][index] ?? null },
    removeItem(key) { values.delete(key) },
    setItem(key, value) { values.set(key, value) },
  }
}

async function loadChatPanelModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-chat-panel-'))
  const outfile = path.join(tempDir, 'ChatPanel.bundle.mjs')
  const previousLocalStorage = globalThis.localStorage
  globalThis.localStorage = localStorageMock()

  try {
    await build({
      entryPoints: [chatPanelEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [aliasPlugin()],
    })
    const module = await import(pathToFileURL(outfile).href)
    return {
      module,
      async cleanup() {
        if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
        else globalThis.localStorage = previousLocalStorage
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (previousLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else globalThis.localStorage = previousLocalStorage
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

test('structured agent failures expose safe copy and completed actions', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const partialAction = {
      tool: 'smooth_mesh',
      result: 'Smoothed mesh.',
      payload: { type: 'mesh_update', url: '/workspace/smoothed.glb' },
    }
    const response = {
      ok: false,
      status: 504,
      json: async () => ({
        detail: {
          code: 'ollama_timeout',
          message: 'Ollama stopped sending data. Try again.',
          retryable: true,
          round: 2,
          actions: [partialAction],
        },
      }),
    }

    await assert.rejects(module.parseAgentChatResponse(response), (error: unknown) => {
      assert.ok(error instanceof module.AgentApiError)
      const agentError = error as Error & { actions: unknown[] }
      assert.equal(agentError.message, 'Ollama stopped sending data. Try again.')
      assert.deepEqual(agentError.actions, [partialAction])
      return true
    })
  } finally {
    await cleanup()
  }
})

test('action application attempts every returned action exactly once after a handler rejection', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const actions = [
      { tool: 'list_models', result: 'first', payload: null },
      { tool: 'smooth_mesh', result: 'second', payload: { type: 'mesh_update', url: '/second.glb' } },
      { tool: 'list_processes', result: 'third', payload: null },
    ]
    const attempts = new Map<string, number>()
    const failures = await module.applyAgentActions(actions, async (action: { tool: string }) => {
      attempts.set(action.tool, (attempts.get(action.tool) ?? 0) + 1)
      if (action.tool === 'smooth_mesh') throw new Error('local reflection failed')
    })

    assert.deepEqual(Object.fromEntries(attempts), {
      list_models: 1,
      smooth_mesh: 1,
      list_processes: 1,
    })
    assert.equal(failures.length, 1)
    assert.equal(failures[0].action.tool, 'smooth_mesh')
    assert.equal(
      module.withActionFailureSummary('Original server error.', failures.length),
      'Original server error. 1 completed action could not be reflected locally.',
    )
  } finally {
    await cleanup()
  }
})

test('failed-turn workflows suppress agent re-entry while successful workflows retain follow-up', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    assert.equal(module.shouldNotifyAgentAfterWorkflowCompletion({
      id: 'wf-failed-turn',
      name: 'Failed turn workflow',
      notifyAgentOnCompletion: false,
    }), false)
    assert.equal(module.shouldNotifyAgentAfterWorkflowCompletion({
      id: 'wf-success-turn',
      name: 'Successful turn workflow',
      notifyAgentOnCompletion: true,
    }), true)
  } finally {
    await cleanup()
  }
})

test('response guards reject malformed success actions and drop malformed error actions safely', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    await assert.rejects(
      module.parseAgentChatResponse({
        ok: true,
        status: 200,
        json: async () => ({
          message: 'Unsafe payload',
          actions: [{ tool: 'smooth_mesh', result: 'bad', payload: { type: 'mesh_update', url: 42 } }],
        }),
      }),
      /invalid agent response/i,
    )

    await assert.rejects(
      module.parseAgentChatResponse({
        ok: false,
        status: 504,
        json: async () => ({
          detail: {
            message: 'Original structured error.',
            actions: [
              { tool: 'list_models', result: '{}', payload: null },
              { tool: 'run_workflow', result: 'bad', payload: { type: 'run_workflow', workflow_id: 7 } },
            ],
          },
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof module.AgentApiError)
        const agentError = error as Error & { actions: Array<{ tool: string }> }
        assert.equal(agentError.message, 'Original structured error.')
        assert.deepEqual(agentError.actions.map((action) => action.tool), ['list_models'])
        return true
      },
    )
  } finally {
    await cleanup()
  }
})

test('submitted messages remain in history and loading clears after request failure', async () => {
  const { module, cleanup } = await loadChatPanelModule()
  try {
    const original = [{ id: 'a', content: 'Earlier message' }]
    const submitted = { id: 'u', content: 'Retry this request' }
    const next = module.appendSubmittedMessage(original, submitted)
    assert.deepEqual(next, [...original, submitted])
    assert.deepEqual(original, [{ id: 'a', content: 'Earlier message' }])

    const loadingStates: boolean[] = []
    await assert.rejects(
      module.withAgentLoading(
        (loading: boolean) => loadingStates.push(loading),
        async () => { throw new Error('request failed') },
      ),
      /request failed/,
    )
    assert.deepEqual(loadingStates, [true, false])
  } finally {
    await cleanup()
  }
})
