import assert from 'node:assert/strict'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'

import {
  ATTACHMENT_CAPABILITY_VALUE,
  attachmentOptions,
  attachmentReceipt,
  decodeAttachmentInput,
  stageSkills,
  type AttachmentInput,
} from '../src/attachments.js'
import { scratch } from './scratch.js'

/**
 * Phase 12's own second adapter road: the bundled bridge's half of the ACP
 * `_meta.harnessdesk.attachments` extension `adapter-acp` already sends.
 *
 * Most of what follows is pure-function proof: no real Claude Code process
 * runs, because every function under test is the translation between the
 * host's isolated input and the Claude Agent SDK's own options/query
 * surface. The last section is the SDK faked instead — the real bridge
 * binary, spoken to over real ACP, spawning the fixture CLI script this
 * package's other tests already use — proving the wire contract itself:
 * the capability this bridge declares, and that a receipt for something the
 * fake CLI cannot actually make discoverable comes back honestly refused,
 * never invented.
 */

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const WORKDIR = scratch('claude-acp-attachments-')

const makeRuntime = (): AcpRuntime =>
  new AcpRuntime({
    id: 'claude-code',
    name: 'Claude Code',
    command: process.execPath,
    args: [BRIDGE],
    env: {
      CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: scratch('claude-acp-attachments-config-'),
      CLAUDE_ACP_STATE_DIR: scratch('claude-acp-attachments-state-'),
      CLAUDECODE: '',
    },
  })

const skillSource = (text = '---\nname: demo\ndescription: demo skill\n---\nDo the thing.\n'): string => {
  const dir = scratch('claude-acp-skill-')
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
  return dir
}

const input = (over: Partial<AttachmentInput> = {}): AttachmentInput => ({
  key: 'k-1',
  skills: null,
  mcp: null,
  notes: null,
  ...over,
})

test('the declared capability is exactly version 1, all three fields true', () => {
  assert.deepEqual(ATTACHMENT_CAPABILITY_VALUE, { version: 1, skills: true, mcp: true, suppressUnapproved: true })
})

// ------------------------------------------------------------ decode

test('decodeAttachmentInput accepts only the exact host shape', () => {
  assert.equal(decodeAttachmentInput(undefined), null, 'a plain conversation has nothing to decode')
  assert.equal(decodeAttachmentInput({}), null)
  assert.equal(decodeAttachmentInput({ harnessdesk: {} }), null, 'no attachments key at all')
  assert.equal(decodeAttachmentInput({ harnessdesk: { attachments: { version: 2, input: { key: 'k', skills: null, mcp: null, notes: null } } } }), null, 'wrong version')
  assert.equal(decodeAttachmentInput({ harnessdesk: { attachments: { version: 1, input: { key: '', skills: null, mcp: null, notes: null } } } }), null, 'empty key')
  assert.equal(
    decodeAttachmentInput({ harnessdesk: { attachments: { version: 1, input: { key: 'k', skills: [{ name: 'x' }], mcp: null, notes: null } } } }),
    null,
    'a skill entry missing digest/path invalidates the whole thing, never salvaged in part',
  )
  const good = decodeAttachmentInput({
    harnessdesk: {
      attachments: {
        version: 1,
        input: { key: 'k-1', skills: [{ name: 'demo', digest: 'd'.repeat(64), path: '~/demo' }], mcp: null, notes: { digest: 'e'.repeat(64), text: 'hello' } },
      },
    },
  })
  assert.deepEqual(good, {
    key: 'k-1',
    skills: [{ name: 'demo', digest: 'd'.repeat(64), path: '~/demo' }],
    mcp: null,
    notes: { digest: 'e'.repeat(64), text: 'hello' },
  })
})

// ------------------------------------------------------------ staging

test('stageSkills builds one plugin with a minimal manifest and the real bytes, nothing else', () => {
  const source = skillSource()
  const root = scratch('claude-acp-stage-')
  const staged = stageSkills(input({ skills: [{ name: 'demo', digest: 'd'.repeat(64), path: source }] }), root)
  assert.ok(staged.pluginPath)
  assert.deepEqual(staged.staged, [{ name: 'demo', digest: 'd'.repeat(64) }])
  assert.deepEqual(staged.refused, [])
  assert.deepEqual(staged.qualifiedNames, ['harnessdesk:demo'])
  const manifest = JSON.parse(readFileSync(join(staged.pluginPath!, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.deepEqual(manifest, { name: 'harnessdesk' }, 'no hooks, no commands, no mcpServers — a host-generated manifest carries only a name')
  assert.equal(readFileSync(join(staged.pluginPath!, 'skills', 'demo', 'SKILL.md'), 'utf8'), readFileSync(join(source, 'SKILL.md'), 'utf8'))
})

test('a missing source is refused by name; other skills in the same batch still stage', () => {
  const source = skillSource()
  const root = scratch('claude-acp-stage-')
  const staged = stageSkills(
    input({
      skills: [
        { name: 'demo', digest: 'd'.repeat(64), path: source },
        { name: 'ghost', digest: 'e'.repeat(64), path: join(root, 'never-existed') },
      ],
    }),
    root,
  )
  assert.deepEqual(staged.staged, [{ name: 'demo', digest: 'd'.repeat(64) }])
  assert.equal(staged.refused.length, 1)
  assert.equal(staged.refused[0]?.name, 'ghost')
})

test('an empty or absent skill list stages nothing and creates no plugin directory', () => {
  const root = scratch('claude-acp-stage-')
  const none = stageSkills(input({ skills: null }), root)
  assert.equal(none.pluginPath, null)
  assert.deepEqual(none.qualifiedNames, [])
  const empty = stageSkills(input({ skills: [] }), root)
  assert.equal(empty.pluginPath, null)
})

test('a symlink anywhere in the approved bundle is refused, never staged as whatever it currently resolves to', () => {
  const real = skillSource()
  const outside = scratch('claude-acp-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'not part of any approved bundle', 'utf8')
  const linked = join(real, 'linked.txt')
  symlinkSync(join(outside, 'secret.txt'), linked)
  const root = scratch('claude-acp-stage-')
  const staged = stageSkills(input({ skills: [{ name: 'demo', digest: 'd'.repeat(64), path: real }] }), root)
  assert.equal(staged.staged.length, 0, 'a bundle containing any symlink is refused whole, not stripped of just that entry')
  assert.equal(staged.refused.length, 1)
  assert.match(staged.refused[0]?.reason ?? '', /symlink/)
})

test('stageSkills resolves a shortPath ~ prefix back to the real home directory', () => {
  const root = scratch('claude-acp-stage-')
  // A path this bridge cannot resolve at all must still be refused by name,
  // not thrown past the caller — proves resolveHome runs before the copy,
  // not that any particular home directory layout exists on this machine.
  const staged = stageSkills(input({ skills: [{ name: 'demo', digest: 'd'.repeat(64), path: '~/__hd_test_never_exists__' }] }), root)
  assert.equal(staged.staged.length, 0)
  assert.equal(staged.refused[0]?.name, 'demo')
})

// ------------------------------------------------------------ options

test('no input at all changes nothing — the plain path stays plain', () => {
  assert.equal(attachmentOptions(null, scratch('claude-acp-opts-')), null)
})

test('an explicit skill list produces settingSources: [], strictMcpConfig: true, and the exact qualified names', () => {
  const source = skillSource()
  const result = attachmentOptions(input({ skills: [{ name: 'demo', digest: 'd'.repeat(64), path: source }] }), scratch('claude-acp-opts-'))
  assert.ok(result)
  assert.deepEqual(result.options['settingSources'], [])
  assert.equal(result.options['strictMcpConfig'], true)
  assert.deepEqual(result.options['skills'], ['harnessdesk:demo'])
  assert.deepEqual(result.options['plugins'], [{ type: 'local', path: result.staged.pluginPath, skipMcpDiscovery: true }])
})

test('strictMcpConfig and settingSources apply even when only mcp (not skills) was declared', () => {
  const result = attachmentOptions(input({ mcp: [{ name: 'reviewer-tools', digest: 'd'.repeat(64), endpoint: 'e' }] }), scratch('claude-acp-opts-'))
  assert.ok(result)
  assert.equal(result.options['strictMcpConfig'], true)
  assert.deepEqual(result.options['settingSources'], [])
  assert.equal(result.options['plugins'], undefined, 'no skills approved: no plugin is fabricated just to carry the MCP restriction')
})

test('notes are folded in as a labeled append, never bare system-instruction text', () => {
  const withNotes = attachmentOptions(input({ notes: { digest: 'd'.repeat(64), text: 'Prefer small diffs.' } }), scratch('claude-acp-opts-'))
  assert.equal(withNotes?.notesAppend, 'Agent notes:\nPrefer small diffs.')
  const blank = attachmentOptions(input({ notes: { digest: 'd'.repeat(64), text: '   ' } }), scratch('claude-acp-opts-'))
  assert.equal(blank?.notesAppend, null, 'whitespace-only notes append nothing')
})

// ------------------------------------------------------------ receipt

test('a skill Claude Code actually reports is loaded; one it does not is refused honestly, never assumed from staging alone', async () => {
  const source = skillSource()
  const root = scratch('claude-acp-stage-')
  const staged = stageSkills(input({ skills: [{ name: 'demo', digest: 'd'.repeat(64), path: source }, { name: 'silent', digest: 'e'.repeat(64), path: skillSource() }] }), root)
  const receipt = await attachmentReceipt(
    input({ key: 'k-1', skills: staged.staged.map((s) => ({ name: s.name, digest: s.digest, path: '' })) }),
    staged,
    {
      supportedCommands: async () => [{ name: 'harnessdesk:demo' }],
      mcpServerStatus: async () => [],
    },
  )
  assert.deepEqual(receipt.loaded, [{ kind: 'skill', name: 'demo', digest: 'd'.repeat(64) }])
  assert.deepEqual(receipt.refused, [{ kind: 'skill', name: 'silent', reason: 'Claude Code did not report this skill as loaded.' }])
})

test('an mcp entry is loaded only when the desk gateway itself reports connected', async () => {
  const staged = { pluginPath: null, qualifiedNames: [], staged: [], refused: [] }
  const approved = input({ mcp: [{ name: 'reviewer-tools', digest: 'd'.repeat(64), endpoint: 'e' }] })

  const connected = await attachmentReceipt(approved, staged, {
    supportedCommands: async () => [],
    mcpServerStatus: async () => [{ name: 'harnessdesk', status: 'connected' }],
  })
  assert.deepEqual(connected.loaded, [{ kind: 'mcp', name: 'reviewer-tools', digest: 'd'.repeat(64) }])

  const failed = await attachmentReceipt(approved, staged, {
    supportedCommands: async () => [],
    mcpServerStatus: async () => [{ name: 'harnessdesk', status: 'failed' }],
  })
  assert.equal(failed.loaded.length, 0)
  assert.match(failed.refused[0]?.reason ?? '', /failed/)

  const missing = await attachmentReceipt(approved, staged, {
    supportedCommands: async () => [],
    mcpServerStatus: async () => [],
  })
  assert.equal(missing.loaded.length, 0)
  assert.match(missing.refused[0]?.reason ?? '', /did not connect/)
})

test('a refused staging failure is carried through to the receipt, never silently dropped', async () => {
  const staged = { pluginPath: null, qualifiedNames: [], staged: [], refused: [{ name: 'ghost', reason: 'ghost is neither a file nor a directory.' }] }
  const receipt = await attachmentReceipt(input({ key: 'k-1' }), staged, {
    supportedCommands: async () => [],
    mcpServerStatus: async () => [],
  })
  assert.deepEqual(receipt.refused, [{ kind: 'skill', name: 'ghost', reason: 'ghost is neither a file nor a directory.' }])
})

test('a query that cannot be asked is not treated as one that answered success', async () => {
  const source = skillSource()
  const staged = stageSkills(input({ skills: [{ name: 'demo', digest: 'd'.repeat(64), path: source }] }), scratch('claude-acp-stage-'))
  const receipt = await attachmentReceipt(input({ skills: [{ name: 'demo', digest: 'd'.repeat(64), path: '' }] }), staged, {
    supportedCommands: async () => {
      throw new Error('the query is not live')
    },
    mcpServerStatus: async () => [],
  })
  assert.deepEqual(receipt.loaded, [])
  assert.equal(receipt.refused[0]?.name, 'demo')
})

test('folded-in notes are reported loaded once actually applied — never claimed before that', async () => {
  const staged = { pluginPath: null, qualifiedNames: [], staged: [], refused: [] }
  const receipt = await attachmentReceipt(input({ notes: { digest: 'd'.repeat(64), text: 'hi' } }), staged, {
    supportedCommands: async () => [],
    mcpServerStatus: async () => [],
  })
  assert.deepEqual(receipt.loaded, [{ kind: 'notes', name: 'notes', digest: 'd'.repeat(64) }])
})

// ------------------------------------------------------------ real bridge, SDK faked

test('the bridge declares the attachments capability honestly, and a plain session asks for no receipt', async () => {
  const runtime = makeRuntime()
  await runtime.start()
  try {
    assert.equal(runtime.info.attachments?.skills, 'scoped')
    assert.equal(runtime.info.attachments?.mcp, 'scoped-gated')
    assert.equal(runtime.info.attachments?.suppressUnapproved, true)
    const session = await runtime.createSession({ cwd: WORKDIR })
    // The host's own adapter refuses locally, before ever asking the peer —
    // a plain session was never given a prepared key to ask about.
    await assert.rejects(runtime.attachmentReceipt(session.id), /never given attachments/)
  } finally {
    await runtime.dispose()
  }
})

test('a real session over the real bridge gets an honest receipt — never a fabricated success', async () => {
  const runtime = makeRuntime()
  await runtime.start()
  try {
    const source = skillSource()
    const session = await runtime.createSession({
      cwd: WORKDIR,
      attachments: { key: 'k-e2e-1', skills: [{ name: 'demo', digest: 'd'.repeat(64), path: source }], mcp: null, notes: null },
    })
    const receipt = await runtime.attachmentReceipt(session.id)
    assert.equal(receipt.key, 'k-e2e-1')
    // The fixture CLI has no notion of skills or plugins at all — it never
    // claims to have loaded one, so a truthful bridge must not either. This
    // is the one guarantee that matters most: staging succeeding is not the
    // same as Claude Code actually reporting the skill loaded.
    assert.deepEqual(receipt.loaded, [])
    assert.equal(receipt.refused[0]?.name, 'demo')
    assert.match(receipt.refused[0]?.reason ?? '', /did not report/)
  } finally {
    await runtime.dispose()
  }
})
