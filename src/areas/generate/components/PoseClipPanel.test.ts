import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { PoseClipKeyframe } from '../poseClipPlan.ts'
import type { RigDisplayNamingResult } from '../rigDisplayNames.ts'
import type { RigBoneId, RigSkeletonSummary } from '../rigSkeleton.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const poseClipPanelEntry = path.join(projectRoot, 'src/areas/generate/components/PoseClipPanel.tsx')

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

async function loadPoseClipPanelModule() {
  const cacheRoot = path.join(projectRoot, 'node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  const tempDir = await mkdtemp(path.join(cacheRoot, 'modly-pose-clip-panel-'))
  const outfile = path.join(tempDir, 'PoseClipPanel.bundle.mjs')

  try {
    await build({
      entryPoints: [poseClipPanelEntry],
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

function createRigSummary(): RigSkeletonSummary {
  const hipsId = 'rig:hero|skeleton:0|bone:hips#0'
  const leftArmId = 'rig:hero|skeleton:0|bone:hips#0/left_arm#0'
  const rightArmId = 'rig:hero|skeleton:0|bone:hips#0/right_arm#0'

  return {
    hasRig: true,
    sourceWorkspacePath: 'Models/hero.glb',
    skeletonContextId: 'rig:hero|skeleton:0',
    skinnedMeshContexts: ['rig:hero|skeleton:0'],
    rootBoneIds: [hipsId],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
    bones: [
      { boneId: hipsId, label: 'Hips', originalName: 'Hips', path: ['Hips'], siblingIndex: 0, childIds: [leftArmId, rightArmId], warnings: [] },
      { boneId: leftArmId, label: 'Arm', originalName: 'Left_Arm', path: ['Hips', 'Arm'], siblingIndex: 0, parentId: hipsId, childIds: [], warnings: ['duplicate-name'] },
      { boneId: rightArmId, label: 'Arm', originalName: 'Right_Arm', path: ['Hips', 'Arm'], siblingIndex: 1, parentId: hipsId, childIds: [], warnings: ['duplicate-name'] },
    ],
  }
}

function createNoRigSummary(): RigSkeletonSummary {
  return {
    hasRig: false,
    sourceWorkspacePath: 'Models/prop.glb',
    skeletonContextId: 'rig:unknown|skeleton:0',
    skinnedMeshContexts: [],
    rootBoneIds: [],
    stats: { skinnedMeshCount: 0, boneCount: 0 },
    warnings: ['No skeleton bones were found.'],
    bones: [],
  }
}

function createKeyframes(summary = createRigSummary()): PoseClipKeyframe[] {
  if (summary.bones.length < 3) return []

  return [
    {
      id: 'kf-late',
      boneId: summary.bones[2].boneId,
      timeSeconds: 1.25,
      rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
    },
    {
      id: 'kf-early',
      boneId: summary.bones[1].boneId,
      timeSeconds: 0.25,
      rotation: { x: 0, y: 0.25, z: 0, w: 0.968 },
    },
  ]
}

function createDisplayNames(summary = createRigSummary()): RigDisplayNamingResult {
  const byBoneId: RigDisplayNamingResult['byBoneId'] = {}
  const labels: Record<string, { label: string; provenance: 'manual' | 'unirig' | 'raw' }> = {
    [summary.bones[0].boneId]: { label: 'UniRig Pelvis', provenance: 'unirig' },
    [summary.bones[1].boneId]: { label: 'Manual Left Arm', provenance: 'manual' },
    [summary.bones[2].boneId]: { label: 'UniRig Right Arm', provenance: 'unirig' },
  }
  const ordered = summary.bones.map((bone) => {
    const override = labels[bone.boneId]
    const entry = {
      boneId: bone.boneId,
      label: override?.label ?? bone.label,
      rawLabel: bone.label,
      provenance: override?.provenance ?? 'raw',
    }
    byBoneId[bone.boneId] = entry
    return entry
  })
  return { byBoneId, ordered }
}

function defaultPanelProps(summary = createRigSummary()) {
  return {
    summary,
    selectedBoneId: summary.bones[1]?.boneId,
    keyframes: createKeyframes(summary),
    currentTimeSeconds: 0.75,
    durationSeconds: 2,
    fps: 10,
    selectedKeyframeId: 'kf-early',
    previewState: 'paused' as const,
    saveState: 'idle' as const,
    loadState: 'idle' as const,
    warnings: [],
    onCaptureKeyframe: () => undefined,
    onCurrentTimeChange: () => undefined,
    onClipMetadataChange: () => undefined,
    onCaptureAndAdvance: () => undefined,
    onSelectKeyframe: () => undefined,
    onDeleteKeyframe: () => undefined,
    onUpdateSelectedKeyframe: () => undefined,
    onDeleteSelectedKeyframe: () => undefined,
    onMoveSelectedKeyframe: () => undefined,
    onShiftSelectedKeyframe: () => undefined,
    onDuplicateSelectedKeyframe: () => undefined,
    onPreviewPlay: () => undefined,
    onPreviewPause: () => undefined,
    onPreviewReset: () => undefined,
    onRotateSelectedTarget: () => undefined,
    onResetSelectedTarget: () => undefined,
    onSaveSidecar: () => undefined,
    onLoadSidecar: () => undefined,
    onSelectBone: () => undefined,
  }
}

function renderPanel(PoseClipPanel: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(PoseClipPanel, props))
}

function assertTextOrder(html: string, orderedText: readonly string[]): void {
  let previousIndex = -1
  for (const text of orderedText) {
    const index = html.indexOf(text)
    assert.notEqual(index, -1, `expected rendered panel to include "${text}"`)
    assert.ok(index > previousIndex, `expected "${text}" to appear after the previous learning step`)
    previousIndex = index
  }
}

function findElementByTitle(node: unknown, title: string): React.ReactElement | undefined {
  if (!isValidElement(node)) return undefined
  if ((node.props as { title?: string }).title === title) return node
  if (typeof node.type === 'function') {
    const renderFunction = node.type as (props: unknown) => React.ReactNode
    return findElementByTitle(renderFunction(node.props), title)
  }
  const children = (node.props as { children?: unknown }).children
  const childList = Array.isArray(children) ? children : [children]
  for (const child of childList) {
    const found = findElementByTitle(child, title)
    if (found) return found
  }
  return undefined
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

function findElementByRoleAndLabel(node: unknown, role: string, ariaLabel: string): React.ReactElement | undefined {
  if (!isValidElement(node)) return undefined
  const props = node.props as { role?: string; 'aria-label'?: string; children?: unknown }
  if (props.role === role && props['aria-label'] === ariaLabel) return node
  if (typeof node.type === 'function') {
    const renderFunction = node.type as (props: unknown) => React.ReactNode
    return findElementByRoleAndLabel(renderFunction(node.props), role, ariaLabel)
  }
  const childList = Array.isArray(props.children) ? props.children : [props.children]
  for (const child of childList) {
    const found = findElementByRoleAndLabel(child, role, ariaLabel)
    if (found) return found
  }
  return undefined
}

function getTextContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return ''
  if (typeof node.type === 'function') {
    const renderFunction = node.type as (props: unknown) => React.ReactNode
    return getTextContent(renderFunction(node.props))
  }
  const children = (node.props as { children?: unknown }).children
  const childList = Array.isArray(children) ? children : [children]
  return childList.map(getTextContent).join('')
}

function findAllElementsByAriaLabelPrefix(node: unknown, ariaLabelPrefix: string, output: React.ReactElement[] = []): React.ReactElement[] {
  if (!isValidElement(node)) return output
  const ariaLabel = (node.props as { 'aria-label'?: string })['aria-label']
  if (ariaLabel?.startsWith(ariaLabelPrefix)) output.push(node)
  if (typeof node.type === 'function') {
    const renderFunction = node.type as (props: unknown) => React.ReactNode
    return findAllElementsByAriaLabelPrefix(renderFunction(node.props), ariaLabelPrefix, output)
  }
  const children = (node.props as { children?: unknown }).children
  const childList = Array.isArray(children) ? children : [children]
  for (const child of childList) findAllElementsByAriaLabelPrefix(child, ariaLabelPrefix, output)
  return output
}

function findAllElementsByType(node: unknown, type: string, output: React.ReactElement[] = []): React.ReactElement[] {
  if (!isValidElement(node)) return output
  if (node.type === type) output.push(node)
  if (typeof node.type === 'function') {
    const renderFunction = node.type as (props: unknown) => React.ReactNode
    return findAllElementsByType(renderFunction(node.props), type, output)
  }
  const children = (node.props as { children?: unknown }).children
  const childList = Array.isArray(children) ? children : [children]
  for (const child of childList) findAllElementsByType(child, type, output)
  return output
}

function assertNativeButtonWithName(node: unknown, ariaLabel: string): void {
  const button = findElementByAriaLabel(node, ariaLabel)
  assert.equal(button?.type, 'button', `${ariaLabel} should be a native button`)
  assert.equal(button?.props.type, 'button', `${ariaLabel} should declare button type`)
}

function assertNativeInputWithName(node: unknown, ariaLabel: string, inputType: string): void {
  const input = findElementByAriaLabel(node, ariaLabel)
  assert.equal(input?.type, 'input', `${ariaLabel} should be a native input`)
  assert.equal(input?.props.type, inputType, `${ariaLabel} should use ${inputType} input type`)
}

test('PoseClipPanel renders beginner Pose/Clip mode copy, selected target details, and keeps capture disabled without a selected stable target', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const selectedHtml = renderPanel(module.PoseClipPanel, defaultPanelProps(summary))
    assert.match(selectedHtml, /Pose\/Clip authoring/)
    assert.match(selectedHtml, /Create a small generated pose clip without changing the source GLB/)
    assert.match(selectedHtml, /Selected target/)
    assert.match(selectedHtml, /Stable id:/)
    assert.match(selectedHtml, new RegExp(summary.bones[1].boneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(selectedHtml, /Export GLB/i)

    const noSelectionElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: undefined,
    })
    const captureButton = findElementByTitle(noSelectionElement, 'Capture pose keyframe')
    assert.equal(captureButton?.props.disabled, true)
    assert.match(renderToStaticMarkup(noSelectionElement), /Select a rig target to capture a keyframe/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel renders as a compact bottom drawer with collapsible sections for common viewport usability', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const element = createElement(module.PoseClipPanel, defaultPanelProps(summary))
    const html = renderToStaticMarkup(element)
    const collapsibleSections = findAllElementsByType(element, 'details')

    assert.match(html, /aria-label="Pose\/Clip compact minimizable bottom drawer"/)
    assert.match(html, /Target browser/)
    assert.match(html, /Timeline keyframes/)
    assert.match(html, /Sidecar file/)
    assert.ok(collapsibleSections.length >= 3, 'expected browser, timeline, and sidecar to be collapsible compact sections')
    assert.equal(collapsibleSections.every((section) => section.props.open === true), true)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel expanded drawer presents the beginner workflow in semantic learning order', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const html = renderPanel(module.PoseClipPanel, defaultPanelProps(summary))

    assertTextOrder(html, [
      '1. Choose a rig target',
      'Selected target',
      '2. Adjust the selected pose',
      'Rotate selected target',
      '3. Capture keyframe',
      'Current time',
      'Capture keyframe at 0.75s',
      'Pose/Clip preview',
      '4. Save or load sidecar',
      'Save sidecar',
      'Load sidecar',
      '5. Review captured keyframes',
      'Timeline keyframes',
      'Selected keyframe actions',
    ])
    assert.doesNotMatch(html, /Minimized expert workflow/i)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel groups target selection, pose adjustment, and capture in the same editing workbench before checking and post-edit sections', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const element = createElement(module.PoseClipPanel, defaultPanelProps(summary))
    const workbench = findElementByRoleAndLabel(element, 'region', 'Pose editing workbench')

    assert.ok(workbench, 'expected an accessible Pose editing workbench region around target selection and pose adjustment')

    const workbenchText = getTextContent(workbench)
    assert.match(workbenchText, /1\. Choose a rig target/)
    assert.match(workbenchText, /Target browser/)
    assert.match(workbenchText, /Selected target/)
    assert.match(workbenchText, /2\. Adjust the selected pose/)
    assert.match(workbenchText, /Rotate selected target/)
    assert.match(workbenchText, /3\. Capture keyframe/)
    assert.match(workbenchText, /Current time/)
    assert.match(workbenchText, /Capture keyframe at 0\.75s/)
    assert.match(workbenchText, /Capture & advance/)
    assert.doesNotMatch(workbenchText, /Pose\/Clip preview/)
    assert.doesNotMatch(workbenchText, /5\. Review captured keyframes/)
    assert.doesNotMatch(workbenchText, /4\. Save or load sidecar/)

    assertTextOrder(renderToStaticMarkup(element), [
      'aria-label="Pose editing workbench"',
      '1. Choose a rig target',
      '2. Adjust the selected pose',
      '3. Capture keyframe',
      'Capture keyframe at 0.75s',
      'Pose/Clip preview',
      '4. Save or load sidecar',
      '5. Review captured keyframes',
      'Selected keyframe actions',
    ])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel defaults to a minimized-capable compact drawer while keeping expanded controls accessible', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const element = createElement(module.PoseClipPanel, defaultPanelProps(summary))
    const html = renderToStaticMarkup(element)
    const minimizeButton = findElementByTitle(element, 'Minimize Pose/Clip drawer')

    assert.match(html, /aria-label="Pose\/Clip compact minimizable bottom drawer"/)
    assert.match(html, /Compact drawer/)
    assert.match(html, /2 keyframes/)
    assert.equal(minimizeButton?.props['aria-label'], 'Minimize Pose/Clip drawer')
    assert.match(html, /Capture keyframe at 0\.75s/)
    assert.match(html, /Rotate selected target/)
    assert.match(html, /Pose\/Clip preview/)
    assert.match(html, /Save sidecar/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel minimized rail renders only expert controls in strict accessible order plus Expand chrome', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const displayNames = createDisplayNames(summary)
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      rigDisplayNames: displayNames,
      drawerMode: 'minimized',
      onDrawerModeChange: (mode: string) => calls.push(mode),
    })
    const html = renderToStaticMarkup(element)
    const expandButton = findElementByTitle(element, 'Expand Pose/Clip drawer')
    const expertControls = findElementByRoleAndLabel(element, 'region', 'Pose/Clip minimized expert controls')

    assert.match(html, /aria-label="Pose\/Clip minimized summary rail"/)
    assert.ok(expertControls, 'expected minimized mode to expose a semantic expert controls region')
    assertTextOrder(html, [
      '-X',
      '+X',
      '-Y',
      '+Y',
      '-Z',
      '+Z',
      'Capture keyframe at 0.75s',
      'Current time',
      '0.75s / 2.00s',
      'Play',
      'Reset',
      'Save sidecar',
      'Load sidecar',
      'Expand',
    ])
    for (const ariaLabel of [
      'Rotate selected target -X',
      'Rotate selected target +X',
      'Rotate selected target -Y',
      'Rotate selected target +Y',
      'Rotate selected target -Z',
      'Rotate selected target +Z',
      'Capture pose keyframe',
      'Current time scrubber',
      'Play Pose/Clip preview',
      'Reset Pose/Clip preview',
      'Save pose clip sidecar',
      'Load pose clip sidecar',
      'Expand Pose/Clip drawer',
    ]) {
      assert.ok(findElementByAriaLabel(element, ariaLabel), `expected minimized control named ${ariaLabel}`)
    }
    assert.equal(expandButton?.props['aria-label'], 'Expand Pose/Clip drawer')
    assert.doesNotMatch(html, /Target browser/)
    assert.doesNotMatch(html, /Selected target/)
    assert.doesNotMatch(html, /Duration seconds/)
    assert.doesNotMatch(html, /Frames per second/)
    assert.doesNotMatch(html, /Timeline keyframes/)
    assert.doesNotMatch(html, /Selected keyframe actions/)
    assert.doesNotMatch(html, /Capture &amp; advance/)
    assert.doesNotMatch(html, /Reset selected\/current pose/)

    expandButton?.props.onClick()
    assert.deepEqual(calls, ['expanded'])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel minimized expert controls keep zero-keyframe preview disabled without verbose visible help', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      drawerMode: 'minimized',
      keyframes: [],
    })
    const html = renderToStaticMarkup(element)
    const expertControls = findElementByRoleAndLabel(element, 'region', 'Pose/Clip minimized expert controls')

    assert.match(html, /aria-label="Pose\/Clip minimized summary rail"/)
    assert.ok(expertControls, 'expected zero-keyframe minimized mode to keep one compact expert controls region')
    assert.doesNotMatch(html, /Capture a keyframe to enable Pose\/Clip preview playback\./)
    assert.doesNotMatch(html, /id="pose-clip-minimized-preview-help"/)
    assertTextOrder(html, [
      '-X',
      '+X',
      '-Y',
      '+Y',
      '-Z',
      '+Z',
      'Capture keyframe at 0.75s',
      'Current time',
      '0.75s / 2.00s',
      'Play',
      'Reset',
      'Save sidecar',
      'Load sidecar',
      'Expand',
    ])

    for (const ariaLabel of [
      'Rotate selected target -X',
      'Rotate selected target +X',
      'Rotate selected target -Y',
      'Rotate selected target +Y',
      'Rotate selected target -Z',
      'Rotate selected target +Z',
    ]) {
      const button = findElementByAriaLabel(element, ariaLabel)
      assert.equal(button?.props.disabled, false)
      assert.equal(button?.props['aria-describedby'], undefined)
    }

    assert.equal(findElementByAriaLabel(element, 'Capture pose keyframe')?.props.disabled, false)
    const playButton = findElementByAriaLabel(element, 'Play Pose/Clip preview')
    assert.equal(playButton?.props.disabled, true)
    assert.equal(playButton?.props['aria-describedby'], undefined)
    assert.equal(playButton?.props.title, 'Play Pose/Clip preview')
    assert.doesNotMatch(html, /Target browser/)
    assert.doesNotMatch(html, /Capture &amp; advance/)
    assert.doesNotMatch(html, /Selected keyframe actions/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel minimized expert controls remain keyboard-operable native controls with discoverable grouping', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const selectedElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      drawerMode: 'minimized',
    })
    const noTargetElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      drawerMode: 'minimized',
      selectedBoneId: undefined,
      keyframes: [],
    })
    const expertControls = findElementByRoleAndLabel(selectedElement, 'region', 'Pose/Clip minimized expert controls')

    assert.ok(expertControls, 'expected minimized controls to be discoverable as a named region')
    assertNativeInputWithName(selectedElement, 'Current time scrubber', 'range')
    for (const ariaLabel of [
      'Rotate selected target -X',
      'Rotate selected target +X',
      'Rotate selected target -Y',
      'Rotate selected target +Y',
      'Rotate selected target -Z',
      'Rotate selected target +Z',
      'Capture pose keyframe',
      'Play Pose/Clip preview',
      'Reset Pose/Clip preview',
      'Save pose clip sidecar',
      'Load pose clip sidecar',
      'Expand Pose/Clip drawer',
    ]) {
      assertNativeButtonWithName(selectedElement, ariaLabel)
    }

    assert.equal(findElementByAriaLabel(noTargetElement, 'Rotate selected target -X')?.props.disabled, true)
    assert.equal(findElementByAriaLabel(noTargetElement, 'Capture pose keyframe')?.props.disabled, true)
    assert.equal(findElementByAriaLabel(noTargetElement, 'Play Pose/Clip preview')?.props.disabled, true)
    assert.match(renderToStaticMarkup(noTargetElement), /role="status"[^>]*>Select a rig target to enable capture\./)
    assert.doesNotMatch(renderToStaticMarkup(noTargetElement), /Capture a keyframe to enable Pose\/Clip preview playback\./)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel minimized boundary omits expanded-only beginner workflow while expanded mode keeps it unchanged', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const expandedHtml = renderPanel(module.PoseClipPanel, defaultPanelProps(summary))
    const minimizedHtml = renderPanel(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      drawerMode: 'minimized',
    })

    for (const expandedOnlyCopy of [
      /Target browser/,
      /Selected target/,
      /Duration seconds/,
      /Frames per second/,
      /Timeline keyframes/,
      /Captured Pose\/Clip keyframes/,
      /Selected keyframe actions/,
      /Capture &amp; advance/,
      /Reset selected\/current pose/,
    ]) {
      assert.match(expandedHtml, expandedOnlyCopy, `expected expanded mode to keep ${expandedOnlyCopy}`)
      assert.doesNotMatch(minimizedHtml, expandedOnlyCopy, `expected minimized mode to omit ${expandedOnlyCopy}`)
    }

    assert.match(minimizedHtml, /aria-label="Pose\/Clip minimized expert controls"/)
    assert.match(minimizedHtml, /Expand/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel minimized controls invoke existing handlers with stable RigBoneId while effective labels stay display-only', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const displayNames = createDisplayNames(summary)
  const selectedBoneId = summary.bones[1].boneId
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      drawerMode: 'minimized',
      rigDisplayNames: displayNames,
      selectedBoneId,
      currentTimeSeconds: 0.75,
      durationSeconds: 2,
      rotationStepDegrees: 12.5,
      onRotateSelectedTarget: (boneId: RigBoneId, axis: 'x' | 'y' | 'z', degreesDelta: number) => calls.push(`rotate:${boneId}:${axis}:${degreesDelta}`),
      onResetSelectedTarget: (boneId: RigBoneId) => calls.push(`reset-selected:${boneId}`),
      onCaptureKeyframe: (boneId: RigBoneId, timeSeconds: number) => calls.push(`capture:${boneId}:${timeSeconds}`),
      onCurrentTimeChange: (timeSeconds: number) => calls.push(`time:${timeSeconds}`),
      onPreviewPlay: () => calls.push('preview:play'),
      onPreviewReset: () => calls.push('preview:reset'),
      onSaveSidecar: () => calls.push('sidecar:save'),
      onLoadSidecar: () => calls.push('sidecar:load'),
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /aria-label="Pose\/Clip minimized summary rail"/)
    assert.doesNotMatch(html, /Reset selected\/current pose/)

    for (const title of [
      'Rotate selected target -X',
      'Rotate selected target +X',
      'Rotate selected target -Y',
      'Rotate selected target +Y',
      'Rotate selected target -Z',
      'Rotate selected target +Z',
    ]) {
      findElementByTitle(element, title)?.props.onClick()
    }
    findElementByTitle(element, 'Capture pose keyframe')?.props.onClick()
    findElementByTitle(element, 'Current time scrubber')?.props.onChange({ currentTarget: { valueAsNumber: 9 } })
    findElementByTitle(element, 'Play Pose/Clip preview')?.props.onClick()
    findElementByTitle(element, 'Reset Pose/Clip preview')?.props.onClick()
    findElementByTitle(element, 'Save pose clip sidecar')?.props.onClick()
    findElementByTitle(element, 'Load pose clip sidecar')?.props.onClick()

    assert.deepEqual(calls, [
      `rotate:${selectedBoneId}:x:-12.5`,
      `rotate:${selectedBoneId}:x:12.5`,
      `rotate:${selectedBoneId}:y:-12.5`,
      `rotate:${selectedBoneId}:y:12.5`,
      `rotate:${selectedBoneId}:z:-12.5`,
      `rotate:${selectedBoneId}:z:12.5`,
      `capture:${selectedBoneId}:0.75`,
      'time:2',
      'preview:play',
      'preview:reset',
      'sidecar:save',
      'sidecar:load',
    ])
    assert.equal(calls.some((call) => /Manual|UniRig|Arm|Right/.test(call)), false)
    assert.equal(calls.some((call) => call.startsWith('reset-selected:')), false)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel shows no-rig and unavailable-target states without throwing away sidecar actions', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const noRigHtml = renderPanel(module.PoseClipPanel, {
      ...defaultPanelProps(createNoRigSummary()),
      selectedBoneId: undefined,
      keyframes: [],
    })
    assert.match(noRigHtml, /No rig target available/)
    assert.match(noRigHtml, /Load a rigged character GLB/)

    const unavailableHtml = renderPanel(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: 'rig:missing|bone:ghost#0' satisfies RigBoneId,
    })
    assert.match(unavailableHtml, /Selected target unavailable/)
    assert.match(unavailableHtml, /The saved sidecar points to a bone that is not in this rig/)
    assert.match(unavailableHtml, /Load sidecar/)
    assert.match(unavailableHtml, /Save sidecar/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel capture and preview controls call props with stable RigBoneId and current time metadata', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      onCaptureKeyframe: (boneId: RigBoneId, timeSeconds: number) => calls.push(`capture:${boneId}:${timeSeconds}`),
      onPreviewPlay: () => calls.push('play'),
      onPreviewPause: () => calls.push('pause'),
      onPreviewReset: () => calls.push('reset'),
    })

    findElementByTitle(element, 'Capture pose keyframe')?.props.onClick()
    findElementByTitle(element, 'Play Pose/Clip preview')?.props.onClick()
    findElementByTitle(createElement(module.PoseClipPanel, { ...defaultPanelProps(summary), previewState: 'playing' }), 'Pause Pose/Clip preview')?.props.onClick()
    findElementByTitle(element, 'Reset Pose/Clip preview')?.props.onClick()

    assert.deepEqual(calls, [
      `capture:${summary.bones[1].boneId}:0.75`,
      'play',
      'reset',
    ])

    const playingElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      previewState: 'playing',
      onPreviewPause: () => calls.push('pause-now'),
    })
    findElementByTitle(playingElement, 'Pause Pose/Clip preview')?.props.onClick()
    assert.equal(calls.at(-1), 'pause-now')
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel renders beginner local rotation controls, reset current pose, and disables them without an editable selected target', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const calls: string[] = []

  try {
    const selectedElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      rotationStepDegrees: 7.5,
      onRotateSelectedTarget: (boneId: RigBoneId, axis: 'x' | 'y' | 'z', degreesDelta: number) => calls.push(`rotate:${boneId}:${axis}:${degreesDelta}`),
      onResetSelectedTarget: (boneId: RigBoneId) => calls.push(`reset-selected:${boneId}`),
    })
    const selectedHtml = renderToStaticMarkup(selectedElement)

    assert.match(selectedHtml, /Rotate selected target/)
    assert.match(selectedHtml, /Use small local rotations before capturing a keyframe/)
    assert.match(selectedHtml, /Step: 7\.5°/)

    const rotateXPositive = findElementByTitle(selectedElement, 'Rotate selected target +X')
    const rotateYNegative = findElementByTitle(selectedElement, 'Rotate selected target -Y')
    const rotateZPositive = findElementByTitle(selectedElement, 'Rotate selected target +Z')
    const resetButton = findElementByTitle(selectedElement, 'Reset selected target pose')
    assert.equal(rotateXPositive?.props.disabled, false)
    assert.equal(rotateYNegative?.props.disabled, false)
    assert.equal(rotateZPositive?.props.disabled, false)
    assert.equal(resetButton?.props.disabled, false)

    rotateXPositive?.props.onClick()
    rotateYNegative?.props.onClick()
    rotateZPositive?.props.onClick()
    resetButton?.props.onClick()
    assert.deepEqual(calls, [
      `rotate:${summary.bones[1].boneId}:x:7.5`,
      `rotate:${summary.bones[1].boneId}:y:-7.5`,
      `rotate:${summary.bones[1].boneId}:z:7.5`,
      `reset-selected:${summary.bones[1].boneId}`,
    ])

    const noTargetElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: undefined,
    })
    assert.equal(findElementByTitle(noTargetElement, 'Rotate selected target +X')?.props.disabled, true)
    assert.equal(findElementByTitle(noTargetElement, 'Reset selected target pose')?.props.disabled, true)
    assert.match(renderToStaticMarkup(noTargetElement), /Select a rig target to enable local rotation controls/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel renders timeline rows sorted by time and keyframe actions use stable keyframe and bone ids without mutating props', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const keyframes = createKeyframes(summary)
  const before = structuredClone(keyframes)
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      keyframes,
      onSelectKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`select:${keyframeId}:${boneId}`),
      onDeleteKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`delete:${keyframeId}:${boneId}`),
    })
    const html = renderToStaticMarkup(element)
    assert.ok(html.indexOf('0.25s') < html.indexOf('1.25s'))
    assert.match(html, /Arm/)
    assert.match(html, /Left_Arm/)
    assert.match(html, /Right_Arm/)

    const selectButtons = findAllElementsByAriaLabelPrefix(element, 'Select keyframe')
    const deleteButtons = findAllElementsByAriaLabelPrefix(element, 'Delete keyframe')
    assert.equal(selectButtons.length, 2)
    assert.equal(deleteButtons.length, 2)

    selectButtons[0].props.onClick()
    deleteButtons[1].props.onClick()

    assert.deepEqual(calls, [
      `select:kf-early:${summary.bones[1].boneId}`,
      `delete:kf-late:${summary.bones[2].boneId}`,
    ])
    assert.deepEqual(keyframes, before)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel renders selected target, target browser, and timeline with effective labels while actions keep stable RigBoneId', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const displayNames = createDisplayNames(summary)
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      rigDisplayNames: displayNames,
      onSelectBone: (boneId: RigBoneId) => calls.push(`target:${boneId}`),
      onSelectKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`keyframe:${keyframeId}:${boneId}`),
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /Selected target/)
    assert.match(html, /Manual Left Arm/)
    assert.match(html, /Name source: manual/)
    assert.match(html, /aria-label="Select bone UniRig Pelvis"/)
    assert.match(html, /0\.25s · Manual Left Arm/)
    assert.match(html, /1\.25s · UniRig Right Arm/)
    assert.doesNotMatch(html, /0\.25s · Arm/)

    findElementByTitle(element, 'Capture pose keyframe')?.props.onClick()
    findAllElementsByAriaLabelPrefix(element, 'Select keyframe')[0].props.onClick()
    assert.deepEqual(calls, [`keyframe:kf-early:${summary.bones[1].boneId}`])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel timeline controls preserve effective labels and stable-id callbacks after selected keyframe actions', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const displayNames = createDisplayNames(summary)
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      rigDisplayNames: displayNames,
      selectedKeyframeId: 'kf-late',
      onCurrentTimeChange: (timeSeconds: number) => calls.push(`time:${timeSeconds}`),
      onUpdateSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`update:${keyframeId}:${boneId}`),
      onDuplicateSelectedKeyframe: (keyframeId: string) => calls.push(`duplicate:${keyframeId}`),
      onSelectBone: (boneId: RigBoneId) => calls.push(`bone:${boneId}`),
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /Manual Left Arm/)
    assert.match(html, /UniRig Right Arm/)
    assert.match(html, /1\.25s · UniRig Right Arm/)
    assert.doesNotMatch(html, /1\.25s · Arm/)

    findElementByTitle(element, 'Current time seconds')?.props.onChange({ currentTarget: { valueAsNumber: 9 } })
    findElementByTitle(element, 'Update selected keyframe')?.props.onClick()
    findElementByTitle(element, 'Duplicate selected keyframe')?.props.onClick()
    findAllElementsByAriaLabelPrefix(element, 'Select bone UniRig Pelvis')[0]?.props.onClick()

    assert.deepEqual(calls, [
      'time:2',
      `update:kf-late:${summary.bones[2].boneId}`,
      'duplicate:kf-late',
      `bone:${summary.bones[0].boneId}`,
    ])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel regression keeps every expanded control callback on stable ids while effective labels stay display-only', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const displayNames = createDisplayNames(summary)
  const selectedBoneId = summary.bones[1].boneId
  const selectedLateKeyframeId = 'kf-late'
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      rigDisplayNames: displayNames,
      selectedBoneId,
      selectedKeyframeId: selectedLateKeyframeId,
      currentTimeSeconds: 0.75,
      rotationStepDegrees: 5,
      onRotateSelectedTarget: (boneId: RigBoneId, axis: 'x' | 'y' | 'z', degreesDelta: number) => calls.push(`rotate:${boneId}:${axis}:${degreesDelta}`),
      onResetSelectedTarget: (boneId: RigBoneId) => calls.push(`reset-pose:${boneId}`),
      onCaptureKeyframe: (boneId: RigBoneId, timeSeconds: number) => calls.push(`capture:${boneId}:${timeSeconds}`),
      onCaptureAndAdvance: (boneId: RigBoneId) => calls.push(`capture-advance:${boneId}`),
      onCurrentTimeChange: (timeSeconds: number) => calls.push(`time:${timeSeconds}`),
      onPreviewPlay: () => calls.push('preview:play'),
      onPreviewReset: () => calls.push('preview:reset'),
      onSaveSidecar: () => calls.push('sidecar:save'),
      onLoadSidecar: () => calls.push('sidecar:load'),
      onSelectKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`select-key:${keyframeId}:${boneId}`),
      onUpdateSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`update-key:${keyframeId}:${boneId}`),
      onDeleteSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`delete-selected:${keyframeId}:${boneId}`),
      onMoveSelectedKeyframe: (keyframeId: string, timeSeconds: number) => calls.push(`move-key:${keyframeId}:${timeSeconds}`),
      onShiftSelectedKeyframe: (keyframeId: string, deltaSeconds: number) => calls.push(`shift-key:${keyframeId}:${deltaSeconds}`),
      onDuplicateSelectedKeyframe: (keyframeId: string) => calls.push(`duplicate-key:${keyframeId}`),
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /Manual Left Arm/)
    assert.match(html, /UniRig Right Arm/)
    assert.match(html, /Stable id:/)

    for (const title of [
      'Rotate selected target -X',
      'Rotate selected target +X',
      'Rotate selected target -Y',
      'Rotate selected target +Y',
      'Rotate selected target -Z',
      'Rotate selected target +Z',
    ]) {
      findElementByTitle(element, title)?.props.onClick()
    }
    findElementByTitle(element, 'Reset selected target pose')?.props.onClick()
    findElementByTitle(element, 'Capture pose keyframe')?.props.onClick()
    findElementByTitle(element, 'Capture & advance selected target')?.props.onClick()
    findElementByTitle(element, 'Current time scrubber')?.props.onChange({ currentTarget: { valueAsNumber: 1.5 } })
    findElementByTitle(element, 'Play Pose/Clip preview')?.props.onClick()
    findElementByTitle(element, 'Reset Pose/Clip preview')?.props.onClick()
    findElementByTitle(element, 'Save pose clip sidecar')?.props.onClick()
    findElementByTitle(element, 'Load pose clip sidecar')?.props.onClick()
    findAllElementsByAriaLabelPrefix(element, 'Select keyframe')[0].props.onClick()
    findElementByTitle(element, 'Update selected keyframe')?.props.onClick()
    findElementByTitle(element, 'Move selected keyframe backward one frame')?.props.onClick()
    findElementByTitle(element, 'Move selected keyframe forward one frame')?.props.onClick()
    findElementByTitle(element, 'Move selected keyframe to current time')?.props.onClick()
    findElementByTitle(element, 'Duplicate selected keyframe')?.props.onClick()
    findElementByTitle(element, 'Delete selected keyframe')?.props.onClick()

    assert.deepEqual(calls, [
      `rotate:${selectedBoneId}:x:-5`,
      `rotate:${selectedBoneId}:x:5`,
      `rotate:${selectedBoneId}:y:-5`,
      `rotate:${selectedBoneId}:y:5`,
      `rotate:${selectedBoneId}:z:-5`,
      `rotate:${selectedBoneId}:z:5`,
      `reset-pose:${selectedBoneId}`,
      `capture:${selectedBoneId}:0.75`,
      `capture-advance:${selectedBoneId}`,
      'time:1.5',
      'preview:play',
      'preview:reset',
      'sidecar:save',
      'sidecar:load',
      `select-key:kf-early:${summary.bones[1].boneId}`,
      `update-key:kf-late:${summary.bones[2].boneId}`,
      'shift-key:kf-late:-0.1',
      'shift-key:kf-late:0.1',
      'move-key:kf-late:0.75',
      'duplicate-key:kf-late',
      `delete-selected:kf-late:${summary.bones[2].boneId}`,
    ])
    assert.equal(calls.some((call) => /Manual|UniRig|Arm|Right/.test(call)), false)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel presents non-blocking sidecar warnings and save/load states without disabling safe actions', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const calls: string[] = []

  try {
    const warnedElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      warnings: [
        { kind: 'missing-sidecar', message: 'No saved pose clip exists yet; start a new clip.' },
        { kind: 'invalid-sidecar', message: 'The selected sidecar was invalid, so it was not applied.' },
        { kind: 'incompatible-sidecar', message: 'This sidecar belongs to another skeleton.' },
      ],
      saveState: 'error',
      saveError: 'Could not write the sidecar.',
      loadState: 'loading',
      onSaveSidecar: () => calls.push('save'),
      onLoadSidecar: () => calls.push('load'),
    })

    const html = renderToStaticMarkup(warnedElement)
    assert.match(html, /No saved pose clip exists yet/)
    assert.match(html, /The selected sidecar was invalid/)
    assert.match(html, /This sidecar belongs to another skeleton/)
    assert.match(html, /Could not write the sidecar/)
    assert.match(html, /Loading sidecar/)

    const saveButton = findElementByTitle(warnedElement, 'Save pose clip sidecar')
    const loadButton = findElementByTitle(warnedElement, 'Load pose clip sidecar')
    assert.equal(saveButton?.props.disabled, false)
    assert.equal(loadButton?.props.disabled, true)
    saveButton?.props.onClick()
    assert.deepEqual(calls, ['save'])

    const savingElement = createElement(module.PoseClipPanel, { ...defaultPanelProps(summary), saveState: 'saving' })
    assert.match(renderToStaticMarkup(savingElement), /Saving sidecar/)
    assert.equal(findElementByTitle(savingElement, 'Save pose clip sidecar')?.props.disabled, true)

    const savedHtml = renderPanel(module.PoseClipPanel, { ...defaultPanelProps(summary), saveState: 'saved', loadState: 'idle' })
    assert.match(savedHtml, /Sidecar saved/)
    assert.doesNotMatch(savedHtml, /embedded GLB/i)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel renders compact timeline controls with semantic labels and clamped current time callbacks', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      currentTimeSeconds: 0.75,
      durationSeconds: 2,
      onCurrentTimeChange: (timeSeconds: number) => calls.push(`time:${timeSeconds}`),
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /Timeline controls/)
    assert.match(html, /aria-label="Current time scrubber"/)
    assert.match(html, /aria-label="Current time seconds"/)
    assert.match(html, /aria-label="Duration seconds"/)
    assert.match(html, /aria-label="Frames per second"/)
    assert.match(html, /aria-label="Capture &amp; advance selected target"/)

    const rangeInput = findElementByTitle(element, 'Current time scrubber')
    const numericInput = findElementByTitle(element, 'Current time seconds')
    assert.equal(rangeInput?.props.type, 'range')
    assert.equal(rangeInput?.props.min, 0)
    assert.equal(rangeInput?.props.max, 2)
    assert.equal(numericInput?.props.type, 'number')
    assert.equal(numericInput?.props.min, 0)
    assert.equal(numericInput?.props.max, 2)

    rangeInput?.props.onChange({ currentTarget: { valueAsNumber: -1 } })
    numericInput?.props.onChange({ currentTarget: { valueAsNumber: 3 } })

    assert.deepEqual(calls, ['time:0', 'time:2'])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel duration and FPS controls clamp callback values and capture advances from selected rig target', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      onClipMetadataChange: (metadata: { durationSeconds?: number; fps?: number }) => calls.push(`metadata:${metadata.durationSeconds ?? '-'}:${metadata.fps ?? '-'}`),
      onCaptureAndAdvance: (boneId: RigBoneId) => calls.push(`capture-advance:${boneId}`),
    })

    findElementByTitle(element, 'Duration seconds')?.props.onChange({ currentTarget: { valueAsNumber: -4 } })
    findElementByTitle(element, 'Frames per second')?.props.onChange({ currentTarget: { valueAsNumber: 0 } })
    findElementByTitle(element, 'Capture & advance selected target')?.props.onClick()

    assert.deepEqual(calls, [
      'metadata:0.001:-',
      'metadata:-:1',
      `capture-advance:${summary.bones[1].boneId}`,
    ])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel marks selected keyframe and wires selected keyframe actions with one-frame movement', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedKeyframeId: 'kf-early',
      fps: 10,
      onUpdateSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`update:${keyframeId}:${boneId}`),
      onDeleteSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => calls.push(`delete-selected:${keyframeId}:${boneId}`),
      onShiftSelectedKeyframe: (keyframeId: string, deltaSeconds: number) => calls.push(`shift:${keyframeId}:${deltaSeconds}`),
      onDuplicateSelectedKeyframe: (keyframeId: string) => calls.push(`duplicate:${keyframeId}`),
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /Selected keyframe actions/)
    assert.match(html, /aria-current="time"/)
    assert.match(html, /Selected keyframe: kf-early/)

    findElementByTitle(element, 'Update selected keyframe')?.props.onClick()
    findElementByTitle(element, 'Move selected keyframe backward one frame')?.props.onClick()
    findElementByTitle(element, 'Move selected keyframe forward one frame')?.props.onClick()
    findElementByTitle(element, 'Duplicate selected keyframe')?.props.onClick()
    findElementByTitle(element, 'Delete selected keyframe')?.props.onClick()

    assert.deepEqual(calls, [
      `update:kf-early:${summary.bones[1].boneId}`,
      'shift:kf-early:-0.1',
      'shift:kf-early:0.1',
      'duplicate:kf-early',
      `delete-selected:kf-early:${summary.bones[1].boneId}`,
    ])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel disables timeline and selected actions without valid rig target or selected keyframe', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const noSelectionElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: undefined,
      selectedKeyframeId: undefined,
    })
    const noSelectionHtml = renderToStaticMarkup(noSelectionElement)

    assert.match(noSelectionHtml, /Select a rig target to enable capture and advance/)
    assert.match(noSelectionHtml, /Select a keyframe to enable update, delete, move, and duplicate/)
    assert.equal(findElementByTitle(noSelectionElement, 'Capture & advance selected target')?.props.disabled, true)
    assert.equal(findElementByTitle(noSelectionElement, 'Update selected keyframe')?.props.disabled, true)
    assert.equal(findElementByTitle(noSelectionElement, 'Delete selected keyframe')?.props.disabled, true)
    assert.equal(findElementByTitle(noSelectionElement, 'Move selected keyframe backward one frame')?.props.disabled, true)
    assert.equal(findElementByTitle(noSelectionElement, 'Move selected keyframe forward one frame')?.props.disabled, true)
    assert.equal(findElementByTitle(noSelectionElement, 'Duplicate selected keyframe')?.props.disabled, true)

    const noKeyframesElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      keyframes: [],
      selectedKeyframeId: 'missing-keyframe',
    })
    assert.equal(findElementByTitle(noKeyframesElement, 'Update selected keyframe')?.props.disabled, true)
    assert.match(renderToStaticMarkup(noKeyframesElement), /No keyframes yet/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel exposes semantic workflow headings in visual learning order', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const element = createElement(module.PoseClipPanel, defaultPanelProps(summary))
    const headingTexts = findAllElementsByType(element, 'h3').map(getTextContent)

    assert.deepEqual(
      headingTexts.filter((text) => /^\d\. /.test(text)),
      [
        '1. Choose a rig target',
        '2. Adjust the selected pose',
        '3. Capture keyframe',
        '4. Save or load sidecar',
        '5. Review captured keyframes',
      ],
    )
    assertTextOrder(renderToStaticMarkup(element), [
      '<h3',
      '1. Choose a rig target',
      '2. Adjust the selected pose',
      '3. Capture keyframe',
      'Pose/Clip preview',
      '4. Save or load sidecar',
      '5. Review captured keyframes',
    ])
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel keeps expanded controls keyboard reachable with accessible names', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const element = createElement(module.PoseClipPanel, defaultPanelProps(summary))

    for (const ariaLabel of [
      'Rotate selected target -X',
      'Rotate selected target +X',
      'Rotate selected target -Y',
      'Rotate selected target +Y',
      'Rotate selected target -Z',
      'Rotate selected target +Z',
      'Capture pose keyframe',
      'Capture & advance selected target',
      'Play Pose/Clip preview',
      'Reset Pose/Clip preview',
      'Save pose clip sidecar',
      'Load pose clip sidecar',
      'Update selected keyframe',
      'Delete selected keyframe',
      'Move selected keyframe backward one frame',
      'Move selected keyframe forward one frame',
      'Move selected keyframe to current time',
      'Duplicate selected keyframe',
    ]) {
      assertNativeButtonWithName(element, ariaLabel)
    }

    assertNativeInputWithName(element, 'Current time scrubber', 'range')
    assertNativeInputWithName(element, 'Current time seconds', 'number')
    assertNativeInputWithName(element, 'Duration seconds', 'number')
    assertNativeInputWithName(element, 'Frames per second', 'number')
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel disabled controls reference visible help instead of relying on color alone', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const noSelectionElement = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: undefined,
      selectedKeyframeId: undefined,
      keyframes: [],
    })
    const html = renderToStaticMarkup(noSelectionElement)

    assert.match(html, /id="pose-clip-rotation-help"[^>]*>Select a rig target to enable local rotation controls\./)
    assert.match(html, /id="pose-clip-capture-help"[^>]*>Select a rig target to enable capture and advance\./)
    assert.match(html, /id="pose-clip-preview-help"[^>]*>Capture a keyframe to enable Pose\/Clip preview playback\./)
    assert.match(html, /id="pose-clip-selected-keyframe-help"[^>]*>Select a keyframe to enable update, delete, move, and duplicate\./)

    for (const ariaLabel of [
      'Rotate selected target -X',
      'Rotate selected target +X',
      'Rotate selected target -Y',
      'Rotate selected target +Y',
      'Rotate selected target -Z',
      'Rotate selected target +Z',
      'Reset selected target pose',
    ]) {
      const button = findElementByAriaLabel(noSelectionElement, ariaLabel)
      assert.equal(button?.props.disabled, true)
      assert.equal(button?.props['aria-describedby'], 'pose-clip-rotation-help')
    }

    for (const ariaLabel of ['Capture pose keyframe', 'Capture & advance selected target']) {
      const button = findElementByAriaLabel(noSelectionElement, ariaLabel)
      assert.equal(button?.props.disabled, true)
      assert.equal(button?.props['aria-describedby'], 'pose-clip-capture-help')
    }

    assert.equal(findElementByAriaLabel(noSelectionElement, 'Play Pose/Clip preview')?.props.disabled, true)
    assert.equal(findElementByAriaLabel(noSelectionElement, 'Play Pose/Clip preview')?.props['aria-describedby'], 'pose-clip-preview-help')

    for (const ariaLabel of [
      'Update selected keyframe',
      'Delete selected keyframe',
      'Move selected keyframe backward one frame',
      'Move selected keyframe forward one frame',
      'Move selected keyframe to current time',
      'Duplicate selected keyframe',
    ]) {
      const button = findElementByAriaLabel(noSelectionElement, ariaLabel)
      assert.equal(button?.props.disabled, true)
      assert.equal(button?.props['aria-describedby'], 'pose-clip-selected-keyframe-help')
    }
  } finally {
    await cleanup()
  }
})
