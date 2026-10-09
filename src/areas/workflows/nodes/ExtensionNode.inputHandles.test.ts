import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'
import type { ExtensionNode as ManifestNode, ProcessExtension, WFNodeData } from '../../../shared/types/electron.d.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const componentEntry = path.join(projectRoot, 'src/areas/workflows/nodes/ExtensionNode.tsx')

test('actual ExtensionNode renders singleton physical ids, anonymous scalar and unshifted positional gaps', async () => {
  // Keep the actual ESM Flow provider, node wrapper and Handle in the render path.
  const xyflow = await import(fileURLToPath(import.meta.resolve('@xyflow/react')))
  const require = createRequire(import.meta.url)
  const manifestNode: ManifestNode = { id: 'run', name: 'Fixture run', input: 'image', output: 'mesh', paramsSchema: [] }
  const extension: ProcessExtension = {
    type: 'process', id: 'fixture', name: 'Fixture', entry: 'processor.js',
    trusted: false, builtin: false, nodes: [manifestNode],
  }
  const fixtureState = { modelExtensions: [], processExtensions: [extension], installedWeightVariants: {} }
  const unexpectedCalls: string[] = []
  const result = await build({
    entryPoints: [componentEntry], write: false, bundle: true, format: 'cjs', platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/*', 'react-dom/server', '@xyflow/react'],
    plugins: [{
      name: 'inert-extension-node-stores',
      setup(builder) {
        builder.onResolve({ filter: /^@shared\/stores\/(extensionsStore|navStore)$/ }, (args) => ({ path: args.path, namespace: 'fixture-store' }))
        builder.onResolve({ filter: /^\.\.\/workflowRunStore$/ }, (args) => args.importer === componentEntry
          ? { path: args.path, namespace: 'fixture-store' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'fixture-store' }, (args) => ({
          loader: 'js',
          contents: args.path.endsWith('extensionsStore')
            ? 'export const useExtensionsStore = (selector) => selector ? selector(fixtureState) : fixtureState'
            : args.path.endsWith('navStore')
              ? 'export const useNavStore = (selector) => selector({ openExtension: () => unexpectedCalls.push("openExtension") })'
              : 'export const useWorkflowRunStore = (selector) => selector({ activeNodeId: null }); useWorkflowRunStore.getState = () => ({ setLiveNodeParams: () => unexpectedCalls.push("setLiveNodeParams") })',
        }))
      },
    }],
  })
  const module = { exports: {} as { default: React.ComponentType<{ id: string; data: WFNodeData }> } }
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports,
    require: (id: string) => id === '@xyflow/react' ? xyflow : require(id),
    fixtureState, unexpectedCalls, console, process,
  })
  assert.equal(typeof module.exports.default, 'function')

  const cases: { label: string; inputs?: ManifestNode['inputs']; targetIds: (string | null)[] }[] = [
    { label: 'true scalar', targetIds: [null] },
    { label: 'singleton positional', inputs: ['image'], targetIds: ['input-0'] },
    { label: 'physical gap', inputs: ['image', '', 'mesh'], targetIds: ['input-0', 'input-1', 'input-2'] },
    { label: 'named PROCESS singleton', inputs: [{ name: 'reference_image', type: 'image' }], targetIds: ['reference_image'] },
  ]
  for (const { label, inputs, targetIds } of cases) {
    if (inputs === undefined) delete manifestNode.inputs
    else manifestNode.inputs = inputs
    const nodes = [{
      id: 'fixture-node', type: 'extensionNode', position: { x: 0, y: 0 }, width: 220, height: 160,
      data: { extensionId: 'fixture/run', enabled: true, params: {} },
    }]
    const flowErrors: string[] = []
    const markup = renderToStaticMarkup(React.createElement(xyflow.ReactFlowProvider, {
      initialNodes: nodes, initialEdges: [], initialWidth: 800, initialHeight: 600,
    }, React.createElement(xyflow.ReactFlow, {
      nodes, edges: [], width: 800, height: 600,
      nodeTypes: { extensionNode: module.exports.default },
      onError: (code: string, message: string) => flowErrors.push(`${code}: ${message}`),
    })))
    assert.match(markup, /data-testid="rf__node-fixture-node"/, label)
    assert.match(markup, /Fixture run/, label)
    const handles = [...markup.matchAll(/<div\b[^>]*\bclass="[^"]*\breact-flow__handle\b[^"]*"[^>]*>/g)]
    const handleIds = (type: 'target' | 'source') => handles
      .filter(([tag]) => new RegExp(`class="[^"]*\\b${type}\\b`).test(tag))
      .map(([tag]) => {
        assert.match(tag, /data-nodeid="fixture-node"/, label)
        return /data-handleid="([^"]*)"/.exec(tag)?.[1] ?? null
      })
    assert.deepEqual(handleIds('target'), targetIds, label)
    assert.deepEqual(handleIds('source'), [null], label)
    assert.deepEqual(flowErrors, [], label)
  }
  assert.deepEqual(unexpectedCalls, [])
})
