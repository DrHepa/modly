import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build, type Plugin } from 'esbuild'
import * as THREE from 'three'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const componentEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsGaussianPlyObject.tsx')

function stubGaussianSplatsPlugin(): Plugin {
  return {
    name: 'stub-gaussian-splats',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@mkkellogg\/gaussian-splats-3d$/ }, () => ({ path: 'gaussian-splats-stub', namespace: 'stub' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'ts',
        contents: `
          import * as THREE from 'three'
          export const SceneFormat = { Ply: 'PLY' }
          export class DropInViewer extends THREE.Group {
            constructor(options = {}) {
              super()
              this.options = options
              this.sceneCount = 1
              this.splatMesh = {
                geometry: new THREE.BufferGeometry(),
                getSplatTree: () => ({ subTrees: [{ nodesWithIndexes: [{ min: new THREE.Vector3(-1, 0, -2), max: new THREE.Vector3(3, 4, 5) }] }] }),
                getSplatCount: () => 0,
              }
            }
            addSplatScene(path, options = {}) {
              this.lastAdd = { path, options }
              const promise = Promise.resolve()
              promise.abort = (reason) => { this.abortReason = reason }
              return promise
            }
            removeSplatScene(index, showLoadingUI) {
              this.lastRemove = [index, showLoadingUI]
              this.sceneCount = 0
              return Promise.resolve()
            }
            getSceneCount() {
              return this.sceneCount
            }
            getSplatMesh() {
              return this.splatMesh
            }
            dispose() {
              this.wasDisposed = true
              return Promise.resolve()
            }
          }
        `,
      }))
    },
  }
}

async function loadGaussianModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-gaussian-test-'))
  const outfile = path.join(tempDir, 'WorldsGaussianPlyObject.bundle.mjs')
  const result = await build({
    entryPoints: [componentEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [stubGaussianSplatsPlugin()],
    external: ['react', 'react/jsx-runtime', 'three'],
  })
  await writeFile(outfile, result.outputFiles[0].text)
  return {
    source: result.outputFiles[0].text,
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

test('WorldsGaussianPlyObject configures native Gaussian PLY loading with the installed DropInViewer contract', async () => {
  const { module, source, cleanup } = await loadGaussianModule()
  const componentSource = await readFile(componentEntry, 'utf8')

  try {
    assert.deepEqual(module.WORLDS_GAUSSIAN_PLY_VIEWER_OPTIONS, {
      gpuAcceleratedSort: true,
      sharedMemoryForWorkers: false,
      sphericalHarmonicsDegree: 0,
    })
    assert.deepEqual(module.WORLDS_GAUSSIAN_PLY_SCENE_OPTIONS, {
      format: 'PLY',
      progressiveLoad: true,
      showLoadingUI: false,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    })
    assert.equal(source.includes('addSplatScene'), true)
    assert.equal(componentSource.includes('Html center'), false)
    assert.equal(componentSource.includes('Loading PLY'), false)
    assert.equal(componentSource.includes('showLoadingUI: false'), true)
    assert.equal(componentSource.includes('loadRef.current?.abort'), true)
    assert.equal(componentSource.includes('removeSplatScene(0, false)'), true)
    assert.equal(componentSource.includes('await nextViewer.dispose()'), true)
  } finally {
    await cleanup()
  }
})

test('WorldsGaussianPlyObject derives local bounds from the library splat tree before falling back', async () => {
  const { module, cleanup } = await loadGaussianModule()

  try {
    const bounds = module.resolveGaussianViewerBounds({
      getSplatMesh() {
        return {
          getSplatTree() {
            return {
              subTrees: [{
                nodesWithIndexes: [{
                  min: new THREE.Vector3(-1, 0, -2),
                  max: new THREE.Vector3(3, 4, 5),
                }],
              }],
            }
          },
        }
      },
    })

    assert.ok(bounds instanceof THREE.Box3)
    assert.deepEqual(bounds?.min.toArray(), [-1, 0, -2])
    assert.deepEqual(bounds?.max.toArray(), [3, 4, 5])
  } finally {
    await cleanup()
  }
})
