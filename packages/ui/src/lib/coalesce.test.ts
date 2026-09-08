import { describe, expect, test } from 'vitest'

import { coalesce } from './coalesce'

describe('coalesce', () => {
  test('a burst of triggers wakes the subscriber once', async () => {
    let wakes = 0
    const trigger = coalesce(() => (wakes += 1))
    for (let index = 0; index < 1_000; index += 1) trigger()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wakes).toBe(1)
  })

  test('a trigger after the frame wakes it again', async () => {
    let wakes = 0
    const trigger = coalesce(() => (wakes += 1))
    trigger()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    trigger()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wakes).toBe(2)
  })
})
