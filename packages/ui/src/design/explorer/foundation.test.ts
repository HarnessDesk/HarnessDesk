import { describe, expect, it } from 'vitest'

import { declarations, FOUNDATIONS } from './foundation'

/**
 * The explorer applies a foundation's overrides on `body`, so it may only take
 * the surface rule of a stylesheet. The Sheet's plate rule resets the group
 * tokens to `initial` for a plate; flattened into the same map, those resets
 * replaced the Sheet's own values and the explorer drew Cards fallbacks.
 */
describe('foundation overrides', () => {
  it('reads only the named rule', () => {
    const css = ':root body[x] { --hd-a: 0px; /* note */ --hd-b: red; }\n:root body[x] .plate { --hd-a: initial; }'
    expect(declarations(css, ':root body[x]')).toEqual({ '--hd-a': '0px', '--hd-b': 'red' })
  })

  it('takes the Sheet values, not its plate resets', () => {
    const sheet = FOUNDATIONS.find((one) => one.id === 'sheet')!.overrides
    expect(sheet['--hd-card-radius']).toBe('0px')
    expect(sheet['--hd-card-fill']).toBe('var(--hd-background)')
    expect(Object.values(sheet)).not.toContain('initial')
  })
})
