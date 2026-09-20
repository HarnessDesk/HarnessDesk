import { useEffect, useMemo, useState } from 'react'

import type { CommitProvenance as Attribution, ProvenanceSeat } from '@harnessdesk/protocol'

import { Button, Chip, Note, Row, Rows, SectionHead } from '../design'
import { provenanceWords } from '../lib/provenance'
import { useSnapshot, useStore } from '../state/context'
import { ProvenanceDialog } from './ProvenanceDialog'

export const CommitSeatLabels = ({ value }: { readonly value: Attribution | null }) => {
  const seat = value?.seats[0]
  return seat ? <span className="min-w-0 truncate" data-provenance-label="" title={seat.seatLabel}>{seat.agentName ?? 'Seat'}{value.seats.length > 1 ? ` +${value.seats.length - 1} Seats` : ''}</span> : null
}

export const useProvenanceBatch = (root: string | null, shas: readonly string[], scope: string) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const revision = root ? snapshot.provenanceRevision.get(root) ?? 0 : 0
  const key = JSON.stringify([root, scope, revision, snapshot.status, shas])
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
  return <section aria-label="Commit provenance"><SectionHead name="Provenance" />
    {failed ? <><Note>Provenance could not be read.</Note><Button variant="secondary" onClick={read.retry}>Retry provenance</Button></>
      : !value ? <Note>Reading provenance…</Note>
      : <><Chip tone="neutral" label={provenanceWords(value)} /><Note>{value.explanation}</Note>
        <Rows>{value.seats.map((item: ProvenanceSeat) => <Row key={item.id} title={item.agentName ?? 'Seat'} desc={item.seatLabel} control={<Button variant="secondary" onClick={() => setSeat(item.id)}>Seat record</Button>} />)}</Rows>
      </>}
    {seat && <ProvenanceDialog root={root} seat={seat} onClose={() => setSeat(null)} />}
  </section>
}
