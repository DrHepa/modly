import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { recoverWorldFfmpegOwnedGarbage, quarantineAndReclaimWorldFfmpegFile } from './world-ffmpeg-owned-garbage.mjs'
import { createWorldFfmpegGithubReleaseClient } from './world-ffmpeg-github-release.mjs'

async function fixtureDirectory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'modly-recovery-preflight-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('reserved GC names exclude unrelated temporaries and report malformed authorities', async (t) => {
  const root = await fixtureDirectory(t)
  const unrelated = 'notes.v1.json.tmp-editor'
  await fs.writeFile(join(root, unrelated), 'unrelated notes')
  const clean = await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.deepEqual(clean.failures, [])
  for (const name of ['.WORLD_FFMPEG_GC.claim-bad.v1.json', '.WORLD_FFMPEG_GC.intent-bad.v1.json']) {
    await fs.writeFile(join(root, name), 'invalid reserved authority')
  }
  const result = await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.equal(result.failures.length, 2)
  assert.ok(result.failures.every(({ message }) => /malformed.*reserved|reserved.*malformed/i.test(message)))
  assert.equal(await fs.readFile(join(root, unrelated), 'utf8'), 'unrelated notes')
  assert.equal((await fs.readdir(root)).length, 3)
})

test('aggregate GC temporary budget applies across distinct generations before recovery', { timeout: 60_000 }, async (t) => {
  const root = await fixtureDirectory(t)
  for (let index = 0; index < 65; index += 1) {
    const name = `.WORLD_FFMPEG_GC.claim-${index.toString(16).padStart(64, '0')}.v1.json.tmp-${'f'.repeat(32)}`
    await fs.writeFile(join(root, name), '')
  }
  const result = await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0].message, /aggregate.*temporary.*bound/i)
  assert.equal((await fs.readdir(root)).length, 65)
})

test('aggregate GC recovery reuses parent enumeration and bounds failure reporting', async (t) => {
  const root = await fixtureDirectory(t)
  for (let index = 0; index < 16; index += 1) {
    const file = join(root, `owned-${index}`)
    await fs.writeFile(file, '')
    await quarantineAndReclaimWorldFfmpegFile({ path: file, label: 'enumeration-budget', maximumBytes: 1 })
  }
  let scans = 0
  for (const method of ['readdir', 'opendir']) {
    const original = fs[method]
    t.mock.method(fs, method, async (...args) => {
      if (args[0] === root) scans += 1
      return original(...args)
    })
  }
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const recovered = await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.deepEqual(recovered.failures, [])
  assert.ok(scans <= 8, `recovery rescanned the same parent ${scans} times`)
  for (let index = 0; index < 100; index += 1) {
    await fs.writeFile(join(root, `.WORLD_FFMPEG_GC.invalid-${index}`), '{}')
  }
  const malformed = await recoverWorldFfmpegOwnedGarbage({ parentDirectory: root, minimumAgeMs: 0 })
  assert.ok(malformed.failures.length > 0 && malformed.failures.length <= 65)
})

const metadata = Object.freeze({
  tag: 'v1.0.0', title: 'Expected title', body: 'Expected notes',
  targetCommitish: 'a'.repeat(40), draft: true,
})

function githubFixture() {
  const methods = []
  let remote = {
    id: 77, tag_name: metadata.tag, name: metadata.title, body: metadata.body,
    target_commitish: metadata.targetCommitish, draft: true,
    upload_url: 'https://uploads.github.com/repos/modly/example/releases/77/assets{?name,label}',
  }
  let present = true
  let deleteAttempts = 0
  let retryDelete = false
  const requestFactory = (options, onResponse) => {
    methods.push(options.method)
    const request = new EventEmitter()
    const pieces = []
    request.write = (bytes) => { pieces.push(Buffer.from(bytes)); return true }
    request.destroy = () => undefined
    request.end = () => queueMicrotask(() => {
      let status = 200
      let bytes
      if (options.method === 'PATCH') {
        remote = { ...remote, ...JSON.parse(Buffer.concat(pieces).toString()) }
        bytes = Buffer.from(JSON.stringify(remote))
      } else if (options.method === 'POST') {
        status = 201
        bytes = Buffer.from(JSON.stringify({ id: 99, name: 'asset.bin', size: 1, state: 'uploaded' }))
      } else if (options.method === 'DELETE') {
        deleteAttempts += 1
        if (retryDelete) {
          status = 503
          remote = { ...remote, draft: false }
          bytes = Buffer.from('{}')
        } else {
          status = 204; present = false; bytes = Buffer.alloc(0)
        }
      } else if (options.path.includes('/assets?')) {
        bytes = Buffer.from(JSON.stringify(present ? [{ id: 99, name: 'asset.bin', size: 1, state: 'uploaded' }] : []))
      } else bytes = Buffer.from(JSON.stringify(remote))
      const response = new EventEmitter()
      response.statusCode = status
      response.headers = {}
      response.destroy = () => undefined
      onResponse(response)
      if (bytes.length) response.emit('data', bytes)
      response.emit('end')
      response.emit('close')
    })
    return request
  }
  const client = createWorldFfmpegGithubReleaseClient({
    repository: 'modly/example', tag: metadata.tag, token: 'fixture', requestFactory,
    sleep: async () => undefined, maxAttempts: 2, operationDeadlineMs: 5000, requestTimeoutMs: 1000,
  })
  return {
    client, methods, edit(change) { remote = { ...remote, ...change } },
    retryDelete() { retryDelete = true }, deleteAttempts: () => deleteAttempts,
  }
}

test('stale release publication rejects metadata changes and reconciles public state without PATCH', async () => {
  const conflict = githubFixture()
  await conflict.client.getRelease()
  conflict.edit({ body: 'Maintainer edited notes' })
  await assert.rejects(conflict.client.publishRelease({ releaseId: 77, metadata }), /metadata|authority|conflict/i)
  assert.equal(conflict.methods.includes('PATCH'), false)

  const published = githubFixture()
  published.edit({ draft: false })
  const result = await published.client.publishRelease({ releaseId: 77, metadata })
  assert.equal(result.release.draft, false)
  assert.equal(published.methods.includes('PATCH'), false)
})

test('stale release uploads and every deletion attempt require a fresh matching private draft', async () => {
  const upload = githubFixture()
  await upload.client.getRelease()
  upload.edit({ draft: false })
  await assert.rejects(upload.client.uploadAsset({
    releaseId: 77, name: 'asset.bin', size: 1,
    chunks: (async function * () { yield Buffer.from('x') })(),
  }), /draft|authority|public/i)
  assert.equal(upload.methods.includes('POST'), false)

  const deletion = githubFixture()
  await deletion.client.getRelease()
  deletion.retryDelete()
  await assert.rejects(deletion.client.deleteAsset({ id: 99, name: 'asset.bin', size: 1, state: 'uploaded' }), /draft|authority|public/i)
  assert.equal(deletion.deleteAttempts(), 1)
})
