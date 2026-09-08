import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  entryHasProblem,
  runtimeId,
  summarise,
  type Library,
  type ReachState,
} from '@harnessdesk/protocol'

import { detectSkillActivations, readLibrary, type InventoryAgent } from '../src/index.js'

/**
 * The library, read.
 *
 * The property under test throughout: **a copy on disk is not the same as a
 * skill an agent can load**, and the report must never conflate them. Four of
 * the six reach states exist only because that distinction is real, and every
 * one of them was observed on a real machine before it was given a name.
 *
 * The scan is pointed at a temporary home, so these run the same on a laptop
 * with six agents installed and on a CI runner with none.
 */

/**
 * An agent that is only what the scanner reads: a brand, and optionally an
 * answer to "what did you load". `InventoryAgent` *is* that shape — the seam
 * exists so this file needs no cast and no sixty-field fixture.
 */
const agent = (
  brand: string,
  reported?: readonly string[] | Error,
  /** Definition paths this agent read and refused, with its reason. */
  problems: Readonly<Record<string, string>> = {},
): InventoryAgent => {
  const base: InventoryAgent = { id: runtimeId(brand), brand }
  if (reported === undefined) return base
  return {
    ...base,
    listSkills: async () => {
      if (reported instanceof Error) throw reported
      return reported.map((name) => ({ name }))
    },
    listSkillProblems: async () =>
      Object.entries(problems).map(([path, message]) => ({ path, message })),
  }
}

const skill = async (root: string, name: string, body: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), body)
}

/** A directory bearing a skill's name with nothing inside it. */
const hollowSkill = async (root: string, name: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true })
}

const stateFor = (library: Library, name: string, brand: string): ReachState => {
  const entry = library.entries.find((one) => one.name === name)
  assert.ok(entry, `no entry named ${name}`)
  const index = library.runtimes.indexOf(runtimeId(brand))
  assert.notEqual(index, -1, `no column for ${brand}`)
  const reach = entry.reach[index]
  assert.ok(reach)
  return reach.state
}

const withHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'hd-library-'))
  try {
    await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('a skill in an agent’s own directory reaches it', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.claude/skills'), 'commit', '---\nname: commit\n---\nBody')
    const library = await readLibrary([agent('claudecode')], { home })
    assert.equal(stateFor(library, 'commit', 'claudecode'), 'reaches')
  })
})

test('one MCP server in two dialects is not reported as differing copies', async () => {
  // Codex spells it in TOML, Claude in JSON, with keys in a different order.
  // The scanner must digest the decoded spec, not the per-dialect text, or the
  // Differs tile and the Problems filter flag a server that is in fact the same
  // everywhere — forever.
  await withHome(async (home) => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      join(home, '.codex/config.toml'),
      '[mcp_servers.fetcher]\ncommand = "npx"\nargs = ["-y", "fetcher-mcp"]\nenv = { TOKEN = "abc" }\n',
    )
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { fetcher: { env: { TOKEN: 'abc' }, command: 'npx', args: ['-y', 'fetcher-mcp'] } },
      }),
    )
    const library = await readLibrary([agent('codex'), agent('claudecode')], { home })
    const entry = library.entries.find((one) => one.name === 'fetcher')
    assert.ok(entry, 'fetcher was scanned')
    const digests = new Set(entry.copies.filter((c) => !c.hollow).map((c) => c.digest))
    assert.equal(digests.size, 1, 'both dialects digest to one canonical form')
    assert.equal(entryHasProblem(entry), false, 'so it is not flagged as a problem')
  })
})

test('a directory with no SKILL.md is hollow, not absent', async () => {
  // The bug this whole page exists to catch: on the developer's machine, 43 of
  // 65 directories under `~/.agents/skills` were exactly this. An agent that
  // scans the parent lists the name and loads nothing, so reporting "absent"
  // would be wrong in the one way that matters.
  await withHome(async (home) => {
    await hollowSkill(join(home, '.claude/skills'), 'browse')
    const library = await readLibrary([agent('claudecode')], { home })
    assert.equal(stateFor(library, 'browse', 'claudecode'), 'hollow')
    const entry = library.entries.find((one) => one.name === 'browse')
    assert.ok(entry)
    assert.equal(entry.copies[0]?.hollow, true)
    assert.equal(entry.copies[0]?.digest, null)
  })
})

test('a copy only in the shared directory does not reach an agent that never reads it', async () => {
  // The measured finding: neither Claude Code 2.1.240 nor the Gemini CLI
  // carries any reference to `~/.agents/skills`. A library that trusted the
  // published convention would call this `reaches` for both.
  await withHome(async (home) => {
    await skill(join(home, '.agents/skills'), 'cso', '---\nname: cso\n---\nBody')
    const library = await readLibrary([agent('claudecode'), agent('geminicli')], { home })
    assert.equal(stateFor(library, 'cso', 'claudecode'), 'unscanned')
    assert.equal(stateFor(library, 'cso', 'geminicli'), 'unscanned')
    const entry = library.entries.find((one) => one.name === 'cso')
    assert.deepEqual(entry?.copies[0]?.readBy, [], 'nothing reads the shared directory')
  })
})

test('what the agent itself reports outranks the path table', async () => {
  // Ground truth beats the table in both directions. The table says nothing
  // reads `.agents/skills`; the agent says it loaded `cso` anyway — because it
  // moved, or was configured to. The agent wins, and the basis says so.
  await withHome(async (home) => {
    await skill(join(home, '.agents/skills'), 'cso', '---\nname: cso\n---\nBody')
    const library = await readLibrary([agent('claudecode', ['cso'])], { home })
    assert.equal(stateFor(library, 'cso', 'claudecode'), 'reaches')
    const entry = library.entries.find((one) => one.name === 'cso')
    assert.equal(entry?.reach[0]?.basis, 'reported')
  })
})

test('an agent asked and silent about a name on disk marks it unscanned, not absent', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.agents/skills'), 'gstack', '---\nname: gstack\n---\nBody')
    const library = await readLibrary([agent('claudecode', [])], { home })
    assert.equal(stateFor(library, 'gstack', 'claudecode'), 'unscanned')
  })
})

test('a copy in the agent’s own directory it has not read back is stale, never unscanned', async () => {
  await withHome(async (home) => {
    // The state of the world one second after this page installs something:
    // the file is exactly where the agent looks, and the agent's answer is
    // the list it made when it started. Reporting that as `unscanned` told
    // the person their brand-new copy was somewhere the agent never looks —
    // on the screen directly after writing it where it does.
    await skill(join(home, '.claude/skills'), 'code-review', '---\nname: code-review\n---\nBody')
    const library = await readLibrary([agent('claudecode', [])], { home })
    assert.equal(stateFor(library, 'code-review', 'claudecode'), 'stale')
    const entry = library.entries.find((one) => one.name === 'code-review')
    assert.equal(entry?.reach[0]?.basis, 'reported')
    assert.match(entry?.reach[0]?.note ?? '', /where this agent looks/)
    // The note states the fact and stops there: an agent that refuses to
    // load a definition looks exactly like one that has not re-read, and
    // naming the cause would be confidently wrong about the first.
    assert.doesNotMatch(entry?.reach[0]?.note ?? '', /has not looked since/)
    // And it is not a defect: the page's own headline action must not make
    // the page complain about its own result.
    assert.equal(entryHasProblem(entry!), false)
  })
})

test('a definition the agent read and refused is refused, not merely unread', async () => {
  await withHome(async (home) => {
    /*
     * The two look identical from disk: a `SKILL.md` is there and the agent
     * did not name it. They need opposite responses — one waits for the agent
     * to look again, and looking again will never help the other — so the
     * library asks agents for their rejections and not only their skills.
     *
     * Measured on Codex 0.149.0 (2026-09-06): `skills/list` answers with an
     * `errors` array beside the skills, one entry per file, naming the file
     * and the fault. A `SKILL.md` with no frontmatter and one missing
     * `description` are both refused; one missing only `name` is accepted,
     * the directory standing in for it.
     */
    await skill(join(home, '.codex/skills'), 'broken', '# No frontmatter here\n')
    await skill(join(home, '.codex/skills'), 'fresh', '---\nname: fresh\n---\nBody')
    const library = await readLibrary(
      [
        agent('codex', [], {
          [join(home, '.codex/skills/broken/SKILL.md')]: 'missing YAML frontmatter delimited by ---',
        }),
      ],
      { home },
    )
    assert.equal(stateFor(library, 'broken', 'codex'), 'rejected')
    const broken = library.entries.find((one) => one.name === 'broken')
    // The agent's own words, not ours: we did not decide this and must not
    // paraphrase a loader rule we have not measured.
    assert.equal(broken?.reach[0]?.note, 'missing YAML frontmatter delimited by ---')
    assert.equal(entryHasProblem(broken!), true, 'something on disk is wrong and is fixable')

    // The one it said nothing about is still only unread.
    assert.equal(stateFor(library, 'fresh', 'codex'), 'stale')
  })
})

test('an agent that reports no rejections leaves every copy as it was', async () => {
  await withHome(async (home) => {
    // The method is optional, and a runtime without it must leave the library
    // exactly as informed as it was before the method existed.
    await skill(join(home, '.claude/skills'), 'quiet', '# No frontmatter\n')
    const library = await readLibrary([agent('claudecode', [])], { home })
    assert.equal(stateFor(library, 'quiet', 'claudecode'), 'stale')
  })
})

test('Codex loads ~/.agents/skills, so a copy there is read by it', async () => {
  await withHome(async (home) => {
    // Measured 2026-09-06 against a real codex-cli 0.149.0 app-server pointed
    // at a temporary `$HOME`: `skills/list` answers with the skills in
    // `~/.agents/skills`, paths and all. The table said otherwise on the
    // strength of a grep, and the cost was a sheet printing "no agent reads
    // this directory" under a copy the switch above it said Codex loaded.
    await skill(join(home, '.agents/skills'), 'db-migrations', '---\nname: db-migrations\n---\nBody')
    const library = await readLibrary([agent('codex'), agent('claudecode')], { home })
    assert.equal(stateFor(library, 'db-migrations', 'codex'), 'reaches')
    assert.equal(stateFor(library, 'db-migrations', 'claudecode'), 'unscanned')
    const entry = library.entries.find((one) => one.name === 'db-migrations')
    assert.deepEqual(entry?.copies[0]?.readBy, [runtimeId('codex')])
  })
})

test('two copies in one agent’s directories with different content differ', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.claude/skills'), 'review', '---\nname: review\n---\nOne')
    await skill(join(home, '.cursor/skills'), 'review', '---\nname: review\n---\nTwo')
    // Cursor reads both its own directory and, per the table, not `.claude` —
    // so give Claude Code two of its own to disagree with each other.
    await skill(join(home, '.claude/skills-extra'), 'ignored', '---\nname: ignored\n---\nX')
    const library = await readLibrary([agent('claudecode'), agent('cursor')], { home })
    assert.equal(stateFor(library, 'review', 'claudecode'), 'reaches')
    assert.equal(stateFor(library, 'review', 'cursor'), 'reaches')
    const entry = library.entries.find((one) => one.name === 'review')
    assert.equal(entry?.copies.length, 2)
    assert.notEqual(entry?.copies[0]?.digest, entry?.copies[1]?.digest)
  })
})

test('identical copies do not read as a disagreement', async () => {
  await withHome(async (home) => {
    const body = '---\nname: same\n---\nIdentical'
    await skill(join(home, '.claude/skills'), 'same', body)
    await skill(join(home, '.agents/skills'), 'same', body)
    const library = await readLibrary([agent('claudecode')], { home })
    assert.equal(stateFor(library, 'same', 'claudecode'), 'reaches')
    const entry = library.entries.find((one) => one.name === 'same')
    assert.equal(new Set(entry?.copies.map((copy) => copy.digest)).size, 1)
  })
})

test('an agent’s own bundled skills are listed and marked read-only', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.codex/skills/.system'), 'imagegen', '---\nname: imagegen\n---\nB')
    const library = await readLibrary([agent('codex')], { home })
    const entry = library.entries.find((one) => one.name === 'imagegen')
    assert.ok(entry)
    assert.equal(entry.copies[0]?.readOnly, true)
  })
})

test('frontmatter survives an unquoted colon in the description', async () => {
  // Technically invalid YAML that every agent's parser accepts in practice;
  // rejecting it would drop real skills out of the report.
  await withHome(async (home) => {
    await skill(
      join(home, '.claude/skills'),
      'pdf',
      '---\nname: PDF tools\ndescription: Use this when: the user asks about PDFs\n---\nBody',
    )
    const library = await readLibrary([agent('claudecode')], { home })
    const entry = library.entries.find((one) => one.name === 'pdf')
    assert.equal(entry?.title, 'PDF tools')
    assert.equal(entry?.description, 'Use this when: the user asks about PDFs')
  })
})

test('MCP servers are read out of both JSON and TOML', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['linear'] } } }),
    )
    await writeFile(
      join(home, '.codex/config.toml'),
      '[mcp_servers.linear]\ncommand = "npx"\n\n[other]\nx = 1\n',
    )
    const library = await readLibrary([agent('claudecode'), agent('codex')], { home })
    const entry = library.entries.find((one) => one.kind === 'mcp' && one.name === 'linear')
    assert.ok(entry, 'the server should appear once, not once per file')
    assert.equal(entry.copies.length, 2)
    assert.equal(stateFor(library, 'linear', 'claudecode'), 'reaches')
    assert.equal(stateFor(library, 'linear', 'codex'), 'reaches')
  })
})

test('an unparseable config contributes nothing and does not fail the scan', async () => {
  await withHome(async (home) => {
    await writeFile(join(home, '.claude.json'), '{ not json')
    await skill(join(home, '.claude/skills'), 'ok', '---\nname: ok\n---\nB')
    const library = await readLibrary([agent('claudecode')], { home })
    assert.equal(stateFor(library, 'ok', 'claudecode'), 'reaches')
    assert.equal(library.entries.filter((one) => one.kind === 'mcp').length, 0)
  })
})

test('a runtime that cannot be asked becomes a gap, never an empty column', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.claude/skills'), 'a', '---\nname: a\n---\nB')
    const library = await readLibrary(
      [agent('claudecode', new Error('not running'))],
      { home },
    )
    const gap = library.gaps.find((one) => one.runtime === runtimeId('claudecode'))
    assert.ok(gap, 'a runtime that threw must be recorded')
    assert.match(gap.reason, /not running/)
    // And the column still works, from disk.
    assert.equal(stateFor(library, 'a', 'claudecode'), 'reaches')
  })
})

test('a runtime with no known locations says so rather than reporting nothing', async () => {
  await withHome(async (home) => {
    const library = await readLibrary([agent('somenewagent')], { home })
    const gap = library.gaps.find((one) => one.kind === 'mcp')
    assert.ok(gap)
    assert.match(gap.reason, /No configuration location/)
  })
})

test('the summary separates partial reach from no reach at all', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.claude/skills'), 'both', '---\nname: both\n---\nB')
    await skill(join(home, '.cursor/skills'), 'both', '---\nname: both\n---\nB')
    await skill(join(home, '.claude/skills'), 'one', '---\nname: one\n---\nB')
    await skill(join(home, '.agents/skills'), 'none', '---\nname: none\n---\nB')

    const library = await readLibrary([agent('claudecode'), agent('cursor')], { home })
    const counts = summarise(library)
    assert.equal(counts.total, 3)
    assert.equal(counts.everywhere, 1, 'both')
    assert.equal(counts.partial, 1, 'one')
    assert.equal(counts.unreachable, 1, 'none — on disk, read by nobody')
  })
})

test('entryHasProblem is true for anything a person should act on', async () => {
  await withHome(async (home) => {
    await hollowSkill(join(home, '.claude/skills'), 'empty')
    await skill(join(home, '.claude/skills'), 'fine', '---\nname: fine\n---\nB')
    const library = await readLibrary([agent('claudecode')], { home })
    const empty = library.entries.find((one) => one.name === 'empty')
    const fine = library.entries.find((one) => one.name === 'fine')
    assert.equal(entryHasProblem(empty!), true)
    assert.equal(entryHasProblem(fine!), false)
  })
})

test('unscanned alone is not a problem — but reaching nobody is', async () => {
  await withHome(async (home) => {
    // One good copy where this agent looks, one where it never does. The
    // second copy makes an `unscanned` cell against every *other* agent; on a
    // machine with several agents that is the most common state there is, and
    // an entry with it must not land in the problems view for that alone.
    await skill(join(home, '.claude/skills'), 'seen', '---\nname: seen\n---\nB')
    await skill(join(home, '.agents/skills'), 'seen', '---\nname: seen\n---\nB')
    // A copy only where nobody looks: nothing in it is broken, and no agent
    // loads it — which is exactly what the problems view exists to surface.
    await skill(join(home, '.agents/skills'), 'stranded', '---\nname: stranded\n---\nB')
    // A good copy where the agent looks and a hollow one where nobody does.
    // No cell ever says `hollow` — no agent scans the directory — and the
    // hollow directory is still there, wearing the name. The predicate must
    // read the copies, not only the cells: this is 44 of the 48 problems on
    // the machine this page was built against.
    await skill(join(home, '.claude/skills'), 'shell', '---\nname: shell\n---\nB')
    await hollowSkill(join(home, '.agents/skills'), 'shell')
    const library = await readLibrary([agent('claudecode'), agent('cursor')], { home })
    const seen = library.entries.find((one) => one.name === 'seen')
    const stranded = library.entries.find((one) => one.name === 'stranded')
    const shell = library.entries.find((one) => one.name === 'shell')
    assert.equal(stateFor(library, 'seen', 'cursor'), 'unscanned')
    assert.equal(entryHasProblem(seen!), false, 'a copy an agent cannot see is not an alarm')
    assert.equal(entryHasProblem(stranded!), true, 'an entry no agent loads is')
    assert.equal(entryHasProblem(shell!), true, 'so is a hollow copy no agent scans')
  })
})

test('project-scope directories are read relative to the open workspace', async () => {
  await withHome(async (home) => {
    const project = join(home, 'workspace')
    await skill(join(project, '.claude/skills'), 'local', '---\nname: local\n---\nB')
    const library = await readLibrary([agent('claudecode')], { home, cwd: project })
    assert.equal(stateFor(library, 'local', 'claudecode'), 'reaches')
    const entry = library.entries.find((one) => one.name === 'local')
    assert.equal(entry?.copies[0]?.scope, 'project')
  })
})

test('with no workspace open, project locations are left out rather than guessed', async () => {
  await withHome(async (home) => {
    const library = await readLibrary([agent('claudecode')], { home })
    assert.equal(
      library.locations.every((one) => one.scope === 'user'),
      true,
    )
  })
})

test('reach is aligned to the runtime column order', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.claude/skills'), 'x', '---\nname: x\n---\nB')
    const library = await readLibrary([agent('codex'), agent('claudecode'), agent('cursor')], {
      home,
    })
    const entry = library.entries.find((one) => one.name === 'x')
    assert.ok(entry)
    assert.equal(entry.reach.length, library.runtimes.length)
    for (const [index, id] of library.runtimes.entries()) {
      assert.equal(entry.reach[index]?.runtime, id, 'column order must match reach order')
    }
  })
})

test('a server with sub-tables is one row, not one per sub-table', async () => {
  // Found by running the scanner against a real machine: `[mcp_servers.x.tools.y]`
  // tables turned one configured server into six library rows named after its
  // tools. The name is the first segment; everything under it is that server.
  await withHome(async (home) => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      join(home, '.codex/config.toml'),
      [
        '[mcp_servers.browser]',
        'command = "npx"',
        '',
        '[mcp_servers.browser.tools.click]',
        'enabled = true',
        '',
        '[mcp_servers.browser.tools.type]',
        'enabled = true',
        '',
        '[mcp_servers."quoted-name"]',
        'command = "x"',
        '',
      ].join('\n'),
    )
    const library = await readLibrary([agent('codex')], { home })
    const servers = library.entries.filter((one) => one.kind === 'mcp').map((one) => one.name)
    assert.deepEqual(servers.sort(), ['browser', 'quoted-name'])
  })
})

test('the summary counts hollow off the disk, not off who happens to read it', async () => {
  // Counting hollow only where an agent already scans the parent would report
  // the machine as healthier the fewer agents are installed — and the
  // directory is just as broken the day one starts reading it.
  await withHome(async (home) => {
    await hollowSkill(join(home, '.agents/skills'), 'shell')
    const library = await readLibrary([agent('claudecode')], { home })
    assert.equal(stateFor(library, 'shell', 'claudecode'), 'unscanned')
    assert.equal(summarise(library).hollow, 1, 'still hollow, whoever is looking')
  })
})

test('the summary counts a disagreement between copies no single agent reads', async () => {
  await withHome(async (home) => {
    await skill(join(home, '.claude/skills'), 'drift', '---\nname: drift\n---\nOne')
    await skill(join(home, '.agents/skills'), 'drift', '---\nname: drift\n---\nTwo')
    const library = await readLibrary([agent('claudecode')], { home })
    assert.equal(summarise(library).differs, 1)
  })
})

test('a block-scalar description is read, not left as its marker', async () => {
  // Found against a real machine: sixty skills wrote `description: |` with the
  // text on the following lines, and every row showed a description of "|".
  await withHome(async (home) => {
    await skill(
      join(home, '.claude/skills'),
      'autoplan',
      [
        '---',
        'name: autoplan',
        'version: 1.0.0',
        'description: |',
        '  Auto-review pipeline — reads the CEO, design and eng reviews',
        '  and runs them sequentially.',
        '---',
        'Body',
      ].join('\n'),
    )
    const library = await readLibrary([agent('claudecode')], { home })
    const entry = library.entries.find((one) => one.name === 'autoplan')
    assert.equal(
      entry?.description,
      'Auto-review pipeline — reads the CEO, design and eng reviews and runs them sequentially.',
    )
  })
})

test('an indented line is never mistaken for a key of its own', async () => {
  await withHome(async (home) => {
    await skill(
      join(home, '.claude/skills'),
      'x',
      ['---', 'description: |', '  name: not the name', '---', 'B'].join('\n'),
    )
    const library = await readLibrary([agent('claudecode')], { home })
    const entry = library.entries.find((one) => one.name === 'x')
    assert.equal(entry?.title, null, 'the indented `name:` belongs to the block above it')
    assert.equal(entry?.description, 'name: not the name')
  })
})

test('a server that reaches nobody is explained as a file, not a directory', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(join(home, '.codex/config.toml'), '[mcp_servers.linear]\ncommand = "npx"\n')
    const library = await readLibrary([agent('codex'), agent('claudecode')], { home })
    const entry = library.entries.find((one) => one.kind === 'mcp' && one.name === 'linear')
    assert.ok(entry)
    const claude = entry.reach[library.runtimes.indexOf(runtimeId('claudecode'))]
    assert.equal(claude?.state, 'unscanned')
    assert.match(claude?.note ?? '', /file this one does not read/)
    assert.doesNotMatch(claude?.note ?? '', /directory/)
  })
})

test('the activation detector reads every shape the transcripts actually take', () => {
  // Codex cats the file in a command item.
  assert.deepEqual(
    detectSkillActivations(
      "/bin/zsh -lc 'cat /Users/u/.agents/skills/using-superpowers/SKILL.md /Users/u/.agents/skills/brainstorming/SKILL.md'",
    ).toSorted(),
    ['brainstorming', 'using-superpowers'],
  )
  // A slash-command echo links the file; `.system` sits between `skills` and
  // the name, which is why the identity is SKILL.md's immediate parent.
  assert.deepEqual(
    detectSkillActivations('Use [$review-agent](/Users/u/.codex/skills/.system/review-agent/SKILL.md)'),
    ['review-agent'],
  )
  // Claude Code's bundled skills live under a hashed path; the parent is
  // still the name.
  assert.deepEqual(
    detectSkillActivations('cd "/tmp/bundled-skills/2.1.237/35f0c321/design" && wc -l SKILL.md; cat /tmp/bundled-skills/2.1.237/35f0c321/design/SKILL.md'),
    ['design'],
  )
  // Twice in one item is one activation of one skill, and prose without a
  // path stays silent.
  assert.deepEqual(detectSkillActivations('a/pdf/SKILL.md b/pdf/SKILL.md'), ['pdf'])
  assert.deepEqual(detectSkillActivations('mentioning SKILL.md by itself means nothing'), [])
})

test('a brand-less runtime’s guessed name still finds its table', () => {
  // "DeepSeek Harness" with no declared brand arrives as `deepseekharness`;
  // shipping without this alias made Cursor's and DSH's columns table-less,
  // reported only as a footnote gap.
  return withHome(async (home) => {
    await skill(join(home, '.dsh/skills'), 'greet', '---\nname: greet\n---\nB')
    const library = await readLibrary([agent('deepseekharness')], { home })
    assert.equal(stateFor(library, 'greet', 'deepseekharness'), 'reaches')
    assert.equal(library.gaps.filter((gap) => gap.kind === 'mcp').length, 0)
  })
})

test('a transport the target cannot spell shows as unhostable, with the reason', async () => {
  // The write path's canHost preflight, asked in the read direction: Codex's
  // TOML has no SSE spelling, so the cell says the pair cannot be hosted —
  // before anyone tries. A representable server (stdio) stays a quiet ring.
  await withHome(async (home) => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          events: { type: 'sse', url: 'https://events.test/sse' },
          fetcher: { command: 'npx', args: ['-y', 'fetch'] },
        },
      }),
    )
    const library = await readLibrary([agent('claudecode'), agent('codex')], { home })
    assert.equal(stateFor(library, 'events', 'codex'), 'unhostable')
    const entry = library.entries.find((one) => one.name === 'events')
    const cell = entry?.reach.find((one) => one.runtime === runtimeId('codex'))
    assert.match(cell?.note ?? '', /SSE/i)
    assert.equal(stateFor(library, 'fetcher', 'codex'), 'unscanned')
  })
})

test('a skill the agent has switched off is not reported as one it loads', async (t) => {
  // The bug: `listSkills` has always answered with each skill's `enabled`
  // flag, and the scan narrowed the answer to `{ name }` and threw it away —
  // so the one page built to be honest about reach said "Loads it" about a
  // skill the person had deliberately turned off.
  const root = await mkdtemp(join(tmpdir(), 'hd-off-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const claude: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review', enabled: false }],
  }
  const library = await readLibrary([claude], { home: root })
  const entry = library.entries.find((one) => one.name === 'review')
  assert.ok(entry)
  assert.equal(entry.reach[0]?.state, 'off')
  // Reported, never scanned: an on/off switch lives inside the agent and no
  // amount of reading directories can see it.
  assert.equal(entry.reach[0]?.basis, 'reported')
})

test('an agent that reports no enabled flag has nothing switched off', async (t) => {
  // Absent means on. An agent that does not model the distinction must not
  // have every skill read as disabled.
  const root = await mkdtemp(join(tmpdir(), 'hd-off-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const claude: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review' }],
  }
  const library = await readLibrary([claude], { home: root })
  assert.equal(library.entries.find((one) => one.name === 'review')?.reach[0]?.state, 'reaches')
})

test('switched off is a choice, not a problem', async (t) => {
  // A page that files a choice under defects teaches people to stop reading
  // its warnings. Off in the only agent that has it must not raise the
  // "on disk, loaded by nobody" finding.
  const root = await mkdtemp(join(tmpdir(), 'hd-off-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const claude: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review', enabled: false }],
  }
  const library = await readLibrary([claude], { home: root })
  const entry = library.entries.find((one) => one.name === 'review')
  assert.ok(entry)
  assert.equal(entryHasProblem(entry), false)
  assert.equal(summarise(library).off, 1)
  // It still does not reach: the count that drives the install offers has to
  // stay literal about what is loading.
  assert.equal(summarise(library).everywhere, 0)
})

test('reach carries the path the agent itself gave, not the one we found', async (t) => {
  // The two are not interchangeable and the difference fails silently: a
  // copy's path is the bundle directory this scan found on disk, and an agent
  // may key the same skill by its definition file. Asked to switch a skill
  // off with the directory, Codex writes a `[[skills.config]]` entry keyed on
  // a path it never matches — the write reports success, the config gains a
  // dead row, and the skill stays on.
  const root = await mkdtemp(join(tmpdir(), 'hd-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const own = join(root, '.claude', 'skills', 'review', 'SKILL.md')
  const claude: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review', path: own }],
  }
  const entry = (await readLibrary([claude], { home: root })).entries.find(
    (one) => one.name === 'review',
  )
  assert.ok(entry)
  assert.equal(entry.reach[0]?.reportedPath, own)
  // And it is genuinely a different string from the copy we found.
  assert.notEqual(entry.copies[0]?.path, own)
})

test('a switched-off skill keeps carrying its agent’s path', async (t) => {
  // The state that most needs it: turning one back *on* addresses the same
  // agent by the same spelling.
  const root = await mkdtemp(join(tmpdir(), 'hd-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const own = join(root, '.claude', 'skills', 'review', 'SKILL.md')
  const claude: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review', path: own, enabled: false }],
  }
  const entry = (await readLibrary([claude], { home: root })).entries.find(
    (one) => one.name === 'review',
  )
  assert.equal(entry?.reach[0]?.state, 'off')
  assert.equal(entry?.reach[0]?.reportedPath, own)
})

test('an agent that reports no path leaves the caller to match by name', async (t) => {
  // Absent, not empty: the sheet sends null and the agent matches on the name,
  // which is the only other thing both sides agree on.
  const root = await mkdtemp(join(tmpdir(), 'hd-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const claude: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review' }],
  }
  const entry = (await readLibrary([claude], { home: root })).entries.find(
    (one) => one.name === 'review',
  )
  assert.equal(entry?.reach[0]?.reportedPath, undefined)
})

test('an agent that refuses client toggles says so on its reach', async (t) => {
  // Measured 2026-08-31: of four agents, only Codex implements the write.
  // Claude Code and Cursor answer over ACP, where a skill is a command the
  // agent declares for the session — `SkillInfo.toggleable` is false and the
  // library has to carry that, because it is the one surface that draws a
  // control per agent.
  const root = await mkdtemp(join(tmpdir(), 'hd-fixed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const acp: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review', toggleable: false }],
  }
  const entry = (await readLibrary([acp], { home: root })).entries.find(
    (one) => one.name === 'review',
  )
  assert.equal(entry?.reach[0]?.state, 'reaches')
  assert.equal(entry?.reach[0]?.toggleable, false)
})

test('an agent that says nothing about toggling is assumed to allow it', async (t) => {
  // Absent means yes, matching `SkillInfo`: an agent with no such concept has
  // nothing it refuses to switch, and Codex — which does implement it —
  // reports no flag at all.
  const root = await mkdtemp(join(tmpdir(), 'hd-fixed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await skill(join(root, '.claude', 'skills'), 'review', '---\nname: review\n---\n\nBody.')

  const agent: InventoryAgent = {
    id: runtimeId('claude'),
    brand: 'claude',
    listSkills: async () => [{ name: 'review' }],
  }
  const entry = (await readLibrary([agent], { home: root })).entries.find(
    (one) => one.name === 'review',
  )
  assert.equal(entry?.reach[0]?.toggleable, true)
})
