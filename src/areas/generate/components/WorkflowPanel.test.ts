import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const workflowPanelEntry = path.join(projectRoot, 'src/areas/generate/components/WorkflowPanel.tsx')

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

  assert.match(validationHtml, /Required port &quot;prompt&quot; is missing\./i)
})
