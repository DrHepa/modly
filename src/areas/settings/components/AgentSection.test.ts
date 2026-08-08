import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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
  useEffect(effect: () => void): void
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

function resolveSource(basePath: string): string {
  if (existsSync(basePath) && statSync(basePath).isFile()) return basePath
  for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
    const candidate = `${basePath}${extension}`
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return basePath
}

function testRuntimePlugin(): Plugin {
  return {
    name: 'agent-section-test-runtime',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\/stores\/agentStore$/ }, () => ({ path: 'agent-store', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\/stores\/appStore$/ }, () => ({ path: 'app-store', namespace: 'agent-section-test' }))
      buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolveSource(path.join(projectRoot, 'src/shared', args.path.slice('@shared/'.length))),
      }))

      buildApi.onLoad({ filter: /.*/, namespace: 'agent-section-test' }, (args) => {
        if (args.path === 'react') {
          return { contents: `
            export function useState(initial) {
              return globalThis.__agentSectionTestHooks.useState(initial)
            }
            export function useEffect(effect) {
              return globalThis.__agentSectionTestHooks.useEffect(effect)
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
        if (args.path === 'agent-store') {
          return { contents: `
            export function useAgentStore() {
              return {
                ollamaUrl: 'http://localhost:11434',
                defaultModel: 'missing:latest',
                defaultThinking: 'auto',
                setOllamaUrl() {},
                setDefaultModel() {},
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
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-agent-section-'))
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

test('Settings Test normalizes authoritative model objects before rendering select options', async () => {
  const states: unknown[] = []
  let cursor = 0
  const hooks: HookRuntime = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
      return [states[index] as T, (next) => {
        states[index] = typeof next === 'function' ? (next as (current: T) => T)(states[index] as T) : next
      }]
    },
    useEffect(effect) { effect() },
  }
  const testGlobal = globalThis as typeof globalThis & { __agentSectionTestHooks?: HookRuntime }
  const previousHooks = testGlobal.__agentSectionTestHooks
  const previousFetch = globalThis.fetch
  testGlobal.__agentSectionTestHooks = hooks
  globalThis.fetch = (async () => ({
    json: async () => ({
      models: [
        { name: 'qwen3.6:latest', digest: `sha256:${'a'.repeat(64)}` },
        { name: 'devstral:latest', digest: `sha256:${'b'.repeat(64)}` },
      ],
    }),
  })) as unknown as typeof fetch

  const { module, cleanup } = await loadAgentSectionModule()
  try {
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
    const select = findElement(updatedTree, (element) => element.type === 'select')
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
  } finally {
    await cleanup()
    if (previousHooks === undefined) Reflect.deleteProperty(testGlobal, '__agentSectionTestHooks')
    else testGlobal.__agentSectionTestHooks = previousHooks
    globalThis.fetch = previousFetch
  }
})
