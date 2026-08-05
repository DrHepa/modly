import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

test('desktop manifest contract includes video in scalar and multi-port unions', async () => {
  const source = await readFile(resolve('electron/main/ipc-handlers.ts'), 'utf8')
  const parsedManifest = source.slice(
    source.indexOf('type ParsedManifest = {'),
    source.indexOf('function parseExtensionManifest'),
  )

  assert.match(parsedManifest, /input\?:\s*'mesh' \| 'image' \| 'text' \| 'audio' \| 'video'/)
  assert.match(parsedManifest, /inputs\?:\s*\('mesh' \| 'image' \| 'text' \| 'audio' \| 'video'\)\[\]/)
  assert.match(parsedManifest, /output\?:\s*'mesh' \| 'image' \| 'text' \| 'audio' \| 'video'/)
})
