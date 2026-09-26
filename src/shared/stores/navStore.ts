import { create } from 'zustand'

export const NAV_PAGES = ['generate', 'workflows', 'worlds', 'models', 'settings'] as const

export type Page = (typeof NAV_PAGES)[number]

interface NavState {
  currentPage: Page
  navigationError: string | null
  navigate: (page: Page) => Promise<boolean>
  dismissNavigationError(): void
  reportWorldsApplyCancellationUncertain(): void
}

let worldsLeaveGuard: (() => Promise<boolean>) | null = null
let navigationGeneration = 0

export function registerWorldsLeaveGuard(guard: () => Promise<boolean>): () => void {
  worldsLeaveGuard = guard
  return () => { if (worldsLeaveGuard === guard) worldsLeaveGuard = null }
}

export const useNavStore = create<NavState>((set, get) => ({
  currentPage: 'generate',
  navigationError: null,
  dismissNavigationError: () => set({ navigationError: null }),
  reportWorldsApplyCancellationUncertain: () => set({
    navigationError: 'Worlds closed before external edit cancellation was verified. The outcome may be uncertain; reopen the project before editing.',
  }),
  navigate: (page) => {
    const generation = ++navigationGeneration
    if (get().currentPage === 'worlds' && page !== 'worlds' && worldsLeaveGuard) {
      return worldsLeaveGuard().then((accepted) => {
        if (generation !== navigationGeneration || get().currentPage !== 'worlds') return false
        if (!accepted) {
          set({ navigationError: 'Worlds external edit cancellation was not verified. You remain in Worlds; the outcome may be uncertain.' })
          return false
        }
        set({ currentPage: page, navigationError: null })
        return true
      }, () => {
        if (generation === navigationGeneration && get().currentPage === 'worlds')
          set({ navigationError: 'Worlds external edit cancellation was not verified. You remain in Worlds; the outcome may be uncertain.' })
        return false
      })
    }
    set({ currentPage: page, ...(page !== 'worlds' ? { navigationError: null } : {}) })
    return Promise.resolve(true)
  },
}))
