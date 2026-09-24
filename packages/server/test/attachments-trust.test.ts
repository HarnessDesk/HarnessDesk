import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { connect } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AttachmentIdentity } from '@harnessdesk/protocol'

import { resolveAttachments, type AttachmentSubject } from '../src/attachments/catalog.js'
import { AttachmentTrust } from '../src/attachments/trust.js'
import { tempDir } from './scratch.js'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'

/**
 * The person's own local approval: preview, approve, and the one question
 * every later load asks — `permits`. Every test here proves the negative as
 * hard as the positive, because a trust store that fails open is worse than
 * one that never shipped.
 */

const subject = (overrides: Partial<AttachmentSubject> = {}): AttachmentSubject => ({
  project: '/project',
  incarnation: 'incarnation-a',
  agent: 'scout',
  origin: 'project',
  agentDigest: 'agent-digest',
  runtime: 'claude',
  build: '1.0.0',
  ceiling: 'edit',
  ...overrides,
})

const identity = (overrides: Partial<AttachmentIdentity> = {}): AttachmentIdentity => ({
  kind: 'skill',
  name: 'demo',
  digest: 'digest-a',
  source: 'agent',
  pathLabel: '~/demo',
  ...overrides,
})

const resolvedOf = (id: AttachmentIdentity) => ({ identity: id, files: [], server: null })

test('cloning and restoring do not approve', async (t) => {
  const dir = tempDir('hd-attach-trust-clone-')
  const trust = new AttachmentTrust(join(dir, 'attachment-trust.json'))

  // Traps: approving must never spawn a process or open a socket.
  const cp = createRequire(import.meta.url)('node:child_process') as { execFile: typeof execFile }
  const realExecFile = cp.execFile
  let spawned = false
  // @ts-expect-error -- test double, arity does not need to match exactly
  cp.execFile = (...args: unknown[]) => {
    spawned = true
    throw new Error('execFile must never be called by trust.ts')
  }
  syncBuiltinESMExports()
  t.after(() => {
    cp.execFile = realExecFile
    syncBuiltinESMExports()
  })

  const original = subject({ incarnation: 'incarnation-a' })
  const id = identity({ digest: 'digest-a' })
  const review = await trust.preview(original, [resolvedOf(id)])
  await trust.approve(review.token)
  assert.equal(await trust.permits(original, id), true, 'the exact combination just approved must permit')

  // "Cloning": the same bundle, same Agent, same everything — except the
  // repository was deleted and cloned again, which phase 4's own
  // `incarnationOf` makes a new incarnation.
  const cloned = subject({ incarnation: 'incarnation-b' })
  assert.equal(await trust.permits(cloned, id), false, 'a different incarnation of the same repository must not inherit trust')

  // "Restoring": the grants file and its sealed key, copied verbatim into a
  // fresh location — exactly what a backup or a second checkout could do,
  // even though the desk's own backup format excludes both files by policy.
  // Read that copy from a second `AttachmentTrust` and prove the exact same
  // boundary still holds there — copying the file confers nothing beyond
  // what its own signed contents already say.
  const restoredDir = tempDir('hd-attach-trust-restored-')
  await mkdir(restoredDir, { recursive: true })
  const { copyFile } = await import('node:fs/promises')
  await copyFile(join(dir, 'attachment-trust.json'), join(restoredDir, 'attachment-trust.json'))
  await copyFile(join(dir, 'attachment-trust.key'), join(restoredDir, 'attachment-trust.key'))
  const restored = new AttachmentTrust(join(restoredDir, 'attachment-trust.json'))
  assert.equal(await restored.permits(original, id), true, 'a byte-identical copy on the same machine still verifies for its own incarnation')
  assert.equal(await restored.permits(cloned, id), false, 'and still refuses a different incarnation, exactly as the original file would')

  // Tampering, not just copying: hand-edit the stored grant's own
  // `incarnation` field to name the *cloned* incarnation, on the very same
  // machine whose key would otherwise still verify everything else about the
  // grant untouched. If `incarnation` is itself inside the signed payload,
  // this edit breaks the signature and the tampered grant permits nothing;
  // if it were left out of the signature, the edit would sail through and a
  // grant taken for one repository would silently cover a clone of it.
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'attachment-trust.json'), 'utf8'))
  raw.grants[0].incarnation = 'incarnation-b'
  await writeFile(join(dir, 'attachment-trust.json'), JSON.stringify(raw))
  const tampered = new AttachmentTrust(join(dir, 'attachment-trust.json'))
  assert.equal(await tampered.permits(cloned, id), false, 'a hand-edited incarnation field must fail its own signature, not silently take effect')

  assert.equal(spawned, false, 'trust never spawns anything')
})

test('review is bound to bytes runtime and ceiling', async () => {
  const dir = tempDir('hd-attach-trust-bound-')
  const trust = new AttachmentTrust(join(dir, 'attachment-trust.json'))

  const base = subject()
  const id = identity()
  const review = await trust.preview(base, [resolvedOf(id)])
  await trust.approve(review.token)
  assert.equal(await trust.permits(base, id), true)

  // Each field changed independently: none of these may permit.
  assert.equal(await trust.permits(base, identity({ digest: 'digest-b' })), false, 'changed bytes must not still be covered')
  assert.equal(await trust.permits(subject({ runtime: 'codex' }), id), false, 'a different runtime must not inherit the grant')
  assert.equal(await trust.permits(subject({ build: '2.0.0' }), id), false, 'a new build must review again')
  assert.equal(await trust.permits(subject({ ceiling: 'merge' }), id), false, 'a widened ceiling must review again')
  assert.equal(await trust.permits(subject({ ceiling: 'read' }), id), true, 'a narrower Seat is less authority, and the reviewed ceiling covers it')
  assert.equal(await trust.permits(subject({ agent: 'other-agent' }), id), false, 'a different Agent id must not inherit the grant')

  // The original combination is untouched by any of the above.
  assert.equal(await trust.permits(base, id), true, 'the original grant remains valid only for its original inputs')
})

test('preview cannot launch', async (t) => {
  const dir = tempDir('hd-attach-trust-nolaunch-')
  const trust = new AttachmentTrust(join(dir, 'attachment-trust.json'))

  const cp = createRequire(import.meta.url)('node:child_process') as { execFile: typeof execFile }
  const realExecFile = cp.execFile
  let spawned = false
  // @ts-expect-error -- test double
  cp.execFile = () => {
    spawned = true
    throw new Error('must not spawn')
  }
  let connected = false
  const realConnect = connect
  const netModule = createRequire(import.meta.url)('node:net') as { connect: typeof connect }
  netModule.connect = () => {
    connected = true
    throw new Error('must not connect')
  }
  syncBuiltinESMExports()
  t.after(() => {
    cp.execFile = realExecFile
    netModule.connect = realConnect
    syncBuiltinESMExports()
  })

  // Resolve both kinds discovery actually handles (skill, mcp) and preview them together.
  const agentDir = join(dir, '.harnessdesk', 'agents', 'scout')
  await mkdir(join(agentDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nDo the thing.\n')
  const entry = {
    id: 'scout',
    origin: 'project' as const,
    path: join(agentDir, 'AGENT.md'),
    digest: 'x',
    shadows: [],
    problems: [],
    definition: {
      id: 'scout',
      name: 'Scout',
      description: null,
      ceiling: 'read' as const,
      ceilingFrom: 'none' as const,
      answers: [],
      produces: [],
      skills: ['demo'],
      mcp: [], // no Library/runtime configured — the mcp side of discovery still runs and finds nothing, without ever launching anything.
      prefer: [],
      brief: 'Look.',
    },
  }
  const resolved = await resolveAttachments(entry, dir)
  assert.equal(resolved.length, 1)

  const review = await trust.preview(subject(), resolved)
  assert.equal(review.declarations.length, 1)
  assert.ok(review.consequence.length > 0)

  assert.equal(spawned, false, 'discovery and preview must never start a process')
  assert.equal(connected, false, 'discovery and preview must never open a socket')
})

test('the sealing key is private to the user, host-owned, never beside the grants it seals', async () => {
  const dir = tempDir('hd-attach-trust-keyperm-')
  const trust = new AttachmentTrust(join(dir, 'attachment-trust.json'))
  const id = identity()
  const review = await trust.preview(subject(), [resolvedOf(id)])
  await trust.approve(review.token)

  const mode = (await stat(join(dir, 'attachment-trust.key'))).mode & 0o777
  assert.equal(mode, 0o600, 'the key is readable by its owner alone, the same as commands-seen.key')
  // Its own file, never folded into the grants JSON a backup or a second
  // checkout could otherwise carry whole.
  const grantsText = await readFile(join(dir, 'attachment-trust.json'), 'utf8')
  assert.ok(!grantsText.includes(await readFile(join(dir, 'attachment-trust.key'), 'utf8')), 'the key never appears inside the grants file')
})

test('a corrupted or missing key fails closed: it never revives what it can no longer verify', async () => {
  const dir = tempDir('hd-attach-trust-keycorrupt-')
  const trust = new AttachmentTrust(join(dir, 'attachment-trust.json'))
  const id = identity()
  const review = await trust.preview(subject(), [resolvedOf(id)])
  await trust.approve(review.token)
  assert.equal(await trust.permits(subject(), id), true, 'sanity: the grant just approved verifies against its own key')

  // Corrupt the key in place — not delete it, so this is "unreadable", not
  // merely "absent" — and read it with a *fresh* store (a live one may cache
  // nothing, but a fresh instance is the honest test of what disk alone says).
  await writeFile(join(dir, 'attachment-trust.key'), Buffer.from('not the cipher output at all'))
  const afterCorruption = new AttachmentTrust(join(dir, 'attachment-trust.json'))
  assert.equal(
    await afterCorruption.permits(subject(), id),
    false,
    'a key that no longer decrypts to a valid 32-byte hex key must approve nothing already on disk',
  )

  // Missing entirely reads the same way: fails closed, not "nothing to check".
  const { rm } = await import('node:fs/promises')
  await rm(join(dir, 'attachment-trust.key'))
  const afterMissing = new AttachmentTrust(join(dir, 'attachment-trust.json'))
  assert.equal(await afterMissing.permits(subject(), id), false, 'a missing key must also approve nothing already on disk')
})

test('plain path reads no attachment roots', async (t) => {
  const dir = tempDir('hd-attach-trust-plain-')
  // Never created: if `AttachmentTrust` read or wrote eagerly, this directory
  // would exist by the time the assertions below run.
  const file = join(dir, 'never-created', 'attachment-trust.json')
  const trust = new AttachmentTrust(file)

  const { access } = await import('node:fs/promises')
  const existsBefore = await access(join(dir, 'never-created')).then(
    () => true,
    () => false,
  )
  assert.equal(existsBefore, false, 'constructing the trust store must not touch disk')

  // A plain Agent — no skills, no mcp — must resolve to nothing without any
  // filesystem access at all. The output alone cannot prove this: an Agent
  // whose folder cannot even be reached also answers `[]`. What proves the
  // opt-in guard is that no filesystem call is made *at all* — every
  // `node:fs/promises` entry point this module could reach is patched, for
  // the one call below, to fail loudly rather than quietly report ENOENT.
  const plain = {
    id: 'plain',
    origin: 'project' as const,
    path: join(dir, 'does', 'not', 'exist', 'AGENT.md'),
    digest: 'x',
    shadows: [],
    problems: [],
    definition: {
      id: 'plain',
      name: 'Plain',
      description: null,
      ceiling: 'read' as const,
      ceilingFrom: 'none' as const,
      answers: [],
      produces: [],
      skills: [],
      mcp: [],
      prefer: [],
      brief: 'Just talk.',
    },
  }

  // A thrown error alone is not proof: `resolveAttachmentDeclarations`'s own
  // `agentFolder` catches a failed `realpath` and turns it into an ordinary
  // "could not resolve" result, so a call that throws here can still be
  // swallowed two frames up and never surface as a rejection. What must be
  // proven is that the call happened *at all* — tracked directly, never
  // inferred from whether something downstream propagated it.
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => unknown>
  const originals: Record<string, (...args: unknown[]) => unknown> = {}
  let touched: string | null = null
  for (const name of ['lstat', 'stat', 'readdir', 'realpath', 'open', 'readFile']) {
    originals[name] = fsp[name]!
    fsp[name] = () => {
      touched ??= name
      throw new Error(`${name} must not be called for a plain Agent with no declarations`)
    }
  }
  syncBuiltinESMExports()
  let resolved: readonly unknown[]
  try {
    resolved = await resolveAttachments(plain, join(dir, 'also', 'does', 'not', 'exist'))
  } finally {
    // Restored before `permits` below, which legitimately reads trust's own
    // files (and must gracefully find neither) — a different question from
    // whether *Agent declarations* were read, which is all this guards.
    for (const [name, fn] of Object.entries(originals)) fsp[name] = fn
    syncBuiltinESMExports()
  }
  assert.equal(touched, null, 'no filesystem call may be made at all for an Agent with no declarations')
  assert.deepEqual(resolved, [])

  // permits() on an untouched store answers false without ever creating the file.
  assert.equal(await trust.permits(subject(), identity()), false)
  const existsAfter = await access(join(dir, 'never-created')).then(
    () => true,
    () => false,
  )
  assert.equal(existsAfter, false, 'a read-only question never creates the trust store')
})

test('a server’s review shows exactly what will run — command, arguments and environment — and says truthfully when it runs', async () => {
  const dir = tempDir('hd-attach-trust-server-')
  const trust = new AttachmentTrust(join(dir, 'attachment-trust.json'))
  const server = {
    name: 'reviewer-tools',
    transport: 'stdio' as const,
    command: '/usr/local/bin/node',
    args: ['server.mjs', '--port', '0'],
    env: { NODE_OPTIONS: '--max-old-space-size=512', GITHUB_TOKEN: 'placeholder-not-a-token' }, // hd-secrets-ok: a stand-in the review must hide
  }
  const id = identity({ kind: 'mcp', name: 'reviewer-tools', digest: 'e'.repeat(64), source: 'library' })
  const review = await trust.preview(subject({ ceiling: 'merge' }), [{ identity: id, files: [], server }], { runtimeName: 'Pretty Agent' })
  const shown = review.files.find((one) => one.path === 'mcp/reviewer-tools/server')
  assert.ok(shown, 'the server has an entry in the review, like every skill file does')
  assert.match(shown.text, /\/usr\/local\/bin\/node/)
  assert.match(shown.text, /"server\.mjs", "--port", "0"/)
  assert.match(shown.text, /NODE_OPTIONS=--max-old-space-size=512/, 'an environment value that changes what runs is shown, not hidden')
  assert.match(shown.text, /GITHUB_TOKEN=/, 'a secret’s name is shown')
  assert.doesNotMatch(shown.text, /placeholder-not-a-token/, 'a secret’s value is not')
  assert.match(shown.text, /e{64}/, 'and the exact identity the approval is bound to')

  assert.match(review.consequence, /Pretty Agent/, 'the runtime is named by its presentation, never its id')
  assert.doesNotMatch(review.consequence, /\bclaude\b/)
  assert.doesNotMatch(review.consequence, /the moment this Seat opens/, 'a server does not start when the Seat opens')
  assert.match(review.consequence, /only when the Seat lists or calls its tools/)
})
