import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Button, Chip, Note, Row, Rows, Section, Switch } from '../design'
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
  const open = snapshot.status === 'open'
  // Two rows and nothing around them: the setting, then how it is going.
  // The state's word is the status row's title, said once — never a title
  // and a chip repeating each other — with the host's reason under it and
  // the one thing to do about it on the row's end.
  const status = (tone: 'success' | 'warning' | 'neutral' | 'danger', label: string, desc: string, action?: ReactNode) => (
    <Row title={<Chip tone={tone} label={label} />} desc={desc} {...(action ? { control: action } : {})} />
  )
  const statusRow = !open
    ? status('neutral', 'Offline', 'Capture status is unavailable while disconnected.')
    : knownNonGit
      ? status('neutral', 'No history', 'This folder has no Git history to capture.')
      : loading
        ? status('neutral', 'Checking', 'Reading capture status…')
        : failed
          ? status('danger', 'Unknown', 'Capture status could not be read.', <Button variant="outline" size="sm" onClick={refresh}>Retry status</Button>)
          : !health
            ? status('neutral', 'Unavailable', 'Capture is unavailable for this folder.')
            : status(
                captureWords(health).tone,
                captureWords(health).label,
                [
                  health.reason,
                  health.enabled ? health.nextStep : 'Turn capture on before retrying.',
                  health.pending > 0 ? `${health.pending} commits are waiting for capture.` : '',
                  health.gaps > 0 ? 'Some historical transitions are unavailable. Retrying cannot recreate history Git no longer has.' : '',
                ].filter(Boolean).join(' '),
                <Button variant="outline" size="sm" disabled={busy || !health.enabled} onClick={() => void change()}>Retry capture</Button>,
              )
  // The switch is only offered once the state it would change is known.
  const settled = open && !loading && !failed
  return (
    <Section title="Provenance">
      <Rows>
        <Row
          title="Capture on this machine"
          desc="Links each change to the Seat and conversation that produced it."
          {...(settled
            ? { control: <Switch checked={health?.enabled ?? false} disabled={!health || busy} aria-label="Capture provenance on this machine" onCheckedChange={(enabled) => void change(enabled)} /> }
            : {})}
        />
        {statusRow}
      </Rows>
      {problem ? <Note>{problem}</Note> : null}
    </Section>
  )
}
