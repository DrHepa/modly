import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { RigEffectiveNamingResult } from '../rigEffectiveNaming.ts'
import type { RigSkeletonSummary } from '../rigSkeleton.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const rigTargetBrowserEntry = path.join(projectRoot, 'src/areas/generate/components/RigTargetBrowser.tsx')

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

async function loadRigTargetBrowserModule() {
  const cacheRoot = path.join(projectRoot, 'node_modules/.cache')
  await mkdir(cacheRoot, { recursive: true })
  const tempDir = await mkdtemp(path.join(cacheRoot, 'modly-rig-target-browser-'))
  const outfile = path.join(tempDir, 'RigTargetBrowser.bundle.mjs')

  try {
    await build({
      entryPoints: [rigTargetBrowserEntry],
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

function renderBrowser(RigTargetBrowser: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(RigTargetBrowser, props))
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

test('RigTargetBrowser renders shared hierarchy, selected details, effective labels, and action slot content', async () => {
  const { module, cleanup } = await loadRigTargetBrowserModule()
  const summary = createRigSummary()
  const selectedBone = summary.bones[1]
  const effectiveNaming = createEffectiveNaming(summary, {
    [summary.bones[0].boneId]: { label: 'UniRig Pelvis', provenance: 'unirig' },
    [selectedBone.boneId]: { label: 'Manual Chest', provenance: 'manual' },
  })

  try {
    const html = renderBrowser(module.RigTargetBrowser, {
      summary,
      selectedBoneId: selectedBone.boneId,
      effectiveNaming,
      onSelectBone: () => undefined,
      actions: (bone: { boneId: string; displayName: string }) => createElement('button', { type: 'button', title: `Pose action for ${bone.displayName}` }, `Act on ${bone.boneId}`),
    })

    assert.match(html, /Selected bone/)
    assert.match(html, /Selected: Manual Chest/)
    assert.match(html, /Name source: manual/)
    assert.match(html, /Parent: UniRig Pelvis/)
    assert.match(html, /Children \(1\): Left Arm/)
    assert.match(html, /aria-label="Select bone UniRig Pelvis"/)
    assert.match(html, /aria-label="Select bone Manual Chest"[^>]*aria-selected="true"/)
    assert.match(html, /title="Pose action for Manual Chest"/)
    assert.match(html, new RegExp(`Act on ${selectedBone.boneId.replace(/[|/\\#]/g, (char) => `\\${char}`)}`))
  } finally {
    await cleanup()
  }
})

test('RigTargetBrowser selection callbacks use stable RigBoneId even when display labels differ', async () => {
  const { module, cleanup } = await loadRigTargetBrowserModule()
  const summary = createRigSummary()
  const beforeSummary = structuredClone(summary)
  const selected: string[] = []
  const effectiveNaming = createEffectiveNaming(summary, {
    [summary.bones[2].boneId]: { label: 'UniRig Left Arm', provenance: 'unirig' },
  })

  try {
    const element = module.RigTargetBrowser({
      summary,
      selectedBoneId: summary.bones[0].boneId,
      effectiveNaming,
      onSelectBone: (boneId: string) => selected.push(boneId),
    })

    const leftArmButton = findElementByAriaLabel(element, 'Select bone UniRig Left Arm')
    assert.ok(leftArmButton, 'expected effective label to remain selectable')
    ;(leftArmButton.props as { onClick: () => void }).onClick()

    assert.deepEqual(selected, [summary.bones[2].boneId])
    assert.deepEqual(summary, beforeSummary)
  } finally {
    await cleanup()
  }
})

test('RigTargetBrowser keeps long hierarchies scrollable while selected details stay outside the scroll region', async () => {
  const { module, cleanup } = await loadRigTargetBrowserModule()
  const summary = createLongRigSummary()
  const selectedBone = summary.bones[20]

  try {
    const html = renderBrowser(module.RigTargetBrowser, {
      summary,
      selectedBoneId: selectedBone.boneId,
      onSelectBone: () => undefined,
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
