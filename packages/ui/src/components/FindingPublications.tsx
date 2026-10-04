import { useState } from 'react'

import type { FindingPublicationItem } from '@harnessdesk/protocol'

import { Banner, Button, Chip, CodeText, Dialog, EmptyState, Note, Row, Rows, SectionHead, Text, Textarea } from '../design'
import { useFindingPublicationActions } from '../lib/use-finding-publication-actions'
import { FindingBackfillDialog } from './FindingBackfillDialog'

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
  const { view, error, pending, acted, act } = useFindingPublicationActions(goal, run, stamp)
  const [skipping, setSkipping] = useState<FindingPublicationItem | null>(null)
  const [why, setWhy] = useState('')
  const [previewing, setPreviewing] = useState(false)

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
        <FindingBackfillDialog backfill={view.backfill} busy={pending === 'backfill'} onCancel={() => setPreviewing(false)}
          onConfirm={() => { void act('backfill', { kind: 'backfill', stamp: view.backfill!.stamp }).then(() => setPreviewing(false)) }} />
      )}
    </section>
  )
}
