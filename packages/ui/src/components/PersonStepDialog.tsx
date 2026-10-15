import { useEffect, useRef, useState } from 'react'
import { sessionKey, type FlowStep, type GitRefsSummary, type Intent, type ReviewCandidate, type SessionId } from '@harnessdesk/protocol'
import { Button, Chip, Dialog, DiffRangeDialog, MergeDialog, Note, RowChoice, Rows } from '../design'
import { shortSha } from '../lib/git-refs'
import { isRecord, RECORD_REASON } from '../lib/team-record'
import { useSnapshot, useStore } from '../state/context'

/** The Board and comparison shelf open the same person-step question and write the same recorded answer. */
export const PersonStepDialog = ({ room, intent, role, mode, onClose }: {
  room: string
  intent: Intent
  role: FlowStep
  mode: 'review' | 'answer'
  onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const record = isRecord(snapshot.goals.get(room))
  const team = snapshot.teams.get(room)
  const root = team?.cwd ?? team?.root
  const [refs, setRefs] = useState<GitRefsSummary | null>(null)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitDialog, setGitDialog] = useState<'merge' | 'diff' | null>(null)
  const saving = useRef(false)
  const [reviewDialog, setReviewDialog] = useState<{
    readonly run: string
    readonly mode: 'review' | 'answer'
    readonly candidates: readonly ReviewCandidate[]
    readonly selected: string | null
    readonly answer: string | null
    readonly pending: boolean
    readonly error: string | null
  }>({ mode, run: role.run ?? '', candidates: [], selected: null, answer: mode === 'review' && role.outcomes.length === 1 ? role.outcomes[0]! : null, pending: mode === 'review', error: null })
  const mergeAnswer = mode === 'review' && reviewDialog.answer === 'merged'
  const selected = reviewDialog.candidates.find(one => one.id === reviewDialog.selected)
  const attemptLabel = (card: number): string => {
    const execution = role.run ? snapshot.flowExecutions.get(role.run) : undefined
    const cards = execution?.rounds.find(one => one.cards.includes(card))?.cards ?? reviewDialog.candidates.map(one => one.card).sort((a, b) => a - b)
    const index = cards.indexOf(card)
    return `Attempt ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index] ?? index + 1}`
  }
  useEffect(() => {
    if (!mergeAnswer || !root) return
    let live = true
    void store.transport.request('git/refs', { root }).then(next => {
      if (live) { setRefs(next); setGitError(next?.branch ? null : 'Choose a destination branch in Changes before merging.') }
    }).catch(() => { if (live) setGitError('The merge destination could not be read. Check Changes and reopen this question.') })
    return () => { live = false }
  }, [mergeAnswer, root, store])
  useEffect(() => {
    if (mode !== 'review' || !role.run) return
    let live = true
    void store.flowReviewCandidates(role.run, intent.id).then(candidates => {
      if (live) setReviewDialog(was => ({ ...was, candidates, pending: false }))
    }).catch((error: unknown) => {
      if (live) setReviewDialog(was => ({ ...was, pending: false, error: error instanceof Error && error.message ? error.message : 'The host could not load review candidates.' }))
    })
    return () => { live = false }
  }, [store, role.run, intent.id, mode])
  const confirmReview = async (): Promise<void> => {
    if (saving.current || !reviewDialog.answer || (reviewDialog.mode === 'review' && !reviewDialog.selected) || isRecord(store.getSnapshot().goals.get(room))) return
    if (mergeAnswer && !refs?.branch) return
    saving.current = true
    setReviewDialog({ ...reviewDialog, pending: true, error: null })
    try {
      if (reviewDialog.mode === 'answer') await store.teamIntent(room, intent.id, 'done', undefined, reviewDialog.answer)
      else if (mergeAnswer) await store.decideFlowReview(reviewDialog.run, intent.id, reviewDialog.selected!, reviewDialog.answer, refs!.branch!)
      else await store.decideFlowReview(reviewDialog.run, intent.id, reviewDialog.selected!, reviewDialog.answer)
      onClose()
    } catch (error) {
      setReviewDialog({
        ...reviewDialog,
        pending: false,
        error: error instanceof Error && error.message ? error.message : 'The host did not record this review.',
      })
      throw error
    } finally {
      saving.current = false
    }
  }

  if (gitDialog === 'merge' && root && refs && selected) return <MergeDialog
    root={root} refs={refs} fixedRef={selected.at} expectedBranch={refs.branch ?? undefined}
    beforeMerge={async () => {
      if (isRecord(store.getSnapshot().goals.get(room))) throw new Error(RECORD_REASON)
      // Refresh candidates before Git is allowed to change the destination.
      const candidates = await store.flowReviewCandidates(reviewDialog.run, intent.id)
      if (!candidates.some(one => one.card === selected.card && one.at === selected.at)) throw new Error('This step or its attempt changed. Reopen the question before merging.')
    }}
    onMerged={async outcome => {
      if (!outcome.merged || outcome.merged.branch !== refs.branch) throw new Error('The merge destination could not be confirmed. Check Changes before recording the answer.')
      await confirmReview()
    }}
    onDone={() => setGitDialog(null)}
  />
  if (gitDialog === 'diff' && root && refs?.headSha && selected) return <DiffRangeDialog root={root} from={refs.headSha} to={selected.at} onDone={() => setGitDialog(null)} />

  const disabled = (reviewDialog.mode === 'review' && !selected) || !reviewDialog.answer || reviewDialog.pending || record || (mergeAnswer && (!root || !refs?.branch || Boolean(gitError)))
  return (
      <Dialog
        title={intent.title}
        description={reviewDialog.mode === 'review' ? 'Choose the attempt this step answers for.' : 'Choose the answer for this step.'}
        flush
        onClose={onClose}
        footer={(
          <>
            <Button variant="default" disabled={disabled} title={record ? RECORD_REASON : undefined} onClick={() => mergeAnswer ? setGitDialog('merge') : void confirmReview().catch(() => {})}>
              {reviewDialog.pending ? 'Saving…' : mergeAnswer ? selected ? `Merge ${attemptLabel(selected.card)} into ${refs?.branch ?? '…'}…` : 'Choose an attempt' : 'Record answer'}
            </Button>
            {mergeAnswer && <Button variant="quiet" disabled={disabled} onClick={() => void confirmReview().catch(() => {})}>I merged it</Button>}
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
          </>
        )}
      >
        {/* A Run that ends wraps its Team, even under a person who has an attempt chosen: the answer would be added
            to a record (#1317). */}
        {record && <Note>{RECORD_REASON}</Note>}
        {reviewDialog.error && <Note tone="bad">{reviewDialog.error}</Note>}
        {mergeAnswer && <Note>{gitError ?? (!root ? 'The merge destination is unavailable.' : !refs ? 'Reading the merge destination…' : `The answer is saved only after the picked commit is verified on ${refs.branch}.`)}</Note>}
        {reviewDialog.mode === 'review' && (reviewDialog.pending && reviewDialog.candidates.length === 0
          ? <Note>Loading attempts…</Note>
          : reviewDialog.candidates.length === 0
            ? <Note>No attempts are available to pick yet.</Note>
            : (
              <Rows role="radiogroup" aria-label="Attempts">
                {reviewDialog.candidates.map((candidate) => {
                  const attempt = snapshot.teams.get(room)?.intents.find((one) => one.id === candidate.card)
                  const candidateHolder = candidate.holder ?? (attempt?.claim
                    ? snapshot.teams.get(room)?.nicknames?.[sessionKey(attempt.claim.runtime, attempt.claim.sessionId)] ??
                      snapshot.sessions.get(sessionKey(attempt.claim.runtime, attempt.claim.sessionId as SessionId))?.title ??
                      snapshot.runtimes.find((one) => one.id === attempt.claim?.runtime)?.presentation.name ??
                      'Unknown holder'
                    : 'No holder')
                  const evidenceIds = new Set(candidate.evidence)
                  const checkFacts = (snapshot.boardEvidence.get(room)?.cards.flatMap((one) => one.facts) ?? [])
                    .filter((view) => evidenceIds.has(view.record.id) && view.record.fact.kind === 'check')
                  return (
                    <RowChoice
                      key={candidate.id}
                      title={(
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{attemptLabel(candidate.card)} · {candidateHolder}</span>
                          {checkFacts.map((view) => {
                            if (view.record.fact.kind !== 'check') return null
                            const result = view.record.fact.timedOut ? 'Timed out' : view.record.fact.exit === 0 ? 'Pass' : 'Fail'
                            return <Chip key={view.record.id} tone={result === 'Pass' ? 'success' : 'danger'}>{`${view.record.fact.name}: ${result}`}</Chip>
                          })}
                        </span>
                      )}
                      desc={<span title={candidate.at}>{shortSha(candidate.at)} · {candidate.branch ?? 'detached'}</span>}
                      truncateDesc
                      selected={reviewDialog.selected === candidate.id}
                      disabled={reviewDialog.pending}
                      onClick={() => setReviewDialog({ ...reviewDialog, selected: candidate.id, error: null })}
                    />
                  )
                })}
              </Rows>
            ))}
        {mergeAnswer && selected && root && refs?.headSha && <Button variant="quiet" disabled={reviewDialog.pending} onClick={() => setGitDialog('diff')}>Show diff</Button>}
        {(reviewDialog.mode === 'answer' || role.outcomes.length > 1) && (
          <Rows role="radiogroup" aria-label="Answer">
            {role.outcomes.map((outcome) => (
              <RowChoice
                key={outcome}
                title={outcome}
                selected={reviewDialog.answer === outcome}
                onClick={() => setReviewDialog({ ...reviewDialog, answer: outcome, error: null })}
              />
            ))}
          </Rows>
        )}
      </Dialog>
  )
}
