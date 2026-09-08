import { describe, expect, test } from 'vitest'

import { elapsedSince, instant } from './clock'

const NOW = Date.UTC(2026, 7, 24, 5, 0, 0)

describe('instant', () => {
  test('a wall-clock reading passes through', () => {
    expect(instant(NOW)).toBe(NOW)
  })

  test('what cannot be a reading is nothing', () => {
    expect(instant(undefined)).toBeNull()
    expect(instant(null)).toBeNull()
    expect(instant(0)).toBeNull()
    // A fixture's sentinel, and the same one after a seconds-to-millis multiply.
    expect(instant(1)).toBeNull()
    expect(instant(1000)).toBeNull()
    // A real timestamp still in seconds.
    expect(instant(Math.floor(NOW / 1000))).toBeNull()
    expect(instant(Number.NaN)).toBeNull()
    expect(instant(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('elapsedSince', () => {
  test('measures forward from a believable stamp', () => {
    expect(elapsedSince(NOW - 74_000, NOW)).toBe(74_000)
  })

  test('a stamp a moment ahead is clock skew, and reads as zero', () => {
    expect(elapsedSince(NOW + 2_000, NOW)).toBe(0)
  })

  test('a stamp far ahead, or older than the app, buys no duration', () => {
    expect(elapsedSince(NOW * 1000, NOW)).toBeNull()
    expect(elapsedSince(1, NOW)).toBeNull()
  })
})
