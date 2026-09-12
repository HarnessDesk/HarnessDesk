import { describe, expect, it } from 'vitest'

import type { GitFileStatus } from '@harnessdesk/protocol'

import { inView } from './git-view'

const FILES: GitFileStatus[] = [
  // MM: staged, then changed again. `git/status` lists it once for each column.
  { path: 'both.txt', status: 'modified', staged: true },
  { path: 'both.txt', status: 'modified', staged: false },
  // A conflict, listed once and unstaged.
  { path: 'conflict.txt', status: 'conflicted', staged: false },
  { path: 'loose.txt', status: 'untracked', staged: false },
  { path: 'ready.txt', status: 'added', staged: true },
]

const shown = (staged: boolean): string[] => FILES.filter((file) => inView(file, staged)).map((file) => `${file.status} ${file.path}`)

describe('the staged view and the working tree (#180)', () => {
  it('a file staged and changed again is in each view once, and a conflict only in the working tree', () => {
    expect(shown(true)).toEqual(['modified both.txt', 'added ready.txt'])
    expect(shown(false)).toEqual(['modified both.txt', 'conflicted conflict.txt', 'untracked loose.txt'])
  })
})
