import type { FindingRunView } from '@harnessdesk/protocol'

import { Banner, Chip, SummaryItem, SummaryList, Text } from '../design'

/**
 * A run's findings, as a person reads its progress. Every word here is a
 * durable fact this desk observed — a completed card, a recorded post — never
 * a token stream ending or a hope about what a forge will do next.
 */

import { runPublication } from '../lib/review-publication'

export interface FindingRoundStatusProps {
  readonly view: FindingRunView
  readonly publicationOn?: boolean
}

export const FindingRoundStatus = ({ view, publicationOn = true }: FindingRoundStatusProps) => {
  const publication = runPublication(view, publicationOn)
  const blindWords = view.embargoed && view.reviewersTotal !== null
    ? `${view.reviewersFinished} of ${view.reviewersTotal} reviewers finished — published when the round closes`
    : null
  return (
    <div className="flex flex-col gap-3">
      {/* One card of facts about the round: each value beside its key. The
          blocking count is read with the open count it is part of, not on a
          row of its own at the far edge. */}
      <SummaryList aria-label="This round">
        <SummaryItem label="Round">{`${view.finished} of ${view.total}`}</SummaryItem>
        <SummaryItem label="Open findings" numeric>
          {view.open}
          {view.blocking > 0 && <Text role="muted" tone="warning">{` · ${view.blocking} blocking`}</Text>}
        </SummaryItem>
        {publication && <SummaryItem label="Publication"><Chip tone={publication.tone}>{publication.label}</Chip></SummaryItem>}
      </SummaryList>
      {blindWords && (
        <Banner tone="neutral" title="This round is still blind">
          {blindWords}
        </Banner>
      )}
      {view.reason && (
        <Banner tone={view.embargoed ? 'neutral' : 'warning'} title="Waiting for a person">
          <Text as="p" role="prose">{view.reason}</Text>
        </Banner>
      )}
      {view.override && (
        <Banner tone="warning" title="Merged anyway">
          <Text as="p" role="prose">{view.override.reason}</Text>
        </Banner>
      )}
    </div>
  )
}
