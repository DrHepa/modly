import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const workflowPanelEntry = path.join(projectRoot, 'src/areas/generate/components/WorkflowPanel.tsx')

async function loadWorkflowPanelModule() {
  const result = await build({
    entryPoints: [workflowPanelEntry],
    write: false,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom/server', 'react/jsx-runtime', '@xyflow/react', 'zustand', 'axios'],
  })

  const module = { exports: {} as typeof import('./WorkflowPanel') }
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: createRequire(import.meta.url), console, process,
    // The SSR fixture never reads or writes the user's persisted browser state.
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  return {
    module: module.exports,
    async cleanup() {},
  }
}

async function renderWorkflowRunFeedback(props: Parameters<typeof import('./WorkflowPanel').WorkflowRunFeedback>[0]) {
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
  assert.match(missingMetadataHtml, /Modly cannot determine the input required by this model\./i)
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
  assert.match(unsupportedModeHtml, /This model input cannot be submitted through the selected generation route\./i)

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
