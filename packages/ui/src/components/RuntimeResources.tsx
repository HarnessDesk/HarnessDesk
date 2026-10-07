import { useEffect, useRef, useState } from 'react'
import type { RuntimeId, RuntimeResources as Cost } from '@harnessdesk/protocol'
import { accountKey, accountName, agentKey } from '../lib/accounts'
import { Button, Chip, Note, SectionHead, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../design'
import { useSnapshot, useStore } from '../state/context'

export const RuntimeResources = ({ runtime }: { readonly runtime?: RuntimeId }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [costs, setCosts] = useState<readonly Cost[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const epoch = useRef(0)
  const request = useRef(0)
  const [busy, setBusy] = useState<RuntimeId | null>(null)
  useEffect(() => {
    ++epoch.current
    setBusy(null)
    let live = true
    let timer: ReturnType<typeof setTimeout>
    setCosts([])
    setProblem(null)
    const read = async (): Promise<void> => {
      const ownRequest = ++request.current
      try {
        const next = await store.runtimeResources()
        if (live && ownRequest === request.current) { setCosts(next); setProblem(null) }
      } catch (error) { if (live && ownRequest === request.current) setProblem(error instanceof Error ? error.message : String(error)) }
      if (live) timer = setTimeout(() => { void read() }, 5_000)
    }
    void read()
    return () => { live = false; epoch.current++; clearTimeout(timer) }
  }, [store, runtime])
  const recycle = async (id: RuntimeId): Promise<void> => {
    if (busy !== null) return
    const ownEpoch = epoch.current
    request.current++
    setBusy(id)
    try {
      const result = await store.recycleRuntime(id)
      if (ownEpoch !== epoch.current) return
      const ownRequest = ++request.current
      const next = await store.runtimeResources()
      if (ownEpoch !== epoch.current) return
      if (ownRequest === request.current) setCosts(next)
      setProblem(result.recycled ? null : 'The runtime is in use; let its work finish before recycling.')
    } catch (error) { if (ownEpoch === epoch.current) setProblem(error instanceof Error ? error.message : String(error)) }
    finally { if (ownEpoch === epoch.current) setBusy(null) }
  }
  const nameFor = (id: RuntimeId): string => {
    const info = snapshot.runtimes.find(one => one.id === id)
    if (!info) return 'Runtime'
    const siblings = snapshot.runtimes.filter(one => agentKey(one) === agentKey(info))
    const account = snapshot.accountsByRuntime[id]?.accounts[0]
    return siblings.length > 1 && account ? `${info.presentation.name} · ${accountName(account, snapshot.accountPrefs[accountKey(id, account)], info.presentation.name)}` : info.presentation.name
  }
  const shown = costs.filter((cost) => runtime === undefined ? cost.processes !== 0 : cost.runtime === runtime)
  const rows = shown.filter(cost => cost.processes !== 0)
  const reasons = [...new Set(rows.map(cost => cost.reason).filter((reason): reason is string => reason !== null))]
  if (shown.length === 0 && !problem) return null
  return <>
    <SectionHead name="Process cost" />
    {shown.some(cost => cost.processes === 0) && <Chip tone="neutral">Not running</Chip>}
    {rows.length > 0 && <Table density="compact" inset="row">
      <TableHeader><TableRow><TableHead>Runtime</TableHead><TableHead numeric>Processes</TableHead><TableHead numeric>Resident memory</TableHead><TableHead align="end">Idle runtime</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((cost) => <TableRow key={cost.runtime}>
        <TableHead variant="row" className="whitespace-normal break-words">{nameFor(cost.runtime)}</TableHead>
        <TableCell numeric>{cost.processes === null ? 'Unavailable' : `${cost.processes} ${cost.processes === 1 ? 'process' : 'processes'}`}</TableCell>
        <TableCell numeric>{cost.residentBytes === null ? 'Unavailable' : `${Math.round(cost.residentBytes / 1024 / 1024)} MiB`}</TableCell>
        <TableCell align="end"><Button size="sm" variant="outline" title={cost.reason ?? undefined} aria-label={`Recycle idle ${nameFor(cost.runtime)}`} disabled={!cost.canRecycle || busy !== null} onClick={() => { void recycle(cost.runtime) }}>Recycle</Button></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    {reasons.map(reason => <Note key={reason}>{reason}</Note>)}
    <Note>Includes child processes. Resident memory can count shared pages more than once. Updates every five seconds.</Note>
    {problem && <Note tone="bad">{problem}</Note>}
  </>
}
