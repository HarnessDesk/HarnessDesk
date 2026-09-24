import type { FindingDetailPage, FindingPage, FindingView } from '@harnessdesk/protocol'

import type { FindingsListState } from '../lib/findings'
import { PREVIEW_GOAL } from './goal-fixture'

/**
 * The findings ledger's read states, for the Goal rail and its detail dialog.
 *
 * One Goal's worth of rows covers every lifecycle word the ledger can show:
 * plain open, a repair claimed and not yet confirmed, a repair confirmed and
 * posted, a confirmed withdrawal, a security finding with a changed-line
 * anchor, a row restored from a backup, and a row carried in from an earlier
 * wrapped Goal — its origin still the source's, never a new claim.
 */

const SHA = 'c'.repeat(40)
const GOAL = PREVIEW_GOAL.goal.id

const finding = (id: string, over: Partial<FindingView> = {}): FindingView => ({
  id,
  origin: { goal: GOAL, run: 'run-preview', round: 2, card: 3, seat: 'seat-preview-reviewer', at: SHA },
  ownerGoal: GOAL,
  title: 'Untitled finding',
  body: 'Details.',
  category: 'ordinary',
  blocking: true,
  related: null,
  anchor: null,
  lifecycle: { state: 'open', confirmed: false, repairs: [] },
  sequence: 1,
  evidence: [`ev-${id}`],
  posted: [],
  restored: false,
  problem: null,
  ...over,
})

export const PREVIEW_FINDINGS: readonly FindingView[] = [
  finding('finding-open-1', {
    title: 'Missing null check on the checkout path',
    body: 'A `null` checkout crashes the flow before the guard runs.',
  }),
  finding('finding-claim-1', {
    title: 'Race between two writers on the same lane',
    body: 'Two lanes wrote the same file at once; the later write silently won.',
    lifecycle: { state: 'repaired', confirmed: false, repairs: [SHA] },
  }),
  finding('finding-confirmed-1', {
    title: 'Off-by-one in the pagination cursor',
    body: 'Fixed and confirmed by the reviewer.',
    blocking: false,
    lifecycle: { state: 'repaired', confirmed: true, repairs: [SHA] },
    posted: [{
      repo: 'harnessdesk/harnessdesk', pr: 42, comment: 991, kind: 'review-comment',
      url: 'https://github.com/harnessdesk/harnessdesk/pull/42#discussion_r991', operation: 'op-post-1',
    }],
  }),
  finding('finding-withdrawn-1', {
    title: 'False positive on a generated file',
    body: 'The file is generated; this does not apply.',
    blocking: false,
    lifecycle: { state: 'withdrawn', confirmed: true, repairs: [] },
  }),
  finding('finding-security-1', {
    title: 'Path traversal in the upload handler',
    body: 'A `..` path component reaches outside the workspace root.',
    category: 'security',
    anchor: { path: 'src/upload.ts', line: 42, side: 'RIGHT' },
  }),
  finding('finding-restored-1', {
    title: 'Recovered from an earlier backup',
    body: 'History only — this desk did not observe it.',
    blocking: false,
    restored: true,
    lifecycle: { state: 'withdrawn', confirmed: true, repairs: [] },
  }),
  finding('finding-carried-1', {
    title: 'Carried from the previous attempt',
    body: 'Still true; carried by reference, not re-raised.',
    origin: { goal: 'goal-wrapped', run: 'run-old', round: 4, card: 2, seat: 'seat-preview-reviewer', at: SHA },
  }),
]

const isOpen = (view: FindingView): boolean => !view.lifecycle.confirmed
const isBlocking = (view: FindingView): boolean => view.blocking && !view.lifecycle.confirmed

export const findingPage = (filter: 'all' | 'open' | 'blocking'): FindingPage => {
  const rows = filter === 'blocking' ? PREVIEW_FINDINGS.filter(isBlocking)
    : filter === 'open' ? PREVIEW_FINDINGS.filter(isOpen)
    : PREVIEW_FINDINGS
  return {
    goal: GOAL,
    stamp: 'preview-stamp',
    rows,
    next: null,
    totals: {
      all: PREVIEW_FINDINGS.length,
      open: PREVIEW_FINDINGS.filter(isOpen).length,
      blocking: PREVIEW_FINDINGS.filter(isBlocking).length,
    },
    problem: null,
  }
}

export const findingsListState = (filter: 'all' | 'open' | 'blocking' = 'all'): FindingsListState => {
  const page = findingPage(filter)
  return {
    filter, rows: page.rows, next: page.next, totals: page.totals, problem: page.problem,
    loading: false, loadingMore: false, error: null, stale: false,
  }
}

export const LOADING_FINDINGS_STATE: FindingsListState = {
  filter: 'all', rows: [], next: null, totals: null, problem: null,
  loading: true, loadingMore: false, error: null, stale: false,
}

export const EMPTY_FINDINGS_STATE: FindingsListState = {
  filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
  loading: false, loadingMore: false, error: null, stale: false,
}

export const UNREADABLE_FINDINGS_STATE: FindingsListState = {
  filter: 'all', rows: [], next: null, totals: null,
  problem: 'Some evidence records could not be read, so this ledger cannot be shown as complete. A person has to look.',
  loading: false, loadingMore: false, error: null, stale: false,
}

export const FAILED_FINDINGS_STATE: FindingsListState = {
  ...findingsListState('all'),
  error: 'The desk did not answer. Check the connection and try again.',
  stale: true,
}

export const findingDetail = (id: string): FindingDetailPage => {
  const found = PREVIEW_FINDINGS.find((one) => one.id === id) ?? PREVIEW_FINDINGS[0]!
  return { finding: found, records: [], seat: null, next: null, problem: null }
}
