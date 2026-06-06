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

import type { PoseClipKeyframe } from '../poseClipPlan.ts'
import type { RigDisplayNamingResult } from '../rigDisplayNames.ts'
import type { RigBoneId, RigSkeletonSummary } from '../rigSkeleton.ts'

const require = createRequire(import.meta.url)
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
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-pose-clip-panel-'))
  const outfile = path.join(tempDir, 'PoseClipPanel.bundle.mjs')

  try {
    await build({
      entryPoints: [poseClipPanelEntry],
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
  return summary.bones.length < 3 ? [] : [
    { id: 'kf-late', boneId: summary.bones[2].boneId, timeSeconds: 1.25, rotation: { x: 0, y: 0.5, z: 0, w: 0.866 } },
    { id: 'kf-early', boneId: summary.bones[1].boneId, timeSeconds: 0.25, rotation: { x: 0, y: 0.25, z: 0, w: 0.968 } },
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
    const entry = { boneId: bone.boneId, label: override?.label ?? bone.label, rawLabel: bone.label, provenance: override?.provenance ?? 'raw' }
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
    canSaveSidecar: true,
    canLoadSidecar: true,
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
  }
}

function findElementByTitle(node: unknown, title: string): React.ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByTitle(child, title)
      if (found) return found
    }
    return undefined
  }
  if (!isValidElement(node)) return undefined
  if ((node.props as { title?: string }).title === title) return node
  if (typeof node.type === 'function') return findElementByTitle((node.type as (props: unknown) => React.ReactNode)(node.props), title)
  const children = (node.props as { children?: unknown }).children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByTitle(child, title)
    if (found) return found
  }
  return undefined
}

function findElementByAriaLabel(node: unknown, ariaLabel: string): React.ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByAriaLabel(child, ariaLabel)
      if (found) return found
    }
    return undefined
  }
  if (!isValidElement(node)) return undefined
  if ((node.props as { 'aria-label'?: string })['aria-label'] === ariaLabel) return node
  if (typeof node.type === 'function') return findElementByAriaLabel((node.type as (props: unknown) => React.ReactNode)(node.props), ariaLabel)
  const children = (node.props as { children?: unknown }).children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByAriaLabel(child, ariaLabel)
    if (found) return found
  }
  return undefined
}

function assertActionFirstMarkup(html: string): void {
  for (const copy of [/Target browser/, /Bone hierarchy/, /Rig bone hierarchy/, /Scrollable rig bone hierarchy/, /Motion Retarget/i, /Developer diagnostics/i, /\bEDIT\b|\bAUTHOR\b|\bINSPECT\b/]) {
    assert.doesNotMatch(html, copy)
  }
}

function assertNoVisibleTargetStatus(html: string): void {
  for (const copy of [/Current target/i, /Manual Left Arm/, /UniRig Pelvis/, />Hips</, />Arm</, />bone_0</, />No target</]) {
    assert.doesNotMatch(html, copy)
  }
}

function assertNoDrawerModeControls(html: string): void {
  assert.doesNotMatch(html, /\bExpand\b/)
  assert.doesNotMatch(html, /\bMinimize\b/)
  assert.doesNotMatch(html, /Pose\/Clip action drawer/)
  assert.match(html, /aria-label="Pose\/Clip action rail"/)
}

test('PoseClipPanel defaults to minimized action-first controls without duplicate target browsing', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const html = renderToStaticMarkup(createElement(module.PoseClipPanel, defaultPanelProps(summary)))

    assert.match(html, /aria-label="Pose\/Clip action rail"/)
    assert.match(html, /Capture keyframe at 0\.75s/)
    assert.match(html, /Current time/)
    assert.match(html, /Play/)
    assert.match(html, /Reset/)
    assert.match(html, /Save sidecar/)
    assert.match(html, /Load sidecar/)
    assertActionFirstMarkup(html)
    assertNoVisibleTargetStatus(html)
    assertNoDrawerModeControls(html)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel ignores drawer mode as a normal UI workflow and never renders target status', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const html = renderToStaticMarkup(createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      drawerMode: 'expanded',
      rigDisplayNames: createDisplayNames(summary),
    }))

    assert.match(html, /aria-label="Pose\/Clip action rail"/)
    assert.match(html, /Capture keyframe at 0\.75s/)
    assert.match(html, /Play/)
    assert.match(html, /Reset/)
    assert.match(html, /Save sidecar/)
    assert.match(html, /Load sidecar/)
    assert.doesNotMatch(html, /Stable id:/)
    assert.doesNotMatch(html, /Name source:/)
    assert.doesNotMatch(html, /Original name:/)
    assertActionFirstMarkup(html)
    assertNoVisibleTargetStatus(html)
    assertNoDrawerModeControls(html)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel target-dependent actions disable safely with concise no-target state', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: undefined,
      keyframes: [],
    })
    const html = renderToStaticMarkup(element)

    assert.equal(findElementByAriaLabel(element, 'Rotate selected target -X')?.props.disabled, true)
    assert.equal(findElementByAriaLabel(element, 'Capture pose keyframe')?.props.disabled, true)
    assert.equal(findElementByAriaLabel(element, 'Play Pose/Clip preview')?.props.disabled, true)
    assert.equal(findElementByAriaLabel(element, 'Save pose clip sidecar')?.props.disabled, false)
    assert.equal(findElementByAriaLabel(element, 'Load pose clip sidecar')?.props.disabled, false)
    assertActionFirstMarkup(html)
    assertNoVisibleTargetStatus(html)
    assertNoDrawerModeControls(html)
    assert.match(html, /aria-describedby="pose-clip-target-help"/)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel direct action handlers use the shared selected RigBoneId and display names stay display-only', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()
  const selectedBoneId = summary.bones[1].boneId
  const calls: string[] = []

  try {
    const element = createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      drawerMode: 'expanded',
      rigDisplayNames: createDisplayNames(summary),
      selectedBoneId,
      rotationStepDegrees: 12.5,
      onRotateSelectedTarget: (boneId: RigBoneId, axis: 'x' | 'y' | 'z', degreesDelta: number) => calls.push(`rotate:${boneId}:${axis}:${degreesDelta}`),
      onResetSelectedTarget: (boneId: RigBoneId) => calls.push(`reset-target:${boneId}`),
      onCaptureKeyframe: (boneId: RigBoneId, timeSeconds: number) => calls.push(`capture:${boneId}:${timeSeconds}`),
      onCurrentTimeChange: (timeSeconds: number) => calls.push(`time:${timeSeconds}`),
      onPreviewPlay: () => calls.push('preview:play'),
      onPreviewReset: () => calls.push('preview:reset'),
      onSaveSidecar: () => calls.push('sidecar:save'),
      onLoadSidecar: () => calls.push('sidecar:load'),
    })

    findElementByTitle(element, 'Rotate selected target -X')?.props.onClick()
    findElementByTitle(element, 'Rotate selected target +Y')?.props.onClick()
    findElementByTitle(element, 'Reset selected target pose')?.props.onClick()
    findElementByTitle(element, 'Capture pose keyframe')?.props.onClick()
    findElementByTitle(element, 'Current time scrubber')?.props.onChange({ currentTarget: { valueAsNumber: 9 } })
    findElementByTitle(element, 'Play Pose/Clip preview')?.props.onClick()
    findElementByTitle(element, 'Reset Pose/Clip preview')?.props.onClick()
    findElementByTitle(element, 'Save pose clip sidecar')?.props.onClick()
    findElementByTitle(element, 'Load pose clip sidecar')?.props.onClick()

    assert.deepEqual(calls, [
      `rotate:${selectedBoneId}:x:-12.5`,
      `rotate:${selectedBoneId}:y:12.5`,
      `reset-target:${selectedBoneId}`,
      `capture:${selectedBoneId}:0.75`,
      'time:2',
      'preview:play',
      'preview:reset',
      'sidecar:save',
      'sidecar:load',
    ])
    assert.equal(calls.some((call) => /Manual|UniRig|Arm|Right/.test(call)), false)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel hides raw selected bone labels from the visible action rail', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()

  try {
    const rawBoneSummary: RigSkeletonSummary = {
      hasRig: true,
      sourceWorkspacePath: 'Models/raw.glb',
      skeletonContextId: 'rig:raw|skeleton:0',
      skinnedMeshContexts: ['rig:raw|skeleton:0'],
      rootBoneIds: ['rig:raw|skeleton:0|bone:bone_0#0' satisfies RigBoneId],
      stats: { skinnedMeshCount: 1, boneCount: 1 },
      warnings: [],
      bones: [
        { boneId: 'rig:raw|skeleton:0|bone:bone_0#0' satisfies RigBoneId, label: 'bone_0', originalName: 'bone_0', path: ['bone_0'], siblingIndex: 0, childIds: [], warnings: [] },
      ],
    }
    const html = renderToStaticMarkup(createElement(module.PoseClipPanel, {
      ...defaultPanelProps(rawBoneSummary),
      selectedBoneId: rawBoneSummary.bones[0].boneId,
      rigDisplayNames: {
        byBoneId: {
          [rawBoneSummary.bones[0].boneId]: { boneId: rawBoneSummary.bones[0].boneId, label: 'Hips', rawLabel: 'bone_0', provenance: 'unirig' },
        },
        ordered: [{ boneId: rawBoneSummary.bones[0].boneId, label: 'Hips', rawLabel: 'bone_0', provenance: 'unirig' }],
      } satisfies RigDisplayNamingResult,
      drawerMode: 'expanded',
    }))

    assert.doesNotMatch(html, />bone_0</)
    assert.doesNotMatch(html, />Hips</)
    assertNoDrawerModeControls(html)
  } finally {
    await cleanup()
  }
})

test('PoseClipPanel stale or no-rig target fails safely while preserving sidecar actions', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const summary = createRigSummary()

  try {
    const noRigHtml = renderToStaticMarkup(createElement(module.PoseClipPanel, {
      ...defaultPanelProps(createNoRigSummary()),
      selectedBoneId: undefined,
      keyframes: [],
    }))
    assert.match(noRigHtml, /Save sidecar/)
    assert.match(noRigHtml, /Load sidecar/)
    assertActionFirstMarkup(noRigHtml)
    assertNoVisibleTargetStatus(noRigHtml)

    const staleHtml = renderToStaticMarkup(createElement(module.PoseClipPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: 'rig:missing|bone:ghost#0' satisfies RigBoneId,
      drawerMode: 'expanded',
    }))
    assert.match(staleHtml, /Save sidecar/)
    assert.match(staleHtml, /Load sidecar/)
    assertActionFirstMarkup(staleHtml)
    assertNoVisibleTargetStatus(staleHtml)
    assertNoDrawerModeControls(staleHtml)
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

test('mounted PoseClipPanel blocks pending and unavailable capability callbacks in both drawer modes', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const calls: unknown[] = []
  const props = { ...defaultPanelProps(), canSaveSidecar: true, canLoadSidecar: true }
  for (const key of Object.keys(props)) if (key.startsWith('on')) (props as any)[key] = (...args: unknown[]) => calls.push([key, ...args])
  const mounted = mountComponent(module.PoseClipPanel, props)
  try {
    for (const drawerMode of ['expanded', 'minimized']) {
      for (const state of [{ saveState: 'saving' }, { loadState: 'loading' }]) {
        mounted.update({ ...props, drawerMode, ...state })
        for (const label of ['Capture pose keyframe', 'Rotate selected target +X', 'Save pose clip sidecar', 'Load pose clip sidecar', 'Play Pose/Clip preview']) {
          const button = mounted.get(label)
          assert.equal(button.props.disabled, true, label)
          button.props.onClick()
        }
        mounted.get('Current time scrubber').props.onChange({ currentTarget: { valueAsNumber: 1.5 } })
      }
      mounted.update({ ...props, drawerMode, canSaveSidecar: false, canLoadSidecar: false })
      for (const label of ['Save pose clip sidecar', 'Load pose clip sidecar']) {
        assert.equal(mounted.get(label).props.disabled, true)
        mounted.get(label).props.onClick()
      }
    }
    assert.deepEqual(calls, [])
    mounted.update({ ...props, summary: createNoRigSummary(), selectedBoneId: props.summary.bones[0].boneId })
    assert.equal(mounted.get('Capture pose keyframe').props.disabled, true)
    assert.equal(mounted.get('Play Pose/Clip preview').props.disabled, true)
  } finally { mounted.unmount(); await cleanup() }
})

test('mounted PoseClipPanel forwards stable target, capture and scrub controls across selection updates', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const calls: unknown[] = [], props = { ...defaultPanelProps() }
  for (const key of Object.keys(props)) if (key.startsWith('on')) (props as any)[key] = (...args: unknown[]) => calls.push([key, ...args])
  const mounted = mountComponent(module.PoseClipPanel, props)
  try {
    mounted.get('Capture pose keyframe').props.onClick()
    mounted.get('Rotate selected target -Z').props.onClick()
    mounted.get('Reset selected target pose').props.onClick()
    mounted.get('Current time scrubber').props.onChange({ currentTarget: { valueAsNumber: 1.125 } })
    const bone = props.summary.bones[1].boneId, other = props.summary.bones[2].boneId
    assert.deepEqual(calls, [['onCaptureKeyframe', bone, 0.75], ['onRotateSelectedTarget', bone, 'z', -10], ['onResetSelectedTarget', bone], ['onCurrentTimeChange', 1.125]])
    mounted.update({ ...props, selectedBoneId: other, currentTimeSeconds: 1.75 })
    mounted.get('Capture pose keyframe').props.onClick()
    assert.deepEqual(calls.at(-1), ['onCaptureKeyframe', other, 1.75])
    assert.doesNotMatch(mounted.text(), /Right_Arm/)
    mounted.update({ ...props, selectedBoneId: 'missing' })
    const before = calls.length
    for (const label of ['Capture pose keyframe', 'Rotate selected target +X', 'Reset selected target pose']) {
      assert.equal(mounted.get(label).props.disabled, true); mounted.get(label).props.onClick()
    }
    assert.equal(calls.length, before)
  } finally { mounted.unmount(); await cleanup() }
})

test('mounted PoseClipPanel preserves caller-owned data and visible errors across retry and legacy mode changes', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const calls: unknown[] = []
  const props = { ...defaultPanelProps(), canSaveSidecar: true, canLoadSidecar: true,
    onDrawerModeChange: (mode: string) => calls.push(mode), onSaveSidecar: () => calls.push('save'),
    onLoadSidecar: () => calls.push('load'), onPreviewPlay: () => calls.push('play'), onPreviewPause: () => calls.push('pause'), onPreviewReset: () => calls.push('reset') }
  const original = JSON.stringify(props.keyframes)
  const mounted = mountComponent(module.PoseClipPanel, props)
  try {
    assert.ok(mounted.get('Pose/Clip action rail'))
    mounted.update({ ...props, drawerMode: 'minimized', saveState: 'error', saveError: 'Disk unavailable', loadState: 'error', loadError: 'Invalid sidecar', warnings: [{ kind: 'unavailable-target', message: 'Source target is unavailable' }] })
    assert.match(mounted.text(), /Disk unavailable/)
    assert.match(mounted.text(), /Invalid sidecar/)
    assert.match(mounted.text(), /Source target is unavailable/)
    assert.ok(mounted.nodes().some(node => node.props.role === 'alert'))
    mounted.get('Save pose clip sidecar').props.onClick()
    mounted.get('Load pose clip sidecar').props.onClick()
    mounted.get('Play Pose/Clip preview').props.onClick()
    mounted.update({ ...props, drawerMode: 'minimized', previewState: 'playing' })
    mounted.get('Pause Pose/Clip preview').props.onClick()
    mounted.get('Reset Pose/Clip preview').props.onClick()
    mounted.update({ ...props, drawerMode: 'expanded', saveState: 'saved' })
    assert.match(mounted.text(), /Sidecar saved/)
    assert.equal(mounted.get('Current time scrubber').props.value, 0.75)
    assert.equal(JSON.stringify(props.keyframes), original)
    assert.deepEqual(calls, ['save', 'load', 'play', 'pause', 'reset'])
  } finally { mounted.unmount(); await cleanup() }
})

test('mounted PoseClipPanel ignores nonfinite input and invalid rotation rather than authoring fallback values', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const calls: unknown[] = []
  const props = { ...defaultPanelProps(), onCurrentTimeChange: (v: number) => calls.push(v), onClipMetadataChange: (v: unknown) => calls.push(v), onRotateSelectedTarget: (...v: unknown[]) => calls.push(v) }
  const mounted = mountComponent(module.PoseClipPanel, { ...props, rotationStepDegrees: NaN })
  try {
    for (const label of ['Current time scrubber']) {
      for (const valueAsNumber of [NaN, Infinity, -Infinity]) mounted.get(label).props.onChange({ currentTarget: { valueAsNumber } })
    }
    assert.equal(mounted.get('Rotate selected target +X').props.disabled, true)
    mounted.get('Rotate selected target +X').props.onClick()
    assert.deepEqual(calls, [])
  } finally { mounted.unmount(); await cleanup() }
})

test('mounted PoseClipPanel disabled controls are inert and native buttons keep keyboard names', async () => {
  const { module, cleanup } = await loadPoseClipPanelModule()
  const calls: unknown[] = [], props = { ...defaultPanelProps() }
  for (const key of Object.keys(props)) if (key.startsWith('on')) (props as any)[key] = (...args: unknown[]) => calls.push([key, ...args])
  const mounted = mountComponent(module.PoseClipPanel, props)
  try {
    for (const mode of ['expanded', 'minimized']) {
      for (const state of [{ rotationStepDegrees: NaN }, { currentTimeSeconds: NaN }, { saveState: 'saving' }, { loadState: 'loading' }, { selectedBoneId: undefined }, { summary: createNoRigSummary() }]) {
        mounted.update({ ...props, drawerMode: mode, ...state })
        const before = calls.length
        for (const node of mounted.nodes().filter(node => node.type === 'button')) {
          assert.equal(node.props.type, 'button')
          assert.ok(node.props['aria-label'] || node.props.title, 'native buttons need an accessible name')
          assert.match(node.props.className, /focus-visible:/)
          if (node.props.disabled) node.props.onClick()
        }
        assert.equal(calls.length, before, `${mode}: ${JSON.stringify(state)}`)
      }
    }
  } finally { mounted.unmount(); await cleanup() }
})
