import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { join } from 'node:path'
import {
  CLIENT_METHODS, CLIENT_PROTOCOL, clientTierFor, parseClientEnvelope, parseClientMessage,
  wireCodeOf, wireDataOf, wireError,
  type ClientTier, type ClientTopic, type ClientMethodName, type FlowExecutionSummary, type GoalView, type HostParams,
  type HostToClient, type WireNotification,
} from '@harnessdesk/protocol'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Host } from './host.js'
import type { Logger } from './log.js'
import { sameCanonicalPath, withCanonicalPaths } from './path-identity.js'

export type ClientConnectionRequest = {
  [M in ClientMethodName]: { readonly id: number; readonly method: M; readonly params: HostParams<M> }
}[ClientMethodName]

/** Trusted host input only. No hello field can install or modify a policy. */
export interface ClientConnectionPolicy {
  readonly preview?: (params: HostParams<'flow/preview'>) => Promise<import('@harnessdesk/protocol').FlowPreview>
  readonly identity: string
  readonly maximumTiers: readonly ClientTier[]
  /** Called after wire validation and before host dispatch; null admits the call. */
  readonly authorize: (request: ClientConnectionRequest) => Promise<string | null>
}

export interface ClientDoorOptions {
  readonly host: Host
  readonly logger: Logger
  readonly home: string
  readonly directory?: string
  readonly hostVersion: string
  readonly policy?: ClientConnectionPolicy
  /** Private listeners return their descriptor to the host without publishing it. */
  readonly discovery?: false
}
export interface ClientDoor {
  readonly socketPath: string
  readonly descriptor: {
    readonly home: string
    readonly pid: number
    readonly startedAt: number
    readonly hostVersion: string
    readonly protocolVersion: number
    readonly socketPath: string
  }
  close(): Promise<void>
}

/** Home is canonicalized by the caller; hashing alone is a pure operation. */
export const clientDoorPaths = (home: string, directory: string): { socketPath: string; pointerPath: string } => {
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 16)
  return { socketPath: join(directory, `${hash}.sock`), pointerPath: join(directory, `${hash}.json`) }
}

export const topicsOf = (notification: WireNotification): readonly ClientTopic[] => {
  switch (notification.method) {
    case 'flow/execution-changed': return ['runs']
    case 'team/changed': return ['cards']
    case 'goal/changed': case 'goal/activity': return ['teams']
    case 'person/notice': return ['notices']
    case 'seat/activity': return ['seats']
    case 'finding/changed': return ['reviews']
    case 'event': return notification.params.event.type === 'approval/requested' || notification.params.event.type === 'approval/resolved' ? ['waiting'] : []
    default: return []
  }
}

export const clientRefusal = (method: string, hello: boolean, tiers: readonly ClientTier[], params?: unknown): string | null => {
  const tier = clientTierFor(method, params)
  if (tier === null) return 'notOnClientSurface'
  if (!hello && method !== 'client/hello') return 'helloFirst'
  if (!tiers.includes(tier)) return 'tierNotGranted'
  return null
}

const alive = (path: string): Promise<boolean> => new Promise((resolve, reject) => {
  const socket = connectSocket(path)
  const finish = (result: boolean) => { socket.destroy(); resolve(result) }
  socket.once('connect', () => finish(true))
  socket.once('error', (error: NodeJS.ErrnoException) => {
    socket.destroy()
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false)
    else reject(error)
  })
  socket.setTimeout(500, () => finish(true))
})

export type ClientDoorFilesystem = Pick<typeof fs, 'realpath' | 'mkdir' | 'chmod' | 'unlink' | 'writeFile' | 'readFile' | 'rm' | 'rename'> & {
  lstat(path: string): Promise<Pick<Stats, 'uid' | 'mode' | 'isDirectory' | 'isSymbolicLink' | 'isSocket'>>
}

type Subscription = HostParams<'client/subscribe'>

const snapshotKey = (notification: WireNotification): string | null => {
  switch (notification.method) {
    case 'seat/activity': return `seat:${notification.params.goal}:${notification.params.seat}`
    case 'flow/execution-changed': return `run:${notification.params.execution.id}`
    case 'team/changed': return `board:${notification.params.state.id}`
    case 'goal/changed': return `goal:${notification.params.view.goal.id}`
    case 'goal/activity': return `goal:${notification.params.goal}`
    default: return null
  }
}

const overlaySnapshot = (previous: WireNotification | undefined, next: WireNotification): WireNotification => {
  if (previous?.method === 'goal/changed' && next.method === 'goal/activity') {
    return { method: 'goal/changed', params: { view: { ...previous.params.view,
      activity: next.params.activity, goal: { ...previous.params.view.goal, sentence: next.params.sentence } } } }
  }
  return next
}

const viewsInScope = async (host: Host, scope: Subscription['scope']): Promise<readonly GoalView[]> => {
  const views = await host.call('goal/list', {})
  const runGoal = scope?.run ? (await host.call('flow/execution', { run: scope.run })).goal : null
  return withCanonicalPaths(() => views.filter(view =>
    (scope?.team === undefined || view.goal.id === scope.team) &&
    (runGoal === null || view.goal.id === runGoal) &&
    (scope?.project === undefined || sameCanonicalPath(view.goal.root, scope.project))))
}

/** Every active Run and the newest one, whatever its state: a Team's starting state, read before its broadcasts. */
const activeAndNewest = (runs: readonly FlowExecutionSummary[]): FlowExecutionSummary[] => {
  const newest = runs.reduce<FlowExecutionSummary | null>((found, run) => found === null || run.startedAt > found.startedAt ? run : found, null)
  return runs.filter(run => run === newest || run.state === 'running' || run.state === 'stalled')
}

const approvalKey = (notification: WireNotification): string | null => {
  if (notification.method !== 'event') return null
  const event = notification.params.event
  if (event.type === 'approval/requested') return JSON.stringify([notification.params.runtime, event.approval.sessionId, event.approval.id])
  if (event.type === 'approval/resolved') return JSON.stringify([notification.params.runtime, event.sessionId, event.approvalId])
  return null
}

const inScope = (notification: WireNotification, views: readonly GoalView[], scope: Subscription['scope']): boolean => {
  switch (notification.method) {
    case 'flow/execution-changed': return views.some(v => v.goal.id === notification.params.execution.goal) &&
      (scope?.run === undefined || notification.params.execution.id === scope.run)
    case 'team/changed': return views.some(v => v.board.id === notification.params.state.id)
    case 'goal/changed': return views.some(v => v.goal.id === notification.params.view.goal.id)
    case 'goal/activity': case 'seat/activity': case 'finding/changed': return views.some(v => v.goal.id === notification.params.goal)
    case 'event': {
      const event = notification.params.event
      const session = event.type === 'approval/requested' ? event.approval.sessionId : event.type === 'approval/resolved' ? event.sessionId : null
      return session !== null && views.some(v => v.members.some(s => s.session.runtime === notification.params.runtime && s.session.sessionId === session))
    }
    case 'person/notice': return (!scope?.team && !scope?.run && !scope?.project) || views.some(v => v.members.some(s => s.session.runtime === notification.params.notice.from.runtime && s.session.sessionId === notification.params.notice.from.sessionId))
    default: return false
  }
}

/** A separate listener over the same envelopes and an explicitly tiered client surface. */
export const openClientDoor = async (options: ClientDoorOptions, filesystem: ClientDoorFilesystem = fs): Promise<ClientDoor | null> => {
  const logger = options.logger.child('client')
  const policy = options.policy === undefined ? undefined : Object.freeze({
    identity: options.policy.identity,
    preview: options.policy.preview,
    maximumTiers: Object.freeze([...options.policy.maximumTiers]),
    authorize: options.policy.authorize,
  })
  const allowed = async (request: ClientConnectionRequest): Promise<boolean> => {
    if (!policy) return true
    try { return await policy.authorize(request) === null } catch { return false }
  }
  const filterAllowed = async <T>(items: readonly T[], request: (item: T) => ClientConnectionRequest): Promise<readonly T[]> => {
    if (!policy) return items
    const admitted = await Promise.all(items.map(item => allowed(request(item))))
    return items.filter((_item, index) => admitted[index])
  }
  const goalRequest = (view: GoalView): ClientConnectionRequest => ({ id: 0, method: 'goal/read', params: { goal: view.goal.id } })
  const runRequest = (run: Pick<FlowExecutionSummary, 'id'>): ClientConnectionRequest => ({ id: 0, method: 'flow/execution', params: { run: run.id } })
  const connectionViews = async (scope: Subscription['scope']) => filterAllowed(await viewsInScope(options.host, scope), goalRequest)
  const notificationAllowed = async (notification: WireNotification, selection: Subscription): Promise<boolean> => {
    if (!policy) return true
    // Scope and item authority are live host facts, including for a baseline
    // collected before ownership changed. A remembered approval is no exemption.
    if (!await allowed({ id: 0, method: 'client/subscribe', params: selection })) return false
    if (!inScope(notification, await connectionViews(selection.scope), selection.scope)) return false
    return notification.method !== 'flow/execution-changed' || await allowed(runRequest(notification.params.execution))
  }
  const effectiveTiers = () => options.host.clientTiers().filter(tier => policy === undefined || policy.maximumTiers.includes(tier))
  const publishDiscovery = options.discovery !== false
  if (process.platform === 'win32') {
    logger.info('client door is not available on this platform')
    return null
  }
  const directory = options.directory ?? process.env['HARNESSDESK_CLIENT_DIR'] ?? `/tmp/harnessdesk-${process.getuid!()}`
  let paths: ReturnType<typeof clientDoorPaths>
  let home: string
  try {
    home = await filesystem.realpath(options.home)
    paths = clientDoorPaths(home, directory)
    try { await filesystem.mkdir(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await filesystem.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) {
      throw new Error('The client directory must be owned by this user, mode 0700, and a directory without a link.')
    }
    let existing
    try { existing = await filesystem.lstat(paths.socketPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (existing) {
      if (!existing.isSocket()) throw new Error('The client socket path is occupied by another file.')
      if (await alive(paths.socketPath)) throw new Error('Another desk with this home is already listening.')
      await filesystem.unlink(paths.socketPath)
    }
  } catch (error) {
    logger.warn('client door was not opened', { reason: String(error) })
    return null
  }

  const http = createServer((_request, response) => response.writeHead(404).end())
  const sockets = new WebSocketServer({ noServer: true })
  const startedAt = Date.now()
  const greeted = new Set<WebSocket>()
  let closed: Promise<void> | null = null
  const closeListener = () => closed ??= (async () => {
    for (const ws of greeted) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ method: 'host/shutdown', params: { reason: 'desk-closed' } }))
    }
    for (const ws of sockets.clients) {
      ws.close(1001, 'desk-closed')
      const timer = setTimeout(() => ws.terminate(), 1000)
      timer.unref()
      ws.once('close', () => clearTimeout(timer))
    }
    await new Promise<void>(resolve => sockets.close(() => resolve()))
    await new Promise<void>(resolve => http.close(() => resolve()))
  })()
  http.on('upgrade', (request, socket, head) => {
    if (request.url !== '/client' || closed !== null) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, ws => {
      sockets.emit('connection', ws, request)
      let hello = false
      let identity = policy?.identity ?? 'unknown'
      let statedPid: number | null = null
      let subscription: Subscription = { topics: [] }
      let proposal: { snapshots: WireNotification[] } | null = null
      const pendingSnapshots = new Set<WireNotification>()
      const consumedSnapshots = new Set<WireNotification>()
      let queue = Promise.resolve()
      const shownApprovals = new Set<string>()
      const send = (message: HostToClient) => {
        if (ws.readyState !== ws.OPEN) return
        if ('method' in message && message.method === 'event') {
          const key = approvalKey(message)
          if (key && message.params.event.type === 'approval/requested') shownApprovals.add(key)
          if (key && message.params.event.type === 'approval/resolved') shownApprovals.delete(key)
        }
        ws.send(JSON.stringify(message))
      }
      const audit = (entry: Parameters<Host['recordClientAudit']>[0]) => options.host.recordClientAudit(entry)
      const topics = (selection = subscription) => new Set<ClientTopic>(selection.topics.includes('waiting') ? [...selection.topics, 'runs', 'cards'] : selection.topics)
      const enqueue = (work: () => Promise<void>) => {
        queue = queue.then(work).catch(error => logger.warn('client notification failed', { error: String(error) }))
      }
      const detach = options.host.addBroadcaster(notification => {
        // Decide selection in queue order, after any preceding subscription.
        if (!hello || topicsOf(notification).length === 0) return
        if (snapshotKey(notification) !== null) {
          pendingSnapshots.add(notification)
          proposal?.snapshots.push(notification)
        }
        enqueue(async () => {
          pendingSnapshots.delete(notification)
          if (consumedSnapshots.delete(notification)) return
          if (!hello || !topicsOf(notification).some(t => topics().has(t))) return
          if (policy) {
            if (await notificationAllowed(notification, subscription)) send(notification)
            return
          }
          const resolved = notification.method === 'event' && notification.params.event.type === 'approval/resolved'
          const key = approvalKey(notification)
          if ((resolved && key !== null && shownApprovals.has(key)) ||
              inScope(notification, await viewsInScope(options.host, subscription.scope), subscription.scope)) send(notification)
        })
      })
      ws.on('message', raw => enqueue(async () => {
        let value: unknown
        let envelope: ReturnType<typeof parseClientEnvelope>
        let tier: ClientTier | null = null
        const refuse = (id: number | null, method: string | undefined, code: string, message: string, data?: unknown) => {
          audit({ kind: 'client/refused', client: identity, statedPid, method, outcome: 'refused', code,
            ...(tier !== null ? { tier } : {}) })
          if (id !== null) send({ id, ok: false, error: wireError(code, message, null, data) })
        }
        try { value = JSON.parse(raw.toString()); envelope = parseClientEnvelope(value) }
        catch (error) {
          const id = typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number' ? value.id : null
          refuse(id, undefined, 'badRequest', String(error)); return
        }
        const { id, method } = envelope
        const params = typeof value === 'object' && value !== null && 'params' in value ? value.params : undefined
        tier = clientTierFor(method, params)
        const refused = clientRefusal(method, hello, effectiveTiers(), params)
        if (refused) { refuse(id, method, refused, `Client request refused: ${refused}.`); return }
        let parsed
        try { parsed = parseClientMessage(value) }
        catch (error) { refuse(id, method, 'badRequest', String(error)); return }
        if (policy) {
          let denied: string | null
          try { denied = await policy.authorize(parsed as ClientConnectionRequest) }
          catch { denied = 'connectionPolicy' }
          if (denied !== null) { refuse(id, method, denied, `Client request refused: ${denied}.`); return }
          // Authorization can await host facts; a live desk revocation still wins.
          const revoked = clientRefusal(method, hello, effectiveTiers(), params)
          if (revoked) { refuse(id, method, revoked, `Client request refused: ${revoked}.`); return }
        }
        if (parsed.method === 'client/hello') {
          const params = parsed.params as HostParams<'client/hello'>
          if (params.protocol !== CLIENT_PROTOCOL) {
            refuse(id, method, 'incompatible', 'The client and desk speak different protocol versions.', { clientProtocol: params.protocol, hostProtocol: CLIENT_PROTOCOL })
            ws.close(1002, 'incompatible'); return
          }
          try {
            const info = await options.host.call('host/hello', { clientVersion: params.client.version })
            const runtimes = await Promise.all(info.runtimes.map(async runtime => ({
              id: runtime.id, name: runtime.presentation.name, metered: runtime.capabilities.metered,
              health: await options.host.call('runtime/health', { runtime: runtime.id }),
            })))
            identity = policy?.identity ?? `${params.client.name}@${params.client.version}`
            statedPid = policy ? null : params.pid ?? null
            hello = true
            greeted.add(ws)
            send({ id, ok: true, result: { protocolVersion: CLIENT_PROTOCOL, hostVersion: options.hostVersion,
              desk: { home, pid: process.pid, startedAt }, tiers: effectiveTiers(),
              methods: Object.keys(CLIENT_METHODS), runtimes } })
            audit({ kind: 'client/connected', client: identity, statedPid, method, tier: 'read', outcome: 'ok' })
          } catch (error) {
            const code = wireCodeOf(error) ?? 'methodFailed'
            send({ id, ok: false, error: wireError(code, String(error), null, wireDataOf(error)) })
            audit({ kind: 'client/call', client: identity, statedPid, method, tier: tier!, outcome: 'failed', code })
          }
          return
        }
        try {
          if (parsed.method === 'client/subscribe') {
            const next = parsed.params as Subscription
            const collecting = proposal = { snapshots: [...pendingSnapshots] }
            const selectedTopics = topics(next)
            const viewsReadAt = collecting.snapshots.length
            const views = await connectionViews(next.scope)
            // A Team's newest Run stays part of that Team's state after it ends, as the window shows it,
            // so a Team scope also starts from that Run; otherwise only active Runs (or the named one) are read.
            const availableRuns = next.scope?.run ? await options.host.call('flow/executions', { active: false })
              : next.scope?.team ? activeAndNewest(await options.host.call('flow/executions', { team: next.scope.team, active: false }))
              : await options.host.call('flow/executions', { active: true })
            const runs = await filterAllowed(availableRuns, runRequest)
            const baseline = new Map<string, WireNotification>()
            const readAt = new Map<string, number>()
            const remember = (notification: WireNotification, sampledAt = viewsReadAt) => {
              const key = snapshotKey(notification)!
              baseline.set(key, notification)
              readAt.set(key, sampledAt)
            }
            if (selectedTopics.has('runs')) for (const run of runs) {
              const sampledAt = collecting.snapshots.length
              const execution = await options.host.call('flow/execution', { run: run.id })
              const notification: WireNotification = { method: 'flow/execution-changed', params: { execution } }
              if (inScope(notification, views, next.scope)) remember(notification, sampledAt)
            }
            if (selectedTopics.has('cards')) for (const view of views) remember({ method: 'team/changed', params: { state: view.board } })
            if (selectedTopics.has('teams')) for (const view of views) remember({ method: 'goal/changed', params: { view } })
            if (selectedTopics.has('seats')) {
              const sampledAt = collecting.snapshots.length
              for (const activity of options.host.seatActivities()) {
                const notification: WireNotification = { method: 'seat/activity', params: activity }
                if (inScope(notification, views, next.scope)) remember(notification, sampledAt)
              }
            }
            // Queued state changes and changes during collection belong to this baseline.
            // Keep event notifications queued, and leave a refused proposal untouched.
            const consumed = new Set<WireNotification>()
            for (const [index, notification] of collecting.snapshots.entries()) {
              if (!topicsOf(notification).some(t => selectedTopics.has(t)) || !inScope(notification, views, next.scope)) continue
              const key = snapshotKey(notification)!
              if (index >= (readAt.get(key) ?? 0)) baseline.set(key, overlaySnapshot(baseline.get(key), notification))
              consumed.add(notification)
            }
            // Goal views carry the board too; keep both baseline forms consistent.
            for (const [key, notification] of baseline) {
              if (notification.method !== 'goal/changed') continue
              const board = baseline.get(`board:${notification.params.view.board.id}`)
              if (board?.method === 'team/changed') baseline.set(key, { method: 'goal/changed',
                params: { view: { ...notification.params.view, board: board.params.state } } })
            }
            const approvals: WireNotification[] = []
            if (selectedTopics.has('waiting')) for (const notification of options.host.pendingApprovalEvents()) {
              if (inScope(notification, views, next.scope)) approvals.push(notification)
            }
            if (policy) {
              for (const [key, notification] of baseline) {
                if (!await notificationAllowed(notification, next)) baseline.delete(key)
              }
              for (let index = approvals.length - 1; index >= 0; index--) {
                if (!await notificationAllowed(approvals[index]!, next)) approvals.splice(index, 1)
              }
            }
            for (const notification of consumed) consumedSnapshots.add(notification)
            subscription = next
            shownApprovals.clear()
            // ACK and the counted baseline remain contiguous in this queue step.
            // Live notifications run afterward; they cannot interleave these frames.
            send({ id, ok: true, result: { baseline: baseline.size + approvals.length } })
            for (const notification of baseline.values()) send(notification)
            for (const notification of approvals) send(notification)
          } else {
            const result = parsed.method === 'goal/list'
              ? await filterAllowed(await options.host.call('goal/list', parsed.params as HostParams<'goal/list'>), goalRequest)
              : parsed.method === 'flow/executions'
              ? await filterAllowed(await options.host.call('flow/executions', parsed.params as HostParams<'flow/executions'>), runRequest)
              : parsed.method === 'team/intent'
              ? await options.host.clientIntent(parsed.params as HostParams<'team/intent'>, identity)
              : parsed.method === 'flow/preview' && policy?.preview
              ? await policy.preview(parsed.params as HostParams<'flow/preview'>)
              : await options.host.call(parsed.method, parsed.params as never)
            send({ id, ok: true, result })
          }
          audit({ kind: 'client/call', client: identity, statedPid, method, tier: tier!, outcome: 'ok' })
        } catch (error) {
          const code = wireCodeOf(error) ?? 'methodFailed'
          send({ id, ok: false, error: wireError(code, error instanceof Error ? error.message : String(error),
            typeof (error as { details?: unknown })?.details === 'string' ? (error as { details: string }).details : null, wireDataOf(error)) })
          audit({ kind: 'client/call', client: identity, statedPid, method, tier: tier!, outcome: 'failed', code })
        } finally {
          proposal = null
        }
      }))
      ws.on('close', () => {
        detach(); greeted.delete(ws)
        audit({ kind: 'client/closed', client: identity, statedPid })
      })
      ws.on('error', error => logger.warn('client socket error', { error: String(error) }))
    })
  })
  const temporaryPointer = `${paths.pointerPath}.${randomUUID()}.tmp`
  let writingPointer = false
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(paths.socketPath, resolve) })
    await filesystem.chmod(paths.socketPath, 0o600)
    if (publishDiscovery) {
      writingPointer = true
      await filesystem.writeFile(temporaryPointer, JSON.stringify({ home, pid: process.pid, hostVersion: options.hostVersion, protocolVersion: CLIENT_PROTOCOL, startedAt }), { mode: 0o600, flag: 'wx' })
      await filesystem.rename(temporaryPointer, paths.pointerPath)
    }
  } catch (error) {
    await closeListener()
    try { if (writingPointer && (error as NodeJS.ErrnoException).code !== 'EEXIST') await filesystem.rm(temporaryPointer, { force: true }) }
    catch (cleanupError) { logger.warn('client temporary pointer could not be removed', { reason: String(cleanupError) }) }
    logger.warn('client door was not opened', { reason: String(error) })
    return null
  }
  let cleanup: Promise<void> | null = null
  return {
    socketPath: paths.socketPath,
    descriptor: Object.freeze({ home, pid: process.pid, startedAt, hostVersion: options.hostVersion,
      protocolVersion: CLIENT_PROTOCOL, socketPath: paths.socketPath }),
    close: () => cleanup ??= (async () => {
      await closeListener()
      if (!publishDiscovery) {
        await filesystem.rm(paths.socketPath, { force: true })
        return
      }
      try {
        const pointer = JSON.parse(await filesystem.readFile(paths.pointerPath, 'utf8')) as { pid: number }
        if (pointer.pid === process.pid) {
          await filesystem.rm(paths.pointerPath, { force: true })
          await filesystem.rm(paths.socketPath, { force: true })
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('client pointer could not be removed', { reason: String(error) }) }
    })(),
  }
}
