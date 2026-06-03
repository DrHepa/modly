import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { RigSkeletonSummary } from '../rigSkeleton.ts'
import type { RigRenamePlan, RigRenameValidationResult } from '../rigRenamePlan.ts'
import type { RigEffectiveNamingResult } from '../rigEffectiveNaming.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const rigEditorPanelEntry = path.join(projectRoot, 'src/areas/generate/components/RigEditorPanel.tsx')

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

async function loadRigEditorPanelModule() {
  const cacheRoot = path.join(projectRoot, 'node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  const tempDir = await mkdtemp(path.join(cacheRoot, 'modly-rig-editor-panel-'))
  const outfile = path.join(tempDir, 'RigEditorPanel.bundle.mjs')

  try {
    await build({
      entryPoints: [rigEditorPanelEntry],
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
  const rootId = 'rig:character|skeleton:0|bone:hips#0'
  const spineId = 'rig:character|skeleton:0|bone:hips#0/spine#0'
  const armId = 'rig:character|skeleton:0|bone:hips#0/spine#0/left_arm#0'

  return {
    hasRig: true,
    sourceWorkspacePath: 'Models/hero.glb',
    skeletonContextId: 'rig:character|skeleton:0',
    skinnedMeshContexts: ['rig:character|skeleton:0'],
    bones: [
      {
        boneId: rootId,
        label: 'Hips',
        originalName: 'Hips',
        path: ['Hips'],
        siblingIndex: 0,
        childIds: [spineId],
        warnings: [],
      },
      {
        boneId: spineId,
        label: 'Spine',
        originalName: 'Spine',
        path: ['Hips', 'Spine'],
        siblingIndex: 0,
        parentId: rootId,
        childIds: [armId],
        warnings: [],
      },
      {
        boneId: armId,
        label: 'Left Arm',
        originalName: 'Left Arm',
        path: ['Hips', 'Spine', 'Left Arm'],
        siblingIndex: 0,
        parentId: spineId,
        childIds: [],
        warnings: [],
      },
    ],
    rootBoneIds: [rootId],
    stats: { skinnedMeshCount: 1, boneCount: 3 },
    warnings: [],
  }
}

function createNoRigSummary(): RigSkeletonSummary {
  return {
    hasRig: false,
    sourceWorkspacePath: 'Models/prop.glb',
    skeletonContextId: 'rig:unknown|skeleton:0',
    skinnedMeshContexts: [],
    bones: [],
    rootBoneIds: [],
    stats: { skinnedMeshCount: 0, boneCount: 0 },
    warnings: ['No skeleton bones were found.'],
  }
}

function createLongRigSummary(count = 32): RigSkeletonSummary {
  const bones: RigSkeletonSummary['bones'] = []
  const rootId = 'rig:long|skeleton:0|bone:root#0'
  let previousId: string | undefined

  for (let index = 0; index < count; index += 1) {
    const label = index === 0 ? 'Root' : `Spine ${index}`
    const boneId = index === 0 ? rootId : `${previousId}/spine_${index}#0`
    const nextId = index < count - 1 ? `${boneId}/spine_${index + 1}#0` : undefined

    bones.push({
      boneId,
      label,
      originalName: label,
      path: bones.length === 0 ? ['Root'] : [...bones[bones.length - 1].path, label],
      siblingIndex: 0,
      ...(previousId ? { parentId: previousId } : {}),
      childIds: nextId ? [nextId] : [],
      warnings: [],
    })
    previousId = boneId
  }

  return {
    hasRig: true,
    sourceWorkspacePath: 'Models/long-unirig.glb',
    skeletonContextId: 'rig:long|skeleton:0',
    skinnedMeshContexts: ['rig:long|skeleton:0'],
    bones,
    rootBoneIds: [rootId],
    stats: { skinnedMeshCount: 1, boneCount: bones.length },
    warnings: [],
  }
}

function createRawBoneRigSummary(): RigSkeletonSummary {
  const contextualIds = {
    hips: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0',
    spine: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0',
    unmapped: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0',
    chest: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0',
    neck: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0/bone_4#0',
    head: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0/bone_4#0/bone_5#0',
  }

  return {
    hasRig: true,
    sourceWorkspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb',
    skeletonContextId: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0',
    skinnedMeshContexts: ['rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0'],
    bones: [
      {
        boneId: contextualIds.hips,
        label: 'bone_0',
        originalName: 'bone_0',
        path: ['bone_0'],
        siblingIndex: 0,
        childIds: [contextualIds.spine],
        warnings: [],
      },
      {
        boneId: contextualIds.spine,
        label: 'bone_1',
        originalName: 'bone_1',
        path: ['bone_0', 'bone_1'],
        siblingIndex: 0,
        parentId: contextualIds.hips,
        childIds: [contextualIds.unmapped],
        warnings: [],
      },
      {
        boneId: contextualIds.unmapped,
        label: 'bone_2',
        originalName: 'bone_2',
        path: ['bone_0', 'bone_1', 'bone_2'],
        siblingIndex: 0,
        parentId: contextualIds.spine,
        childIds: [contextualIds.chest],
        warnings: [],
      },
      {
        boneId: contextualIds.chest,
        label: 'bone_3',
        originalName: 'bone_3',
        path: ['bone_0', 'bone_1', 'bone_2', 'bone_3'],
        siblingIndex: 0,
        parentId: contextualIds.unmapped,
        childIds: [contextualIds.neck],
        warnings: [],
      },
      {
        boneId: contextualIds.neck,
        label: 'bone_4',
        originalName: 'bone_4',
        path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4'],
        siblingIndex: 0,
        parentId: contextualIds.chest,
        childIds: [contextualIds.head],
        warnings: [],
      },
      {
        boneId: contextualIds.head,
        label: 'bone_5',
        originalName: 'bone_5',
        path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4', 'bone_5'],
        siblingIndex: 0,
        parentId: contextualIds.neck,
        childIds: [],
        warnings: [],
      },
    ],
    rootBoneIds: [contextualIds.hips],
    stats: { skinnedMeshCount: 1, boneCount: 6 },
    warnings: [],
  }
}

function createRawBone20RigSummary(): RigSkeletonSummary {
  const rootId = 'rig:Workflows/raw-bone20-unirig.glb|skeleton:0|bone:bone_0#0'
  const leftUpperLegId = `${rootId}/bone_20#0`

  return {
    hasRig: true,
    sourceWorkspacePath: 'Workflows/raw-bone20-unirig.glb',
    skeletonContextId: 'rig:Workflows/raw-bone20-unirig.glb|skeleton:0',
    skinnedMeshContexts: ['rig:Workflows/raw-bone20-unirig.glb|skeleton:0'],
    bones: [
      {
        boneId: rootId,
        label: 'bone_0',
        originalName: 'bone_0',
        path: ['bone_0'],
        siblingIndex: 0,
        childIds: [leftUpperLegId],
        warnings: [],
      },
      {
        boneId: leftUpperLegId,
        label: 'bone_20',
        originalName: 'bone_20',
        path: ['bone_0', 'bone_20'],
        siblingIndex: 0,
        parentId: rootId,
        childIds: [],
        warnings: [],
      },
    ],
    rootBoneIds: [rootId],
    stats: { skinnedMeshCount: 1, boneCount: 2 },
    warnings: [],
  }
}

function createPlan(summary: RigSkeletonSummary, aliases: RigRenamePlan['aliases'] = {}): RigRenamePlan {
  return { skeletonContextId: summary.skeletonContextId, aliases }
}

function validRenamePlan(): RigRenameValidationResult {
  return { valid: true, errors: [] }
}

function createEffectiveNaming(summary = createRigSummary(), labels: Record<string, { label: string; provenance: 'manual' | 'unirig' | 'raw' }>): RigEffectiveNamingResult {
  const byBoneId: RigEffectiveNamingResult['byBoneId'] = {}
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
    renamePlan: createPlan(summary),
    validation: validRenamePlan(),
    onSelectBone: () => undefined,
    onAliasChange: () => undefined,
    onCancelAlias: () => undefined,
    onRevertAliases: () => undefined,
    onSaveAliases: () => undefined,
  }
}

function renderPanel(RigEditorPanel: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(RigEditorPanel, props))
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

test('RigEditorPanel renders a simple hierarchy and selected bone details from controlled props', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()

  try {
    const html = renderPanel(module.RigEditorPanel, defaultPanelProps(summary))

    assert.match(html, /Rig Editor/)
    assert.match(html, /3 bones/)
    assert.match(html, /Hips/)
    assert.match(html, /Spine/)
    assert.match(html, /Left Arm/)
    assert.match(html, /Selected bone/)
    assert.match(html, /Path: Hips \/ Spine/)
    assert.match(html, /Original name: Spine/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel keeps long hierarchies in an accessible scroll region without hiding selected details', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createLongRigSummary()
  const selectedBone = summary.bones[20]

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
    })

    assert.match(html, /Selected bone details/)
    assert.match(html, /Selected: Spine 20/)
    assert.match(html, /Parent: Spine 19/)
    assert.match(html, /Children \(1\): Spine 21/)
    assert.match(html, /aria-label="Scrollable rig bone hierarchy"/)
    assert.match(html, /tabindex="0"/)
    assert.match(html, /Scroll to browse all 32 bones/)
    assert.match(html, /Spine 31/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel marks the selected tree item with an accessible selected affordance', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const selectedBone = summary.bones[1]

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
    })

    assert.match(html, /aria-label="Select bone Spine"[^>]*aria-selected="true"/)
    assert.match(html, /Select bone Spine[\s\S]*Selected/)
    assert.match(html, /Parent: Hips/)
    assert.match(html, /Children \(1\): Left Arm/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel bone selection and alias editing invoke callbacks without mutating the summary', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const beforeLabels = summary.bones.map((bone) => bone.label)
  const selected: string[] = []
  const aliases: Array<[string, string]> = []

  try {
    const element = module.RigEditorPanel({
      ...defaultPanelProps(summary),
      selectedBoneId: summary.bones[0].boneId,
      onSelectBone: (boneId: string) => selected.push(boneId),
      onAliasChange: (boneId: string, alias: string) => aliases.push([boneId, alias]),
    })
    const leftArmButton = findElementByAriaLabel(element, 'Select bone Left Arm')
    assert.ok(leftArmButton, 'expected a selectable Left Arm bone control')
    ;(leftArmButton.props as { onClick: () => void }).onClick()

    const aliasInput = findElementByAriaLabel(element, 'Alias for Hips')
    assert.ok(aliasInput, 'expected a controlled alias input for the selected bone')
    ;(aliasInput.props as { onChange: (event: { currentTarget: { value: string } }) => void }).onChange({ currentTarget: { value: 'Pelvis' } })

    assert.deepEqual(selected, [summary.bones[2].boneId])
    assert.deepEqual(aliases, [[summary.bones[0].boneId, 'Pelvis']])
    assert.deepEqual(summary.bones.map((bone) => bone.label), beforeLabels)
    assert.equal(summary.bones[0].originalName, 'Hips')
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel shows validation errors, disables save when invalid, and keeps cancel/revert visible', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const selectedBone = summary.bones[1]

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
      renamePlan: createPlan(summary, {
        [selectedBone.boneId]: { oldLabel: selectedBone.label, alias: 'Hips' },
      }),
      validation: {
        valid: false,
        errors: [
          {
            boneId: selectedBone.boneId,
            code: 'duplicate-alias',
            message: 'Alias "Hips" for "Spine" collides with "Hips" in this skeleton.',
          },
        ],
      },
    })

    assert.match(html, /Alias &quot;Hips&quot; for &quot;Spine&quot; collides with &quot;Hips&quot; in this skeleton\./)
    assert.match(html, /role="alert"/)
    assert.match(html, /title="Save rig aliases"[^>]*disabled=""/)
    assert.match(html, /title="Cancel alias for Spine"/)
    assert.match(html, /title="Revert all rig aliases"/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel hides hydration warnings when no sidecar warning is provided', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()

  try {
    const absentWarningHtml = renderPanel(module.RigEditorPanel, defaultPanelProps(summary))
    const nullWarningHtml = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      hydrationWarning: null,
    })

    assert.doesNotMatch(absentWarningHtml, /saved aliases could not be loaded/i)
    assert.doesNotMatch(absentWarningHtml, /rig is still usable/i)
    assert.doesNotMatch(nullWarningHtml, /saved aliases could not be loaded/i)
    assert.doesNotMatch(nullWarningHtml, /rig is still usable/i)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel shows invalid sidecar hydration warning without blocking rig editing controls', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const selectedBone = summary.bones[1]
  const selected: string[] = []
  const aliases: Array<[string, string]> = []
  let saveCount = 0

  try {
    const element = module.RigEditorPanel({
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
      renamePlan: createPlan(summary, {
        [selectedBone.boneId]: { oldLabel: selectedBone.label, alias: 'Chest Control' },
      }),
      hydrationWarning: { status: 'warning', messages: ['Rig rename sidecar JSON is invalid.'] },
      onSelectBone: (boneId: string) => selected.push(boneId),
      onAliasChange: (boneId: string, alias: string) => aliases.push([boneId, alias]),
      onSaveAliases: () => { saveCount += 1 },
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /role="status"/)
    assert.match(html, /saved aliases could not be loaded/i)
    assert.match(html, /rig is still usable/i)
    assert.match(html, /Rig rename sidecar JSON is invalid\./)

    const hipsButton = findElementByAriaLabel(element, 'Select bone Hips')
    assert.ok(hipsButton, 'expected tree selection to remain available')
    ;(hipsButton.props as { onClick: () => void }).onClick()

    const aliasInput = findElementByAriaLabel(element, 'Alias for Spine')
    assert.ok(aliasInput, 'expected alias input to remain editable')
    ;(aliasInput.props as { onChange: (event: { currentTarget: { value: string } }) => void }).onChange({ currentTarget: { value: 'Chest FK' } })

    const saveButton = findElementByTitle(element, 'Save rig aliases')
    assert.ok(saveButton, 'expected save button to remain available')
    assert.equal((saveButton.props as { disabled?: boolean }).disabled, false)
    ;(saveButton.props as { onClick: () => void }).onClick()

    assert.deepEqual(selected, [summary.bones[0].boneId])
    assert.deepEqual(aliases, [[selectedBone.boneId, 'Chest FK']])
    assert.equal(saveCount, 1)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel renders newbie-friendly empty state for models without rig and no save actions', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createNoRigSummary()

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: undefined,
      renamePlan: createPlan(summary),
    })

    assert.match(html, /No rig detected/)
    assert.match(html, /This model does not expose skeleton bones yet/)
    assert.match(html, /Try a rigged character GLB to inspect bones and plan safe aliases/)
    assert.doesNotMatch(html, /Save rig aliases/)
    assert.doesNotMatch(html, /Delete/)
    assert.doesNotMatch(html, /Export GLB/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel displays UniRig effective labels in the existing tree and details when no manual alias exists', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const beforeLabels = summary.bones.map((bone) => bone.label)
  const effectiveNaming = createEffectiveNaming(summary, {
    [summary.bones[0].boneId]: { label: 'UniRig Pelvis', provenance: 'unirig' },
    [summary.bones[1].boneId]: { label: 'UniRig Spine', provenance: 'unirig' },
  })

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: summary.bones[1].boneId,
      effectiveNaming,
    })

    assert.match(html, /aria-label="Select bone UniRig Pelvis"/)
    assert.match(html, /aria-label="Select bone UniRig Spine"[^>]*aria-selected="true"/)
    assert.match(html, /Selected: UniRig Spine/)
    assert.match(html, /Name source: UniRig/)
    assert.match(html, /Parent: UniRig Pelvis/)
    assert.match(html, /Children \(1\): Left Arm/)
    assert.match(html, /Original name: Spine/)
    assert.deepEqual(summary.bones.map((bone) => bone.label), beforeLabels)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel gives manual aliases priority over UniRig labels and keeps alias editing manual', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const selectedBone = summary.bones[1]
  const effectiveNaming = createEffectiveNaming(summary, {
    [summary.bones[0].boneId]: { label: 'UniRig Pelvis', provenance: 'unirig' },
    [selectedBone.boneId]: { label: 'Manual Chest', provenance: 'manual' },
  })
  const aliases: Array<[string, string]> = []
  let saveCount = 0

  try {
    const element = module.RigEditorPanel({
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
      renamePlan: createPlan(summary, {
        [selectedBone.boneId]: { oldLabel: selectedBone.label, alias: 'Manual Chest' },
      }),
      effectiveNaming,
      onAliasChange: (boneId: string, alias: string) => aliases.push([boneId, alias]),
      onSaveAliases: () => { saveCount += 1 },
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /aria-label="Select bone Manual Chest"[^>]*aria-selected="true"/)
    assert.doesNotMatch(html, /aria-label="Select bone UniRig Spine"/)
    assert.match(html, /Selected: Manual Chest/)
    assert.match(html, /Name source: manual/)

    const aliasInput = findElementByAriaLabel(element, 'Alias for Manual Chest')
    assert.ok(aliasInput, 'expected alias input to stay editable under the manual display label')
    assert.equal((aliasInput.props as { value: string }).value, 'Manual Chest')
    ;(aliasInput.props as { onChange: (event: { currentTarget: { value: string } }) => void }).onChange({ currentTarget: { value: 'Manual Chest FK' } })

    assert.deepEqual(aliases, [[selectedBone.boneId, 'Manual Chest FK']])
    assert.equal(saveCount, 0, 'rigmeta/effective labels must not auto-save aliases')
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel displays contract-derived semantic labels while keeping original raw bone names and stable alias ids', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRawBone20RigSummary()
  const selectedBone = summary.bones[1]
  const aliases: Array<[string, string]> = []
  const effectiveNaming = createEffectiveNaming(summary, {
    [selectedBone.boneId]: { label: 'Left Upper Leg', provenance: 'unirig' },
  })

  try {
    const element = module.RigEditorPanel({
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
      effectiveNaming,
      onAliasChange: (boneId: string, alias: string) => aliases.push([boneId, alias]),
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /aria-label="Select bone Left Upper Leg"[^>]*aria-selected="true"/)
    assert.match(html, /Selected: Left Upper Leg/)
    assert.match(html, /Name source: UniRig/)
    assert.match(html, /Original name: bone_20/)
    assert.doesNotMatch(html, /Selected: bone_20/)

    const aliasInput = findElementByAriaLabel(element, 'Alias for Left Upper Leg')
    assert.ok(aliasInput, 'expected contract-derived label to be used as input context')
    ;(aliasInput.props as { onChange: (event: { currentTarget: { value: string } }) => void }).onChange({ currentTarget: { value: 'Manual Leg FK' } })

    assert.deepEqual(aliases, [[selectedBone.boneId, 'Manual Leg FK']])
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel keeps manual aliases above contract-derived labels for raw-only rigs', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRawBone20RigSummary()
  const selectedBone = summary.bones[1]

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
      renamePlan: createPlan(summary, {
        [selectedBone.boneId]: { oldLabel: selectedBone.label, alias: 'Manual Upper Leg' },
      }),
      effectiveNaming: createEffectiveNaming(summary, {
        [selectedBone.boneId]: { label: 'Manual Upper Leg', provenance: 'manual' },
      }),
    })

    assert.match(html, /aria-label="Select bone Manual Upper Leg"[^>]*aria-selected="true"/)
    assert.match(html, /Selected: Manual Upper Leg/)
    assert.match(html, /Name source: manual/)
    assert.match(html, /Original name: bone_20/)
    assert.doesNotMatch(html, /Selected: Left Upper Leg/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel falls back to raw GLB labels and raw provenance when no alias or UniRig label exists', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: summary.bones[2].boneId,
      effectiveNaming: createEffectiveNaming(summary, {}),
    })

    assert.match(html, /aria-label="Select bone Left Arm"[^>]*aria-selected="true"/)
    assert.match(html, /Selected: Left Arm/)
    assert.match(html, /Name source: raw/)
    assert.match(html, /Path: Hips \/ Spine \/ Left Arm/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel callbacks continue to use stable boneId even when effective display labels differ', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const beforeSummary = structuredClone(summary)
  const selected: string[] = []
  const aliases: Array<[string, string]> = []
  const effectiveNaming = createEffectiveNaming(summary, {
    [summary.bones[0].boneId]: { label: 'UniRig Pelvis', provenance: 'unirig' },
    [summary.bones[2].boneId]: { label: 'UniRig Left Arm', provenance: 'unirig' },
  })

  try {
    const element = module.RigEditorPanel({
      ...defaultPanelProps(summary),
      selectedBoneId: summary.bones[0].boneId,
      effectiveNaming,
      onSelectBone: (boneId: string) => selected.push(boneId),
      onAliasChange: (boneId: string, alias: string) => aliases.push([boneId, alias]),
    })

    const leftArmButton = findElementByAriaLabel(element, 'Select bone UniRig Left Arm')
    assert.ok(leftArmButton, 'expected effective label to be selectable in the existing tree')
    ;(leftArmButton.props as { onClick: () => void }).onClick()

    const aliasInput = findElementByAriaLabel(element, 'Alias for UniRig Pelvis')
    assert.ok(aliasInput, 'expected alias input to use effective context but stable callback IDs')
    ;(aliasInput.props as { onChange: (event: { currentTarget: { value: string } }) => void }).onChange({ currentTarget: { value: 'Manual Pelvis' } })

    assert.deepEqual(selected, [summary.bones[2].boneId])
    assert.deepEqual(aliases, [[summary.bones[0].boneId, 'Manual Pelvis']])
    assert.deepEqual(summary, beforeSummary)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel uses semantic draft labels for raw-bone selected details and hierarchy when effective naming exists', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRawBoneRigSummary()

  try {
    const html = renderPanel(module.RigEditorPanel, {
      ...defaultPanelProps(summary),
      selectedBoneId: summary.bones[3]!.boneId,
      effectiveNaming: createEffectiveNaming(summary, {
        [summary.bones[0]!.boneId]: { label: 'Hip', provenance: 'manual' },
        [summary.bones[1]!.boneId]: { label: 'Spine', provenance: 'unirig' },
        [summary.bones[3]!.boneId]: { label: 'Chest', provenance: 'unirig' },
        [summary.bones[4]!.boneId]: { label: 'Neck', provenance: 'unirig' },
        [summary.bones[5]!.boneId]: { label: 'Head', provenance: 'unirig' },
      }),
    })

    assert.match(html, /Selected: Chest/)
    assert.match(html, /Parent: bone_2/)
    assert.match(html, /Children \(1\): Neck/)
    assert.match(html, /Path: Hip \/ Spine \/ bone_2 \/ Chest/)
    assert.match(html, /aria-label="Select bone Hip"/)
    assert.match(html, /aria-label="Select bone Spine"/)
    assert.match(html, /aria-label="Select bone Chest"/)
    assert.match(html, /aria-label="Select bone Neck"/)
    assert.match(html, /aria-label="Select bone Head"/)
    assert.doesNotMatch(html, /aria-label="Select bone bone_1"/)
    assert.doesNotMatch(html, /aria-label="Select bone bone_3"/)
    assert.doesNotMatch(html, /aria-label="Select bone bone_4"/)
    assert.doesNotMatch(html, /aria-label="Select bone bone_5"/)
  } finally {
    await cleanup()
  }
})

test('RigEditorPanel keeps invalid rigmeta warnings non-blocking while effective labels remain editable', async () => {
  const { module, cleanup } = await loadRigEditorPanelModule()
  const summary = createRigSummary()
  const selectedBone = summary.bones[1]
  const aliases: Array<[string, string]> = []
  let saveCount = 0

  try {
    const element = module.RigEditorPanel({
      ...defaultPanelProps(summary),
      selectedBoneId: selectedBone.boneId,
      effectiveNaming: createEffectiveNaming(summary, {
        [selectedBone.boneId]: { label: 'UniRig Spine', provenance: 'unirig' },
      }),
      hydrationWarning: { status: 'warning', messages: ['Rigmeta JSON is invalid.'] },
      onAliasChange: (boneId: string, alias: string) => aliases.push([boneId, alias]),
      onSaveAliases: () => { saveCount += 1 },
    })
    const html = renderToStaticMarkup(element)

    assert.match(html, /role="status"/)
    assert.match(html, /Rigmeta JSON is invalid\./)

    const aliasInput = findElementByAriaLabel(element, 'Alias for UniRig Spine')
    assert.ok(aliasInput, 'expected invalid rigmeta warning to be non-blocking')
    ;(aliasInput.props as { onChange: (event: { currentTarget: { value: string } }) => void }).onChange({ currentTarget: { value: 'Manual Spine' } })

    const saveButton = findElementByTitle(element, 'Save rig aliases')
    assert.ok(saveButton, 'expected manual save control to remain present')
    assert.equal((saveButton.props as { disabled?: boolean }).disabled, true)

    assert.deepEqual(aliases, [[selectedBone.boneId, 'Manual Spine']])
    assert.equal(saveCount, 0)
  } finally {
    await cleanup()
  }
})
