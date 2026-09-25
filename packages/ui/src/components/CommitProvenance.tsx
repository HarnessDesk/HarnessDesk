import { useEffect, useMemo, useState } from 'react'

import type { CommitProvenance as Attribution, ProvenanceSeat } from '@harnessdesk/protocol'

import { Button, Chip, Note, Row, Rows, SectionHead } from '../design'
import { provenanceRootFor, provenanceWords } from '../lib/provenance'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { EvidenceChips } from './EvidenceChips'
import { ProvenanceDialog } from './ProvenanceDialog'

export const CommitSeatLabels = ({ value }: { readonly value: Attribution | null }) => {
  const seat = value?.seats[0]
  return seat ? <span className="min-w-0 truncate" data-provenance-label="" title={seat.seatLabel}>{seat.agentName ?? 'Seat'}{value.seats.length > 1 ? ` +${value.seats.length - 1} Seats` : ''}</span> : null
}

export const useProvenanceBatch = (root: string | null, shas: readonly string[], scope: string) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const project = root ? provenanceRootFor(root, snapshot.workspaces) : null
  const revision = project ? snapshot.provenanceRevision.get(project) ?? 0 : 0
  const key = JSON.stringify([root, project, scope, revision, snapshot.status, shas])
  const [read, setRead] = useState<{ key: string; values: ReadonlyMap<string, Attribution>; error: boolean }>({ key: '', values: new Map(), error: false })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!root || snapshot.status !== 'open' || shas.length === 0) return
    let live = true
    const pages = Array.from({ length: Math.ceil(shas.length / 400) }, (_, index) => shas.slice(index * 400, index * 400 + 400))
    void Promise.all(pages.map((page) => store.readProvenance(root, page))).then(
      (pages) => { if (live) setRead({ key, values: new Map(pages.flatMap((page) => (page?.commits ?? []).map((commit) => [commit.sha, commit] as const))), error: false }) },
      () => { if (live) setRead({ key, values: new Map(), error: true }) },
    )
    return () => { live = false }
  }, [store, root, key, retry])
  return { values: read.key === key ? read.values : new Map<string, Attribution>(), error: read.key === key && read.error, retry: () => setRetry((value) => value + 1) }
}

export const CommitProvenance = ({ root, sha, value: supplied }: { readonly root: string; readonly sha: string; readonly value?: Attribution | null }) => {
  const read = useProvenanceBatch(root, useMemo(() => [sha], [sha]), 'detail')
  const value = supplied ?? read.values.get(sha)
  const failed = supplied === undefined && read.error
  const [seat, setSeat] = useState<string | null>(null)
  const snapshot = useSnapshot()
  return <section aria-label="Commit provenance"><SectionHead name="Provenance" />
    {failed ? <><Note>Provenance could not be read.</Note><Button variant="secondary" onClick={read.retry}>Retry provenance</Button></>
      : !value ? <Note>Reading provenance…</Note>
      : <><Chip tone="neutral" label={provenanceWords(value)} /><Note>{value.explanation}</Note>
        <Rows>{value.seats.map((item: ProvenanceSeat) => {
          const runtime = snapshot.runtimes.find((entry) => entry.id === item.runtime)
          return <Row key={item.id} title={item.agentName ?? 'Seat'} desc={item.seatLabel} mark={runtime ? <RuntimeMark runtime={runtime} size={14} /> : <RuntimeMark runtime={{ id: item.runtime, presentation: { name: item.runtime } }} size={14} />} control={<Button variant="secondary" onClick={() => setSeat(item.id)}>Seat record</Button>} />
        })}</Rows>
        {value.cards.map((card) => {
          const evidence = snapshot.boardEvidence.get(card.board)?.cards.find((entry) => entry.card === card.id)
          /* A card this desk no longer holds is history, and history is over. */
          const intent = snapshot.teams.get(card.board)?.intents.find((entry) => entry.id === card.id)
          return evidence ? <EvidenceChips key={`${card.board}:${card.id}`} id={card.id} title="Provenance evidence" card={evidence} finished={intent ? intent.state === 'done' : true} /> : <Note key={`${card.board}:${card.id}`}>The desk no longer has evidence for this historical card.</Note>
        })}
      </>}
    {seat && <ProvenanceDialog root={root} seat={seat} onClose={() => setSeat(null)} />}
  </section>
}
