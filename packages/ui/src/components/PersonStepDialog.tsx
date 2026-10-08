import { useEffect, useState } from 'react'
import { sessionKey, type FlowStep, type Intent, type ReviewCandidate, type SessionId } from '@harnessdesk/protocol'
import { Button, Chip, Dialog, Note, RowChoice, Rows } from '../design'
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
  const [reviewDialog, setReviewDialog] = useState<{
    readonly run: string
    readonly mode: 'review' | 'answer'
    readonly candidates: readonly ReviewCandidate[]
    readonly selected: string | null
    readonly answer: string | null
    readonly pending: boolean
    readonly error: string | null
  }>({ mode, run: role.run ?? '', candidates: [], selected: null, answer: mode === 'review' && role.outcomes.length === 1 ? role.outcomes[0]! : null, pending: mode === 'review', error: null })
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
    if (!reviewDialog.answer || (reviewDialog.mode === 'review' && !reviewDialog.selected) || isRecord(store.getSnapshot().goals.get(room))) return
    setReviewDialog({ ...reviewDialog, pending: true, error: null })
    try {
      if (reviewDialog.mode === 'answer') await store.teamIntent(room, intent.id, 'done', undefined, reviewDialog.answer)
      else await store.decideFlowReview(reviewDialog.run, intent.id, reviewDialog.selected!, reviewDialog.answer)
      onClose()
    } catch (error) {
      setReviewDialog({
        ...reviewDialog,
        pending: false,
        error: error instanceof Error && error.message ? error.message : 'The host did not record this review.',
      })
    }
  }

  return (
      <Dialog
        title={intent.title}
        subhead={reviewDialog.mode === 'review' ? 'Choose the attempt this step answers for.' : 'Choose the answer for this step.'}
        flush
        onClose={onClose}
        footer={(
          <>
            <Button variant="default" disabled={(reviewDialog.mode === 'review' && !reviewDialog.selected) || !reviewDialog.answer || reviewDialog.pending || record} title={record ? RECORD_REASON : undefined} onClick={() => void confirmReview()}>
              {reviewDialog.pending ? 'Saving…' : 'Record answer'}
            </Button>
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
          </>
        )}
      >
        {/* A Run that ends wraps its Team, even under a person who has an attempt chosen: the answer would be added
            to a record (#1317). */}
        {record && <Note>{RECORD_REASON}</Note>}
        {reviewDialog.error && <Note tone="bad">{reviewDialog.error}</Note>}
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
                          <span className="truncate">{attempt?.title ?? `Card #${candidate.card}`} · {candidateHolder}</span>
                          {checkFacts.map((view) => {
                            if (view.record.fact.kind !== 'check') return null
                            const result = view.record.fact.timedOut ? 'Timed out' : view.record.fact.exit === 0 ? 'Pass' : 'Fail'
                            return <Chip key={view.record.id} tone={result === 'Pass' ? 'success' : 'danger'}>{`${view.record.fact.name}: ${result}`}</Chip>
                          })}
                        </span>
                      )}
                      desc={`${candidate.branch ?? 'detached'} · ${shortSha(candidate.at)}`}
                      truncateDesc
                      selected={reviewDialog.selected === candidate.id}
                      onClick={() => setReviewDialog({ ...reviewDialog, selected: candidate.id, error: null })}
                    />
                  )
                })}
              </Rows>
            ))}
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
