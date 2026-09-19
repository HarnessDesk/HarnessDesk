import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { ChangeStats, FileState, PatchHeader, PatchSection } from './Change'

describe('change presentation', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('owns the one added and removed count shape', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<ChangeStats added={12} removed={3} />))
    expect(host.querySelector('[data-slot="change-stats"]')?.textContent).toBe('+12−3')
    expect(host.querySelector('[data-tone="success"]')?.textContent).toBe('+12')
    expect(host.querySelector('[data-tone="danger"]')?.textContent).toBe('−3')
  })

  it('turns file state into a typed letter and accessible name', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<FileState state="renamed" />))
    expect(host.querySelector('[data-slot="file-state"]')?.textContent).toBe('R')
    expect(host.querySelector('[data-slot="file-state"]')?.getAttribute('aria-label')).toBe('Renamed')
  })

  it('names patch structure without a free-form visual kind catalogue', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<PatchSection><PatchHeader>src/a.ts</PatchHeader></PatchSection>))
    expect(host.querySelector('[data-slot="patch-section"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="patch-header"]')?.textContent).toBe('src/a.ts')
  })
})
