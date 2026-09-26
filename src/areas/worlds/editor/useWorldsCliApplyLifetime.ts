import { useLayoutEffect } from 'react'
import { registerWorldsLeaveGuard, useNavStore } from '../../../shared/stores/navStore.ts'
import type { WorldEditorController } from './worldEditorController.ts'

type CancellationPort = Pick<WorldEditorController, 'cancelExternalCliIntents'>

/** Unmount can only send a negative signal; it cannot wait for Main's ACK. */
export function useWorldsCliApplyUnmountCancellation(controller: CancellationPort): void {
  useLayoutEffect(() => {
    return () => {
      const uncertain = () => useNavStore.getState().reportWorldsApplyCancellationUncertain()
      try {
        // Start IPC synchronously in cleanup. A lost ACK is uncertainty, never proof of no commit.
        void controller.cancelExternalCliIntents().then((result) => {
          if (!result.ok) uncertain()
        }, uncertain)
      } catch { uncertain() }
    }
  }, [controller])
}

export function useWorldsCliApplyLifetime(controller: CancellationPort): void {
  useWorldsCliApplyUnmountCancellation(controller)
  useLayoutEffect(() => registerWorldsLeaveGuard(async () => (await controller.cancelExternalCliIntents()).ok), [controller])
}
