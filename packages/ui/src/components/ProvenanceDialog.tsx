import { useEffect, useState } from 'react'

import { runtimeId, sessionId, type ProvenanceSeatDetail } from '@harnessdesk/protocol'

import { Button, Dialog, Note } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { SeatRecordView } from './SeatRecordBlock'

/** A historical Seat is read by immutable Seat id, never by today's session. */
export const ProvenanceDialog = ({ root, seat, onClose }: { readonly root: string; readonly seat: string; readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const key = `${root}:${seat}:${snapshot.status}`
  const [read, setRead] = useState<{ key: string; value?: ProvenanceSeatDetail; failed?: boolean } | null>(null)
  const [opening, setOpening] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  useEffect(() => {
    if (snapshot.status !== 'open') return
    let live = true
    void store.readProvenanceSeat(root, seat).then(
      (value) => { if (live) setRead({ key, value }) },
      () => { if (live) setRead({ key, failed: true }) },
    )
    return () => { live = false }
  }, [store, root, seat, key, snapshot.status])
  const current = read?.key === key ? read : null
  const pointer = current?.value?.session
  const runtime = pointer && snapshot.runtimes.find((entry) => entry.id === pointer.runtime)
  const unavailable = snapshot.status !== 'open' || !pointer || !runtime || current?.value?.unavailable
  const open = async () => {
    if (!pointer || !runtime || unavailable) return
    setOpening(true)
    setOpenFailed(false)
    try {
      await store.openSession(sessionId(pointer.sessionId), { runtime: runtimeId(pointer.runtime) })
      onClose()
    } catch {
      setOpenFailed(true)
    } finally { setOpening(false) }
  }
  return <Dialog title="Seat record" onClose={onClose} footer={<Button variant="default" disabled={!current?.value || Boolean(unavailable) || opening} onClick={() => void open()}>Open conversation</Button>}>
    {snapshot.status !== 'open' ? <Note>The Seat record is unavailable while disconnected.</Note>
      : !current ? <Note>Reading Seat record…</Note>
      : current.failed ? <Note>The Seat record could not be read.</Note>
      : current.value?.seat ? <SeatRecordView seat={current.value.seat} />
      // The specific reason, when the host gave one, said once — never
      // followed by the generic sentence it already answers.
      : current.value?.unavailable ? <Note>{current.value.unavailable}</Note>
      : <Note>The historical Seat record is unavailable.</Note>}
    {current?.value?.seat && <Note>The recorded brief has an identity, but its text is not retained. The Agent may have changed since this Seat was kept.</Note>}
    {openFailed && <Note>The original conversation could not be opened.</Note>}
  </Dialog>
}
