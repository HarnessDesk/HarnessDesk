import { beforeEach, expect, it, vi } from 'vitest'

import { type HostMethodName, type WireNotification } from '@harnessdesk/protocol'

import { EVIDENCE_BOARD, EVIDENCE_ROOM, PREVIEW_UNSEEN } from '../preview/evidence-fixture'
import { AppStore } from './store'

let store: AppStore
let request: ReturnType<typeof vi.fn>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  request = vi.fn(async (method: HostMethodName) => (method === 'evidence/board' ? EVIDENCE_BOARD : null))
  vi.spyOn(store.transport, 'request').mockImplementation(request as never)
})

const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as {
    handlers: { onNotification(notification: WireNotification): void }
  }
  transport.handlers.onNotification(notification)
}

it("a room's evidence arrives whole, replaces what was there, and goes with the room", () => {
  push({ method: 'evidence/changed', params: { room: EVIDENCE_ROOM, evidence: EVIDENCE_BOARD } })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(EVIDENCE_BOARD)

  const later = { ...EVIDENCE_BOARD, stamp: EVIDENCE_BOARD.stamp + 1, cards: [] }
  push({ method: 'evidence/changed', params: { room: EVIDENCE_ROOM, evidence: later } })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(later)

  push({ method: 'team/removed', params: { room: EVIDENCE_ROOM } })
  expect(store.getSnapshot().boardEvidence.has(EVIDENCE_ROOM)).toBe(false)
})

it('an answer older than what is drawn is dropped: a slow read never moves a card back', async () => {
  let answer!: (evidence: unknown) => void
  request.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
  const polling = store.loadBoardEvidence(EVIDENCE_ROOM)
  const newer = { ...EVIDENCE_BOARD, stamp: EVIDENCE_BOARD.stamp + 10, cards: [] }
  push({ method: 'evidence/changed', params: { room: EVIDENCE_ROOM, evidence: newer } })
  answer(EVIDENCE_BOARD)
  await polling
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(newer)
  push({
    method: 'evidence/changed',
    params: { room: EVIDENCE_ROOM, evidence: { ...EVIDENCE_BOARD, stamp: EVIDENCE_BOARD.stamp + 5 } },
  })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toBe(newer)
})

it('a board reads its evidence when asked, and a read that fails leaves what was drawn', async () => {
  await store.loadBoardEvidence(EVIDENCE_ROOM)
  expect(request).toHaveBeenCalledWith('evidence/board', { room: EVIDENCE_ROOM })
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toEqual(EVIDENCE_BOARD)

  request.mockRejectedValueOnce(new Error('There is no room room-evidence on this desk.'))
  await store.loadBoardEvidence(EVIDENCE_ROOM)
  expect(store.getSnapshot().boardEvidence.get(EVIDENCE_ROOM)).toEqual(EVIDENCE_BOARD)
})

it('running a check says it started, or hands back the command nobody here has approved, verbatim', async () => {
  await expect(store.runCheck(EVIDENCE_ROOM, 1, 'verify')).resolves.toEqual({ kind: 'started' })
  expect(request).toHaveBeenLastCalledWith('evidence/check/run', {
    room: EVIDENCE_ROOM,
    card: 1,
    name: 'verify',
  })

  request.mockRejectedValueOnce(
    Object.assign(new Error('lint runs a command this machine has not approved'), {
      code: 'checkUnseen',
      data: PREVIEW_UNSEEN,
    }),
  )
  await expect(store.runCheck(EVIDENCE_ROOM, 1, 'lint')).resolves.toEqual({
    kind: 'unseen',
    unseen: PREVIEW_UNSEEN,
  })

  await store.runCheck(EVIDENCE_ROOM, 1, 'lint', {
    seen: PREVIEW_UNSEEN.check.run,
    digest: PREVIEW_UNSEEN.digest,
  })
  expect(request).toHaveBeenLastCalledWith('evidence/check/run', {
    room: EVIDENCE_ROOM,
    card: 1,
    name: 'lint',
    seen: 'pnpm lint --max-warnings 0',
    digest: PREVIEW_UNSEEN.digest,
  })
})

it('any other refusal to run a check is thrown in the host’s words', async () => {
  request.mockRejectedValueOnce(
    Object.assign(new Error('lint is running on #1, and one check runs on a card at a time.'), {
      code: 'methodFailed',
    }),
  )
  await expect(store.runCheck(EVIDENCE_ROOM, 1, 'verify')).rejects.toThrow(
    'lint is running on #1, and one check runs on a card at a time.',
  )
})
