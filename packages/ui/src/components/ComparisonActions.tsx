import { useEffect, useState } from 'react'
import { flowStepOf, type FlowExecution, type GitMergeOutcome, type GitRefsSummary, type Intent } from '@harnessdesk/protocol'
import { ComparisonDecision, DiffRangeDialog, MergeDialog } from '../design'
import type { ComparisonVerdictModel } from '../lib/comparison-verdict'
import { encodeComparisonMerge, type ComparisonMergeReceipt } from '../lib/comparison-merge'
import type { RunAttempt } from '../lib/run-timeline'
import { sanitizeText } from '../lib/sanitize'
import { useStore } from '../state/context'

/** Presents the Run's pick using the same Git dialogs and person completion as the workbench. */
export const ComparisonActions = ({ room, root, execution, cards, verdict, choice, onKeep, onMerged }: {
  room: string
  root: string
  execution: FlowExecution
  cards: readonly Intent[]
  verdict: Extract<ComparisonVerdictModel, {kind:'picked'}>
  choice: RunAttempt
  onKeep: (card: number) => void
  onMerged: (receipt: ComparisonMergeReceipt) => void
}) => {
  const store = useStore()
  const [refs, setRefs] = useState<GitRefsSummary | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'merge' | 'compare' | null>(null)
  const [readVersion, setReadVersion] = useState(0)
  const refresh = () => setReadVersion(value => value + 1)
  useEffect(() => {
    let live = true
    setRefs(null)
    setReadError(null)
    void store.transport.request('git/refs', {root}).then(next => {
      if (live) { setRefs(next); setReadError(next?.branch ? null : 'Choose a branch in Changes before merging.') }
    }).catch(() => { if (live) setReadError('The merge destination could not be read. Open Changes to check the repository.') })
    return () => { live = false }
  }, [store, root, readVersion])
  const attempts = verdict.judge.pick?.attempts ?? []
  const other = attempts.find(one => one.card !== choice.card)
  const label = choice.label.replace(/^Attempt /, '')
  const card = cards.find(one => one.id === verdict.next?.card)
  const step = card ? flowStepOf(card, undefined, [execution]) : null
  const canComplete = card?.state === 'open' && step?.kind === 'person' && step.outcomes.includes('merged') && execution.state === 'running'
  const refusal = !canComplete ? 'This Run has no pending person merge step.' : !choice.revision ? 'This attempt has no recorded commit.' : readError ?? (!refs ? 'Reading the merge destination…' : undefined)
  const merged = async (outcome: GitMergeOutcome) => {
    if (!choice.revision || !card) return
    if (!outcome.merged || outcome.merged.branch !== refs?.branch) throw new Error('The merge finished, but its commit could not be confirmed. Check Changes before recording the answer.')
    const receipt: ComparisonMergeReceipt = {version:1, run:execution.id, card:choice.card, revision:choice.revision, commit:outcome.merged.commit, branch:outcome.merged.branch, at:Date.now()}
    const handoff = encodeComparisonMerge(receipt)
    await store.teamIntent(room, card.id, 'done', undefined, 'merged', handoff)
    // The window's answer can resolve after the engine rolled a failed save
    // back. Only the saved person handoff earns a completion summary.
    const saved = await store.transport.request('team/state', {room})
    const answer = saved.intents.find(one => one.id === card.id)
    if (saved.problem || answer?.state !== 'done' || answer.outcome !== 'merged' || answer.handoff !== handoff) {
      throw new Error('The merge finished, but its answer was not saved. Check the Board before recording it again.')
    }
    onMerged(receipt)
  }
  const beforeMerge = async () => {
    const now = await store.transport.request('git/refs', {root})
    if (!now?.branch || now.branch !== refs?.branch) throw new Error('The destination branch changed. Close this question and check Changes before merging.')
    const current = store.getSnapshot().teams.get(room)?.intents.find(one => one.id === card?.id)
    const run = store.getSnapshot().flowExecutions.get(execution.id)
    if (current?.state !== 'open' || run?.state !== 'running') throw new Error('This person step is no longer waiting for a merge.')
  }
  return <>
    <ComparisonDecision
      title={choice.card === verdict.attempt.card ? `The judge picked ${label}` : `You picked ${label}`}
      reason={verdict.reason ? <>{choice.card !== verdict.attempt.card && `Judge picked ${verdict.attempt.label.replace(/^Attempt /, '')}: `}“{sanitizeText(verdict.reason)}”</> : undefined}
      mergeLabel={`Merge ${label} into ${sanitizeText(refs?.branch ?? '…')}`}
      mergeRefusal={refusal}
      onMerge={() => setDialog('merge')}
      onRefresh={refresh}
      onCompare={() => setDialog('compare')}
      compareRefusal={attempts.length !== 2 || attempts.some(one => !one.revision) ? 'Both attempts need a recorded commit to compare changes.' : undefined}
      keepLabel={other ? `Keep ${other.label.replace(/^Attempt /, '')} instead` : undefined}
      onKeep={canComplete && other?.revision ? () => onKeep(other.card) : undefined}
    />
    {dialog === 'merge' && refs && choice.revision && <MergeDialog key={choice.revision} root={root} refs={refs} fixedRef={choice.revision} expectedBranch={refs.branch ?? undefined} beforeMerge={beforeMerge} onMerged={merged} onDone={() => {setDialog(null); refresh()}} />}
    {dialog === 'compare' && attempts[0]?.revision && attempts[1]?.revision && <DiffRangeDialog root={root} from={attempts[0].revision} to={attempts[1].revision} onDone={() => setDialog(null)} />}
  </>
}
