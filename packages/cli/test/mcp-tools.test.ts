import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMANDS, parseArgs, runCommand, type CommandIo } from '../src/cli.js'
import { MCP_EXCLUDED, MCP_RUN_WAIT_MAX, ToolInputError, toolsOf } from '../src/mcp-tools.js'

/** The tool list `harnessdesk mcp` serves, pinned: a change here is a change to what every MCP client sees. */
const TOOL_TABLE: readonly (readonly [name: string, tier: string, properties: readonly string[], required: readonly string[]])[] = [
  ['desks', 'read', [], []],
  ['status', 'read', ['team'], []],
  ['teams', 'read', ['project'], []],
  ['runs', 'read', ['team', 'project', 'all'], []],
  ['open', 'run', ['path'], ['path']],
  ['flows', 'read', ['project'], []],
  ['flow_preview', 'read', ['flow', 'project', 'title', 'briefFile', 'input', 'seat'], ['flow']],
  ['flow_start', 'run', ['flow', 'project', 'title', 'briefFile', 'input', 'seat'], ['flow']],
  ['session_show', 'read', ['session', 'runtime', 'epochs', 'all'], ['session']],
  ['run_show', 'read', ['run'], ['run']],
  ['run_stop', 'run', ['run', 'reason'], ['run', 'reason']],
  ['run_wait', 'read', ['run', 'timeout'], ['run']],
  ['library_list', 'read', ['project', 'kind', 'issues'], []],
  ['library_show', 'read', ['name', 'project', 'kind', 'text'], ['name']],
  ['card_show', 'read', ['team', 'card'], ['team', 'card']],
  ['card_handoff', 'read', ['team', 'card'], ['team', 'card']],
  ['card_answer', 'answer', ['team', 'card', 'outcome', 'contextFile'], ['team', 'card', 'outcome']],
  ['card_abandon', 'run', ['team', 'card', 'reason'], ['team', 'card', 'reason']],
  ['waiting', 'read', [], []],
]

const tools = toolsOf(COMMANDS)

test('the tools are the command table, named, tiered and shaped as pinned', () => {
  assert.deepEqual(tools.map(tool => [tool.name, tool.tier, Object.keys(tool.inputSchema.properties), [...tool.inputSchema.required]]), TOOL_TABLE)
  for (const tool of tools) assert.match(tool.name, /^[a-z_]+$/)
})

test('no tool offers a flag the server decides, or one that would raise a ceiling or never end', () => {
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
    assert.equal(tool.inputSchema.type, 'object')
    for (const key of ['json', 'home', 'traceWire', 'yes', 'unattended', 'watch', 'until']) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties, key), false, `${tool.name} offers ${key}`)
    }
    assert.match(tool.description, /\n\nReturns: [\s\S]+\n\nTier: (read|run|answer)\./)
  }
  assert.match(tools.find(tool => tool.name === 'flow_start')!.description, /Settings › Permissions › MCP clients/)
  assert.equal(tools.find(tool => tool.name === 'run_wait')!.inputSchema.properties['timeout']!['maximum'], MCP_RUN_WAIT_MAX)
  assert.deepEqual(tools.find(tool => tool.name === 'flow_start')!.inputSchema.properties['briefFile']!['not'], { const: '-' })
})

test('every tool call becomes a command line the parser accepts, naming the same command', () => {
  for (const tool of tools) {
    const input: Record<string, unknown> = {}
    for (const key of tool.inputSchema.required) input[key] = key === 'card' ? '1' : 'x'
    const argv = tool.toArgv(input)
    const parsed = parseArgs([...argv, '--json'])
    assert.equal(parsed.command, tool.command, tool.name)
  }
  // Every optional property too, at once, where the parser allows them together.
  const start = tools.find(tool => tool.name === 'flow_start')!
  const argv = start.toArgv({ flow: 'review', project: '/work/repo', title: 'Fix it', briefFile: '/work/brief.md', input: ['a=1', 'b=2'], seat: ['coder=fake'] })
  assert.deepEqual(argv, ['flow', 'start', 'review', '--project', '/work/repo', '--title', 'Fix it', '--brief-file', '/work/brief.md', '--input', 'a=1', '--input', 'b=2', '--seat', 'coder=fake', '--yes'])
  const parsed = parseArgs([...argv, '--json'])
  assert.equal(parsed.unattended, undefined, 'unattended is never passed')
  assert.deepEqual(tools.find(tool => tool.name === 'run_wait')!.toArgv({ run: 'r1', timeout: 3600 }), ['run', 'wait', 'r1', '--timeout', '3600'])
  assert.deepEqual(tools.find(tool => tool.name === 'card_answer')!.toArgv({ team: 't', card: '3', outcome: 'approved' }), ['card', 'answer', 't', '3', 'approved'])
  assert.deepEqual(tools.find(tool => tool.name === 'runs')!.toArgv({ all: false }), ['runs'], 'a switch is passed only for true')
  assert.deepEqual(tools.find(tool => tool.name === 'runs')!.toArgv({ all: true }), ['runs', '--all'])
})

test('every argument is held to its schema before it becomes a command line, whatever the client sent', () => {
  const tool = (name: string) => tools.find(one => one.name === name)!
  const wait = tool('run_wait')
  assert.deepEqual(wait.inputSchema.properties['timeout'], { ...wait.inputSchema.properties['timeout'], type: 'integer', minimum: 1, maximum: MCP_RUN_WAIT_MAX })
  // A number sent as a string never slips past the cap, nor does any other spelling of one.
  for (const timeout of ['7200', '60', 7200, 3601, 0, -1, 1.5, Number.NaN, Infinity, true, [60], { seconds: 60 }]) {
    assert.throws(() => wait.toArgv({ run: 'r1', timeout }), ToolInputError, `timeout ${JSON.stringify(timeout)}`)
  }
  assert.throws(() => wait.toArgv({ run: 'r1', timeout: '7200' }), /whole number of seconds from 1 to 3600/)
  for (const timeout of [1, 600, 3600]) assert.deepEqual(wait.toArgv({ run: 'r1', timeout }), ['run', 'wait', 'r1', '--timeout', String(timeout)])
  // No other tool takes a number: every other value is a string, a switch or a list of strings, and is held to that.
  const numeric = tools.flatMap(one => Object.entries(one.inputSchema.properties).filter(([, schema]) => schema['type'] === 'number' || schema['type'] === 'integer').map(([key]) => `${one.name}.${key}`))
  assert.deepEqual(numeric, ['run_wait.timeout'])
  assert.throws(() => wait.toArgv({ run: 42 }), ToolInputError, 'a positional is a string')
  assert.throws(() => tool('card_answer').toArgv({ team: 't', card: 3, outcome: 'approved' }), ToolInputError, 'a card is its number as a string')
  assert.throws(() => tool('runs').toArgv({ all: 'yes' }), ToolInputError, 'a switch is a boolean')
  assert.throws(() => tool('flow_start').toArgv({ flow: 'review', input: 'a=1' }), ToolInputError, 'a list is a list')
  assert.throws(() => tool('flow_start').toArgv({ flow: 'review', input: [1] }), ToolInputError, 'a list holds strings')
  assert.throws(() => tool('flow_start').toArgv({ flow: 'review', input: Array.from({ length: 33 }, (_, n) => `k${n}=v`) }), ToolInputError)
  assert.throws(() => tool('library_list').toArgv({ kind: 'plugin' }), ToolInputError, 'an enum is held to its values')
  assert.throws(() => tool('flow_start').toArgv({ flow: 'review', unattended: true }), /flow_start takes no unattended/)
  assert.throws(() => tool('flow_start').toArgv({ flow: 'review', yes: false }), ToolInputError)
})

test('a value given by position cannot be read as a flag', () => {
  const start = tools.find(tool => tool.name === 'flow_start')!
  assert.throws(() => start.toArgv({ flow: '--unattended' }), ToolInputError)
  assert.throws(() => start.toArgv({ flow: '-x' }), ToolInputError)
})

test('every command has a tool or a written reason not to, so a new command needs a decision', () => {
  const named = new Set(tools.map(tool => tool.command))
  assert.deepEqual(COMMANDS.filter(command => !named.has(command.name)).map(command => command.name), Object.keys(MCP_EXCLUDED))
  assert.deepEqual(MCP_EXCLUDED, { watch: 'streams forever; use run_wait or status' })
  assert.equal(tools.length, COMMANDS.length - Object.keys(MCP_EXCLUDED).length)
})

test('standard input is the MCP channel, so `-` for a file is a usage error from an MCP call', async () => {
  const err: string[] = []
  const io: CommandIo = { out: () => {}, err: text => err.push(text), interactive: false, surface: 'mcp' }
  assert.equal(await runCommand(['flow', 'start', 'review', '--brief-file', '-', '--yes', '--json'], io), 2)
  assert.equal(await runCommand(['card', 'answer', 't', '1', 'approved', '--context-file', '-', '--json'], io), 2)
  assert.equal(err.filter(text => text.includes('stdin is the MCP channel; give a file path')).length, 2)
})
