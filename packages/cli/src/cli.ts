import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { connect, WireCallError, type Client, type ClientEvent, type ClientTransport } from '@harnessdesk/client'
import { teamOverviewOf } from '@harnessdesk/client/views'
import { canonicalProject, findDesks, localTransport, resolveDesk, type DeskPointer } from '@harnessdesk/client/node'
import { parseSeat, seatSpec, doingSentence, type FlowPreview, type FlowSeat, type ClientTier, type ClientMethodName, type ClientTopic, type GoalView, type HostParams, type HostResult } from '@harnessdesk/protocol'

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
  target?: string
  title?: string
  briefFile?: string
  input?: string[]
  seat?: string[]
  unattended?: boolean
  yes?: boolean
  timeout?: string
}
interface Command {
  readonly name: string
  readonly tier: ClientTier
  readonly methods: readonly ClientMethodName[]
  readonly flags: readonly string[]
  readonly execute: (args: Arguments) => Promise<number>
}
/** The executable dispatch table is also the client-surface coverage contract. */
export const COMMANDS = [
  { name: 'desks', tier: 'read', methods: ['client/hello'], flags: [], execute: desks },
  { name: 'status', tier: 'read', methods: ['client/hello', 'client/subscribe', 'insight/goal'], flags: ['team'], execute: status },
  { name: 'teams', tier: 'read', methods: ['goal/list'], flags: ['project'], execute: teams },
  { name: 'runs', tier: 'read', methods: ['flow/executions'], flags: ['team', 'project', 'all'], execute: runs },
  { name: 'watch', tier: 'read', methods: ['client/subscribe', 'flow/execution', 'flow/executions', 'finding/run'], flags: ['team', 'run', 'project', 'until', 'raw'], execute: watch },
  { name: 'open', tier: 'run', methods: ['workspace/open'], flags: ['target'], execute: openProject },
  { name: 'flows', tier: 'read', methods: ['flow/catalog'], flags: ['project'], execute: flows },
  { name: 'flow preview', tier: 'read', methods: ['flow/source', 'flow/preview'], flags: ['target', 'project', 'title', 'briefFile', 'input', 'seat', 'unattended'], execute: previewFlow },
  { name: 'flow start', tier: 'run', methods: ['flow/source', 'flow/preview', 'flow/start-goal'], flags: ['target', 'project', 'title', 'briefFile', 'input', 'seat', 'unattended', 'yes'], execute: startFlow },
  { name: 'run show', tier: 'read', methods: ['flow/execution'], flags: ['target'], execute: showRun },
  { name: 'run wait', tier: 'read', methods: ['client/subscribe', 'flow/execution'], flags: ['target', 'timeout'], execute: waitRun },
] as const satisfies readonly Command[]

class UsageError extends Error {}
function usage(reason: string): never { throw new UsageError(`Usage: ${reason}\nharnessdesk <desks|status|teams|runs|watch|open|flows|flow preview|flow start|run show|run wait> [--home DIR] [--json] [--trace-wire]`) }
const globals = ['home', 'json', 'traceWire']
const switches = new Set(['json', 'all', 'raw', 'traceWire', 'unattended', 'yes'])
const names: Readonly<Record<string, keyof Arguments>> = { '--home': 'home', '--json': 'json', '--trace-wire': 'traceWire', '--project': 'project', '--team': 'team', '--run': 'run', '--all': 'all', '--raw': 'raw', '--until': 'until', '--title': 'title', '--brief-file': 'briefFile', '--input': 'input', '--seat': 'seat', '--unattended': 'unattended', '--yes': 'yes', '--timeout': 'timeout' }

export function parseArgs(argv: readonly string[]): Arguments {
  const result: Record<string, string | boolean | string[]> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) {
      if (!result['command']) result['command'] = arg
      else if (result['command'] === 'flow' || result['command'] === 'run') result['command'] += ` ${arg}`
      else if (['open', 'flow preview', 'flow start', 'run show', 'run wait'].includes(String(result['command'])) && !result['target']) result['target'] = arg
      else usage(`Unexpected argument ${arg}`)
      continue
    }
    const key = names[arg]
    if (!key) usage(`Unknown flag ${arg}`)
    if (key !== 'input' && key !== 'seat' && Object.hasOwn(result, key)) usage(`Repeated flag ${arg}`)
    if (switches.has(key)) result[key] = true
    else {
      const value = argv[++i]
      if (!value || value.startsWith('--')) usage(`A value is required for ${arg}`)
      if (key === 'input' || key === 'seat') ((result[key] ??= []) as string[]).push(value)
      else result[key] = value
    }
  }
  const command = COMMANDS.find(command => command.name === result['command'])
  if (!command) usage('Choose a command: ' + COMMANDS.map(command => command.name).join(', '))
  for (const key of Object.keys(result)) {
    if (key !== 'command' && !globals.includes(key) && !(command.flags as readonly string[]).includes(key)) usage(`--${key} is not available on ${command.name}`)
  }
  if (['team', 'run', 'project'].filter(key => result[key] !== undefined).length > 1) usage('Choose only one of --team, --run, --project')
  if ((command.flags as readonly string[]).includes('target') && !result['target']) usage(`${command.name} requires a target`)
  if (result['until'] && (result['until'] !== 'settled' || !result['run'])) usage('--until settled requires --run')
  if (result['timeout'] !== undefined && (typeof result['timeout'] !== 'string' || !result['timeout'].trim() || !Number.isFinite(Number(result['timeout'])) || Number(result['timeout']) < 0 || Number(result['timeout']) * 1000 > 2_147_483_647)) usage('--timeout needs finite non-negative seconds within the timer range')
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

function relativeSince(since: number | null): string {
  if (since === null) return 'unknown'
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000))
  if (seconds < 1) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

async function status(args: Arguments): Promise<number> {
  const client = await open(args, undefined, { topics: ['runs', 'cards', 'teams', 'seats', 'waiting'], ...(args.team ? { scope: { team: args.team } } : {}) })
  try {
    await client.synced()
    const snapshot = client.snapshot()
    const teams = snapshot.teams
    const runs = snapshot.runs.filter(run => run.state === 'running' || run.state === 'stalled').map(run => ({
      id: run.id, team: run.goal, flow: run.document.flow.name, state: run.state,
      round: run.rounds.at(-1)?.n ?? null, role: run.rounds.at(-1)?.role ?? null, reason: run.reason,
      startedAt: run.startedAt ?? teams.find(team => team.goal.id === run.goal)?.goal.createdAt ?? 0,
    })).sort((a, b) => b.startedAt - a.startedAt)
    const shown = teams.filter(team => args.team ? team.goal.id === args.team : runs.some(run => run.team === team.goal.id))
    const overviews = await Promise.all(shown.map(async team => ({
      team: team.goal.id,
      overview: teamOverviewOf(snapshot, team.goal.id, { report: await client.call('insight/goal', { goal: team.goal.id }), runtimes: client.hello.runtimes }),
    })))
    output(args, { hello: client.hello, teams, runs, overviews }, () => {
      line([client.hello.desk.home, client.hello.hostVersion])
      for (const runtime of client.hello.runtimes) {
        const health = runtime.health
        line([runtime.name, health.state, ...(health.state === 'unavailable' ? [health.reason, health.message, health.remediation] : [])])
      }
      for (const { team, overview } of overviews) {
        teamLine(teams.find(one => one.goal.id === team)!)
        const run = overview.run
        if (run) line([run.run, run.state, `round ${run.round ?? 'unknown'}`, `role ${run.role ?? 'unknown'}`,
          run.reviewRounds ? `reviews ${run.reviewRounds.used} of ${run.reviewRounds.of}` : 'reviews unknown',
          `cost ${[run.total.money === null ? null : `$${run.total.money.toFixed(2)}`, run.total.turns === null ? null : `${run.total.turns} turns`].filter(value => value !== null).join(', ') || 'unknown'}`,
        ])
        for (const need of overview.needsYou) line(['needs-you', need.kind, need.seat, need.card === null ? null : `#${need.card}`, need.summary])
        for (const seat of overview.seats) line([seat.name, seat.role, seat.card ? `#${seat.card.id} ${seat.card.title}` : null, seat.state, seat.doing, `since ${relativeSince(seat.since)}`])
      }
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
    case 'seat.changed': line([event.type, event.team, event.seat, event.role, event.card, event.state, event.doing ? doingSentence(event.doing) : undefined]); break
    case 'review.changed': line([event.type, event.team, event.run, event.round, event.cards, event.state, event.reason, event.pr]); break
    case 'team.changed': line([event.type, event.team, event.activity, event.sentence]); break
    case 'waiting': case 'waiting.cleared': line([event.type, event.id, event.summary]); break
    case 'notice': line([event.type, event.team, event.text]); break
    case 'gap': case 'end': line([event.type, event.reason]); break
  }
}

async function watch(args: Arguments): Promise<number> {
  const topics: ClientTopic[] = ['runs', 'cards', 'teams', 'waiting', 'notices', 'seats', 'reviews']
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

async function projectOf(args: Arguments): Promise<string> {
  if (args.project) return canonicalProject(args.project)
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
    return canonicalProject(stdout.trim())
  } catch { return usage('Outside a repository, give --project PATH') }
}

async function openProject(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const project = await client.call('workspace/open', { path: await canonicalProject(args.target!) })
    output(args, project, () => line([project.path, project.name]))
    return 0
  } finally { client.close() }
}

async function flows(args: Arguments): Promise<number> {
  const root = await projectOf(args)
  const client = await open(args)
  try {
    const entries = await client.call('flow/catalog', { root })
    output(args, { flows: entries }, () => { for (const flow of entries) line([flow.id, flow.origin, flow.problem]) })
    return 0
  } finally { client.close() }
}

async function stdinText(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += chunk.toString()
  return text
}

async function flowRequest(args: Arguments, client: Client) {
  const root = await projectOf(args), target = args.target!
  // Paths belong to the caller. The desk only receives text, or a catalogue
  // id it resolves under its own catalogue rules; it never opens this path.
  const source = target.includes('/') || /\.ya?ml$/i.test(target)
    ? await readFile(target, 'utf8') : await client.call('flow/source', { root, id: target })
  const vars: Record<string, string> = {}
  for (const entry of args.input ?? []) {
    const split = entry.indexOf('=')
    if (split <= 0) usage('--input needs name=value or name=@path')
    const name = entry.slice(0, split), value = entry.slice(split + 1)
    if (Object.hasOwn(vars, name)) usage(`Repeated input ${name}`)
    vars[name] = value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value
  }
  if (args.briefFile !== undefined) {
    if (Object.hasOwn(vars, 'brief')) usage('Choose --brief-file or --input brief, once')
    vars['brief'] = args.briefFile === '-' ? await stdinText() : await readFile(args.briefFile, 'utf8')
  }
  if (args.title !== undefined) {
    if (Object.hasOwn(vars, 'title')) usage('Choose --title or --input title, once')
    vars['title'] = args.title
  }
  const seats: Record<string, readonly FlowSeat[]> = {}
  for (const entry of args.seat ?? []) {
    const split = entry.indexOf('=')
    if (split <= 0) usage('--seat needs role=runtime[=model][/effort][+thinking]')
    const role = entry.slice(0, split)
    if (Object.hasOwn(seats, role)) usage(`Repeated seat role ${role}; give its seats as a comma-separated list`)
    seats[role] = entry.slice(split + 1).split(',').map(spec => {
      const seat = parseSeat(spec)
      if (typeof seat === 'string') usage(seat)
      return seat
    })
  }
  const options = { ...(args.seat ? { seats } : {}), attended: !args.unattended }
  let preview = await client.call('flow/preview', { root, source, vars, ...options })
  const declared = preview.compiled.document.flow.inputs.map(input => input.id)
  const undeclared = Object.keys(vars).filter(name => !declared.includes(name) && !(name === 'title' && args.title !== undefined))
  if (undeclared.length) usage(`The flow has no input ${undeclared.join(', ')}; it declares: ${declared.join(', ') || '(none)'}`)
  // Only the host parses the Flow. When title names the Team alone, redeem a
  // preview taken of exactly those declared inputs, without a second parser.
  if (args.title !== undefined && !declared.includes('title')) {
    delete vars['title']
    preview = await client.call('flow/preview', { root, source, vars, ...options })
  }
  return { root, source, vars, ...options, preview }
}

function printPreview(preview: FlowPreview, stream: NodeJS.WritableStream = process.stdout): void {
  const write = (parts: readonly unknown[]) => stream.write(parts.filter(part => part !== undefined && part !== null).map(part => sanitizeHuman(String(part))).join('  ') + '\n')
  write([preview.compiled.document.flow.name, preview.attended === false ? 'unattended' : 'attended', 'preview spends nothing'])
  for (const [role, seats] of Object.entries(preview.overrides ?? {})) write([role, 'override', seats.run.map(seatSpec).join(', '), 'file:', seats.file.map(seatSpec).join(', ')])
  for (const seat of preview.seats) {
    const candidate = seat.plan.winner === null ? null : seat.plan.candidates[seat.plan.winner]
    write([`${seat.role}[${seat.index + 1}]`, candidate?.label ?? seat.agent ?? 'unavailable', seat.plan.ceiling?.hold ?? 'unavailable', seat.plan.blocked])
  }
  for (const check of preview.commands) write(['check', check.role, check.run, `cwd ${check.cwd}`, `timeout ${check.timeout}s`])
  for (const problem of preview.problems) write(['problem', problem.at, problem.text])
}

async function previewFlow(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const { preview } = await flowRequest(args, client)
    output(args, preview, () => printPreview(preview))
    return preview.problems.length || !preview.token ? 4 : 0
  } finally { client.close() }
}

async function startFlow(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const { preview, ...request } = await flowRequest(args, client)
    // --yes acknowledges this preview; a pipe never implies approval to
    // spend. JSON keeps stdout to the start result, even during confirmation.
    printPreview(preview, args.json ? process.stderr : process.stdout)
    if (preview.problems.length || !preview.token) return 4
    if (!args.yes) {
      if (!process.stdin.isTTY) usage('Without a terminal, flow start requires --yes')
      const prompt = createInterface({ input: process.stdin, output: process.stderr })
      try { if (!/^y(?:es)?$/i.test((await prompt.question('Start this Flow? [y/N] ')).trim())) return 4 }
      finally { prompt.close() }
    }
    const run = await client.call('flow/start-goal', { ...request, token: preview.token, sentence: args.title ?? preview.compiled.document.flow.name })
    output(args, { run: run.id, team: run.goal }, () => line([run.id, run.goal]))
    return 0
  } finally { client.close() }
}

async function showRun(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const run = await client.call('flow/execution', { run: args.target! })
    output(args, run, () => {
      line([run.id, run.state, run.attended === false ? 'unattended' : 'attended', run.reason])
      for (const round of run.rounds) line([`round ${round.n}`, round.role, round.state, `cards ${round.cards.join(', ')}`])
      for (const [role, seats] of Object.entries(run.overrides ?? {})) line([role, 'override', seats.map(seatSpec).join(', ')])
    })
    return 0
  } finally { client.close() }
}

async function waitRun(args: Arguments): Promise<number> {
  let client: Client | undefined, pendingTransport: ClientTransport | undefined
  let code: number | undefined, reason: string | null = null
  let raw: Promise<void> | undefined, rawFailure: unknown
  const cancel = () => { client?.close(); pendingTransport?.close() }
  const interrupt = () => { code ??= 130; reason ??= 'interrupted'; cancel() }
  const terminate = () => { code ??= 143; reason ??= 'interrupted'; cancel() }
  const timeout = args.timeout === undefined ? undefined : setTimeout(() => { code ??= 8; reason ??= 'timeout'; cancel() }, Number(args.timeout) * 1000)
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  const decide = () => {
    if (code !== undefined || !client) return
    const snapshot = client.snapshot(), run = snapshot.runs.find(run => run.id === args.target)
    if (!run) return
    if (run.state !== 'running') {
      code = run.state === 'settled' ? 0 : 7
      reason = run.reason
      return
    }
    const person = snapshot.boards.some(board => board.id === run.goal && board.intents.some(card =>
      card.state !== 'done' && card.state !== 'abandoned' &&
      run.document.flow.roles.some(role => role.id === card.role && role.kind === 'person') &&
      run.rounds.some(round => round.role === card.role && round.state !== 'closed' && round.cards.includes(card.id))))
    const question = snapshot.approvals.some(one => one.approval.type === 'userInput' || one.approval.type === 'elicitation')
    if (person || question) { code = 5; reason = person ? 'waiting for a person card' : 'waiting for an answer' }
  }
  try {
    client = await open(args, undefined, { topics: ['runs', 'cards', 'waiting'], scope: { run: args.target! } }, transport => {
      pendingTransport = transport
      if (code !== undefined) transport.close()
    })
    // Both queues are independent; discarded raw messages must still drain.
    raw = (async () => { for await (const _ of client!.notifications()) {} })().catch(error => { rawFailure = error })
    if (code !== undefined) client.close()
    await client.synced()
    decide()
    if (code === undefined) for await (const event of client.events()) {
      if (event.type === 'gap') await client.synced()
      if (event.type === 'end' && code === undefined) throw new WireCallError('disconnected', 'The desk closed before the run reached an outcome.')
      decide()
      if (code !== undefined) break
    }
    if (code === undefined) throw new WireCallError('disconnected', 'The run wait ended without an outcome.')
  } catch (error) { if (code === undefined) throw error }
  finally {
    client?.close(); pendingTransport?.close()
    if (timeout !== undefined) clearTimeout(timeout)
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
    await raw
  }
  if (rawFailure && code === undefined) throw rawFailure
  const state = client?.snapshot().runs.find(run => run.id === args.target)?.state ?? null
  output(args, { run: args.target, state, reason }, () => line([args.target, state, reason]))
  return code!
}
