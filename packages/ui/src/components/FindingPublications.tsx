import { useEffect, useState } from 'react'

import type { FindingPublicationItem, FindingPublicationsView } from '@harnessdesk/protocol'

import { Banner, Button, Chip, CodeText, ConfirmDialog, Dialog, EmptyState, Note, Row, Rows, SectionHead, Text, Textarea } from '../design'
import { useStore } from '../state/context'

/**
 * A run's closed-round postings that need a person: each one paused before
 * it was sent, started and never confirmed, or uncertain — with the desk's
 * own reason — and the rounds kept on the desk that could be posted now.
 * "Post again" reads the pull request back before anything is sent; "Skip"
 * asks why and leaves that on the Goal's receipt; posting earlier rounds
 * shows exactly what would go before it goes. Loaded explicitly, never in
 * render, and read again whenever the run's own view moves (`stamp`).
 */

const STATE_WORDS: Readonly<Record<FindingPublicationItem['state'], string>> = {
  prepared: 'Paused',
  started: 'Unconfirmed',
  uncertain: 'Uncertain',
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export const FindingPublications = ({ goal, run, stamp }: { readonly goal: string; readonly run: string; readonly stamp: string }) => {
  const store = useStore()
  const [view, setView] = useState<FindingPublicationsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [acted, setActed] = useState(false)
  const [skipping, setSkipping] = useState<FindingPublicationItem | null>(null)
  const [why, setWhy] = useState('')
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    let live = true
    store.readFindingPublications(goal, run).then(
      (next) => { if (live) setView(next) },
      (failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)) },
    )
    return () => { live = false }
  }, [store, goal, run, stamp])

  const act = async (what: string, action: Parameters<typeof store.publishFinding>[0]['action']): Promise<boolean> => {
    if (pending) return false
    setPending(what)
    setError(null)
    try {
      setView(await store.publishFinding({ goal, run, action }))
      setActed(true)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      // What the refusal left behind — a posting now uncertain, say — is read again.
      store.readFindingPublications(goal, run).then(setView, () => {})
      return false
    } finally {
      setPending(null)
    }
  }

  if (!view) return error ? <Banner tone="danger" title="These postings could not be read">{error}</Banner> : null
  const nothing = view.items.length === 0 && view.backfill === null
  if (nothing && !acted && !error) return null

  return (
    <section aria-label="Posting to the pull request" className="flex flex-col gap-2">
      <SectionHead name="Posting to the pull request" />
      {error && <Banner tone="danger" title="This posting could not be changed">{error}</Banner>}
      {nothing && <EmptyState variant="inline" title="Nothing here needs you." />}
      {view.items.length > 0 && (
        <Rows>
          {view.items.map((item) => (
            <Row
              key={item.key}
              title={item.finding ? <CodeText>{item.finding}</CodeText> : `Review summary, round ${item.round}`}
              desc={item.reason ?? undefined}
              wrapDesc
              control={
                <span className="flex items-center gap-2">
                  <Chip tone={item.state === 'prepared' ? 'warning' : 'danger'}>{STATE_WORDS[item.state]}</Chip>
                  <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void act(item.key, { kind: 'post-again', key: item.key })}>
                    {pending === item.key ? 'Working…' : 'Post again'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => { setWhy(''); setSkipping(item) }}>
                    Skip…
                  </Button>
                </span>
              }
            />
          ))}
        </Rows>
      )}
      {view.backfill && (
        <Note>
          <span className="flex items-center justify-between gap-3">
            <span>{`${plural(view.backfill.rounds.length, 'closed round was', 'closed rounds were')} kept on the desk before pull request #${view.backfill.pr} was bound.`}</span>
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => setPreviewing(true)}>Post earlier rounds…</Button>
          </span>
        </Note>
      )}
      {skipping && (
        <Dialog
          title="Skip this posting"
          onClose={() => setSkipping(null)}
          footer={
            <>
              <Button
                variant="default"
                disabled={pending !== null || why.trim() === ''}
                onClick={() => void act(skipping.key, { kind: 'skip', key: skipping.key, reason: why.trim() }).then((done) => { if (done) setSkipping(null) })}
              >
                {pending === skipping.key ? 'Working…' : 'Skip it'}
              </Button>
              <Button variant="secondary" onClick={() => setSkipping(null)}>Keep it</Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Text as="p" role="prose">
              It is not posted, and the Goal’s receipt says so with your reason. If it reached the pull request after all, where it landed is recorded instead.
            </Text>
            <Textarea aria-label="Reason" value={why} onChange={(event) => setWhy(event.target.value)} placeholder="Say why it is not posted." />
          </div>
        </Dialog>
      )}
      {previewing && view.backfill && (
        <ConfirmDialog
          title="Post earlier rounds"
          tone="default"
          confirmLabel={`Post to #${view.backfill.pr}`}
          busy={pending === 'backfill'}
          onCancel={() => setPreviewing(false)}
          onConfirm={() => {
            const stampNow = view.backfill!.stamp
            void act('backfill', { kind: 'backfill', stamp: stampNow }).then(() => setPreviewing(false))
          }}
        >
          <div className="flex flex-col gap-1">
            {view.backfill.rounds.map((one) => (
              <Text key={one.round} as="p" role="prose">
                {`Round ${one.round}: ${plural(one.findings, 'finding', 'findings')} and ${plural(one.reviews, 'review', 'reviews')}`}
              </Text>
            ))}
            <Text as="p" role="meta">Each comment names the Agent that made its claim and the revision it read. One reviewed at a revision the pull request has moved past waits for you.</Text>
          </div>
        </ConfirmDialog>
      )}
    </section>
  )
}
