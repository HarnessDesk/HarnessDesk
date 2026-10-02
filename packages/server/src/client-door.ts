import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { join } from 'node:path'
import {
  CLIENT_METHODS, CLIENT_PROTOCOL, CLIENT_TIERS_GRANTED_BY_DEFAULT, parseClientEnvelope, parseClientMessage,
  wireCodeOf, wireDataOf, wireError,
  type ClientMethodName, type ClientTier, type ClientTopic, type GoalView, type HostParams,
  type HostToClient, type WireNotification,
} from '@harnessdesk/protocol'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Host } from './host.js'
import type { Logger } from './log.js'
import { sameCanonicalPath } from './path-identity.js'

export interface ClientDoorOptions {
  readonly host: Host
  readonly logger: Logger
  readonly home: string
  readonly directory?: string
  readonly hostVersion: string
}
export interface ClientDoor {
  readonly socketPath: string
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
    case 'event': return notification.params.event.type === 'approval/requested' || notification.params.event.type === 'approval/resolved' ? ['waiting'] : []
    default: return []
  }
}

export const clientRefusal = (method: string, hello: boolean, tiers: readonly ClientTier[]): string | null => {
  if (!Object.hasOwn(CLIENT_METHODS, method)) return 'notOnClientSurface'
  if (!hello && method !== 'client/hello') return 'helloFirst'
  if (!tiers.includes(CLIENT_METHODS[method as ClientMethodName])) return 'tierNotGranted'
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

export type ClientDoorFilesystem = Pick<typeof fs, 'realpath' | 'mkdir' | 'chmod' | 'unlink' | 'writeFile' | 'readFile' | 'rm'> & {
  lstat(path: string): Promise<Pick<Stats, 'uid' | 'mode' | 'isDirectory' | 'isSymbolicLink' | 'isSocket'>>
}

type Subscription = HostParams<'client/subscribe'>

const viewsInScope = async (host: Host, scope: Subscription['scope']): Promise<readonly GoalView[]> => {
  const views = await host.call('goal/list', {})
  const runGoal = scope?.run ? (await host.call('flow/execution', { run: scope.run })).goal : null
  return views.filter(view =>
    (scope?.team === undefined || view.goal.id === scope.team) &&
    (runGoal === null || view.goal.id === runGoal) &&
    (scope?.project === undefined || sameCanonicalPath(view.goal.root, scope.project)))
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
    case 'goal/activity': return views.some(v => v.goal.id === notification.params.goal)
    case 'event': {
      const event = notification.params.event
      const session = event.type === 'approval/requested' ? event.approval.sessionId : event.type === 'approval/resolved' ? event.sessionId : null
      return session !== null && views.some(v => v.members.some(s => s.session.runtime === notification.params.runtime && s.session.sessionId === session))
    }
    case 'person/notice': return (!scope?.team && !scope?.run && !scope?.project) || views.some(v => v.members.some(s => s.session.runtime === notification.params.notice.from.runtime && s.session.sessionId === notification.params.notice.from.sessionId))
    default: return false
  }
}

/** A separate listener over the same envelopes, granting reads only. */
export const openClientDoor = async (options: ClientDoorOptions, filesystem: ClientDoorFilesystem = fs): Promise<ClientDoor | null> => {
  const logger = options.logger.child('client')
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
  http.on('upgrade', (request, socket, head) => {
    if (request.url !== '/client' || closed !== null) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, ws => {
      sockets.emit('connection', ws, request)
      let hello = false
      let identity = 'unknown'
      let statedPid: number | null = null
      let subscription: Subscription = { topics: [] }
      let proposal: Subscription | null = null
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
        // Keep both selections' events until the baseline decides which one commits.
        if (!hello || !topicsOf(notification).some(t => topics().has(t) || (proposal !== null && topics(proposal).has(t)))) return
        enqueue(async () => {
          if (!hello || !topicsOf(notification).some(t => topics().has(t))) return
          const resolved = notification.method === 'event' && notification.params.event.type === 'approval/resolved'
          const key = approvalKey(notification)
          if ((resolved && key !== null && shownApprovals.has(key)) ||
              inScope(notification, await viewsInScope(options.host, subscription.scope), subscription.scope)) send(notification)
        })
      })
      ws.on('message', raw => enqueue(async () => {
        let value: unknown
        let envelope: ReturnType<typeof parseClientEnvelope>
        const refuse = (id: number | null, method: string | undefined, code: string, message: string, data?: unknown) => {
          audit({ kind: 'client/refused', client: identity, statedPid, method, outcome: 'refused', code,
            ...(method && Object.hasOwn(CLIENT_METHODS, method) ? { tier: CLIENT_METHODS[method as ClientMethodName] } : {}) })
          if (id !== null) send({ id, ok: false, error: wireError(code, message, null, data) })
        }
        try { value = JSON.parse(raw.toString()); envelope = parseClientEnvelope(value) }
        catch (error) {
          const id = typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number' ? value.id : null
          refuse(id, undefined, 'badRequest', String(error)); return
        }
        const { id, method } = envelope
        const refused = clientRefusal(method, hello, CLIENT_TIERS_GRANTED_BY_DEFAULT)
        if (refused) { refuse(id, method, refused, `Client request refused: ${refused}.`); return }
        let parsed
        try { parsed = parseClientMessage(value) }
        catch (error) { refuse(id, method, 'badRequest', String(error)); return }
        if (parsed.method === 'client/hello') {
          const params = parsed.params as HostParams<'client/hello'>
          if (params.protocol !== CLIENT_PROTOCOL) {
            refuse(id, method, 'incompatible', 'The client and desk speak different protocol versions.', { clientProtocol: params.protocol, hostProtocol: CLIENT_PROTOCOL })
            ws.close(1002, 'incompatible'); return
          }
          try {
            const info = await options.host.call('host/hello', { clientVersion: params.client.version })
            const runtimes = await Promise.all(info.runtimes.map(async runtime => ({
              id: runtime.id, name: runtime.presentation.name,
              health: await options.host.call('runtime/health', { runtime: runtime.id }),
            })))
            identity = `${params.client.name}@${params.client.version}`
            statedPid = params.pid ?? null
            hello = true
            greeted.add(ws)
            send({ id, ok: true, result: { protocolVersion: CLIENT_PROTOCOL, hostVersion: options.hostVersion,
              desk: { home, pid: process.pid, startedAt }, tiers: CLIENT_TIERS_GRANTED_BY_DEFAULT,
              methods: Object.keys(CLIENT_METHODS), runtimes } })
            audit({ kind: 'client/connected', client: identity, statedPid, method, tier: 'read', outcome: 'ok' })
          } catch (error) {
            const code = wireCodeOf(error) ?? 'methodFailed'
            send({ id, ok: false, error: wireError(code, String(error), null, wireDataOf(error)) })
            audit({ kind: 'client/call', client: identity, statedPid, method, tier: 'read', outcome: 'failed', code })
          }
          return
        }
        try {
          if (parsed.method === 'client/subscribe') {
            const next = parsed.params as Subscription
            proposal = next
            const selectedTopics = topics(next)
            const views = await viewsInScope(options.host, next.scope)
            const runs = await options.host.call('flow/executions', { active: next.scope?.run ? false : true })
            const baseline: WireNotification[] = []
            if (selectedTopics.has('runs')) for (const run of runs) {
              const execution = await options.host.call('flow/execution', { run: run.id })
              const notification: WireNotification = { method: 'flow/execution-changed', params: { execution } }
              if (inScope(notification, views, next.scope)) baseline.push(notification)
            }
            if (selectedTopics.has('cards')) for (const view of views) baseline.push({ method: 'team/changed', params: { state: view.board } })
            if (selectedTopics.has('teams')) for (const view of views) baseline.push({ method: 'goal/changed', params: { view } })
            if (selectedTopics.has('waiting')) for (const notification of options.host.pendingApprovalEvents()) {
              if (inScope(notification, views, next.scope)) baseline.push(notification)
            }
            subscription = next
            shownApprovals.clear()
            send({ id, ok: true, result: null })
            for (const notification of baseline) send(notification)
          } else {
            const result = await options.host.call(parsed.method, parsed.params as never)
            send({ id, ok: true, result })
          }
          audit({ kind: 'client/call', client: identity, statedPid, method, tier: 'read', outcome: 'ok' })
        } catch (error) {
          const code = wireCodeOf(error) ?? 'methodFailed'
          send({ id, ok: false, error: wireError(code, error instanceof Error ? error.message : String(error),
            typeof (error as { details?: unknown })?.details === 'string' ? (error as { details: string }).details : null, wireDataOf(error)) })
          audit({ kind: 'client/call', client: identity, statedPid, method, tier: 'read', outcome: 'failed', code })
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
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(paths.socketPath, resolve) })
    await filesystem.chmod(paths.socketPath, 0o600)
    await filesystem.writeFile(paths.pointerPath, JSON.stringify({ home, pid: process.pid, hostVersion: options.hostVersion, protocolVersion: CLIENT_PROTOCOL, startedAt }), { mode: 0o600, flag: 'w' })
    await filesystem.chmod(paths.pointerPath, 0o600)
  } catch (error) {
    http.close()
    logger.warn('client door was not opened', { reason: String(error) })
    return null
  }
  return {
    socketPath: paths.socketPath,
    close: () => closed ??= (async () => {
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
