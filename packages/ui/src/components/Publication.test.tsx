import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ForgeReference, PublicationItem } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ItemView } from './Items'
import { publicationVerb } from '../design/patterns/PublicationCard'

/**
 * A publication in the transcript.
 *
 * The rule the row keeps: it is the desk's record of what went on the forge,
 * drawn as the object — a verb, the address as a link, the state — and never
 * a line of shell output or a claim in the desk's own words about the
 * signature. What the card shows is GitHub's own text; the row shows the
 * address and where it points.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const snapshot = emptySnapshot()

const render = (item: PublicationItem): void => {
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ItemView item={item} root="/w" />
      </StoreProvider>,
    )
  })
}

const reference = (overrides: Partial<ForgeReference> = {}): ForgeReference => ({
  kind: 'pullRequest',
  action: 'opened',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  title: 'Add widgets',
  state: 'open',
  author: 'octocat',
  additions: 12,
  deletions: 3,
  files: 2,
  excerpt: 'Widgets.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)',
  via: 'gh',
  signature: '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Codex GPT-5.4 · High)',
  ...overrides,
})

const item = (overrides: Partial<ForgeReference> = {}): PublicationItem =>
  ({ id: 'p1', type: 'publication', reference: reference(overrides) }) as unknown as PublicationItem

describe('the publication row', () => {
  it('draws the verb, the address as a link to the forge, and the state', () => {
    render(item())
    const row = container.querySelector('[data-kind="pullRequest"]')!
    expect(row.textContent).toContain('Opened a pull request')
    expect(row.textContent).toContain('acme/widgets #7')
    expect(row.textContent).toContain('Open')
    const link = row.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/7')
    // The row is the record, not the sentence: the signature is on the card, in GitHub's text, never restated here.
    expect(row.textContent).not.toContain('Generated with')
    expect(row.textContent).not.toContain('Signed')
  })

  it('opens the forge page outside the app rather than navigating the window', () => {
    const opened = vi.fn()
    ;(window as unknown as { harnessdesk?: unknown }).harnessdesk = { openExternal: opened }
    try {
      render(item())
      const link = container.querySelector('a')!
      act(() => {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(opened).toHaveBeenCalledWith('https://github.com/acme/widgets/pull/7')
    } finally {
      delete (window as unknown as { harnessdesk?: unknown }).harnessdesk
    }
  })

  it('names each kind of publication by what the conversation did', () => {
    expect(publicationVerb(reference())).toBe('Opened a pull request')
    expect(publicationVerb(reference({ action: 'updated' }))).toBe('Updated the pull request')
    expect(publicationVerb(reference({ kind: 'review', action: 'posted' }))).toBe('Reviewed the pull request')
    expect(publicationVerb(reference({ kind: 'comment', action: 'posted' }))).toBe('Commented on the pull request')
    expect(publicationVerb(reference({ kind: 'comment', action: 'posted', subject: 'issue' }))).toBe('Commented on the issue')
    // Said, not guessed: a pull request whose size the forge did not give is still a pull request.
    expect(
      publicationVerb(reference({ kind: 'comment', action: 'posted', additions: null, deletions: null, files: null })),
    ).toBe('Commented on the pull request')
  })

  it('says the state in a word, and nothing when the forge gave none', () => {
    render(item({ state: 'merged' }))
    expect(container.querySelector('[data-slot="publication-state"]')?.textContent).toBe('Merged')
    render(item({ state: null }))
    expect(container.querySelector('[data-slot="publication-state"]')).toBeNull()
  })

  /* The chip is one thing to focus, so a keyboard reaches its card the way a
     pointer does. #148 made every name card pointer-only for a while — right
     for a rail row full of controls, wrong here — and both reviewers of that
     round found this row had quietly lost its card for anyone tabbing to it. */
  it('opens its card for a keyboard that tabs to the chip, as for a pointer resting on it', () => {
    vi.useFakeTimers()
    try {
      render(item())
      const link = container.querySelector('a')!
      // A keyboard: a key goes down, and then focus lands on the chip.
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }))
      })
      act(() => link.focus())
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(document.activeElement).toBe(link)
      expect(document.querySelector('[data-slot="hover-card-content"]')?.textContent).toContain('Add widgets')
    } finally {
      vi.useRealTimers()
    }
  })
})
