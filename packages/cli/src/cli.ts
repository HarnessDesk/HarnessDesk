import { connect, WireCallError, type Client, type ClientEvent, type ClientTransport } from '@harnessdesk/client'
import { canonicalProject, findDesks, localTransport, resolveDesk, type DeskPointer } from '@harnessdesk/client/node'
import type { ClientMethodName, ClientTopic, GoalView, HostParams, HostResult } from '@harnessdesk/protocol'

interface Arguments {
  command: string
  home?: string
  json?: boolean
  traceWire?: boolean
  project?: string
  team?: string
  run?: string
  all?: boolean
  raw?: boolean
  until?: 'settled'
}
interface Command {
  readonly name: string
  readonly methods: readonly ClientMethodName[]
  readonly flags: readonly string[]
  readonly execute: (args: Arguments) => Promise<number>
}
/** The executable dispatch table is also the client-surface coverage contract. */
export const COMMANDS = [
  { name: 'desks', methods: ['client/hello'], flags: [], execute: desks },
  { name: 'status', methods: ['client/hello', 'goal/list', 'flow/executions'], flags: [], execute: status },
  { name: 'teams', methods: ['goal/list'], flags: ['project'], execute: teams },
  { name: 'runs', methods: ['flow/executions'], flags: ['team', 'project', 'all'], execute: runs },
  { name: 'watch', methods: ['client/subscribe', 'flow/execution', 'finding/run'], flags: ['team', 'run', 'project', 'until', 'raw'], execute: watch },
] as const satisfies readonly Command[]

class UsageError extends Error {}
function usage(reason: string): never { throw new UsageError(`Usage: ${reason}\nharnessdesk <desks|status|teams|runs|watch> [--home DIR] [--json] [--trace-wire]`) }
const globals = ['home', 'json', 'traceWire']
const switches = new Set(['json', 'all', 'raw', 'traceWire'])
const names: Readonly<Record<string, keyof Arguments>> = { '--home': 'home', '--json': 'json', '--trace-wire': 'traceWire', '--project': 'project', '--team': 'team', '--run': 'run', '--all': 'all', '--raw': 'raw', '--until': 'until' }

export function parseArgs(argv: readonly string[]): Arguments {
  const result: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) {
      if (result['command']) usage(`Unexpected argument ${arg}`)
      result['command'] = arg
      continue
    }
    const key = names[arg]
    if (!key) usage(`Unknown flag ${arg}`)
    if (Object.hasOwn(result, key)) usage(`Repeated flag ${arg}`)
    if (switches.has(key)) result[key] = true
    else {
      const value = argv[++i]
      if (!value || value.startsWith('--')) usage(`A value is required for ${arg}`)
      result[key] = value
    }
  }
  const command = COMMANDS.find(command => command.name === result['command'])
  if (!command) usage('Choose one of desks, status, teams, runs, watch')
  for (const key of Object.keys(result)) {
    if (key !== 'command' && !globals.includes(key) && !(command.flags as readonly string[]).includes(key)) usage(`--${key} is not available on ${command.name}`)
  }
  if (['team', 'run', 'project'].filter(key => result[key] !== undefined).length > 1) usage('Choose only one of --team, --run, --project')
  if (result['until'] && (result['until'] !== 'settled' || !result['run'])) usage('--until settled requires --run')
  return result as unknown as Arguments
}

/** Remove terminal commands before removing their introducers, including C1 forms. */
export function sanitizeHuman(value: string): string {
  return value
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
}

export function errorExit(error: unknown): number {
  if (error instanceof UsageError) return 2
  if (!(error instanceof WireCallError)) return 1
  if (error.code === 'noDesk') return 3
  if (['incompatible', 'deskTooOld'].includes(error.code)) return 6
  if (['unsafeDirectory', 'unsafeSocket', 'unsafePointer', 'tierNotGranted', 'notOnClientSurface', 'helloFirst', 'badRequest', 'refused', 'alreadyAnswered', 'clientDoorOnly'].includes(error.code)) return 4
  return 1
}

const line = (parts: readonly unknown[]) => process.stdout.write(parts.filter(part => part !== undefined && part !== null).map(part => sanitizeHuman(typeof part === 'string' ? part : JSON.stringify(part))).join('  ') + '\n')
// JSON.stringify escapes C0; explicitly escape DEL/C1 while preserving parsed data.
const encodeJson = (value: unknown) => JSON.stringify(value).replace(/[\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
const jsonLine = (value: unknown) => process.stdout.write(encodeJson(value) + '\n')
const output = (args: Arguments, value: object, human: () => void) => { if (args.json) jsonLine(value); else human() }
const teamLine = (team: GoalView) => line([team.goal.id, team.activity ?? team.goal.state, team.goal.sentence])

async function open(args: Arguments, desk?: DeskPointer, subscribe?: HostParams<'client/subscribe'>, onTransport?: (transport: ClientTransport) => void): Promise<Client> {
  const pointer = desk ?? await resolveDesk({ home: args.home })
  return connect({
    client: { name: 'harnessdesk', version: '0.1.0' },
    subscribe,
    transport: async () => {
      const transport = await localTransport(pointer)
      onTransport?.(transport)
      if (!args.traceWire) return transport
      const trace = (direction: string, message: unknown) => process.stderr.write(encodeJson({ direction, message }) + '\n')
      return {
        ...transport,
        send: message => { trace('send', message); transport.send(message) },
        onMessage: listener => transport.onMessage(message => { trace('receive', message); listener(message) }),
      } satisfies ClientTransport
    },
  })
}

async function desks(args: Arguments): Promise<number> {
  const found: HostResult<'client/hello'>[] = []
  for (const pointer of await findDesks()) {
    const client = await open(args, pointer)
    try { found.push(client.hello) } finally { client.close() }
  }
  output(args, { desks: found }, () => {
    if (!found.length) line(['No running desks.'])
    for (const hello of found) line([hello.desk.home, hello.hostVersion, new Date(hello.desk.startedAt).toISOString()])
  })
  return 0
}

async function status(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const teams = await client.call('goal/list', {})
    const runs = await client.call('flow/executions', {})
    output(args, { hello: client.hello, teams, runs }, () => {
      line([client.hello.desk.home, client.hello.hostVersion])
      for (const runtime of client.hello.runtimes) {
        const health = runtime.health
        line([runtime.name, health.state, ...(health.state === 'unavailable' ? [health.reason, health.message, health.remediation] : [])])
      }
      for (const team of teams) teamLine(team)
      for (const run of runs) line([run.id, run.state, run.flow, run.reason])
    })
    return 0
  } finally { client.close() }
}

async function teams(args: Arguments): Promise<number> {
  const project = args.project ? await canonicalProject(args.project) : undefined
  const client = await open(args)
  try {
    // goal/list's root filter is lexical; apply the host's canonical path identity here.
    const found = await client.call('goal/list', {})
    const selected: GoalView[] = []
    for (const team of found) if (!project || await canonicalProject(team.goal.root) === project) selected.push(team)
    output(args, { teams: selected }, () => { for (const team of selected) teamLine(team) })
    return 0
  } finally { client.close() }
}

async function runs(args: Arguments): Promise<number> {
  const project = args.project ? await canonicalProject(args.project) : undefined
  const client = await open(args)
  try {
    const found = await client.call('flow/executions', { team: args.team, project, active: !args.all })
    output(args, { runs: found }, () => { for (const run of found) line([run.id, run.team, run.state, run.flow, run.round, run.reason]) })
    return 0
  } finally { client.close() }
}

function eventLine(event: ClientEvent): void {
  switch (event.type) {
    case 'hello': line(['hello', event.desk.home, event.hostVersion]); break
    case 'run.changed': line([event.type, event.run, event.state, event.round, event.reason]); break
    case 'card.changed': line([event.type, event.team, event.card, event.state, event.title, event.outcome]); break
    case 'team.changed': line([event.type, event.team, event.activity, event.sentence]); break
    case 'waiting': case 'waiting.cleared': line([event.type, event.id, event.summary]); break
    case 'notice': line([event.type, event.team, event.text]); break
    case 'gap': case 'end': line([event.type, event.reason]); break
  }
}

async function watch(args: Arguments): Promise<number> {
  const topics: ClientTopic[] = ['runs', 'cards', 'teams', 'waiting', 'notices']
  let client: Client | undefined, signalCode = 0, reachedUntil = false
  let pendingTransport: ClientTransport | undefined
  const cancel = () => { if (client) client.close(); else pendingTransport?.close() }
  const interrupt = () => { signalCode ||= 130; cancel() }
  const terminate = () => { signalCode ||= 143; cancel() }
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  let ending: Extract<ClientEvent, { type: 'end' }> | undefined, failure: unknown, rawFailure: unknown
  let raw: Promise<void> | undefined
  const write = (event: ClientEvent) => { if (args.json || args.raw) jsonLine(event); else eventLine(event) }
  try {
    const project = args.project ? await canonicalProject(args.project) : undefined
    const scope = args.team ? { team: args.team } : args.run ? { run: args.run } : project ? { project } : undefined
    client = await open(args, undefined, { topics, scope }, transport => {
      pendingTransport = transport
      if (signalCode) transport.close()
    })
    if (signalCode) client.close()
    try {
      for await (const event of client.events()) {
        if (event.type === 'end') { ending = event; continue }
        if (!args.raw || event.type === 'hello') write(event)
        if (event.type === 'hello') {
          const current = client
          raw = (async () => { for await (const notification of current.notifications()) if (args.raw) jsonLine(notification) })().catch(error => { rawFailure = error })
        }
        if (args.until && event.type === 'run.changed' && event.run === args.run && ['settled', 'stopped', 'stalled'].includes(event.state)) {
          reachedUntil = true
          client.close()
        }
      }
    } catch (error) { failure = error }
    // Consume both independent queues in every mode; raw output drains before end.
    await raw
    if (ending) write(reachedUntil && !signalCode ? { ...ending, reason: 'until' } : ending)
    if (failure || rawFailure) throw failure ?? rawFailure
    return signalCode
  } catch (error) {
    if (!signalCode) throw error
    // Before a completed handshake there is no hello to claim, only an interruption.
    if (!ending) write({ v: 1, type: 'end', at: new Date().toISOString(), reason: 'interrupted' })
    return signalCode
  } finally {
    client?.close()
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv)
    return await COMMANDS.find(command => command.name === args.command)!.execute(args)
  } catch (error) {
    const code = error instanceof WireCallError ? `${error.code}: ` : ''
    process.stderr.write(sanitizeHuman(code + (error instanceof Error ? error.message : String(error))) + '\n')
    return errorExit(error)
  }
}
