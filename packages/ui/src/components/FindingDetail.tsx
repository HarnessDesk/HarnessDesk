import { useEffect, useState } from 'react'

import type { FindingDetailPage, FindingOrigin, FindingRecord } from '@harnessdesk/protocol'

import { Banner, Button, Chip, CodeText, Dialog, KeyValue, KeyValueRow, Text } from '../design'
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
}: {
  readonly goal: string
  readonly finding: string
  readonly onClose: () => void
}) => {
  const store = useStore()
  const [read, setRead] = useState<Read>({ kind: 'loading' })
  const [more, setMore] = useState(false)

  useEffect(() => {
    let live = true
    setRead({ kind: 'loading' })
    store.readFinding(goal, finding).then(
      (page) => { if (live) setRead({ kind: 'ready', page }) },
      (error: unknown) => { if (live) setRead({ kind: 'error', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { live = false }
  }, [store, goal, finding])

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
        return (
          <div className="flex flex-col gap-4">
            {problem && <Banner tone="warning" title="This history cannot be shown as complete">{problem}</Banner>}
            <KeyValue>
              <KeyValueRow label="Id"><CodeText>{view.id}</CodeText></KeyValueRow>
              <KeyValueRow label="Category">{CATEGORY_WORDS[view.category] ?? view.category}</KeyValueRow>
              <KeyValueRow label="Weight"><Chip tone={view.blocking ? 'warning' : 'neutral'}>{blockingWords(view)}</Chip></KeyValueRow>
              <KeyValueRow label="Raised">{`Round ${view.origin.round}, at ${view.origin.at.slice(0, 12)}`}</KeyValueRow>
              {view.restored && <KeyValueRow label="History">From a backup — history here, not live clearance.</KeyValueRow>}
              {view.anchor && (
                <KeyValueRow label="Location"><CodeText>{`${view.anchor.path}:${view.anchor.line}`}</CodeText></KeyValueRow>
              )}
            </KeyValue>
            <Markdown text={view.body} />
            <section aria-label="History" className="flex flex-col gap-3 border-t border-(--hd-border) pt-3">
              {records.filter((record) => record.finding.event.kind !== 'raise').map((record) => (
                <div key={record.id} className="flex flex-col gap-1">
                  <Text role="meta">{eventSentence(record, view.origin)}</Text>
                  {(record.finding.event.kind === 'repair' || record.finding.event.kind === 'verdict') && record.finding.event.note && (
                    <Markdown text={record.finding.event.note} />
                  )}
                </div>
              ))}
              {read.page.next && (
                <Button variant="ghost" size="sm" disabled={more} onClick={() => void loadMore()}>
                  {more ? 'Loading…' : 'Show more history'}
                </Button>
              )}
            </section>
            <section aria-label="Where it was posted" className="flex flex-col gap-1 border-t border-(--hd-border) pt-3">
              {view.posted.length === 0 ? (
                <Text role="muted">Not published yet</Text>
              ) : (
                view.posted.map((post) => (
                  post.url.startsWith('https://') ? (
                    <Button key={post.operation} variant="link" size="inline" className="self-start" onClick={() => openExternal(post.url)}>
                      {postWords(post)}
                    </Button>
                  ) : (
                    <Text key={post.operation} role="muted">{`${postWords(post)} (its address could not be verified)`}</Text>
                  )
                ))
              )}
            </section>
            <section aria-label="Raised by" className="border-t border-(--hd-border) pt-3">
              {seat ? <SeatRecordView seat={seat} /> : <Text role="muted">This Seat is unavailable.</Text>}
            </section>
          </div>
        )
      })()}
    </Dialog>
  )
}
