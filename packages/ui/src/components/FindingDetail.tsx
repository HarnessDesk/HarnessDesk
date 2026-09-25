import { useEffect, useState } from 'react'

import type { FindingDetailPage, FindingOrigin, FindingRecord, FindingRunView, FindingView } from '@harnessdesk/protocol'

import { Banner, Button, Chip, CodeText, Dialog, Fieldset, KeyValue, KeyValueRow, Note, Text, Textarea } from '../design'
import { openExternal } from '../lib/desktop'
import { blockingWords, postWords } from '../lib/findings'
import { useStore } from '../state/context'
import { Markdown } from './Markdown'
import { SeatRecordView } from './SeatRecordBlock'

/**
 * One finding's full history: the historical raise first — title, category,
 * weight, where it was raised and, if any, the changed line it anchors to —
 * then every later event in the order the ledger recorded them, then where it
 * was posted. Loaded explicitly (`readFinding`) rather than during render,
 * and never sends a message or touches an embargo: this is a read.
 */

const CATEGORY_WORDS: Readonly<Record<string, string>> = { ordinary: 'Ordinary', regression: 'Regression', security: 'Security' }

/** Who did this, in the reader's own words — never a raw Seat id standing in for a name. */
const actorWords = (record: FindingRecord, origin: FindingOrigin): string => {
  const event = record.finding.event
  if (record.seat === null) return event.kind === 'verdict' && event.by === 'person' ? 'A person' : 'The host'
  return record.seat === origin.seat ? 'The raising Agent' : 'A later reviewing Agent'
}

const eventSentence = (record: FindingRecord, origin: FindingOrigin): string => {
  const who = actorWords(record, origin)
  const event = record.finding.event
  switch (event.kind) {
    case 'repair':
      return `${who} claimed a repair, at revision ${record.fact.at.slice(0, 12)}`
    case 'verdict':
      return event.state === 'open'
        ? `${who} recorded this as still open`
        : event.state === 'repaired'
          ? `${who} confirmed the repair`
          : `${who} confirmed it withdrawn`
    case 'carry':
      return `Carried from ${event.from} into ${event.to}`
    case 'post':
      return `Posted as a ${postWords(event.location)}`
    default:
      return ''
  }
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly page: FindingDetailPage }

export const FindingDetail = ({
  goal,
  finding,
  onClose,
  decide,
  verdictAfterRun = false,
}: {
  readonly goal: string
  readonly finding: string
  readonly onClose: () => void
  /** The run a person may decide this finding against, as they last read it; absent where no decision is offered. */
  readonly decide?: FindingRunView
  /**
   * Whether a person's verdict may still be recorded against `decide` once
   * that run itself has stopped or settled — true while its Goal is open,
   * since a finding outlives the run that raised it (#890). The host refuses
   * once the Goal is closed, whatever this says.
   */
  readonly verdictAfterRun?: boolean
}) => {
  const store = useStore()
  const [read, setRead] = useState<Read>({ kind: 'loading' })
  const [more, setMore] = useState(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let live = true
    setRead({ kind: 'loading' })
    store.readFinding(goal, finding).then(
      (page) => { if (live) setRead({ kind: 'ready', page }) },
      (error: unknown) => { if (live) setRead({ kind: 'error', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { live = false }
  }, [store, goal, finding, generation])

  const loadMore = async (): Promise<void> => {
    if (read.kind !== 'ready' || !read.page.next || more) return
    setMore(true)
    try {
      const next = await store.readFinding(goal, finding, read.page.next)
      setRead((was) => was.kind === 'ready'
        ? { kind: 'ready', page: { ...next, records: [...was.page.records, ...next.records] } }
        : was)
    } catch (error) {
      setRead({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setMore(false)
    }
  }

  const title = read.kind === 'ready' ? (read.page.finding.title.trim() || read.page.finding.id) : 'Finding'

  return (
    <Dialog title={title} onClose={onClose} size="lg" tall>
      {read.kind === 'loading' && <Text role="muted">Reading this finding…</Text>}
      {read.kind === 'error' && <Banner tone="danger" title="This finding could not be read">{read.message}</Banner>}
      {read.kind === 'ready' && (() => {
        const { finding: view, records, seat, problem } = read.page
        const later = records.filter((record) => record.finding.event.kind !== 'raise')
        /* The dialog's own stack spaces these; each later part of the history
           is one of its named groups, the way a form's are. */
        return (
          <>
            {problem && <Banner tone="warning" title="This history cannot be shown as complete">{problem}</Banner>}
            <KeyValue>
              <KeyValueRow label="Id"><CodeText>{view.id}</CodeText></KeyValueRow>
              <KeyValueRow label="Category">{CATEGORY_WORDS[view.category] ?? view.category}</KeyValueRow>
              <KeyValueRow label="Weight"><Chip tone={view.blocking ? 'warning' : 'neutral'}>{blockingWords(view)}</Chip></KeyValueRow>
              <KeyValueRow label="Raised">{`Round ${view.origin.round}, at ${view.origin.at.slice(0, 12)}`}</KeyValueRow>
              {view.restored && <KeyValueRow label="History">From a backup — history here, not live clearance.</KeyValueRow>}
              {view.anchor && (
                <KeyValueRow label="Location" kind="path">{`${view.anchor.path}:${view.anchor.line}`}</KeyValueRow>
              )}
            </KeyValue>
            <Markdown text={view.body} />
            {/* Only once there is a later event, or more of them to read: a named
                group with nothing under it reads as a history that failed to load. */}
            {(later.length > 0 || read.page.next) && (
              <Fieldset legend="History">
                {later.map((record) => (
                  <div key={record.id} className="flex flex-col gap-1">
                    <Text role="meta">{eventSentence(record, view.origin)}</Text>
                    {(record.finding.event.kind === 'repair' || record.finding.event.kind === 'verdict') && record.finding.event.note && (
                      <Markdown text={record.finding.event.note} />
                    )}
                  </div>
                ))}
                {read.page.next && (
                  <Button variant="ghost" size="sm" className="justify-self-start" disabled={more} onClick={() => void loadMore()}>
                    {more ? 'Loading…' : 'Show more history'}
                  </Button>
                )}
              </Fieldset>
            )}
            <Fieldset legend="Where it was posted">
              {view.posted.length === 0 ? (
                <Text role="muted">Not published yet</Text>
              ) : (
                view.posted.map((post) => (
                  post.url.startsWith('https://') ? (
                    <Button key={post.operation} variant="link" size="inline" className="justify-self-start" onClick={() => openExternal(post.url)}>
                      {postWords(post)}
                    </Button>
                  ) : (
                    <Text key={post.operation} role="muted">{`${postWords(post)} (its address could not be verified)`}</Text>
                  )
                ))
              )}
            </Fieldset>
            <Fieldset legend="Raised by">
              {seat ? <SeatRecordView seat={seat} /> : <Text role="muted">This Seat is unavailable.</Text>}
            </Fieldset>
            {decide && (
              <PersonVerdict goal={goal} view={view} run={decide} afterRun={verdictAfterRun} onDecided={() => setGeneration((one) => one + 1)} />
            )}
          </>
        )
      })()}
    </Dialog>
  )
}

/**
 * A person's own verdict on a finding (`adjudicate`): the same lifecycle
 * event a raising Agent's later review records, by a person, with a reason.
 * Offered only on an unresolved finding; a repair is accepted or rejected
 * only once one has been claimed. Bound to the run view the person read, so
 * a run that moved on refuses it rather than applying it to something else.
 */
const PersonVerdict = ({ goal, view, run, afterRun, onDecided }: {
  readonly goal: string
  readonly view: FindingView
  readonly run: FindingRunView
  readonly afterRun: boolean
  readonly onDecided: () => void
}) => {
  const store = useStore()
  const [why, setWhy] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (view.lifecycle.confirmed || view.restored || view.problem !== null) return null
  const refusal = (afterRun ? null : run.undecidable) ??
    (view.origin.run !== run.run && view.origin.goal === goal ? 'This finding belongs to an earlier run on this Goal.' : null)
  const choices: readonly { readonly label: string; readonly state: 'open' | 'repaired' | 'withdrawn' }[] = view.lifecycle.state === 'repaired'
    ? [{ label: 'Accept the repair', state: 'repaired' }, { label: 'Reject the repair', state: 'open' }, { label: 'Withdraw it', state: 'withdrawn' }]
    : [{ label: 'Withdraw it', state: 'withdrawn' }]
  const choose = async (label: string, state: 'open' | 'repaired' | 'withdrawn'): Promise<void> => {
    if (pending || refusal) return
    const reason = why.trim()
    if (reason === '') { setError('Say why.'); return }
    setPending(label)
    setError(null)
    try {
      await store.decideFindingRun({
        goal, run: run.run, round: run.round, stamp: run.stamp,
        action: { kind: 'adjudicate', finding: view.id, state }, reason,
      })
      setWhy('')
      onDecided()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(null)
    }
  }
  return (
    <Fieldset legend="Decide it yourself">
      {refusal && <Note>{refusal}</Note>}
      <Textarea aria-label="Why" value={why} disabled={refusal !== null || pending !== null} onChange={(event) => setWhy(event.target.value)} placeholder="Say why you are deciding this rather than a reviewer." />
      {error && <Banner tone="danger" title="This decision could not be recorded">{error}</Banner>}
      <span className="flex gap-2">
        {choices.map((choice) => (
          <Button
            key={choice.label}
            size="sm"
            variant={choice.state === 'withdrawn' ? 'outline' : 'default'}
            disabled={refusal !== null || pending !== null}
            title={refusal ?? undefined}
            onClick={() => void choose(choice.label, choice.state)}
          >
            {pending === choice.label ? 'Working…' : choice.label}
          </Button>
        ))}
      </span>
    </Fieldset>
  )
}
