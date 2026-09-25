import { useEffect, useState } from 'react'

import type { CeilingLevel, SeatRecord } from '@harnessdesk/protocol'

import { KeyValue, KeyValueRow } from '../design'
import { ceilingWords, originWords, passedWords, seatCeilingWords } from '../lib/agents'
import { shortSha } from '../lib/evidence'
import { shortPath } from '../lib/paths'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import { GroupLine, PanelEmpty } from './Panel'
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
    <section aria-label="Seat record">
      <GroupLine left="Seat record" right={seat.restored ? 'From a backup' : seat.closed ? 'Closed' : 'Open'} />
      <KeyValue>
        <KeyValueRow label="Agent">
          {seat.agent
            ? `${seat.agent.name} · ${originWords(seat.agent.origin, project)}`
            : `No Agent — a flow's ${seat.role ?? 'role'} seat`}
        </KeyValueRow>
        <KeyValueRow label="Runs on">{seat.seatLabel}</KeyValueRow>
        {seat.passedOver.length > 0 && (
          <KeyValueRow label="Passed over">{seat.passedOver.map(passedWords).join('; ')}</KeyValueRow>
        )}
        <KeyValueRow label="Told it may">{orderWords(seat.standing)}</KeyValueRow>
        {seat.ceiling && <KeyValueRow label="Ceiling">{seatCeilingWords(seat.ceiling)}</KeyValueRow>}
        <KeyValueRow label="Checkout">
          {seat.checkout.head
            ? `${seat.checkout.branch ?? 'a detached HEAD'} at ${shortSha(seat.checkout.head)}`
            : 'no commit yet'}
        </KeyValueRow>
        <KeyValueRow label="Folder" kind="path">{shortPath(seat.checkout.cwd, snapshot.home)}</KeyValueRow>
        {room && <KeyValueRow label="Board">{seat.role ? `${room} · as ${seat.role}` : room}</KeyValueRow>}
        <KeyValueRow label="Opened">{new Date(seat.openedAt).toLocaleString()}</KeyValueRow>
        {seat.closed && (
          <KeyValueRow label="Closed">{`${closedWords(seat.closed.why)}, ${new Date(seat.closed.at).toLocaleString()}`}</KeyValueRow>
        )}
        {seat.restored && (
          <KeyValueRow label="Restored">{`From a backup, ${new Date(seat.restored.at).toLocaleString()}. This desk did not keep this seat, so it says nothing about what this conversation is here.`}</KeyValueRow>
        )}
      </KeyValue>
      <SeatAttachments seat={seat.id} historical={seat.closed !== null || seat.restored !== null} />
    </section>
  )
}
