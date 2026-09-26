import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThinkingMode = 'auto' | 'on' | 'off'
export type WorldsAiProvider = 'ollama' | 'openai'

interface AgentSettings {
  ollamaUrl:        string
  defaultModel:     string
  defaultThinking:  ThinkingMode
  worldsProvider:   WorldsAiProvider
  worldsOpenAiModel: string

  setOllamaUrl:       (url: string)          => void
  setDefaultModel:    (model: string)        => void
  setDefaultThinking: (mode: ThinkingMode)   => void
  setWorldsProvider: (provider: WorldsAiProvider) => void
  setWorldsOpenAiModel: (model: string) => void
}

export const useAgentStore = create<AgentSettings>()(
  persist(
    (set) => ({
      ollamaUrl:       'http://localhost:11434',
      defaultModel:    'gemma4:e4b',
      defaultThinking: 'auto',
      worldsProvider: 'ollama',
      worldsOpenAiModel: 'gpt-5.1',

      setOllamaUrl:       (url)   => set({ ollamaUrl: url }),
      setDefaultModel:    (model) => set({ defaultModel: model }),
      setDefaultThinking: (mode)  => set({ defaultThinking: mode }),
      setWorldsProvider: (provider) => set({ worldsProvider: provider }),
      setWorldsOpenAiModel: (model) => set({ worldsOpenAiModel: model }),
    }),
    { name: 'modly-agent-settings' },
  ),
)
