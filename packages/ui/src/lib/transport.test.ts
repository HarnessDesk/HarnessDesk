import { describe, expect, it } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'

import { rejectionFor, sentenceOf } from './transport'

describe('sentenceOf', () => {
  it('adds the reason the agent gave, because the message alone says nothing', () => {
    expect(
      sentenceOf({
        code: 'methodFailed',
        message: 'Internal error',
        details: 'the query closed before it answered',
      }),
    ).toBe('Internal error — the query closed before it answered')
  })

  it('leaves a message that already explains itself alone', () => {
    const message = 'Fake ACP Agent cannot open this conversation: its folder no longer exists (/gone).'
    expect(sentenceOf({ code: 'methodFailed', message, details: null })).toBe(message)
    expect(sentenceOf({ code: 'methodFailed', message })).toBe(message)
  })

  it('does not say the same thing twice', () => {
    expect(sentenceOf({ code: 'methodFailed', message: 'Nope', details: 'Nope' })).toBe('Nope')
    expect(sentenceOf({ code: 'methodFailed', message: 'Nope', details: '   ' })).toBe('Nope')
  })

  it('handles non-string error details without crashing (#507)', () => {
    expect(
      sentenceOf({
        code: 'internal',
        message: 'bad',
        details: 42 as unknown as string,
      }),
    ).toBe('bad — 42')

    expect(
      sentenceOf({
        code: 'internal',
        message: 'bad',
        details: { object: true } as unknown as string,
      }),
    ).toBe('bad')
  })
})

describe('rejectionFor', () => {
  it('keeps what a failure carries for the interface beside its code and sentence', () => {
    const candidates = [{ label: 'Claude · Opus 5 · High', state: 'passed' }]
    const error = rejectionFor({ code: 'seatRefused', message: 'No seat could be opened for this Agent', data: { candidates } })
    expect((error as Error & { code?: string }).code).toBe('seatRefused')
    expect((error as Error & { data?: unknown }).data).toEqual({ candidates })
    // And a failure with nothing more to say carries nothing more.
    expect('data' in rejectionFor({ code: 'methodFailed', message: 'no' })).toBe(false)
  })
})

describe('Transport queue handling (#501)', () => {
  it('holds independent request owners through success, error, abort and disconnect', async () => {
    class MockWebSocket {
      static OPEN = 1
      static instance: MockWebSocket
      readyState = 0
      listeners = new Map<string, (event: any) => void>()
      sent: string[] = []
      failSend = false
      constructor(_url: string) { MockWebSocket.instance = this }
      addEventListener(type: string, cb: (event: any) => void) { this.listeners.set(type, cb) }
      send(frame: string) { if (this.failSend) throw new Error('Synthetic send failure'); this.sent.push(frame) }
      close() { this.readyState = 3 }
      open() { this.readyState = 1; this.listeners.get('open')?.({}) }
      message(value: unknown) { this.listeners.get('message')?.({ data: JSON.stringify(value) }) }
      disconnect() { this.readyState = 3; this.listeners.get('close')?.({}) }
    }
    const original = globalThis.WebSocket
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
    try {
      const { Transport } = await import('./transport')
      let owners = 0
      const transport = new Transport('ws://example.test', {
        onEvent: () => {}, onNotification: () => {}, onStatus: () => {},
        onRequest: (() => { owners++; let live = true; return () => { if (live) { live = false; owners-- } } }) as never,
      } as never)
      transport.connect(); const socket = MockWebSocket.instance; socket.open()
      const a = transport.request('session/read', { runtime: runtimeId('example'), sessionId: 'one' as never })
      const b = transport.request('session/read', { runtime: runtimeId('example'), sessionId: 'two' as never })
      expect(owners).toBe(2)
      const [first, second] = socket.sent.map(frame => JSON.parse(frame).id)
      socket.message({ id: first, ok: true, result: null }); await a
      expect(owners).toBe(1)
      socket.message({ id: second, ok: false, error: { code: 'methodFailed', message: 'Synthetic refusal' } })
      await expect(b).rejects.toThrow('Synthetic refusal'); expect(owners).toBe(0)
      const controller = new AbortController()
      const c = transport.request('session/read', { runtime: runtimeId('example'), sessionId: 'three' as never }, { signal: controller.signal })
      controller.abort(); await expect(c).rejects.toMatchObject({ name: 'AbortError' }); expect(owners).toBe(0)
      socket.failSend = true
      const failed = transport.request('session/read', { runtime: runtimeId('example'), sessionId: 'failed' as never })
      await expect(failed).rejects.toThrow('Synthetic send failure'); expect(owners).toBe(0)
      socket.failSend = false
      const circular: { self?: unknown } = {}; circular.self = circular
      expect(() => transport.request('session/read', circular as never)).toThrow(); expect(owners).toBe(0)
      const queuedTransport = new Transport('ws://example.test', {
        onEvent: () => {}, onNotification: () => {}, onStatus: () => {},
        onRequest: (() => { owners++; let live = true; return () => { if (live) { live = false; owners-- } } }) as never,
      } as never)
      queuedTransport.connect()
      const queuedSocket = MockWebSocket.instance
      const queued = queuedTransport.request('session/read', { runtime: runtimeId('example'), sessionId: 'queued' as never })
      queuedSocket.failSend = true; queuedSocket.open()
      await expect(queued).rejects.toThrow('Synthetic send failure'); expect(owners).toBe(0)
      queuedTransport.close()
      const d = transport.request('session/read', { runtime: runtimeId('example'), sessionId: 'four' as never })
      socket.disconnect(); await expect(d).rejects.toThrow('connection'); expect(owners).toBe(0)
      transport.close()
    } finally { globalThis.WebSocket = original }
  })
  it('delivers the transcript fence alongside its event', async () => {
    class MockWebSocket {
      static instance: MockWebSocket
      listeners = new Map<string, (event: { data: string }) => void>()
      constructor(_url: string) { MockWebSocket.instance = this }
      addEventListener(type: string, cb: (event: { data: string }) => void) { this.listeners.set(type, cb) }
      close() {}
      message(value: unknown) { this.listeners.get('message')?.({ data: JSON.stringify(value) }) }
    }
    const original = globalThis.WebSocket
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
    try {
      const { Transport } = await import('./transport')
      const received: unknown[][] = []
      const transport = new Transport('ws://example.test', {
        onEvent: ((...args: unknown[]) => received.push(args)) as never,
        onNotification: () => {}, onStatus: () => {},
      })
      transport.connect()
      const fence = { epoch: 'epoch', generation: 'generation', revision: 3, sequence: 5 }
      const event = { type: 'session/title', sessionId: 'one', title: 'Title' }
      MockWebSocket.instance.message({ method: 'event', params: { runtime: 'example', event, transcriptFence: fence } })
      expect(received).toEqual([['example', event, fence]])
      transport.close()
    } finally {
      globalThis.WebSocket = original
    }
  })
  it('removes an aborted disconnected request before the socket opens', async () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = []
      url: string
      readyState = 0
      listeners = new Map<string, ((event: unknown) => void)[]>()
      sent: string[] = []

      constructor(url: string) {
        this.url = url
        MockWebSocket.instances.push(this)
      }

      addEventListener(type: string, cb: (event: unknown) => void) {
        const list = this.listeners.get(type) ?? []
        list.push(cb)
        this.listeners.set(type, list)
      }

      send(frame: string) { this.sent.push(frame) }
      close() { this.readyState = 3 }
      open() {
        this.readyState = 1
        for (const cb of this.listeners.get('open') ?? []) cb({})
      }
    }

    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.instances = []
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket

    try {
      const { Transport } = await import('./transport')
      const transport = new Transport('ws://example.test/ws?token=t', {
        onEvent: () => {}, onNotification: () => {}, onStatus: () => {},
      })
      transport.connect()
      const socket = MockWebSocket.instances[0]
      if (!socket) throw new Error('socket undefined')

      const controller = new AbortController()
      const promise = transport.request('runtime/account', { runtime: runtimeId('codex') }, { signal: controller.signal })
      controller.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

      socket.open()
      expect(socket.sent).toEqual([])
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })

  it('clears queued requests on socket disconnect so rejected calls are not sent on reconnect', async () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = []
      url: string
      readyState = 0
      listeners = new Map<string, ((event: unknown) => void)[]>()
      sent: string[] = []

      constructor(url: string) {
        this.url = url
        MockWebSocket.instances.push(this)
      }

      addEventListener(type: string, cb: (event: unknown) => void) {
        const list = this.listeners.get(type) ?? []
        list.push(cb)
        this.listeners.set(type, list)
      }

      send(frame: string) {
        this.sent.push(frame)
      }

      close() {
        this.readyState = 3
        for (const cb of this.listeners.get('close') ?? []) cb({})
      }

      message(value: unknown) { for (const cb of this.listeners.get('message') ?? []) cb({ data: JSON.stringify(value) }) }

      open() {
        this.readyState = 1
        for (const cb of this.listeners.get('open') ?? []) cb({})
      }
    }

    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.instances = []
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket

    try {
      const { Transport } = await import('./transport')
      const notifications: unknown[] = []
      const transport = new Transport('ws://example.test/ws?token=t', {
        onEvent: () => {},
        onNotification: event => notifications.push(event),
        onStatus: () => {},
      })
      transport.connect()
      const firstSocket = MockWebSocket.instances[0]
      expect(firstSocket).toBeDefined()
      if (!firstSocket) throw new Error('firstSocket undefined')

      // Request while socket is still CONNECTING (queued)
      const promise = transport.request('host/hello', { clientVersion: 'x' })

      // Socket closes before opening -> promise should reject with connection lost
      firstSocket.close()

      await expect(promise).rejects.toThrow('The connection to HarnessDesk was lost.')

      // Wait for backoff reconnect (attempt 1 is 300ms)
      await new Promise((resolve) => setTimeout(resolve, 350))
      const secondSocket = MockWebSocket.instances[1]
      expect(secondSocket).toBeDefined()
      if (!secondSocket) throw new Error('secondSocket undefined')
      secondSocket.open()

      // The queued request was rejected, so it must not be sent on reconnect
      expect(secondSocket.sent).toEqual([])
      firstSocket.message({ method: 'chats/rootsChanged', params: { epoch: 'old', revision: 10, roots: ['/old'] } })
      secondSocket.message({ method: 'chats/rootsChanged', params: { epoch: 'new', revision: 1, roots: ['/new'] } })
      firstSocket.close()
      expect(notifications).toEqual([{ method: 'chats/rootsChanged', params: { epoch: 'new', revision: 1, roots: ['/new'] } }])
      expect(transport.status).toBe('open')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })

  it('rejects pending requests when error.details is non-string rather than hanging (#507)', async () => {
    class MockWebSocket {
      static instances: MockWebSocket[] = []
      static OPEN = 1
      url: string
      readyState = 0
      listeners = new Map<string, ((event: unknown) => void)[]>()
      sent: string[] = []

      constructor(url: string) {
        this.url = url
        MockWebSocket.instances.push(this)
      }

      addEventListener(type: string, cb: (event: unknown) => void) {
        const list = this.listeners.get(type) ?? []
        list.push(cb)
        this.listeners.set(type, list)
      }

      send(frame: string) {
        this.sent.push(frame)
      }

      close() {
        this.readyState = 3
        for (const cb of this.listeners.get('close') ?? []) cb({})
      }

      open() {
        this.readyState = 1
        for (const cb of this.listeners.get('open') ?? []) cb({})
      }

      emitMessage(data: string) {
        for (const cb of this.listeners.get('message') ?? []) cb({ data })
      }
    }

    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.instances = []
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket

    try {
      const { Transport } = await import('./transport')
      const transport = new Transport('ws://example.test/ws?token=t', {
        onEvent: () => {},
        onNotification: () => {},
        onStatus: () => {},
      })
      transport.connect()
      const socket = MockWebSocket.instances[0]
      expect(socket).toBeDefined()
      if (!socket) throw new Error('socket undefined')
      socket.open()

      const promise = transport.request('host/hello', { clientVersion: 'x' })
      expect(socket.sent.length).toBe(1)
      const sentMsg = JSON.parse(socket.sent[0]!)
      const id = sentMsg.id

      socket.emitMessage(
        JSON.stringify({
          id,
          ok: false,
          error: { code: 'internal', message: 'bad', details: 42 },
        }),
      )

      await expect(promise).rejects.toThrow('bad — 42')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })
})
