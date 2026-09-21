import type { GoalReceipt as GoalReceiptRecord } from '@harnessdesk/protocol'

import { Chip, CodeText, Note, Row, Rows, SectionHead, Text } from '../design'
import { InsightCost } from './InsightCost'

export interface GoalReceiptProps {
  readonly receipt: GoalReceiptRecord | Omit<GoalReceiptRecord, 'id' | 'wrappedAt'>
  readonly root: string
  /** Supplied by the receipt owner after an explicit Insight read; omitted by previews and isolated renderers. */
  readonly insight?: Omit<import('./InsightCost').InsightCostProps, 'onSeat' | 'onSession' | 'onMessage'>
}

export const GoalReceipt = ({ receipt, insight }: GoalReceiptProps) => {
  return (
  <div>
    <Chip tone="neutral">As recorded when wrapped</Chip>
    <SectionHead name="What finished" />
    <Text as="p" role="value">{receipt.summary}</Text>
    <SectionHead name="Work" />
    <Rows>
      {receipt.cards.map((card) => (
        <Row
          key={card.id}
          title={`#${card.id} · ${card.resolution === 'finished' ? 'Finished' : 'Dropped'}`}
          {...(card.reason ? { desc: card.reason } : {})}
        />
      ))}
    </Rows>
    {receipt.answers.length > 0 ? (
      <>
        <SectionHead name="Seat answers" />
        <Rows>
          {receipt.answers.map((answer, index) => (
            <Row
              key={`${answer.seat}:${index}`}
              title={<CodeText>{answer.text || 'No answer was recorded.'}</CodeText>}
              desc={answer.partial ? `Partial${answer.stopReason ? ` · ${answer.stopReason}` : ''}` : answer.stopReason ?? undefined}
              control={<Chip tone={answer.partial ? 'warning' : 'neutral'}>{answer.seat}</Chip>}
            />
          ))}
        </Rows>
      </>
    ) : null}
    {receipt.evidence.length > 0 ? (
      <>
        <SectionHead name="Evidence" />
        <Rows>{receipt.evidence.map((id) => <Row key={id} title={id} desc="Recorded evidence ID" />)}</Rows>
      </>
    ) : null}
    {receipt.revisions.length > 0 ? (
      <>
        <SectionHead name="Revisions" />
        <Rows>{receipt.revisions.map((revision) => <Row key={revision.cwd} title={revision.cwd} desc={revision.head ?? 'Revision was not recorded'} />)}</Rows>
      </>
    ) : null}
    {receipt.lanes.length > 0 ? (
      <>
        <SectionHead name="Retained lanes" />
        <Rows>{receipt.lanes.map((lane) => <Row key={lane.lane} title={lane.cwd} desc={lane.dirty === true ? 'Dirty checkout retained' : lane.dirty === false ? 'Clean checkout retained' : 'Checkout state was not recorded'} />)}</Rows>
      </>
    ) : null}
    {receipt.citations.length > 0 ? (
      <>
        <SectionHead name="Citations" />
        <Rows>{receipt.citations.map((citation) => <Row key={`${citation.receipt}:${citation.path}`} title={citation.path} desc={`Receipt ${citation.receipt} at ${citation.at}`} />)}</Rows>
      </>
    ) : null}
    {receipt.gaps.length > 0 ? (
      <>
        <SectionHead name="Gaps" />
        {receipt.gaps.map((gap) => <Note key={gap} tone="warn">{gap}</Note>)}
      </>
    ) : null}
    {'id' in receipt && insight ? <InsightCost {...insight} /> : null}
  </div>
  )
}
