import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS, clientTierFor } from '@harnessdesk/protocol'
import { WireCallError } from '@harnessdesk/client'
import { COMMANDS, sanitizeHuman, parseArgs, errorExit } from '../src/cli.js'

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
