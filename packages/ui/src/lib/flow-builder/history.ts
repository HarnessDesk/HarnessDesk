import type { BuilderDocument } from './document'

export interface BuilderHistory {
  readonly past: readonly BuilderDocument[]
  readonly present: BuilderDocument
  readonly future: readonly BuilderDocument[]
}

const HISTORY_LIMIT = 200

/**
 * History stores whole-document snapshots. The screen commits one move on
 * drag end, not on every pointer move, so a drag creates one undo entry.
 */
export const createHistory = (present: BuilderDocument): BuilderHistory => ({ past: [], present, future: [] })
export const editHistory = (history: BuilderHistory, operation: (document: BuilderDocument) => BuilderDocument): BuilderHistory => {
  const present = operation(history.present)
  return present === history.present ? history : { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present, future: [] }
}
export const undo = (history: BuilderHistory): BuilderHistory => {
  const present = history.past.at(-1)
  return present ? { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] } : history
}
export const redo = (history: BuilderHistory): BuilderHistory => {
  const present = history.future[0]
  return present ? { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present, future: history.future.slice(1) } : history
}
