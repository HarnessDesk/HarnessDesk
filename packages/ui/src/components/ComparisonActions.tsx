import { useEffect, useState } from 'react'
import { flowStepOf, type FlowExecution, type GitRefsSummary, type Intent } from '@harnessdesk/protocol'
import { ComparisonDecision } from '../design'
import type { ComparisonVerdictModel } from '../lib/comparison-verdict'
import { encodeComparisonMerge, type ComparisonMergeReceipt } from '../lib/comparison-merge'
import type { RunAttempt } from '../lib/run-timeline'
import { sanitizeText } from '../lib/sanitize'
import { useStore } from '../state/context'
import { DiffRangeDialog, MergeDialog } from './GitDialogs'

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
  useEffect(() => {
    let live = true
    void store.transport.request('git/refs', {root}).then(next => {
      if (live) { setRefs(next); setReadError(next?.branch ? null : 'Choose a branch in Changes before merging.') }
    }).catch(() => { if (live) setReadError('The merge destination could not be read. Open Changes to check the repository.') })
    return () => { live = false }
  }, [store, root])
  const attempts = verdict.judge.pick?.attempts ?? []
  const other = attempts.find(one => one.card !== choice.card)
  const label = choice.label.replace(/^Attempt /, '')
  const card = cards.find(one => one.id === verdict.next?.card)
  const step = card ? flowStepOf(card, undefined, [execution]) : null
  const canComplete = card?.state === 'open' && step?.kind === 'person' && step.outcomes.includes('merged') && execution.state === 'running'
  const refusal = !canComplete ? 'This Run has no pending person merge step.' : !choice.revision ? 'This attempt has no recorded commit.' : readError ?? (!refs ? 'Reading the merge destination…' : undefined)
  const merged = async () => {
    if (!choice.revision || !card) return
    const now = await store.transport.request('git/refs', {root})
    if (!now?.branch || !now.headSha) throw new Error('The merge finished, but its commit could not be read. Check Changes before recording the answer.')
    const receipt: ComparisonMergeReceipt = {version:1, run:execution.id, card:choice.card, revision:choice.revision, commit:now.headSha, branch:now.branch, at:Date.now()}
    await store.teamIntent(room, card.id, 'done', undefined, 'merged', encodeComparisonMerge(receipt))
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
      onCompare={() => setDialog('compare')}
      compareRefusal={attempts.length !== 2 || attempts.some(one => !one.revision) ? 'Both attempts need a recorded commit to compare changes.' : undefined}
      keepLabel={other ? `Keep ${other.label.replace(/^Attempt /, '')} instead` : undefined}
      onKeep={canComplete && other?.revision ? () => onKeep(other.card) : undefined}
    />
    {dialog === 'merge' && refs && choice.revision && <MergeDialog key={choice.revision} root={root} refs={refs} fixedRef={choice.revision} beforeMerge={beforeMerge} onMerged={merged} onDone={() => setDialog(null)} />}
    {dialog === 'compare' && attempts[0]?.revision && attempts[1]?.revision && <DiffRangeDialog root={root} from={attempts[0].revision} to={attempts[1].revision} onDone={() => setDialog(null)} />}
  </>
}
