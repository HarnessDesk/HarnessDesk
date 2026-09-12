import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, type LibraryPlannedOp } from '@harnessdesk/protocol'

import {
  applyLibrary,
  decodeMcpEntry,
  planLibrary,
  unifiedDiff,
  type WriteAgent,
} from '../src/index.js'

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
    await writeFile(join(source, 'scripts/run.sh'), '#!/bin/sh\necho ok\n')

    const plan = await planLibrary([agent('codex'), agent('claudecode')], [
      { kind: 'installSkill', name: 'commit', sourcePath: source, targetRuntime: runtimeId('claudecode') },
    ], { libraryDir, home })
    assert.deepEqual(plan.ops[0]?.extraFiles, ['scripts/run.sh'])

    await applyLibrary(plan.ops, { libraryDir, home })
    const copied = await readFile(join(home, '.claude/skills/commit/scripts/run.sh'), 'utf8')
    assert.match(copied, /echo ok/)
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
