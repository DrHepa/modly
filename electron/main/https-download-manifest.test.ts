import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const {
  canonicalHttpsPlanJson,
  expectedHttpsMarkerAssets,
  httpsPlanSha256,
  normalizeHttpsDownloads,
} = await import(new URL('./https-download-manifest.ts', import.meta.url).href)
const {
  parseExtensionManifest,
} = await import(new URL('./automation-capabilities.ts', import.meta.url).href)
const {
  validateInstallCandidates,
} = await import(new URL('./github-extension-install.ts', import.meta.url).href)

const vfrontPlan = [
  {
    url: 'https://kaldir.vc.cit.tum.de/gaussiangpt/vqvae_vfront.ckpt',
    filename: 'vqvae_vfront.ckpt',
    size_bytes: 2115020643,
    sha256: '9f70d0939dc791292be52da6c503bf51b3ac73d9905b51784d0aac81e44faf7a',
  },
  {
    url: 'https://kaldir.vc.cit.tum.de/gaussiangpt/gpt_vfront.ckpt',
    filename: 'gpt_vfront.ckpt',
    size_bytes: 3421157765,
    sha256: '203dc730495bf4f21e60280c6152703867f1b81e9c035d110d792e6a87d9313b',
  },
]

test('normalizes exact ordered HTTPS download assets', () => {
  const normalized = normalizeHttpsDownloads(vfrontPlan)

  assert.deepEqual(normalized, [
    {
      url: vfrontPlan[0].url,
      filename: 'vqvae_vfront.ckpt',
      sizeBytes: 2115020643,
      sha256: vfrontPlan[0].sha256,
    },
    {
      url: vfrontPlan[1].url,
      filename: 'gpt_vfront.ckpt',
      sizeBytes: 3421157765,
      sha256: vfrontPlan[1].sha256,
    },
  ])
  assert.deepEqual(expectedHttpsMarkerAssets(normalized!), [
    {
      filename: 'vqvae_vfront.ckpt',
      size_bytes: 2115020643,
      sha256: vfrontPlan[0].sha256,
    },
    {
      filename: 'gpt_vfront.ckpt',
      size_bytes: 3421157765,
      sha256: vfrontPlan[1].sha256,
    },
  ])
})

test('canonical HTTPS plan JSON and SHA match Python sort_keys output', () => {
  const normalized = normalizeHttpsDownloads(vfrontPlan)!

  assert.match(
    canonicalHttpsPlanJson(normalized),
    /^\[\{"filename":"vqvae_vfront\.ckpt","sha256":/,
  )
  assert.equal(
    httpsPlanSha256(normalized),
    '7e2c3c305c5eef0d6f75558486299a71934909e95af580fed0ebc3dc816df994',
  )
})

test('rejects local hostnames and non-global literal IP addresses without DNS resolution', () => {
  for (const url of [
    'https://localhost/model.bin',
    'https://LOCALHOST./model.bin',
    'https://worker.localhost./model.bin',
    'https://printer.local./model.bin',
    'https://0.0.0.0/model.bin',
    'https://10.0.0.1/model.bin',
    'https://100.64.0.1/model.bin',
    'https://127.0.0.1/model.bin',
    'https://169.254.1.1/model.bin',
    'https://172.16.0.1/model.bin',
    'https://192.168.0.1/model.bin',
    'https://[::]/model.bin',
    'https://[::1]/model.bin',
    'https://[::ffff:127.0.0.1]/model.bin',
    'https://[fc00::1]/model.bin',
    'https://[fe80::1]/model.bin',
  ]) {
    assert.throws(
      () => normalizeHttpsDownloads([{
        ...vfrontPlan[0],
        url,
      }]),
      /local host|globally routable host/,
      url,
    )
  }
})

test('preserves unresolved DNS names and accepts global literal IP addresses', () => {
  const normalized = normalizeHttpsDownloads([
    {
      ...vfrontPlan[0],
      url: 'https://does-not-resolve.invalid/model.bin',
      filename: 'dns-name.bin',
    },
    {
      ...vfrontPlan[0],
      url: 'https://8.8.8.8/model.bin',
      filename: 'ipv4.bin',
    },
    {
      ...vfrontPlan[0],
      url: 'https://[2606:4700:4700::1111]/model.bin',
      filename: 'ipv6.bin',
    },
  ])

  assert.deepEqual(
    normalized?.map((asset: { url: string }) => asset.url),
    [
      'https://does-not-resolve.invalid/model.bin',
      'https://8.8.8.8/model.bin',
      'https://[2606:4700:4700::1111]/model.bin',
    ],
  )
})

test('rejects explicit HTTPS port zero while preserving valid and default ports', () => {
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      url: 'https://example.com:0/model.bin',
    }]),
    /invalid port/,
  )

  const normalized = normalizeHttpsDownloads([
    {
      ...vfrontPlan[0],
      url: 'https://example.com/model.bin',
      filename: 'default-port.bin',
    },
    {
      ...vfrontPlan[0],
      url: 'https://example.com:443/model.bin',
      filename: 'explicit-default-port.bin',
    },
    {
      ...vfrontPlan[0],
      url: 'https://example.com:8443/model.bin',
      filename: 'custom-port.bin',
    },
  ])

  assert.deepEqual(
    normalized?.map((asset: { url: string }) => asset.url),
    [
      'https://example.com/model.bin',
      'https://example.com:443/model.bin',
      'https://example.com:8443/model.bin',
    ],
  )
})

test('rejects malformed, mutable or ambiguous HTTPS assets', () => {
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      extra: true,
    }]),
    /unknown fields/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([{
      filename: 'model.bin',
      size_bytes: 1,
      sha256: '0'.repeat(64),
    }]),
    /missing required fields/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      url: 'http://assets.example.com/model.bin',
    }]),
    /HTTPS URL/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      url: 'https://user:secret@assets.example.com/model.bin',
    }]),
    /credentials/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      url: 'https://assets.example.com/model.bin#fragment',
    }]),
    /fragment/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      filename: '../model.bin',
    }]),
    /safe basename/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      size_bytes: Number.MAX_SAFE_INTEGER + 1,
    }]),
    /positive safe integer/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([{
      ...vfrontPlan[0],
      sha256: 'A'.repeat(64),
    }]),
    /lowercase/,
  )
  assert.throws(
    () => normalizeHttpsDownloads([
      vfrontPlan[0],
      {
        ...vfrontPlan[1],
        filename: vfrontPlan[0].filename,
      },
    ]),
    /duplicate filename/,
  )
})

test('manifest parser accepts none only for models and propagates HTTPS plans', () => {
  const extension = parseExtensionManifest({
    id: 'gaussiangpt',
    type: 'model',
    nodes: [{
      id: 'generate-vfront',
      input: 'none',
      output: 'mesh',
      download_check: '.modly/https-assets-ready.json',
      https_downloads: vfrontPlan,
    }],
  }, 'gaussiangpt', new Set(), false)

  assert.equal(extension.type, 'model')
  assert.equal(extension.nodes[0].input, 'none')
  assert.deepEqual(
    extension.nodes[0].httpsDownloads,
    normalizeHttpsDownloads(vfrontPlan),
  )

  assert.throws(
    () => parseExtensionManifest({
      id: 'invalid-process',
      type: 'process',
      entry: 'processor.js',
      nodes: [{
        id: 'run',
        input: 'none',
        output: 'mesh',
      }],
    }, 'invalid-process', new Set(), false),
    /only for model extension nodes/,
  )
})

test('GitHub candidate validation rejects local HTTPS hosts before setup', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'modly-local-https-'))

  try {
    await writeFile(join(repoDir, 'generator.py'), '# test fixture\n')

    await assert.rejects(
      validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/local-https',
        discovery: {
          mode: 'legacy',
          candidates: [{
            id: 'local-https',
            type: 'model',
            sourceDir: repoDir,
            relativePath: '.',
            manifest: {
              id: 'local-https',
              type: 'model',
              generator_class: 'LocalGenerator',
              nodes: [{
                id: 'generate',
                input: 'none',
                output: 'mesh',
                https_downloads: [{
                  ...vfrontPlan[0],
                  url: 'https://localhost./model.bin',
                }],
              }],
            },
            entryFile: 'generator.py',
            requiresSetup: true,
          }],
        },
      }),
      /local host/,
    )
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
})

test('GitHub candidate validation rejects HTTPS port zero before setup', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'modly-port-zero-https-'))

  try {
    await writeFile(join(repoDir, 'generator.py'), '# test fixture\n')

    await assert.rejects(
      validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/port-zero-https',
        discovery: {
          mode: 'legacy',
          candidates: [{
            id: 'port-zero-https',
            type: 'model',
            sourceDir: repoDir,
            relativePath: '.',
            manifest: {
              id: 'port-zero-https',
              type: 'model',
              generator_class: 'PortZeroGenerator',
              nodes: [{
                id: 'generate',
                input: 'none',
                output: 'mesh',
                https_downloads: [{
                  ...vfrontPlan[0],
                  url: 'https://example.com:0/model.bin',
                }],
              }],
            },
            entryFile: 'generator.py',
            requiresSetup: true,
          }],
        },
      }),
      /invalid port/,
    )
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
})

test('GitHub candidate validation rejects malformed HTTPS plans before setup', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'modly-invalid-https-'))

  try {
    await writeFile(join(repoDir, 'generator.py'), '# test fixture\n')

    await assert.rejects(
      validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/invalid-https',
        discovery: {
          mode: 'legacy',
          candidates: [{
            id: 'invalid-https',
            type: 'model',
            sourceDir: repoDir,
            relativePath: '.',
            manifest: {
              id: 'invalid-https',
              type: 'model',
              generator_class: 'InvalidGenerator',
              nodes: [{
                id: 'generate',
                input: 'none',
                output: 'mesh',
                https_downloads: [{
                  ...vfrontPlan[0],
                  unexpected: true,
                }],
              }],
            },
            entryFile: 'generator.py',
            requiresSetup: true,
          }],
        },
      }),
      /unknown fields/,
    )
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
})
