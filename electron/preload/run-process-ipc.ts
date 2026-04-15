import type { ProcessInput, ProcessResult } from '../../src/shared/types/electron.d'

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
