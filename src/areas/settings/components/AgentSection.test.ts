import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const agentSectionEntry = path.join(projectRoot, 'src/areas/settings/components/AgentSection.tsx')

interface TestElement {
  type: unknown
  key: unknown
  props: Record<string, unknown>
}

interface HookRuntime {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void]
  useRef<T>(initial: T): { current: T }
  useCallback<T>(callback: T, dependencies: readonly unknown[]): T
  useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void
  useLayoutEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void
}

function isTestElement(value: unknown): value is TestElement {
  return value !== null && typeof value === 'object' && 'type' in value && 'props' in value
}

function findElement(value: unknown, predicate: (element: TestElement) => boolean): TestElement | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findElement(entry, predicate)
      if (match) return match
    }
    return null
  }
  if (!isTestElement(value)) return null
  if (predicate(value)) return value
  return findElement(value.props.children, predicate)
}

function findElements(value: unknown, predicate: (element: TestElement) => boolean): TestElement[] {
  if (Array.isArray(value)) return value.flatMap((entry) => findElements(entry, predicate))
  if (!isTestElement(value)) return []
  return [
    ...(predicate(value) ? [value] : []),
    ...findElements(value.props.children, predicate),
  ]
}

function testRuntimePlugin(): Plugin {
  return {
    name: 'agent-section-test-runtime',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\/stores\/agentStore$/ }, () => ({ path: 'agent-store', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\/stores\/appStore$/ }, () => ({ path: 'app-store', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\/services\/llmDownloads$/ }, () => ({ path: 'llm-downloads', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\/components\/ui\/ModelLibraryModal$/ }, () => ({ path: 'model-library-modal', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\// }, (args) => buildApi.resolve(
        path.join(projectRoot, 'src/shared', args.path.slice('@shared/'.length)),
        { kind: args.kind, resolveDir: args.resolveDir },
      ))

      buildApi.onLoad({ filter: /.*/, namespace: 'agent-section-test' }, (args) => {
        if (args.path === 'react') {
          return { contents: `
            export function useState(initial) {
              return globalThis.__agentSectionTestHooks.useState(initial)
            }
            export function useRef(initial) {
              return globalThis.__agentSectionTestHooks.useRef(initial)
            }
            export function useCallback(callback, dependencies) {
              return globalThis.__agentSectionTestHooks.useCallback(callback, dependencies)
            }
            export function useEffect(effect, dependencies) {
              return globalThis.__agentSectionTestHooks.useEffect(effect, dependencies)
            }
            export function useLayoutEffect(effect, dependencies) {
              return globalThis.__agentSectionTestHooks.useLayoutEffect(effect, dependencies)
            }
          ` }
        }
        if (args.path === 'jsx-runtime') {
          return { contents: `
            export const Fragment = Symbol.for('agent-section-test.fragment')
            export function jsx(type, props, key) { return { type, props, key } }
            export const jsxs = jsx
          ` }
        }
        if (args.path === 'llm-downloads') {
          return { contents: `
            export function consumeSse() { throw new Error('Unexpected SSE install in model-discovery fixture') }
          ` }
        }
        if (args.path === 'model-library-modal') {
          return { contents: `
            export function ModelLibraryModal() { throw new Error('Unexpected model library in model-discovery fixture') }
          ` }
        }
        if (args.path === 'agent-store') {
          return { contents: `
            export const PROVIDERS = {
              local:      { label: 'Local (llama.cpp)', baseUrl: '' },
              // Ollama serves an OpenAI-compatible API — reuses models already pulled with it.
              ollama:     { label: 'Ollama',            baseUrl: 'http://localhost:11434/v1', noKey: true },
              openai:     { label: 'ChatGPT (OpenAI)',  baseUrl: 'https://api.openai.com/v1' },
              anthropic:  { label: 'Claude (Anthropic)', baseUrl: 'https://api.anthropic.com/v1' },
              mistral:    { label: 'Mistral',           baseUrl: 'https://api.mistral.ai/v1' },
              groq:       { label: 'Groq',              baseUrl: 'https://api.groq.com/openai/v1' },
              openrouter: { label: 'OpenRouter',        baseUrl: 'https://openrouter.ai/api/v1' },
              custom:     { label: 'Custom endpoint',   baseUrl: '' },
            }
            export function useAgentStore() {
              return {
                provider: 'ollama',
                localModel: 'qwen3-4b',
                external: { ollama: { apiKey: '', model: 'missing:latest' } },
                defaultThinking: 'auto',
                setProvider() {},
                setExternal() {},
                setDefaultThinking() {},
              }
            }
          ` }
        }
        return { contents: `
          export function useAppStore(selector) {
            return selector({ apiUrl: 'http://127.0.0.1:8000' })
          }
        ` }
      })
    },
  }
}

async function loadAgentSectionModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-agent-section-'))
  const outfile = path.join(tempDir, 'AgentSection.bundle.mjs')
  try {
    await build({
      entryPoints: [agentSectionEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [testRuntimePlugin()],
    })
    const module = await import(pathToFileURL(outfile).href)
    return {
      module,
      async cleanup() { await rm(tempDir, { recursive: true, force: true }) },
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

test('Settings Test consumes authoritative sorted model names before rendering select options', async () => {
  const states: unknown[] = []
  const callbacks = new Map<number, { dependencies: readonly unknown[]; callback: unknown }>()
  const effects = new Map<number, { dependencies?: readonly unknown[]; cleanup?: () => void }>()
  let cursor = 0
  const sameDependencies = (previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) => (
    previous !== undefined && next !== undefined && previous.length === next.length
      && previous.every((value, index) => Object.is(value, next[index]))
  )
  const runEffect: HookRuntime['useEffect'] = (effect, dependencies) => {
    const index = cursor++
    const previous = effects.get(index)
    if (previous && sameDependencies(previous.dependencies, dependencies)) return
    previous?.cleanup?.()
    const cleanup = effect()
    effects.set(index, { dependencies: dependencies?.slice(), cleanup: typeof cleanup === 'function' ? cleanup : undefined })
  }
  const hooks: HookRuntime = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [states[index] as T, (next) => {
        states[index] = typeof next === 'function' ? (next as (current: T) => T)(states[index] as T) : next
      }]
    },
    useRef<T>(initial: T) {
      const index = cursor++
      if (!(index in states)) states[index] = { current: initial }
      return states[index] as { current: T }
    },
    useCallback<T>(callback: T, dependencies: readonly unknown[]) {
      const index = cursor++
      const previous = callbacks.get(index)
      if (previous && sameDependencies(previous.dependencies, dependencies)) return previous.callback as T
      callbacks.set(index, { dependencies: dependencies.slice(), callback })
      return callback
    },
    useEffect: runEffect,
    useLayoutEffect: runEffect,
  }
  const testGlobal = globalThis as typeof globalThis & { __agentSectionTestHooks?: HookRuntime }
  const previousHooks = testGlobal.__agentSectionTestHooks
  const previousFetch = globalThis.fetch
  testGlobal.__agentSectionTestHooks = hooks
  const unexpectedRequests: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    let payload: unknown
    if (url === 'http://127.0.0.1:8000/agent/external/models' && method === 'POST') {
      assert.deepEqual(JSON.parse(String(init?.body)), { base_url: 'http://localhost:11434/v1', api_key: '' })
      payload = { models: ['devstral:latest', 'qwen3.6:latest'] }
    } else if (url === 'http://127.0.0.1:8000/llm/status' && method === 'GET') {
      payload = { binary_installed: true }
    } else if (url === 'http://127.0.0.1:8000/llm/models?downloaded=true' && method === 'GET') {
      payload = { models: [] }
    } else if (url === 'http://127.0.0.1:8000/llm/config' && method === 'GET') {
      payload = { max_models: 'auto', resolved_max_models: 1, vram_gb: 8 }
    } else {
      unexpectedRequests.push(`${method} ${url}`)
      throw new Error(`Unexpected model-discovery fixture request: ${method} ${url}`)
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  let cleanup: (() => Promise<void>) | undefined
  try {
    const loaded = await loadAgentSectionModule()
    const { module } = loaded
    cleanup = loaded.cleanup
    const render = () => {
      cursor = 0
      return module.AgentSection()
    }
    const initialTree = render()
    const testButton = findElement(initialTree, (element) => (
      element.type === 'button' && element.props.children === 'Test'
    ))
    assert.ok(testButton)
    await (testButton.props.onClick as () => Promise<void>)()

    const updatedTree = render()
    const modelBlock = findElement(updatedTree, (element) => element.props.label === 'Model')
    assert.ok(modelBlock)
    const select = findElement(modelBlock, (element) => element.type === 'select')
    assert.ok(select)
    assert.equal(select.props.value, 'devstral:latest')
    const options = findElements(select, (element) => element.type === 'option')
    assert.deepEqual(options.map((option) => option.props.children), [
      'devstral:latest',
      'qwen3.6:latest',
    ])
    assert.deepEqual(options.map((option) => option.props.value), [
      'devstral:latest',
      'qwen3.6:latest',
    ])
    assert.deepEqual(options.map((option) => option.key), [
      'devstral:latest',
      'qwen3.6:latest',
    ])
    assert.deepEqual(unexpectedRequests, [])
  } finally {
    try {
      for (const effect of effects.values()) effect.cleanup?.()
      await cleanup?.()
    } finally {
      if (previousHooks === undefined) Reflect.deleteProperty(testGlobal, '__agentSectionTestHooks')
      else testGlobal.__agentSectionTestHooks = previousHooks
      globalThis.fetch = previousFetch
    }
  }
})
