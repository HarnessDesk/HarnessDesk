import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { firstSentence, render } from './cli-doc.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(root, 'script/cli-doc.mjs')

/**
 * The command-line reference generator, and the gate step that holds
 * `docs/cli.md` to it.
 *
 * `render` is pure, so most of this hands it a command table of its own: the
 * output has to carry everything the table says, and nothing in the table may
 * change without the output changing, because that is what lets a gate that
 * compares the committed file with `render`'s answer notice a stale one. The
 * rest runs the command itself, against files in a temporary folder, to prove
 * the step goes red on a stale file and green on a current one.
 */

const sample = () => ({
  commands: [
    {
      name: 'ping',
      tier: 'read',
      usage: 'ping [--count N]',
      description: 'Pings the desk once. It waits for one answer and prints it.',
      arguments: [],
      options: [{ flag: '--count', value: 'N', description: 'How many times to ping.' }],
      json: 'A single object, `{ "ok": true }`.',
      exits: { 0: 'Pinged.', 3: 'The desk is not there.' },
    },
    {
      name: 'pour out',
      tier: 'answer',
      usage: 'pour out <cup> [--yes]',
      description: 'Pours a cup out. Mind the floor.',
      arguments: [{ name: 'cup', description: 'Which cup | the one to pour.' }],
      options: [{ flag: '--yes', description: 'Say yes without being asked.' }],
      json: 'The cup, `null` once it is empty.',
      exits: { 0: 'Poured.', 4: 'Refused | the tier is off.' },
    },
  ],
  exitCodes: { 0: 'Done.', 3: 'No desk.', 4: 'Refused | with a pipe in it.', 130: 'Interrupted.' },
  globalOptions: [
    { flag: '--home', value: 'DIR', description: 'The desk to talk to.' },
    { flag: '--json', description: 'Print JSON.' },
  ],
})

test('every command gets a section with what the table says about it', () => {
  const text = render(sample())
  assert.match(text, /^# The `harnessdesk` command line\n/)
  assert.match(text, /Do not edit — change the table and run `pnpm cli:doc`/)

  assert.ok(text.includes('### `harnessdesk pour out`\n\n```\nharnessdesk pour out <cup> [--yes]\n```\n\nPours a cup out. Mind the floor.\n\nNeeds the **answer** tier.\n'))
  assert.ok(text.includes('**Arguments**\n\n- `<cup>`: Which cup | the one to pour.\n'))
  assert.ok(text.includes('**Flags**\n\n- `--yes`: Say yes without being asked.\n'))
  assert.ok(text.includes('**With `--json`**\n\nThe cup, `null` once it is empty.\n'))
  assert.ok(text.includes('**Exit codes**\n\n- `0`: Poured.\n- `4`: Refused | the tier is off.\n'))

  // A value is part of how a flag is typed.
  assert.ok(text.includes('- `--count N`: How many times to ping.\n'))
  assert.ok(text.includes('- `--home DIR`: The desk to talk to.\n'))
  assert.ok(text.includes('- `--json`: Print JSON.\n'))
})

test('a command with no arguments and no flags has no empty headings', () => {
  const section = render(sample()).split('### `harnessdesk ping`')[1].split('### `harnessdesk pour out`')[0]
  assert.doesNotMatch(section, /\*\*Arguments\*\*/)
  assert.match(section, /\*\*Flags\*\*/)

  const bare = sample()
  bare.commands[0].options = []
  const without = render(bare).split('### `harnessdesk ping`')[1].split('### `harnessdesk pour out`')[0]
  assert.doesNotMatch(without, /\*\*Flags\*\*/)
  assert.doesNotMatch(without, /\*\*Arguments\*\*/)
})

test('the table at the top gives each command, its first sentence, its tier and a link, with pipes escaped', () => {
  const text = render(sample())
  assert.ok(text.includes('| [`ping`](#harnessdesk-ping) | Pings the desk once. | read |\n'))
  assert.ok(text.includes('| [`pour out`](#harnessdesk-pour-out) | Pours a cup out. | answer |\n'))
  assert.ok(text.includes('| 4 | Refused \\| with a pipe in it. |\n'), 'a pipe in a table cell is escaped')
  // The exit codes come in the order of their numbers.
  assert.ok(text.indexOf('| 0 | Done. |') < text.indexOf('| 3 | No desk. |'))
  assert.ok(text.indexOf('| 3 | No desk. |') < text.indexOf('| 130 | Interrupted. |'))
})

test('the first sentence is the first sentence, wherever the stop is', () => {
  assert.equal(firstSentence('Lists the desks. It prints them.'), 'Lists the desks.')
  assert.equal(firstSentence('Only one sentence.'), 'Only one sentence.')
  assert.equal(firstSentence('No full stop at all'), 'No full stop at all')
  assert.equal(firstSentence('Says what `a.b` is. Then more.'), 'Says what `a.b` is.')
})

test('the commands that ask first are found from their --yes flag, not named by hand', () => {
  const ask = (text) => text.split('\n').find((line) => /ask first|asks first/.test(line))
  assert.match(ask(render(sample())), /The command that starts, stops or abandons work asks first: `pour out`\. On a terminal it asks a yes-or-no question; with no terminal it needs `--yes`, and without either it exits 2\./)

  const two = sample()
  two.commands[0].options = [...two.commands[0].options, { flag: '--yes', description: 'Yes.' }]
  assert.match(ask(render(two)), /The commands that start, stop or abandon work ask first: `ping` and `pour out`\. On a terminal they ask a yes-or-no question; with no terminal they need `--yes`, and without either they exit 2\./)

  const none = sample()
  none.commands[1].options = []
  assert.equal(ask(render(none)), undefined, 'with nothing that asks, no sentence says that something does')
})

test('the output is deterministic, ends in one newline and never leaves a run of blank lines', () => {
  const text = render(sample())
  assert.equal(render(sample()), text)
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'))
  assert.doesNotMatch(text, /\n{3,}/)
})

test('nothing in the table can change without the reference changing', () => {
  const base = render(sample())
  const edits = {
    'a description': (table) => { table.commands[0].description = 'Pings the desk twice.' },
    'a usage line': (table) => { table.commands[0].usage = 'ping [--times N]' },
    'a tier': (table) => { table.commands[0].tier = 'run' },
    'an argument': (table) => { table.commands[1].arguments[0].description = 'Which mug.' },
    'a flag': (table) => { table.commands[0].options[0].value = 'COUNT' },
    'a flag’s words': (table) => { table.commands[0].options[0].description = 'How often.' },
    'the JSON shape': (table) => { table.commands[0].json = 'Nothing, now.' },
    'a command’s exit code': (table) => { table.commands[1].exits[4] = 'Refused outright.' },
    'an added exit code': (table) => { table.commands[0].exits[8] = 'Timed out.' },
    'the exit table': (table) => { table.exitCodes[3] = 'No desk is running.' },
    'a global flag': (table) => { table.globalOptions[0].description = 'Which desk.' },
    'a new command': (table) => { table.commands.push({ ...table.commands[0], name: 'pong' }) },
    'a removed command': (table) => { table.commands.pop() },
  }
  for (const [what, edit] of Object.entries(edits)) {
    const table = sample()
    edit(table)
    assert.notEqual(render(table), base, `${what} is in the reference`)
  }
})

/* ---- the real table, and the gate step ---------------------------------------------- */

const built = join(root, 'packages/cli/dist/src/cli.js')
const needsBuild = 'The command line is not built, so its command table cannot be read: run pnpm build:node first.'

test('every command in the real table has its section, its usage and its tier in the reference', async () => {
  assert.ok(existsSync(built), needsBuild)
  const { COMMANDS } = await import(pathToFileURL(built).href)
  const { EXIT_CODES, GLOBAL_OPTIONS } = await import(pathToFileURL(join(root, 'packages/cli/dist/src/reference.js')).href)
  const text = render({ commands: COMMANDS, exitCodes: EXIT_CODES, globalOptions: GLOBAL_OPTIONS })
  assert.ok(COMMANDS.length >= 17)
  for (const command of COMMANDS) {
    assert.ok(text.includes(`### \`harnessdesk ${command.name}\`\n`), `${command.name}: a section`)
    assert.ok(text.includes(`harnessdesk ${command.usage}\n`), `${command.name}: its usage`)
    assert.ok(text.includes(`Needs the **${command.tier}** tier.`), `${command.name}: its tier`)
    assert.ok(text.includes(command.description), `${command.name}: its description`)
    for (const code of Object.keys(command.exits)) assert.ok(text.includes(`- \`${code}\`: ${command.exits[code]}`), `${command.name}: exit ${code}`)
  }
  for (const code of Object.keys(EXIT_CODES)) assert.ok(text.includes(`| ${code} |`), `exit code ${code} in the table`)
})

const runScript = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })

test('the gate step goes red on a stale file, and says how to fix it', () => {
  assert.ok(existsSync(built), needsBuild)
  const directory = mkdtempSync(join(tmpdir(), 'hd-cli-doc-'))
  try {
    const file = join(directory, 'cli.md')

    const missing = runScript('--check', '--file', file)
    assert.equal(missing.status, 1, 'a reference that is not there is stale')
    assert.match(missing.stderr, /is stale\. Run: pnpm cli:doc/)

    const written = runScript('--file', file)
    assert.equal(written.status, 0, written.stderr)
    assert.match(written.stdout, /^wrote /)
    assert.equal(runScript('--check', '--file', file).status, 0, 'the file the generator just wrote is current')
    assert.match(runScript('--check', '--file', file).stdout, /is current\./)

    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace('Lists the desks running for you', 'Lists some desks'))
    const stale = runScript('--check', '--file', file)
    assert.equal(stale.status, 1, 'a hand edit makes it stale')
    assert.match(stale.stderr, /is stale\. Run: pnpm cli:doc/)

    // A table that moved on without the file is the same thing: the file below is
    // what the reference said before a flag's words changed.
    writeFileSync(file, text.replace('Print JSON on stdout instead of text', 'Print JSON'))
    assert.equal(runScript('--check', '--file', file).status, 1)

    assert.equal(runScript('--file', file).status, 0)
    assert.equal(readFileSync(file, 'utf8'), text, 'writing again restores exactly what the table says')
    assert.equal(runScript('--check', '--file', file).status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the gate step still runs when it is reached through a link, rather than exit 0 having done nothing', () => {
  assert.ok(existsSync(built), needsBuild)
  const directory = mkdtempSync(join(tmpdir(), 'hd-cli-doc-link-'))
  try {
    const link = join(directory, 'cli-doc.mjs')
    symlinkSync(SCRIPT, link)
    const run = spawnSync(process.execPath, [link, '--check', '--file', join(directory, 'missing.md')], { cwd: directory, encoding: 'utf8' })
    assert.equal(run.status, 1, run.stdout)
    assert.match(run.stderr, /is stale/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the gate step refuses to read a command line that is not built, rather than pass over nothing', () => {
  // The script finds the command line by a fixed place, so prove the message
  // by pointing a copy of it at an empty tree.
  const directory = mkdtempSync(join(tmpdir(), 'hd-cli-doc-empty-'))
  try {
    const copy = join(directory, 'script')
    mkdirSync(copy)
    writeFileSync(join(copy, 'cli-doc.mjs'), readFileSync(SCRIPT, 'utf8'))
    const run = spawnSync(process.execPath, [join(copy, 'cli-doc.mjs'), '--check'], { cwd: directory, encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /command line is not built/)
    assert.match(run.stderr, /pnpm build:node/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
