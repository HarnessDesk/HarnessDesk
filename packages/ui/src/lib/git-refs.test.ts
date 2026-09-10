import { describe, expect, test } from 'vitest'

import type { GitBranchRef } from '@harnessdesk/protocol'

import { branchTree, commitDate, inFolder, refChips, shortSha } from './git-refs'

const branch = (name: string): GitBranchRef => ({
  name,
  sha: 'abc',
  current: false,
  committedAt: 0,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
})

describe('branchTree', () => {
  test('slash prefixes fold into folders, the rest sort beside them', () => {
    const entries = branchTree([
      branch('main'),
      branch('feat/editor'),
      branch('feat/graph'),
      branch('fix/ci'),
      branch('zeta'),
    ])
    expect(
      entries.map((entry) => (entry.kind === 'folder' ? `${entry.name}/` : entry.branch.name)),
    ).toEqual(['feat/', 'fix/', 'main', 'zeta'])
    const feat = entries.find((entry) => entry.kind === 'folder' && entry.name === 'feat')
    expect(feat?.kind === 'folder' && feat.branches.map(inFolder)).toEqual(['editor', 'graph'])
  })

  test('a lone deep name still files under its folder, remainder kept whole', () => {
    const entries = branchTree([branch('claude/terminal-button-f1cf13')])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('folder')
    expect(entries[0]?.kind === 'folder' && entries[0].branches.map(inFolder)).toEqual([
      'terminal-button-f1cf13',
    ])
  })
})

describe('refChips', () => {
  const remotes = new Set(['origin'])

  test('classifies HEAD, branches, remotes and tags in git’s own words', () => {
    expect(refChips(['HEAD -> main', 'origin/main', 'tag: v1', 'feat/x'], remotes)).toEqual([
      { kind: 'head', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v1' },
      { kind: 'branch', name: 'feat/x' },
    ])
  })

  test('a detached HEAD and a slashed local branch both keep their meaning', () => {
    expect(refChips(['HEAD'], remotes)).toEqual([{ kind: 'head', name: 'HEAD' }])
    expect(refChips(['upstream/x'], remotes)).toEqual([{ kind: 'branch', name: 'upstream/x' }])
  })
})

describe('table text', () => {
  test('shortSha is the seven the column shows', () => {
    expect(shortSha('21249924edfc334013dcdd3d25bab7c9b4ea8d0d')).toBe('2124992')
  })

  test('commitDate steps from time to day to year as the commit ages', () => {
    const now = new Date('2026-08-29T15:00:00').getTime()
    const today = commitDate(new Date('2026-08-29T09:30:00').getTime(), now)
    expect(today).toMatch(/9:30|09:30/)
    expect(commitDate(new Date('2026-03-02T09:30:00').getTime(), now)).toMatch(/Mar 2/)
    expect(commitDate(new Date('2025-03-02T09:30:00').getTime(), now)).toMatch(/2025/)
  })
})
