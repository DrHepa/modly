import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'

const NVIDIA_CONTROL = '/dev/nvidiactl'
const NVIDIA_UVM = '/dev/nvidia-uvm'
const NVIDIA_INITSTATE = '/sys/module/nvidia/initstate'
const NVIDIA_UVM_INITSTATE = '/sys/module/nvidia_uvm/initstate'
const NVIDIA_GPU_NAME = /^nvidia(0|[1-9][0-9]*)$/
const MAX_DEV_ENTRIES = 4_096
const MAX_GPU_DEVICES = 32
const MAX_GPU_INDEX = 254
const MAX_INITSTATE_BYTES = 64

export interface AgentOllamaGpuDeviceStat {
  kind: 'character-device' | 'regular-file' | 'directory' | 'symlink' | 'other'
  device: bigint
  inode: bigint
  rdev: bigint
  uid: number
  gid: number
  mode: number
  nlink: number
  size: number
  mtimeNs: bigint
  ctimeNs: bigint
}

export interface AgentOllamaGpuDeviceFilesystem {
  readdir(path: string): Promise<readonly string[]>
  lstat(path: string): Promise<AgentOllamaGpuDeviceStat>
  realpath(path: string): Promise<string>
  readRegularFile(path: string, maximumBytes: number): Promise<Readonly<{
    bytes: Buffer
    stat: AgentOllamaGpuDeviceStat
  }>>
}

export interface OpenAgentOllamaGpuDeviceAuthority {
  readonly mode: 'cpu' | 'nvidia'
  readonly devicePaths: readonly string[]
  readonly sysfsPaths: readonly string[]
  revalidate(): Promise<void>
  close(): Promise<void>
}

interface DeviceIdentity {
  path: string
  stat: Readonly<AgentOllamaGpuDeviceStat>
  major: number
  minor: number
}

interface SysfsIdentity {
  path: string
  stat: Readonly<AgentOllamaGpuDeviceStat>
}

interface AcceleratorSnapshot {
  mode: 'cpu' | 'nvidia'
  devices: readonly Readonly<DeviceIdentity>[]
  sysfs: readonly Readonly<SysfsIdentity>[]
}

export class AgentOllamaGpuDeviceAuthorityError extends Error {
  readonly code: 'accelerator_unavailable' | 'accelerator_stale'

  constructor(code: AgentOllamaGpuDeviceAuthorityError['code']) {
    super(code)
    this.name = 'AgentOllamaGpuDeviceAuthorityError'
    this.code = code
  }
}

function kindOf(info: BigIntStats): AgentOllamaGpuDeviceStat['kind'] {
  if (info.isCharacterDevice()) return 'character-device'
  if (info.isFile() && !info.isSymbolicLink()) return 'regular-file'
  if (info.isDirectory() && !info.isSymbolicLink()) return 'directory'
  if (info.isSymbolicLink()) return 'symlink'
  return 'other'
}

function safeNumber(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  return result
}

function fromBigIntStats(info: BigIntStats): AgentOllamaGpuDeviceStat {
  return {
    kind: kindOf(info),
    device: info.dev,
    inode: info.ino,
    rdev: info.rdev,
    uid: safeNumber(info.uid),
    gid: safeNumber(info.gid),
    mode: Number(info.mode & 0o7777n),
    nlink: safeNumber(info.nlink),
    size: safeNumber(info.size),
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  }
}

function validStat(value: AgentOllamaGpuDeviceStat): boolean {
  return Boolean(value && typeof value === 'object'
    && ['character-device', 'regular-file', 'directory', 'symlink', 'other'].includes(value.kind)
    && [value.device, value.inode, value.rdev, value.mtimeNs, value.ctimeNs]
      .every((candidate) => typeof candidate === 'bigint' && candidate >= 0n)
    && [value.uid, value.gid, value.mode, value.nlink, value.size]
      .every((candidate) => Number.isSafeInteger(candidate) && candidate >= 0)
    && value.mode <= 0o7777 && value.rdev <= 0xffffffffffffffffn)
}

function sameStat(left: AgentOllamaGpuDeviceStat, right: AgentOllamaGpuDeviceStat): boolean {
  return left.kind === right.kind && left.device === right.device && left.inode === right.inode
    && left.rdev === right.rdev && left.uid === right.uid && left.gid === right.gid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function linuxMajor(value: bigint): number {
  return Number(((value & 0x00000000000fff00n) >> 8n) | ((value & 0xfffff00000000000n) >> 32n))
}

function linuxMinor(value: bigint): number {
  return Number((value & 0xffn) | ((value & 0x00000ffffff00000n) >> 12n))
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}

const productionFilesystem: AgentOllamaGpuDeviceFilesystem = {
  readdir: (path) => readdir(path),
  lstat: async (path) => fromBigIntStats(await lstat(path, { bigint: true })),
  realpath,
  readRegularFile: async (path, maximumBytes) => {
    if (typeof constants.O_NOFOLLOW !== 'number') {
      throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fromBigIntStats(await handle.stat({ bigint: true }))
      const target = Buffer.alloc(maximumBytes + 1)
      const { bytesRead } = await handle.read(target, 0, target.byteLength, null)
      if (bytesRead > maximumBytes) throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
      return Object.freeze({ bytes: target.subarray(0, bytesRead), stat })
    } finally {
      await handle.close().catch(() => undefined)
    }
  },
}

async function maybeStat(
  filesystem: AgentOllamaGpuDeviceFilesystem,
  path: string,
): Promise<AgentOllamaGpuDeviceStat | undefined> {
  try {
    const stat = await filesystem.lstat(path)
    if (!validStat(stat)) throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
    return stat
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function inspectDevice(
  filesystem: AgentOllamaGpuDeviceFilesystem,
  path: string,
): Promise<DeviceIdentity> {
  const before = await filesystem.lstat(path)
  if (!validStat(before) || before.kind !== 'character-device' || before.uid !== 0 || before.nlink !== 1
    || (before.mode & ~0o666) !== 0 || (before.mode & 0o600) !== 0o600
    || await filesystem.realpath(path) !== path) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  const after = await filesystem.lstat(path)
  if (!validStat(after) || !sameStat(before, after)) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  return Object.freeze({
    path,
    stat: Object.freeze({ ...before }),
    major: linuxMajor(before.rdev),
    minor: linuxMinor(before.rdev),
  })
}

async function inspectSysfs(
  filesystem: AgentOllamaGpuDeviceFilesystem,
  path: string,
  before: AgentOllamaGpuDeviceStat,
): Promise<SysfsIdentity> {
  if (before.kind !== 'regular-file' || before.uid !== 0 || before.nlink !== 1 || before.size > 4_096
    || (before.mode & ~0o444) !== 0 || (before.mode & 0o400) === 0
    || await filesystem.realpath(path) !== path) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  const opened = await filesystem.readRegularFile(path, MAX_INITSTATE_BYTES)
  const after = await filesystem.lstat(path)
  if (!validStat(opened.stat) || !validStat(after) || !sameStat(before, opened.stat) || !sameStat(before, after)
    || !opened.bytes.equals(Buffer.from('live\n'))) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  return Object.freeze({ path, stat: Object.freeze({ ...before }) })
}

async function scanAccelerator(filesystem: AgentOllamaGpuDeviceFilesystem): Promise<AcceleratorSnapshot> {
  const names = await filesystem.readdir('/dev')
  if (!Array.isArray(names) || names.length > MAX_DEV_ENTRIES
    || names.some((name) => typeof name !== 'string' || name.length < 1 || name.includes('/') || name.includes('\0'))
    || new Set(names).size !== names.length) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  const gpuNames = names.filter((name) => /^nvidia[0-9]+$/.test(name))
  if (gpuNames.length > MAX_GPU_DEVICES) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  const indexed = gpuNames.map((name) => {
    const match = NVIDIA_GPU_NAME.exec(name)
    const index = match ? Number(match[1]) : Number.NaN
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_GPU_INDEX || name !== `nvidia${index}`) {
      throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
    }
    return { name, index }
  }).sort((left, right) => left.index - right.index)

  const [nvidiaState, uvmState] = await Promise.all([
    maybeStat(filesystem, NVIDIA_INITSTATE),
    maybeStat(filesystem, NVIDIA_UVM_INITSTATE),
  ])
  const hasControl = names.includes('nvidiactl')
  const hasUvm = names.includes('nvidia-uvm')
  const nvidiaEvidence = names.some((name) => name.startsWith('nvidia')) || nvidiaState !== undefined || uvmState !== undefined
  if (!nvidiaEvidence) {
    return Object.freeze({ mode: 'cpu', devices: Object.freeze([]), sysfs: Object.freeze([]) })
  }
  if (!hasControl || !hasUvm || indexed.length < 1 || !nvidiaState || !uvmState) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }

  const [control, uvm, ...gpus] = await Promise.all([
    inspectDevice(filesystem, NVIDIA_CONTROL),
    inspectDevice(filesystem, NVIDIA_UVM),
    ...indexed.map(({ name }) => inspectDevice(filesystem, `/dev/${name}`)),
  ])
  if (control.major !== 195 || control.minor !== 255 || uvm.major === control.major || uvm.major < 1 || uvm.minor !== 0
    || gpus.some((gpu, index) => gpu.major !== control.major || gpu.minor !== indexed[index].index)) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  const sysfs = await Promise.all([
    inspectSysfs(filesystem, NVIDIA_INITSTATE, nvidiaState),
    inspectSysfs(filesystem, NVIDIA_UVM_INITSTATE, uvmState),
  ])
  return Object.freeze({
    mode: 'nvidia',
    devices: Object.freeze([control, ...gpus, uvm]),
    sysfs: Object.freeze(sysfs),
  })
}

function sameSnapshot(left: AcceleratorSnapshot, right: AcceleratorSnapshot): boolean {
  return left.mode === right.mode && left.devices.length === right.devices.length && left.sysfs.length === right.sysfs.length
    && left.devices.every((entry, index) => {
      const candidate = right.devices[index]
      return candidate !== undefined && entry.path === candidate.path && entry.major === candidate.major
        && entry.minor === candidate.minor && sameStat(entry.stat, candidate.stat)
    })
    && left.sysfs.every((entry, index) => {
      const candidate = right.sysfs[index]
      return candidate !== undefined && entry.path === candidate.path && sameStat(entry.stat, candidate.stat)
    })
}

export async function openAgentOllamaGpuDeviceAuthority(
  options: { filesystem?: AgentOllamaGpuDeviceFilesystem } = {},
): Promise<OpenAgentOllamaGpuDeviceAuthority> {
  if (process.platform !== 'linux' || !options || typeof options !== 'object' || Array.isArray(options)
    || Reflect.ownKeys(options).some((key) => key !== 'filesystem')) {
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
  const filesystem = options.filesystem ?? productionFilesystem
  try {
    const snapshot = await scanAccelerator(filesystem)
    let closed = false
    const authority: OpenAgentOllamaGpuDeviceAuthority = {
      mode: snapshot.mode,
      devicePaths: Object.freeze(snapshot.devices.map((entry) => entry.path)),
      sysfsPaths: Object.freeze(snapshot.sysfs.map((entry) => entry.path)),
      revalidate: async () => {
        if (closed) throw new AgentOllamaGpuDeviceAuthorityError('accelerator_stale')
        try {
          const current = await scanAccelerator(filesystem)
          if (!sameSnapshot(snapshot, current)) throw new AgentOllamaGpuDeviceAuthorityError('accelerator_stale')
        } catch {
          throw new AgentOllamaGpuDeviceAuthorityError('accelerator_stale')
        }
      },
      close: async () => { closed = true },
    }
    return Object.freeze(authority)
  } catch (error) {
    if (error instanceof AgentOllamaGpuDeviceAuthorityError) throw error
    throw new AgentOllamaGpuDeviceAuthorityError('accelerator_unavailable')
  }
}
