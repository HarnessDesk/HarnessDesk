import { afterEach, expect, test, vi } from 'vitest'

import { scriptedScrollBehavior } from './scripted-scroll'

afterEach(() => vi.unstubAllGlobals())

test('a view without matchMedia scrolls without animation', () => {
  vi.stubGlobal('matchMedia', undefined)
  expect(scriptedScrollBehavior()).toBe('auto')
})

test.each([
  [true, 'auto'],
  [false, 'smooth'],
] as const)('a reduced-motion preference of %s chooses %s', (matches, behavior) => {
  const matchMedia = vi.fn(() => ({ matches }))
  vi.stubGlobal('matchMedia', matchMedia)
  expect(scriptedScrollBehavior()).toBe(behavior)
  expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
})
