import type { LibraryOpResult, LibraryPlannedOp } from '@harnessdesk/protocol'
import { showToast } from '../design'

export const HISTORY_VERB: Readonly<Record<string, string>> = {
  'skill/create': 'Installed', 'skill/update': 'Updated', 'skill/replace': 'Replaced a copy of', 'skill/remove': 'Removed a copy of',
  'mcp/create': 'Added', 'mcp/update': 'Updated', 'mcp/replace': 'Replaced', 'mcp/remove': 'Removed',
}
export const HISTORY_TRY: Readonly<Record<string, string>> = {
  'skill/create': 'install', 'skill/update': 'update', 'skill/replace': 'replace a copy of', 'skill/remove': 'remove a copy of',
  'mcp/create': 'add', 'mcp/update': 'update', 'mcp/replace': 'replace', 'mcp/remove': 'remove',
}
/** One result per apply, with failures kept until dismissed. Skips say nothing. */
export const libraryWriteToasts = (ops: readonly LibraryPlannedOp[], results: readonly LibraryOpResult[], open: () => void): void => {
  const joined = results.flatMap(result => {
    const op = ops.find(op => op.id === result.id)
    return op && op.action !== 'skip' && op.action !== 'refuse' ? [{ op, result }] : []
  })
  const done = joined.filter(one => one.result.outcome === 'done')
  const failed = joined.filter(one => one.result.outcome === 'failed')
  const action = { label: 'View changes', onSelect: open }
  if (done.length) {
    const op = done[0]!.op
    showToast({ tone: 'success', title: done.length === 1 ? `${HISTORY_VERB[`${op.kind}/${op.action}`]} ${op.name}`
      : done.every(one => one.op.kind === 'skill' && one.op.action === 'create') ? `Added ${done.length} skills to the Library` : `Made ${done.length} changes to the Library`, action })
  }
  if (failed.length) {
    const { op, result } = failed[0]!
    showToast({ tone: 'danger', title: failed.length === 1 ? `Couldn't ${HISTORY_TRY[`${op.kind}/${op.action}`]} ${op.name}` : `${failed.length} changes didn't go through`,
      body: result.detail, action }, { persist: true })
  }
}
