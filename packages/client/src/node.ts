import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { connect as connectSocket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import type { HostToClient } from '@harnessdesk/protocol'
import { WireCallError, type ClientTransport } from './index.js'

export interface DeskPointer {
  readonly home: string
  readonly pid: number
  readonly startedAt: number
  readonly hostVersion: string
  readonly protocolVersion: number
  readonly socketPath: string
}
type Environment = Readonly<Record<string, string | undefined>>
/** Match the host's project identity: realpath when present, absolute path otherwise. */
export async function canonicalProject(project: string): Promise<string> {
  try { return await fs.realpath(project) }
  catch { return resolve(project) }
}
const uid = () => {
  if (!process.getuid) throw new WireCallError('noDesk', 'The local client door is not available on this platform.')
  return process.getuid()
}
const directoryOf = (env: Environment) => env['HARNESSDESK_CLIENT_DIR'] ?? `/tmp/harnessdesk-${uid()}`
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const directorySafe = async (directory: string) => {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o7777) !== 0o700) {
    throw new WireCallError('unsafeDirectory', 'The client directory must belong to this user, be mode 0700, and not be a link.')
  }
}
const fileSafe = async (path: string, kind: 'socket' | 'pointer') => {
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o7777) !== 0o600 ||
      !(kind === 'socket' ? stat.isSocket() : stat.isFile())) {
    throw new WireCallError(kind === 'socket' ? 'unsafeSocket' : 'unsafePointer', `The client ${kind} must belong to this user, be mode 0600, and not be a link.`)
  }
}
const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true }
  catch (error) { if (codeOf(error) === 'ESRCH') return false; throw error }
}
const socketAlive = (path: string): Promise<boolean> => new Promise((resolve, reject) => {
  const socket = connectSocket(path)
  const done = (alive: boolean) => { socket.destroy(); resolve(alive) }
  socket.once('connect', () => done(true))
  socket.once('error', error => {
    socket.destroy()
    if (['ECONNREFUSED', 'ENOENT'].includes(codeOf(error) ?? '')) resolve(false)
    else reject(error)
  })
  socket.setTimeout(500, () => done(false))
})
const pointerOf = (value: unknown, socketPath: string): DeskPointer | null => {
  if (!value || typeof value !== 'object') return null
  const p = value as Record<string, unknown>
  if (typeof p['home'] !== 'string' || typeof p['pid'] !== 'number' || !Number.isSafeInteger(p['pid']) || p['pid'] <= 0 ||
      typeof p['startedAt'] !== 'number' || !Number.isFinite(p['startedAt']) || typeof p['hostVersion'] !== 'string' ||
      typeof p['protocolVersion'] !== 'number' || !Number.isSafeInteger(p['protocolVersion'])) return null
  return { home: p['home'], pid: p['pid'], startedAt: p['startedAt'], hostVersion: p['hostVersion'], protocolVersion: p['protocolVersion'], socketPath }
}
const socketFor = (home: string, directory: string) => join(directory, `${createHash('sha256').update(home).digest('hex').slice(0, 16)}.sock`)

/** Read-only discovery: stale, malformed and unsafe pointers are excluded, never removed. */
export async function findDesks(options: { env?: Environment } = {}): Promise<readonly DeskPointer[]> {
  const directory = directoryOf(options.env ?? process.env)
  try { await directorySafe(directory) }
  catch (error) { if (codeOf(error) === 'ENOENT') return []; throw error }
  const desks: DeskPointer[] = []
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!/^[a-f0-9]{16}\.json$/.test(name)) continue
    try {
      const path = join(directory, name), socketPath = join(directory, name.replace(/\.json$/, '.sock'))
      await fileSafe(path, 'pointer')
      const desk = pointerOf(JSON.parse(await fs.readFile(path, 'utf8')), socketPath)
      if (!desk || socketFor(desk.home, directory) !== socketPath || !processAlive(desk.pid)) continue
      await fileSafe(socketPath, 'socket')
      if (await socketAlive(socketPath)) desks.push(desk)
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof WireCallError || ['ENOENT', 'ESRCH', 'ECONNREFUSED'].includes(codeOf(error) ?? '')) continue
      throw error
    }
  }
  return desks
}

/**
 * Explicit home, then HARNESSDESK_HOME, then ~/.harnessdesk; no fallback to another desk.
 * noDesk is an absence; unsafeDirectory/unsafeSocket/unsafePointer are permission refusals.
 */
export async function resolveDesk(options: { home?: string; env?: Environment } = {}): Promise<DeskPointer> {
  const env = options.env ?? process.env
  const directory = directoryOf(env)
  const requested = options.home ?? env['HARNESSDESK_HOME'] ?? join(homedir(), '.harnessdesk')
  const noDesk = async (): Promise<never> => {
    const found = await findDesks({ env })
    throw new WireCallError('noDesk', `No running desk for ${requested}. Desks found: ${found.length ? found.map(desk => desk.home).join(', ') : 'none'}.`)
  }
  try {
    await directorySafe(directory)
    const home = await fs.realpath(requested)
    const socketPath = socketFor(home, directory)
    const pointerPath = socketPath.replace(/\.sock$/, '.json')
    await fileSafe(pointerPath, 'pointer')
    await fileSafe(socketPath, 'socket')
    const desk = pointerOf(JSON.parse(await fs.readFile(pointerPath, 'utf8')), socketPath)
    if (!desk || desk.home !== home || !processAlive(desk.pid) || !await socketAlive(socketPath)) return noDesk()
    return desk
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ESRCH', 'ECONNREFUSED'].includes(codeOf(error) ?? '')) return noDesk()
    throw error
  }
}

/** WebSocket over the private unix socket. Rechecks the boundary on every connection. */
export async function localTransport(desk: DeskPointer): Promise<ClientTransport> {
  try {
    await directorySafe(dirname(desk.socketPath))
    await fileSafe(desk.socketPath, 'socket')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') throw new WireCallError('noDesk', 'The desk socket is no longer present.')
    throw error
  }
  const ws = new WebSocket(`ws+unix://${desk.socketPath}:/client`, { handshakeTimeout: 5000 })
  await new Promise<void>((resolve, reject) => {
    const opened = () => { ws.off('error', failed); resolve() }
    const failed = (error: Error) => { ws.off('open', opened); reject(new WireCallError('noDesk', `The desk socket could not be opened: ${error.message}`)) }
    ws.once('open', opened); ws.once('error', failed)
  })
  const messages = new Set<(message: HostToClient) => void>(), closes = new Set<() => void>()
  ws.on('message', raw => {
    let message: HostToClient
    try { message = JSON.parse(raw.toString()) as HostToClient }
    catch { ws.close(1002, 'invalid message'); return }
    // A malformed peer cannot crash callbacks or leave a pending call alive.
    if (!message || typeof message !== 'object' ||
      !('method' in message ? typeof message.method === 'string' && typeof message.params === 'object' :
        typeof message.id === 'number' && typeof message.ok === 'boolean' && (message.ok || typeof message.error?.code === 'string'))) {
      ws.close(1002, 'invalid message'); return
    }
    for (const listener of messages) listener(message)
  })
  ws.on('close', () => { for (const listener of closes) listener() })
  ws.on('error', () => { ws.terminate() })
  return {
    send: message => {
      if (ws.readyState !== WebSocket.OPEN) throw new WireCallError('disconnected', 'The desk connection is closed.')
      ws.send(JSON.stringify(message))
    },
    onMessage: listener => { messages.add(listener); return () => { messages.delete(listener) } },
    onClose: listener => {
      closes.add(listener)
      if (ws.readyState === WebSocket.CLOSED) queueMicrotask(() => { if (closes.has(listener)) listener() })
      return () => { closes.delete(listener) }
    },
    close: () => { ws.close() },
  }
}
