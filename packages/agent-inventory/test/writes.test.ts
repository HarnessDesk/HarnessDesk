import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, type LibraryPlannedOp } from '@harnessdesk/protocol'

import { digestOf } from '../src/digest.js'
import {
  applyLibrary,
  bundleDigest,
  decodeMcpEntry,
  planLibrary,
  unifiedDiff,
  type WriteAgent,
} from '../src/index.js'
import { activeLockCountForTest, isSafeSkillRelativePath, MAX_BUNDLE_FILES } from '../src/writes.js'

/**
 * The write path.
 *
 * The property under test throughout: **what was previewed is what happens,
 * or nothing does.** Every plan is made against a temporary home, every
 * apply re-checks that home, and the interesting cases are the ones where
 * the world moved between the two — or where the plan was never honest to
 * begin with and the apply half refuses it anyway, because the ops cross a
 * socket in production and the socket is not trusted.
 */

const agent = (brand: string): WriteAgent => ({ id: runtimeId(brand), brand })

const skill = async (root: string, name: string, body: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), body)
}

const BODY = '---\nname: commit\ndescription: Commits things\n---\nDo the commit.\n'
const EDITED = '---\nname: commit\ndescription: Commits things\n---\nDo it differently.\n'

const withHome = async (fn: (home: string, libraryDir: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'hd-writes-'))
  try {
    await fn(home, join(home, '.harnessdesk/library'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('install: plan previews a creation, apply performs exactly it', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    const agents = [agent('codex'), agent('claudecode')]
    const plan = await planLibrary(
      agents,
      [
        {
          kind: 'installSkill',
          name: 'commit',
          sourcePath: join(home, '.codex/skills/commit'),
          targetRuntime: runtimeId('claudecode'),
        },
      ],
      { libraryDir, home },
    )
    assert.equal(plan.ops.length, 1)
    const op = plan.ops[0]!
    assert.equal(op.action, 'create')
    assert.equal(op.targetPath, join(home, '.claude/skills/commit'))
    assert.equal(op.guardDigest, null)
    assert.ok(op.preview?.includes('+Do the commit.'), 'the diff shows the body arriving')

    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.deepEqual(results.map((one) => one.outcome), ['done'])
    const written = await readFile(join(home, '.claude/skills/commit/SKILL.md'), 'utf8')
    assert.equal(written, BODY)

    // Planned again, the same intent has nothing to do — and says so.
    const again = await planLibrary(agents, [
      {
        kind: 'installSkill',
        name: 'commit',
        sourcePath: join(home, '.codex/skills/commit'),
        targetRuntime: runtimeId('claudecode'),
      },
    ], { libraryDir, home })
    assert.equal(again.ops[0]?.action, 'skip')
    assert.match(again.ops[0]?.reason ?? '', /identical/i)
  })
})

test('install carries a bundle’s extra files, not just the definition', async () => {
  await withHome(async (home, libraryDir) => {
    const source = join(home, '.codex/skills/commit')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await mkdir(join(source, 'scripts'), { recursive: true })
    await writeFile(join(source, 'scripts/run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 })

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath: source, targetRuntime: runtimeId('claudecode') },
    ], { libraryDir, home })
    assert.deepEqual(plan.ops[0]?.extraFiles, ['scripts/run.sh'])

    await applyLibrary(plan.ops, { libraryDir, home })
    const copied = await readFile(join(home, '.claude/skills/commit/scripts/run.sh'), 'utf8')
    assert.match(copied, /echo ok/)
    assert.equal((await lstat(join(home, '.claude/skills/commit/scripts/run.sh'))).mode & 0o777, 0o755)
  })
})

test('bundle A: an edited installed script is refused, then resolved with a backup', async () => {
  await withHome(async (home, libraryDir) => {
    const source = join(home, '.codex/skills/commit')
    const target = join(home, '.claude/skills/commit')
    const context = { libraryDir, home }
    const agents = [agent('codex'), agent('claudecode')]
    const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath: source, targetRuntime: runtimeId('claudecode') }
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await mkdir(join(source, 'scripts'))
    await writeFile(join(source, 'scripts/run.sh'), 'echo original\n')
    const installed = await applyLibrary((await planLibrary(agents, [intent], context)).ops, context)
    assert.equal(installed[0]?.outcome, 'done')

    await writeFile(join(target, 'scripts/run.sh'), 'echo my edit\n')
    await writeFile(join(source, 'SKILL.md'), EDITED)
    await writeFile(join(source, 'scripts/run.sh'), 'echo updated\n')
    const blocked = await planLibrary(agents, [intent], context)
    assert.equal(blocked.ops[0]?.action, 'refuse')
    assert.match(blocked.ops[0]?.reason ?? '', /edited since/i)
    assert.equal((await applyLibrary(blocked.ops, context))[0]?.outcome, 'skipped')
    assert.equal(await readFile(join(target, 'scripts/run.sh'), 'utf8'), 'echo my edit\n')

    const resolved = await planLibrary(agents, [{ kind: 'syncSkill', name: 'commit', sourcePath: source, targetPaths: [target] }], context)
    assert.equal(resolved.ops[0]?.backup, true)
    const applied = await applyLibrary(resolved.ops, context)
    assert.equal(applied[0]?.outcome, 'done')
    assert.equal(await readFile(join(applied[0]!.backupPath!, 'scripts/run.sh'), 'utf8'), 'echo my edit\n')
    assert.equal(await readFile(join(target, 'scripts/run.sh'), 'utf8'), 'echo updated\n')
  })
})

test('bundle B: changing only a source script plans and applies an update', async () => {
  await withHome(async (home, libraryDir) => {
    const source = join(home, '.codex/skills/commit')
    const target = join(home, '.claude/skills/commit')
    const context = { libraryDir, home }
    const agents = [agent('codex'), agent('claudecode')]
    const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath: source, targetRuntime: runtimeId('claudecode') }
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await mkdir(join(source, 'scripts'))
    await writeFile(join(source, 'scripts/run.sh'), 'echo original\n')
    assert.equal((await applyLibrary((await planLibrary(agents, [intent], context)).ops, context))[0]?.outcome, 'done')

    await writeFile(join(source, 'scripts/run.sh'), 'echo updated\n')
    const update = await planLibrary(agents, [intent], context)
    assert.equal(update.ops[0]?.action, 'update')
    assert.match(update.ops[0]?.reason ?? '', /scripts\/run\.sh/)
    assert.equal(update.ops[0]?.backup, false)
    assert.equal((await applyLibrary(update.ops, context))[0]?.outcome, 'done')
    assert.equal(await readFile(join(target, 'scripts/run.sh'), 'utf8'), 'echo updated\n')
  })
})

test('bundle C: a script changed after preview fails alone without writing or backing up', async () => {
  await withHome(async (home, libraryDir) => {
    const source = join(home, '.codex/skills/commit')
    const target = join(home, '.claude/skills/commit')
    const context = { libraryDir, home }
    const agents = [agent('codex'), agent('claudecode')]
    const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath: source, targetRuntime: runtimeId('claudecode') }
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await mkdir(join(source, 'scripts'))
    await writeFile(join(source, 'scripts/run.sh'), 'echo original\n')
    assert.equal((await applyLibrary((await planLibrary(agents, [intent], context)).ops, context))[0]?.outcome, 'done')
    await writeFile(join(source, 'SKILL.md'), EDITED)
    await writeFile(join(source, 'scripts/run.sh'), 'echo previewed\n')
    const plan = await planLibrary(agents, [intent, { kind: 'authorSkill', name: 'review', content: BODY, targetRuntimes: [runtimeId('claudecode')] }], context)
    await writeFile(join(source, 'scripts/run.sh'), 'echo unseen\n')
    const applied = await applyLibrary(plan.ops, context)
    assert.deepEqual(applied.map((op) => op.outcome), ['failed', 'done'])
    assert.equal(applied[0]?.detail, 'The source changed since the preview — plan again.')
    assert.equal(applied[0]?.backupPath, undefined)
    assert.equal(await readFile(join(target, 'scripts/run.sh'), 'utf8'), 'echo original\n')
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), BODY)
  })
})

test('a copy someone else installed is never overwritten by an install', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    // Already present at the target, different content, no manifest entry.
    await skill(join(home, '.claude/skills'), 'commit', EDITED)

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      {
        kind: 'installSkill',
        name: 'commit',
        sourcePath: join(home, '.codex/skills/commit'),
        targetRuntime: runtimeId('claudecode'),
      },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'refuse')
    assert.match(plan.ops[0]?.reason ?? '', /not written by HarnessDesk/i)

    // And the refusal survives the wire: a crafted op that claims otherwise
    // still fails at apply, because ownership is re-derived there.
    const forged: LibraryPlannedOp = {
      id: 'op-x',
      kind: 'skill',
      name: 'commit',
      action: 'update',
      targetPath: join(home, '.claude/skills/commit'),
      content: BODY,
      guardDigest: null,
      backup: false,
    }
    const results = await applyLibrary([forged], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'failed')
  })
})

test('a copy we wrote may be updated; one the person edited may not', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    const install = await planLibrary([agent('codex'), agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath: join(home, '.codex/skills/commit'), targetRuntime: runtimeId('claudecode') },
    ], { libraryDir, home })
    await applyLibrary(install.ops, { libraryDir, home })

    // The source moves on; ours updates cleanly.
    await writeFile(join(home, '.codex/skills/commit/SKILL.md'), EDITED)
    const update = await planLibrary([agent('codex'), agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath: join(home, '.codex/skills/commit'), targetRuntime: runtimeId('claudecode') },
    ], { libraryDir, home })
    assert.equal(update.ops[0]?.action, 'update')
    const applied = await applyLibrary(update.ops, { libraryDir, home })
    assert.equal(applied[0]?.outcome, 'done')

    // The person edits the installed copy; the next install stands back.
    await writeFile(join(home, '.claude/skills/commit/SKILL.md'), `${EDITED}\nMine now.\n`)
    await writeFile(join(home, '.codex/skills/commit/SKILL.md'), BODY)
    const blocked = await planLibrary([agent('codex'), agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath: join(home, '.codex/skills/commit'), targetRuntime: runtimeId('claudecode') },
    ], { libraryDir, home })
    assert.equal(blocked.ops[0]?.action, 'refuse')
    assert.match(blocked.ops[0]?.reason ?? '', /edited since/i)
  })
})

test('resolve: the winner is copied over the losers, with a backup each', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await skill(join(home, '.claude/skills'), 'commit', EDITED)

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      {
        kind: 'syncSkill',
        name: 'commit',
        sourcePath: join(home, '.codex/skills/commit'),
        targetPaths: [join(home, '.claude/skills/commit')],
      },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'replace')
    assert.equal(plan.ops[0]?.backup, true)

    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')
    assert.ok(results[0]?.backupPath, 'the replaced copy was filed somewhere')
    const kept = await readFile(join(results[0]!.backupPath!, 'SKILL.md'), 'utf8')
    assert.equal(kept, EDITED)
    const now = await readFile(join(home, '.claude/skills/commit/SKILL.md'), 'utf8')
    assert.equal(now, BODY)
  })
})

test('resolve carries the winner’s bundle files, not just its definition', async () => {
  await withHome(async (home, libraryDir) => {
    // The winner is a bundle with a script; the loser is a bundle too.
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await mkdir(join(home, '.codex/skills/commit/scripts'), { recursive: true })
    await writeFile(join(home, '.codex/skills/commit/scripts/run.sh'), 'echo hi')
    await skill(join(home, '.claude/skills'), 'commit', EDITED)
    await writeFile(join(home, '.claude/skills/commit/stale.txt'), 'old')

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      {
        kind: 'syncSkill',
        name: 'commit',
        sourcePath: join(home, '.codex/skills/commit'),
        targetPaths: [join(home, '.claude/skills/commit')],
      },
    ], { libraryDir, home })
    await applyLibrary(plan.ops, { libraryDir, home })

    // The winner's script arrived; the definition is the winner's; and the
    // loser's stray file is gone (the directory was rewritten to match).
    assert.equal(
      await readFile(join(home, '.claude/skills/commit/scripts/run.sh'), 'utf8'),
      'echo hi',
    )
    assert.equal(await readFile(join(home, '.claude/skills/commit/SKILL.md'), 'utf8'), BODY)
    assert.equal(existsSync(join(home, '.claude/skills/commit/stale.txt')), false)
  })
})

test('a target that changed since the preview fails alone; the rest proceed', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await skill(join(home, '.codex/skills'), 'review', BODY.replace(/commit/g, 'review'))

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath: join(home, '.codex/skills/commit'), targetRuntime: runtimeId('claudecode') },
      { kind: 'installSkill', name: 'review', sourcePath: join(home, '.codex/skills/review'), targetRuntime: runtimeId('claudecode') },
    ], { libraryDir, home })

    // Between plan and apply, something else claims the first target.
    await skill(join(home, '.claude/skills'), 'commit', EDITED)

    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.equal(results[0]?.outcome, 'failed')
    assert.match(results[0]?.detail ?? '', /changed since the preview/i)
    assert.equal(results[1]?.outcome, 'done')
    assert.equal(existsSync(join(home, '.claude/skills/review/SKILL.md')), true)
    // The claimed copy is exactly as its claimant left it.
    assert.equal(await readFile(join(home, '.claude/skills/commit/SKILL.md'), 'utf8'), EDITED)
  })
})

test('remove: a hollow directory goes, its stray files filed first', async () => {
  await withHome(async (home, libraryDir) => {
    const hollow = join(home, '.agents/skills/ghost')
    await mkdir(hollow, { recursive: true })
    await writeFile(join(hollow, 'notes.txt'), 'left behind\n')

    const plan = await planLibrary([agent('claudecode')], [
      { kind: 'removeCopy', name: 'ghost', path: hollow },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'remove')
    assert.equal(plan.ops[0]?.backup, true)

    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')
    assert.equal(existsSync(hollow), false)
    const filed = await readFile(join(results[0]!.backupPath!, 'notes.txt'), 'utf8')
    assert.equal(filed, 'left behind\n')
  })
})

test('the agent-shipped directories refuse writes at plan and at apply', async () => {
  await withHome(async (home, libraryDir) => {
    const system = join(home, '.codex/skills/.system/builtin')
    await mkdir(system, { recursive: true })
    await writeFile(join(system, 'SKILL.md'), BODY)

    const plan = await planLibrary([agent('codex')], [
      { kind: 'removeCopy', name: 'builtin', path: system },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'refuse')
    assert.match(plan.ops[0]?.reason ?? '', /shipped by the agent/i)

    const forged: LibraryPlannedOp = {
      id: 'op-x',
      kind: 'skill',
      name: 'builtin',
      action: 'remove',
      targetPath: system,
      guardDigest: null,
      backup: true,
    }
    const results = await applyLibrary([forged], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'failed')
    assert.equal(existsSync(join(system, 'SKILL.md')), true)
  })
})

test('a path outside every known root is refused whatever the plan says', async () => {
  await withHome(async (home, libraryDir) => {
    const forged: LibraryPlannedOp = {
      id: 'op-x',
      kind: 'skill',
      name: 'evil',
      action: 'create',
      targetPath: join(home, 'Documents/evil'),
      content: BODY,
      guardDigest: null,
      backup: false,
    }
    const results = await applyLibrary([forged], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'failed')
    assert.match(results[0]?.detail ?? '', /not in any directory this library manages/i)
    assert.equal(existsSync(join(home, 'Documents')), false)
  })
})

test('a target that escapes a known root through `..` is refused at apply', async () => {
  await withHome(async (home, libraryDir) => {
    // Reads as inside `.claude/skills/`, resolves to `~/Documents`. A raw
    // prefix test would let it through; the guard resolves it first.
    const forged: LibraryPlannedOp = {
      id: 'op-x',
      kind: 'skill',
      name: 'evil',
      action: 'remove',
      targetPath: join(home, '.claude/skills/../../Documents'),
      guardDigest: null,
      backup: true,
    }
    await mkdir(join(home, 'Documents'), { recursive: true })
    await writeFile(join(home, 'Documents/keepme.txt'), 'precious')
    const results = await applyLibrary([forged], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'failed')
    assert.match(results[0]?.detail ?? '', /not in any directory this library manages/i)
    assert.equal(existsSync(join(home, 'Documents/keepme.txt')), true)
  })
})

test('a bundle symlink is never followed out of the skill directory', async () => {
  await withHome(async (home, libraryDir) => {
    // A secret outside the bundle, and a link to it inside.
    await mkdir(join(home, 'secret'), { recursive: true })
    await writeFile(join(home, 'secret/creds'), 'AWS_SECRET')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    const { symlink } = await import('node:fs/promises')
    await symlink(join(home, 'secret/creds'), join(home, '.codex/skills/commit/creds'))

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      {
        kind: 'installSkill',
        name: 'commit',
        sourcePath: join(home, '.codex/skills/commit'),
        targetRuntime: runtimeId('claudecode'),
      },
    ], { libraryDir, home })
    await applyLibrary(plan.ops, { libraryDir, home })
    // The definition crossed; the linked secret did not.
    assert.equal(existsSync(join(home, '.claude/skills/commit/SKILL.md')), true)
    assert.equal(existsSync(join(home, '.claude/skills/commit/creds')), false)
  })
})

test('authoring requires frontmatter and installs to every named agent', async () => {
  await withHome(async (home, libraryDir) => {
    const agents = [agent('codex'), agent('claudecode')]
    const bare = await planLibrary(agents, [
      { kind: 'authorSkill', name: 'notes', content: 'just prose', targetRuntimes: [runtimeId('codex')] },
    ], { libraryDir, home })
    assert.equal(bare.ops[0]?.action, 'refuse')

    const authored = '---\nname: notes\ndescription: Keeps notes\n---\nWrite them down.\n'
    const plan = await planLibrary(agents, [
      {
        kind: 'authorSkill',
        name: 'notes',
        content: authored,
        targetRuntimes: [runtimeId('codex'), runtimeId('claudecode')],
      },
    ], { libraryDir, home })
    assert.deepEqual(plan.ops.map((one) => one.action), ['create', 'create'])
    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.deepEqual(results.map((one) => one.outcome), ['done', 'done'])
    assert.equal(await readFile(join(home, '.codex/skills/notes/SKILL.md'), 'utf8'), authored)
    assert.equal(await readFile(join(home, '.claude/skills/notes/SKILL.md'), 'utf8'), authored)
  })
})

test('authoring accepts CRLF line endings in frontmatter', async () => {
  await withHome(async (home, libraryDir) => {
    const agents = [agent('codex')]
    const crlf = '---\r\nname: notes\r\ndescription: Keeps notes\r\n---\r\nWrite them down.\r\n'
    const plan = await planLibrary(agents, [
      {
        kind: 'authorSkill',
        name: 'notes',
        content: crlf,
        targetRuntimes: [runtimeId('codex')],
      },
    ], { libraryDir, home })
    assert.deepEqual(plan.ops.map((one) => one.action), ['create'])
    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.deepEqual(results.map((one) => one.outcome), ['done'])
    assert.equal(await readFile(join(home, '.codex/skills/notes/SKILL.md'), 'utf8'), crlf)
  })
})

test('a name that is not one path segment never becomes a path', async () => {
  await withHome(async (home, libraryDir) => {
    const plan = await planLibrary([agent('codex')], [
      { kind: 'removeCopy', name: '../escape', path: join(home, '.codex/skills/../escape') },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'refuse')
  })
})

test('mcp: a stdio server crosses from Codex TOML to Claude JSON faithfully', async () => {
  await withHome(async (home, libraryDir) => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      join(home, '.codex/config.toml'),
      [
        'model = "gpt-5.6"',
        '',
        '[mcp_servers.browser]',
        'command = "npx"',
        'args = ["-y", "@browser/mcp"]',
        'env = { DEBUG = "1" }',
        '',
        '[other_table]',
        'key = "untouched"',
        '',
      ].join('\n'),
    )

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      {
        kind: 'installMcp',
        name: 'browser',
        sourcePath: join(home, '.codex/config.toml'),
        targetRuntime: runtimeId('claudecode'),
      },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'create')
    assert.equal(plan.ops[0]?.targetPath, join(home, '.claude.json'))

    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')
    const written = await readFile(join(home, '.claude.json'), 'utf8')
    const spec = decodeMcpEntry(written, 'json', 'mcpServers', 'browser', 'claude')
    assert.deepEqual(spec, {
      name: 'browser',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@browser/mcp'],
      env: { DEBUG: '1' },
    })
  })
})

test('mcp: an SSE server cannot be spelled in Codex TOML, and the cell says why', async () => {
  await withHome(async (home, libraryDir) => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { events: { type: 'sse', url: 'https://x.test/sse' } } }, null, 2),
    )
    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      {
        kind: 'installMcp',
        name: 'events',
        sourcePath: join(home, '.claude.json'),
        targetRuntime: runtimeId('codex'),
      },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'refuse')
    assert.match(plan.ops[0]?.reason ?? '', /SSE/i)
    assert.equal(existsSync(join(home, '.codex/config.toml')), false, 'nothing was written')
  })
})

test('mcp: editing one entry leaves every other key of the file alone', async () => {
  await withHome(async (home, libraryDir) => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify(
        {
          numStartups: 42,
          mcpServers: { keep: { command: 'keep-me' }, gone: { command: 'remove-me' } },
          projects: { '/x': { history: [] } },
        },
        null,
        2,
      ),
    )
    const plan = await planLibrary([agent('claudecode')], [
      { kind: 'removeMcp', name: 'gone', path: join(home, '.claude.json') },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'remove')
    assert.equal(plan.ops[0]?.backup, true)

    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')
    const after = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as Record<string, unknown>
    assert.equal(after['numStartups'], 42)
    assert.deepEqual(after['mcpServers'], { keep: { command: 'keep-me' } })
    assert.deepEqual(after['projects'], { '/x': { history: [] } })
    const filed = await readFile(results[0]!.backupPath!, 'utf8')
    assert.match(filed, /remove-me/)
  })
})

test('mcp: TOML surgery replaces one table and leaves the rest byte-familiar', async () => {
  await withHome(async (home, libraryDir) => {
    await writeFile(
      join(home, '.gemini/settings.json').replace('.gemini/settings.json', '.claude.json'),
      JSON.stringify({ mcpServers: { fetch: { type: 'http', url: 'https://fetch.test/mcp' } } }, null, 2),
    )
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      join(home, '.codex/config.toml'),
      ['model = "gpt-5.6"', '', '[mcp_servers.old]', 'command = "old-server"', ''].join('\n'),
    )

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      { kind: 'installMcp', name: 'fetch', sourcePath: join(home, '.claude.json'), targetRuntime: runtimeId('codex') },
      { kind: 'removeMcp', name: 'old', path: join(home, '.codex/config.toml') },
    ], { libraryDir, home })
    assert.deepEqual(plan.ops.map((one) => one.action), ['create', 'remove'])

    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.deepEqual(results.map((one) => one.outcome), ['done', 'done'])
    const after = await readFile(join(home, '.codex/config.toml'), 'utf8')
    assert.match(after, /^model = "gpt-5\.6"/m, 'unrelated keys survive')
    assert.match(after, /\[mcp_servers\.fetch\]\nurl = "https:\/\/fetch\.test\/mcp"/)
    assert.doesNotMatch(after, /old-server/)
  })
})

test('unified diffs parse the way the renderer expects', () => {
  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { fromLabel: 'x', toLabel: 'x' })
  assert.match(diff, /^--- x\n\+\+\+ x\n@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c$/)
  assert.equal(unifiedDiff('same\n', 'same\n'), '', 'identical content has no diff to show')
})

test('backups accumulate under the library directory, never beside the agents', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await skill(join(home, '.claude/skills'), 'commit', EDITED)
    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      {
        kind: 'syncSkill',
        name: 'commit',
        sourcePath: join(home, '.codex/skills/commit'),
        targetPaths: [join(home, '.claude/skills/commit')],
      },
    ], { libraryDir, home })
    const results = await applyLibrary(plan.ops, { libraryDir, home })
    assert.ok(results[0]?.backupPath?.startsWith(join(libraryDir, 'backups')))
    const kept = await readdir(join(libraryDir, 'backups'))
    assert.equal(kept.length, 1)
  })
})

test('restore: what a remove filed comes back, and the current state is filed in turn', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.claude/skills'), 'commit', BODY)
    const removal = await planLibrary([agent('claudecode')], [
      { kind: 'removeCopy', name: 'commit', path: join(home, '.claude/skills/commit') },
    ], { libraryDir, home })
    const removed = await applyLibrary(removal.ops, { libraryDir, home })
    const backupPath = removed[0]!.backupPath!
    assert.equal(existsSync(join(home, '.claude/skills/commit')), false)

    const restore = await planLibrary([agent('claudecode')], [
      {
        kind: 'restoreCopy',
        name: 'commit',
        backupPath,
        targetPath: join(home, '.claude/skills/commit'),
      },
    ], { libraryDir, home })
    assert.equal(restore.ops[0]?.action, 'create')
    assert.ok(restore.ops[0]?.preview?.includes('+Do the commit.'))
    const results = await applyLibrary(restore.ops, { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')
    assert.equal(await readFile(join(home, '.claude/skills/commit/SKILL.md'), 'utf8'), BODY)

    // Restoring over something replaces it — and files it first.
    await writeFile(join(home, '.claude/skills/commit/SKILL.md'), EDITED)
    const again = await planLibrary([agent('claudecode')], [
      { kind: 'restoreCopy', name: 'commit', backupPath, targetPath: join(home, '.claude/skills/commit') },
    ], { libraryDir, home })
    assert.equal(again.ops[0]?.action, 'replace')
    assert.equal(again.ops[0]?.backup, true)
    const applied = await applyLibrary(again.ops, { libraryDir, home })
    assert.equal(applied[0]?.outcome, 'done')
    assert.ok(applied[0]?.backupPath, 'the replaced state was filed')
    assert.equal(await readFile(join(home, '.claude/skills/commit/SKILL.md'), 'utf8'), BODY)
  })
})

test('restore: a removed MCP declaration returns to its file', async () => {
  await withHome(async (home, libraryDir) => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ keep: 1, mcpServers: { fetcher: { command: 'npx', args: ['-y', 'fetch'] } } }, null, 2),
    )
    const removal = await planLibrary([agent('claudecode')], [
      { kind: 'removeMcp', name: 'fetcher', path: join(home, '.claude.json') },
    ], { libraryDir, home })
    const removed = await applyLibrary(removal.ops, { libraryDir, home })
    const backupPath = removed[0]!.backupPath!

    const restore = await planLibrary([agent('claudecode')], [
      { kind: 'restoreCopy', name: 'fetcher', backupPath, targetPath: join(home, '.claude.json') },
    ], { libraryDir, home })
    assert.equal(restore.ops[0]?.action, 'create')
    assert.equal(restore.ops[0]?.kind, 'mcp')
    const results = await applyLibrary(restore.ops, { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')
    const after = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(after['mcpServers'], { fetcher: { command: 'npx', args: ['-y', 'fetch'] } })
    assert.equal(after['keep'], 1)
  })
})

test('restore refuses to read from anywhere but the library’s own backups', async () => {
  await withHome(async (home, libraryDir) => {
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    const plan = await planLibrary([agent('claudecode')], [
      {
        kind: 'restoreCopy',
        name: 'commit',
        backupPath: join(home, '.codex/skills/commit'),
        targetPath: join(home, '.claude/skills/commit'),
      },
    ], { libraryDir, home })
    assert.equal(plan.ops[0]?.action, 'refuse')
    assert.match(plan.ops[0]?.reason ?? '', /own backups/i)
  })
})

test('an op whose source escapes every known directory fails at apply', async () => {
  await withHome(async (home, libraryDir) => {
    await mkdir(join(home, 'secrets'), { recursive: true })
    await writeFile(join(home, 'secrets/key.pem'), 'PRIVATE')
    const forged: LibraryPlannedOp = {
      id: 'op-x',
      kind: 'skill',
      name: 'exfil',
      action: 'create',
      targetPath: join(home, '.claude/skills/exfil'),
      content: BODY,
      sourcePath: join(home, 'secrets'),
      extraFiles: ['key.pem'],
      guardDigest: null,
      backup: false,
    }
    const results = await applyLibrary([forged], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'failed')
    assert.match(results[0]?.detail ?? '', /source is not in any directory/i)
    assert.equal(existsSync(join(home, '.claude/skills/exfil')), false)
  })
})

test('concurrent MCP apply operations preserve all declarations (#449)', async () => {
  await withHome(async (home, libraryDir) => {
    const target = join(home, '.codex/config.toml')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(target, '')

    const mk = (i: number): LibraryPlannedOp => ({
      id: `op-${i}`,
      kind: 'mcp',
      name: `srv${i}`,
      action: 'create',
      targetPath: target,
      guardDigest: null,
      backup: false,
      content: JSON.stringify({ name: `srv${i}`, transport: 'stdio', command: 'npx' }),
    })

    const count = 20
    const ops = Array.from({ length: count }, (_, i) => mk(i + 1))
    const results = await Promise.all(ops.map((op) => applyLibrary([op], { libraryDir, home })))
    for (const res of results) {
      assert.equal(res[0]?.outcome, 'done', `all operations must succeed: ${res[0]?.detail}`)
    }

    const text = await readFile(target, 'utf8')
    const matches = (text.match(/\[mcp_servers\./g) ?? []).length
    assert.equal(matches, count, `all ${count} MCP servers must be declared, got ${matches}`)
    assert.equal(activeLockCountForTest(), 0, 'all idle targetLocks entries must be pruned')
  })
})

test('concurrent MCP apply operations preserve all declarations in JSON configs (#449)', async () => {
  await withHome(async (home, libraryDir) => {
    const target = join(home, '.claude.json')
    await writeFile(target, JSON.stringify({ mcpServers: {} }, null, 2))

    const mk = (i: number): LibraryPlannedOp => ({
      id: `op-json-${i}`,
      kind: 'mcp',
      name: `srv${i}`,
      action: 'create',
      targetPath: target,
      guardDigest: null,
      backup: false,
      content: JSON.stringify({ name: `srv${i}`, transport: 'stdio', command: 'npx' }),
    })

    const count = 20
    const ops = Array.from({ length: count }, (_, i) => mk(i + 1))
    const results = await Promise.all(ops.map((op) => applyLibrary([op], { libraryDir, home })))
    for (const res of results) {
      assert.equal(res[0]?.outcome, 'done', `all operations must succeed: ${res[0]?.detail}`)
    }

    const text = await readFile(target, 'utf8')
    const parsed = JSON.parse(text) as { mcpServers: Record<string, unknown> }
    assert.equal(Object.keys(parsed.mcpServers).length, count, `all ${count} MCP servers must be declared`)
    assert.equal(activeLockCountForTest(), 0, 'all idle targetLocks entries must be pruned')
  })
})

test('manifest save does not follow preexisting temp symlink and overwrite outside files (#453)', async () => {
  await withHome(async (home, libraryDir) => {
    await mkdir(libraryDir, { recursive: true })
    const manifestPath = join(libraryDir, 'manifest.json')
    const outside = join(home, 'outside.txt')
    await writeFile(outside, 'outside-before')
    await symlink(outside, `${manifestPath}.tmp`)

    const op: LibraryPlannedOp = {
      id: 'op-1',
      kind: 'skill',
      name: 'demo',
      action: 'create',
      targetPath: join(home, '.claude/skills/demo'),
      guardDigest: null,
      guardBundle: null,
      backup: false,
      content: '---\nname: demo\n---\ntext\n',
    }

    const results = await applyLibrary([op], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')

    const outsideContent = await readFile(outside, 'utf8')
    assert.equal(outsideContent, 'outside-before', 'manifest save must not overwrite symlink target')

    const stat = await lstat(manifestPath)
    assert.equal(stat.isSymbolicLink(), false, 'manifest.json must not be promoted from symlink')
  })
})

test('symlinked source skill bundle pointing outside managed roots is refused (#448)', async () => {
  await withHome(async (home, libraryDir) => {
    const outside = join(home, 'outside-source')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), '---\nname: leak\n---\noutside\n')
    await writeFile(join(outside, 'secret.txt'), 'outside-file')

    const codexSkills = join(home, '.codex/skills')
    await mkdir(codexSkills, { recursive: true })
    const symlinkPath = join(codexSkills, 'leak')
    await symlink(outside, symlinkPath)

    const plan = await planLibrary(
      [agent('codex'), agent('claudecode')],
      [
        {
          kind: 'installSkill',
          name: 'leak',
          sourcePath: symlinkPath,
          targetRuntime: runtimeId('claudecode'),
        },
      ],
      { libraryDir, home },
    )

    assert.equal(plan.ops[0]?.action, 'refuse', 'intent should be refused')
    assert.match(plan.ops[0]?.reason ?? '', /The source is not in any directory this library reads/i)

    // And if an op carrying this sourcePath reached applyLibrary anyway, it must fail
    const forged: LibraryPlannedOp = {
      id: 'op-1',
      kind: 'skill',
      name: 'leak',
      action: 'create',
      targetPath: join(home, '.claude/skills/leak'),
      guardDigest: null,
      backup: false,
      content: '---\nname: leak\n---\noutside\n',
      extraFiles: ['secret.txt'],
      sourcePath: symlinkPath,
    }
    const results = await applyLibrary([forged], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'failed')
    assert.match(results[0]?.detail ?? '', /The source is not in any directory this library reads/i)
    assert.equal(existsSync(join(home, '.claude/skills/leak/secret.txt')), false)
  })
})

test('manifest loader ignores entries with invalid kind or name (#451)', async () => {
  await withHome(async (home, libraryDir) => {
    const target = join(home, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    const foreign = '---\nname: demo\n---\nforeign\n'
    await writeFile(join(target, 'SKILL.md'), foreign)

    const source = join(home, '.codex/skills/source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '---\nname: demo\n---\nreplacement\n')

    await mkdir(libraryDir, { recursive: true })
    await writeFile(
      join(libraryDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { kind: 'broken-kind', name: 'demo', path: target, digest: digestOf(foreign), at: 0 },
          { kind: 'skill', name: 123, path: target, digest: digestOf(foreign), at: 0 },
        ],
      }),
    )

    const plan = await planLibrary(
      [agent('codex'), agent('claudecode')],
      [{ kind: 'installSkill', name: 'demo', sourcePath: source, targetRuntime: runtimeId('claudecode') }],
      { libraryDir, home },
    )
    assert.equal(plan.ops[0]?.action, 'refuse', 'foreign copy must not be treated as owned when kind is invalid')
    assert.match(plan.ops[0]?.reason ?? '', /not written by HarnessDesk/i)
  })
})

test('isSafeSkillRelativePath refuses Windows backslash, absolute, drive, UNC, and traversal paths (#458)', () => {
  // Safe relative paths
  assert.equal(isSafeSkillRelativePath('file.txt'), true)
  assert.equal(isSafeSkillRelativePath('scripts/run.sh'), true)
  assert.equal(isSafeSkillRelativePath('scripts/nested/deep.txt'), true)
  assert.equal(isSafeSkillRelativePath('scripts\\run.sh'), true)

  // Traversal with forward and backward slashes
  assert.equal(isSafeSkillRelativePath('..'), false)
  assert.equal(isSafeSkillRelativePath('../secret.txt'), false)
  assert.equal(isSafeSkillRelativePath('..\\secret.txt'), false)
  assert.equal(isSafeSkillRelativePath('sub/../../secret.txt'), false)
  assert.equal(isSafeSkillRelativePath('sub\\..\\..\\secret.txt'), false)
  assert.equal(isSafeSkillRelativePath('sub/..\\secret.txt'), false)

  // Empty segments and root prefixes
  assert.equal(isSafeSkillRelativePath(''), false)
  assert.equal(isSafeSkillRelativePath('/file.txt'), false)
  assert.equal(isSafeSkillRelativePath('\\file.txt'), false)
  assert.equal(isSafeSkillRelativePath('sub//file.txt'), false)
  assert.equal(isSafeSkillRelativePath('sub\\\\file.txt'), false)

  // Absolute / drive paths
  assert.equal(isSafeSkillRelativePath('C:\\secret.txt'), false)
  assert.equal(isSafeSkillRelativePath('c:/secret.txt'), false)
  assert.equal(isSafeSkillRelativePath('D:\\sub\\file.txt'), false)

  // UNC forms
  assert.equal(isSafeSkillRelativePath('\\\\server\\share\\secret.txt'), false)
  assert.equal(isSafeSkillRelativePath('//server/share/secret.txt'), false)
})

test('isSafeSkillRelativePath refuses a "." segment and a NUL byte, on either separator', () => {
  // A `.` segment was previously let through — harmless to `path.join`, but
  // a second, looser rule than the one `agent-files.ts`'s Agent-backup path
  // check applies to the very same shape of input. `isSafePathSegment` is
  // now the one rule both read a segment by.
  assert.equal(isSafeSkillRelativePath('.'), false)
  assert.equal(isSafeSkillRelativePath('notes/./bad.md'), false)
  assert.equal(isSafeSkillRelativePath('notes\\.\\bad.md'), false)

  // A NUL was not checked at all before.
  assert.equal(isSafeSkillRelativePath('bad\0path.md'), false)
  assert.equal(isSafeSkillRelativePath('notes/bad\0.md'), false)
  assert.equal(isSafeSkillRelativePath('notes\\bad\0.md'), false)
})

test('skill extra files refuses Windows backslash path traversal (#458)', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await writeFile(join(home, '.codex/skills/secret.txt'), 'PRIVATE_DATA')
    await mkdir(join(sourcePath, 'scripts'), { recursive: true })
    await writeFile(join(sourcePath, 'scripts/run.sh'), '#!/bin/sh\necho hi')

    const targetPath = join(home, '.claude/skills/commit')
    const forged: LibraryPlannedOp = {
      id: 'op-traversal',
      kind: 'skill',
      name: 'commit',
      action: 'create',
      targetPath,
      content: BODY,
      sourcePath,
      extraFiles: [
        '..\\secret.txt',
        'C:\\secret.txt',
        'sub\\..\\..\\secret.txt',
        '\\\\server\\share\\secret.txt',
        'scripts/run.sh',
      ],
      guardDigest: null,
      guardBundle: null,
      sourceBundle: bundleDigest([
        { path: 'SKILL.md', bytes: Buffer.from(BODY) },
        { path: 'scripts/run.sh', bytes: Buffer.from('#!/bin/sh\necho hi') },
      ]),
      backup: false,
    }
    const results = await applyLibrary([forged], { libraryDir, home })
    assert.equal(results[0]?.outcome, 'done')
    // Legitimate extra file is copied
    assert.equal(existsSync(join(targetPath, 'scripts/run.sh')), true)
    // Traversal files must be skipped and never copied
    assert.equal(existsSync(join(home, '.claude/skills/secret.txt')), false)
    assert.equal(existsSync(join(targetPath, '..\\secret.txt')), false)
    assert.equal(existsSync(join(targetPath, 'C:\\secret.txt')), false)
    assert.equal(existsSync(join(targetPath, '\\\\server\\share\\secret.txt')), false)
  })
})

test('the shared bundle digest keeps attachment approvals pinned to the same bytes', () => {
  assert.equal(bundleDigest([
    { path: 'scripts/run.sh', bytes: Buffer.from('#!/bin/sh\necho one\n') },
    { path: 'SKILL.md', bytes: Buffer.from('---\nname: demo\n---\nDo the thing.\n') },
  ]), '90c5cc6bc70e7a9bb761c3f5e2c8b1400b5aea4227a65530d6e66913c185aa0a')
})

test('new or removed source extras after preview are refused before creating a target', async (t) => {
  for (const change of ['added', 'removed'] as const) {
    await t.test(change, async () => {
      await withHome(async (home, libraryDir) => {
        const sourcePath = join(home, '.codex/skills/commit')
        await skill(join(home, '.codex/skills'), 'commit', BODY)
        await writeFile(join(sourcePath, 'notes.txt'), 'original')
        const context = { home, libraryDir }
        const plan = await planLibrary([agent('claudecode')], [{ kind: 'installSkill', name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }], context)
        if (change === 'added') await writeFile(join(sourcePath, 'unseen.txt'), 'unseen')
        else await rm(join(sourcePath, 'notes.txt'))
        const result = (await applyLibrary(plan.ops, context))[0]!
        assert.equal(result.detail, 'The source changed since the preview — plan again.')
        assert.equal(existsSync(join(home, '.claude/skills/commit')), false)
      })
    })
  }
})

test('a flat skill is guarded as a one-file bundle, including when already in its own root', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.claude/skills/commit.md')
    await mkdir(join(home, '.claude/skills'), { recursive: true })
    await writeFile(sourcePath, BODY)
    const plan = await planLibrary([agent('claudecode')], [{ kind: 'installSkill', name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }], { home, libraryDir })
    assert.equal(plan.ops[0]?.action, 'skip')
    assert.equal(plan.ops[0]?.targetPath, sourcePath)
    assert.equal(plan.ops[0]?.guardBundle, bundleDigest([{ path: 'SKILL.md', bytes: Buffer.from(BODY) }]))
  })
})

test('skill writes without a bundle guard require a new plan', async () => {
  await withHome(async (home, libraryDir) => {
    const targetPath = join(home, '.claude/skills/commit')
    const results = await applyLibrary([{ id: 'old-plan', kind: 'skill', name: 'commit', action: 'create', targetPath, content: BODY, guardDigest: null, backup: false }], { home, libraryDir })
    assert.equal(results[0]?.detail, 'Plan again.')
    assert.equal(existsSync(targetPath), false)
  })
})

test('a target script changed after preview fails before removal or replacement', async () => {
  await withHome(async (home, libraryDir) => {
    const targetPath = join(home, '.claude/skills/commit')
    await skill(join(home, '.claude/skills'), 'commit', BODY)
    await mkdir(join(targetPath, 'scripts'))
    await writeFile(join(targetPath, 'scripts/run.sh'), 'echo original\n')
    const plan = await planLibrary([agent('claudecode')], [{ kind: 'removeCopy', name: 'commit', path: targetPath }], { home, libraryDir })
    await writeFile(join(targetPath, 'scripts/run.sh'), 'echo my edit\n')
    const result = (await applyLibrary(plan.ops, { home, libraryDir }))[0]!
    assert.equal(result.detail, 'The target changed since the preview — plan again.')
    assert.equal(result.backupPath, undefined)
    assert.equal(await readFile(join(targetPath, 'scripts/run.sh'), 'utf8'), 'echo my edit\n')
  })
})

test('legacy ownership vouches for a lone definition, but keeps a backup of untracked extras', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    const targetPath = join(home, '.claude/skills/commit')
    await skill(join(home, '.codex/skills'), 'commit', EDITED)
    await skill(join(home, '.claude/skills'), 'commit', BODY)
    await mkdir(libraryDir, { recursive: true })
    await writeFile(join(libraryDir, 'manifest.json'), JSON.stringify({ version: 1, entries: [{ kind: 'skill', name: 'commit', path: targetPath, digest: digestOf(BODY), at: 1 }] }))
    const context = { home, libraryDir }
    const agents = [agent('codex'), agent('claudecode')]
    const install = { kind: 'installSkill' as const, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
    assert.equal((await planLibrary(agents, [install], context)).ops[0]?.action, 'update')
    await writeFile(join(targetPath, 'notes.txt'), 'my notes')
    assert.equal((await planLibrary(agents, [install], context)).ops[0]?.action, 'refuse')
    const plan = await planLibrary(agents, [{ kind: 'syncSkill', name: 'commit', sourcePath, targetPaths: [targetPath] }], context)
    assert.equal(plan.ops[0]?.backup, true)
    const result = (await applyLibrary(plan.ops, context))[0]!
    assert.equal(result.outcome, 'done')
    assert.equal(await readFile(join(result.backupPath!, 'notes.txt'), 'utf8'), 'my notes')
  })
})

test('an update records retained files as owned, and reports at most five changed names', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    const targetPath = join(home, '.claude/skills/commit')
    const context = { home, libraryDir }
    const agents = [agent('codex'), agent('claudecode')]
    const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    for (let i = 0; i < 7; i++) await writeFile(join(sourcePath, `note-${i}.txt`), 'original')
    await applyLibrary((await planLibrary(agents, [intent], context)).ops, context)
    for (let i = 0; i < 7; i++) await writeFile(join(sourcePath, `note-${i}.txt`), 'updated')
    let plan = await planLibrary(agents, [intent], context)
    assert.equal(plan.ops[0]?.reason, 'Bundle files differ: note-0.txt, note-1.txt, note-2.txt, note-3.txt, note-4.txt and 2 more.')
    assert.equal((await applyLibrary(plan.ops, context))[0]?.outcome, 'done')
    await rm(join(sourcePath, 'note-6.txt'))
    await writeFile(join(sourcePath, 'SKILL.md'), EDITED)
    plan = await planLibrary(agents, [intent], context)
    assert.equal((await applyLibrary(plan.ops, context))[0]?.outcome, 'done')
    assert.equal(await readFile(join(targetPath, 'note-6.txt'), 'utf8'), 'updated')
    await writeFile(join(sourcePath, 'SKILL.md'), BODY)
    assert.equal((await planLibrary(agents, [intent], context)).ops[0]?.action, 'update')
  })
})

test('writes refuse retained-plus-incoming bundles over a cap before touching the target', async (t) => {
  for (const cap of ['files', 'bytes'] as const) {
    for (const phase of ['plan', 'update', 'create'] as const) {
      await t.test(`${cap} at ${phase}`, async () => {
        await withHome(async (home, libraryDir) => {
          const sourcePath = join(home, '.codex/skills/commit')
          const targetPath = join(home, '.claude/skills/commit')
          const context = { home, libraryDir }
          const agents = [agent('codex'), agent('claudecode')]
          const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
          await skill(join(home, '.codex/skills'), 'commit', BODY)
          if (cap === 'files') {
            for (let i = 0; i < MAX_BUNDLE_FILES; i++) await writeFile(join(sourcePath, `note-${i}.txt`), 'original')
          } else {
            await writeFile(join(sourcePath, 'retained.txt'), Buffer.alloc(10 * 1024 * 1024, 'a'))
          }
          const initial = (await planLibrary(agents, [intent], context)).ops[0]!
          assert.equal((await applyLibrary([initial], context))[0]?.outcome, 'done')
          const before = new Map(await Promise.all((await readdir(targetPath)).map(async (path) =>
            [path, await readFile(join(targetPath, path))] as const)))
          const manifestBefore = await readFile(join(libraryDir, 'manifest.json'), 'utf8')
          await rm(join(sourcePath, cap === 'files' ? 'note-0.txt' : 'retained.txt'))
          await writeFile(join(sourcePath, 'incoming.txt'), cap === 'files' ? 'incoming' : Buffer.alloc(10 * 1024 * 1024, 'b'))
          if (cap === 'bytes') await writeFile(join(sourcePath, 'extra.txt'), 'x')
          await writeFile(join(sourcePath, 'SKILL.md'), EDITED)
          const reason = cap === 'files' ? /more than 200 files/ : /more than 20 MB/
          if (phase === 'plan') {
            // Both entry points preserve files no longer shipped by the source.
            const plan = await planLibrary(agents, [intent,
              { kind: 'syncSkill', name: 'commit', sourcePath, targetPaths: [targetPath] },
            ], context)
            assert.deepEqual(plan.ops.map((op) => op.action), ['refuse', 'refuse'])
            for (const op of plan.ops) {
              assert.equal(op.targetPath, targetPath)
              assert.match(op.reason ?? '', reason)
            }
          } else {
            // Apply must rederive the cap even if an over-limit op crosses the wire.
            const extraFiles = (await readdir(sourcePath)).filter((path) => path !== 'SKILL.md')
            const files = await Promise.all(['SKILL.md', ...extraFiles].map(async (path) =>
              ({ path, bytes: await readFile(join(sourcePath, path)) })))
            const op: LibraryPlannedOp = { ...initial, action: phase, content: EDITED,
              guardDigest: digestOf(BODY), guardBundle: initial.sourceBundle!,
              extraFiles, sourceBundle: bundleDigest(files), backup: true }
            const result = (await applyLibrary([op], context))[0]!
            assert.equal(result.outcome, 'failed')
            assert.match(result.detail ?? '', reason)
            assert.equal(result.backupPath, undefined)
          }
          assert.deepEqual((await readdir(targetPath)).sort(), [...before.keys()].sort())
          for (const [path, bytes] of before) assert.deepEqual(await readFile(join(targetPath, path)), bytes)
          assert.equal(await readFile(join(libraryDir, 'manifest.json'), 'utf8'), manifestBefore)
          assert.equal(existsSync(join(libraryDir, 'backups')), false)
        })
      })
    }
  }
})

test('updates at a bundle cap count incoming replacements once and keep unshipped files', async (t) => {
  for (const cap of ['files', 'bytes'] as const) {
    await t.test(cap, async () => {
      await withHome(async (home, libraryDir) => {
        const sourcePath = join(home, '.codex/skills/commit')
        const targetPath = join(home, '.claude/skills/commit')
        const context = { home, libraryDir }
        const agents = [agent('codex'), agent('claudecode')]
        const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
        await skill(join(home, '.codex/skills'), 'commit', BODY)
        if (cap === 'files') {
          for (let i = 0; i < MAX_BUNDLE_FILES; i++) await writeFile(join(sourcePath, `note-${i}.txt`), 'original')
        } else {
          await writeFile(join(sourcePath, 'note-0.txt'), Buffer.alloc(10 * 1024 * 1024, 'a'))
          await writeFile(join(sourcePath, 'note-1.txt'), Buffer.alloc(10 * 1024 * 1024, 'a'))
        }
        assert.equal((await applyLibrary((await planLibrary(agents, [intent], context)).ops, context))[0]?.outcome, 'done')
        const retained = await readFile(join(targetPath, 'note-0.txt'))
        await rm(join(sourcePath, 'note-0.txt'))
        const incoming = cap === 'files' ? Buffer.from('updated') : Buffer.alloc(10 * 1024 * 1024, 'b')
        await writeFile(join(sourcePath, 'note-1.txt'), incoming)
        await writeFile(join(sourcePath, 'SKILL.md'), EDITED)
        const plan = await planLibrary(agents, [intent], context)
        assert.equal(plan.ops[0]?.action, 'update')
        assert.equal((await applyLibrary(plan.ops, context))[0]?.outcome, 'done')
        assert.equal(await readFile(join(targetPath, 'SKILL.md'), 'utf8'), EDITED)
        assert.deepEqual(await readFile(join(targetPath, 'note-0.txt')), retained)
        assert.deepEqual(await readFile(join(targetPath, 'note-1.txt')), incoming)
      })
    })
  }
})

test('preview cap accounting excludes incoming paths that apply will skip', async (t) => {
  for (const cap of ['files', 'bytes'] as const) {
    await t.test(cap, async () => {
      await withHome(async (home, libraryDir) => {
        const sourcePath = join(home, '.codex/skills/commit')
        const targetPath = join(home, '.claude/skills/commit')
        const context = { home, libraryDir }
        const agents = [agent('codex'), agent('claudecode')]
        const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
        await skill(join(home, '.codex/skills'), 'commit', BODY)
        if (cap === 'files') {
          for (let i = 0; i < MAX_BUNDLE_FILES; i++) await writeFile(join(sourcePath, `note-${i}.txt`), 'original')
        } else {
          await writeFile(join(sourcePath, 'note-0.txt'), Buffer.alloc(10 * 1024 * 1024, 'a'))
          await writeFile(join(sourcePath, 'note-1.txt'), Buffer.alloc(10 * 1024 * 1024, 'a'))
        }
        assert.equal((await applyLibrary((await planLibrary(agents, [intent], context)).ops, context))[0]?.outcome, 'done')
        const retained = await readFile(join(targetPath, 'note-0.txt'))
        await rm(join(sourcePath, 'note-0.txt'))
        const incoming = cap === 'files' ? Buffer.from('updated') : Buffer.alloc(10 * 1024 * 1024, 'b')
        await writeFile(join(sourcePath, 'note-1.txt'), incoming)
        await writeFile(join(sourcePath, '..\\ignored.txt'), 'ignored')
        await writeFile(join(sourcePath, 'SKILL.md'), EDITED)
        const plan = await planLibrary(agents, [intent,
          { kind: 'syncSkill', name: 'commit', sourcePath, targetPaths: [targetPath] },
        ], context)
        assert.deepEqual(plan.ops.map((op) => op.action), ['update', 'update'])
        assert.equal((await applyLibrary([plan.ops[0]!], context))[0]?.outcome, 'done')
        assert.equal(await readFile(join(targetPath, 'SKILL.md'), 'utf8'), EDITED)
        assert.deepEqual(await readFile(join(targetPath, 'note-0.txt')), retained)
        assert.deepEqual(await readFile(join(targetPath, 'note-1.txt')), incoming)
        assert.equal(existsSync(join(targetPath, '..\\ignored.txt')), false)
        assert.equal(existsSync(join(home, '.claude/skills/ignored.txt')), false)
        assert.equal((await readdir(targetPath)).length, cap === 'files' ? MAX_BUNDLE_FILES + 1 : 3)
      })
    })
  }
})

test('a source file arriving between the preview list and digest is refused before writing', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await writeFile(join(sourcePath, 'notes.txt'), 'original')
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { planLibrary, applyLibrary } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
      const [home, libraryDir, sourcePath] = process.argv.slice(1);
      const readdir = fs.readdirSync;
      fs.readdirSync = (path, ...args) => {
        const names = readdir(path, ...args);
        if (path === sourcePath) {
          fs.writeFileSync(sourcePath + '/unseen.txt', 'unseen');
          fs.readdirSync = readdir;
          syncBuiltinESMExports();
        }
        return names;
      };
      syncBuiltinESMExports();
      const context = { home, libraryDir };
      const plan = await planLibrary([{ id: 'claudecode', brand: 'claudecode' }], [
        { kind: 'installSkill', name: 'commit', sourcePath, targetRuntime: 'claudecode' },
        { kind: 'authorSkill', name: 'next', content: ${JSON.stringify(BODY)}, targetRuntimes: ['claudecode'] },
      ], context);
      console.log(JSON.stringify({ plan, results: await applyLibrary(plan.ops, context) }));
    `
    const { plan, results } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, home, libraryDir, sourcePath], {
      timeout: 5000, encoding: 'utf8',
    })) as { plan: { ops: LibraryPlannedOp[] }; results: { outcome: string; detail?: string }[] }
    assert.deepEqual(plan.ops[0]?.extraFiles, ['notes.txt'])
    assert.equal(plan.ops[0]?.sourceBundle, bundleDigest([
      { path: 'SKILL.md', bytes: Buffer.from(BODY) },
      { path: 'notes.txt', bytes: Buffer.from('original') },
      { path: 'unseen.txt', bytes: Buffer.from('unseen') },
    ]))
    assert.deepEqual(results.map((op) => op.outcome), ['failed', 'done'])
    assert.equal(results[0]?.detail, 'The source changed since the preview — plan again.')
    assert.equal(existsSync(join(home, '.claude/skills/commit')), false)
    assert.equal(existsSync(join(libraryDir, 'backups')), false)
    assert.equal(await readFile(join(home, '.claude/skills/next/SKILL.md'), 'utf8'), BODY)
  })
})

test('supporting-file updates replace destination links without touching their referents', async (t) => {
  for (const timing of ['before preview', 'after preview']) {
    await t.test(timing, async () => {
      await withHome(async (home, libraryDir) => {
        const sourcePath = join(home, '.codex/skills/commit')
        const targetPath = join(home, '.claude/skills/commit')
        const outside = join(home, 'outside.sh')
        const context = { home, libraryDir }
        const agents = [agent('claudecode')]
        const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
        await skill(join(home, '.codex/skills'), 'commit', BODY)
        assert.equal((await applyLibrary((await planLibrary(agents, [intent], context)).ops, context))[0]?.outcome, 'done')
        await chmod(join(targetPath, 'SKILL.md'), 0o600)
        await writeFile(outside, 'keep these bytes', { mode: 0o600 })
        await mkdir(join(sourcePath, 'scripts'))
        await mkdir(join(targetPath, 'scripts'))
        await writeFile(join(sourcePath, 'scripts/run.sh'), 'echo updated\n', { mode: 0o755 })
        await writeFile(join(sourcePath, 'SKILL.md'), EDITED)
        const link = () => symlink(outside, join(targetPath, 'scripts/run.sh'))
        if (timing === 'before preview') await link()
        const plan = await planLibrary(agents, [intent], context)
        assert.equal(plan.ops[0]?.action, 'update')
        if (timing === 'after preview') await link()
        const result = (await applyLibrary(plan.ops, context))[0]!
        assert.equal(await readFile(outside, 'utf8'), 'keep these bytes')
        assert.equal((await lstat(outside)).mode & 0o777, 0o600)
        assert.equal(result.outcome, 'done')
        assert.equal((await lstat(join(targetPath, 'scripts/run.sh'))).isSymbolicLink(), false)
        assert.equal(await readFile(join(targetPath, 'scripts/run.sh'), 'utf8'), 'echo updated\n')
        assert.equal((await lstat(join(targetPath, 'scripts/run.sh'))).mode & 0o777, 0o755)
        assert.equal((await lstat(join(targetPath, 'SKILL.md'))).mode & 0o777, 0o600)
        assert.deepEqual(await readdir(join(targetPath, 'scripts')), ['run.sh'])
      })
    })
  }
})

test('supporting-file updates refuse linked destination directories before writing', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    const targetPath = join(home, '.claude/skills/commit')
    const outside = join(home, 'outside')
    const context = { home, libraryDir }
    const agents = [agent('claudecode')]
    const intent = { kind: 'installSkill' as const, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await applyLibrary((await planLibrary(agents, [intent], context)).ops, context)
    await mkdir(outside)
    await writeFile(join(outside, 'run.sh'), 'keep these bytes')
    await symlink(outside, join(targetPath, 'scripts'))
    await mkdir(join(sourcePath, 'scripts'))
    await writeFile(join(sourcePath, 'scripts/run.sh'), 'echo updated\n')
    await writeFile(join(sourcePath, 'SKILL.md'), EDITED)
    const plan = await planLibrary(agents, [intent], context)
    assert.equal(plan.ops[0]?.action, 'update')
    const result = (await applyLibrary(plan.ops, context))[0]!
    assert.equal(await readFile(join(outside, 'run.sh'), 'utf8'), 'keep these bytes')
    assert.equal(result.outcome, 'failed')
    assert.match(result.detail ?? '', /link/i)
    assert.equal(await readFile(join(targetPath, 'SKILL.md'), 'utf8'), BODY)
  })
})

test('a FIFO in a source skill bundle is refused without blocking planning', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    execFileSync('mkfifo', [join(sourcePath, 'pipe')])
    const script = `
      import { planLibrary } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
      const [home, libraryDir, sourcePath] = process.argv.slice(1);
      const plan = await planLibrary([{ id: 'claudecode', brand: 'claudecode' }], [
        { kind: 'installSkill', name: 'commit', sourcePath, targetRuntime: 'claudecode' },
        { kind: 'authorSkill', name: 'next', content: ${JSON.stringify(BODY)}, targetRuntimes: ['claudecode'] },
      ], { home, libraryDir });
      console.log(JSON.stringify(plan.ops));
    `
    const ops = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, home, libraryDir, sourcePath], {
      timeout: 5000, encoding: 'utf8',
    })) as LibraryPlannedOp[]
    assert.deepEqual(ops.map((op) => op.action), ['refuse', 'create'])
    assert.match(ops[0]?.reason ?? '', /pipe.*not a regular file/i)
    assert.equal(existsSync(join(home, '.claude/skills/commit')), false)
  })
})

test('an unreadable source directory is refused rather than installed partially', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    const scriptsPath = join(sourcePath, 'scripts')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await mkdir(scriptsPath)
    await writeFile(join(scriptsPath, 'run.sh'), 'echo keep me\n')
    await chmod(scriptsPath, 0o300)
    try {
      const context = { home, libraryDir }
      const plan = await planLibrary([agent('claudecode')], [
        { kind: 'installSkill', name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') },
        { kind: 'authorSkill', name: 'next', content: BODY, targetRuntimes: [runtimeId('claudecode')] },
      ], context)

      assert.deepEqual(plan.ops.map((op) => op.action), ['refuse', 'create'])
      assert.match(plan.ops[0]?.reason ?? '', /scripts.*could not be inspected/i)
      assert.deepEqual((await applyLibrary(plan.ops, context)).map((op) => op.outcome), ['skipped', 'done'])
      assert.equal(existsSync(join(home, '.claude/skills/commit')), false)
      assert.equal(await readFile(join(home, '.claude/skills/next/SKILL.md'), 'utf8'), BODY)
    } finally {
      await chmod(scriptsPath, 0o700)
    }
  })
})

test('an oversized target refuses its operation while other planning intents proceed', async (t) => {
  for (const kind of ['installSkill', 'removeCopy', 'syncSkill', 'restoreCopy'] as const) {
    await t.test(kind, async () => {
      await withHome(async (home, libraryDir) => {
        const sourcePath = join(home, '.codex/skills/commit')
        const targetPath = join(home, '.claude/skills/commit')
        const backupPath = join(libraryDir, 'backups/commit')
        await skill(join(home, '.codex/skills'), 'commit', EDITED)
        await skill(join(home, '.claude/skills'), 'commit', BODY)
        await skill(join(libraryDir, 'backups'), 'commit', EDITED)
        await writeFile(join(targetPath, 'large.txt'), '')
        await truncate(join(targetPath, 'large.txt'), 21 * 1024 * 1024)
        const intent = kind === 'installSkill' ? { kind, name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') }
          : kind === 'removeCopy' ? { kind, name: 'commit', path: targetPath }
          : kind === 'syncSkill' ? { kind, name: 'commit', sourcePath, targetPaths: [targetPath] }
          : { kind, name: 'commit', backupPath, targetPath }
        const context = { home, libraryDir }
        const plan = await planLibrary([agent('claudecode')], [intent,
          { kind: 'authorSkill', name: 'next', content: BODY, targetRuntimes: [runtimeId('claudecode')] },
        ], context)
        assert.deepEqual(plan.ops.map((op) => op.action), ['refuse', 'create'])
        assert.match(plan.ops[0]?.reason ?? '', /more than 20 MB/i)
        assert.equal(plan.ops[0]?.targetPath, targetPath)
        assert.equal(plan.ops[0]?.guardBundle, undefined)
        assert.equal(plan.ops[0]?.sourceBundle, undefined)
        assert.equal(new Set(plan.ops.map((op) => op.id)).size, 2)
        assert.deepEqual((await applyLibrary(plan.ops, context)).map((op) => op.outcome), ['skipped', 'done'])
        assert.equal(await readFile(join(targetPath, 'SKILL.md'), 'utf8'), BODY)
      })
    })
  }
})

test('an oversized skill definition refuses removal while the next intent proceeds', async (t) => {
  for (const flat of [true, false]) {
    await t.test(flat ? 'flat file' : 'bundle definition', async () => {
      await withHome(async (home, libraryDir) => {
        const targetPath = join(home, flat ? '.claude/skills/commit.md' : '.claude/skills/commit')
        const definitionPath = flat ? targetPath : join(targetPath, 'SKILL.md')
        await mkdir(join(home, '.claude/skills'), { recursive: true })
        if (!flat) await mkdir(targetPath)
        await writeFile(definitionPath, BODY)
        await truncate(definitionPath, 21 * 1024 * 1024)
        const context = { home, libraryDir }
        const plan = await planLibrary([agent('claudecode')], [
          { kind: 'removeCopy', name: 'commit', path: targetPath },
          { kind: 'authorSkill', name: 'next', content: BODY, targetRuntimes: [runtimeId('claudecode')] },
        ], context)
        assert.deepEqual(plan.ops.map((op) => op.action), ['refuse', 'create'])
        assert.equal(plan.ops[0]?.targetPath, targetPath)
        assert.match(plan.ops[0]?.reason ?? '', /more than 20 MB/i)
        assert.equal(plan.ops[0]?.guardBundle, undefined)
        assert.deepEqual((await applyLibrary(plan.ops, context)).map((op) => op.outcome), ['skipped', 'done'])
        assert.equal((await lstat(definitionPath)).size, 21 * 1024 * 1024)
        assert.equal((await readFile(definitionPath)).subarray(0, Buffer.byteLength(BODY)).toString(), BODY)
        assert.equal(existsSync(join(libraryDir, 'backups')), false)
        assert.equal(await readFile(join(home, '.claude/skills/next/SKILL.md'), 'utf8'), BODY)
      })
    })
  }
})

test('an oversized flat definition cannot be removed by an operation claiming no definition', async () => {
  await withHome(async (home, libraryDir) => {
    const targetPath = join(home, '.claude/skills/commit.md')
    await mkdir(join(home, '.claude/skills'), { recursive: true })
    await writeFile(targetPath, BODY)
    await truncate(targetPath, 21 * 1024 * 1024)
    const context = { home, libraryDir }
    const next = await planLibrary([agent('claudecode')], [
      { kind: 'authorSkill', name: 'next', content: BODY, targetRuntimes: [runtimeId('claudecode')] },
    ], context)
    const results = await applyLibrary([
      { id: 'unreadable-flat', kind: 'skill', name: 'commit', action: 'remove', targetPath,
        guardDigest: null, guardBundle: null, backup: false },
      ...next.ops,
    ], context)
    assert.deepEqual(results.map((op) => op.outcome), ['failed', 'done'])
    assert.match(results[0]?.detail ?? '', /more than 20 MB/i)
    assert.equal(results[0]?.backupPath, undefined)
    assert.equal((await lstat(targetPath)).size, 21 * 1024 * 1024)
    assert.equal((await readFile(targetPath)).subarray(0, Buffer.byteLength(BODY)).toString(), BODY)
    assert.equal(existsSync(join(libraryDir, 'backups')), false)
  })
})

test('a source file swapped for a FIFO at open fails alone without blocking apply', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    const note = join(sourcePath, 'notes.txt')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await writeFile(note, 'original')
    const plan = await planLibrary([agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') },
      { kind: 'authorSkill', name: 'next', content: BODY, targetRuntimes: [runtimeId('claudecode')] },
    ], { home, libraryDir })
    const script = `
      import fs from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { applyLibrary } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
      const [home, libraryDir, note, ops] = process.argv.slice(1);
      const open = fs.openSync;
      fs.openSync = (path, ...args) => {
        if (path === note) {
          fs.unlinkSync(note);
          execFileSync('mkfifo', [note]);
          fs.openSync = open;
          syncBuiltinESMExports();
        }
        return open(path, ...args);
      };
      syncBuiltinESMExports();
      console.log(JSON.stringify(await applyLibrary(JSON.parse(ops), { home, libraryDir })));
    `
    const results = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, home, libraryDir, note, JSON.stringify(plan.ops)], {
      timeout: 5000, encoding: 'utf8',
    })) as { outcome: string; detail?: string }[]
    assert.deepEqual(results.map((op) => op.outcome), ['failed', 'done'])
    assert.equal(results[0]?.detail, 'The source changed since the preview — plan again.')
    assert.equal(existsSync(join(home, '.claude/skills/commit')), false)
  })
})

test('a source file growing during the read is byte-bounded and fails before writing', async () => {
  await withHome(async (home, libraryDir) => {
    const sourcePath = join(home, '.codex/skills/commit')
    const note = join(sourcePath, 'notes.txt')
    await skill(join(home, '.codex/skills'), 'commit', BODY)
    await writeFile(note, 'original')
    const plan = await planLibrary([agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath, targetRuntime: runtimeId('claudecode') },
    ], { home, libraryDir })
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { applyLibrary } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
      const [home, libraryDir, note, ops] = process.argv.slice(1);
      const open = fs.openSync, read = fs.readSync;
      let noteFd;
      fs.openSync = (path, ...args) => {
        const fd = open(path, ...args);
        if (path === note) noteFd = fd;
        return fd;
      };
      fs.readSync = (fd, ...args) => {
        const count = read(fd, ...args);
        if (fd === noteFd) {
          fs.truncateSync(note, 21 * 1024 * 1024);
          fs.readSync = read;
          syncBuiltinESMExports();
        }
        return count;
      };
      syncBuiltinESMExports();
      console.log(JSON.stringify(await applyLibrary(JSON.parse(ops), { home, libraryDir })));
    `
    const results = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, home, libraryDir, note, JSON.stringify(plan.ops)], {
      timeout: 5000, encoding: 'utf8',
    })) as { outcome: string; detail?: string }[]
    assert.equal(results[0]?.outcome, 'failed')
    assert.equal(results[0]?.detail, 'The source changed since the preview — plan again.')
    assert.equal(existsSync(join(home, '.claude/skills/commit')), false)
  })
})
