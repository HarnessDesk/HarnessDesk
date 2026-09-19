import type { BackupFile, BackupReport } from '@harnessdesk/protocol'

/**
 * What General › Backup says after an export or a restore: every store it
 * carried, counted, each with its noun — never a field name. Kept apart from
 * the rows that say it so each sentence can be read without a screen.
 *
 * Nothing is counted as something it is not. An export that left lines out —
 * ones this build could not read — says so. A restore says apart what was
 * already here, what it refused — a record it could not read, or one a backup
 * may not write here — and what could not be written.
 */

/** "1 runtime", "3 runtimes" — a count and its noun, the noun's plural by adding an s. */
export const count = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`

/** Every Seat and fact a backup carries, counted as the lines its stores hold. */
const recordsIn = (backup: BackupFile): number =>
  (backup.evidence ?? []).reduce((sum, one) => sum + one.seats.length + one.facts.length, 0)

/** The lines its stores held that the exporting build could not read, and so left out. */
const unreadableIn = (backup: BackupFile): number =>
  (backup.evidence ?? []).reduce((sum, one) => sum + (one.unreadable ?? 0), 0)

export const exportedSentence = (backup: BackupFile): string => {
  const left = unreadableIn(backup)
  return `Exported ${count(backup.agents.length, 'runtime')}, ${count(backup.agentFolders?.length ?? 0, 'Agent')} of yours, ${count(backup.transcripts.length, 'conversation')} and ${count(recordsIn(backup), 'record')} of what the desk observed.${left > 0 ? ` ${count(left, 'record')} this build cannot read ${left === 1 ? 'was' : 'were'} left out.` : ''}`
}

export const restoredSentence = (report: BackupReport): string => {
  const here =
    report.agents.skipped + report.transcripts.skipped + report.agentFolders.skipped + report.evidence.duplicate
  const { refused, failed } = report.evidence
  return `Restored ${count(report.agents.restored, 'runtime')}, ${count(report.agentFolders.restored, 'Agent')}, ${count(report.seating.restored, 'seat choice')}, ${count(report.preferences, 'preference')}, ${count(report.transcripts.restored, 'conversation')} and ${count(report.evidence.restored, 'record')} of what the desk observed.${here > 0 ? ` ${here} already here or newer, left alone.` : ''}${refused > 0 ? ` ${count(refused, 'record')} refused: this desk could not read ${refused === 1 ? 'it' : 'them'}, or a backup may not write ${refused === 1 ? 'it' : 'them'} here.` : ''}${failed > 0 ? ` ${count(failed, 'record')} could not be written.` : ''}`
}
