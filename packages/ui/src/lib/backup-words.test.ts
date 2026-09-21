import { expect, it } from 'vitest'

import type { BackupFile, BackupReport } from '@harnessdesk/protocol'

import { count, exportedSentence, restoredSentence } from './backup-words'

/* General › Backup's two sentences: every store counted, evidence among them. */

const report = (over: Partial<BackupReport> = {}): BackupReport => ({
  agents: { restored: 2, skipped: 0 },
  preferences: 3,
  transcripts: { restored: 4, skipped: 0 },
  agentFolders: { restored: 1, skipped: 0 },
  seating: { restored: 1, skipped: 0 },
  provenance: { restored: 0, duplicate: 0, refused: 0 },
  evidence: { restored: 12, duplicate: 0, refused: 0, failed: 0 },
  ...over,
})

const backup = (evidence: BackupFile['evidence']): BackupFile => ({
  kind: 'harnessdesk-backup',
  version: 1,
  exportedAt: 1,
  hostVersion: '1.0.0',
  agents: [{ id: 'fake' }],
  preferences: {},
  transcripts: [],
  agentFolders: [],
  seating: null,
  ...(evidence ? { evidence } : {}),
})

it('a restore counts what the desk observed beside everything else it added', () => {
  expect(restoredSentence(report())).toBe(
    'Restored 2 runtimes, 1 Agent, 1 seat choice, 3 preferences, 4 conversations and 12 records of what the desk observed.',
  )
  expect(count(1, 'record')).toBe('1 record')
})

it('what was already here is counted once, evidence included', () => {
  expect(restoredSentence(report({ transcripts: { restored: 4, skipped: 1 }, evidence: { restored: 0, duplicate: 5, refused: 0, failed: 0 } }))).toBe(
    'Restored 2 runtimes, 1 Agent, 1 seat choice, 3 preferences, 4 conversations and 0 records of what the desk observed. 6 already here or newer, left alone.',
  )
})

it('what a restore refused and what it could not write are said apart, never as already here', () => {
  expect(restoredSentence(report({ evidence: { restored: 3, duplicate: 0, refused: 2, failed: 1 } }))).toBe(
    'Restored 2 runtimes, 1 Agent, 1 seat choice, 3 preferences, 4 conversations and 3 records of what the desk observed. 2 records refused: this desk could not read them, or a backup may not write them here. 1 record could not be written.',
  )
})

it('an export counts the records it carries, and a backup from before evidence carries none', () => {
  expect(exportedSentence(backup([{ project: '/work/repo', seats: [{}, {}], facts: [{}] }]))).toBe(
    'Exported 1 runtime, 0 Agents of yours, 0 conversations and 3 records of what the desk observed.',
  )
  expect(exportedSentence(backup(undefined))).toBe(
    'Exported 1 runtime, 0 Agents of yours, 0 conversations and 0 records of what the desk observed.',
  )
})

it('an export that left out lines it could not read says so', () => {
  expect(exportedSentence(backup([{ project: '/work/repo', seats: [{}], facts: [{}], unreadable: 2 }]))).toBe(
    'Exported 1 runtime, 0 Agents of yours, 0 conversations and 2 records of what the desk observed. 2 records this build cannot read were left out.',
  )
})
