import type { ProcessInput, ProcessResult } from '../../src/shared/types/electron.d'

// Legacy user-driven workflow surface. Governed Agent actions must never import
// or invoke this channel; migration into the future broker is tracked separately.

type IpcInvoke = (
  channel: string,
  extensionId: string,
  input: ProcessInput,
  params: Record<string, unknown>,
) => Promise<{ success: boolean; result?: ProcessResult; error?: string }>

export function invokeExtensionsRunProcess(
  ipcInvoke: IpcInvoke,
  extensionId: string,
  input: ProcessInput,
  params: Record<string, unknown>,
): Promise<{ success: boolean; result?: ProcessResult; error?: string }> {
  return ipcInvoke('extensions:runProcess', extensionId, input, params)
}
