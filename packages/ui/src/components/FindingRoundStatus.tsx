import type { FindingRunView } from '@harnessdesk/protocol'

import { Banner, Chip, KeyValue, KeyValueRow, Text } from '../design'

/**
 * A run's findings, as a person reads its progress. Every word here is a
 * durable fact this desk observed — a completed card, a recorded post — never
 * a token stream ending or a hope about what a forge will do next.
 */

const PUBLICATION_WORDS: Readonly<Record<FindingRunView['publication'], string>> = {
  local: 'Kept on the desk',
  pending: 'Posting…',
  posted: 'Published',
  partial: 'Partially published',
  uncertain: 'Publication uncertain',
}

const PUBLICATION_TONE: Readonly<Record<FindingRunView['publication'], 'neutral' | 'warning' | 'success' | 'danger'>> = {
  local: 'neutral', pending: 'neutral', posted: 'success', partial: 'warning', uncertain: 'danger',
}

export interface FindingRoundStatusProps {
  readonly view: FindingRunView
}

export const FindingRoundStatus = ({ view }: FindingRoundStatusProps) => {
  const blindWords = view.embargoed && view.reviewersTotal !== null
    ? `${view.reviewersFinished} of ${view.reviewersTotal} reviewers finished — published when the round closes`
    : null
  return (
    <div className="flex flex-col gap-3">
      <KeyValue>
        <KeyValueRow label="Round">{`${view.finished} of ${view.total}`}</KeyValueRow>
        <KeyValueRow label="Open findings">{view.open}</KeyValueRow>
        <KeyValueRow label="Blocking">{view.blocking}</KeyValueRow>
        <KeyValueRow label="Publication"><Chip tone={PUBLICATION_TONE[view.publication]}>{PUBLICATION_WORDS[view.publication]}</Chip></KeyValueRow>
      </KeyValue>
      {blindWords && (
        <Banner tone="neutral" title="This round is still blind">
          {blindWords}
        </Banner>
      )}
      {view.reason && (
        <Banner tone={view.embargoed ? 'neutral' : 'warning'} title="Waiting for a person">
          <Text as="p" role="value">{view.reason}</Text>
        </Banner>
      )}
    </div>
  )
}
