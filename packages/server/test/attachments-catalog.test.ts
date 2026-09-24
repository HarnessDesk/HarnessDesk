import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AgentEntry } from '@harnessdesk/protocol'

import { mcpIdentityDigest, resolveAttachmentDeclarations, resolveAttachments } from '../src/attachments/catalog.js'
import { tempDir } from './scratch.js'

/**
 * The bounded, no-follow bundle reader and the Library fallback it revalidates
 * before ever hashing a byte. Every test here is read-only discovery: none of
 * them may start a process or reach the network, which is exactly the
 * property `preview cannot launch` (`attachments-trust.test.ts`) also proves
 * from the trust side.
 */

const scout = (overrides: Partial<AgentEntry> & { readonly skills?: readonly string[]; readonly mcp?: readonly string[] }): AgentEntry => ({
  id: overrides.id ?? 'scout',
  origin: overrides.origin ?? 'project',
  path: overrides.path ?? '/nonexistent/.harnessdesk/agents/scout/AGENT.md',
  digest: 'irrelevant-here',
  shadows: [],
  problems: [],
  definition: {
    id: overrides.id ?? 'scout',
    name: 'Scout',
    description: null,
    ceiling: 'read',
    ceilingFrom: 'none',
    answers: [],
    produces: [],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    prefer: [],
    brief: 'Look around.',
  },
})

/** A project with `.harnessdesk/agents/<id>/skills/<name>/` ready to fill in. */
const projectWithAgent = async (prefix: string, id: string): Promise<{ readonly root: string; readonly agentDir: string }> => {
  const root = tempDir(prefix)
  const agentDir = join(root, '.harnessdesk', 'agents', id)
  await mkdir(agentDir, { recursive: true })
  return { root, agentDir }
}

test('hashes the whole skill bundle', async () => {
  const { root, agentDir } = await projectWithAgent('hd-attach-hash-', 'scout')
  const bundle = join(agentDir, 'skills', 'demo')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), '---\nname: demo\n---\nDo the thing.\n')
  await writeFile(join(bundle, 'run.sh'), '#!/bin/sh\necho one\n')

  const entry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), skills: ['demo'] })
  const first = await resolveAttachments(entry, root)
  assert.equal(first.length, 1)
  const before = first[0]!.identity.digest

  // SKILL.md itself never changes; only the script beside it does.
  await writeFile(join(bundle, 'run.sh'), '#!/bin/sh\necho two\n')
  const second = await resolveAttachments(entry, root)
  const after = second[0]!.identity.digest

  assert.notEqual(before, after, 'a script change must change the whole bundle identity, not just SKILL.md')
  assert.equal(second[0]!.files.length, 2)
})

test('refuses links and boundary escapes', async (t) => {
  const { root, agentDir } = await projectWithAgent('hd-attach-links-', 'scout')
  const bundle = join(agentDir, 'skills', 'demo')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), '---\nname: demo\n---\nDo the thing.\n')

  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'OUTSIDE SECRET')

  const entry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), skills: ['demo'] })

  // A whole bundle root that is itself a link is refused before anything under it is read.
  {
    const linkedBundleParent = join(agentDir, 'skills')
    const linkedName = 'linked'
    await symlink(outside, join(linkedBundleParent, linkedName))
    const linkedEntry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), skills: [linkedName] })
    const resolved = await resolveAttachments(linkedEntry, root)
    assert.equal(resolved.length, 0)
  }

  // A folded-case `.GIT` inside a bundle is excluded, not fatal — it never contributes bytes or a refusal.
  await mkdir(join(bundle, '.GIT'))
  await writeFile(join(bundle, '.GIT', 'config'), 'not part of the bundle')
  const clean = await resolveAttachments(entry, root)
  assert.equal(clean.length, 1)
  assert.ok(!clean[0]!.files.some((file) => file.path.toLowerCase().includes('.git')))

  // A *nested directory* swapped for a link right after its own before/after
  // checks pass, but before its first child is ever named, must still be
  // refused — the exact gap `NOFOLLOW_ANY` closes and plain `O_NOFOLLOW`
  // cannot: `sub`'s child `note.txt` is examined for the first time only
  // after the swap, so there is no earlier classification for it to mismatch
  // against by identity, and only refusing the *open itself* at any path
  // component — not just the last one — catches it. This is the identical
  // race `agent-files.test.ts` proves against `copyAgentFolder`, replayed
  // here against `readBundle`.
  const sub = join(bundle, 'sub')
  await mkdir(sub)
  await writeFile(join(sub, 'note.txt'), 'inside, safe')
  const outside2 = join(root, 'outside2')
  await mkdir(outside2)
  await writeFile(join(outside2, 'note.txt'), 'OUTSIDE SECRET 2')
  // The resolver realpaths the Agent's own folder before joining
  // `skills/<name>` onto it, so the patched path must be built the same way:
  // on a machine where the temp root itself sits behind a link (macOS's
  // `/var` -> `/private/var`), the raw `sub` string above is not the one
  // `readBundle` actually calls `lstat` with.
  const realSub = join(await realpath(bundle), 'sub')
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { lstat: (...args: unknown[]) => Promise<unknown> }
  const realLstat = fsp.lstat
  let calls = 0
  fsp.lstat = async (...args: unknown[]) => {
    const result = await realLstat(...args)
    if (String(args[0]) === realSub) {
      calls += 1
      // Call 1: the parent's own classification of `sub`. Call 2: `sub`'s own
      // "before" check. Call 3: `sub`'s own "after" check, run right after its
      // `readdir` and right before the loop over its children starts. The
      // swap lands strictly after that third, legitimate check succeeds.
      if (calls === 3) {
        await rm(sub, { recursive: true, force: true })
        await symlink(outside2, sub)
      }
    }
    return result
  }
  syncBuiltinESMExports()
  t.after(() => {
    fsp.lstat = realLstat
    syncBuiltinESMExports()
  })

  const raced = await resolveAttachments(entry, root)
  assert.equal(raced.length, 0, 'the whole bundle refuses once an ancestor inside it was swapped for a link mid-walk')
  assert.equal(calls, 3, 'the swap this test depends on actually fired, exactly once')
  assert.equal(await readFile(join(outside2, 'note.txt'), 'utf8'), 'OUTSIDE SECRET 2', 'the outside file was never touched')
  assert.deepEqual((await readdir(outside2)).sort(), ['note.txt'], 'the outside folder itself gained nothing from the refused read')
})

test('bounds before materializing', async () => {
  const { root, agentDir } = await projectWithAgent('hd-attach-bounds-', 'scout')

  // An oversized file, first alphabetically, refuses the whole attachment.
  {
    const bundle = join(agentDir, 'skills', 'big')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(bundle, 'SKILL.md'), '---\nname: big\n---\nBig.\n')
    await writeFile(join(bundle, 'a-large-file.txt'), 'x'.repeat(256 * 1024 + 1))
    const entry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), skills: ['big'] })
    const { declarations, resolved } = await resolveAttachmentDeclarations(entry, root)
    assert.equal(resolved.length, 0)
    assert.equal(declarations.length, 1)
    assert.equal(declarations[0]!.identity, null)
    assert.match(declarations[0]!.problem ?? '', /larger than/)
  }

  // 129 entries refuses the whole attachment too — never the first 128, accepted partially.
  {
    const bundle = join(agentDir, 'skills', 'flood')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(bundle, 'SKILL.md'), '---\nname: flood\n---\nFlood.\n')
    for (let index = 0; index < 128; index += 1) {
      await writeFile(join(bundle, `f${String(index).padStart(4, '0')}.txt`), 'x')
    }
    const entry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), skills: ['flood'] })
    const { declarations, resolved } = await resolveAttachmentDeclarations(entry, root)
    assert.equal(resolved.length, 0, 'the 129th entry (SKILL.md plus 128 files) must refuse the whole bundle')
    assert.equal(declarations.length, 1)
    assert.equal(declarations[0]!.identity, null)
    assert.match(declarations[0]!.problem ?? '', /more than 128 entries/)
  }
})

test('ambiguous Library copy is not chosen', async () => {
  const { root, agentDir } = await projectWithAgent('hd-attach-ambiguous-', 'scout')
  // No Agent-local `skills/shared-thing` at all — this name must fall through to the Library.
  const home = tempDir('hd-attach-ambiguous-home-')

  const projectCopy = join(root, '.agents', 'skills', 'shared-thing')
  await mkdir(projectCopy, { recursive: true })
  await writeFile(join(projectCopy, 'SKILL.md'), '---\nname: shared-thing\n---\nProject version.\n')

  const homeCopy = join(home, '.agents', 'skills', 'shared-thing')
  await mkdir(homeCopy, { recursive: true })
  await writeFile(join(homeCopy, 'SKILL.md'), '---\nname: shared-thing\n---\nHome version — deliberately different text.\n')

  const entry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), skills: ['shared-thing'] })
  const { declarations, resolved } = await resolveAttachmentDeclarations(entry, root, [], home)

  assert.equal(resolved.length, 0, 'an ambiguous name must load nothing, never pick a copy by scan order')
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0]!.identity, null)
  assert.match(declarations[0]!.problem ?? '', /differing copies/)

  // Once the ambiguity is gone, the one remaining copy must actually resolve
  // — proving the Library fallback works at all, not only that it correctly
  // refuses. (This exact path once failed with a spurious "was replaced" on
  // any machine where a legitimate ancestor is itself a link, such as the temp
  // root used above: `libraryCopy` must canonicalize that ancestor before
  // `readBundle` ever opens anything under it.)
  await rm(projectCopy, { recursive: true, force: true })
  const solo = await resolveAttachmentDeclarations(entry, root, [], home)
  assert.equal(solo.resolved.length, 1)
  assert.equal(solo.declarations[0]!.problem, null)
  assert.equal(solo.declarations[0]!.identity?.source, 'library')
})

/**
 * The digest `adapter-acp/test/attachments.test.ts` pins as a real Library
 * MCP identity: SHA-256 over `canonicalMcp` of this exact spec. Pinned here,
 * against the catalog's own function, so the two tests cannot drift apart —
 * the adapter package has no dependency that could compute it itself.
 */
export const PINNED_MCP_SPEC = { name: 'reviewer-tools', transport: 'stdio', command: 'node', args: ['server.mjs'] } as const
export const PINNED_MCP_DIGEST = 'f0dc54b9c1cc6b3f5258181220f07a45af1ab746d32d63338a8c4cee47cdf40d'

test('an MCP server’s identity is a full SHA-256 over its canonical spec, from the one read that also yields the spec', async () => {
  const { root, agentDir } = await projectWithAgent('hd-attach-mcp-id-', 'scout')
  const home = tempDir('hd-attach-mcp-id-home-')
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'reviewer-tools': { command: 'node', args: ['server.mjs'] } } }),
  )
  const entry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), mcp: ['reviewer-tools'] })
  const { declarations, resolved } = await resolveAttachmentDeclarations(entry, root, [{ id: 'fake', brand: 'claudecode' } as never], home)

  assert.equal(declarations.length, 1)
  assert.equal(declarations[0]!.problem, null)
  const identity = declarations[0]!.identity!
  assert.match(identity.digest, /^[0-9a-f]{64}$/, 'a trust decision is gated on a full SHA-256, never a 16-hex display digest')
  assert.equal(identity.digest, mcpIdentityDigest(PINNED_MCP_SPEC))
  assert.equal(identity.digest, PINNED_MCP_DIGEST)
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0]!.server?.command, 'node', 'the spec the gateway will run comes from the same read the digest was taken over')
  assert.equal(mcpIdentityDigest(resolved[0]!.server!), identity.digest)

  // One changed argument is a different server, and a different identity.
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'reviewer-tools': { command: 'node', args: ['server.mjs', '--evil'] } } }),
  )
  const changed = await resolveAttachmentDeclarations(entry, root, [{ id: 'fake', brand: 'claudecode' } as never], home)
  assert.notEqual(changed.declarations[0]!.identity?.digest, identity.digest)
})

test('an MCP server whose spec cannot be decoded has no identity to approve', async () => {
  const { root, agentDir } = await projectWithAgent('hd-attach-mcp-undecodable-', 'scout')
  const home = tempDir('hd-attach-mcp-undecodable-home-')
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'reviewer-tools': { note: 'no command and no url' } } }))
  const entry = scout({ id: 'scout', origin: 'project', path: join(agentDir, 'AGENT.md'), mcp: ['reviewer-tools'] })
  // The scanner lists the server by name, but nothing here can say what would run: no identity, so nothing to approve.
  const { declarations, resolved } = await resolveAttachmentDeclarations(entry, root, [{ id: 'fake', brand: 'claudecode' } as never], home)
  assert.equal(resolved.length, 0)
  assert.equal(declarations[0]!.identity, null)
  assert.match(declarations[0]!.problem ?? '', /cannot be read as a server/)
})
