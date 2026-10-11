import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { CLIENT_METHODS, clientTierFor } from '@harnessdesk/protocol'
import { WireCallError } from '@harnessdesk/client'
import { COMMANDS, FLAG_KEYS, GLOBAL_FLAG_KEYS, errorText, main, sanitizeHuman, parseArgs, errorExit } from '../src/cli.js'
import { EXIT_CODES, GLOBAL_OPTIONS, type OptionDoc } from '../src/reference.js'

test('the executable command table covers exactly the declared client surface', () => {
  assert.deepEqual(COMMANDS.map(command => command.name), ['desks', 'status', 'teams', 'runs', 'watch', 'open', 'flows', 'flow preview', 'flow start', 'run show', 'run stop', 'run wait', 'library list', 'library show', 'card show', 'card handoff', 'card answer', 'card abandon', 'waiting'])
  const methods = new Set(COMMANDS.flatMap(command => [...command.methods]))
  for (const command of COMMANDS) for (const method of command.methods) { const tier = clientTierFor(method, 'action' in command ? { action: command.action } : undefined); assert.ok(tier === 'read' || tier === command.tier, `${command.name}: ${method}`) }
  for (const method of methods) assert.ok(Object.hasOwn(CLIENT_METHODS, method), method)
  assert.deepEqual([...methods].sort(), Object.keys(CLIENT_METHODS).sort())
})

test('library command arguments and option ownership are strict', () => {
  assert.deepEqual(parseArgs(['library', 'list', '--project', '.', '--kind', 'mcp', '--issues']), {
    command: 'library list', project: '.', kind: 'mcp', issues: true,
  })
  assert.deepEqual(parseArgs(['library', 'show', 'demo-skill', '--text']), {
    command: 'library show', target: 'demo-skill', text: true,
  })
  assert.deepEqual(parseArgs(['--json', 'library', 'show', 'demo-skill', '--kind', 'skill']), {
    command: 'library show', target: 'demo-skill', json: true, kind: 'skill',
  })
  for (const args of [
    ['library', 'list', '--text'], ['library', 'show'], ['library', 'show', 'demo', '--issues'],
    ['library', 'list', '--kind', 'plugin'], ['library', 'show', 'demo', '--kind', 'plugin'],
    ['library', 'list', '--kind', 'skill', '--kind', 'mcp'], ['library', 'show', 'demo', 'extra'],
  ]) assert.throws(() => parseArgs(args), /usage/i, args.join(' '))
})

test('human text removes C0/C1, CSI, OSC hyperlinks and clipboard, and DCS payloads', () => {
  assert.equal(sanitizeHuman('hi\x1b[31mred\x1b[0m\n\r\t\0\x7f\x85!'), 'hired!')
  assert.equal(sanitizeHuman('\x1b]8;;https://example.com\x1b\\title\x1b]8;;\x1b\\'), 'title')
  assert.equal(sanitizeHuman('a\x1b]52;c;cGF5bG9hZA==\x07b\x1bPsecret\x1b\\c'), 'abc')
  assert.equal(sanitizeHuman('a\x9b31mb\x9d52;c;secret\x9cc'), 'abc')
  assert.equal(sanitizeHuman('Jane Doe — 東京'), 'Jane Doe — 東京')
})

test('arguments permit global flags around a command and validate scopes and command flags', () => {
  assert.deepEqual(parseArgs(['--home', '/tmp/demo', 'runs', '--json', '--all', '--project', '.']), { command: 'runs', home: '/tmp/demo', json: true, all: true, project: '.' })
  assert.deepEqual(parseArgs(['status', '--team', 'demo-team', '--json']), { command: 'status', team: 'demo-team', json: true })
  assert.deepEqual(parseArgs(['watch', '--run', 'r-demo', '--until', 'settled', '--trace-wire']), { command: 'watch', run: 'r-demo', until: 'settled', traceWire: true })
  for (const args of [[], ['open'], ['runs', '--team', 'g', '--project', '.'], ['watch', '--until', 'settled'], ['watch', '--until', 'waiting'], ['teams', '--all'], ['status', '--raw'], ['watch', '--run'], ['status', 'extra'], ['runs', '--all', '--all'], ['status', '--credential', 'x']]) {
    assert.throws(() => parseArgs(args), /usage/i, args.join(' '))
  }
})

test('exit codes preserve client boundary and compatibility refusals', () => {
  for (const [code, expected] of [['noDesk', 3], ['unsafeDirectory', 4], ['unsafeSocket', 4], ['unsafePointer', 4], ['tierNotGranted', 4], ['notOnClientSurface', 4], ['helloFirst', 4], ['badRequest', 4], ['incompatible', 6], ['deskTooOld', 6], ['deadline', 1], ['methodFailed', 1]] as const) {
    assert.equal(errorExit(new WireCallError(code, 'demo')), expected, code)
  }
  assert.equal(errorExit(new Error('error')), 1)
})


test('flow arguments accept one target and repeated inputs and seats, with strict flag ownership', () => {
  assert.deepEqual(parseArgs(['flow', 'preview', './demo.yaml', '--seat', 'writer=fake/high', '--seat', 'reviewer=fake,fake', '--input', 'brief=@brief.md', '--input', 'title=Demo', '--unattended']), {
    command: 'flow preview', target: './demo.yaml', seat: ['writer=fake/high', 'reviewer=fake,fake'], input: ['brief=@brief.md', 'title=Demo'], unattended: true,
  })
  assert.equal(parseArgs(['flow', 'start', 'demo', '--yes']).yes, true)
  assert.equal(parseArgs(['open', '.']).target, '.')
  for (const args of [['flow', 'preview'], ['flow', 'start', 'demo', '--raw'], ['flow', 'preview', 'demo', '--yes'], ['open', '.', 'extra'], ['flows', '--seat', 'writer=fake']]) assert.throws(() => parseArgs(args), /usage/i)
})


test('run wait timeout is a finite non-negative number of seconds within timer range', () => {
  assert.equal(parseArgs(['run', 'show', 'demo']).target, 'demo')
  assert.equal(parseArgs(['run', 'wait', 'demo', '--timeout', '0.1']).timeout, '0.1')
  for (const value of ['NaN', 'Infinity', '-1', '2147484', '']) assert.throws(() => parseArgs(['run', 'wait', 'demo', '--timeout', value]), /usage/i)
  assert.throws(() => parseArgs(['run', 'show', 'demo', '--timeout', '1']), /usage/i)
})


test('run stop takes its required reason only from the flag', () => {
  assert.deepEqual(parseArgs(['run', 'stop', 'r-demo', '--reason', 'Changed', '--yes']), { command: 'run stop', target: 'r-demo', reason: 'Changed', yes: true })
  for (const args of [['run', 'stop', 'r-demo'], ['run', 'stop', 'r-demo', 'Changed'], ['run', 'stop', 'r-demo', '--reason', '  ']]) assert.throws(() => parseArgs(args), /usage/i)
})


test('card arguments bind team, card and outcome positionally; text stays in named flags', () => {
  assert.deepEqual(parseArgs(['card', 'answer', 'g', '1', 'shipped', '--context-file', '-']), { command: 'card answer', team: 'g', card: '1', outcome: 'shipped', contextFile: '-' })
  assert.deepEqual(parseArgs(['card', 'abandon', 'g', '1', '--reason', 'Changed', '--yes']), { command: 'card abandon', team: 'g', card: '1', reason: 'Changed', yes: true })
  assert.equal(parseArgs(['waiting', '--watch']).watch, true)
  for (const args of [['card', 'show', 'g'], ['card', 'answer', 'g', '1'], ['card', 'answer', 'g', '1', 'shipped', 'text'], ['card', 'abandon', 'g', '1'], ['card', 'handoff', 'g', '1', '--yes'], ['waiting', '--reason', 'text']]) assert.throws(() => parseArgs(args), /usage/i)
})


/*
 * The table is also what `docs/cli.md` is written from (`script/cli-doc.mjs`),
 * so what it says has to be what the parser does. These tests hold the two to
 * each other: the reference cannot describe a command line the parser would
 * refuse, nor leave a flag the parser accepts undocumented.
 */

const keyOf = (flag: string) => FLAG_KEYS[flag]
/** A command's options as the reference types them: the literal table narrows a flag with no value to a type without the field. */
const optionsOf = (command: (typeof COMMANDS)[number]): readonly OptionDoc[] => command.options
const placeholders = (usage: string) => [...usage.matchAll(/<([a-z]+)>/g)].map(hit => hit[1]!)
/** The flags in a usage line, and whether each is required: outside every `[…]`. */
const usageFlags = (usage: string) => {
  const required = new Set([...usage.replace(/\[[^\]]*\]/g, ' ').matchAll(/(--[a-z-]+)/g)].map(hit => hit[1]!))
  return [...usage.matchAll(/(--[a-z-]+)/g)].map(hit => ({ flag: hit[1]!, required: required.has(hit[1]!) }))
}
const SAMPLE_ARGUMENT: Readonly<Record<string, string>> = { team: 'team-1', card: '1', outcome: 'shipped', run: 'run-1', flow: 'review-pr', path: '.' }
const SAMPLE_VALUE = (value: string | undefined) => value === undefined ? undefined : value === 'SECONDS' ? '5' : value === 'settled' ? 'settled' : value === 'PATH|-' ? '-' : value === 'skill|mcp' ? 'skill' : value.startsWith('ROLE=') ? 'writer=fake/high' : value === 'NAME=VALUE' ? 'a=b' : 'x'

test('every command is described for the reference, and says how it can end', () => {
  for (const command of COMMANDS) {
    assert.ok(command.description.length > 40, `${command.name}: a description`)
    assert.match(command.description.split(/(?<=\.) /)[0]!, /^[A-Z].{10,120}\.$/, `${command.name}: the first sentence reads as a summary on its own`)
    assert.ok(command.usage === command.name || command.usage.startsWith(`${command.name} `), `${command.name}: usage starts with the command`)
    assert.ok(command.json.length > 10, `${command.name}: its --json shape`)
    assert.ok(Object.hasOwn(command.exits, 0), `${command.name}: what exit 0 means`)
    for (const code of Object.keys(command.exits)) assert.ok(Object.hasOwn(EXIT_CODES, code), `${command.name}: exit ${code} is a code the command line has`)
    assert.ok(['read', 'run', 'answer'].includes(command.tier), `${command.name}: its tier`)
  }
})

test('usage, arguments and options agree with each other and with the flags the parser takes', () => {
  for (const command of COMMANDS) {
    assert.deepEqual(command.arguments.map(argument => argument.name), placeholders(command.usage), `${command.name}: arguments in the order usage gives them`)
    for (const argument of command.arguments) assert.ok(argument.description.length > 10, `${command.name} <${argument.name}>: described`)

    const inUsage = usageFlags(command.usage).map(entry => entry.flag)
    assert.deepEqual([...new Set(inUsage)].sort(), command.options.map(option => option.flag).sort(), `${command.name}: usage names exactly the options it documents`)
    for (const option of command.options) {
      assert.ok(option.description.length > 10, `${command.name} ${option.flag}: described`)
      assert.ok(Object.hasOwn(FLAG_KEYS, option.flag), `${command.name}: ${option.flag} is a flag`)
      assert.ok((command.flags as readonly string[]).includes(keyOf(option.flag)!), `${command.name}: ${option.flag} is one the parser lets it take`)
      assert.ok(!GLOBAL_OPTIONS.some(global => global.flag === option.flag), `${command.name}: ${option.flag} is global, so it is not repeated`)
    }
    // A flag the parser lets a command take is documented, unless it is the same word as an argument.
    const documented = new Set(command.options.map(option => keyOf(option.flag)))
    const positional = new Set(placeholders(command.usage))
    for (const key of command.flags) {
      const spelling = Object.keys(FLAG_KEYS).find(flag => FLAG_KEYS[flag] === key)
      if (spelling === undefined) assert.ok(positional.size > 0 || key === 'target', `${command.name}: ${key} is positional`)
      else if (!positional.has(key)) assert.ok(documented.has(key), `${command.name}: ${spelling} is accepted and not documented`)
    }
  }
})

test('the global flags are the three the parser treats as global', () => {
  assert.deepEqual(GLOBAL_OPTIONS.map(option => keyOf(option.flag)), [...GLOBAL_FLAG_KEYS])
  for (const option of GLOBAL_OPTIONS) assert.ok(option.description.length > 10, option.flag)
})

test('the usage line of every command, and each option it documents, is accepted by the parser', () => {
  for (const command of COMMANDS) {
    const words = command.name.split(' ')
    const given = command.arguments.map(argument => SAMPLE_ARGUMENT[argument.name] ?? 'x')
    const required = usageFlags(command.usage).filter(entry => entry.required).flatMap(entry => {
      const value = SAMPLE_VALUE(optionsOf(command).find(option => option.flag === entry.flag)?.value)
      return value === undefined ? [entry.flag] : [entry.flag, value]
    })
    assert.equal(parseArgs([...words, ...given, ...required]).command, command.name, `${command.name}: its usage line`)
    for (const option of optionsOf(command)) {
      const value = SAMPLE_VALUE(option.value)
      const extra = [option.flag, ...(value === undefined ? [] : [value])]
      // `--until` is meaningless without the run it ends on.
      const needs = option.flag === '--until' ? ['--run', 'run-1'] : []
      const args = [...words, ...given, ...required.filter(flag => flag !== option.flag && (value === undefined || flag !== value)), ...needs, ...extra]
      assert.equal(parseArgs(args).command, command.name, `${command.name}: ${option.flag} is accepted`)
    }
    // And what usage calls required really is: leaving it out is a usage error.
    for (const entry of usageFlags(command.usage).filter(one => one.required)) {
      const without = required.filter((_, at) => required[at] !== entry.flag && required[at - 1] !== entry.flag)
      assert.throws(() => parseArgs([...words, ...given, ...without]), /usage/i, `${command.name}: ${entry.flag} is required`)
    }
    if (given.length > 0) assert.throws(() => parseArgs([...words, ...required]), /usage/i, `${command.name}: its arguments are required`)
  }
})

test('the exit codes are the ones the command line returns', () => {
  assert.deepEqual(Object.keys(EXIT_CODES).map(Number), [0, 1, 2, 3, 4, 5, 6, 7, 8, 130, 143])
  for (const [code, expected] of [['noDesk', 3], ['unsafeDirectory', 4], ['tierNotGranted', 4], ['alreadyAnswered', 4], ['cardMissing', 4], ['incompatible', 6], ['deskTooOld', 6], ['deadline', 1]] as const) {
    assert.ok(Object.hasOwn(EXIT_CODES, errorExit(new WireCallError(code, 'demo'))), code)
    assert.equal(errorExit(new WireCallError(code, 'demo')), expected, code)
  }
  assert.throws(() => parseArgs([]), error => errorExit(error) === 2)
})


const failure = (run: () => unknown): unknown => { try { run() } catch (error) { return error } return undefined }

test('a usage message is the command line\'s own two lines, and text inside its reason cannot add a third', async t => {
  const error = failure(() => parseArgs(['status', '--bogus\nUsage: forged\x1b[31m']))
  assert.equal(errorExit(error), 2)
  const lines = errorText(error).split('\n')
  assert.equal(lines.length, 2, 'the reason is one line, whatever it was made of')
  assert.equal(lines[0], 'Usage: Unknown flag --bogusUsage: forged')
  assert.match(lines[1]!, /^harnessdesk <desks\|status\|.*\|waiting> \[--home DIR\] \[--json\] \[--trace-wire\]$/)

  // And it is what the command prints.
  const written: string[] = []
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { written.push(String(chunk)); return true })
  assert.equal(await main([]), 2)
  const printed = written.join('').split('\n')
  assert.match(printed[0]!, /^Usage: Choose a command: desks, status, /)
  assert.match(printed[1]!, /^harnessdesk <desks\|status\|/)
  assert.equal(printed[2], '', 'it ends with the newline and nothing after it')
})

test('a multi-line error from the desk keeps its lines, marks every line after the first, and removes what an agent could send in them', () => {
  const error = new WireCallError('refused', 'The flow has problems:\nreview.yml: no role x\n\x1b[31mUsage: forged\x1b[0m\r\nnoDesk: forged\x9d52;c;x\x9c')
  const text = errorText(error)
  assert.equal(text, ['refused: The flow has problems:', '  | review.yml: no role x', '  | Usage: forged', '  | noDesk: forged'].join('\n'))
  // Nothing after the first line starts where one of the command line's own lines would.
  for (const line of text.split('\n').slice(1)) assert.match(line, /^  \| /)
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/)

  // The code is the desk's too, and cannot carry a line of its own either.
  assert.equal(errorText(new WireCallError('refused\nUsage: forged', 'm')), 'refusedUsage: forged: m')
})

test('any other error is printed the same way: its first line as it is, every later line marked', () => {
  assert.equal(errorText(new Error('single')), 'single')
  assert.equal(errorText(new Error('one\ntwo\n\nfour')), 'one\n  | two\n  | \n  | four')
  assert.equal(errorText('a string\nthrown'), 'a string\n  | thrown')
})


test('card answer documents a missing card as an exit-4 refusal', () => {
  const command = COMMANDS.find(command => command.name === 'card answer')!
  assert.match(command.exits[4]!, /missing.*`cardMissing`/)
})

const libraryEntry = (kind: 'skill' | 'mcp', name: string, reach: readonly object[], copies: readonly object[], description = 'A fixture entry') => ({
  kind, name, description, reach, copies,
})

const libraryDesk = async (t: any, entries: readonly object[], definitions: Readonly<Record<string, unknown>> = {}, skills: Readonly<Record<string, unknown>> = {}) => {
  const directory = await mkdtemp('/tmp/hd-cli-library-')
  await chmod(directory, 0o700)
  const homePath = join(directory, 'home')
  await mkdir(homePath)
  const home = await realpath(homePath)
  const socketPath = join(directory, `${createHash('sha256').update(home).digest('hex').slice(0, 16)}.sock`)
  const server = createServer()
  const sockets = new WebSocketServer({ noServer: true })
  const calls: { method: string; params: unknown }[] = []
  const runtimes = ['runtime-a', 'runtime-b', 'runtime-c', 'runtime-d'].map((id, index) => ({ id, name: `Agent ${index + 1}` }))
  const hello = {
    protocolVersion: 1, hostVersion: 'fixture', desk: { home, pid: process.pid, startedAt: 1 },
    tiers: ['read'], methods: Object.keys(CLIENT_METHODS), runtimes,
  }
  const library = { generatedAt: 1, home: '/home/jane', runtimes: runtimes.map(runtime => runtime.id), locations: [], entries, gaps: [] }
  const usage = { generatedAt: 1, sessionsScanned: 3, skills }
  server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => {
    ws.on('message', raw => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> }
      calls.push({ method: request.method, params: request.params })
      const result = request.method === 'client/hello' ? hello
        : request.method === 'library/read' ? library
          : request.method === 'library/usage' ? usage
            : request.method === 'library/definition' ? definitions[String(request.params['path'])] ?? null
              : null
      ws.send(JSON.stringify({ id: request.id, ok: true, result }))
    })
  }))
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  await chmod(socketPath, 0o600)
  await writeFile(socketPath.replace(/\.sock$/, '.json'), JSON.stringify({
    home, pid: process.pid, startedAt: 1, hostVersion: 'fixture', protocolVersion: 1,
  }), { mode: 0o600 })
  const previousClientDir = process.env['HARNESSDESK_CLIENT_DIR']
  const previousHarnessHome = process.env['HARNESSDESK_HOME']
  process.env['HARNESSDESK_CLIENT_DIR'] = directory
  process.env['HARNESSDESK_HOME'] = home
  t.after(async () => {
    if (previousClientDir === undefined) delete process.env['HARNESSDESK_CLIENT_DIR']
    else process.env['HARNESSDESK_CLIENT_DIR'] = previousClientDir
    if (previousHarnessHome === undefined) delete process.env['HARNESSDESK_HOME']
    else process.env['HARNESSDESK_HOME'] = previousHarnessHome
    for (const ws of sockets.clients) ws.terminate()
    await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve())))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { home, directory, library, calls }
}

const runCli = async (t: any, args: readonly string[]) => {
  const stdout: string[] = [], stderr: string[] = []
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true })
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true })
  const code = await main(args)
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

test('library list filters issue rows, reports reach and differing copies, and sends only a read request', async t => {
  const healthy = libraryEntry('skill', 'plain-skill', Array.from({ length: 4 }, (_, i) => ({ runtime: `runtime-${String.fromCharCode(97 + i)}`, state: 'reaches' })), [])
  const issue = libraryEntry('skill', 'split-skill', [
    { runtime: 'runtime-a', state: 'reaches' }, { runtime: 'runtime-b', state: 'reaches' },
    { runtime: 'runtime-c', state: 'rejected' }, { runtime: 'runtime-d', state: 'absent' },
  ], [
    { path: '/home/jane/.agents/skills/split-skill', scope: 'user', readBy: ['runtime-a'], hollow: false, digest: 'a', readOnly: false },
    { path: '/home/jane/.codex/skills/split-skill', scope: 'user', readBy: ['runtime-b'], hollow: false, digest: 'b', readOnly: false },
  ])
  const mcp = libraryEntry('mcp', 'fixture-server', [{ runtime: 'runtime-a', state: 'rejected' }], [])
  const rig = await libraryDesk(t, [healthy, issue, mcp])
  const projectPath = join(rig.directory, 'project')
  await mkdir(projectPath)
  const project = await realpath(projectPath)
  const result = await runCli(t, ['library', 'list', '--project', project, '--kind', 'skill', '--issues'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'skill  split-skill  in 2 of 4 · 1 differs  issue\n')
  assert.deepEqual(rig.calls.map(call => call.method), ['client/hello', 'library/read'])
  assert.deepEqual(rig.calls[1]!.params, { cwd: project })
})

test('library list JSON keeps the read model and filters only its entries', async t => {
  const skill = libraryEntry('skill', 'one-skill', [], [])
  const mcp = libraryEntry('mcp', 'one-server', [], [])
  const rig = await libraryDesk(t, [skill, mcp])
  const result = await runCli(t, ['library', 'list', '--json', '--kind', 'mcp'])
  assert.equal(result.code, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed, { home: rig.library.home, runtimes: rig.library.runtimes, entries: [mcp] })
})

test('library show sanitizes descriptions and prints copies, agent reach, usage and definition files', async t => {
  const entry = libraryEntry('skill', 'demo-skill', [
    { runtime: 'runtime-a', state: 'reaches', basis: 'reported' },
    { runtime: 'runtime-b', state: 'stale', basis: 'scanned', note: 'Refresh after install' },
  ], [
    { path: '/home/jane/.agents/skills/demo-skill', scope: 'user', readBy: ['runtime-a'], hollow: false, digest: 'abc', readOnly: false },
    { path: '/tmp/project/.agents/skills/demo-skill', scope: 'project', readBy: ['runtime-b'], hollow: true, digest: null, readOnly: true },
  ], 'A useful \u001b[31mskill\u001b[0m description')
  const definition = {
    name: 'demo-skill', kind: 'skill', path: '/tmp/project/.agents/skills/demo-skill', text: '# Demo', truncated: false,
    files: [{ path: 'SKILL.md', bytes: 6 }, { path: 'examples/demo.md', bytes: 12 }], moreFiles: 0,
  }
  const rig = await libraryDesk(t, [entry], { '/tmp/project/.agents/skills/demo-skill': definition }, {
    'demo-skill': { sessions: 2, activations: 4, lastAt: 1_800_000_000_000, byRuntime: {} },
  })
  const result = await runCli(t, ['library', 'show', 'demo-skill', '--project', '/tmp/project'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /A useful skill description/)
  assert.doesNotMatch(result.stdout, /\x1b/)
  assert.match(result.stdout, /~\/\.agents\/skills\/demo-skill/)
  assert.match(result.stdout, /user.*abc.*Agent 1/)
  assert.match(result.stdout, /hollow.*read-only/)
  assert.match(result.stdout, /Agent 1.*reaches.*asked/)
  assert.match(result.stdout, /Agent 2.*stale.*on disk.*Refresh after install/)
  assert.match(result.stdout, /2 stored conversations.*4 activations/)
  assert.match(result.stdout, /counted in conversations this desk stored/)
  assert.match(result.stdout, /examples\/demo\.md.*12 bytes/)
  assert.deepEqual(rig.calls.map(call => call.method), ['client/hello', 'library/read', 'library/definition', 'library/definition', 'library/usage'])
})

test('library show --text prints only the first readable definition, with human text sanitized', async t => {
  const entry = libraryEntry('skill', 'pipe-skill', [], [
    { path: '/home/jane/first', scope: 'user', readBy: [], hollow: false, digest: 'a', readOnly: false },
    { path: '/home/jane/second', scope: 'user', readBy: [], hollow: false, digest: 'b', readOnly: false },
  ])
  const rig = await libraryDesk(t, [entry], {
    '/home/jane/second': { name: 'pipe-skill', kind: 'skill', path: '/home/jane/second', text: 'one\n\u001b[31mtwo\u001b[0m\n', truncated: false, files: [], moreFiles: 0 },
  })
  const result = await runCli(t, ['library', 'show', 'pipe-skill', '--text'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'one\ntwo\n')
  assert.deepEqual(rig.calls.map(call => call.method), ['client/hello', 'library/read', 'library/definition', 'library/definition'])
})

test('library show reports missing names with exit 1 and ambiguous names with exit 2', async t => {
  const missingRig = await libraryDesk(t, [])
  const missing = await runCli(t, ['library', 'show', 'not-here'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /No skill or server called not-here here\./)
  assert.equal(missingRig.calls.at(-1)?.method, 'library/read')

  const ambiguousRig = await libraryDesk(t, [libraryEntry('skill', 'shared-name', [], []), libraryEntry('mcp', 'shared-name', [], [])])
  const ambiguous = await runCli(t, ['library', 'show', 'shared-name'])
  assert.equal(ambiguous.code, 2)
  assert.match(ambiguous.stderr, /both a skill and an MCP server/)
  assert.match(ambiguous.stderr, /--kind/)
  assert.equal(ambiguousRig.calls.at(-1)?.method, 'library/read')
})
