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
})

