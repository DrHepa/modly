import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AgentSessionStore, AGENT_SESSION_TTL_MS } from './agent-session-store.ts'

const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])

async function withStore(run: (store: AgentSessionStore, root: string, clock: { now: number }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'modly-agent-sessions-'))
  const clock = { now: Date.parse('2026-08-05T10:00:00.000Z') }
  let id = 0
  const store = new AgentSessionStore({ rootDir: root, now: () => clock.now, randomId: () => `id-${++id}` })
  try { await run(store, root, clock) } finally { await rm(root, { recursive: true, force: true }) }
}

test('create, list, read, and activate do not slide the seven-day TTL', async () => {
  await withStore(async (store, _root, clock) => {
    const created = await store.create({ title: 'First chat' })
    assert.equal(Date.parse(created.expiresAt) - Date.parse(created.updatedAt), AGENT_SESSION_TTL_MS)
    const initialExpiry = created.expiresAt

    clock.now += 60_000
    await store.list()
    await store.read({ sessionId: created.id })
    await store.activate({ sessionId: created.id })
    assert.equal((await store.read({ sessionId: created.id })).expiresAt, initialExpiry)

    clock.now += 60_000
    const renamed = await store.rename({ sessionId: created.id, expectedRevision: created.revision, title: 'Renamed' })
    assert.equal(renamed.expiresAt, new Date(clock.now + AGENT_SESSION_TTL_MS).toISOString())
  })
})

test('new sessions and mutations sample the clock exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'modly-agent-clock-'))
  const base = Date.parse('2026-08-05T10:00:00.000Z')
  let ticks = 0
  const store = new AgentSessionStore({ rootDir: root, now: () => base + ticks++, randomId: () => `clock-${ticks}` })
  try {
    const created = await store.create({ title: 'Clock-safe' })
    assert.equal(Date.parse(created.expiresAt) - Date.parse(created.updatedAt), AGENT_SESSION_TTL_MS)
    const renamed = await store.rename({ sessionId: created.id, expectedRevision: created.revision, title: 'Clock-safe renamed' })
    assert.equal(Date.parse(renamed.expiresAt) - Date.parse(renamed.updatedAt), AGENT_SESSION_TTL_MS)
    assert.equal((await store.read({ sessionId: created.id })).id, created.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('semantic no-op rename preserves revision and TTL', async () => {
  await withStore(async (store, _root, clock) => {
    const created = await store.create({ title: 'Stable title' })
    clock.now += 60_000
    const unchanged = await store.rename({ sessionId: created.id, expectedRevision: created.revision, title: '  Stable title  ' })
    assert.equal(unchanged.revision, created.revision)
    assert.equal(unchanged.updatedAt, created.updatedAt)
    assert.equal(unchanged.expiresAt, created.expiresAt)
  })
})

test('message persistence is allowlisted and rejects runtime or secret-bearing fields', async () => {
  await withStore(async (store) => {
    const session = await store.create({})
    await assert.rejects(
      store.appendMessage({
        sessionId: session.id,
        expectedRevision: session.revision,
        message: { id: 'm1', role: 'assistant', content: 'Safe', thinking: 'private chain' } as never,
      }),
      /only allowed fields/i,
    )
    const appended = await store.appendMessage({
      sessionId: session.id,
      expectedRevision: session.revision,
      message: { id: 'm1', role: 'assistant', content: 'Safe answer' },
    })
    assert.deepEqual(appended.messages, [{ id: 'm1', role: 'assistant', content: 'Safe answer', attachmentIds: [], summaries: [] }])

    const redacted = await store.appendMessage({
      sessionId: session.id,
      expectedRevision: appended.revision,
      message: { id: 'm2', role: 'user', content: 'token=https://example.test/private password=hunter2 file:///home/user/key' },
    })
    assert.equal(redacted.messages[1].content.includes('hunter2'), false)
    assert.equal(redacted.messages[1].content.includes('example.test'), false)
    assert.equal(redacted.messages[1].content.includes('/home/user'), false)

    const adversarial = await store.appendMessage({
      sessionId: session.id,
      expectedRevision: redacted.revision,
      message: {
        id: 'm3',
        role: 'user',
        content: String.raw`preview=data:image/png;base64,AAAA path=/home/alice/private.txt uri=file:///home/alice/key win=C:\Users\Alice\secret.txt unc=\\server\share\secret.txt`,
      },
    })
    const persisted = adversarial.messages[2].content
    for (const secretFragment of ['data:image', '/home/alice', 'C:\\Users\\Alice', '\\\\server\\share']) {
      assert.equal(persisted.includes(secretFragment), false, `persisted privacy fragment: ${secretFragment}`)
    }

    const delimiterProbes = [
      String.raw`quoted="/home/alice/private.txt"`,
      String.raw`colon:C:\Users\Alice\private.txt`,
      String.raw`quoted="\\server\share\private.txt"`,
      String.raw`uri=file:/home/alice/private.txt`,
      String.raw`winuri=file:C:\Users\Alice\private.txt`,
    ]
    let current = adversarial
    for (const [index, probe] of delimiterProbes.entries()) {
      current = await store.appendMessage({
        sessionId: session.id,
        expectedRevision: current.revision,
        message: { id: `delimiter-${index}`, role: 'user', content: probe },
      })
      assert.equal(current.messages.at(-1)?.content, '[redacted private content]', probe)
    }

    const credentialProbes = [
      'Authorization: Bearer bearer-value',
      'password whitespace-value',
      'passwd: colon-value',
      'token=equals-value',
      'api_key->arrow-value',
      'apikey|pipe-value',
      'secret whitespace-value',
    ]
    for (const [index, probe] of credentialProbes.entries()) {
      current = await store.appendMessage({
        sessionId: session.id,
        expectedRevision: current.revision,
        message: { id: `credential-${index}`, role: 'user', content: probe },
      })
      assert.equal(current.messages.at(-1)?.content, '[redacted private content]', probe)
    }
    await assert.rejects(
      store.create({ title: 'preview=data:image/png;base64,AAAA' }),
      /invalid agent session create/i,
    )
  })
})

test('optimistic revisions reject stale writes', async () => {
  await withStore(async (store) => {
    const session = await store.create({})
    await store.rename({ sessionId: session.id, expectedRevision: session.revision, title: 'Current' })
    await assert.rejects(
      store.appendMessage({ sessionId: session.id, expectedRevision: session.revision, message: { id: 'm', role: 'user', content: 'stale' } }),
      /revision conflict/i,
    )
  })
})

test('managed attachments validate image signatures and never return filesystem paths', async () => {
  await withStore(async (store) => {
    const session = await store.create({})
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const updated = await store.addAttachment({
      sessionId: session.id,
      expectedRevision: session.revision,
      attachment: { name: 'reference.png', mimeType: 'image/png', bytes: png },
    })
    assert.equal(updated.attachments.length, 1)
    assert.equal(Object.hasOwn(updated.attachments[0], 'path'), false)
    assert.deepEqual(await store.readAttachment({ sessionId: session.id, attachmentId: updated.attachments[0].id }), png)

    const windowsNamed = await store.addAttachment({
      sessionId: session.id,
      expectedRevision: updated.revision,
      attachment: { name: String.raw`C:\Users\Alice\private\reference.png`, mimeType: 'image/png', bytes: png },
    })
    assert.equal(windowsNamed.attachments.at(-1)?.name, 'reference.png')
    const uncNamed = await store.addAttachment({
      sessionId: session.id,
      expectedRevision: windowsNamed.revision,
      attachment: { name: String.raw`\\server\share\reference-unc.png`, mimeType: 'image/png', bytes: png },
    })
    assert.equal(uncNamed.attachments.at(-1)?.name, 'reference-unc.png')
    assert.equal(JSON.stringify(uncNamed.attachments).includes('Alice'), false)
    assert.equal(JSON.stringify(uncNamed.attachments).includes('server'), false)

    let credentialNamed = uncNamed
    for (const name of [
      'Authorization Bearer top-secret.png',
      'password hunter2.png',
      'token=private-value.png',
    ]) {
      credentialNamed = await store.addAttachment({
        sessionId: session.id,
        expectedRevision: credentialNamed.revision,
        attachment: { name, mimeType: 'image/png', bytes: png },
      })
      assert.equal(credentialNamed.attachments.at(-1)?.name, 'attachment.png', name)
    }
    const credentialNamesJson = JSON.stringify(credentialNamed.attachments)
    for (const fragment of ['Authorization', 'Bearer', 'top-secret', 'hunter2', 'private-value']) {
      assert.equal(credentialNamesJson.includes(fragment), false, fragment)
    }

    await assert.rejects(
      store.addAttachment({
        sessionId: session.id,
        expectedRevision: credentialNamed.revision,
        attachment: { name: 'fake.png', mimeType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) },
      }),
      /image signature/i,
    )
  })
})

test('managed attachment I/O rejects symlinked session directories and files', async () => {
  await withStore(async (store, root) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'modly-agent-outside-'))
    try {
      const session = await store.create({})
      const attachmentsRoot = path.join(root, 'agent-session-attachments')
      await mkdir(attachmentsRoot, { recursive: true })
      await symlink(outside, path.join(attachmentsRoot, session.id), 'dir')
      const recovered = await store.addAttachment({
        sessionId: session.id,
        expectedRevision: session.revision,
        attachment: { name: 'escape.png', mimeType: 'image/png', bytes: PNG_BYTES },
      })
      assert.deepEqual(await readdir(outside), [])
      assert.equal((await stat(path.join(attachmentsRoot, session.id))).isDirectory(), true)

      const attachment = recovered.attachments[0]
      const managedFile = path.join(attachmentsRoot, session.id, `${attachment.id}.png`)
      const outsideFile = path.join(outside, 'outside.png')
      await writeFile(outsideFile, PNG_BYTES)
      await rm(managedFile)
      await symlink(outsideFile, managedFile, 'file')
      await assert.rejects(
        store.readAttachment({ sessionId: session.id, attachmentId: attachment.id }),
        /symlink|managed attachment/i,
      )
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('attachment limit is per message and staged attachments can be rolled back', async () => {
  await withStore(async (store) => {
    let session = await store.create({})
    for (let index = 0; index < 9; index += 1) {
      session = await store.addAttachment({
        sessionId: session.id,
        expectedRevision: session.revision,
        attachment: { name: `${index}.png`, mimeType: 'image/png', bytes: PNG_BYTES },
      })
      const attachmentId = session.attachments.at(-1)!.id
      session = await store.appendMessage({
        sessionId: session.id,
        expectedRevision: session.revision,
        message: { id: `message-${index}`, role: 'user', content: `Image ${index}`, attachmentIds: [attachmentId] },
      })
    }
    assert.equal(session.attachments.length, 9)

    session = await store.addAttachment({
      sessionId: session.id,
      expectedRevision: session.revision,
      attachment: { name: 'staged.png', mimeType: 'image/png', bytes: PNG_BYTES },
    })
    const stagedId = session.attachments.at(-1)!.id
    session = await store.removeAttachment({ sessionId: session.id, expectedRevision: session.revision, attachmentId: stagedId })
    assert.equal(session.attachments.some((attachment) => attachment.id === stagedId), false)
  })
})

test('expired sessions are inaccessible and active deletion selects newest survivor or creates one', async () => {
  await withStore(async (store, _root, clock) => {
    const first = await store.create({ title: 'First' })
    clock.now += 1_000
    const second = await store.create({ title: 'Second' })
    await store.activate({ sessionId: first.id })
    const afterDelete = await store.delete({ sessionId: first.id, expectedRevision: first.revision })
    assert.equal(afterDelete.activeSessionId, second.id)

    const secondCurrent = await store.read({ sessionId: second.id })
    const lastDelete = await store.delete({ sessionId: second.id, expectedRevision: secondCurrent.revision })
    assert.equal(lastDelete.sessions.length, 1)
    assert.notEqual(lastDelete.activeSessionId, second.id)

    clock.now += AGENT_SESSION_TTL_MS + 1
    await assert.rejects(store.read({ sessionId: lastDelete.activeSessionId }), /not found|expired/i)
  })
})

test('delete waits for attachment and corrupt-backup cleanup before confirming', async () => {
  await withStore(async (store, root, clock) => {
    let session = await store.create({ title: 'Delete me' })
    session = await store.addAttachment({
      sessionId: session.id,
      expectedRevision: session.revision,
      attachment: { name: 'delete.png', mimeType: 'image/png', bytes: PNG_BYTES },
    })
    const sessionDir = path.join(root, 'agent-session-attachments', session.id)
    const backup = path.join(root, `agent-sessions.corrupt-${clock.now}-recent.json`)
    await writeFile(backup, 'sensitive backup', { mode: 0o600 })

    await store.delete({ sessionId: session.id, expectedRevision: session.revision })
    await assert.rejects(access(sessionDir), /ENOENT/)
    await assert.rejects(access(backup), /ENOENT/)
  })
})

test('remove and delete fail closed when privacy cleanup fails', async () => {
  await withStore(async (store, root) => {
    let session = await store.create({ title: 'Protected' })
    session = await store.addAttachment({
      sessionId: session.id,
      expectedRevision: session.revision,
      attachment: { name: 'protected.png', mimeType: 'image/png', bytes: PNG_BYTES },
    })
    const attachment = session.attachments[0]
    const managedFile = path.join(root, 'agent-session-attachments', session.id, `${attachment.id}.png`)
    const injected = new AgentSessionStore({
      rootDir: root,
      removePath: async (target: string, options?: Parameters<typeof rm>[1]) => {
        if (target === managedFile || target.endsWith(session.id) || target.includes('agent-sessions.corrupt-')) {
          throw new Error('injected cleanup failure')
        }
        await rm(target, options)
      },
    } as never)

    await assert.rejects(
      injected.removeAttachment({ sessionId: session.id, expectedRevision: session.revision, attachmentId: attachment.id }),
      (error: unknown) => error instanceof Error && error.name === 'AgentSessionCleanupError',
    )
    assert.equal((await injected.read({ sessionId: session.id })).attachments.length, 1)
    await access(managedFile)

    const backup = path.join(root, `agent-sessions.corrupt-${Date.now()}-protected.json`)
    await writeFile(backup, 'private backup', { mode: 0o600 })
    await assert.rejects(
      injected.delete({ sessionId: session.id, expectedRevision: session.revision }),
      (error: unknown) => error instanceof Error && error.name === 'AgentSessionCleanupError',
    )
    assert.equal((await injected.read({ sessionId: session.id })).id, session.id)
  })
})

test('expired backup cleanup failure is surfaced instead of reporting maintenance success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'modly-agent-cleanup-failure-'))
  const now = Date.parse('2026-08-06T10:00:00.000Z')
  const backup = path.join(root, `agent-sessions.corrupt-${now - AGENT_SESSION_TTL_MS - 1}-expired.json`)
  try {
    await writeFile(backup, 'private backup', { mode: 0o600 })
    const store = new AgentSessionStore({
      rootDir: root,
      now: () => now,
      removePath: async (target: string, options?: Parameters<typeof rm>[1]) => {
        if (target === backup) throw new Error('injected cleanup failure')
        await rm(target, options)
      },
    } as never)
    await assert.rejects(
      store.list(),
      (error: unknown) => error instanceof Error && error.name === 'AgentSessionCleanupError',
    )
    await access(backup)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('corrupt backups expire after seven days while recent evidence is retained', async () => {
  await withStore(async (store, root, clock) => {
    const oldBackup = path.join(root, `agent-sessions.corrupt-${clock.now - AGENT_SESSION_TTL_MS - 1}-old.json`)
    const recentBackup = path.join(root, `agent-sessions.corrupt-${clock.now - AGENT_SESSION_TTL_MS + 1}-recent.json`)
    const unrelated = path.join(root, 'agent-sessions.corrupt-unknown.json')
    await writeFile(oldBackup, 'old', { mode: 0o600 })
    await writeFile(recentBackup, 'recent', { mode: 0o600 })
    await writeFile(unrelated, 'unknown', { mode: 0o600 })
    await store.list()
    await assert.rejects(access(oldBackup), /ENOENT/)
    await access(recentBackup)
    await access(unrelated)
  })
})

test('each corruption retains its own recent backup for the full evidence window', async () => {
  await withStore(async (store, root, clock) => {
    const documentPath = path.join(root, 'agent-sessions.json')
    const firstCorruption = '{"first":"corruption"'
    const secondCorruption = '{"second":"corruption"'

    await writeFile(documentPath, firstCorruption)
    await store.list()
    clock.now += 1_000
    await writeFile(documentPath, secondCorruption)
    await store.list()

    const backupNames = (await readdir(root))
      .filter((name) => /^agent-sessions\.corrupt-\d+-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name))
      .sort()
    assert.equal(backupNames.length, 2)
    const backupContents = await Promise.all(backupNames.map((name) => readFile(path.join(root, name), 'utf8')))
    assert.deepEqual(new Set(backupContents), new Set([firstCorruption, secondCorruption]))
  })
})

test('future schemas remain byte-for-byte read-only including unknown and v1 temp auxiliaries', async () => {
  await withStore(async (store, root) => {
    const documentPath = path.join(root, 'agent-sessions.json')
    const future = JSON.stringify({ schema: 'modly.agent-sessions', version: 2, opaque: { keep: true } })
    const v1Temp = path.join(root, 'agent-sessions.json.v1-temp.tmp')
    const unknownTemp = path.join(root, 'future-writer.tmp')
    await writeFile(documentPath, future)
    await writeFile(v1Temp, 'future auxiliary')
    await writeFile(unknownTemp, 'unknown auxiliary')
    assert.equal((await store.list()).readOnly, true)
    assert.equal(await readFile(documentPath, 'utf8'), future)
    assert.equal(await readFile(v1Temp, 'utf8'), 'future auxiliary')
    assert.equal(await readFile(unknownTemp, 'utf8'), 'unknown auxiliary')
  })
})

test('v1 maintenance deletes only exact v1 temp names', async () => {
  await withStore(async (store, root) => {
    await store.list()
    const exactV1Temp = path.join(root, 'agent-sessions.json.safe-id.tmp')
    const foreignTemp = path.join(root, 'foreign.tmp')
    await writeFile(exactV1Temp, 'temp')
    await writeFile(foreignTemp, 'foreign')
    await store.list()
    await assert.rejects(access(exactV1Temp), /ENOENT/)
    assert.equal(await readFile(foreignTemp, 'utf8'), 'foreign')
  })
})

test('unsupported future schemas are preserved read-only and corrupt v1 salvages valid sessions', async () => {
  await withStore(async (store, root) => {
    const file = path.join(root, 'agent-sessions.json')
    await writeFile(file, JSON.stringify({ schema: 'modly.agent-sessions', version: 99, opaque: { keep: true } }))
    const futureBytes = await readFile(file, 'utf8')
    assert.equal((await store.list()).readOnly, true)
    await assert.rejects(store.create({}), /newer version/i)
    assert.equal(await readFile(file, 'utf8'), futureBytes)

    const valid = {
      id: 'valid-1', title: 'Recovered', revision: 1,
      createdAt: '2026-08-05T10:00:00.000Z', updatedAt: '2026-08-05T10:00:00.000Z', expiresAt: '2026-08-12T10:00:00.000Z',
      messages: [], attachments: [],
    }
    await writeFile(file, JSON.stringify({
      schema: 'modly.agent-sessions', version: 1, activeSessionId: 'valid-1',
      sessions: [valid, { ...valid, title: 'Duplicate must be dropped' }, { id: 7 }],
    }))
    const recovered = await new AgentSessionStore({ rootDir: root, now: () => Date.parse('2026-08-05T11:00:00.000Z') }).list()
    assert.deepEqual(recovered.sessions.map((item) => item.id), ['valid-1'])
    const backupName = (await readdir(root)).find((name) => name.startsWith('agent-sessions.corrupt-'))
    assert.ok(backupName)
    assert.equal((await stat(path.join(root, backupName))).mode & 0o777, 0o600)
  })
})
