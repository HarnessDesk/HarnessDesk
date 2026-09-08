import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, sep } from 'node:path'

import type {
  AcpAgentConfig,
  AcpExecutableSpec,
  AcpLaunchDecision,
  ResolvedExecutable,
} from '@harnessdesk/adapter-acp'
import type { InstallCopy, InstallInfo } from '@harnessdesk/protocol'

import type { AgentRegistryStore } from '../agent-registry.js'
import { channelLabel } from './channels.js'
import { KNOWN_AGENTS, knownAgent, knownAgentByCommand, type CommandSpec, type KnownAgent } from './known-agents.js'
import { expandHome, findInstalls, judgeInstalls, type JudgedInstall, type LocateOptions } from './locate.js'

/**
 * Why the launch is being decided: a start settles every question the agent
 * has about itself, a re-check only asks whether a different copy should be
 * answering now.
 */
export type LaunchOccasion = 'start' | 'recheck'

/** What one scan concluded: every copy, and the one that answers. */
type Judgement = ReturnType<typeof judgeInstalls>
import { runForOutput } from './run.js'

/**
 * Which copy of an agent answers, decided from the machine, not from the row.
 *
 * A row in `agents.json` names one command. On a real machine the same
 * agent is often present two or three times — the copy `brew install` put
 * in the Cellar, the one `npm i -g` put beside node, the one the desk
 * downloaded from the registry, the one a vendor installer dropped into a
 * dot-folder — and each is a different version with a different model list.
 * The row's command was right the day it was written and is a coin toss
 * after that.
 *
 * So the row's command is the *fallback*. Before every start this service
 * looks for every copy the agent's knowledge names, asks each for its
 * version, and hands the runtime the newest one that is new enough — or
 * the one the person pinned. When nothing installed qualifies, the row runs
 * as written: a package runner fetches its pinned version, a download the
 * desk made answers. The person's own install always wins over ours, and a
 * copy that arrives or leaves is noticed on the next check.
 *
 * Two more things the row cannot know are decided here, because only the
 * machine can answer them: whether a service the agent needs is running
 * (OpenClaw's bridge is mute without its Gateway), and whether the agent's
 * own validator accepts its own configuration (a file written by another
 * version of the same agent is the commonest way an install that *looks*
 * fine refuses to start). Both become the runtime's health, in the agent's
 * own words, instead of a handshake that times out.
 */

type Log = (message: string, details?: Record<string, unknown>) => void

export interface InstallServiceOptions {
  readonly stateDir: string
  readonly store: Pick<AgentRegistryStore, 'entry' | 'patch'>
  /** The registry's current version of an entry, for the update advisory. */
  readonly registryVersion?: (id: string) => Promise<string | null>
  readonly locate?: Partial<LocateOptions>
  /** Runs a check command; exit 0 is a pass. Injectable for tests. */
  readonly check?: (spec: CommandSpec) => Promise<{ ok: boolean; output: string }>
  readonly now?: () => number
  readonly log?: Log
}

const runCheck = async (spec: CommandSpec): Promise<{ ok: boolean; output: string }> => {
  const result = await runForOutput(spec.command, spec.args ?? [], {
    timeoutMs: 20_000,
    ...(spec.env ? { env: spec.env } : {}),
  })
  const output = `${result.stdout}${result.stderr}`.trim()
  if (result.timedOut) return { ok: false, output: output || `${spec.command} did not answer within 20 seconds.` }
  return { ok: result.ok, output }
}

/** The first few lines that carry the reason, for a health sentence. */
const gist = (output: string, lines = 6): string =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, lines)
    .join('\n')

export class InstallService {
  readonly #last = new Map<string, InstallInfo>()
  readonly #managedDir: string

  constructor(private readonly options: InstallServiceOptions) {
    this.#managedDir = join(options.stateDir, 'acp-agents')
  }

  /** What the desk knows about the agent a row names, if anything. */
  knowledgeFor(config: Pick<AcpAgentConfig, 'id' | 'command' | 'executable'>): KnownAgent | undefined {
    const row = this.options.store.entry(config.id) ?? {}
    const byField = [row['agent'], (row['registry'] as { id?: unknown } | undefined)?.id, row['template'], config.id]
      .filter((value): value is string => typeof value === 'string')
      .map(knownAgent)
      .find((known) => known !== undefined)
    if (byField) return byField
    const cli = config.executable?.command ?? config.command
    return knownAgentByCommand(basename(cli))
  }

  /**
   * The row's own command, when it is a copy of *this agent* on disk.
   *
   * A row that names the agent's own CLI — a registry download, a path
   * someone wrote — is a copy the scan should count. A bridge row is not:
   * its command is the interpreter (`process.execPath`, which is Electron
   * in the app), and offering that path to the scan had it probed for a
   * version and listed as a copy of Claude. The name decides, because the
   * name is what the knowledge table is written against.
   */
  #storedCopy(config: Pick<AcpAgentConfig, 'command'>, known: KnownAgent | undefined): readonly string[] {
    if (!isAbsolute(config.command)) return []
    const named = known?.cli.commands.includes(basename(config.command)) ?? false
    // A managed download is ours and is named by its folder, not by the
    // command inside it, so it counts however the vendor spelled the file.
    const managed = config.command.startsWith(this.#managedDir + sep)
    return named || managed ? [config.command] : []
  }

  #locateOptions(
    config: Pick<AcpAgentConfig, 'command'>,
    known: KnownAgent | undefined,
  ): LocateOptions {
    return {
      managedDir: this.#managedDir,
      also: this.#storedCopy(config, known),
      ...this.options.locate,
    }
  }

  #pinOf(id: string): string | null {
    const install = this.options.store.entry(id)?.['install']
    const pin = typeof install === 'object' && install !== null ? (install as { pin?: unknown })['pin'] : undefined
    return typeof pin === 'string' ? pin : null
  }

  async #judge(config: AcpAgentConfig, known: KnownAgent) {
    const spec = {
      commands: known.cli.commands,
      ...(known.cli.paths ? { paths: known.cli.paths } : {}),
      ...(known.cli.versionArgs ? { versionArgs: known.cli.versionArgs } : {}),
      ...(known.cli.minVersion ? { minVersion: known.cli.minVersion } : {}),
      publish: {
        npmPackage: known.publish.npm ?? null,
        brewFormula: known.publish.brew ?? null,
        pypiPackage: known.publish.pypi ?? null,
        selfUpdate: known.publish.selfUpdate ?? null,
      },
    }
    const found = await findInstalls(spec, this.#locateOptions(config, known))
    return judgeInstalls(found, {
      ...(known.cli.minVersion ? { minVersion: known.cli.minVersion } : {}),
      pinnedPath: this.#pinOf(config.id),
    })
  }

  /**
   * The whole picture for the interface: every copy, the one that answers,
   * the fallback, and what the knowledge says about updating, homes and
   * signing in. Null for an agent the desk has no table for. Remembered,
   * so `RuntimeInfo` can carry it without a scan per read.
   */
  async describe(config: AcpAgentConfig, judged?: Judgement): Promise<InstallInfo | null> {
    const known = this.knowledgeFor(config)
    if (!known) return null
    // Handed the judgement its caller already made, when there is one. Every
    // scan spawns one `--version` per copy on the machine, and describing a
    // decision by making it again doubled that for every agent start — ten
    // agents coming up at once meant twenty machine-wide scans, the second
    // ten racing the starts they were describing.
    const { chosen, copies } = judged ?? (await this.#judge(config, known))
    const row = this.options.store.entry(config.id) ?? {}
    const provenance = row['registry'] as { id?: string; version?: string } | undefined
    const fallback = this.#fallbackOf(config, copies)
    let registryUpdate: { version: string } | null = null
    if (provenance?.id && provenance.version && this.options.registryVersion) {
      const current = await this.options.registryVersion(provenance.id).catch(() => null)
      if (current && isNewer(current, provenance.version)) registryUpdate = { version: current }
    }
    const info: InstallInfo = {
      copies: copies.map(toCopy),
      chosen: chosen ? toCopy(chosen) : null,
      policy: this.#pinOf(config.id) ? 'pinned' : 'newest',
      fallback,
      ...(known.cli.minVersion ? { minVersion: known.cli.minVersion } : {}),
      ...(known.cli.minVersionReason ? { minVersionReason: known.cli.minVersionReason } : {}),
      registryUpdate,
      home: {
        path: known.home.path,
        ...(known.home.env ? { env: known.home.env } : {}),
        ...(known.home.note ? { note: known.home.note } : {}),
      },
      signIn: {
        ...(known.auth.terminal ? { terminal: known.auth.terminal } : {}),
        note: known.auth.note,
      },
      installCommand: known.publish.installCommand,
      checkedAt: (this.options.now ?? Date.now)(),
    }
    this.#last.set(config.id, info)
    return info
  }

  /** The last description, without a scan. */
  last(id: string): InstallInfo | null {
    return this.#last.get(id) ?? null
  }

  /**
   * What the row itself runs when no installed copy is chosen. A download
   * the desk made is `managed` (the desk may replace it); so is a package
   * runner, whose pinned version the desk wrote and may rewrite.
   */
  #fallbackOf(config: AcpAgentConfig, copies: readonly JudgedInstall[]): InstallInfo['fallback'] {
    const command = config.command
    const stored = isAbsolute(command) ? copies.find((copy) => copy.path === command) : undefined
    if (stored) {
      return { command, version: stored.version, managed: stored.managed }
    }
    const runner = basename(command)
    if (runner === 'npx' || runner === 'uvx') {
      const pkg = (config.args ?? []).find((arg) => !arg.startsWith('-')) ?? ''
      const at = pkg.lastIndexOf('@')
      const version = at > 0 ? pkg.slice(at + 1) : pkg.includes('==') ? pkg.split('==')[1] ?? null : null
      return { command: [command, ...(config.args ?? [])].join(' '), version, managed: true }
    }
    if (isAbsolute(command) && !existsSync(command)) return null
    return { command: [command, ...(config.args ?? [])].join(' '), version: null, managed: false }
  }

  /**
   * The launch decision for a direct agent — one whose CLI speaks ACP
   * itself. The chosen copy runs with the knowledge's ACP arguments; the
   * agent's own checks run first. Null means "run the row as written":
   * either the desk has no knowledge of this agent, or nothing installed
   * qualifies and the row's fallback is the right answer.
   */
  async launchFor(config: AcpAgentConfig, occasion: LaunchOccasion = 'start'): Promise<AcpLaunchDecision | null> {
    const known = this.knowledgeFor(config)
    if (!known || known.acp.bridge) return null
    const judged = await this.#judge(config, known)
    const { chosen, copies } = judged
    const cli = chosen?.path ?? null
    if (!cli) {
      const fallback = this.#fallbackOf(config, copies)
      // Which fallbacks are worth running when nothing qualified.
      //
      // A package runner is: it fetches its own pinned version, which is not
      // a copy on this machine and was never judged. A row that *names the
      // agent's CLI* is not — whether by a bare name the scan could not find
      // (spawning it only produces ENOENT a moment later) or by an absolute
      // path the scan found and rejected. That second case is the one that
      // mattered: with the row at `/usr/local/bin/gemini` and that copy below
      // the floor, `chosen` was null but the fallback looked runnable, so the
      // start went ahead on the very binary the floor exists to refuse.
      const rowNamesTheCli = known.cli.commands.includes(basename(config.command))
      const rowWasJudged = copies.some((copy) => copy.path === config.command)
      if (fallback && !rowNamesTheCli && !rowWasJudged) {
        void this.describe(config, judged)
        return null
      }
      const tooOld = copies.find((copy) => copy.standing === 'too-old')
      void this.describe(config, judged)
      return {
        blocked: tooOld
          ? {
              reason: 'versionTooOld',
              // The knowledge's own reason is a written sentence and ends
              // like one; only the stand-in needs a full stop adding, or the
              // message ends "…started with the old flag.." — the same slip
              // the copy in `lib/installs.ts` had.
              message: `${known.name} ${tooOld.version} at ${tooOld.path} is too old: ${
                known.cli.minVersionReason ?? `${known.cli.minVersion} or newer is needed.`
              }`,
              // The road it came by, when that road has an update verb;
              // otherwise the vendor's own install line, because a copy
              // someone put on the machine by hand still has to be replaced
              // somehow and a refusal with no way forward is a dead end.
              remediation: tooOld.updateCommand
                ? `Update it with \`${tooOld.updateCommand}\`.`
                : `Install a newer one with \`${known.publish.installCommand}\`.`,
            }
          : {
              reason: 'notInstalled',
              message: `${known.name} is not installed on this machine.`,
              remediation: `Install it with \`${known.publish.installCommand}\`.`,
            },
      }
    }
    const withCli = (spec: CommandSpec): CommandSpec =>
      known.cli.commands.includes(spec.command) ? { ...spec, command: cli } : spec
    const check = this.options.check ?? runCheck
    // The agent's own checks answer "should this start?", and that question
    // is settled once it has. A re-check asks something narrower — is a
    // different copy the one that should answer now — so it does not shell
    // out to `config validate` and a daemon probe again. Without this the
    // refresher's half-hourly tick, and every focus return, ran two
    // 20-second-budget commands per known agent for the life of the app.
    if (occasion === 'start' && known.preflight) {
      const result = await check(withCli(known.preflight.command))
      if (!result.ok) {
        void this.describe(config, judged)
        return {
          blocked: {
            reason: 'unknown',
            message: `${known.name} refuses its own configuration:\n${gist(result.output)}`,
            remediation: known.preflight.remediation,
          },
        }
      }
    }
    if (occasion === 'start' && known.daemon) {
      const result = await check(withCli(known.daemon.check))
      if (!result.ok) {
        void this.describe(config, judged)
        return {
          blocked: {
            reason: 'unknown',
            message: `${known.daemon.name} is not running.`,
            remediation: `${known.daemon.note} Start it with \`${known.daemon.start}\`.`,
          },
        }
      }
    }
    void this.describe(config, judged)
    return {
      command: cli,
      args: [...known.acp.args],
      ...(known.acp.env ? { env: known.acp.env } : {}),
      version: chosen?.version ?? null,
    }
  }

  /**
   * The CLI a bridge should drive, from the same scan: the newest copy that
   * is new enough, or the pinned one. Absent knowledge, a plain PATH lookup
   * through the same probe, so a bridge for an unknown CLI still works.
   */
  async executableFor(config: AcpAgentConfig, spec: AcpExecutableSpec): Promise<ResolvedExecutable | null> {
    const known = this.knowledgeFor(config)
    const found = await findInstalls(
      {
        commands: known?.cli.commands.includes(basename(spec.command)) ? known.cli.commands : [spec.command],
        ...(known?.cli.paths ? { paths: known.cli.paths } : {}),
        ...(spec.versionArgs ? { versionArgs: spec.versionArgs } : known?.cli.versionArgs ? { versionArgs: known.cli.versionArgs } : {}),
        publish: known
          ? {
              npmPackage: known.publish.npm ?? null,
              brewFormula: known.publish.brew ?? null,
              pypiPackage: known.publish.pypi ?? null,
              selfUpdate: known.publish.selfUpdate ?? null,
            }
          : {},
      },
      { ...this.#locateOptions(config, known), also: isAbsolute(spec.command) ? [spec.command] : [] },
    )
    const judged = judgeInstalls(found, {
      ...(known?.cli.minVersion ? { minVersion: known.cli.minVersion } : {}),
      pinnedPath: this.#pinOf(config.id),
    })
    // The same scan, described rather than repeated.
    if (known) void this.describe(config, judged)
    return judged.chosen ? { path: judged.chosen.path, version: judged.chosen.version } : null
  }

  /**
   * The executable a bridge row should be told to drive, when the row does
   * not say and the knowledge does — a registry entry for an adapter that
   * reads the CLI's path from the environment.
   */
  executableSpecFor(config: AcpAgentConfig): AcpExecutableSpec | null {
    if (config.executable) return config.executable
    const known = this.knowledgeFor(config)
    if (!known?.acp.bridge) return null
    return {
      // The table is hand-transcribed vendor facts; an entry that lost its
      // command names should degrade to the row's own, not throw while the
      // host is being built.
      command: known.cli.commands[0] ?? config.command,
      env: known.acp.bridge.executableEnv,
      ...(known.cli.versionArgs ? { versionArgs: known.cli.versionArgs } : {}),
    }
  }

  /** Pins one copy, or clears the pin. The next start honours it. */
  pin(id: string, path: string | null): void {
    const current = this.options.store.entry(id)?.['install']
    const kept = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {}
    const next = { ...kept, pin: path ?? undefined }
    const install = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined))
    this.options.store.patch(id, { install: Object.keys(install).length > 0 ? install : undefined })
  }

  /**
   * Whether a known agent has a usable copy on this machine right now —
   * what the add page asks before offering a download, and what the
   * template rows say beside their names.
   */
  async installedCopyOf(known: KnownAgent): Promise<JudgedInstall | null> {
    const spec = {
      commands: known.cli.commands,
      ...(known.cli.paths ? { paths: known.cli.paths } : {}),
      ...(known.cli.versionArgs ? { versionArgs: known.cli.versionArgs } : {}),
    }
    const found = await findInstalls(spec, { managedDir: this.#managedDir, ...this.options.locate })
    return judgeInstalls(found, { ...(known.cli.minVersion ? { minVersion: known.cli.minVersion } : {}) }).chosen
  }

  /** The home the knowledge names, expanded for this machine. */
  homeOf(known: KnownAgent): string {
    return expandHome(known.home.path, this.options.locate?.home ?? homedir())
  }

  static get known(): readonly KnownAgent[] {
    return KNOWN_AGENTS
  }
}

const toCopy = (copy: JudgedInstall): InstallCopy => ({
  path: copy.path,
  version: copy.version,
  channel: copy.channel,
  channelLabel: channelLabel(copy.channel),
  standing: copy.standing,
  managed: copy.managed,
  updateCommand: copy.updateCommand,
})

const isNewer = (latest: string, running: string): boolean => {
  const parse = (raw: string) => {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
  }
  const a = parse(latest)
  const b = parse(running)
  if (!a || !b) return false
  return (a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!) > 0
}
