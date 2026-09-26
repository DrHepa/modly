import { Component, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useThree } from '@react-three/fiber'

export interface WorldViewportFailure {
  kind: 'render-error' | 'context-lost'
  message: string
}

export interface WorldViewportLease {
  commit(): void
  release(): void
  isCurrent(): boolean
  fail(failure: WorldViewportFailure): void
}

/** Session-only availability. Neither recovery nor its leases can write a document. */
export function createWorldViewportRecovery(onFailure: (failure: WorldViewportFailure) => void) {
  let state: { attempt: number; failure: WorldViewportFailure | null } = { attempt: 0, failure: null }
  let epoch = 0
  let ownershipVersion = 0
  let owner: WorldViewportLease | null = null
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    capture(reportFailure: (failure: WorldViewportFailure) => void = onFailure): WorldViewportLease {
      // Allocation during React rendering is pure: a suspended candidate cannot revoke the visible owner.
      const capturedEpoch = epoch
      let committedVersion: number | null = null
      let released = false
      let pendingFailure: WorldViewportFailure | null = null
      const lease: WorldViewportLease = {
        isCurrent: () => capturedEpoch === epoch && owner === lease && !released && !state.failure,
        commit() {
          if (capturedEpoch !== epoch || state.failure || owner === lease) return
          // Permit StrictMode's release/recommit, but never resurrect an owner superseded by another commit.
          if (committedVersion !== null && (committedVersion !== ownershipVersion || owner !== null)) return
          owner = lease
          committedVersion = ++ownershipVersion
          released = false
          if (pendingFailure) {
            const failure = pendingFailure
            pendingFailure = null
            lease.fail(failure)
          }
        },
        release() {
          released = true
          pendingFailure = null
          if (owner === lease) owner = null
        },
        fail(failure: WorldViewportFailure) {
          if (capturedEpoch !== epoch || state.failure || released) return
          if (owner !== lease) {
            // Child layout effects run before the parent boundary commits. Publish only if it commits.
            if (committedVersion === null) pendingFailure ??= failure
            return
          }
          state = { ...state, failure }
          // Revoke side effects before notifying React about the unavailable viewport.
          reportFailure(failure)
          notify()
        },
      }
      return lease
    },
    revoke() { epoch += 1; owner = null },
    retry() {
      if (!state.failure) return false
      epoch += 1
      owner = null
      state = { attempt: state.attempt + 1, failure: null }
      notify()
      return true
    },
  }
}

/** Listen on the canvas itself: context-loss events do not bubble. */
export function observeWorldCanvasContext(
  canvas: Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener'>,
  onFailure?: (failure: WorldViewportFailure) => void,
  onReady?: (ready: boolean) => void,
  isContextLost: () => boolean = () => false,
): () => void {
  let active = true
  let lost = false
  const handleLoss = (event: Event) => {
    if (!active || lost) return
    event.preventDefault()
    lost = true
    onReady?.(false)
    onFailure?.({ kind: 'context-lost', message: 'The graphics context was lost.' })
  }
  canvas.addEventListener('webglcontextlost', handleLoss)
  if (isContextLost()) handleLoss(new Event('webglcontextlost'))
  else onReady?.(true)
  return () => {
    if (!active) return
    active = false
    canvas.removeEventListener('webglcontextlost', handleLoss)
    onReady?.(false)
  }
}

export function WorldCanvasLifecycle({ onFailure, onReady }: {
  onFailure?: (failure: WorldViewportFailure) => void
  onReady?: (ready: boolean) => void
}): null {
  const renderer = useThree((state) => state.gl)
  useLayoutEffect(() => observeWorldCanvasContext(renderer.domElement, onFailure, onReady, () => renderer.getContext().isContextLost()), [renderer, onFailure, onReady])
  return null
}

interface BoundaryProps {
  children: ReactNode
  failure: WorldViewportFailure | null
  lease: WorldViewportLease
  onRetry(): void
  retryDisabled?: boolean
}

/** Keep this outside the complete viewport, including its input and RAF owners. */
export class WorldViewportBoundary extends Component<BoundaryProps, { caught: boolean }> {
  state = { caught: false }

  static getDerivedStateFromError(): { caught: boolean } { return { caught: true } }

  componentDidMount(): void { this.props.lease.commit() }

  componentDidUpdate(previous: BoundaryProps): void {
    if (previous.lease !== this.props.lease) {
      previous.lease.release()
      this.props.lease.commit()
    }
  }

  componentWillUnmount(): void { this.props.lease.release() }

  componentDidCatch(error: unknown): void {
    this.props.lease.commit()
    this.props.lease.fail({ kind: 'render-error', message: error instanceof Error ? error.message : 'The 3D viewport could not start.' })
  }

  render(): ReactNode {
    if (!this.state.caught && !this.props.failure) return this.props.children
    return <UnavailableViewport onRetry={this.props.onRetry} retryDisabled={this.props.retryDisabled} />
  }
}

function UnavailableViewport({ onRetry, retryDisabled }: Pick<BoundaryProps, 'onRetry' | 'retryDisabled'>): JSX.Element {
  const retryRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Restore focus lost with the canvas, but never steal it from an editor control.
    if (!retryDisabled && typeof document !== 'undefined' && document.activeElement === document.body) retryRef.current?.focus()
  }, [retryDisabled])
  return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div role="alert">
          <h2 className="text-sm font-medium text-zinc-100">3D viewport unavailable</h2>
          <p className="mt-1 text-xs text-zinc-400">You can keep editing.</p>
        </div>
        <button ref={retryRef} type="button" className="worlds-button" aria-label="Retry viewport" disabled={retryDisabled} onClick={onRetry}>Retry viewport</button>
      </div>
    )
}
