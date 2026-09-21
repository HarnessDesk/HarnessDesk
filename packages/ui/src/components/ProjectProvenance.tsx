import { useCallback, useEffect, useRef, useState } from 'react'

import { Button, Chip, Note, Row, Rows, SectionHead, Switch } from '../design'
import { captureForRoot, captureWords } from '../lib/provenance'
import { useSnapshot, useStore } from '../state/context'

/** The saved host value stays visible until a reversible preference write settles. */
export const ProjectProvenance = ({ root }: { readonly root: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const activeRoot = useRef(root)
  const knownNonGit = snapshot.workspaces.some((workspace) => workspace.path === root && workspace.git === null && workspace.repo === null)
  const refresh = useCallback(() => {
    if (knownNonGit || snapshot.status !== 'open') return
    setLoading(true); setFailed(false)
    void store.loadCaptureHealth(root).then(
      () => { if (activeRoot.current === root) setLoading(false) },
      () => { if (activeRoot.current === root) { setLoading(false); setFailed(true) } },
    )
  }, [store, root, snapshot.status, knownNonGit])
  useEffect(() => {
    activeRoot.current = root
    setBusy(false)
    setProblem(null)
    if (knownNonGit) { setLoading(false); setFailed(false); return }
    refresh()
  }, [root, knownNonGit, refresh])
  const health = knownNonGit ? undefined : captureForRoot(root, snapshot.captureHealth, snapshot.workspaces)
  const change = async (enabled?: boolean) => {
    if (!health || busy || (enabled === undefined && !health.enabled)) return
    setBusy(true); setProblem(null)
    try { enabled === undefined ? await store.retryCapture(root) : await store.setCapture(root, enabled) }
    catch { if (activeRoot.current === root) setProblem(enabled === undefined ? 'Capture could not be retried.' : 'The capture preference could not be saved.') }
    finally { if (activeRoot.current === root) setBusy(false) }
  }
  return <section aria-label="Provenance"><SectionHead name="Provenance" />
    {snapshot.status !== 'open' ? <Note>Capture status is unavailable while disconnected.</Note>
      : knownNonGit ? <><Rows><Row title="Capture on this machine" control={<Switch checked={false} disabled aria-label="Capture provenance on this machine" />} /></Rows><Note>This folder has no Git history to capture.</Note></>
      : loading ? <Note>Reading capture status…</Note>
      : failed ? <><Note>Capture status could not be read.</Note><Button variant="secondary" onClick={refresh}>Retry status</Button></>
      : !health ? <><Rows><Row title="Capture on this machine" control={<Switch checked={false} disabled aria-label="Capture provenance on this machine" />} /></Rows><Note>{knownNonGit ? 'This folder has no Git history to capture.' : 'Capture is unavailable for this folder.'}</Note></>
      : <><Rows>
        <Row title="Capture on this machine" desc="Keep links from changes to the Seats and conversations that produced them." control={<Switch checked={health.enabled} disabled={busy} aria-label="Capture provenance on this machine" onCheckedChange={(enabled) => void change(enabled)} />} />
        <Row title={captureWords(health).label} desc={`${health.reason} ${health.nextStep}`} control={<Chip tone={captureWords(health).tone} label={captureWords(health).label} />} />
      </Rows>
      {health.pending > 0 && <Note>{`${health.pending} commits are waiting for capture.`}</Note>}
      {health.gaps > 0 && <Note>Some historical transitions are unavailable. Retrying cannot recreate history Git no longer has.</Note>}
      {problem && <Note>{problem}</Note>}
      <Button variant="secondary" disabled={busy || !health.enabled} onClick={() => void change()}>Retry capture</Button>
      {!health.enabled && <Note>Turn capture on before retrying.</Note>}</>}
  </section>
}
