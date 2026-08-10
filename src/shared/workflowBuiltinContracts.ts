import type { ArtifactKind } from './types/artifacts.ts'

export type WorkflowBuiltinParamScalar = boolean | number | string

export interface WorkflowBuiltinParamCondition {
  param: string
  equals: WorkflowBuiltinParamScalar
}

interface WorkflowBuiltinParamRules {
  required: boolean
  requiredWhen?: WorkflowBuiltinParamCondition
  forbiddenWhen?: WorkflowBuiltinParamCondition
  allowEmpty?: boolean
  workspacePath?: boolean
}

export type WorkflowBuiltinParamContract = WorkflowBuiltinParamRules & (
  | { type: 'boolean', default?: boolean }
  | { type: 'int', default?: number, min?: number, max?: number }
  | { type: 'float', default?: number, min?: number, max?: number }
  | { type: 'string', default?: string }
  | { type: 'select', default?: string | number, options: readonly (string | number)[] }
)

export type WorkflowBuiltinAgentSourceAuthority =
  | { kind: 'inline' }
  | { kind: 'workspace', sourceKind: 'video' | 'scene', pathParam: string }
  | { kind: 'current', discriminator: string, value: WorkflowBuiltinParamScalar }
  | { kind: 'unsupported' }

export interface WorkflowBuiltinNodeContract {
  input: ArtifactKind | null
  output: ArtifactKind | null
  params: Readonly<Record<string, WorkflowBuiltinParamContract>>
  agentSourceAuthority?: WorkflowBuiltinAgentSourceAuthority
}

/**
 * Pure workflow contracts shared with main-process authorities and renderer
 * preflight. UI catalogs may add labels and icons, but they must not redefine
 * executable parameter or I/O contracts.
 */
export const WORKFLOW_BUILTIN_NODE_CONTRACTS = {
  imageNode: {
    input: null,
    output: 'image',
    params: {
      filePath: { type: 'string', required: true, workspacePath: true },
    },
    // Image execution reads a raw renderer path today. Agent creation remains
    // fail-closed until that runtime accepts a confined workspace reference.
    agentSourceAuthority: { kind: 'unsupported' },
  },
  videoNode: {
    input: null,
    output: 'video',
    params: {
      videoPath: { type: 'string', required: true, workspacePath: true },
      displayName: { type: 'string', required: false },
    },
    agentSourceAuthority: { kind: 'workspace', sourceKind: 'video', pathParam: 'videoPath' },
  },
  textNode: {
    input: null,
    output: 'text',
    params: {
      text: { type: 'string', required: true },
    },
    agentSourceAuthority: { kind: 'inline' },
  },
  meshNode: {
    input: null,
    output: 'mesh',
    params: {
      source: { type: 'select', required: true, default: 'file', options: ['file', 'current'] },
      filePath: {
        type: 'string',
        required: false,
        requiredWhen: { param: 'source', equals: 'file' },
        forbiddenWhen: { param: 'source', equals: 'current' },
        workspacePath: true,
      },
      fileName: {
        type: 'string',
        required: false,
        forbiddenWhen: { param: 'source', equals: 'current' },
      },
    },
    // File mode is a raw path at runtime. Current-scene is the only already
    // authorized source mode that does not persist an Agent-supplied path.
    agentSourceAuthority: { kind: 'current', discriminator: 'source', value: 'current' },
  },
  sceneNode: {
    input: null,
    output: 'scene',
    params: {
      path: { type: 'string', required: true, workspacePath: true },
      manifestPath: { type: 'string', required: false, workspacePath: true },
      sceneRoot: { type: 'string', required: false, workspacePath: true, allowEmpty: false },
      sourceKind: { type: 'select', required: false, options: ['manifest', 'directory'] },
    },
    agentSourceAuthority: { kind: 'workspace', sourceKind: 'scene', pathParam: 'path' },
  },
  outputNode: { input: 'mesh', output: null, params: {} },
  addToWorldsNode: { input: 'mesh', output: null, params: {} },
  previewImageNode: { input: 'image', output: null, params: {} },
  previewNode: { input: 'image', output: null, params: {} },
  landmarksNode: { input: 'mesh', output: 'mesh', params: {} },
  waitNode: { input: 'mesh', output: 'mesh', params: {} },
} as const satisfies Readonly<Record<string, WorkflowBuiltinNodeContract>>

export type WorkflowBuiltinNodeType = keyof typeof WORKFLOW_BUILTIN_NODE_CONTRACTS

export function workflowBuiltinParamIsRequired(
  contract: WorkflowBuiltinParamContract,
  values: Readonly<Record<string, unknown>>,
): boolean {
  return contract.required
    || (contract.requiredWhen !== undefined
      && values[contract.requiredWhen.param] === contract.requiredWhen.equals)
}

export function workflowBuiltinParamIsForbidden(
  contract: WorkflowBuiltinParamContract,
  values: Readonly<Record<string, unknown>>,
): boolean {
  return contract.forbiddenWhen !== undefined
    && values[contract.forbiddenWhen.param] === contract.forbiddenWhen.equals
}

export function isSafeWorkflowWorkspacePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.trim() !== value) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  if (/[\\:%?#]/.test(value) || value.startsWith('/') || value.startsWith('~')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}
