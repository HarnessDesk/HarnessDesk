import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { clientTierFor, type ClientTier, type HostParams } from '@harnessdesk/protocol'
import { openClientDoor, type ClientConnectionPolicy, type ClientDoor, type ClientDoorOptions } from '../client-door.js'
import type { Host } from '../host.js'

/** All inputs come from the host's approved contract and journal, never hello or
 * model arguments. Step 8 supplies the start hook; absence refuses every start. */
export interface LeadClientAuthorityOptions {
  readonly admission?: import('./admission.js').LeadAdmission
  readonly host: Pick<Host, 'call' | 'clientScopeViews'>
  readonly project: string
  readonly owned: readonly { readonly goal: string; readonly run: string }[]
  /** Live host journal projection, for starts admitted after this connection opened. */
  readonly readOwned?: () => readonly { readonly goal: string; readonly run: string }[]
  readonly maximumTiers?: readonly ClientTier[]
  readonly authorizeStart?: (params: HostParams<'flow/start-goal'>) => boolean | Promise<boolean>
}

export const createLeadClientAuthority = async (options: LeadClientAuthorityOptions): Promise<ClientConnectionPolicy> => {
  const project = await fs.realpath(options.project)
  const host = options.host
  const authorizeStart = options.admission?.authorizeStart ?? options.authorizeStart
  const initialOwned = options.owned.map(({ goal, run }) => Object.freeze({ goal, run }))
  const readOwned = options.admission?.readOwned ?? options.readOwned ?? (() => initialOwned)
  const runs = () => new Map(readOwned().map(({ goal, run }) => [run, goal]))
  const maximumTiers = Object.freeze((options.maximumTiers ?? ['read', 'run']).filter(tier => tier === 'read' || tier === 'run'))
  const inProject = async (path: string) => await fs.realpath(path) === project
  const goalInScope = async (goal: string) => {
    const view = host.clientScopeViews().find(view => view.goal.id === goal)
    return view !== undefined && [...runs().values()].includes(goal) && inProject(view.goal.root)
  }
  const runInScope = async (run: string, goal?: string) => {
    const owner = runs().get(run)
    return owner !== undefined && (goal === undefined || owner === goal) &&
      (await host.call('flow/execution', { run })).goal === owner && await goalInScope(owner)
  }
  const seatInScope = async (runtime: string, sessionId: string) => {
    const seat = await host.call('evidence/seat', { runtime, sessionId })
    return seat?.board != null && await goalInScope(seat.board)
  }
  return Object.freeze({
    identity: 'lead', maximumTiers,
    preview: options.admission?.preview,
    authorize: async request => {
      try {
        if (clientTierFor(request.method, request.params) === 'answer') return 'tierNotGranted'
        // Re-resolve the pinned location, including on reads, rather than allowing
        // a renamed/deleted project to be replaced by a new alias at dispatch.
        if (!await inProject(project)) return 'leadScope'
        // Goal-level reads cover every execution on an owned Goal, including
        // one a person continued. Run-level reads stay ownership-scoped.
        // Lead reads cover only this contract's owned Goals and runs, inside
        // its canonical project. The door filters collections and subscriptions
        // with the same single-read checks; project scope never grants ownership.
        switch (request.method) {
          case 'client/hello': return null
          case 'library/usage': return 'leadScope'
          case 'workspace/open': return await inProject(request.params.path) ? null : 'leadScope'
          case 'flow/catalog': case 'flow/source': case 'goal/list':
            return request.params.root !== undefined && await inProject(request.params.root) ? null : 'leadScope'
          case 'flow/preview':
            return await inProject(request.params.root) && request.params.retry === undefined && request.params.continues === undefined ? null : 'leadScope'
          case 'flow/start-goal':
            if (!await inProject(request.params.root) || request.params.continues != null || request.params.goal !== undefined) return 'leadScope'
            return await authorizeStart?.(request.params) === true ? null : 'leadStartNotApproved'
          case 'flow/execution': case 'flow/execution/stop':
            return await runInScope(request.params.run) ? null : 'leadScope'
          case 'goal/read': case 'insight/goal': case 'finding/list':
            return await goalInScope(request.params.goal) ? null : 'leadScope'
          case 'finding/run':
            return await runInScope(request.params.run, request.params.goal) ? null : 'leadScope'
          case 'evidence/board': return await goalInScope(request.params.room) ? null : 'leadScope'
          case 'evidence/seat': return await seatInScope(request.params.runtime, request.params.sessionId) ? null : 'leadScope'
          case 'flow/executions': {
            const { team, project: target } = request.params
            if (target !== undefined && !await inProject(target)) return 'leadScope'
            if (team !== undefined && !await goalInScope(team)) return 'leadScope'
            return target !== undefined || team !== undefined ? null : 'leadScope'
          }
          case 'client/subscribe': {
            const scope = request.params.scope
            if (scope?.team === undefined && scope?.run === undefined && scope?.project === undefined) return 'leadScope'
            if (scope.project !== undefined && !await inProject(scope.project)) return 'leadScope'
            if (scope.team !== undefined && !await goalInScope(scope.team)) return 'leadScope'
            if (scope.run !== undefined && !await runInScope(scope.run, scope.team)) return 'leadScope'
            return null
          }
          case 'team/intent': {
            if (request.params.action !== 'abandon' || !await goalInScope(request.params.room)) return 'leadScope'
            // A Goal can hold several executions; owning the Goal is insufficient
            // to abandon a card opened by a different execution on that Goal.
            for (const [run, goal] of runs()) {
              if (goal !== request.params.room || !await runInScope(run, goal)) continue
              const execution = await host.call('flow/execution', { run })
              if (execution.rounds.some(round => round.cards.includes(request.params.id))) return null
            }
            return 'leadScope'
          }
          case 'library/read':
            return request.params.cwd !== undefined && await inProject(request.params.cwd) ? null : 'leadScope'
          case 'library/definition':
            return request.params.cwd !== undefined && await inProject(request.params.cwd) ? null : 'leadScope'
          default: return 'leadScope'
        }
      } catch { return 'leadScope' }
    },
  } satisfies ClientConnectionPolicy)
}

/** A unix socket path is capped near 104 bytes and the door's is `<parent>/hd-lead-XXXXXX/<16 hex>.sock`. A home deep
 * enough to overflow that keeps its reserved parent in a short, per-user, per-home directory instead, so the Lead
 * does not stop answering for the length of someone's path. */
const SOCKET_ROOM = '/hd-lead-XXXXXX/0123456789abcdef.sock'.length
const leadClientParent = async (home: string, create: boolean): Promise<string | null> => {
  const real = await fs.realpath(home)
  const beside = join(real, 'lead-clients')
  const parent = beside.length + SOCKET_ROOM < 104 ? beside
    : `/tmp/hd-lead-${process.getuid!()}-${createHash('sha256').update(real).digest('hex').slice(0, 8)}`
  if (create) {
    try { await fs.mkdir(parent, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  let stat
  try { stat = await fs.lstat(parent) }
  catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700)
    throw new Error('lead-listener-parent')
  return parent
}

/** Call only after acquiring the home's single desk writer. Recovery is confined
 * to that home's reserved parent; no global temporary-directory sweep occurs. */
export const cleanupLeadClientDoors = async (home: string): Promise<void> => {
  if (process.platform === 'win32') return
  const parent = await leadClientParent(home, false)
  if (parent === null) return
  for (const name of await fs.readdir(parent)) {
    if (!/^hd-lead-[A-Za-z0-9]{6}$/.test(name)) continue
    const path = join(parent, name)
    const stat = await fs.lstat(path)
    // Foreign entries and links are preserved, including links to other homes.
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) continue
    await fs.rm(path, { recursive: true, force: true })
  }
}

/** The descriptor stays in the parent until the supervisor writes it to the
 * child's private input. There is no discovery pointer, argv or env marker.
 * Socket ownership is not an OS sandbox against another same-user process. */
export const openLeadClientDoor = async (
  options: Omit<ClientDoorOptions, 'policy' | 'discovery'> & { readonly authority: ClientConnectionPolicy; readonly onWithdrawn?: (runId: string) => void },
): Promise<ClientDoor | null> => {
  if (process.platform === 'win32') return null
  // Every private socket belongs to this home, rather than a global /tmp sweep.
  // The ordinary door's directory and discovery/environment switches stay separate.
  const parent = await leadClientParent(options.home, true)
  const directory = await fs.mkdtemp(join(parent!, 'hd-lead-'))
  try {
    const door = await openClientDoor({ host: options.host, logger: options.logger, home: options.home,
      hostVersion: options.hostVersion, directory, policy: { ...options.authority, onWithdrawn: options.onWithdrawn, identity: 'lead',
        maximumTiers: options.authority.maximumTiers.filter(tier => tier === 'read' || tier === 'run') }, discovery: false })
    if (!door) { await fs.rm(directory, { recursive: true, force: true }); return null }
    let closing: Promise<void> | undefined
    return { ...door, close: () => closing ??= (async () => {
      try { await door.close() }
      finally { await fs.rm(directory, { recursive: true, force: true }) }
    })() }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}
