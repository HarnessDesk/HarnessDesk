import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
