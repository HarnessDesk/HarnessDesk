import { useState } from 'react'

import type { GoalCitation, GoalReceipt as GoalReceiptRecord } from '@harnessdesk/protocol'

import { Chip, CodeText, Dialog, Note, Row, RowButton, Rows, SectionHead, Text } from '../design'
import { shortSha } from '../lib/evidence'
import { InsightCost } from './InsightCost'
import { MemoryCitation } from './MemoryCitation'

export interface GoalReceiptProps {
  readonly receipt: GoalReceiptRecord | Omit<GoalReceiptRecord, 'id' | 'wrappedAt'>
  readonly root: string
  /** Supplied by the receipt owner after an explicit Insight read; omitted by previews and isolated renderers. */
  readonly insight?: Omit<import('./InsightCost').InsightCostProps, 'onSeat' | 'onSession' | 'onMessage'>
}

/**
 * A Seat's name, in the receipt's own words — `agent.name · seatLabel` when
 * an Agent held it, its bare `seatLabel` when a flow seated a runtime with
 * none. Null when `members` has nothing for this Seat: an older receipt,
 * wrapped before the field existed; or a restored Seat, which a wrap's
 * `members` excludes the same way it excludes it from `seats` — evidence
 * that Seat produced falls back further, to its own recorded `seatLabel`.
 */
const nameOf = (members: GoalReceiptRecord['members'], seat: string): string | null => {
  const member = members?.find((one) => one.seat === seat)
  if (!member) return null
  return member.agent ? `${member.agent} · ${member.seatLabel}` : member.seatLabel
}

export const GoalReceipt = ({ receipt, insight }: GoalReceiptProps) => {
  const [opened, setOpened] = useState<GoalCitation | null>(null)
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
              control={<Chip tone={answer.partial ? 'warning' : 'neutral'}>{nameOf(receipt.members, answer.seat) ?? answer.seat}</Chip>}
            />
          ))}
        </Rows>
      </>
    ) : null}
    {receipt.evidence.length > 0 ? (
      <>
        <SectionHead name="Evidence" />
        <Rows>{receipt.evidence.map((id) => {
          const ref = receipt.evidenceSeats?.find((one) => one.id === id)
          // A restored Seat has no entry in `members` — fall back to the
          // label this evidence's own reference carried, from the Seat's
          // own record, before an id with no name behind it at all.
          const name = ref === undefined
            ? null
            : ref.seat === null ? 'Observed by the desk' : nameOf(receipt.members, ref.seat) ?? ref.seatLabel ?? null
          return <Row key={id} title={name ?? id} desc={name ? id : 'Recorded evidence ID'} />
        })}</Rows>
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
        <Rows>
          {receipt.citations.map((citation) => (
            <RowButton
              key={`${citation.receipt}:${citation.path}`}
              title={citation.path}
              desc={`Receipt ${citation.receipt} at ${shortSha(citation.at)}`}
              onClick={() => setOpened(citation)}
            />
          ))}
        </Rows>
      </>
    ) : null}
    {receipt.gaps.length > 0 ? (
      <>
        <SectionHead name="Gaps" />
        {receipt.gaps.map((gap) => <Note key={gap} tone="warn">{gap}</Note>)}
      </>
    ) : null}
    {'id' in receipt && insight ? <InsightCost {...insight} /> : null}
    {opened && (
      <Dialog title={opened.path} size="lg" onClose={() => setOpened(null)}>
        <MemoryCitation root={opened.project} goal={null} citation={opened} />
      </Dialog>
    )}
  </div>
  )
}
