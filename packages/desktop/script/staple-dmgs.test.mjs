import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { releaseDirectory, repairManifest } from './staple-dmgs.mjs'

/**
 * The DMG stapling pass, over the two things about it that can go wrong
 * silently: which directory it works in, and what it leaves in the manifest.
 *
 * Signing, notarizing and stapling are Apple's tools and are not faked here —
 * what is pinned is the arithmetic around them. `latest-mac.yml` is the file
 * electron-updater fetches, and a wrong hash in it is not visible from any
 * green build; it is visible when someone's update fails months later. The
 * fail-closed exits are pinned for the same reason: they are the kind of thing
 * a later edit quietly turns back into a `return`.
 */

const SCRIPT = fileURLToPath(new URL('./staple-dmgs.mjs', import.meta.url))

const ZIP_ARM = '1FITcbG7c0eQ/e5+LpocpHJFZFRyixNOMnc17YXtDa/JOxDgWSV32fe9G3NuMjg1qyFqWjjClW2dNSTWz+0tyQ=='
const ZIP_X64 = 'c6s4iIPC88tYH4Vd6U2n9zV1tagjgL2mB+t9UOYQgfH+S/UcqFiQ00a99ow0ROfd2uCMcPRFO9dSNm1Nd3RRJQ=='
const OLD_ARM = '2U/lUs8Gf+yL6gBsjR6BwzxRMWEjCZFupCSTyD1fjD/8n0VOCeWNOpHnZDA6w0KL6vFbFGA4qn5MwIzae370dA=='
const OLD_X64 = 'SzixCJ2BGgctc5wgeL/FXVkSoR1847PysMyOa01buiw/FIfFv/M0ytX8pCFyXo6rQmnzjXYebl3WAqFaEpC9hQ=='
const NEW_ARM = 'Ng40+qTfstq85Pjqo1WVF5ggLR2bzD0ZLzijC+VX+PJa23uZFZ5Foqc0m43UGnDpQ7HRJysS6utW/j3Ajga4ig=='
const NEW_X64 = 'FNCRvh3WB8cxkyYO5QnHsGD3VXX2t6I2RAr8cZmpqUROPNyBerK+tr+2GwUzohLArJ7yfaxkn7I6a4/Mpoil4g=='

/**
 * What electron-builder writes: the zips first — it sorts them there so the
 * legacy top-level `path`/`sha512` describe one — then the DMGs, with the
 * `blockMapSize` the zip rows carry and the DMG rows do not.
 */
const MANIFEST = `version: 0.1.0
files:
  - url: HarnessDesk-0.1.0-arm64-mac.zip
    sha512: ${ZIP_ARM}
    size: 118231044
    blockMapSize: 126518
  - url: HarnessDesk-0.1.0-x64-mac.zip
    sha512: ${ZIP_X64}
    size: 123769812
    blockMapSize: 131044
  - url: HarnessDesk-0.1.0-arm64.dmg
    sha512: ${OLD_ARM}
    size: 121847296
  - url: HarnessDesk-0.1.0-x64.dmg
    sha512: ${OLD_X64}
    size: 127438848
path: HarnessDesk-0.1.0-arm64-mac.zip
sha512: ${ZIP_ARM}
releaseDate: '2026-09-06T11:04:22.117Z'
`

const STAPLED = [
  { url: 'HarnessDesk-0.1.0-arm64.dmg', sha512: NEW_ARM, size: 121858560 },
  { url: 'HarnessDesk-0.1.0-x64.dmg', sha512: NEW_X64, size: 127450112 },
]

test('the DMG rows take the new bytes and nothing else moves', () => {
  const { manifest, missing } = repairManifest(MANIFEST, STAPLED)
  assert.deepEqual(missing, [])
  assert.equal(
    manifest,
    `version: 0.1.0
files:
  - url: HarnessDesk-0.1.0-arm64-mac.zip
    sha512: ${ZIP_ARM}
    size: 118231044
    blockMapSize: 126518
  - url: HarnessDesk-0.1.0-x64-mac.zip
    sha512: ${ZIP_X64}
    size: 123769812
    blockMapSize: 131044
  - url: HarnessDesk-0.1.0-arm64.dmg
    sha512: ${NEW_ARM}
    size: 121858560
  - url: HarnessDesk-0.1.0-x64.dmg
    sha512: ${NEW_X64}
    size: 127450112
path: HarnessDesk-0.1.0-arm64-mac.zip
sha512: ${ZIP_ARM}
releaseDate: '2026-09-06T11:04:22.117Z'
`,
  )
})

test('a row is found by its url, not by the order or spacing of its keys', () => {
  const reordered = `version: 0.1.0
files:
    -   size: 121847296
        blockMapSize: 130001
        sha512: ${OLD_ARM}
        url: 'HarnessDesk-0.1.0-arm64.dmg'
releaseDate: '2026-09-06T11:04:22.117Z'
`
  const { manifest, missing } = repairManifest(reordered, [STAPLED[0]])
  assert.deepEqual(missing, [])
  assert.match(manifest, /^        sha512: Ng40\+/m)
  assert.match(manifest, /^    -   size: 121858560$/m)
  // Untouched: a key this pass has no business rewriting.
  assert.match(manifest, /^        blockMapSize: 130001$/m)
})

test('a size the row never had is written in beside the hash', () => {
  const sizeless = `version: 0.1.0
files:
  - url: HarnessDesk-0.1.0-arm64.dmg
    sha512: ${OLD_ARM}
releaseDate: '2026-09-06T11:04:22.117Z'
`
  const { manifest, missing } = repairManifest(sizeless, [STAPLED[0]])
  assert.deepEqual(missing, [])
  assert.equal(
    manifest,
    `version: 0.1.0
files:
  - url: HarnessDesk-0.1.0-arm64.dmg
    sha512: ${NEW_ARM}
    size: 121858560
releaseDate: '2026-09-06T11:04:22.117Z'
`,
  )
})

test('a DMG with no row is reported, not passed over', () => {
  const { missing } = repairManifest(MANIFEST, [
    STAPLED[0],
    { url: 'HarnessDesk-0.1.0-universal.dmg', sha512: NEW_X64, size: 1 },
  ])
  assert.deepEqual(missing, ['HarnessDesk-0.1.0-universal.dmg'])
})

test('a blank line or a comment under files: is not the end of the sequence', () => {
  // Nothing electron-builder writes today, and nothing it promised not to.
  // The point of reading the structure was to stop caring how it is spaced;
  // taking the first entry from the line straight after `files:` cared again,
  // and answered a comment by reporting every DMG missing and failing closed.
  const spaced = `version: 0.1.0
files:

  # written by electron-builder
  - url: HarnessDesk-0.1.0-arm64.dmg
    sha512: ${OLD_ARM}
    size: 121847296
releaseDate: '2026-09-06T11:04:22.117Z'
`
  const { manifest, missing } = repairManifest(spaced, [STAPLED[0]])
  assert.deepEqual(missing, [])
  assert.match(manifest, new RegExp(`^    sha512: ${NEW_ARM.replace(/[+/]/g, '\\$&')}$`, 'm'))
  assert.match(manifest, /^    size: 121858560$/m)
  assert.match(manifest, /^  # written by electron-builder$/m)
})

test('a manifest with no files sequence repairs nothing and says so', () => {
  const { manifest, missing } = repairManifest('version: 0.1.0\n', STAPLED)
  assert.equal(manifest, 'version: 0.1.0\n')
  assert.deepEqual(missing, STAPLED.map(({ url }) => url))
})

/*
 * The legacy top-level `path`/`sha512`. electron-builder sorts the zip to the
 * front of the sequence and copies that row up here, so on this project they
 * describe a file stapling never touches — but that is a consequence of the
 * mac target list, not a rule. Drop the zip target and they describe a DMG,
 * and a rewrite that only walks the sequence would leave the copy stale.
 */

test('the top-level hash follows path when path names a stapled DMG', () => {
  const dmgFirst = `version: 0.1.0
files:
  - url: HarnessDesk-0.1.0-arm64.dmg
    sha512: ${OLD_ARM}
    size: 121847296
path: HarnessDesk-0.1.0-arm64.dmg
sha512: ${OLD_ARM}
releaseDate: '2026-09-06T11:04:22.117Z'
`
  const { manifest } = repairManifest(dmgFirst, [STAPLED[0]])
  assert.equal(manifest.match(/Ng40\+/g)?.length, 2)
  assert.ok(!manifest.includes(OLD_ARM))
})

test('and is left alone when path names a file this pass never touched', () => {
  const { manifest } = repairManifest(MANIFEST, STAPLED)
  assert.match(manifest, new RegExp(`^sha512: ${ZIP_ARM.replace(/[+/]/g, '\\$&')}$`, 'm'))
})

/*
 * Where the pass runs, and that it still refuses to end well with nothing to
 * show. `release` as a bare relative path only resolved from packages/desktop.
 */

test('the release directory comes from this file, not from the working directory', () => {
  assert.equal(
    releaseDirectory(['node', SCRIPT]),
    fileURLToPath(new URL('../release', import.meta.url)),
  )
  assert.ok(releaseDirectory(['node', SCRIPT]).endsWith(join('packages', 'desktop', 'release')))
})

test('an explicit directory is taken as given', () => {
  assert.equal(releaseDirectory(['node', SCRIPT, 'somewhere/else']), resolve('somewhere/else'))
})

test('nothing is signed before the pass knows it can finish', () => {
  // `codesign --force` rewrites the DMG in place. The credential check used to
  // come after the first one, so a run with an identity but no notarization
  // credentials left a signed, unnotarized, half-processed disk image behind
  // on its way to exit 1. Both preconditions are asked before the loop now.
  //
  // Which of the two refuses depends on the machine this runs on — a release
  // machine has the identity, a plain one does not — but neither may have
  // touched the file, and that is what is asserted.
  const scratch = mkdtempSync(join(tmpdir(), 'harnessdesk-staple-'))
  try {
    const dmg = join(scratch, 'HarnessDesk-0.1.0-arm64.dmg')
    const before = Buffer.from('not really a disk image, and it must stay that way')
    writeFileSync(dmg, before)

    const stripped = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('APPLE_')),
    )
    const result = spawnSync(process.execPath, [SCRIPT, scratch], {
      encoding: 'utf8',
      env: stripped,
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /No notarization credentials|No "Developer ID Application" identity/)
    assert.deepEqual(readFileSync(dmg), before)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a missing manifest stops the pass at the start, not half an hour in', () => {
  // `latest-mac.yml` is as much a precondition as the identity and the
  // credentials, and it used to be read after the loop — so a release with no
  // manifest signed every DMG, waited out every notarization, stapled them
  // all, and only then discovered a file that had been missing the whole time.
  //
  // Which precondition speaks depends on the machine: a release machine has
  // the signing identity and gets as far as the manifest, a runner does not.
  // Neither may have touched the DMG, and that is the assertion.
  const scratch = mkdtempSync(join(tmpdir(), 'harnessdesk-staple-'))
  try {
    const dmg = join(scratch, 'HarnessDesk-0.1.0-arm64.dmg')
    const before = Buffer.from('still not a disk image')
    writeFileSync(dmg, before)

    const result = spawnSync(process.execPath, [SCRIPT, scratch], {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('APPLE_')),
        ),
        // The Apple ID route, so the API-key file check above cannot be what
        // answers: this test is about the manifest and nothing else.
        APPLE_ID: 'x@y.z',
        APPLE_APP_SPECIFIC_PASSWORD: 'p',
        APPLE_TEAM_ID: 'TEAM01',
      },
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /latest-mac\.yml is missing|No "Developer ID Application" identity/)
    assert.deepEqual(readFileSync(dmg), before)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('an API key that is not a file stops the pass before it signs', () => {
  // Run under `dist:notarized` the preflight has already asked this, but the
  // script is also documented as runnable on its own — and there `notarytool`
  // was the first thing to notice a key that is not on disk, one
  // `codesign --force` too late to leave the DMG alone.
  const scratch = mkdtempSync(join(tmpdir(), 'harnessdesk-staple-'))
  try {
    const dmg = join(scratch, 'HarnessDesk-0.1.0-arm64.dmg')
    const before = Buffer.from('a disk image only in name')
    writeFileSync(dmg, before)
    writeFileSync(
      join(scratch, 'latest-mac.yml'),
      `version: 0.1.0\nfiles:\n  - url: HarnessDesk-0.1.0-arm64.dmg\n    sha512: ${OLD_ARM}\n    size: 1\n`,
    )

    const result = spawnSync(process.execPath, [SCRIPT, scratch], {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('APPLE_')),
        ),
        APPLE_API_KEY: join(scratch, 'no-such-key.p8'),
        APPLE_API_KEY_ID: 'K1',
        APPLE_API_ISSUER: 'I1',
      },
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /does not name a file that exists|No "Developer ID Application" identity/)
    assert.deepEqual(readFileSync(dmg), before)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a DMG the manifest never mentions is caught before any of them are signed', () => {
  // The file being present is not the same as the rows being there. A stray
  // DMG left in release/ by an earlier build has no row, which is fatal — and
  // used to be fatal only after every disk image had been signed, submitted,
  // waited on and stapled.
  const scratch = mkdtempSync(join(tmpdir(), 'harnessdesk-staple-'))
  try {
    const known = join(scratch, 'HarnessDesk-0.1.0-arm64.dmg')
    const stray = join(scratch, 'HarnessDesk-0.0.9-arm64.dmg')
    const before = Buffer.from('left over from the build before')
    writeFileSync(known, Buffer.from('the one the manifest knows'))
    writeFileSync(stray, before)
    writeFileSync(
      join(scratch, 'latest-mac.yml'),
      `version: 0.1.0\nfiles:\n  - url: HarnessDesk-0.1.0-arm64.dmg\n    sha512: ${OLD_ARM}\n    size: 1\n`,
    )

    const result = spawnSync(process.execPath, [SCRIPT, scratch], {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('APPLE_')),
        ),
        APPLE_ID: 'x@y.z',
        APPLE_APP_SPECIFIC_PASSWORD: 'p',
        APPLE_TEAM_ID: 'TEAM01',
      },
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /HarnessDesk-0\.0\.9-arm64\.dmg: no row|No "Developer ID Application" identity/)
    assert.deepEqual(readFileSync(stray), before)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a directory that is not there, and one with nothing in it, both fail', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'harnessdesk-staple-'))
  try {
    const absent = spawnSync(process.execPath, [SCRIPT, join(scratch, 'never-built')], {
      encoding: 'utf8',
    })
    assert.equal(absent.status, 1)
    assert.match(absent.stderr, /No release directory at .*never-built/)

    const empty = spawnSync(process.execPath, [SCRIPT, scratch], { encoding: 'utf8' })
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /No DMGs in/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
