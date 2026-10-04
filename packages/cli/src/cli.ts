import { connect, WireCallError, type Client, type ClientEvent, type ClientTransport } from '@harnessdesk/client'
import { teamOverviewOf, runTimelineOf } from '@harnessdesk/client/views'
import { readTextFile, repositoryRoot, readConfirmation, canonicalProject, findDesks, localTransport, resolveDesk, type DeskPointer } from '@harnessdesk/client/node'
import { parseSeat, seatSpec, doingSentence, type FlowPreview, type FlowSeat, type ClientTier, type ClientMethodName, type ClientTopic, type GoalView, type HostParams, type HostResult, type FindingView } from '@harnessdesk/protocol'
import { CARD_ARGUMENT, FLOW_ARGUMENT, FLOW_OPTIONS, RUN_ARGUMENT, TEAM_ARGUMENT, YES_OPTION, type ArgumentDoc, type OptionDoc } from './reference.js'

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
  reason?: string
  card?: string
  outcome?: string
  contextFile?: string
  watch?: boolean
}
interface Command {
  readonly name: string
  readonly action?: 'done' | 'abandon'
  readonly tier: ClientTier
  readonly methods: readonly ClientMethodName[]
  readonly flags: readonly string[]
  readonly execute: (args: Arguments) => Promise<number>
  /**
   * The rest is what `docs/cli.md` says about the command, and the reference
   * generator writes it out verbatim. It is written for a person driving
   * their own work: what the command does, how to type it, what it prints
   * with `--json`, and how it ends. `usage` is the command as typed, `<name>`
   * a value to give and `[…]` optional; a test parses an example built from
   * it, so it cannot describe a command the parser would refuse.
   */
  readonly usage: string
  readonly description: string
  readonly arguments: readonly ArgumentDoc[]
  readonly options: readonly OptionDoc[]
  readonly json: string
  /** The exit codes it has a meaning of its own for. `EXIT_CODES` is every code there is. */
  readonly exits: Readonly<Record<number, string>>
}
/** The executable dispatch table is also the client-surface coverage contract. */
export const COMMANDS = [
  {
    name: 'desks', tier: 'read', methods: ['client/hello'], flags: [], execute: desks,
    usage: 'desks',
    description: 'Lists the desks running for you: the folder each keeps its state in, its version and when it started. The app is one desk; a desk started with another `HARNESSDESK_HOME` is another.',
    arguments: [],
    options: [],
    json: 'A single object, `{ "desks": [...] }`, with one entry for each running desk: `protocolVersion`, `hostVersion`, `desk` (`home`, `pid` and `startedAt`), `tiers`, `methods` and `runtimes`.',
    exits: { 0: 'Done. With no desk running it says so and still exits 0.' },
  },
  {
    name: 'status', tier: 'read', methods: ['client/hello', 'client/subscribe', 'insight/goal'], flags: ['team'], execute: status,
    usage: 'status [--team TEAM]',
    description: "Shows one desk at a glance: its agents, and each Team with a run in flight. It prints the desk's home and version, how each of its agents is doing, and for every Team with a run in flight the run's state, round and role, the review rounds used, what it has cost, anything that needs you, and what each seat is doing. With `--team`, that Team is shown whether or not it has a run in flight.",
    arguments: [],
    options: [{ flag: '--team', value: 'TEAM', description: 'Show this Team even when it has no run in flight. Its newest run, ended or not, is the one shown.' }],
    json: 'A single object: `hello` (what the desk says about itself), `teams` (the Teams in scope), `runs` (their runs in flight) and `overviews`, one `{ "team", "overview" }` for each Team shown, whose `overview` has `run`, `needsYou` and `seats`.',
    exits: { 0: 'Done.' },
  },
  {
    name: 'teams', tier: 'read', methods: ['goal/list'], flags: ['project'], execute: teams,
    usage: 'teams [--project PATH]',
    description: "Lists the desk's Teams: each one's id, what it is doing or its state, and its sentence. With `--project`, only the Teams working in that project.",
    arguments: [],
    options: [{ flag: '--project', value: 'PATH', description: 'Only the Teams working in this project: the path of its folder. Symbolic links are followed.' }],
    json: "A single object, `{ \"teams\": [...] }`. Each entry is a Team as the desk holds it: `goal` (the Team's own record: `id`, `sentence`, `state`, `root` and more), `activity`, `members` and `board`.",
    exits: { 0: 'Done.' },
  },
  {
    name: 'runs', tier: 'read', methods: ['flow/executions'], flags: ['team', 'project', 'all'], execute: runs,
    usage: 'runs [--team TEAM | --project PATH] [--all]',
    description: "Lists runs, newest first: each run's id, Team, state, flow, round and the reason it is not running. By default only runs in flight (running or stalled); `--all` adds the ones that have ended.",
    arguments: [],
    options: [
      { flag: '--team', value: 'TEAM', description: 'Only the runs of this Team.' },
      { flag: '--project', value: 'PATH', description: 'Only the runs of Teams working in this project: the path of its folder. Symbolic links are followed.' },
      { flag: '--all', description: 'Include runs that have ended, settled or stopped, as well as those in flight.' },
    ],
    json: 'A single object, `{ "runs": [...] }`. Each run has `id`, `team`, `flow`, `state`, `round`, `role`, `reason` and `startedAt`.',
    exits: { 0: 'Done.' },
  },
  {
    name: 'watch', tier: 'read', methods: ['client/subscribe', 'flow/execution', 'flow/executions', 'finding/run'], flags: ['team', 'run', 'project', 'until', 'raw'], execute: watch,
    usage: 'watch [--team TEAM | --run RUN | --project PATH] [--until settled] [--raw]',
    description: "Streams what changes on the desk, one line per change, until you interrupt it. That is runs, cards, seats, reviews and Teams changing, anything that starts or stops waiting for a person, and notices. It opens with `hello` and closes with `end`, and nothing polls. A connection that drops is rejoined, marked with `gap`, and the whole current state follows it. With `--run RUN --until settled` it ends, with exit code 0, when that run settles, stops or stalls.",
    arguments: [],
    options: [
      { flag: '--team', value: 'TEAM', description: 'Only changes to this Team.' },
      { flag: '--run', value: 'RUN', description: "Only changes to this run. A run that has already ended is read once, so you still see how it ended." },
      { flag: '--project', value: 'PATH', description: 'Only changes in this project: the path of its folder. Symbolic links are followed.' },
      { flag: '--until', value: 'settled', description: 'End the stream when the run named with `--run` settles, stops or stalls. Needs `--run`.' },
      { flag: '--raw', description: "Print the desk's own notifications unchanged, between `hello` and `end`. Their format is not stable: it changes as the desk grows." },
    ],
    json: [
      "One object per line, each with `v` (the format's version, 1), `type` and `at` (an ISO time). It opens with `hello` and closes with `end`. Ignore any `type` you do not know, and any field you do not need.",
      '',
      '- `hello`: `desk`, `hostVersion`, `protocolVersion`, `tiers`.',
      '- `run.changed`: `run`, `team`, `flow`, `state` (`running`, `settled`, `stopped` or `stalled`), `round`, `reason`.',
      '- `card.changed`: `team`, `card`, `role`, `state`, `outcome`, `title`; sometimes `seat` and `since`.',
      '- `seat.changed`: `team`, `seat`, `role`, `card`, `state` (`working`, `waiting` or `idle`), `doing`; sometimes `since`.',
      "- `review.changed`: `team`, `run` and one review round's publication: `round`, `cards`, `state`, `reason`, `pr`.",
      '- `team.changed`: `team`, `activity`, `sentence`.',
      '- `waiting` and `waiting.cleared`: `id`, `team`, `kind` (`card`, `question` or `approval`), `card` or `seat`, `summary`. The same `id` clears the item it raised.',
      '- `notice`: `team`, `text`.',
      '- `gap`: `reason`. The connection dropped and came back, or the subscription changed; the whole current state follows, so a reader can start over.',
      '- `end`: `reason` (`interrupted`, `until`, `desk-closed` or `error`).',
      '',
      "With `--raw` the desk's own notifications are printed between `hello` and `end` instead.",
    ].join('\n'),
    exits: {
      0: 'The stream ended: `--until` was reached, or the desk closed.',
      130: 'Interrupted with Ctrl-C. The final `end` line is written first.',
      143: 'Terminated. The final `end` line is written first.',
    },
  },
  {
    name: 'open', tier: 'run', methods: ['workspace/open'], flags: ['target'], execute: openProject,
    usage: 'open <path>',
    description: "Opens a folder as a project on the desk, as opening it in the app does, so its flows and Teams can work in it. Prints the project's path and name.",
    arguments: [{ name: 'path', description: 'The folder to open. Symbolic links are followed.' }],
    options: [],
    json: 'The project as the desk records it: `path`, `name`, `lastOpenedAt` and, for a Git folder, its repository facts.',
    exits: { 0: 'Opened.' },
  },
  {
    name: 'flows', tier: 'read', methods: ['flow/catalog'], flags: ['project'], execute: flows,
    usage: 'flows [--project PATH]',
    description: "Lists the flows a project offers, with where each comes from and any problem in it. A flow is a file that says who does what, and in which order. For each one it prints its id, whether it comes from the project, from you or from the app, and any problem the desk found in it.",
    arguments: [],
    options: [{ flag: '--project', value: 'PATH', description: 'The project to list: the path of its folder. Defaults to the Git repository containing the current folder.' }],
    json: 'A single object, `{ "flows": [...] }`. Each flow has `id`, `origin` (`project`, `user` or `builtin`), `path`, `name`, `description` and `problem`.',
    exits: { 0: 'Done.', 2: 'Not inside a Git repository, and no `--project`.' },
  },
  {
    name: 'flow preview', tier: 'read', methods: ['flow/source', 'flow/preview'], flags: ['target', 'project', 'title', 'briefFile', 'input', 'seat', 'unattended'], execute: previewFlow,
    usage: 'flow preview <flow> [--project PATH] [--title TEXT] [--brief-file PATH] [--input NAME=VALUE] [--seat ROLE=RUNTIME] [--unattended]',
    description: "Says what a flow would do, without doing it or spending anything. It lists the seats the flow would open (with any override beside the file's own), the check commands it would run, and everything wrong with it. A preview opens no session, spends nothing and starts nothing, so it is free to repeat. Warnings stay visible and do not stop a start.",
    arguments: [FLOW_ARGUMENT],
    options: FLOW_OPTIONS,
    json: "The preview exactly as the desk returns it: `token` (what a start redeems; `null` when the flow has an error a start could not get past), `attended`, `overrides`, `compiled`, `seats`, `commands`, `guards`, `messaging` and `problems`.",
    exits: {
      0: 'The flow can be started.',
      2: 'The flow has no such input. The inputs it declares are listed.',
      4: 'The preview has errors, or no token to start with. The problems are printed.',
    },
  },
  {
    name: 'flow start', tier: 'run', methods: ['flow/source', 'flow/preview', 'flow/start-goal'], flags: ['target', 'project', 'title', 'briefFile', 'input', 'seat', 'unattended', 'yes'], execute: startFlow,
    usage: 'flow start <flow> [--project PATH] [--title TEXT] [--brief-file PATH] [--input NAME=VALUE] [--seat ROLE=RUNTIME] [--unattended] [--yes]',
    description: "Starts a Team running a flow, after showing a preview. It previews first, then on a terminal asks `Start this Flow? [y/N]`; `--yes` answers for you, and is needed when there is no terminal. Prints the new run and its Team. Starting spends: the flow's seats run commands, within their ceilings.",
    arguments: [FLOW_ARGUMENT],
    options: [...FLOW_OPTIONS, YES_OPTION],
    json: '`{ "run": "<run id>", "team": "<Team id>" }` on stdout. The preview and the confirmation prompt go to stderr, so a pipe sees only this.',
    exits: {
      0: 'Started.',
      2: 'There is no terminal and no `--yes`, or the flow has no such input.',
      4: 'The preview has errors or no token to start with, or you answered no.',
    },
  },
  {
    name: 'run show', tier: 'read', methods: ['flow/execution', 'client/subscribe', 'evidence/board', 'finding/list', 'finding/run'], flags: ['target'], execute: showRun,
    usage: 'run show <run>',
    description: 'Shows the shared Run timeline: its header, brief, rounds, cards, check results, findings and ending. It keeps attendance and seat overrides. Round lines show answered counts; review rows show recorded publication state. JSON keeps the execution unchanged.',
    arguments: [RUN_ARGUMENT],
    options: [],
    json: "The run exactly as the desk holds it: `id`, `goal` (the Team's id), `state`, `attended`, `rounds`, `reason`, `overrides` and the flow's own `document`.",
    exits: { 0: 'Done.' },
  },
  {
    name: 'run stop', tier: 'run', methods: ['flow/execution/stop'], flags: ['target', 'reason', 'yes'], execute: stopRun,
    usage: 'run stop <run> --reason TEXT [--yes]',
    description: "Stops a run and interrupts its seats, without opening the next card. It ends the run's current round and fires no rule, so no reviewer or fixer card opens afterwards. The run then reads stopped, by you, with your reason. Stopping a run that has already ended answers with that run unchanged. On a terminal it asks `Stop this run? [y/N]`; `--yes` answers for you, and is needed when there is no terminal.",
    arguments: [RUN_ARGUMENT],
    options: [{ flag: '--reason', value: 'TEXT', description: 'Why the run is stopped. Required, and recorded with the run.' }, YES_OPTION],
    json: 'The stopped run: the object `run show` prints.',
    exits: {
      0: 'Stopped, or it had already ended.',
      2: 'There is no terminal and no `--yes`.',
      4: 'You answered no, or the desk refused.',
    },
  },
  {
    name: 'run wait', tier: 'read', methods: ['client/subscribe', 'flow/execution'], flags: ['target', 'timeout'], execute: waitRun,
    usage: 'run wait <run> [--timeout SECONDS]',
    description: 'Waits for a run to end, without polling, and says how it ended in its exit code. A run that has already ended answers at once. A run that is waiting for you, on a person card or a question from one of its seats, also ends the wait.',
    arguments: [RUN_ARGUMENT],
    options: [{ flag: '--timeout', value: 'SECONDS', description: 'Give up after this many seconds, counted from when the command starts, and exit 8. Any finite number from 0 up; leave it out to wait without a deadline.' }],
    json: '`{ "run": "<run id>", "state": "<state>", "reason": "<reason>" }`. `state` is `null` when the timeout or a signal came before the desk had answered, and `reason` is `null` when the run has none.',
    exits: {
      0: 'The run settled.',
      5: 'The run is waiting for a person: an open person card, or a question from one of its seats.',
      7: 'The run ended stopped or stalled.',
      8: 'The timeout passed first.',
      130: 'Interrupted with Ctrl-C.',
      143: 'Terminated.',
    },
  },
  {
    name: 'card show', tier: 'read', methods: ['goal/read'], flags: ['team', 'card'], execute: showCard,
    usage: 'card show <team> <card>',
    description: "One card on a Team's board: its role, state, outcome, note and handoff. The handoff is what the card's worker left for whoever picks the work up next.",
    arguments: [TEAM_ARGUMENT, CARD_ARGUMENT],
    options: [],
    json: 'The card as the board holds it: `id`, `title`, `state`, `role`, `outcome`, `note`, `handoff` and more.',
    exits: { 0: 'Done.', 4: 'The Team has no such card.' },
  },
  {
    name: 'card handoff', tier: 'read', methods: ['goal/read'], flags: ['team', 'card'], execute: handoffCard,
    usage: 'card handoff <team> <card>',
    description: "Prints a card's handoff text and nothing else, so it can go down a pipe. Line breaks are kept; control characters are removed.",
    arguments: [TEAM_ARGUMENT, CARD_ARGUMENT],
    options: [],
    json: '`{ "handoff": "<text>" }`.',
    exits: { 0: 'Printed.', 1: 'The card has no handoff. One line on stderr says so.', 4: 'The Team has no such card.' },
  },
  {
    name: 'card answer', tier: 'answer', action: 'done', methods: ['team/intent'], flags: ['team', 'card', 'outcome', 'contextFile'], execute: answerCard,
    usage: 'card answer <team> <card> <outcome> [--context-file PATH|-]',
    description: "Answers a card a flow addressed to a person, with one of its role's outcomes. You give an outcome the card's role declares, and optionally the context to go with it. The run moves on from there, and the Team's channel shows the answer as given from the command line. The first answer wins: a card that has been answered cannot be answered again. The desk grants this only when Settings › Permissions › Let command-line clients answer for me is on; a scripted desk can set `HARNESSDESK_CLIENTS_MAY_ANSWER=1` in its environment instead.",
    arguments: [TEAM_ARGUMENT, CARD_ARGUMENT, { name: 'outcome', description: "One of the outcomes the card's role declares in the flow." }],
    options: [{ flag: '--context-file', value: 'PATH|-', description: 'Context to send with the answer, read from this file or from standard input with `-`. There is no argument for it on the command line itself.' }],
    json: '`{ "team": "<Team id>", "card": <number>, "outcome": "<outcome>" }`.',
    exits: {
      0: 'Answered.',
      4: "Refused: the card is not addressed to a person, the outcome is not one its role declares, the card was already answered (`alreadyAnswered`), or the desk does not grant answers (`tierNotGranted`). The desk's code is printed on stderr.",
    },
  },
  {
    name: 'card abandon', tier: 'run', action: 'abandon', methods: ['goal/read', 'flow/executions', 'flow/execution', 'team/intent'], flags: ['team', 'card', 'reason', 'yes'], execute: abandonCard,
    usage: 'card abandon <team> <card> --reason TEXT [--yes]',
    description: "Abandons a card, though the rule after its role still fires. That rule may open the next role's card: before it asks, the command says which role that would be, and points to `run stop` as the way to end the work instead. On a terminal it asks `Abandon this card? [y/N]`; `--yes` answers for you, and is needed when there is no terminal.",
    arguments: [TEAM_ARGUMENT, CARD_ARGUMENT],
    options: [{ flag: '--reason', value: 'TEXT', description: 'Why the card is abandoned. Required, and recorded with the card.' }, YES_OPTION],
    json: '`{ "role": "<the abandoned card\'s role>", "nextRole": "<the role that opened next>" }`; either is `null` when there is none.',
    exits: {
      0: 'Abandoned.',
      2: 'There is no terminal and no `--yes`.',
      4: 'You answered no, or the desk refused.',
    },
  },
  {
    name: 'waiting', tier: 'read', methods: ['client/subscribe'], flags: ['watch'], execute: waiting,
    usage: 'waiting [--watch]',
    description: 'Everything waiting for a person: person cards, questions from seats and tool approvals. It only reads: it answers none of them, and approvals and questions are answered in the app. Each item has an id that stays the same, and clears under the same id.',
    arguments: [],
    options: [{ flag: '--watch', description: 'Keep going: print `waiting` and `waiting.cleared` events, between `hello` and `end`, until interrupted.' }],
    json: 'A single object, `{ "waiting": [...] }`, each item with `id`, `team`, `kind` (`card`, `question` or `approval`), `card` or `seat`, and `summary`. With `--watch`, one event per line instead, as `watch` prints them.',
    exits: {
      0: 'Done.',
      130: 'Interrupted with Ctrl-C (with `--watch`).',
      143: 'Terminated (with `--watch`).',
    },
  },
] as const satisfies readonly Command[]

class UsageError extends Error {}
/** The second line of every usage message: the command line's own, and the same each time. */
const USAGE_LINE = 'harnessdesk <desks|status|teams|runs|watch|open|flows|flow preview|flow start|run show|run stop|run wait|card show|card handoff|card answer|card abandon|waiting> [--home DIR] [--json] [--trace-wire]'
// The reason is one line, whatever it was made of: it can carry a name the person typed, or one a flow file declared.
function usage(reason: string): never { throw new UsageError(`Usage: ${sanitizeHuman(reason)}`) }
/** The flags every command takes, as the keys the parser stores them under. */
export const GLOBAL_FLAG_KEYS: readonly string[] = ['home', 'json', 'traceWire']
const switches = new Set(['json', 'all', 'raw', 'traceWire', 'unattended', 'yes', 'watch'])
/** Every flag's spelling, and the key the parser stores it under. */
export const FLAG_KEYS: Readonly<Record<string, keyof Arguments>> = { '--home': 'home', '--json': 'json', '--trace-wire': 'traceWire', '--project': 'project', '--team': 'team', '--run': 'run', '--all': 'all', '--raw': 'raw', '--until': 'until', '--title': 'title', '--brief-file': 'briefFile', '--input': 'input', '--seat': 'seat', '--unattended': 'unattended', '--yes': 'yes', '--timeout': 'timeout', '--reason': 'reason', '--context-file': 'contextFile', '--watch': 'watch' }

export function parseArgs(argv: readonly string[]): Arguments {
  const result: Record<string, string | boolean | string[]> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) {
      if (!result['command']) result['command'] = arg
      else if (result['command'] === 'flow' || result['command'] === 'run' || result['command'] === 'card') result['command'] += ` ${arg}`
      else if (['open', 'flow preview', 'flow start', 'run show', 'run wait', 'run stop'].includes(String(result['command'])) && !result['target']) result['target'] = arg
      else if (String(result['command']).startsWith('card ') && !result['team']) result['team'] = arg
      else if (String(result['command']).startsWith('card ') && !result['card']) result['card'] = arg
      else if (result['command'] === 'card answer' && !result['outcome']) result['outcome'] = arg
      else usage(`Unexpected argument ${arg}`)
      continue
    }
    const key = FLAG_KEYS[arg]
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
    if (key !== 'command' && !GLOBAL_FLAG_KEYS.includes(key) && !(command.flags as readonly string[]).includes(key)) usage(`--${key} is not available on ${command.name}`)
  }
  if (['team', 'run', 'project'].filter(key => result[key] !== undefined).length > 1) usage('Choose only one of --team, --run, --project')
  if ((command.flags as readonly string[]).includes('target') && !result['target']) usage(`${command.name} requires a target`)
  if (command.name.startsWith('card ') && (!result['team'] || !result['card'] || !/^\d+$/.test(String(result['card'])) || !Number.isSafeInteger(Number(result['card'])))) usage(`${command.name} requires a team and numeric card id`)
  if (command.name === 'card answer' && !result['outcome']) usage('card answer requires an outcome')
  if ((command.name === 'run stop' || command.name === 'card abandon') && (typeof result['reason'] !== 'string' || !result['reason'].trim())) usage(`${command.name} requires --reason TEXT`)
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

/** What marks every line of a message but the first, so that no line of it can pass for one the command line wrote. */
const CONTINUATION = '  | '

/**
 * What is printed for a failure.
 *
 * A usage message is the command line's own, and it is the only one that is two
 * lines: its reason is one line and its second line is a constant. Any other
 * message is not the command line's to vouch for: a desk's, with whatever an
 * agent put in it, or the system's naming a path an agent chose. It is cleaned
 * a line at a time and every line after the first is marked, so it keeps its
 * shape (a validation that lists three problems is three lines) and none of it
 * can pass for a line of ours, such as a usage line or an error code.
 */
export function errorText(error: unknown): string {
  if (error instanceof UsageError) return `${error.message}\n${USAGE_LINE}`
  // The desk's code is part of the first line, whatever it was made of.
  const code = error instanceof WireCallError ? `${sanitizeHuman(error.code)}: ` : ''
  const [first = '', ...rest] = (error instanceof Error ? error.message : String(error)).split('\n').map(sanitizeHuman)
  return [`${code}${first}`, ...rest.map(line => `${CONTINUATION}${line}`)].join('\n')
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
    process.stderr.write(errorText(error) + '\n')
    return errorExit(error)
  }
}

async function projectOf(args: Arguments): Promise<string> {
  if (args.project) return canonicalProject(args.project)
  try {
    return await repositoryRoot()
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
  process.stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of process.stdin) text += chunk.toString()
  return text
}

async function flowRequest(args: Arguments, client: Client) {
  const root = await projectOf(args), target = args.target!
  // Paths belong to the caller. The desk only receives text, or a catalogue
  // id it resolves under its own catalogue rules; it never opens this path.
  const source = target.includes('/') || /\.ya?ml$/i.test(target)
    ? await readTextFile(target) : await client.call('flow/source', { root, id: target })
  const vars: Record<string, string> = Object.create(null)
  for (const entry of args.input ?? []) {
    const split = entry.indexOf('=')
    if (split <= 0) usage('--input needs name=value or name=@path')
    const name = entry.slice(0, split), value = entry.slice(split + 1)
    if (Object.hasOwn(vars, name)) usage(`Repeated input ${name}`)
    vars[name] = value.startsWith('@') ? await readTextFile(value.slice(1)) : value
  }
  if (args.briefFile !== undefined) {
    if (Object.hasOwn(vars, 'brief')) usage('Choose --brief-file or --input brief, once')
    vars['brief'] = args.briefFile === '-' ? await stdinText() : await readTextFile(args.briefFile)
  }
  if (args.title !== undefined) {
    if (Object.hasOwn(vars, 'title')) usage('Choose --title or --input title, once')
    vars['title'] = args.title
  }
  const seats: Record<string, readonly FlowSeat[]> = Object.create(null)
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
    return preview.problems.some(problem => problem.level === 'error') || !preview.token ? 4 : 0
  } finally { client.close() }
}

async function startFlow(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const { preview, ...request } = await flowRequest(args, client)
    // --yes acknowledges this preview; a pipe never implies approval to
    // spend. JSON keeps stdout to the start result, even during confirmation.
    printPreview(preview, args.json ? process.stderr : process.stdout)
    if (preview.problems.some(problem => problem.level === 'error') || !preview.token) return 4
    if (!args.yes) {
      if (!process.stdin.isTTY || process.stdin.readableEnded) usage('Without terminal input, flow start requires --yes')
      if (!/^y(?:es)?$/i.test((await readConfirmation('Start this Flow? [y/N] ')).trim())) return 4
    }
    const run = await client.call('flow/start-goal', { ...request, token: preview.token, sentence: args.title ?? preview.compiled.document.flow.name })
    output(args, { run: run.id, team: run.goal }, () => line([run.id, run.goal]))
    return 0
  } finally { client.close() }
}

async function showRun(args: Arguments): Promise<number> {
  const client = await open(args, undefined, args.json ? undefined : { topics: ['cards', 'teams'], scope: { run: args.target! } })
  try {
    if (args.json) {
      output(args, await client.call('flow/execution', { run: args.target! }), () => {})
      return 0
    }
    await client.synced()
    const snapshot = client.snapshot()
    const run = snapshot.runs.find(one => one.id === args.target)
    if (!run) throw new WireCallError('notFound', 'The Run is not in the subscription baseline.')
    const evidence = await client.call('evidence/board', { room: run.goal })
    const findings: FindingView[] = []
    let cursor: string | undefined
    do {
      const page = await client.call('finding/list', { goal: run.goal, filter: 'all', ...(cursor ? { cursor } : {}) })
      findings.push(...page.rows)
      cursor = page.next ?? undefined
    } while (cursor)
    const findingRun = await client.call('finding/run', { goal: run.goal, run: run.id })
    const timeline = runTimelineOf(snapshot, run, { evidence, findings, findingRun })
    const header = timeline.header
    line([header.run, header.flow, header.state, run.attended === false ? 'unattended' : 'attended',
      header.revision ? `revision ${header.revision}` : null, header.continues ? `continues ${header.continues}` : null,
      header.publication?.label, header.needsYou ? 'Needs you' : null])
    for (const row of timeline.rows) line([row.title, row.status, row.publication?.label, row.detail,
      row.durationMs === null ? null : `${row.durationMs}ms`])
    for (const [role, seats] of Object.entries(run.overrides ?? {})) line([role, 'override', seats.map(seatSpec).join(', ')])
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
    // A run subscription carries its whole Team's questions. Match the
    // session to a Seat this Run recorded before treating it as a person wait.
    const members = snapshot.teams.find(team => team.goal.id === run.goal)?.members ?? []
    const question = snapshot.approvals.some(one =>
      (one.approval.type === 'userInput' || one.approval.type === 'elicitation') &&
      members.some(member => member.session.runtime === one.runtime && member.session.sessionId === one.sessionId &&
        run.rounds.some(round => round.seats.includes(member.id))))
    if (person || question) { code = 5; reason = person ? 'waiting for a person card' : 'waiting for an answer' }
  }
  try {
    client = await open(args, undefined, { topics: ['runs', 'cards', 'teams', 'waiting'], scope: { run: args.target! } }, transport => {
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


async function confirmAction(args: Arguments, prompt: string): Promise<boolean> {
  if (args.yes) return true
  if (!process.stdin.isTTY || process.stdin.readableEnded) usage(`Without terminal input, ${args.command} requires --yes`)
  return /^y(?:es)?$/i.test((await readConfirmation(prompt)).trim())
}

async function stopRun(args: Arguments): Promise<number> {
  if (!await confirmAction(args, 'Stop this run? [y/N] ')) return 4
  const client = await open(args)
  try {
    const run = await client.call('flow/execution/stop', { run: args.target!, reason: args.reason! })
    output(args, run, () => line([run.id, run.state, run.reason]))
    return 0
  } finally { client.close() }
}


async function readCard(args: Arguments, client: Client) {
  const view = await client.call('goal/read', { goal: args.team! })
  const card = view.board.intents.find(card => card.id === Number(args.card))
  if (!card) throw new WireCallError('refused', 'There is no such card on this Team.')
  return card
}

function handoffText(text: string): string { return text.split('\n').map(sanitizeHuman).join('\n') }
function printHandoff(text: string): void { process.stdout.write(handoffText(text) + (text.endsWith('\n') ? '' : '\n')) }

async function showCard(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const card = await readCard(args, client)
    output(args, card, () => {
      line([card.id, card.role, card.state, card.title])
      line(['outcome', card.outcome ?? '(none)']); line(['note', card.note ?? '(none)'])
      line(['handoff']); if (card.handoff) printHandoff(card.handoff); else line(['(none)'])
    })
    return 0
  } finally { client.close() }
}

async function handoffCard(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const card = await readCard(args, client)
    if (!card.handoff) { process.stderr.write('This card has no handoff.\n'); return 1 }
    if (args.json) jsonLine({ handoff: card.handoff }); else printHandoff(card.handoff)
    return 0
  } finally { client.close() }
}

async function answerCard(args: Arguments): Promise<number> {
  const context = args.contextFile === undefined ? undefined : args.contextFile === '-' ? await stdinText() : await readTextFile(args.contextFile)
  const client = await open(args)
  try {
    await client.call('team/intent', { room: args.team!, id: Number(args.card), action: 'done', outcome: args.outcome!, ...(context === undefined ? {} : { context }) })
    output(args, { team: args.team, card: Number(args.card), outcome: args.outcome }, () => line([args.team, args.card, 'answered', args.outcome]))
    return 0
  } finally { client.close() }
}

async function abandonCard(args: Arguments): Promise<number> {
  const client = await open(args)
  try {
    const card = await readCard(args, client)
    const runs = await client.call('flow/executions', { team: args.team, active: true })
    const executions = await Promise.all(runs.map(run => client.call('flow/execution', { run: run.id })))
    const execution = executions.find(run => run.rounds.some(round => round.cards.includes(card.id)))
    const rules = execution?.document.flow.rules.filter(rule => rule.on === card.role) ?? []
    const targets = rules.map(rule => `${rule.then.role}${rule.when ? ' (if its conditions match)' : ''}`)
    const message = `Abandoning ${card.role ?? 'this role'} still fires the rule after the role. ${targets.length ? `Next role: ${targets.join(', ')}; the first matching rule opens it.` : 'No next role is declared.'} To end the work, use run stop${execution ? ` ${execution.id}` : ' <run>'} --reason TEXT.`
    process.stderr.write(sanitizeHuman(message) + '\n')
    if (!await confirmAction(args, 'Abandon this card? [y/N] ')) return 4
    const result = await client.call('team/intent', { room: args.team!, id: Number(args.card), action: 'abandon', reason: args.reason! })
    output(args, result ?? { role: card.role ?? null, nextRole: null }, () => line([args.card, 'abandoned', 'role', result?.role ?? card.role, 'next role', result?.nextRole ?? '(none)']))
    return 0
  } finally { client.close() }
}

async function waiting(args: Arguments): Promise<number> {
  let client: Client | undefined, pending: ClientTransport | undefined, signalCode = 0
  const cancel = () => { client?.close(); pending?.close() }
  const interrupt = () => { signalCode ||= 130; cancel() }
  const terminate = () => { signalCode ||= 143; cancel() }
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  let drain: Promise<void> | undefined
  try {
    client = await open(args, undefined, { topics: ['waiting'] }, transport => { pending = transport; if (signalCode) transport.close() })
    if (signalCode) client.close()
    drain = (async () => { for await (const ignored of client!.notifications()) { void ignored } })()
    await client.synced()
    if (!args.watch) {
      const items = client.snapshot().waiting ?? []
      output(args, { waiting: items }, () => { for (const item of items) line([item.id, item.kind, item.team, item.card, item.summary]) })
    } else {
      for await (const event of client.events()) {
        if (['hello', 'waiting', 'waiting.cleared', 'gap', 'notice', 'end'].includes(event.type)) { if (args.json) jsonLine(event); else eventLine(event) }
      }
    }
    return signalCode
  } catch (error) { if (signalCode) return signalCode; throw error }
  finally { client?.close(); await drain; process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
}
