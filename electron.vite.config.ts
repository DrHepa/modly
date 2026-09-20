import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { resolveApiEndpoint } from './electron/main/api-endpoint'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve('electron/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve('electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: 'src',
    build: {
      rollupOptions: {
        input: resolve('src/index.html')
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
    plugins: [
      react(),
      {
        name: 'modly-api-csp-origin',
        transformIndexHtml(html: string) {
          return html.replace('__MODLY_API_ORIGIN__', resolveApiEndpoint().baseUrl)
        }
      }
    ]
  }
})
