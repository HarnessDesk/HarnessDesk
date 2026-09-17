import { describe, expect, it } from 'vitest'

import { terminalAppearance } from './terminal'

describe('terminalAppearance', () => {
  it('translates the resolved foundation into xterm options', () => {
    document.body.style.setProperty('--hd-font-code', 'Probe Mono')
    document.body.style.setProperty('--hd-surface-fill', 'rgb(1, 2, 3)')
    document.body.style.setProperty('--hd-foreground', 'rgb(4, 5, 6)')
    document.body.style.setProperty('--hd-accent', 'rgb(7, 8, 9)')
    document.body.style.setProperty('--hd-accent-dim', 'rgba(7, 8, 9, 0.2)')

    expect(terminalAppearance()).toEqual({
      fontFamily: 'Probe Mono, Menlo, monospace',
      theme: {
        background: 'rgb(1, 2, 3)',
        foreground: 'rgb(4, 5, 6)',
        cursor: 'rgb(7, 8, 9)',
        selectionBackground: 'rgba(7, 8, 9, 0.2)',
      },
    })

    document.body.removeAttribute('style')
  })
})
