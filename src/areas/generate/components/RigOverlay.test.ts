import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { RigSelectionOverlayViewModel } from '../rigSkeleton.ts'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const rigOverlayEntry = path.join(projectRoot, 'src/areas/generate/components/RigOverlay.tsx')

function aliasPlugin(): Plugin {
  const resolvePath = (basePath: string): string => {
    if (existsSync(basePath) && statSync(basePath).isFile()) return basePath
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = `${basePath}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    if (existsSync(basePath) && statSync(basePath).isDirectory()) {
      for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = path.join(basePath, `index${extension}`)
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      }
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
      buildApi.onResolve({ filter: /^@\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src', args.path.slice('@/'.length))),
      }))
    },
  }
}

async function loadRigOverlayModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-rig-overlay-'))
  const outfile = path.join(tempDir, 'RigOverlay.bundle.mjs')

  try {
    await build({
      entryPoints: [rigOverlayEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [aliasPlugin(), { name: 'canonical-react', setup(builder) {
        builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }))
      } }],
    })

    const module = await import(pathToFileURL(outfile).href)

    return {
      module,
      async cleanup() {
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

const overlayViewModel: RigSelectionOverlayViewModel = {
  selectedBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
  selectedLabel: 'Spine',
  parentBoneId: 'rig:hero|skeleton:0|bone:hips#0',
  childBoneIds: [
    'rig:hero|skeleton:0|bone:hips#0/spine#0/head#0',
    'rig:hero|skeleton:0|bone:hips#0/spine#0/left_arm#0',
  ],
  highlightedBoneIds: [
    'rig:hero|skeleton:0|bone:hips#0/spine#0',
    'rig:hero|skeleton:0|bone:hips#0',
    'rig:hero|skeleton:0|bone:hips#0/spine#0/head#0',
    'rig:hero|skeleton:0|bone:hips#0/spine#0/left_arm#0',
  ],
  connections: [
    { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', relation: 'parent' },
    { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0/head#0', relation: 'child' },
    { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0/left_arm#0', relation: 'child' },
  ],
}

function renderOverlay(RigOverlay: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(RigOverlay, props))
}

function findElementByAriaLabel(node: unknown, ariaLabel: string): React.ReactElement | undefined {
  if (!isValidElement(node)) return undefined
  if ((node.props as { 'aria-label'?: string })['aria-label'] === ariaLabel) return node

  if (typeof node.type === 'function') {
    const renderFunction = node.type as (props: unknown) => React.ReactNode
    return findElementByAriaLabel(renderFunction(node.props), ariaLabel)
  }

  const children = (node.props as { children?: unknown }).children
  const childList = Array.isArray(children) ? children : [children]
  for (const child of childList) {
    const found = findElementByAriaLabel(child, ariaLabel)
    if (found) return found
  }
  return undefined
}

function findConnectionItemByText(node: unknown, text: string): React.ReactElement | undefined {
  if (!isValidElement(node)) return undefined

  if (typeof node.type === 'function') {
    const renderFunction = node.type as (props: unknown) => React.ReactNode
    return findConnectionItemByText(renderFunction(node.props), text)
  }

  const children = (node.props as { children?: unknown }).children
  const childList = Array.isArray(children) ? children : [children]
  if (node.type === 'li' && childList.some((child) => child === text)) return node

  for (const child of childList) {
    const found = findConnectionItemByText(child, text)
    if (found) return found
  }
  return undefined
}

test('RigOverlay renders selected bone affordance, label, and immediate parent/child connections only', async () => {
  const { module, cleanup } = await loadRigOverlayModule()

  try {
    const html = renderOverlay(module.RigOverlay, { overlay: overlayViewModel, onSelectBone: () => undefined })

    assert.match(html, /aria-label="Rig selection overlay"/)
    assert.match(html, /Selected bone: Spine/)
    assert.match(html, /Select highlighted bone Spine/)
    assert.match(html, /Parent connection/)
    assert.match(html, /Child connection 1/)
    assert.match(html, /Child connection 2/)
    assert.doesNotMatch(html, /rig:hero\|skeleton:0\|bone:hips#0\/spine#0\/left_arm#0\/finger#0/)
  } finally {
    await cleanup()
  }
})

test('RigOverlay returns safe empty markup for null overlay and exposes no mutating save/export controls', async () => {
  const { module, cleanup } = await loadRigOverlayModule()

  try {
    const html = renderOverlay(module.RigOverlay, { overlay: null, onSelectBone: () => undefined })

    assert.equal(html, '')
    assert.doesNotMatch(html, /Save rig aliases/)
    assert.doesNotMatch(html, /Transform/)
    assert.doesNotMatch(html, /Export GLB/)
    assert.doesNotMatch(html, /Delete/)
  } finally {
    await cleanup()
  }
})

test('RigOverlay highlighted bone affordances invoke onSelectBone without mutating the view model', async () => {
  const { module, cleanup } = await loadRigOverlayModule()
  const selected: string[] = []
  const before = structuredClone(overlayViewModel)

  try {
    const element = module.RigOverlay({
      overlay: overlayViewModel,
      onSelectBone: (boneId: string) => selected.push(boneId),
    })
    const parentMarker = findElementByAriaLabel(element, 'Select highlighted bone Parent')
    assert.ok(parentMarker, 'expected parent marker to be selectable from overlay')
    ;(parentMarker.props as { onClick: () => void }).onClick()

    assert.deepEqual(selected, ['rig:hero|skeleton:0|bone:hips#0'])
    assert.deepEqual(overlayViewModel, before)
  } finally {
    await cleanup()
  }
})

test('RigOverlay marks the selected bone and its direct connection semantically without owning the main highlight', async () => {
  const { module, cleanup } = await loadRigOverlayModule()

  try {
    const element = module.RigOverlay({ overlay: overlayViewModel, onSelectBone: () => undefined })
    const selectedMarker = findElementByAriaLabel(element, 'Select highlighted bone Spine')
    const parentMarker = findElementByAriaLabel(element, 'Select highlighted bone Parent')
    const parentConnection = findConnectionItemByText(element, 'Parent connection')
    const childConnection = findConnectionItemByText(element, 'Child connection 1')

    assert.ok(selectedMarker, 'expected selected marker to be present')
    assert.ok(parentMarker, 'expected related parent marker to be present')
    assert.ok(parentConnection, 'expected selected parent connection to be present')
    assert.ok(childConnection, 'expected secondary child connection to be present')
    assert.equal((selectedMarker.props as { 'data-rig-highlight'?: string })['data-rig-highlight'], 'selected')
    assert.equal((selectedMarker.props as { 'aria-current'?: string })['aria-current'], 'true')
    assert.equal((parentMarker.props as { 'data-rig-highlight'?: string })['data-rig-highlight'], 'related')
    assert.equal((parentConnection.props as { 'data-rig-connection-highlight'?: string })['data-rig-connection-highlight'], 'selected')
    assert.equal((childConnection.props as { 'data-rig-connection-highlight'?: string })['data-rig-connection-highlight'], 'related')
  } finally {
    await cleanup()
  }
})

test('RigOverlay keeps the top-left selected marker informational instead of visually dominant', async () => {
  const { module, cleanup } = await loadRigOverlayModule()

  try {
    const element = module.RigOverlay({ overlay: overlayViewModel, onSelectBone: () => undefined })
    const selectedMarker = findElementByAriaLabel(element, 'Select highlighted bone Spine')
    const parentMarker = findElementByAriaLabel(element, 'Select highlighted bone Parent')

    assert.ok(selectedMarker, 'expected selected marker to be present')
    assert.ok(parentMarker, 'expected related parent marker to be present')

    const selectedProps = selectedMarker.props as { style?: Record<string, string | number>; 'data-rig-visual-tone'?: string }
    const relatedProps = parentMarker.props as { style?: Record<string, string | number>; 'data-rig-visual-tone'?: string }

    assert.equal(selectedProps['data-rig-visual-tone'], 'selected-informational')
    assert.equal(selectedProps.style?.backgroundColor, 'rgba(34, 211, 238, 0.14)')
    assert.equal(selectedProps.style?.color, '#cffafe')
    assert.equal(selectedProps.style?.transform, 'none')
    assert.equal(selectedProps.style?.opacity, 1)
    assert.equal(selectedProps.style?.zIndex, 1)
    assert.equal(selectedProps.style?.boxShadow, 'none')

    assert.equal(relatedProps['data-rig-visual-tone'], 'related-muted')
    assert.equal(relatedProps.style?.backgroundColor, 'rgba(24, 24, 27, 0.72)')
    assert.equal(relatedProps.style?.opacity, 0.72)
    assert.equal(relatedProps.style?.transform, 'none')
  } finally {
    await cleanup()
  }
})

test('RigOverlay moves the informational selected contract when selectedBoneId changes', async () => {
  const { module, cleanup } = await loadRigOverlayModule()

  try {
    const nextOverlay: RigSelectionOverlayViewModel = {
      ...overlayViewModel,
      selectedBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0/head#0',
      selectedLabel: 'Head',
      parentBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      childBoneIds: [],
      highlightedBoneIds: [
        'rig:hero|skeleton:0|bone:hips#0/spine#0/head#0',
        'rig:hero|skeleton:0|bone:hips#0/spine#0',
      ],
      connections: [
        { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0/head#0', relation: 'parent' },
      ],
    }

    const element = module.RigOverlay({ overlay: nextOverlay, onSelectBone: () => undefined })
    const selectedMarker = findElementByAriaLabel(element, 'Select highlighted bone Head')
    const relatedMarker = findElementByAriaLabel(element, 'Select highlighted bone Parent')

    assert.ok(selectedMarker, 'expected new selected marker to be present')
    assert.ok(relatedMarker, 'expected previous parent marker to be present as related')
    assert.equal((selectedMarker.props as { 'data-rig-visual-tone'?: string })['data-rig-visual-tone'], 'selected-informational')
    assert.equal((selectedMarker.props as { style?: Record<string, string | number> }).style?.backgroundColor, 'rgba(34, 211, 238, 0.14)')
    assert.equal((relatedMarker.props as { 'data-rig-visual-tone'?: string })['data-rig-visual-tone'], 'related-muted')
    assert.equal((relatedMarker.props as { style?: Record<string, string | number> }).style?.opacity, 0.72)
  } finally {
    await cleanup()
  }
})

// Installed React 18/reconciler 0.27 mounts real components and prop updates in
// memory. This is callback/control coverage, not browser focus or visual proof.
type MountedNode = { type: string; props: Record<string, any>; children: MountedNode[] }
function mountComponent(component: React.ComponentType<any>, initialProps: Record<string, unknown>) {
  const context = {}
  const remove = (parent: MountedNode, child: MountedNode) => {
    const index = parent.children.indexOf(child)
    if (index >= 0) parent.children.splice(index, 1)
  }
  const append = (parent: MountedNode, child: MountedNode) => { remove(parent, child); parent.children.push(child) }
  const insert = (parent: MountedNode, child: MountedNode, before: MountedNode) => {
    remove(parent, child); parent.children.splice(parent.children.indexOf(before), 0, child)
  }
  const renderer = require('react-reconciler')({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context,
    getPublicInstance: (instance: MountedNode) => instance,
    prepareForCommit: () => null, resetAfterCommit: () => undefined,
    createInstance: (type: string, props: Record<string, unknown>) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove,
    insertBefore: insert, insertInContainerBefore: insert,
    finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareUpdate: () => true,
    commitUpdate: (instance: MountedNode, _payload: unknown, _type: string, _old: unknown, props: Record<string, unknown>) => { instance.props = props },
    commitTextUpdate: (instance: MountedNode, _old: string, text: string) => { instance.props.text = text },
    clearContainer: (container: MountedNode) => { container.children = [] }, detachDeletedInstance: () => undefined,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  })
  const host: MountedNode = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (error: unknown) => { throw error }, null)
  const update = (props: Record<string, unknown> | null) => {
    renderer.flushSync(() => renderer.updateContainer(props ? createElement(component, props) : null, root, null, () => undefined))
    while (renderer.flushPassiveEffects()) { /* Drain component effects. */ }
  }
  const nodes = (): MountedNode[] => {
    const visit = (node: MountedNode): MountedNode[] => [node, ...node.children.flatMap(visit)]
    return visit(host)
  }
  update(initialProps)
  return {
    update, nodes,
    get(label: string) {
      const node = nodes().find(node => node.props['aria-label'] === label || node.props.title === label)
      assert.ok(node, `Missing mounted control: ${label}`)
      return node
    },
    text: () => nodes().filter(node => node.type === '#text').map(node => node.props.text).join(' '),
    unmount: () => update(null),
  }
}

test('mounted RigOverlay keeps selection controlled by stable ids across updates and null capability', async () => {
  const { module, cleanup } = await loadRigOverlayModule()
  const calls: string[] = []
  const mounted = mountComponent(module.RigOverlay, { overlay: overlayViewModel, onSelectBone: (id: string) => calls.push(id) })
  try {
    mounted.get('Select highlighted bone Parent').props.onClick()
    assert.deepEqual(calls, [overlayViewModel.parentBoneId])
    assert.equal(mounted.get(`Select highlighted bone ${overlayViewModel.selectedLabel}`).props['aria-current'], 'true')
    mounted.update({ overlay: { ...overlayViewModel, selectedLabel: 'Display only alias' }, onSelectBone: (id: string) => calls.push(id) })
    mounted.get('Select highlighted bone Display only alias').props.onClick()
    assert.equal(calls.at(-1), overlayViewModel.selectedBoneId)
    mounted.update({ overlay: null, onSelectBone: (id: string) => calls.push(id) })
    assert.equal(mounted.nodes().filter(node => node.type === 'button').length, 0)
  } finally { mounted.unmount(); await cleanup() }
})
