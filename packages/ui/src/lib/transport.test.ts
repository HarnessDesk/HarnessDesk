import { describe, expect, it } from 'vitest'

import { sentenceOf } from './transport'

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

describe('Transport queue handling (#501)', () => {
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
        onEvent: () => {},
        onNotification: () => {},
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

