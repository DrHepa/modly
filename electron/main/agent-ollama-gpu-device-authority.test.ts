import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentOllamaGpuDeviceAuthorityError,
  openAgentOllamaGpuDeviceAuthority,
  type AgentOllamaGpuDeviceFilesystem,
  type AgentOllamaGpuDeviceStat,
} from './agent-ollama-gpu-device-authority.ts'

const NVIDIA_INITSTATE = '/sys/module/nvidia/initstate'
const NVIDIA_UVM_INITSTATE = '/sys/module/nvidia_uvm/initstate'

function deviceNumber(major: number, minor: number): bigint {
  const majorValue = BigInt(major)
  const minorValue = BigInt(minor)
  return ((majorValue & 0xfffn) << 8n)
    | ((majorValue & ~0xfffn) << 32n)
    | (minorValue & 0xffn)
    | ((minorValue & ~0xffn) << 12n)
}

function fixtureStat(
  kind: AgentOllamaGpuDeviceStat['kind'],
  overrides: Partial<AgentOllamaGpuDeviceStat> = {},
): AgentOllamaGpuDeviceStat {
  return {
    kind,
    device: 1n,
    inode: 1n,
    rdev: 0n,
    uid: 0,
    gid: 0,
    mode: kind === 'character-device' ? 0o666 : 0o444,
    nlink: 1,
    size: kind === 'regular-file' ? 4_096 : 0,
    mtimeNs: 1n,
    ctimeNs: 1n,
    ...overrides,
  }
}

class FixtureFilesystem implements AgentOllamaGpuDeviceFilesystem {
  devEntries: string[] = ['null', 'random']
  readonly stats = new Map<string, AgentOllamaGpuDeviceStat>()
  readonly canonical = new Map<string, string>()
  readonly contents = new Map<string, Buffer>()

  async readdir(path: string): Promise<readonly string[]> {
    assert.equal(path, '/dev')
    return [...this.devEntries]
  }

  async lstat(path: string): Promise<AgentOllamaGpuDeviceStat> {
    const value = this.stats.get(path)
    if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { ...value }
  }

  async realpath(path: string): Promise<string> {
    if (!this.stats.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return this.canonical.get(path) ?? path
  }

  async readRegularFile(path: string, maximumBytes: number): Promise<Readonly<{
    bytes: Buffer
    stat: AgentOllamaGpuDeviceStat
  }>> {
    const bytes = this.contents.get(path)
    const stat = this.stats.get(path)
    if (!bytes || !stat || bytes.byteLength > maximumBytes) throw new Error('unreadable')
    return { bytes: Buffer.from(bytes), stat: { ...stat } }
  }
}

function addCompleteNvidia(fixture: FixtureFilesystem, indexes: readonly number[] = [0]): void {
  fixture.devEntries.push('nvidia-modeset', 'nvidia-uvm', 'nvidiactl', ...indexes.map((index) => `nvidia${index}`))
  fixture.stats.set('/dev/nvidiactl', fixtureStat('character-device', { inode: 10n, rdev: deviceNumber(195, 255) }))
  fixture.stats.set('/dev/nvidia-uvm', fixtureStat('character-device', { inode: 11n, rdev: deviceNumber(509, 0) }))
  for (const index of indexes) {
    fixture.stats.set(`/dev/nvidia${index}`, fixtureStat('character-device', {
      inode: BigInt(20 + index),
      rdev: deviceNumber(195, index),
    }))
  }
  for (const [index, path] of [NVIDIA_INITSTATE, NVIDIA_UVM_INITSTATE].entries()) {
    fixture.stats.set(path, fixtureStat('regular-file', { device: 2n, inode: BigInt(30 + index) }))
    fixture.contents.set(path, Buffer.from('live\n'))
  }
}

test('GPU device authority preserves a private CPU-only mode only when NVIDIA is genuinely absent', async () => {
  const fixture = new FixtureFilesystem()
  const authority = await openAgentOllamaGpuDeviceAuthority({ filesystem: fixture })
  assert.equal(authority.mode, 'cpu')
  assert.deepEqual(authority.devicePaths, [])
  assert.deepEqual(authority.sysfsPaths, [])
  await authority.revalidate()

  fixture.stats.set(NVIDIA_INITSTATE, fixtureStat('regular-file', { device: 2n }))
  fixture.contents.set(NVIDIA_INITSTATE, Buffer.from('live\n'))
  await assert.rejects(authority.revalidate(), (error: unknown) => (
    error instanceof AgentOllamaGpuDeviceAuthorityError && error.code === 'accelerator_stale'
  ))
  await authority.close()
})

test('GPU device authority binds a complete NVIDIA set in deterministic numeric order', async () => {
  const fixture = new FixtureFilesystem()
  addCompleteNvidia(fixture, [12, 2, 0])
  const authority = await openAgentOllamaGpuDeviceAuthority({ filesystem: fixture })
  assert.equal(authority.mode, 'nvidia')
  assert.deepEqual(authority.devicePaths, [
    '/dev/nvidiactl',
    '/dev/nvidia0',
    '/dev/nvidia2',
    '/dev/nvidia12',
    '/dev/nvidia-uvm',
  ])
  assert.deepEqual(authority.sysfsPaths, [NVIDIA_INITSTATE, NVIDIA_UVM_INITSTATE])
  await authority.revalidate()

  fixture.stats.set('/dev/nvidia2', {
    ...fixture.stats.get('/dev/nvidia2')!,
    ctimeNs: 2n,
  })
  await assert.rejects(authority.revalidate(), (error: unknown) => (
    error instanceof AgentOllamaGpuDeviceAuthorityError && error.code === 'accelerator_stale'
  ))
  await authority.close()
})

test('GPU device authority denies partial, unsafe, aliased, and inconsistent NVIDIA topology', async (t) => {
  const cases: Array<readonly [string, (fixture: FixtureFilesystem) => void]> = [
    ['orphan NVIDIA evidence', (fixture) => {
      fixture.devEntries.push('nvidia-modeset')
    }],
    ['partial device set', (fixture) => {
      fixture.devEntries.push('nvidiactl')
      fixture.stats.set('/dev/nvidiactl', fixtureStat('character-device', { rdev: deviceNumber(195, 255) }))
    }],
    ['missing sysfs state', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.stats.delete(NVIDIA_UVM_INITSTATE)
      fixture.contents.delete(NVIDIA_UVM_INITSTATE)
    }],
    ['non-character GPU', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.stats.set('/dev/nvidia0', fixtureStat('regular-file'))
    }],
    ['symlinked control node', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.stats.set('/dev/nvidiactl', fixtureStat('symlink'))
      fixture.canonical.set('/dev/nvidiactl', '/tmp/nvidiactl')
    }],
    ['wrong GPU minor', (fixture) => {
      addCompleteNvidia(fixture, [2])
      fixture.stats.set('/dev/nvidia2', fixtureStat('character-device', { rdev: deviceNumber(195, 1) }))
    }],
    ['unsafe owner', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.stats.set('/dev/nvidia0', fixtureStat('character-device', { uid: 1, rdev: deviceNumber(195, 0) }))
    }],
    ['unsafe device mode', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.stats.set('/dev/nvidia0', fixtureStat('character-device', { mode: 0o777, rdev: deviceNumber(195, 0) }))
    }],
    ['symlinked sysfs state', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.stats.set(NVIDIA_INITSTATE, fixtureStat('symlink', { device: 2n }))
      fixture.canonical.set(NVIDIA_INITSTATE, '/tmp/initstate')
    }],
    ['writable sysfs state', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.stats.set(NVIDIA_INITSTATE, fixtureStat('regular-file', { device: 2n, mode: 0o644 }))
    }],
    ['non-live module', (fixture) => {
      addCompleteNvidia(fixture)
      fixture.contents.set(NVIDIA_INITSTATE, Buffer.from('coming\n'))
    }],
  ]
  for (const [name, configure] of cases) {
    await t.test(name, async () => {
      const fixture = new FixtureFilesystem()
      configure(fixture)
      await assert.rejects(openAgentOllamaGpuDeviceAuthority({ filesystem: fixture }), (error: unknown) => (
        error instanceof AgentOllamaGpuDeviceAuthorityError
        && error.code === 'accelerator_unavailable'
        && !error.message.includes('/dev')
        && !error.message.includes('/sys')
      ))
    })
  }
})

test('GPU device authority bounds enumeration and detects sysfs mutation', async () => {
  const oversized = new FixtureFilesystem()
  addCompleteNvidia(oversized, Array.from({ length: 33 }, (_, index) => index))
  await assert.rejects(openAgentOllamaGpuDeviceAuthority({ filesystem: oversized }), (error: unknown) => (
    error instanceof AgentOllamaGpuDeviceAuthorityError && error.code === 'accelerator_unavailable'
  ))

  const fixture = new FixtureFilesystem()
  addCompleteNvidia(fixture)
  const authority = await openAgentOllamaGpuDeviceAuthority({ filesystem: fixture })
  fixture.contents.set(NVIDIA_UVM_INITSTATE, Buffer.from('going\n'))
  await assert.rejects(authority.revalidate(), (error: unknown) => (
    error instanceof AgentOllamaGpuDeviceAuthorityError && error.code === 'accelerator_stale'
  ))
  await authority.close()
})
