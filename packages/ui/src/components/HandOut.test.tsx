import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Intent, TeamPeerInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { DEFAULT_TEMPLATE, HandOut, fill, pairUp, varsFor } from './HandOut'

/*
 * The open cards handed to the idle members, one each, in one action.
 *
 * Pinned because the pairing is the whole feature: a claimed card must not be
 * handed out twice, a busy member must not be handed a second job, and what
 * the host is asked to send must be the template plus each member's values —
 * never a hundred pre-rendered messages, which would put the rendering in
 * the renderer and take the batch away from the channel.
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

const intent = (id: number, title: string, over: Partial<Intent> = {}): Intent =>
  ({
    id,
    title,
    detail: null,
    state: 'open',
    files: [`reports/${id}.md`],
    dependsOn: [],
    claim: null,
    blockedReason: null,
    handoff: null,
    note: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as unknown as Intent

const member = (sessionId: string, nickname: string, busy = false): TeamPeerInfo =>
  ({ runtime: 'cursor', sessionId, title: null, agent: 'Cursor', busy, nickname, cwd: '/repo' }) as unknown as TeamPeerInfo

describe('pairing', () => {
  it('pairs open cards with idle members in order, skipping claimed cards and busy members', () => {
    const pairs = pairUp(
      [
        intent(1, 'Audit /'),
        intent(2, 'Audit /about', { state: 'claimed', claim: { runtime: 'cursor', sessionId: 'x' } as never }),
        intent(3, 'Audit /admin'),
        intent(4, 'Audit /blog'),
      ],
      [member('s1', 'Gemini'), member('s2', 'Gemini 2', true), member('s3', 'Gemini 3')],
    )
    expect(pairs.map((one) => [one.card.id, one.member.nickname])).toEqual([
      [1, 'Gemini'],
      [3, 'Gemini 3'],
    ])
  })

  it('pairs by name first — a member titled after its page takes that page — and in order after', () => {
    const named = (sessionId: string, nickname: string, title: string) =>
      ({ ...member(sessionId, nickname), title }) as TeamPeerInfo
    const pairs = pairUp(
      [intent(1, 'Audit /'), intent(2, 'Audit /about'), intent(3, 'Audit /admin/blog'), intent(4, 'Audit /admin')],
      [named('s1', 'Gemini', '/admin'), member('s2', 'Gemini 2'), named('s3', 'Gemini 3', '/about')],
    )
    expect(pairs.map((one) => [one.member.nickname, one.card.id, one.byName])).toEqual([
      ['Gemini', 4, true],
      ['Gemini 2', 1, false],
      ['Gemini 3', 2, true],
    ])
  })

  it('fills the slots per member and leaves an unknown slot standing', () => {
    const vars = varsFor(intent(7, 'Audit /pricing', { detail: 'Reading quality.' }), member('s1', 'Gemini 4'))
    expect(fill('#{{card}} {{title}} — {{detail}} ({{files}}) for {{member}}; {{nope}}', vars)).toBe(
      '#7 Audit /pricing — Reading quality. (reports/7.md) for Gemini 4; {{nope}}',
    )
  })
})

describe('HandOut', () => {
  it('shows the pairing, previews the first rendering, and hands out the template with each member\'s values', async () => {
    const teamHandout = vi.fn(async () => ({ batch: 'b', delivered: 2, queued: 0, refused: 0 }))
    const store = {
      subscribe: () => () => {},
      getSnapshot: () => ({ ...emptySnapshot(), status: 'open' }) as AppSnapshot,
      teamHandout,
    } as unknown as AppStore
    const onClose = vi.fn()
    const onTrouble = vi.fn()
    const intents = [intent(1, 'Audit /'), intent(2, 'Audit /about'), intent(3, 'Audit /admin')]
    const peers = [member('s1', 'Gemini'), member('s2', 'Gemini 2')]

    act(() => {
      root.render(
        <StoreProvider store={store}>
          <HandOut room="room-1" intents={intents} peers={peers} onClose={onClose} onTrouble={onTrouble} />
        </StoreProvider>,
      )
    })
    expect(container.querySelector('[data-slot="handout-pairing"]')?.textContent).toBe(
      '2 open cards to 2 idle members, one each; 1 more card stays open.',
    )
    expect(container.querySelector('[data-slot="handout-preview"]')?.textContent).toContain('Take card #1 — Audit /.')

    const go = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Hand out 2 cards')
    expect(go).toBeDefined()
    await act(async () => {
      go?.click()
      await Promise.resolve()
    })
    expect(teamHandout).toHaveBeenCalledWith('room-1', DEFAULT_TEMPLATE, [
      { runtime: 'cursor', sessionId: 's1', vars: varsFor(intents[0]!, peers[0]!) },
      { runtime: 'cursor', sessionId: 's2', vars: varsFor(intents[1]!, peers[1]!) },
    ])
    expect(onTrouble).toHaveBeenCalledWith(null)
    expect(onClose).toHaveBeenCalled()
  })

  it('says why there is nothing to hand out', () => {
    const store = {
      subscribe: () => () => {},
      getSnapshot: () => ({ ...emptySnapshot(), status: 'open' }) as AppSnapshot,
    } as unknown as AppStore
    act(() => {
      root.render(
        <StoreProvider store={store}>
          <HandOut room="room-1" intents={[intent(1, 'Audit /')]} peers={[member('s1', 'Gemini', true)]} onClose={() => {}} onTrouble={() => {}} />
        </StoreProvider>,
      )
    })
    expect(container.querySelector('[data-slot="handout-pairing"]')?.textContent).toBe('Nobody in the room is idle right now.')
    const go = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith('Hand out'))
    expect((go as HTMLButtonElement | undefined)?.disabled).toBe(true)
  })
})
