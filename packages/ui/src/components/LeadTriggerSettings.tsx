import { useEffect, useRef, useState } from 'react'
import type { LeadFollowPreferences, LeadSettingsUpdate } from '@harnessdesk/protocol'
import { Row, RowButton, Rows, Section, Switch, Text } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { useDestinationActive } from '../panels/destination-page'

/** Follow preferences are machine settings; declarations remain project files.
 * Reading this list never arms a trigger or saves its declaration. */
export const LeadTriggerSettings = ({ follow = { checks: true, reviews: true }, root, update, onError }: {
  readonly follow?: LeadFollowPreferences
  readonly root: string | null
  readonly update: (value: Omit<LeadSettingsUpdate, 'expectedRevision'>) => Promise<unknown>
  readonly onError: (error: unknown) => void
}) => {
  const store = useStore(), snapshot = useSnapshot(), active = useDestinationActive()
  const [rows, setRows] = useState<{ root: string; path: string; rows: { id: string; summary: string }[] } | null>(null)
  const [problem, setProblem] = useState(false), [pending, setPending] = useState(false), busy = useRef(false)
  const revision = root ? snapshot.triggerRevisions[root] : undefined
  useEffect(() => {
    if (!active || !root) return
    let alive = true
    setProblem(false)
    void (async () => {
      try {
        const view = await store.projectTriggers(root)
        const targets = view.triggers.filter(trigger => trigger.definition && 'lead' in trigger.definition.opens && trigger.definition.opens.lead === true)
        const rows = await Promise.all(targets.map(async trigger => {
          const preview = await store.previewTrigger(root, trigger.id)
          return { id: trigger.id, summary: preview.lead?.summary ?? trigger.id }
        }))
        if (alive) setRows({ root, path: view.path, rows })
      } catch { if (alive) { setRows(null); setProblem(true) } }
    })()
    return () => { alive = false }
  }, [store, active, root, revision])
  const toggle = async (kind: keyof LeadFollowPreferences, checked: boolean) => {
    if (busy.current) return
    busy.current = true; setPending(true)
    try { await update({ follow: { ...follow, [kind]: checked } }) }
    catch (error) { onError(error) }
    finally { busy.current = false; setPending(false) }
  }
  return <Section title="Triggers">
    <Text as="p" role="prose">Follow my pull requests</Text>
    <Rows>{([['checks', 'Checks failed'], ['reviews', 'Review comment']] as const).map(([kind, label]) => <Row key={kind} title={label} control={<Switch aria-label={label} checked={follow[kind]} disabled={pending} onCheckedChange={checked => void toggle(kind, checked)} />} />)}</Rows>
    <Text as="p" role="prose">Open a goal when</Text>
    {active && rows?.root === root && rows.rows.length ? <Rows>{rows.rows.map(row => <RowButton key={row.id} title={row.summary} onClick={() => store.openFile(rows.path)} />)}</Rows>
      : <Text as="p" role="muted">{problem ? 'Project triggers could not be read.' : 'No project triggers open a Lead goal.'}</Text>}
  </Section>
}
