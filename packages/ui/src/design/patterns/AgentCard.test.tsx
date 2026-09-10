import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { AgentCard, type AgentCardSubject } from './AgentCard'

/**
 * The card's one structural rule, pinned.
 *
 * Everything else here is layout that a designer may move. What must not move
 * is **a band with nothing true to say is not drawn** — because the failure it
 * prevents is not cosmetic. A card that keeps its shape by padding out empty
 * bands reports a confidence it does not have: an agent whose harness never
 * says how big its context window is would show a full meter, and the reader
 * would hand it work it cannot take.
 *
 * The second is the caution band carrying *every* caution rather than the
 * highest-ranked one. The rail can only afford one and drops the loser; having
 * room for the pair is most of why this card exists rather than a longer
 * tooltip, and a later tidy-up that "simplifies" it back to one would delete
 * the reason without noticing.
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

const render = (subject: AgentCardSubject): void => {
  act(() => root.render(<AgentCard subject={subject} />))
}

const text = (): string => container.textContent ?? ''

/** How many bands the card drew — each one costs a divider and some height. */
const bands = (): number => container.querySelectorAll('[data-slot="agent-card-band"]').length

const BARE: AgentCardSubject = {
  kind: 'member',
  name: 'Opus',
  tint: 'violet',
  mark: <svg />,
}

it('draws nothing but the crest when that is all it knows', () => {
  render(BARE)
  expect(text()).toBe('Opus')
  expect(bands()).toBe(0)
})

it('does not draw a Running band for a harness that reports no model or state', () => {
  render({ ...BARE, running: { model: null, version: '2.1.259', state: null } })
  // The version alone is not a reading: a band saying only "2.1.259" is a
  // divider spent on the one fact nobody opened the card for.
  expect(text()).not.toContain('2.1.259')
  expect(bands()).toBe(0)
})

it('fills the meter with what is left, and says so', () => {
  render({
    ...BARE,
    meter: { label: 'Context', left: 740_000, of: 1_000_000, reading: '740K left of 1M' },
  })
  expect(text()).toContain('740K left of 1M')
  const bar = container.querySelector('[role="progressbar"]')
  expect(bar?.getAttribute('aria-valuenow')).toBe('740000')
  const fill = container.querySelector('[data-slot="progress-fill"]') as HTMLElement | null
  expect(fill?.style.width).toBe('74%')
})

it('carries both cautions, not the higher-ranked one', () => {
  render({
    ...BARE,
    cautions: [
      { tone: 'danger', text: 'Cannot take jobs — the board’s tools are not reachable.' },
      { tone: 'quiet', text: 'Reachable, but has taken nothing from the board this run.' },
    ],
  })
  expect(text()).toContain('Cannot take jobs')
  expect(text()).toContain('has taken nothing from the board')
})

it('offers only the verbs it was given', () => {
  render({ ...BARE, actions: [{ label: 'Open', onSelect: () => {}, primary: true }] })
  const labels = [...container.querySelectorAll('button')].map((one) => one.textContent)
  expect(labels).toEqual(['Open'])
})

it('says working as a light and a reading, never as a bare word', () => {
  render({ ...BARE, working: true, running: { state: 'Working — 41s into this turn' } })
  // The lamp is decoration; the sentence under the name is what a screen
  // reader hears, and the band carries the number a glance came for.
  expect(text()).toContain('— working')
  expect(text()).toContain('41s into this turn')
})

it('never prints the same string twice in the crest', () => {
  // A room names its members after their agent, so this arrives from the real
  // wire, not from a contrived subject: nickname "Claude Code", harness
  // "Claude Code", no account. It read "Claude Code / Claude Code" in the
  // running app before this rule existed.
  render({ ...BARE, name: 'Claude Code', identity: 'Claude Code', also: 'Claude Code' })
  expect(text()).toBe('Claude Code')
  // And the half that is news survives.
  render({ ...BARE, name: 'Claude Code', identity: 'Claude Code · not signed in' })
  expect(text()).toContain('not signed in')
})

it('keeps the second name only when it is a name of its own', () => {
  render({ ...BARE, also: 'Canonicalise a room’s project' })
  expect(text()).toContain('Canonicalise a room’s project')
  render(BARE)
  expect(text()).toBe('Opus')
})

/**
 * A setting with three states is a band, not three more verbs.
 *
 * The room's inbound mode went in as three entries in `actions`, and the verbs
 * row does not wrap: with Open, Watch beside and Take out of the room already
 * there, the card drew five buttons, two of them past its own edge and one cut
 * mid-word. It was found by photographing the real app, and it is the reason
 * this band exists.
 */
it('a choice is its own band, showing which of the values is current', () => {
  const picked: string[] = []
  render({
    ...BARE,
    choice: {
      label: 'Messages',
      value: 'hold',
      options: [
        { value: 'accept', label: 'Accept' },
        { value: 'hold', label: 'Hold' },
        { value: 'refuse', label: 'Refuse' },
      ],
      onChange: (next) => picked.push(next),
    },
    actions: [{ label: 'Open', onSelect: () => {}, primary: true }],
  })

  // Two bands: the choice and the verbs. They are separate rows, which is the
  // whole of what this change is.
  expect(bands()).toBe(2)
  const group = container.querySelector('[aria-label="Messages"]')
  expect(group).toBeTruthy()
  expect(group?.querySelectorAll('button').length).toBe(3)
  // Which one it is in — a list of verbs cannot say this at all.
  const current = [...(group?.querySelectorAll('button') ?? [])].find(
    (one) => one.getAttribute('aria-checked') === 'true' || one.getAttribute('data-checked') !== null,
  )
  expect(current?.textContent?.trim()).toBe('Hold')

  const accept = [...(group?.querySelectorAll('button') ?? [])].find(
    (one) => one.textContent?.trim() === 'Accept',
  )
  act(() => (accept as HTMLButtonElement).click())
  expect(picked).toEqual(['accept'])
})

it('the verbs row wraps, so a long label cannot leave the card', () => {
  /* Not decoration. Three sentence-length verbs is what a member card in a
     room carries, and the row was `flex` with no wrap and no shrink. */
  render({ ...BARE, actions: [{ label: 'Open', onSelect: () => {} }] })
  const row = [...container.querySelectorAll('[data-slot="agent-card-band"]')].at(-1)
  expect(row?.className).toContain('flex-wrap')
})

it('a subject with no choice draws no band for one', () => {
  /* The column head passes no `onInbound`, so its card must not offer the
     control. True by construction — no prop, no band — and pinned so a
     refactor that defaults the field has to say so. */
  render({ ...BARE, actions: [{ label: 'Open', onSelect: () => {} }] })
  expect(container.querySelector('[data-slot="agent-card-choice"]')).toBeNull()
  expect(bands()).toBe(1)
})
