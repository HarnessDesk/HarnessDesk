import { describe, expect, it } from 'vitest'

import { isDerivedLength } from './guides-tokens'

describe('isDerivedLength', () => {
  it('takes a length built from other lengths, or from the root', () => {
    expect(isDerivedLength('calc(8px + 8px + 1px)')).toBe(true)
    expect(isDerivedLength('max(12px, 1rem)')).toBe(true)
    expect(isDerivedLength('calc(\n  4px +\n  1px\n)')).toBe(true)
  })

  it('leaves out a length that resolves against a box or a font', () => {
    for (const value of [
      'max(12px, 0.92em)',
      'calc(1em + 2px)',
      'min(12px, 2cqw)',
      'calc(3vi + 1px)',
      'calc(2cap)',
      'calc(50% - 4px)',
      'clamp(4px, 2dvh, 8px)',
      'calc(1lh - 4px)',
      'calc(4px +\n 0.5em)',
    ]) expect(isDerivedLength(value), value).toBe(false)
  })

  it('leaves out what is not a calculation', () => {
    expect(isDerivedLength('12px')).toBe(false)
    expect(isDerivedLength('var(--hd-space-3)')).toBe(false)
  })
})
