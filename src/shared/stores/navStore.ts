import { create } from 'zustand'

export const NAV_PAGES = ['generate', 'workflows', 'worlds', 'models', 'settings'] as const

export type Page = (typeof NAV_PAGES)[number]

interface NavState {
  currentPage: Page
  navigate: (page: Page) => void
}

export const useNavStore = create<NavState>((set) => ({
  currentPage: 'generate',
  navigate: (page) => set({ currentPage: page })
}))
