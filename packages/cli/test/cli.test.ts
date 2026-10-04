import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS, clientTierFor } from '@harnessdesk/protocol'
import { WireCallError } from '@harnessdesk/client'
import { COMMANDS, FLAG_KEYS, GLOBAL_FLAG_KEYS, sanitizeHuman, parseArgs, errorExit } from '../src/cli.js'
import { EXIT_CODES, GLOBAL_OPTIONS, type OptionDoc } from '../src/reference.js'

test('the executable command table covers exactly the declared client surface', () => {
  assert.deepEqual(COMMANDS.map(command => command.name), ['desks', 'status', 'teams', 'runs', 'watch', 'open', 'flows', 'flow preview', 'flow start', 'run show', 'run stop', 'run wait', 'card show', 'card handoff', 'card answer', 'card abandon', 'waiting'])
  const methods = new Set(COMMANDS.flatMap(command => [...command.methods]))
  for (const command of COMMANDS) for (const method of command.methods) { const tier = clientTierFor(method, 'action' in command ? { action: command.action } : undefined); assert.ok(tier === 'read' || tier === command.tier, `${command.name}: ${method}`) }
  for (const method of methods) assert.ok(Object.hasOwn(CLIENT_METHODS, method), method)
  assert.deepEqual([...methods].sort(), Object.keys(CLIENT_METHODS).sort())
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
const SAMPLE_VALUE = (value: string | undefined) => value === undefined ? undefined : value === 'SECONDS' ? '5' : value === 'settled' ? 'settled' : value === 'PATH|-' ? '-' : value.startsWith('ROLE=') ? 'writer=fake/high' : value === 'NAME=VALUE' ? 'a=b' : 'x'

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
  for (const [code, expected] of [['noDesk', 3], ['unsafeDirectory', 4], ['tierNotGranted', 4], ['alreadyAnswered', 4], ['incompatible', 6], ['deskTooOld', 6], ['deadline', 1]] as const) {
    assert.ok(Object.hasOwn(EXIT_CODES, errorExit(new WireCallError(code, 'demo'))), code)
    assert.equal(errorExit(new WireCallError(code, 'demo')), expected, code)
  }
  assert.throws(() => parseArgs([]), error => errorExit(error) === 2)
})
