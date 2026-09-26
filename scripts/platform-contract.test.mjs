import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rootUrl = new URL('../', import.meta.url)
const require = createRequire(import.meta.url)

async function read(relativePath) {
  return readFile(new URL(relativePath, rootUrl), 'utf8')
}

test('Electron 44 and Vite 7 platform versions and bootstrap scripts stay pinned', async () => {
  const packageJson = JSON.parse(await read('package.json'))
  const packageLock = JSON.parse(await read('package-lock.json'))

  assert.equal(packageJson.engines?.node, '>=22.12.0')
  assert.equal(packageJson.type, undefined)
  assert.equal(packageJson.dependencies?.['@electron-toolkit/utils'], '4.0.0')
  assert.equal(packageJson.dependencies?.['electron-updater'], '6.8.9')
  assert.equal(packageJson.dependencies?.esbuild, '^0.28.0')
  assert.equal(packageJson.dependencies?.['@dimforge/rapier3d'], '0.20.0')
  assert.equal(packageJson.dependencies?.mediabunny, '1.55.4')
  assert.match(packageJson.dependencies?.react, /^\^?18\./)
  assert.match(packageJson.dependencies?.['react-dom'], /^\^?18\./)
  assert.equal(packageJson.devDependencies?.electron, '44.1.1')
  assert.equal(packageJson.devDependencies?.['electron-vite'], '5.0.0')
  assert.equal(packageJson.devDependencies?.vite, '7.3.6')
  assert.equal(packageJson.devDependencies?.['@vitejs/plugin-react'], '5.2.0')
  assert.equal(packageJson.devDependencies?.['@types/node'], '24.13.3')
  assert.equal(packageJson.devDependencies?.['electron-builder'], '26.15.3')
  assert.equal(packageJson.devDependencies?.typescript, '5.9.3')
  assert.equal(packageJson.scripts?.['electron:install'], 'install-electron --no')
  assert.equal(packageJson.scripts?.predev, 'npm run electron:install')
  assert.equal(packageJson.scripts?.prepreview, 'npm run electron:install')
  assert.equal(packageLock.packages?.['node_modules/electron']?.version, '44.1.1')
  assert.equal(packageLock.packages?.['node_modules/@dimforge/rapier3d']?.version, '0.20.0')
  assert.equal(packageLock.packages?.['node_modules/mediabunny']?.version, '1.55.4')
  assert.deepEqual(packageLock.packages?.['node_modules/electron']?.bin, {
    electron: 'cli.js',
    'install-electron': 'install.js',
  })
})

test('packaged Mediabunny carries exact MPL-2.0 notice, license, and source provenance', async () => {
  const packageJson = JSON.parse(await read('package.json'))
  assert.ok(packageJson.build?.extraResources?.some((entry) => (
    entry.from === 'THIRD_PARTY_NOTICES.md' && entry.to === 'THIRD_PARTY_NOTICES.md'
  )))
  assert.ok(packageJson.build?.extraResources?.some((entry) => (
    entry.from === 'resources/licenses/mediabunny-1.55.4' && entry.to === 'licenses/mediabunny-1.55.4'
  )))

  const [notice, packagedLicense, dependencyLicense, provenance] = await Promise.all([
    read('THIRD_PARTY_NOTICES.md'),
    read('resources/licenses/mediabunny-1.55.4/LICENSE'),
    read('node_modules/mediabunny/LICENSE'),
    read('resources/licenses/mediabunny-1.55.4/SOURCE.md'),
  ])
  assert.match(notice, /Mediabunny 1\.55\.4/)
  assert.match(notice, /MPL-2\.0/)
  assert.equal(packagedLicense, dependencyLicense)
  assert.match(provenance, /https:\/\/github\.com\/Vanilagy\/mediabunny\/tree\/v1\.55\.4/)
  assert.match(provenance, /No vendored source modifications/)
})

test('FFmpeg packages only an audited current-tuple bundle with exact notices and offline gates', async () => {
  const packageJson = JSON.parse(await read('package.json'))
  assert.equal(packageJson.build?.beforePack, 'scripts/world-ffmpeg-before-pack.cjs')
  assert.equal(packageJson.build?.electronDist, 'node_modules/electron/dist')
  assert.equal(packageJson.build?.downloadAlternateFFmpeg, false)
  assert.equal(packageJson.build?.npmRebuild, false)
  assert.ok(packageJson.build?.extraResources?.some((entry) => (
    entry.from === 'resources/licenses/world-ffmpeg-7.1.1'
      && entry.to === 'licenses/world-ffmpeg-7.1.1'
  )))
  assert.deepEqual(packageJson.build?.win?.extraResources?.filter((entry) => String(entry.to).startsWith('ffmpeg/')), [{
    from: 'resources/ffmpeg/win32-x64', to: 'ffmpeg/win32-x64',
  }])
  assert.deepEqual(packageJson.build?.mac?.extraResources?.filter((entry) => String(entry.to).startsWith('ffmpeg/')), [{
    from: 'resources/ffmpeg/darwin-arm64', to: 'ffmpeg/darwin-arm64',
  }])
  const linuxFfmpegResources = packageJson.build?.linux?.extraResources?.filter((entry) => String(entry.to).startsWith('ffmpeg/'))
  assert.deepEqual(linuxFfmpegResources, [{
    from: 'resources/ffmpeg/linux-${arch}', to: 'ffmpeg/linux-${arch}',
  }])
  assert.ok(
    packageJson.build?.linux?.extraResources?.some((entry) => (
      entry.from === 'resources/world-ffmpeg-build-reports/linux-${arch}.json'
        && entry.to === 'world-ffmpeg-build-reports/linux-${arch}.json'
    )),
    'Linux package resources must bind FFmpeg and build-report lookup to electron-builder arch expansion.',
  )
  assert.ok(
    !packageJson.build?.linux?.extraResources?.some((entry) => (
      /linux-x64/.test(`${entry.from} ${entry.to}`)
        || /linux-arm64/.test(`${entry.from} ${entry.to}`)
    )),
    'Linux package resources must not hard-code one architecture and risk cross-arch fallback.',
  )
  assert.match(packageJson.scripts?.['verify:world-ffmpeg-package'], /verify-world-ffmpeg-package\.ts/)
  assert.match(packageJson.scripts?.['test:world-ffmpeg-native'], /world-ffmpeg-native-e2e\.ts/)
  assert.match(packageJson.scripts?.['prepare:package-tool-cache'], /prepare-electron-builder-tool-cache\.mjs/)
  assert.equal(packageJson.scripts?.package, 'npm run build && npm run package:from-build')
  assert.equal(packageJson.scripts?.['package:from-build'], 'scripts/world-ffmpeg-clean-package')
  assert.doesNotMatch(packageJson.scripts?.build, /curl|wget|fetch|download|prepare-resources/i)
  assert.doesNotMatch(packageJson.scripts?.package, /npx|curl|wget|fetch|download|prepare-resources/i)

  const offlinePackage = await read('scripts/world-ffmpeg-package-tools.mjs')
  const cleanPackage = await read('scripts/world-ffmpeg-clean-package')
  const cleanPackageCommand = await read('scripts/world-ffmpeg-clean-package.cmd')
  const cleanPackageBootstrap = await read('scripts/world-ffmpeg-package-bootstrap.mjs')
  const cleanPackageEnvironment = await read('scripts/world-ffmpeg-package-environment.cjs')
  const cleanPackageNode = await read('scripts/world-ffmpeg-offline-package.mjs')
  const packageHook = await read('scripts/world-ffmpeg-before-pack.cjs')
  const programmaticRunner = await read('scripts/world-ffmpeg-electron-builder-runner.cjs')
  const trustedBuilderConfig = JSON.parse(await read('scripts/world-ffmpeg-electron-builder-config.json'))
  const pinnedBuilderApi = await read('node_modules/electron-builder/out/builder.js')
  const pinnedBuilderCli = await read('node_modules/electron-builder/out/cli/cli-util.js')
  assert.match(offlinePackage, /requestArguments/)
  assert.match(offlinePackage, /ELECTRON_BUILDER_RUNNER/)
  assert.doesNotMatch(offlinePackage, /electron-builder[/\\]out[/\\]cli|builderArguments/)
  assert.match(offlinePackage, /verifyPackagedRuntime/)
  assert.match(offlinePackage, /post-package verification failed/)
  assert.match(programmaticRunner, /require\('electron-builder'\)/)
  assert.match(programmaticRunner, /execArgv:\s*process\.execArgv/)
  assert.match(programmaticRunner, /requireExactExecArgv\(dependencies\.execArgv\)/)
  assert.match(programmaticRunner, /configLoader\.loadEnv = async/)
  assert.doesNotMatch(programmaticRunner, /electron-builder[/\\]out[/\\]cli|createYargs|process\.argv\.slice/)
  assert.match(pinnedBuilderCli, /loadEnv\)\(path\.join\(process\.cwd\(\), "electron-builder\.env"\)/)
  assert.doesNotMatch(pinnedBuilderApi, /loadEnv|electron-builder\.env/)
  assert.match(cleanPackage, /exec \/usr\/bin\/env -i/)
  assert.match(cleanPackage, /node_modules\/electron\/dist\/electron/)
  assert.match(cleanPackage, /Electron\.app\/Contents\/MacOS\/Electron/)
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']) {
    assert.doesNotMatch(cleanPackage, new RegExp(`${name}=`))
  }
  assert.doesNotMatch(cleanPackageCommand, /where|pwsh|powershell|%~1|%\*|%PATH%|%SystemRoot%|%WORLD_/i)
  assert.match(cleanPackageCommand, /set "NODE_OPTIONS="/)
  assert.match(cleanPackageCommand, /set "NODE_PATH="/)
  assert.match(cleanPackageCommand, /set "PATH="/)
  assert.match(cleanPackageCommand, /set "COMSPEC="/)
  assert.match(cleanPackageCommand, /set "PATHEXT="/)
  assert.match(cleanPackageCommand, /%~dp0\.\.\\node_modules\\electron\\dist\\electron\.exe/)
  assert.match(cleanPackageCommand, /world-ffmpeg-package-bootstrap\.mjs/)
  assert.doesNotMatch(cleanPackageCommand, /world-ffmpeg-package-bootstrap\.mjs"\s+%/)
  await assert.rejects(read('scripts/world-ffmpeg-clean-package.ps1'), /ENOENT/)
  assert.match(cleanPackageBootstrap, /ELECTRON_RUN_AS_NODE/)
  assert.match(cleanPackageBootstrap, /process\.versions\.electron/)
  assert.match(cleanPackageBootstrap, /WORLD_FFMPEG_ELECTRON_VERSION/)
  assert.match(cleanPackageEnvironment, /44\.1\.1/)
  assert.match(cleanPackageBootstrap, /shell:\s*false/)
  assert.match(cleanPackageNode, /assertWorldFfmpegCleanPackageAuthority\(\)/)
  assert.match(cleanPackageNode, /execArgv\.length !== 0/)
  assert.match(packageHook, /--require=\$\{DENY_NETWORK_PRELOAD\}/)
  assert.match(packageHook, /WORLD_FFMPEG_VERIFIER_AUTHORITY/)
  assert.equal(trustedBuilderConfig.extends, null)
  delete trustedBuilderConfig.extends
  assert.deepEqual(trustedBuilderConfig, packageJson.build)

  const builtinBuild = await read('scripts/build-builtins.mjs')
  assert.match(builtinBuild, /runNpm\(\['ci', '--offline', '--omit=dev'/)

  const [notice, provenance, license, trustedKeys] = await Promise.all([
    read('THIRD_PARTY_NOTICES.md'),
    read('resources/licenses/world-ffmpeg-7.1.1/SOURCE.md'),
    read('resources/licenses/world-ffmpeg-7.1.1/LGPL-2.1.txt'),
    read('electron/main/world-render-ffmpeg-trusted-keys.json'),
  ])
  assert.match(notice, /FFmpeg 7\.1\.1/)
  assert.match(notice, /libvpx 1\.15\.2/)
  assert.match(notice, /libopus 1\.5\.2/)
  assert.match(notice, /zlib 1\.3\.2/)
  assert.match(notice, /LGPL-2\.1-or-later/)
  assert.match(provenance, /modly-world-ffmpeg-7\.1\.1-sources\.tar\.xz/)
  assert.match(provenance, /same GitHub\s+release as the corresponding Modly binary/)
  assert.match(provenance, /recipient-owned Ed25519 build key/)
  assert.match(provenance, /vendor package does not trust an unsigned\s+or silently modified replacement/)
  assert.match(license, /GNU LESSER GENERAL PUBLIC LICENSE/)
  assert.deepEqual(JSON.parse(trustedKeys), {})
})

test('afterPack verifies the emitted tuple and notices before signing or artifact creation', async () => {
  const { afterPackWith } = require('./after-pack.js')
  const calls = []
  const linuxContext = {
    electronPlatformName: 'linux', arch: 1, appOutDir: '/package/linux',
    packager: { appInfo: { productFilename: 'Modly' } },
  }
  await afterPackWith(linuxContext, {
    verifyCli: async (path) => { calls.push(['verifyCli', path]); return { ok: true } },
    verify: async (request) => { calls.push(['verify', request]); return { ok: true } },
    codesign: async (path) => { calls.push(['codesign', path]) },
  })
  assert.deepEqual(calls, [
    ['verifyCli', '/package/linux/resources'],
    ['verify', { platform: 'linux', arch: 'x64', resourcesPath: '/package/linux/resources' }],
  ])

  calls.length = 0
  const macContext = {
    electronPlatformName: 'darwin', arch: 3, appOutDir: '/package/mac',
    packager: { appInfo: { productFilename: 'Modly' } },
  }
  await afterPackWith(macContext, {
    verifyCli: async (path) => { calls.push(['verifyCli', path]); return { ok: true } },
    verify: async (request) => { calls.push(['verify', request]); return { ok: true } },
    codesign: async (path) => { calls.push(['codesign', path]) },
  })
  assert.deepEqual(calls, [
    ['verifyCli', '/package/mac/Modly.app/Contents/Resources'],
    ['verify', { platform: 'darwin', arch: 'arm64', resourcesPath: '/package/mac/Modly.app/Contents/Resources' }],
    ['codesign', '/package/mac/Modly.app'],
  ])

  await assert.rejects(afterPackWith(macContext, {
    verifyCli: async () => ({ ok: true }),
    verify: async () => ({ ok: false, code: 'bundle-invalid' }),
    codesign: async () => { throw new Error('must not sign') },
  }), /Packaged FFmpeg verification failed: bundle-invalid/)
})

test('electron-vite keeps Electron CJS output and emits the Rapier browser Worker as ESM', async () => {
  const config = await read('electron.vite.config.ts')
  const rendererOffset = config.indexOf('renderer:')

  assert.doesNotMatch(config, /externalizeDepsPlugin/)
  assert.equal(config.match(/target:\s*'node24\.19'/g)?.length, 2)
  assert.equal(config.match(/externalizeDeps:\s*true/g)?.length, 2)
  assert.equal(config.match(/target:\s*'chrome152'/g)?.length, 1)
  assert.ok(rendererOffset > 0)
  assert.doesNotMatch(config.slice(0, rendererOffset), /formats?:\s*\[?['"]es['"]/)
  assert.match(config.slice(rendererOffset), /worker:\s*\{[\s\S]*format:\s*'es'/)
  assert.match(config, /rapierWasmIntegration\(\)/)
  assert.match(config, /import initRapierWasm from "\.\/rapier_wasm3d_bg\.wasm\?init&inline";/)
})

test('physics Worker registers its protocol listener before loading Rapier', async () => {
  const worker = await read('src/areas/worlds/runtime/worldPhysics.worker.ts')
  const listenerOffset = worker.indexOf("scope.addEventListener('message'")
  const rapierLoadOffset = worker.indexOf("import('@dimforge/rapier3d')")

  assert.doesNotMatch(worker, /^import RAPIER from '@dimforge\/rapier3d'$/m)
  assert.ok(listenerOffset >= 0)
  assert.ok(rapierLoadOffset > listenerOffset)
  assert.match(worker, /postError\('physics-init-failed'/)
})

test('built-in extension dependencies are lockfile-backed and installed with npm ci', async () => {
  const buildScript = await read('scripts/build-builtins.mjs')
  assert.doesNotMatch(buildScript, /npm install/)
  assert.match(buildScript, /npm ci/)
  assert.match(buildScript, /package-lock\.json/)

  for (const extension of ['mesh-exporter', 'mesh-optimizer']) {
    const packageJson = JSON.parse(await read(`src/areas/workflows/nodes/${extension}/package.json`))
    const packageLock = JSON.parse(await read(`src/areas/workflows/nodes/${extension}/package-lock.json`))
    assert.equal(packageLock.lockfileVersion, 3)
    assert.equal(packageLock.packages?.['']?.name, packageJson.name)
    assert.deepEqual(packageLock.packages?.['']?.dependencies, packageJson.dependencies)
  }
})

test('CI and release use Node 24, npm ci, and the canonical build entry point', async () => {
  for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const source = await read(workflow)
    assert.doesNotMatch(source, /node-version:\s*['"]20['"]|run:\s*npm install/)
    assert.equal(
      source.match(/node-version:/g)?.length,
      source.match(/node-version:\s*['"]24['"]/g)?.length,
    )
    assert.match(source, /run:\s*npm ci/)
    assert.match(source, /npm run build/)
    assert.doesNotMatch(source, /npx electron-vite build/)
    assert.doesNotMatch(source, /npx electron-builder/)
    assert.match(source, /fetch:world-ffmpeg-sources/)
    assert.match(source, /build:world-ffmpeg-runtime/)
    assert.match(source, /test:world-ffmpeg-native/)
    assert.match(source, /prepare:package-tool-cache/)
    assert.doesNotMatch(source, /npm run package:from-build/)
    const expectedPackageTargets = workflow.endsWith('/release.yml') ? 4 : 3
    assert.equal(source.match(/world-ffmpeg-clean-package/g)?.length, expectedPackageTargets)
    assert.match(source, /Package offline and independently verify emitted resources/)
    assert.match(source, /WORLD_FFMPEG_BUILD_TRUST_FILE/)
    assert.match(source, /WORLD_FFMPEG_PACKAGE_RESULT/)
    assert.match(source, /world-ffmpeg-package-result\.mjs/)
    assert.match(source, /GITHUB_OUTPUT/)
    assert.doesNotMatch(source, /\bdist\/\*|\bdist\\\*/)
    if (workflow.endsWith('/ci.yml')) {
      assert.doesNotMatch(source, /actions\/upload-artifact@v4|artifact_paths|result_manifest/)
      assert.match(source, /package-custody-contracts:[\s\S]*timeout-minutes: 10[\s\S]*node --no-warnings --experimental-strip-types\s+--test --test-concurrency=1\s+scripts\/world-ffmpeg-custody-convergence\.test\.mjs/)
      assert.equal(source.match(/world-ffmpeg-release-uploader\.mjs --verify-only/g)?.length, 3)
      assert.equal(source.match(/--github-output/g)?.length >= 3, true)
      assert.equal(source.match(/WORLD_FFMPEG_PACKAGE_VERIFICATION_RECEIPT: \$\{\{ steps\.evidence\.outputs\.WORLD_FFMPEG_PACKAGE_VERIFICATION_RECEIPT \}\}/g)?.length, 3)
    }
    assert.match(source, /npm run verify:world-ffmpeg-package/)
    const fetchOffset = source.indexOf('fetch:world-ffmpeg-sources')
    const buildOffset = Math.min(...[
      source.indexOf('build:world-ffmpeg-runtime'),
      source.indexOf('bash scripts/build-world-ffmpeg-runtime.sh'),
    ].filter((offset) => offset >= 0))
    const verifyOffset = source.indexOf('verify:world-ffmpeg-package')
    const nativeOffset = source.indexOf('test:world-ffmpeg-native')
    const packageOffset = source.indexOf('world-ffmpeg-clean-package')
    assert.ok(fetchOffset >= 0 && fetchOffset < buildOffset)
    assert.ok(buildOffset < verifyOffset && verifyOffset < nativeOffset && nativeOffset < packageOffset)

    const windowsStart = source.indexOf('  build-windows:')
    const windowsEndCandidates = ['  build-linux:', '  build-macos:']
      .map((marker) => source.indexOf(marker, windowsStart + 1)).filter((offset) => offset > windowsStart)
    const windows = source.slice(windowsStart, Math.min(...windowsEndCandidates))
    assert.match(windows, /shell:\s*msys2 \{0\}[\s\S]*bash scripts\/build-world-ffmpeg-runtime\.sh/)
    assert.doesNotMatch(windows, /npm run build:world-ffmpeg-runtime/)
    assert.match(windows, /shell:\s*C:\\Windows\\System32\\cmd\.exe \/d \/s \/c "call \{0\}"[\s\S]*run:\s*scripts\\world-ffmpeg-clean-package\.cmd > "%RUNNER_TEMP%\\world-ffmpeg-package-output\.txt"\s*$/m)
    assert.doesNotMatch(windows, /world-ffmpeg-clean-package\.cmd --/)
    assert.match(source, /run:\s*\.\/scripts\/world-ffmpeg-clean-package > "\$RUNNER_TEMP\/world-ffmpeg-package-output\.txt"\s*$/m)
    assert.doesNotMatch(source, /world-ffmpeg-clean-package --/)
    for (const argument of [
      '--source-cache "$root/world-ffmpeg-sources"',
      '--work-root "$root/world-ffmpeg-work"',
      '--output "$root/world-ffmpeg-output"',
      '--private-key "$root/world-ffmpeg',
      '--trusted-keys "$root/world-ffmpeg-trust/trusted-keys.v1.json"',
    ]) assert.match(windows, new RegExp(escapeRegExp(argument)))

    const buildInvocations = source.match(
      /(?:bash scripts\/build-world-ffmpeg-runtime\.sh|npm run build:world-ffmpeg-runtime --) \\\n[\s\S]*?--trusted-keys [^\n]+/g,
    ) ?? []
    assert.equal(buildInvocations.length, expectedPackageTargets)
    for (const invocation of buildInvocations) {
      for (const argument of ['--source-cache', '--work-root', '--output', '--private-key', '--trusted-keys']) {
        assert.equal(invocation.match(new RegExp(escapeRegExp(argument), 'g'))?.length, 1)
      }
    }
  }
  const ci = await read('.github/workflows/ci.yml')
  const release = await read('.github/workflows/release.yml')
  assert.match(release, /build-linux-arm64:\s*[\s\S]*?runs-on:\s*ubuntu-24\.04-arm/)
  assert.match(release, /test "\$\(uname -m\)" = aarch64/)
  assert.match(release, /test "\$\(getconf GNU_LIBC_VERSION\)" = 'glibc 2\.39'/)
  assert.match(release, /--target linux-arm64 --source-cache/)
  assert.match(release, /--target linux-arm64 --source-resources/)
  assert.match(release, /prepare:package-tool-cache -- --target linux-arm64/)
  assert.doesNotMatch(release, /build-linux-arm64:[\s\S]*?--target linux-x64[\s\S]*?Package offline and independently verify emitted resources/)
  for (const [name, workflow] of [['CI', ci], ['release', release]]) {
    assert.match(
      workflow,
      /build-macos:\s*[\s\S]*?runs-on:\s*macos-26\s*[\s\S]*?test "\$\(uname -m\)" = arm64/,
      `${name} must pin the arm64 macOS runner label and independently assert the runtime architecture`,
    )
    assert.doesNotMatch(workflow, /runs-on:\s*macos-latest/)
  }
  assert.match(release, /fetch:world-ffmpeg-sources/)
  assert.match(release, /create:world-ffmpeg-sources/)
  assert.match(release, /modly-world-ffmpeg-7\.1\.1-sources\.tar\.xz/)
  assert.match(release, /GENERATION\.v1\.json/)
  assert.match(release, /READY\.v1\.json/)
  assert.match(release, /WORLD_FFMPEG_RELEASE_PRIVATE_KEY_B64/)
  assert.doesNotMatch(release, /resources[\\/]world-ffmpeg-build-reports[\\/](?:win32-x64|darwin-arm64|linux-x64)\.json/)
  assert.doesNotMatch(release, /--artifact-list|artifacts=\(\)|artifact_paths|result_manifest/)
  assert.equal(release.match(/world-ffmpeg-release-uploader\.mjs/g)?.length, 4)
  assert.equal(release.match(/WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT: \$\{\{ steps\.package\.outputs\.WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT \}\}/g)?.length, 4)
  assert.doesNotMatch(release, /gh release (?:create|upload|edit)/)
  assert.doesNotMatch(release, /--clobber/)
  assert.match(release, /world-ffmpeg-release-finalizer\.mjs/)
  assert.match(release, /world-ffmpeg-source-release-uploader\.mjs/)
  assert.match(release, /world-ffmpeg-release-draft\.mjs/)
  assert.match(release, /world-ffmpeg-release-draft\.mjs[\s\S]*--target-commitish "\$\{\{ github\.sha \}\}"/)
  assert.equal(
    release.match(/WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT: \$\{\{ needs\.create-release\.outputs\.WORLD_FFMPEG_RELEASE_DRAFT_RECEIPT \}\}/g)?.length,
    6,
  )
  assert.equal(release.match(/WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT: \$\{\{ steps\.upload\.outputs\.WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT \}\}/g)?.length, 4)
  for (const target of ['WINDOWS', 'DARWIN', 'LINUX', 'LINUX_ARM64']) {
    assert.match(release, new RegExp(`WORLD_FFMPEG_${target}_UPLOAD_RECEIPT: \\$\\{\\{ needs\\.`))
  }
  assert.match(release, /WORLD_FFMPEG_SOURCE_UPLOAD_RECEIPT: \$\{\{ needs\.publish-world-ffmpeg-source\.outputs\.WORLD_FFMPEG_SOURCE_UPLOAD_RECEIPT \}\}/)
  const packageResult = await read('scripts/world-ffmpeg-package-result.mjs')
  assert.match(packageResult, /requireWorldFfmpegPackageResultReceipt\(input\?\.resultReceipt, manifestPath\)/)
  assert.match(packageResult, /loadWorldFfmpegPackageResult\(manifestPath, \{[\s\S]*?resultReceipt,[\s\S]*?outputCustody:/)
  assert.match(packageResult, /WORLD_FFMPEG_PACKAGE_RESULT_RECEIPT=/)
  assert.doesNotMatch(packageResult, /artifact_paths<</)
  const uploader = await read('scripts/world-ffmpeg-release-uploader.mjs')
  const releaseDraft = await read('scripts/world-ffmpeg-release-draft.mjs')
  const releaseClient = await read('scripts/world-ffmpeg-github-release.mjs')
  const releaseFinalizer = await read('scripts/world-ffmpeg-release-finalizer.mjs')
  assert.match(releaseDraft, /WORLD_FFMPEG_RELEASE_GENERATION\.v1\.json/)
  assert.match(releaseDraft, /targetCommitish/)
  assert.match(releaseDraft, /metadata\.body/)
  assert.doesNotMatch(`${releaseClient}\n${releaseFinalizer}`, /If-Match|transitionOwned|expectedEtag/)
  assert.match(uploader, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/)
  assert.match(uploader, /createBoundChunkStream\(file\)/)
  assert.match(uploader, /await requireBoundPublicName\(file\)/)
  assert.match(uploader, /`UPLOAD\.\$\{manifest\.target\}\.v1\.json`/)
  assert.match(uploader, /requireWorldFfmpegPackageResultManifest\(manifest, receipt/)
  assert.match(uploader, /WORLD_FFMPEG_PACKAGE_VERIFICATION_RECEIPT=/)
  assert.match(uploader, /WORLD_FFMPEG_PACKAGE_UPLOAD_RECEIPT=/)
  assert.match(uploader, /--github-output/)
  assert.match(uploader, /uploaded: false/)
  assert.doesNotMatch(release, /gh release upload[^\n]*(?:WORLD_FFMPEG|artifacts)/)
  const packageTools = await read('scripts/world-ffmpeg-package-tools.mjs')
  const artifactInspector = await read('scripts/world-ffmpeg-artifact-inspector.mjs')
  assert.match(packageTools, /inspectWorldFfmpegPackageArtifacts/)
  assert.match(packageTools, /expectedRuntimeManifestSha256: verification\.runtimeManifestSha256/)
  assert.match(packageTools, /WORLD_FFMPEG_BUILD_REPORT\.\$\{requireTarget\(target\)\}\.v1\.json/)
  assert.match(packageTools, /RESULT\.\$\{requireTarget\(target\)\}\.v1\.json/)
  assert.match(artifactInspector, /copyBoundArtifact\(request\.artifactName, snapshotPath, request\)/)
  assert.match(artifactInspector, /runPinnedExtractorChild\(Object\.freeze\(\{/)
  assert.match(artifactInspector, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\)/)
  assert.match(artifactInspector, /extractorHandle\.stat\(\{ bigint: true \}\)/)
  assert.match(artifactInspector, /verifyWorldFfmpegPackage\(\{/)
  assert.match(artifactInspector, /verification\.runtimeManifestSha256 !== request\.expectedRuntimeManifestSha256/)
  assert.match(artifactInspector, /deployable artifact changed after inspection/)
  const toolLock = JSON.parse(await read('resources/packaging/electron-builder-tool-cache.v1.json'))
  assert.equal(toolLock.extractors['win32-x64'].execution, 'in-process-portable-zip-v1')
  assert.deepEqual(toolLock.extractors['win32-x64'].source, {
    release: 'modly-world-ffmpeg-portable-zip@1',
    filename: 'world-ffmpeg-portable-zip.mjs',
    member: 'module',
  })
  const portableZip = Buffer.from(await read('scripts/world-ffmpeg-portable-zip.mjs'))
  assert.equal(toolLock.extractors['win32-x64'].sha256, createHash('sha256').update(portableZip).digest('hex'))
  assert.equal(toolLock.extractors['win32-x64'].size, portableZip.byteLength)
  const attributes = await read('.gitattributes')
  assert.match(attributes, /^scripts\/world-ffmpeg-portable-zip\.mjs text eol=lf$/m)
  const packageConfig = JSON.parse(await read('scripts/world-ffmpeg-electron-builder-config.json'))
  assert.equal(packageConfig.win.target, 'dir')
  assert.doesNotMatch(release, /resources\/ffmpeg\/(?:win32-x64|darwin-arm64|linux-x64)[\s\S]*Verify audited Worlds FFmpeg bundle[\s\S]*Build & Package/)
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('native FFmpeg harness asserts repository-produced codec and exact timeline evidence', async () => {
  const source = await read('scripts/world-ffmpeg-native-e2e.ts')
  assert.match(source, /inspectWorldWebmVerificationEvidence/)
  assert.match(source, /videoCodec/)
  assert.match(source, /audioCodec/)
  assert.match(source, /videoFrameCount/)
  assert.match(source, /videoPresentationTimestampsTicks/)
  assert.match(source, /videoEndNanoseconds/)
  assert.match(source, /audioPresentedEndNanoseconds/)
  assert.match(source, /declaredDurationNanoseconds/)
})
