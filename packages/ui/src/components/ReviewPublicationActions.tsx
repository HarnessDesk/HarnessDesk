import { useState } from 'react'
import type { FindingPublicationsView } from '@harnessdesk/protocol'
import { Banner, Button, Text } from '../design'
import { useFindingPublicationActions } from '../lib/use-finding-publication-actions'
import { sanitizeText } from '../lib/sanitize'
import { FindingBackfillDialog } from './FindingBackfillDialog'

export interface ReviewActionsTarget { readonly goal: string; readonly run: string; readonly stamp: string }

/** Mounted only on a Run with a store-backed door; standalone inspector examples remain plain data. */
export const ReviewPublicationActions = ({ goal, run, stamp, round, review, alreadyShownReason }: ReviewActionsTarget & { round: number; review: string; alreadyShownReason?: string | null }) => {
  const { view, error, pending, act } = useFindingPublicationActions(goal, run, stamp)
  const [preview, setPreview] = useState<FindingPublicationsView['backfill']>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const item = view?.items.find(one => one.round === round && one.finding === null) ?? view?.items.find(one => one.round === round)
  const backfill = view?.backfill?.rounds.some(one => one.round === round) ? view.backfill : null
  const pr = item?.pr ?? backfill?.pr
  const reason = item?.reason ?? view?.backfillRefusal ?? null
  const refusal = error ?? (view ? reason ?? 'This round has nothing waiting to post.' : 'Reading publication details…')
  const copy = async () => {
    setCopyError(null)
    try { await navigator.clipboard.writeText(sanitizeText(review)); setCopied(true) }
    catch { setCopyError('The review could not be copied. Select its text and copy it.') }
  }
  return <div className="flex min-w-0 flex-col gap-2" data-slot="review-publication-actions">
    {item?.finding && <Text as="div" role="meta">Posting finding {sanitizeText(item.finding)}</Text>}
    {reason && sanitizeText(reason) !== sanitizeText(alreadyShownReason ?? '') && <Text as="div" role="prose" className="whitespace-pre-wrap break-words">{sanitizeText(reason)}</Text>}
    {error && <Banner tone="warning" title="The review could not be posted">{sanitizeText(error)}</Banner>}
    {copyError && <Text as="div" role="meta">{copyError}</Text>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => void copy()}>Copy review</Button>
      <Button variant="outline" size="sm" disabled={pending !== null || (!item && !backfill)}
        title={pr ? `Posts this ${item?.finding ? 'finding' : 'review'} to pull request #${pr} as you. Nothing else changes.` : sanitizeText(refusal)}
        onClick={() => { if (item) void act(item.key, { kind: 'post-again', key: item.key }); else if (backfill) setPreview(backfill) }}>
        {pending !== null ? 'Working…' : 'Post to pull request'}
      </Button>
      {copied && <Text role="meta">Copied</Text>}
    </div>
    {preview && <FindingBackfillDialog backfill={preview} busy={pending === 'backfill'} onCancel={() => setPreview(null)}
      onConfirm={() => { void act('backfill', { kind: 'backfill', stamp: preview.stamp }).then(() => setPreview(null)) }} />}
  </div>
}
