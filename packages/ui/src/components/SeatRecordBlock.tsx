import { useEffect, useState } from 'react'

import type { CeilingLevel, SeatRecord } from '@harnessdesk/protocol'

import { KeyValue, KeyValueRow, SummaryList, SummaryItem, ToolSection, ToolFold, ToolProse, Chip, InlineParts } from '../design'
import { ceilingWords, originWords, passedWords, seatCeilingWords } from '../lib/agents'
import { ceilingTitle } from '../lib/ceilings'
import { shortSha } from '../lib/evidence'
import { shortPath } from '../lib/paths'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { PanelEmpty } from './Panel'
import { SeatAttachments } from './SeatAttachments'

export const SeatRecordBlock = () => {
  const store = useStore()
  const session = useActiveSession()
  const runtime = session?.runtime ?? null
  const id = session?.id ?? null
  const key = JSON.stringify([runtime, id])
  const [read, setRead] = useState<
    | { readonly key: string; readonly seat: SeatRecord | null }
    | { readonly key: string; readonly problem: string }
    | null
  >(null)

  useEffect(() => {
    if (!runtime || !id) return
    let live = true
    const asked = JSON.stringify([runtime, id])
    store.seatRecord(runtime, id).then(
      (seat) => {
        if (live) setRead({ key: asked, seat })
      },
      (error: unknown) => {
        if (live) setRead({ key: asked, problem: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [store, runtime, id])

  if (!read || read.key !== key) return null
  if ('problem' in read) {
    return <PanelEmpty>{`Its Seat record could not be read: ${read.problem}`}</PanelEmpty>
  }
  return read.seat ? <SeatRecordView seat={read.seat} /> : null
}

const closedWords = (why: string): string =>
  why === 'deleted' ? 'Its conversation was deleted' : `Closed — ${why}`

const LEVEL_WORDS: Readonly<Record<CeilingLevel, string>> = {
  read: 'Read',
  edit: 'Edit',
  publish: 'Publish',
  merge: 'Merge',
}

export const orderWords = (standing: SeatRecord['standing']): string =>
  standing.kind === 'permission'
    ? ceilingWords(standing.permission)
    : standing.kind === 'ceiling'
      ? `${LEVEL_WORDS[standing.level]} · its ceiling`
      : 'Unknown · its ceiling was not kept'

export const SeatRecordView = ({ seat }: { readonly seat: SeatRecord }) => {
  const snapshot = useSnapshot()
  const project = seat.checkout.project.split('/').filter(Boolean).at(-1) ?? null
  const room = seat.board ? (snapshot.teams.get(seat.board)?.name ?? 'a room this desk no longer has') : null
  return (
    <ToolSection label="Seat record" value={seat.restored ? 'From a backup' : seat.closed ? 'Closed' : 'Open'}>
      <SummaryList surface="panel" aria-label="Seat summary">
        {seat.agent && <SummaryItem label="Agent" kind="name">{seat.agent.name}</SummaryItem>}
        <SummaryItem label="Runs on" kind="name">{seat.seatLabel}</SummaryItem>
        {seat.role && <SummaryItem label="Role" kind="name">{seat.role}</SummaryItem>}
        <SummaryItem label="Ceiling">{seat.ceiling ? <InlineParts>
          <Chip size="sm" tone="neutral" title={ceilingTitle(seat.ceiling)}>{ceilingWords(seat.ceiling.level)}</Chip>
          <Chip size="sm" tone="neutral" title={ceilingTitle(seat.ceiling)}>{seat.ceiling.hold === 'held' ? 'Held' : 'Asked, not held'}</Chip>
        </InlineParts> : orderWords(seat.standing)}</SummaryItem>
      </SummaryList>
      <ToolFold label="Details">
      <KeyValue variant="panel" inset="row">
        <KeyValueRow label="Agent" kind="name">
          {seat.agent
            ? `${seat.agent.name} · ${originWords(seat.agent.origin, project)}`
            : `No Agent — a flow's ${seat.role ?? 'role'} seat`}
        </KeyValueRow>
        <KeyValueRow label="Runs on" kind="name">{seat.seatLabel}</KeyValueRow>
        {seat.passedOver.length > 0 && (
          <KeyValueRow label="Passed over">{seat.passedOver.length}</KeyValueRow>
        )}
        <KeyValueRow label="Told it may">{orderWords(seat.standing)}</KeyValueRow>
        {seat.ceiling && <KeyValueRow label="Ceiling">{seatCeilingWords(seat.ceiling)}</KeyValueRow>}
        <KeyValueRow label="Checkout" kind="name">
          {seat.checkout.head
            ? `${seat.checkout.branch ?? 'a detached HEAD'} at ${shortSha(seat.checkout.head)}`
            : 'no commit yet'}
        </KeyValueRow>
        <KeyValueRow label="Folder" kind="path">{shortPath(seat.checkout.cwd, snapshot.home)}</KeyValueRow>
        {room && <KeyValueRow label="Board" kind="name">{seat.role ? `${room} · as ${seat.role}` : room}</KeyValueRow>}
        <KeyValueRow label="Opened">{new Date(seat.openedAt).toLocaleString()}</KeyValueRow>
        {seat.closed && (
          <KeyValueRow label="Closed">{new Date(seat.closed.at).toLocaleString()}</KeyValueRow>
        )}
        {seat.restored && (
          <KeyValueRow label="Restored">{new Date(seat.restored.at).toLocaleString()}</KeyValueRow>
        )}
      </KeyValue>
      {seat.passedOver.map((passed, index) => <ToolProse key={index}>{passedWords(passed)}</ToolProse>)}
      {seat.closed && <ToolProse>{closedWords(seat.closed.why)}</ToolProse>}
      {seat.restored && <ToolProse>This desk did not keep this seat, so it says nothing about what this conversation is here.</ToolProse>}
      <SeatAttachments seat={seat.id} historical={seat.closed !== null || seat.restored !== null} />
      </ToolFold>
    </ToolSection>
  )
}
