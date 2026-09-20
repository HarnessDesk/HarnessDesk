import type { Goal, Intent, SeatRecord } from '@harnessdesk/protocol'

export const goal = (id = 'g1', over: Partial<Goal> = {}): Goal => ({
  id,
  root: '/work/repo',
  cwd: '/work/repo',
  sentence: 'Finish the change',
  state: 'open',
  revision: 0,
  checkout: 'shared',
  dependsOn: [],
  origin: { kind: 'person' },
  createdAt: 1,
  updatedAt: 1,
  receipt: null,
  ...over,
})

export const seat = (id = 's1', over: Partial<SeatRecord> = {}): SeatRecord => ({
  id,
  agent: null,
  briefDigest: null,
  seat: { runtime: 'fake' },
  seatLabel: 'Fake Runtime',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: '/work/repo', project: '/work/repo', branch: null, head: null },
  session: { runtime: 'fake', sessionId: id },
  board: 'g1',
  role: null,
  openedAt: 1,
  closed: null,
  ...over,
})

export const intent = (id = 1, over: Partial<Intent> = {}): Intent => ({
  id,
  title: 'Finish the change',
  state: 'open',
  files: [],
  dependsOn: [],
  claim: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})
