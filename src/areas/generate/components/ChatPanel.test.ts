import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { JSDOM } from 'jsdom'
import React from 'react'

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
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-chat-panel-'))
  const outfile = path.join(tempDir, 'ChatPanel.bundle.mjs')
  const previousLocalStorage = globalThis.localStorage
  globalThis.localStorage = localStorageMock()

  try {
    // Resolve external dependencies read-only without emitting into the checkout.
    await symlink(path.join(projectRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
    await build({
      stdin: {
        contents: [
          `export * from ${JSON.stringify(chatPanelEntry)}`,
          `export { default } from ${JSON.stringify(chatPanelEntry)}`,
          `export { useAgentStore } from ${JSON.stringify(path.join(projectRoot, 'src/shared/stores/agentStore.ts'))}`,
          `export { useAppStore } from ${JSON.stringify(path.join(projectRoot, 'src/shared/stores/appStore.ts'))}`,
          `export { useLlmModelsStore } from ${JSON.stringify(path.join(projectRoot, 'src/shared/stores/llmModelsStore.ts'))}`,
        ].join('\n'),
        resolveDir: projectRoot,
        sourcefile: 'ChatPanel.fixture.ts',
        loader: 'ts',
      },
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

for (const provider of ['local', 'custom'] as const) {
  test(`${provider} selection sends its current model, provider and full image data URL`, async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://fixture.test/' })
    const dataUrl = 'data:image/png;base64,AAAA'
    const globals: Record<string, unknown> = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      Node: dom.window.Node,
      Event: dom.window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
      FileReader: class {
        onload?: (event: { target: { result: string } }) => void
        readAsDataURL() { this.onload?.({ target: { result: dataUrl } }) }
      },
    }
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
    const previousFetch = globalThis.fetch
    let loaded: Awaited<ReturnType<typeof loadChatPanelModule>> | undefined
    let root: ReturnType<typeof import('react-dom/client').createRoot> | undefined
    const calls: Array<Record<string, unknown>> = []
    try {
      for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
      dom.window.HTMLElement.prototype.scrollIntoView = () => {}
      loaded = await loadChatPanelModule()
      const { module } = loaded
      module.useAppStore.setState({ apiUrl: 'http://backend.fixture.test' })
      module.useLlmModelsStore.setState({
        fetchedApiUrl: 'http://backend.fixture.test',
        models: [
          { id: 'first-local', name: 'First Local', downloaded: true, tags: [] },
          { id: 'selected-local', name: 'Selected Local', downloaded: true, tags: [] },
          { id: 'cad-tool', name: 'CAD Tool', downloaded: true, tags: ['cad'] },
        ],
      })
      module.useAgentStore.setState({
        provider,
        localModel: 'first-local',
        external: { custom: { model: 'selected-external', baseUrl: 'https://custom.fixture.test/compatible', apiKey: 'fixture-key' } },
      })
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), 'http://backend.fixture.test/agent/chat')
        assert.equal(init?.method, 'POST')
        calls.push(JSON.parse(String(init?.body)))
        return { ok: true, status: 200, json: async () => ({ message: 'Fixture response.', actions: [] }) } as Response
      }
      const { createRoot } = await import('react-dom/client')
      const container = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(container)
      root = createRoot(container)
      await React.act(async () => { root!.render(React.createElement(module.default)) })
      const selectButton = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(provider === 'local' ? 'First Local' : 'selected-external'),
      )
      assert.ok(selectButton)
      await React.act(async () => { selectButton.click() })
      if (provider === 'local') {
        assert.equal(container.textContent?.includes('CAD Tool'), false)
        const selected = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Selected Local'))
        assert.ok(selected)
        await React.act(async () => { selected.click() })
      } else {
        assert.ok(container.textContent?.includes('change the model in Settings'))
      }
      const fileInput = container.querySelector('input[type=file]')!
      Object.defineProperty(fileInput, 'files', { value: [new dom.window.File(['synthetic'], 'fixture.png', { type: 'image/png' })] })
      await React.act(async () => { fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
      const textarea = container.querySelector('textarea')!
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
      await React.act(async () => {
        setValue.call(textarea, 'Inspect this image.')
        textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const send = container.querySelector('button.bg-accent') as HTMLButtonElement
      assert.ok(send)
      assert.equal(send.disabled, false)
      await React.act(async () => { send.click() })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].model, provider === 'local' ? 'selected-local' : 'selected-external')
      assert.deepEqual(calls[0].provider, provider === 'local'
        ? { type: 'local' }
        : { type: 'external', base_url: 'https://custom.fixture.test/compatible', api_key: 'fixture-key' })
      assert.deepEqual((calls[0].messages as Array<{ images?: string[] }>)[0].images, [dataUrl])
      assert.equal('ollama_url' in calls[0], false)
    } finally {
      if (root) await React.act(async () => { root!.unmount() })
      await loaded?.cleanup()
      globalThis.fetch = previousFetch
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      dom.window.close()
    }
  })
}
