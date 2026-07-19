import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const workflowPanelEntry = path.join(projectRoot, 'src/areas/generate/components/WorkflowPanel.tsx')
const workflowPanelSource = path.join(projectRoot, 'src/areas/generate/components/WorkflowPanel.tsx')

async function loadWorkflowPanelModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-workflow-panel-'))
  const outfile = path.join(tempDir, 'WorkflowPanel.bundle.mjs')

  await build({
    entryPoints: [workflowPanelEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom/server', 'react/jsx-runtime', '@xyflow/react', 'zustand', 'axios'],
  })

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function renderWorkflowRunFeedback(props: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return renderToStaticMarkup(createElement(module.WorkflowRunFeedback, props))
  } finally {
    await cleanup()
  }
}

async function renderArtifactHistoryDisclosure(props: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return renderToStaticMarkup(createElement(module.ArtifactHistoryDisclosure, props))
  } finally {
    await cleanup()
  }
}

async function deriveWaitParamRowArtifactHistoryRows(input: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return module.deriveWaitParamRowArtifactHistoryRows(input)
  } finally {
    await cleanup()
  }
}

async function resolveWorkflowPanelLandmarkGuidance(input: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return module.resolveWorkflowPanelLandmarkGuidance(input)
  } finally {
    await cleanup()
  }
}

async function resolveWorkflowRunPrimaryAction(input: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return module.resolveWorkflowRunPrimaryAction(input)
  } finally {
    await cleanup()
  }
}

async function executeWorkflowRunPrimaryAction(action: Record<string, unknown>, handlers: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return module.executeWorkflowRunPrimaryAction(action, handlers)
  } finally {
    await cleanup()
  }
}

async function executeWorkflowLandmarkGuidanceAction(action: Record<string, unknown>, handlers: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return module.executeWorkflowLandmarkGuidanceAction(action, handlers)
  } finally {
    await cleanup()
  }
}

async function renderWorkflowLandmarkGuidance(props: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return renderToStaticMarkup(createElement(module.WorkflowLandmarkGuidance, props))
  } finally {
    await cleanup()
  }
}

async function renderWorkflowRunFooter(props: Record<string, unknown>) {
  const { module, cleanup } = await loadWorkflowPanelModule()

  try {
    return renderToStaticMarkup(createElement(module.WorkflowRunFooter, props))
  } finally {
    await cleanup()
  }
}

function meshArtifact(id: string, filePath: string, versionId: string) {
  return {
    id,
    kind: 'mesh',
    uri: filePath,
    versionId,
    legacy: { filePath, outputType: 'mesh' },
  }
}

function substitutionPoint(nodeId: string, inputArtifact: ReturnType<typeof meshArtifact>) {
  return {
    kind: 'artifact_substitution',
    nodeId,
    inputArtifactId: inputArtifact.id,
    inputArtifact,
    allowedKinds: ['mesh'],
    status: 'declared',
    interaction: {
      boundary: 'ui_only',
      headless: false,
      editor: 'none',
      continueMode: 'manual',
    },
  }
}

const artifactHistoryRows = [
  {
    kind: 'checkpoint-original',
    label: 'Temporary checkpoint',
    description: 'Starting artifact: mesh at /workspace/original.glb (version v1).',
    status: 'available',
  },
  {
    kind: 'pending-edited-copy',
    label: 'Edited copy pending',
    description: 'Edited copy: mesh at /workspace/edited.glb (version v2). It will only be used if you continue with it.',
    status: 'pending',
  },
  {
    kind: 'replacement-used',
    label: 'Replacement used',
    description: 'Continue used the edited artifact: mesh at /workspace/edited.glb (version v2).',
    status: 'used',
  },
  {
    kind: 'original-used',
    label: 'Original used',
    description: 'Continue kept the original artifact: mesh at /workspace/original.glb (version v1). No replacement was applied.',
    status: 'skipped',
  },
  {
    kind: 'final-output',
    label: 'Final output',
    description: 'Current output: mesh at /workspace/final.glb (version v3).',
    status: 'available',
  },
]

test('WorkflowRunFeedback surfaces prompt-required and metadata dispatch errors with actionable copy', async () => {
  const promptRequiredHtml = await renderWorkflowRunFeedback({
    runState: {
      status: 'error',
      blockIndex: 0,
      blockTotal: 1,
      blockProgress: 0,
      blockStep: '',
      error: 'Error: prompt is required',
    },
    runValidationIssue: null,
    isRunning: false,
  })

  assert.match(promptRequiredHtml, /Prompt required/i)
  assert.match(promptRequiredHtml, /Add text in the workflow prompt field before generating\./i)

  const missingMetadataHtml = await renderWorkflowRunFeedback({
    runState: {
      status: 'error',
      blockIndex: 0,
      blockTotal: 1,
      blockProgress: 0,
      blockStep: '',
      error: 'Error: Missing workflow capability input metadata for extension: invalid/missing-input',
    },
    runValidationIssue: null,
    isRunning: false,
  })

  assert.match(missingMetadataHtml, /Capability metadata is incomplete/i)
  assert.match(missingMetadataHtml, /Modly cannot tell whether this model expects text or an image\./i)
})

test('deriveWaitParamRowArtifactHistoryRows maps original checkpoint and pending replacement from WaitParamRow inputs', async () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const pendingReplacement = meshArtifact('mesh-asset', '/workspace/checkpoints/original-edited.glb', 'mesh-asset-edited')

  const rows = await deriveWaitParamRowArtifactHistoryRows({
    waitNodeId: 'wait-node',
    nodeArtifacts: { 'wait-node': original },
    artifactLineages: {},
    substitutionPoint: substitutionPoint('wait-node', original),
    pendingReplacement,
  })

  assert.deepEqual(rows.map((row: { kind: string }) => row.kind), ['checkpoint-original', 'pending-edited-copy'])
})

test('deriveWaitParamRowArtifactHistoryRows maps accepted replacement and final output from WaitParamRow inputs', async () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const replacement = meshArtifact('mesh-asset', '/workspace/checkpoints/replacement.glb', 'mesh-asset-replacement')
  const finalOutput = meshArtifact('final-mesh', '/workspace/output/final.glb', 'final-v1')

  const rows = await deriveWaitParamRowArtifactHistoryRows({
    waitNodeId: 'wait-node',
    nodeArtifacts: { 'wait-node': original },
    artifactLineages: {},
    substitutionPoint: substitutionPoint('wait-node', original),
    runArtifact: finalOutput,
    replacementResult: {
      status: 'accepted',
      artifact: replacement,
      legacy: { filePath: replacement.uri, outputType: 'mesh' },
    },
  })

  assert.deepEqual(rows.map((row: { kind: string }) => row.kind), ['checkpoint-original', 'replacement-used', 'final-output'])
})

test('deriveWaitParamRowArtifactHistoryRows includes landmark sidecar history when available', async () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')

  const rows = await deriveWaitParamRowArtifactHistoryRows({
    waitNodeId: 'landmarks-node',
    nodeArtifacts: { 'landmarks-node': original },
    artifactLineages: {},
    landmarkSidecar: {
      sidecarRole: 'landmarks-sidecar',
      runId: 'workflow-landmarks-runtime',
      nodeId: 'landmarks-node',
      sidecarWorkspacePath: 'Workflows/landmarks/workflow-landmarks-runtime/landmarks-node.landmarks.v1.json',
      targetArtifactId: 'mesh-asset',
      targetVersionId: 'mesh-asset-original',
      targetMeshPath: '/workspace/checkpoints/original.glb',
      downstreamParam: 'landmarks_sidecar_path',
    },
  })

  assert.deepEqual(rows.map((row: { kind: string }) => row.kind), ['checkpoint-original', 'landmark-sidecar'])
  assert.match(rows[1].description, /Workflows\/landmarks\/workflow-landmarks-runtime\/landmarks-node\.landmarks\.v1\.json/)
})

test('deriveWaitParamRowArtifactHistoryRows does not mutate WaitParamRow artifact inputs', async () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const pendingReplacement = meshArtifact('mesh-asset', '/workspace/checkpoints/original-edited.glb', 'mesh-asset-edited')
  const input = {
    waitNodeId: 'wait-node',
    nodeArtifacts: { 'wait-node': original },
    artifactLineages: {
      'mesh-asset': {
        artifactId: original.id,
        originalVersionId: original.versionId,
        currentVersionId: original.versionId,
        versions: [{ id: original.versionId, role: 'original', ref: original, createdAt: '2026-05-17T16:00:00.000Z' }],
      },
    },
    substitutionPoint: substitutionPoint('wait-node', original),
    pendingReplacement,
  }
  const before = structuredClone(input)

  await deriveWaitParamRowArtifactHistoryRows(input)

  assert.deepEqual(input, before)
})

test('WorkflowRunFeedback keeps validation copy and explains unsupported capability modes', async () => {
  const unsupportedModeHtml = await renderWorkflowRunFeedback({
    runState: {
      status: 'error',
      blockIndex: 0,
      blockTotal: 1,
      blockProgress: 0,
      blockStep: '',
      error: 'Error: Unsupported workflow capability input for extension invalid/unsupported-input: mesh',
    },
    runValidationIssue: null,
    isRunning: false,
  })

  assert.match(unsupportedModeHtml, /Unsupported model mode/i)
  assert.match(unsupportedModeHtml, /This Generate panel only supports models that start from text or image inputs\./i)

  const validationHtml = await renderWorkflowRunFeedback({
    runState: {
      status: 'idle',
      blockIndex: 0,
      blockTotal: 0,
      blockProgress: 0,
      blockStep: '',
    },
    runValidationIssue: {
      message: 'Required port "prompt" is missing.',
    },
    isRunning: false,
  })

  assert.equal(validationHtml, '')
})

test('WorkflowPanel source keeps Generate ungated by semantic run validation', async () => {
  const source = await readFile(workflowPanelSource, 'utf8')

  assert.doesNotMatch(source, /validateWorkflowProcessRun/)
  assert.doesNotMatch(source, /hasRunValidationIssue/)
  assert.match(source, /WorkflowRunFeedback[\s\S]*runState=\{runState\}[\s\S]*runValidationIssue=\{null\}[\s\S]*isRunning=\{isRunning\}/)
})

test('ArtifactHistoryDisclosure is a collapsed secondary Wait checkpoint entry by default', async () => {
  const html = await renderArtifactHistoryDisclosure({ rows: artifactHistoryRows })

  assert.match(html, /Artifact history/i)
  assert.match(html, /Review the checkpoint artifact before you continue\./i)
  assert.doesNotMatch(html, /Temporary checkpoint/i)
  assert.doesNotMatch(html, /Final output/i)
})

test('ArtifactHistoryDisclosure shows short beginner-friendly artifact rows when expanded', async () => {
  const html = await renderArtifactHistoryDisclosure({ rows: artifactHistoryRows, defaultExpanded: true })

  assert.match(html, /Artifact history/i)
  assert.match(html, /Temporary checkpoint/i)
  assert.match(html, /Edited copy pending/i)
  assert.match(html, /Replacement used/i)
  assert.match(html, /Original used/i)
  assert.match(html, /Final output/i)
  assert.match(html, /It will only be used if you continue with it\./i)
})

test('ArtifactHistoryDisclosure degrades gracefully when the Wait checkpoint has no artifact context', async () => {
  const html = await renderArtifactHistoryDisclosure({ rows: [], defaultExpanded: true })

  assert.match(html, /Artifact history/i)
  assert.match(html, /No artifact history yet\./i)
  assert.doesNotMatch(html, /Temporary checkpoint/i)
})

test('ArtifactHistoryDisclosure stays hidden outside the Wait checkpoint context', async () => {
  const html = await renderArtifactHistoryDisclosure({ rows: artifactHistoryRows, isWaitCheckpoint: false })

  assert.equal(html, '')
})

test('resolveWorkflowPanelLandmarkGuidance shows current landmark, progress, remaining, and disabled continue copy', async () => {
  const guidance = await resolveWorkflowPanelLandmarkGuidance({
    nodeId: 'landmarks-node',
    activeNodeId: 'landmarks-node',
    session: {
      nodeId: 'landmarks-node',
      activeLandmarkId: 'hip',
      completed: {
        left_shoulder: { id: 'left_shoulder' },
        right_shoulder: { id: 'right_shoulder' },
      },
      validity: { valid: false, missing: ['hip', 'left_knee', 'right_knee'] },
      canContinue: false,
    },
  })

  assert.equal(guidance.isActive, true)
  assert.equal(guidance.currentLabel, 'Hip')
  assert.equal(guidance.currentToken, 'H')
  assert.equal(guidance.progressLabel, '2 of 5 landmarks marked')
  assert.equal(guidance.remainingLabel, 'Still needed: Hip, Left knee, Right knee')
  assert.deepEqual(guidance.remainingLandmarks.map((landmark: { label: string; token: string }) => [landmark.label, landmark.token]), [
    ['Hip', 'H'],
    ['Left knee', 'LK'],
    ['Right knee', 'RK'],
  ])
  assert.equal(guidance.continueDisabled, true)
  assert.match(guidance.instruction, /Click the mesh in the 3D viewer/i)
})

test('resolveWorkflowPanelLandmarkGuidance enables continue and uses completion copy when all required landmarks are marked', async () => {
  const guidance = await resolveWorkflowPanelLandmarkGuidance({
    nodeId: 'landmarks-node',
    activeNodeId: 'landmarks-node',
    session: {
      nodeId: 'landmarks-node',
      activeLandmarkId: 'right_knee',
      completed: {
        left_shoulder: { id: 'left_shoulder' },
        right_shoulder: { id: 'right_shoulder' },
        hip: { id: 'hip' },
        left_knee: { id: 'left_knee' },
        right_knee: { id: 'right_knee' },
      },
      validity: { valid: true, missing: [] },
      canContinue: true,
    },
  })

  assert.equal(guidance.currentLabel, 'Right knee')
  assert.equal(guidance.currentToken, 'RK')
  assert.equal(guidance.progressLabel, '5 of 5 landmarks marked')
  assert.equal(guidance.remainingLabel, 'All required landmarks are marked. You can continue.')
  assert.equal(guidance.continueDisabled, false)
})

test('WorkflowLandmarkGuidance renders beginner-friendly controls and disables Continue until completion', async () => {
  const html = await renderWorkflowLandmarkGuidance({
    nodeId: 'landmarks-node',
    activeNodeId: 'landmarks-node',
    session: {
      nodeId: 'landmarks-node',
      activeLandmarkId: 'left_knee',
      completed: {
        left_shoulder: { id: 'left_shoulder' },
        right_shoulder: { id: 'right_shoulder' },
        hip: { id: 'hip' },
      },
      validity: { valid: false, missing: ['left_knee', 'right_knee'] },
      canContinue: false,
      error: 'Missing required landmarks: left_knee, right_knee',
    },
  })

  assert.match(html, /Mark:/i)
  assert.match(html, /Left knee/i)
  assert.match(html, /LK/i)
  assert.match(html, /3 of 5 landmarks marked/i)
  assert.match(html, /Still needed: Left knee, Right knee/i)
  assert.match(html, /Next points/i)
  assert.match(html, /Click the mesh in the 3D viewer/i)
  assert.match(html, /Clear landmarks/i)
  assert.match(html, /To re-mark a point, click the same landmark again in the viewer/i)
  assert.match(html, /disabled=""/i)
  assert.match(html, /Finish all landmarks to continue/i)
})

test('WorkflowLandmarkGuidance renders compact re-mark actions for already placed landmarks', async () => {
  const html = await renderWorkflowLandmarkGuidance({
    nodeId: 'landmarks-node',
    activeNodeId: 'landmarks-node',
    session: {
      nodeId: 'landmarks-node',
      activeLandmarkId: 'right_knee',
      completed: {
        left_shoulder: { id: 'left_shoulder' },
        right_shoulder: { id: 'right_shoulder' },
        hip: { id: 'hip' },
      },
      validity: { valid: false, missing: ['left_knee', 'right_knee'] },
      canContinue: false,
    },
  })

  assert.match(html, /Placed landmarks/i)
  assert.match(html, /Re-mark LS Left shoulder/i)
  assert.match(html, /Re-mark RS Right shoulder/i)
  assert.match(html, /Re-mark H Hip/i)
  assert.doesNotMatch(html, /Re-mark Left knee/i)
})

test('resolveWorkflowRunPrimaryAction exposes enabled Continue for completed paused landmarks', async () => {
  const action = await resolveWorkflowRunPrimaryAction({
    runState: {
      status: 'paused',
      blockStep: 'Paused — mark required landmarks',
      substitutionPoint: { nodeId: 'landmarks-node' },
    },
    activeNodeId: 'landmarks-node',
    landmarkSession: {
      nodeId: 'landmarks-node',
      activeLandmarkId: 'right_knee',
      completed: {
        left_shoulder: { id: 'left_shoulder' },
        right_shoulder: { id: 'right_shoulder' },
        hip: { id: 'hip' },
        left_knee: { id: 'left_knee' },
        right_knee: { id: 'right_knee' },
      },
      validity: { valid: true, missing: [] },
      canContinue: true,
    },
    hasRunValidationIssue: false,
  })

  assert.deepEqual(action, {
    kind: 'continue-landmarks',
    label: 'Continue workflow',
    disabled: false,
  })
})

test('resolveWorkflowRunPrimaryAction keeps paused incomplete landmarks actionable but disabled', async () => {
  const action = await resolveWorkflowRunPrimaryAction({
    runState: {
      status: 'paused',
      blockStep: 'Paused — mark required landmarks',
      substitutionPoint: { nodeId: 'landmarks-node' },
    },
    activeNodeId: 'landmarks-node',
    landmarkSession: {
      nodeId: 'landmarks-node',
      activeLandmarkId: 'left_knee',
      completed: {
        left_shoulder: { id: 'left_shoulder' },
        right_shoulder: { id: 'right_shoulder' },
        hip: { id: 'hip' },
      },
      validity: { valid: false, missing: ['left_knee', 'right_knee'] },
      canContinue: false,
    },
    hasRunValidationIssue: false,
  })

  assert.deepEqual(action, {
    kind: 'continue-landmarks',
    label: 'Finish all landmarks to continue',
    disabled: true,
  })
})

test('executeWorkflowRunPrimaryAction invokes real continueRun only for enabled landmarks continue action', async () => {
  let continueCalls = 0
  let cancelCalls = 0
  let generateCalls = 0

  await executeWorkflowRunPrimaryAction(
    { kind: 'continue-landmarks', label: 'Continue workflow', disabled: false },
    {
      continueRun: () => { continueCalls += 1 },
      cancel: () => { cancelCalls += 1 },
      generate: () => { generateCalls += 1 },
    },
  )

  assert.equal(continueCalls, 1)
  assert.equal(cancelCalls, 0)
  assert.equal(generateCalls, 0)

  await executeWorkflowRunPrimaryAction(
    { kind: 'continue-landmarks', label: 'Finish all landmarks to continue', disabled: true },
    {
      continueRun: () => { continueCalls += 1 },
      cancel: () => { cancelCalls += 1 },
      generate: () => { generateCalls += 1 },
    },
  )

  assert.equal(continueCalls, 1)
})

test('executeWorkflowLandmarkGuidanceAction clears landmarks through the real node-scoped reset action', async () => {
  const resetCalls: string[] = []
  const continueCalls: string[] = []

  await executeWorkflowLandmarkGuidanceAction(
    { kind: 'clear-landmarks', nodeId: 'landmarks-node', disabled: false },
    {
      resetLandmarks: (nodeId: string) => { resetCalls.push(nodeId) },
      continueRun: () => { continueCalls.push('continue') },
    },
  )

  assert.deepEqual(resetCalls, ['landmarks-node'])
  assert.deepEqual(continueCalls, [])
})

test('WorkflowRunFooter renders the real Generate CTA for unpinned paused landmarks', async () => {
  const html = await renderWorkflowRunFooter({
    primaryAction: { kind: 'continue-landmarks', label: 'Finish all landmarks to continue', disabled: true },
    runState: { status: 'paused' },
    runValidationIssue: null,
    isRunning: true,
    onGenerate: () => {},
    onCancel: () => {},
    onContinueRun: () => {},
  })

  assert.match(html, /Finish all landmarks to continue/i)
  assert.match(html, /disabled=""/i)
  assert.doesNotMatch(html, /Clear landmarks/i)
})

test('WorkflowRunFooter exposes clickable Continue and Clear for completed unpinned landmarks', async () => {
  const html = await renderWorkflowRunFooter({
    primaryAction: { kind: 'continue-landmarks', label: 'Continue workflow', disabled: false },
    runState: { status: 'paused' },
    runValidationIssue: null,
    isRunning: true,
    landmarkClearAction: { kind: 'clear-landmarks', nodeId: 'landmarks-node', disabled: false },
    onGenerate: () => {},
    onCancel: () => {},
    onContinueRun: () => {},
    onResetLandmarks: () => {},
  })

  assert.match(html, /Continue workflow/i)
  assert.match(html, /Clear landmarks/i)
  assert.doesNotMatch(html, /disabled=""/i)
})
