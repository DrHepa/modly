import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { RigSelectionOverlayViewModel } from '../rigSkeleton.ts'

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
  const cacheRoot = path.join(projectRoot, 'node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  const tempDir = await mkdtemp(path.join(cacheRoot, 'modly-rig-overlay-'))
  const outfile = path.join(tempDir, 'RigOverlay.bundle.mjs')

  try {
    await build({
      entryPoints: [rigOverlayEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [aliasPlugin()],
      external: ['react', 'react-dom', 'react/jsx-runtime'],
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
