import { useEffect, useMemo, useState } from 'react'
import type { GitMergeOutcome, GitRefsSummary } from '@harnessdesk/protocol'

import { useStore } from '../../state/context'
import { DiffView } from '../../components/Diff'
import { DiffIcon, MergeIcon } from '../../components/Icons'
import { Button } from '../ui/button'
import { NativeSelect } from '../ui/native-select'
import { Note } from './Settings'
import { ActionError } from './ActionError'
import { Dialog } from './ModalDialog'

/** Shared Git questions for the Changes pane and a recorded comparison. */
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

// -------------------------------------------------------------------- merge

/** The toolbar's Merge: pick what joins the current branch. */
export const MergeDialog = ({
  root,
  refs,
  preselect,
  fixedRef,
  expectedBranch,
  beforeMerge,
  onMerged,
  onDone,
}: {
  root: string
  refs: GitRefsSummary
  preselect?: string
  /** A comparison merges its recorded revision; the generic Git dialog keeps its picker. */
  fixedRef?: string
  expectedBranch?: string
  beforeMerge?: () => Promise<void>
  onMerged?: (outcome: GitMergeOutcome) => Promise<void>
  onDone: (done: boolean) => void
}) => {
  const store = useStore()
  const current = refs.branch
  const choices = useMemo(() => {
    if (fixedRef) return [fixedRef]
    const locals = refs.branches.filter((branch) => !branch.current).map((branch) => branch.name)
    const remotes = refs.remotes.map((remote) => `${remote.remote}/${remote.name}`)
    const tags = refs.tags.map((tag) => tag.name)
    return [...locals, ...remotes, ...tags]
  }, [refs, fixedRef])
  const [ref, setRef] = useState(fixedRef ?? preselect ?? choices[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const merge = async (): Promise<void> => {
    if (!ref) return
    setBusy(true)
    setError(null)
    try {
      await beforeMerge?.()
      const outcome = await store.transport.request('git/merge', { root, ref, ...(expectedBranch ? {expectedBranch} : {}) })
      settle(store, outcome)
      if (outcome.conflicts.length === 0) await onMerged?.(outcome)
      onDone(true)
    } catch (raised) {
      setError(reason(raised))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={current ? `Merge into ${current}` : 'Merge'}
      icon={<MergeIcon size={16} />}
      onClose={() => onDone(false)}
      footer={
        <>
          <Button variant="default" onClick={() => void merge()} disabled={busy || !ref}>
            {busy ? 'Merging…' : 'Merge'}
          </Button>
          <Button variant="secondary" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <NativeSelect
          variant="filled" controlSize="compact"
          value={ref} disabled={busy || Boolean(fixedRef)}
          aria-label="What to merge"
          onChange={(event) => setRef(event.target.value)}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </NativeSelect>
        <Note>
          A conflict is not a failure: the files stay in the working tree, named, and committing concludes the
          merge.
        </Note>
        {error && (
          <ActionError>{error}</ActionError>
        )}
      </div>
    </Dialog>
  )
}

/** One warning for every conflicted outcome, and the surface that shows it. */
const settle = (store: ReturnType<typeof useStore>, outcome: GitMergeOutcome): void => {
  if (outcome.conflicts.length > 0) {
    store.notice('warning', outcome.summary)
    // Open, never toggle: a Changes panel already showing must stay.
    store.openDetailsTab('changes')
  } else {
    store.notice('info', outcome.summary)
  }
}

// -------------------------------------------------------------- range diff

/** “Diff against current”: the plain difference between two revisions. */
export const DiffRangeDialog = ({
  root,
  from,
  to,
  onDone,
}: {
  root: string
  from: string
  to: string
  onDone: () => void
}) => {
  const store = useStore()
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void store.transport
      .request('git/diffRange', { root, from, to })
      .then((result) => {
        if (!cancelled) setDiff(result.diff)
      })
      .catch((raised: unknown) => {
        if (!cancelled) setError(reason(raised))
      })
    return () => {
      cancelled = true
    }
  }, [root, from, to, store])

  return (
    <Dialog
      title={`${from} → ${to}`}
      icon={<DiffIcon size={16} />}
      size="xl"
      tall
      onClose={onDone}
      footer={<Button variant="default" onClick={onDone}>Close</Button>}
    >
      {error ? (
        <ActionError>{error}</ActionError>
      ) : diff === null ? (
        <Note>Reading the difference…</Note>
      ) : diff.length === 0 ? (
        <Note>The two are identical.</Note>
      ) : (
        <DiffView diff={diff} />
      )}
    </Dialog>
  )
}

