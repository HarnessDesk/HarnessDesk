import { describe, expect, it } from 'vitest'

import { handOverToComposer } from './compose'

describe('handing a message to the composer', () => {
  it('is acknowledged the moment a composer is listening', async () => {
    let got: unknown = null
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ text: string; onReceived?: () => void }>).detail
      got = detail.text
      detail.onReceived?.()
    }
    window.addEventListener('harnessdesk:compose', listener)
    try {
      expect(await handOverToComposer({ text: 'hello' })).toBe(true)
      expect(got).toBe('hello')
    } finally {
      window.removeEventListener('harnessdesk:compose', listener)
    }
  })

  it('keeps asking for a few frames, then says nobody took it', async () => {
    // A composer that only turns up after a couple of frames — the effect
    // that registers its listener has not run yet.
    let dispatches = 0
    let late: ((event: Event) => void) | null = null
    const counter = (): void => {
      dispatches += 1
    }
    window.addEventListener('harnessdesk:compose', counter)
    const promise = handOverToComposer({ text: 'late' }, { frames: 8 })
    setTimeout(() => {
      late = (event: Event): void => {
        ;(event as CustomEvent<{ onReceived?: () => void }>).detail.onReceived?.()
      }
      window.addEventListener('harnessdesk:compose', late)
    }, 30)
    try {
      expect(await promise).toBe(true)
      expect(dispatches).toBeGreaterThan(1)
    } finally {
      window.removeEventListener('harnessdesk:compose', counter)
      if (late) window.removeEventListener('harnessdesk:compose', late)
    }
    expect(await handOverToComposer({ text: 'nobody' }, { frames: 3 })).toBe(false)
  })
})
