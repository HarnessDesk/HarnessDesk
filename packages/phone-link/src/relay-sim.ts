import { createServer, type Server } from 'node:http'
import { CloseCode, HEARTBEAT_PING, HEARTBEAT_PONG, RelayHeaders, decodeDeskFrame, encodeDeskFrame } from '@harnessdesk/contract'
import { idFromPub } from '@harnessdesk/crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { PhoneSim } from './sim.js'

/** The challenge this room hands out. A real relay signs a fresh one each time. */
export const CHALLENGE = 'c'.repeat(43)

/**
 * A relay room in miniature for tests and local checks, after the service's own rules: the newest desk socket wins, a phone with no desk is
 * told so, frames cross with the connection number on the desk side only, and `ping` is answered by the relay.
 */
export class RelaySim {
  /** Desk tokens the room lets in. */
  readonly tokens = new Set(['desk-token'])
  readonly tickets = new Map<string, string>()
  readonly desks: { token: string; proof: string }[] = []
  /** What the desk told the room to do with a phone. */
  readonly closes: { conn: number; code: number }[] = []
  answerPings = true
  maxPhones = 8
  maxFrame = 1_048_576
  /** Ends each desk socket right after `ready`, as a relay that keeps failing just past admission would. */
  dropAfterReady = false
  /** Admits each desk socket and answers its pings but never says `ready`, as a room stuck half way would. */
  withholdReady = false
  down = false
  #desk: WebSocket | null = null
  #phones = new Map<number, WebSocket>()
  #next = 1
  readonly #server: Server
  readonly #wss = new WebSocketServer({ noServer: true })

  private constructor(server: Server, readonly url: string, readonly deskId: string) { this.#server = server }

  static async start(deskId: string): Promise<RelaySim> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('no port')
    const relay = new RelaySim(server, `ws://127.0.0.1:${address.port}`, deskId)
    server.on('request', (request, response) => {
      if (relay.down) return void response.writeHead(503).end()
      if (request.url === '/v1/challenge') return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: CHALLENGE, expiresAt: 0 }))
      response.writeHead(404).end()
    })
    server.on('upgrade', (request, socket, head) => {
      const refuse = (status: number) => { socket.end(`HTTP/1.1 ${status} No\r\nconnection: close\r\n\r\n`) }
      if (relay.down) return refuse(503)
      const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '')
      if (request.url === `/v1/desk/${relay.deskId}`) {
        if (!relay.tokens.has(bearer) || request.headers[RelayHeaders.challenge] !== CHALLENGE) return refuse(401)
        relay.desks.push({ token: bearer, proof: String(request.headers[RelayHeaders.proof]) })
        return relay.#wss.handleUpgrade(request, socket, head, ws => relay.#deskJoined(ws))
      }
      if (request.url === `/v1/phone/${relay.deskId}`) {
        const dev = relay.tickets.get(bearer)
        if (!dev) return refuse(401)
        return relay.#wss.handleUpgrade(request, socket, head, ws => relay.#phoneJoined(ws, dev))
      }
      refuse(404)
    })
    return relay
  }

  get desk(): WebSocket | null { return this.#desk }

  /** Stops reading the current desk socket, so its close is never answered: a network that went quiet mid-close. */
  holdDesk(): void { (this.#desk as unknown as { _socket: { pause(): void } } | null)?._socket.pause() }

  #deskJoined(ws: WebSocket): void {
    const previous = this.#desk
    this.#desk = ws
    if (previous) {
      previous.close(CloseCode.REPLACED, 'replaced')
      for (const phone of this.#phones.values()) phone.close(CloseCode.PEER_DROPPED, 'desk replaced')
      this.#phones.clear()
    }
    if (!this.withholdReady) ws.send(JSON.stringify({ t: 'ready', maxPhones: this.maxPhones, maxFrame: this.maxFrame }))
    if (this.dropAfterReady) setTimeout(() => ws.close(CloseCode.UNAVAILABLE, 'unavailable'), 5)
    ws.on('message', (data, isBinary) => {
      const bytes = data as Buffer
      if (!isBinary) {
        const text = bytes.toString('utf8')
        if (text === HEARTBEAT_PING) return void (this.answerPings && ws.send(HEARTBEAT_PONG))
        const message = JSON.parse(text) as { t: string; conn: number; code: number; reason?: string }
        if (message.t === 'close') {
          this.closes.push({ conn: message.conn, code: message.code })
          this.#phones.get(message.conn)?.close(message.code, message.reason)
        }
        return
      }
      const frame = decodeDeskFrame(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) as Uint8Array<ArrayBuffer>)
      if (frame) this.#phones.get(frame.conn)?.send(frame.payload)
    })
    ws.on('close', () => {
      if (this.#desk !== ws) return
      this.#desk = null
      for (const phone of this.#phones.values()) phone.close(CloseCode.PEER_DROPPED, 'desk went away')
      this.#phones.clear()
    })
  }

  #phoneJoined(ws: WebSocket, dev: string): void {
    const desk = this.#desk
    if (!desk) return void ws.close(CloseCode.DESK_OFFLINE, 'desk offline')
    const conn = this.#next++
    this.#phones.set(conn, ws)
    desk.send(JSON.stringify({ t: 'open', conn, dev }))
    ws.on('message', data => {
      const bytes = data as Buffer
      desk.send(encodeDeskFrame(conn, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)))
    })
    ws.on('close', code => {
      if (this.#phones.get(conn) !== ws) return
      this.#phones.delete(conn)
      if (desk.readyState === desk.OPEN) desk.send(JSON.stringify({ t: 'gone', conn, code }))
    })
  }

  /** The ticket the account would hand this phone after redeeming an invite. */
  async ticketFor(phone: PhoneSim): Promise<string> {
    const ticket = `ticket-${this.tickets.size}`
    this.tickets.set(ticket, await idFromPub(phone.key.pub))
    return ticket
  }

  async close(): Promise<void> {
    for (const client of this.#wss.clients) client.terminate()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}
