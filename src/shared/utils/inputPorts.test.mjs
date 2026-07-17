import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-input-ports-test-')), 'inputPorts.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/utils/inputPorts.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('legacy inputs keep input-N handles and safe string labels', () => {
  const { normalizeExtensionInputPorts } = loadModule()
  const normalized = normalizeExtensionInputPorts({
    input: 'image',
    inputs: ['image', 'text'],
    inputLabels: ['Main image', { unsafe: true }],
  })

  assert.equal(normalized.mode, 'legacy')
  assert.deepEqual(normalized.ports.map((port) => port.handle), ['input-0', 'input-1'])
  assert.deepEqual(normalized.ports.map((port) => port.label), ['Main image', 'text'])
  assert.equal(normalized.primary.handle, 'input-0')
  assert.deepEqual(normalized.issues, [])
})

test('named-v1 ports use declaration order and first required primary', () => {
  const { normalizeExtensionInputPorts } = loadModule()
  const normalized = normalizeExtensionInputPorts({
    io_contract: 'named-v1',
    input_ports: [
      { name: 'reference', type: 'image', required: false },
      { name: 'subject', type: 'image', label: 'Subject', required: true },
    ],
  })

  assert.equal(normalized.mode, 'named-v1')
  assert.deepEqual(normalized.ports.map((port) => port.handle), ['reference', 'subject'])
  assert.deepEqual(normalized.ports.map((port) => port.label), ['reference', 'Subject'])
  assert.equal(normalized.primary.handle, 'subject')
})

test('named-v1 reports malformed, duplicate, and unsupported ports', () => {
  const { normalizeExtensionInputPorts } = loadModule()
  const normalized = normalizeExtensionInputPorts({
    io_contract: 'named-v1',
    input_ports: [
      { name: 'Image', type: 'image' },
      { name: 'caption', type: 'text', required: true },
      { name: 'side', type: 'video', required: true },
      { name: 'Image', type: 'image' },
    ],
  })

  assert.ok(normalized.issues.some((issue) => /lowercase-safe/.test(issue)))
  assert.ok(normalized.issues.some((issue) => /named-v1 currently supports image inputs only/.test(issue)))
  assert.ok(normalized.issues.some((issue) => /unsupported type/.test(issue)))
  assert.ok(normalized.issues.some((issue) => /Duplicate input port name/.test(issue)))
  assert.ok(normalized.issues.some((issue) => /required must be present and boolean/.test(issue)))
})

test('named-v1 reports arrays, extra keys, non-string labels, and non-boolean required', () => {
  const { normalizeExtensionInputPorts } = loadModule()
  const normalized = normalizeExtensionInputPorts({
    io_contract: 'named-v1',
    input_ports: [
      ['not-an-object'],
      { name: 'front', type: 'image', required: true, max: 1 },
      { name: 'side', type: 'image', required: 'yes' },
      { name: 'detail', type: 'image', label: { unsafe: true }, required: false },
    ],
  })

  assert.equal(normalized.mode, 'named-v1')
  assert.deepEqual(normalized.ports, [])
  assert.ok(normalized.issues.some((issue) => /must be an object/.test(issue)))
  assert.ok(normalized.issues.some((issue) => /unsupported field\(s\): max/.test(issue)))
  assert.ok(normalized.issues.some((issue) => /required must be present and boolean/.test(issue)))
  assert.ok(normalized.issues.some((issue) => /label must be a string/.test(issue)))
})
