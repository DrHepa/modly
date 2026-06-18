import type { WorkflowExtension } from './mockExtensions'

/**
 * MODEL scene input must remain a single `input` (never inside `inputs`).
 * PROCESS supports scene ports. Mirrors the install-side shape policy.
 */
export function hasUnsupportedSceneShape(ext: Pick<WorkflowExtension, 'type' | 'input' | 'inputs' | 'output'>): boolean {
  const usesSceneInput = ext.input === 'scene' || ext.inputs?.some((input) => (typeof input === 'string' ? input : input.type) === 'scene') === true
  if (ext.type === 'process') return false
  return usesSceneInput && (ext.inputs !== undefined || ext.input !== 'scene')
}
