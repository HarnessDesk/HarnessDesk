import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentEvent, HostMethodName, HostToClient } from '@harnessdesk/protocol'
import WebSocket from 'ws'

import { Host, Logger, StateStore, serve, type HostOptions, type RunningServer } from '../../src/index.js'
import { FakeRuntime } from './fake-runtime.js'

/**
 * A host on a real socket, in front of a fake runtime.
 *
 * Shared by every end-to-end suite so they exercise the same path a renderer
 * does — validation, dispatch, broadcast — rather than calling `host.call`
 * directly and missing the wire.
 */

export const silent = new Logger('test', { level: 'error', console: false })

export interface Harness {
  readonly host: Host
  readonly runtime: FakeRuntime
  readonly server: RunningServer
  readonly stateDir: string
}

export const start = async (options: Partial<HostOptions> = {}): Promise<Harness> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-test-'))
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
    pickDirectory: async () => stateDir,
    ...options,
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  return { host, runtime, server, stateDir }
}

export const stop = async (harness: Harness): Promise<void> => {
  await harness.server.close()
  // `dispose()` is what makes the next line safe: it waits out every writer
  // the host owns, so nothing is still putting files into the state directory
  // by the time it is removed.
  await harness.host.dispose()
  /*
    And the retries are the belt to that brace. `fs.rm` empties a directory and
    then removes it, which on a loaded runner are two IO round trips with a
    real gap between them — so any writer that outlives its shutdown drops a
    file into that gap and `rmdir` fails with ENOTEMPTY. That is a bug in the
    writer and is fixed as one; what a teardown owes the run is that finding
    the next such writer looks like a test failure, not like a hook failure in
    whichever test happened to be last.
  */
  await rm(harness.stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

/** A typed client over the wire protocol, mirroring what the renderer uses. */
export class Client {
  #socket: WebSocket
  #nextId = 0
  #pending = new Map<number, (message: HostToClient) => void>()
  readonly events: AgentEvent[] = []
  readonly notifications: HostToClient[] = []

  private constructor(socket: WebSocket) {
    this.#socket = socket
    // Listeners must be attached before the socket opens: the host sends `sync`
    // and replays pending approvals the moment it accepts the upgrade, and `ws`
    // drops messages that arrive with no listener registered.
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as HostToClient
      this.notifications.push(message)
      if ('method' in message) {
        if (message.method === 'event') this.events.push(message.params.event)
        return
      }
      this.#pending.get(message.id)?.(message)
      this.#pending.delete(message.id)
    })
  }

  static async connect(server: RunningServer, token = server.token): Promise<Client> {
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?token=${token}`)
    const client = new Client(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return client
  }

  call(method: HostMethodName, params: unknown): Promise<unknown> {
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (message) => {
        if ('ok' in message && message.ok) resolve(message.result)
        // The code travels with the sentence, as it does in the renderer's
        // transport: a failure the interface is meant to *act* on is told
        // apart by its code, never by reading its English.
        else if ('ok' in message) {
          reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
        }
      })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Sends a frame verbatim, for testing what the host rejects. */
  raw(payload: string): void {
    this.#socket.send(payload)
  }

  async until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  close(): void {
    this.#socket.close()
  }
}
