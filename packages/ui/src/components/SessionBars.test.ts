import { describe, expect, it } from 'vitest'

import type { Session } from '@harnessdesk/protocol'

import { deliverablesOf } from './SessionBars'

const withChanges = (changes: unknown[]): Session =>
  ({
    id: 's1',
    turns: [{ id: 't1', status: 'completed', items: [{ id: 'f1', type: 'fileChange', status: 'completed', changes }] }],
  }) as unknown as Session

describe('deliverablesOf', () => {
  it('counts a change the way the file view draws it (#155)', () => {
    // An added file arrives as its content, with no + on its lines; after a hunk, +++ is an added ++ line.
    expect(
      deliverablesOf(
        withChanges([
          { path: 'new.ts', kind: { type: 'add' }, diff: 'export const x = 1\nexport const y = 2\n' },
          { path: 'count.ts', kind: { type: 'update' }, diff: '@@ -1,1 +1,2 @@\n x\n+++count;\n' },
        ]),
      ),
    ).toEqual([
      { path: 'new.ts', kind: 'add', added: 2, removed: 0 },
      { path: 'count.ts', kind: 'update', added: 1, removed: 0 },
    ])
  })

  it('leaves out a file the session made and then removed, as the turn card does (review of #236, round 1)', () => {
    expect(
      deliverablesOf(
        withChanges([
          { path: 'scratch.cjs', kind: { type: 'add' }, diff: 'x\n' },
          { path: 'kept.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
          { path: 'scratch.cjs', kind: { type: 'delete' }, diff: 'x\n' },
        ]),
      ),
    ).toEqual([{ path: 'kept.ts', kind: 'update', added: 1, removed: 1 }])
  })
})
