import type { WorldsCliDirectEditBroker } from './worlds-cli-direct-edit-broker.ts'
import type { WorldsCliTransport } from './worlds-cli-transport.ts'

type DispatchResult = Awaited<ReturnType<WorldsCliDirectEditBroker['execute']>>
type DispatchFailureCode = Extract<DispatchResult, { ok: false }>['code']

function dispatchFailureCode(value: string): DispatchFailureCode {
  return value === 'STALE' || value === 'AMBIGUOUS' || value === 'BUSY'
    || value === 'NOT_FOUND' || value === 'INVALID_REQUEST' || value === 'UNAVAILABLE'
    ? value : 'UNAVAILABLE'
}

/** Main-only late binding: proposal IDs cross this boundary, never mutation authority. */
export function createWorldsCliDirectEditDispatch(
  getTransport: () => Pick<WorldsCliTransport, 'reserveDirectEdit'> | null,
  broker: Pick<WorldsCliDirectEditBroker, 'execute'>,
): (proposalId: string) => Promise<DispatchResult> {
  return async (proposalId) => {
    const transport = getTransport()
    if (!transport) return { ok: false, code: 'UNAVAILABLE' }
    let reserved: Awaited<ReturnType<WorldsCliTransport['reserveDirectEdit']>>
    try { reserved = await transport.reserveDirectEdit(proposalId) }
    catch { return { ok: false, code: 'UNAVAILABLE' } }
    if (!reserved.ok) return { ok: false, code: dispatchFailureCode(reserved.code) }
    try {
      const result = await broker.execute(reserved.reservation)
      if (!result.ok) {
        try { await reserved.reservation.finish() } catch { /* Custody is consumed even when cleanup fails. */ }
      }
      return result
    }
    catch {
      try { await reserved.reservation.finish() } catch { /* Custody is consumed even when cleanup fails. */ }
      return { ok: false, code: 'UNAVAILABLE' }
    }
  }
}
