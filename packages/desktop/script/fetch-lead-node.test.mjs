import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { LEAD_NODE } from '../electron/lead-runtime.mjs'
import { beforePack, fetchLeadNode, leadNodeUrl } from './fetch-lead-node.mjs'

/** A stand-in for the nodejs.org darwin archive: the same layout, a scripted `node`, no network. */
const archive = (t, version, arch) => {
  const work = mkdtempSync(join(tmpdir(), 'hd-lead-node-fixture-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const top = `node-v${version}-darwin-${arch}`
  mkdirSync(join(work, top, 'bin'), { recursive: true })
  writeFileSync(join(work, top, 'bin/node'), '#!/bin/sh\necho stand-in\n', { mode: 0o644 })
  writeFileSync(join(work, top, 'LICENSE'), 'Node.js is licensed for use as follows: (stand-in)\n')
  writeFileSync(join(work, top, 'README.md'), 'not shipped\n')
  const tar = spawnSync('tar', ['-czf', join(work, 'node.tar.gz'), '-C', work, top])
  assert.equal(tar.status, 0, String(tar.stderr))
  const bytes = readFileSync(join(work, 'node.tar.gz'))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const serving = (bytes, calls) => async (url) => { calls.push(url); return new Response(bytes) }
const into = (t) => { const dir = mkdtempSync(join(tmpdir(), 'hd-lead-node-into-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }

test('the pin names one exact Node 26 release and a SHA-256 for each architecture the app ships', () => {
  assert.match(LEAD_NODE.version, /^26\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(LEAD_NODE.sha256).sort(), ['arm64', 'x64'])
  for (const digest of Object.values(LEAD_NODE.sha256)) assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(leadNodeUrl(LEAD_NODE.version, 'arm64'), `https://nodejs.org/dist/v${LEAD_NODE.version}/node-v${LEAD_NODE.version}-darwin-arm64.tar.gz`)
})

test('a verified archive leaves only an executable node and its licence, and a second pack reuses it', async (t) => {
  const { bytes, sha256 } = archive(t, '26.0.0', 'arm64'), calls = [], dir = into(t)
  const pin = { version: '26.0.0', sha256: { arm64: sha256 } }
  const binary = await fetchLeadNode({ arch: 'arm64', into: dir, pin, fetch: serving(bytes, calls), log: () => {} })
  assert.equal(binary, join(dir, 'arm64/bin/node'))
  assert.equal(statSync(binary).mode & 0o777, 0o755)
  assert.match(readFileSync(join(dir, 'arm64/LICENSE'), 'utf8'), /Node\.js is licensed/)
  assert.equal(existsSync(join(dir, 'arm64/README.md')), false, 'nothing but the binary and its licence ships')
  assert.deepEqual(calls, ['https://nodejs.org/dist/v26.0.0/node-v26.0.0-darwin-arm64.tar.gz'])
  await fetchLeadNode({ arch: 'arm64', into: dir, pin, fetch: serving(bytes, calls), log: () => {} })
  assert.equal(calls.length, 1, 'a copy verified for this exact pin is not downloaded again')
})

test('a checksum mismatch fails the build and leaves nothing to pack', async (t) => {
  const { bytes } = archive(t, '26.0.0', 'x64'), dir = into(t)
  const pin = { version: '26.0.0', sha256: { x64: '0'.repeat(64) } }
  await assert.rejects(fetchLeadNode({ arch: 'x64', into: dir, pin, fetch: serving(bytes, []), log: () => {} }), /SHA-256 mismatch/)
  assert.equal(existsSync(join(dir, 'x64/bin/node')), false)
})

test('a copy verified for another pin is fetched and checked again', async (t) => {
  const old = archive(t, '26.0.0', 'arm64'), next = archive(t, '26.1.0', 'arm64'), dir = into(t), calls = []
  await fetchLeadNode({ arch: 'arm64', into: dir, pin: { version: '26.0.0', sha256: { arm64: old.sha256 } }, fetch: serving(old.bytes, calls), log: () => {} })
  await assert.rejects(fetchLeadNode({ arch: 'arm64', into: dir, pin: { version: '26.1.0', sha256: { arm64: old.sha256 } }, fetch: serving(next.bytes, calls), log: () => {} }), /SHA-256 mismatch/)
  assert.equal(calls.length, 2)
})

test('an unanswered download, an unpinned architecture and a non-macOS pack all fail the build', async (t) => {
  const dir = into(t)
  await assert.rejects(fetchLeadNode({ arch: 'arm64', into: dir, pin: { version: '26.0.0', sha256: { arm64: '0'.repeat(64) } },
    fetch: async () => new Response('gone', { status: 404 }), log: () => {} }), /answered 404/)
  await assert.rejects(fetchLeadNode({ arch: 'ia32', into: dir, fetch: async () => { throw new Error('must not fetch') }, log: () => {} }), /no pinned SHA-256/)
  await assert.rejects(beforePack({ electronPlatformName: 'linux', arch: 1 }), /macOS only/)
  await assert.rejects(beforePack({ electronPlatformName: 'darwin', arch: 4 }), /no pinned Node/)
})
