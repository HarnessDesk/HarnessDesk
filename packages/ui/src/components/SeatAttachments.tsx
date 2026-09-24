import { useEffect, useState } from 'react'

import type { AttachmentDeclaration, SeatAttachmentsRecord, SeatId } from '@harnessdesk/protocol'

import { Chip, Row, Rows, SectionHead } from '../design'
import { useStore } from '../state/context'
import { GroupLine, PanelEmpty } from './Panel'

/**
 * A Seat's frozen attachment history — what an Agent declared, and what its
 * runtime actually loaded, next to `SeatRecordView`'s own immutable facts.
 *
 * Decision 19 of the phase-12 plan draws the one line this component exists
 * to hold: `loaded`, `not-loaded` and `not recorded` are three different
 * facts, and a Seat with no sidecar is never dressed up as one that
 * deliberately "loaded nothing" — the plain path (an Agent with nothing
 * declared) and an old Seat from before this feature shipped read exactly
 * the same way here, honestly, as "Not recorded". `historical` only ever
 * changes the tense of the status line; a `restored` epoch always wins it,
 * because a backup-imported observation must never read as a live one.
 */
export const SeatAttachments = ({
  seat,
  historical = false,
}: {
  readonly seat: SeatId
  readonly historical?: boolean
}) => {
  const store = useStore()
  const [read, setRead] = useState<
    | { readonly key: SeatId; readonly record: SeatAttachmentsRecord | null }
    | { readonly key: SeatId; readonly problem: string }
    | null
  >(null)

  useEffect(() => {
    let live = true
    setRead(null)
    store.readSeatAttachments(seat).then(
      (record) => { if (live) setRead({ key: seat, record }) },
      (error: unknown) => { if (live) setRead({ key: seat, problem: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { live = false }
  }, [store, seat])

  if (!read || read.key !== seat) return null
  if ('problem' in read) {
    return <PanelEmpty>{`Its attachments could not be read: ${read.problem}`}</PanelEmpty>
  }
  if (!read.record) return <PanelEmpty>Not recorded</PanelEmpty>

  const { record } = read
  const skills = record.declarations.filter((one) => one.kind === 'skill')
  const servers = record.declarations.filter((one) => one.kind === 'mcp')

  const statusOf = (declaration: AttachmentDeclaration): { readonly loaded: boolean; readonly reason: string | null } => {
    const result = declaration.identity
      ? record.results.find((one) => one.identity.kind === declaration.identity!.kind && one.identity.name === declaration.identity!.name)
      : undefined
    const loaded = result?.status === 'loaded'
    return { loaded, reason: loaded ? null : (result?.reason ?? declaration.problem) }
  }

  const declarationRow = (declaration: AttachmentDeclaration) => {
    const { loaded, reason } = statusOf(declaration)
    return (
      <Row
        key={`${declaration.kind}:${declaration.name}`}
        title={declaration.name}
        {...(reason ? { desc: reason } : {})}
        control={<Chip tone={loaded ? 'success' : 'warning'}>{loaded ? 'Loaded' : 'Not loaded'}</Chip>}
      />
    )
  }

  const status = record.restored ? 'Restored' : historical ? `Loaded on ${record.runtime}` : `Currently on ${record.runtime}`

  return (
    <section aria-label="Attachments">
      <GroupLine left="Attachments" right={status} />
      {skills.length === 0 && servers.length === 0 ? (
        <PanelEmpty>Runtime defaults — nothing declared</PanelEmpty>
      ) : (
        <>
          {skills.length > 0 && (
            <>
              <SectionHead name="Skills" />
              <Rows>{skills.map(declarationRow)}</Rows>
            </>
          )}
          {servers.length > 0 && (
            <>
              <SectionHead name="Servers" />
              <Rows>{servers.map(declarationRow)}</Rows>
            </>
          )}
        </>
      )}
    </section>
  )
}
