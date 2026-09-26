import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import type { Plugin } from 'vite'

import { loadWorldFfmpegBuildTrustSync } from './scripts/world-ffmpeg-build-trust.mjs'

const RAPIER_WASM_MODULE_SUFFIX = '/node_modules/@dimforge/rapier3d/rapier_wasm3d.js'
const RAPIER_WASM_ESM_IMPORT = 'import * as wasm from "./rapier_wasm3d_bg.wasm";'
const WORLD_FFMPEG_BUILD_TRUST = process.env.WORLD_FFMPEG_BUILD_TRUST_FILE
  ? loadWorldFfmpegBuildTrustSync(process.env.WORLD_FFMPEG_BUILD_TRUST_FILE).keys
  : Object.freeze({})

function rapierWasmIntegration(): Plugin {
  return {
    name: 'modly-rapier-wasm-integration',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith(RAPIER_WASM_MODULE_SUFFIX)) return null
      if (!code.includes(RAPIER_WASM_ESM_IMPORT)) {
        throw new Error('Pinned Rapier WASM entry no longer matches the supported integration contract.')
      }
      return code.replace(RAPIER_WASM_ESM_IMPORT, [
        'import initRapierWasm from "./rapier_wasm3d_bg.wasm?init&inline";',
        'import * as rapierWasmBindings from "./rapier_wasm3d_bg.js";',
        'const rapierWasmInstance = await initRapierWasm({ "./rapier_wasm3d_bg.js": rapierWasmBindings });',
        'const wasm = rapierWasmInstance.exports;',
      ].join('\n'))
    },
  }
}

export default defineConfig({
  main: {
    define: {
      __WORLD_FFMPEG_BUILD_TRUST__: JSON.stringify(WORLD_FFMPEG_BUILD_TRUST),
    },
    build: {
      target: 'node24.19',
      externalizeDeps: true,
      lib: {
        entry: {
          index: resolve('electron/main/index.ts'),
          'world-render-internal': resolve('electron/main/world-render-internal.ts')
        }
      }
    }
  },
  preload: {
    build: {
      target: 'node24.19',
      externalizeDeps: true,
      lib: {
        entry: {
          index: resolve('electron/preload/index.ts'),
          'world-render': resolve('electron/preload/world-render.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src',
    build: {
      target: 'chrome152',
      rollupOptions: {
        input: {
          index: resolve('src/index.html'),
          'world-render': resolve('src/world-render.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src'),
        '@areas': resolve('src/areas'),
        '@shared': resolve('src/shared'),
        '@styles': resolve('src/styles')
      }
    },
    plugins: [rapierWasmIntegration(), react()],
    worker: {
      format: 'es',
      plugins: () => [rapierWasmIntegration()]
    }
  }
})
