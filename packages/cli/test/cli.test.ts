import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_METHODS } from '@harnessdesk/protocol'
import { WireCallError } from '@harnessdesk/client'
import { COMMANDS, sanitizeHuman, parseArgs, errorExit } from '../src/cli.js'

test('the executable command table covers exactly the read client surface', () => {
  assert.deepEqual(COMMANDS.map(command => command.name), ['desks', 'status', 'teams', 'runs', 'watch'])
  const methods = new Set(COMMANDS.flatMap(command => [...command.methods]))
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
