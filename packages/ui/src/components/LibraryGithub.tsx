import { useEffect, useRef, useState } from 'react'
import type { Library, LibraryIntent, LibrarySourceResult, RuntimeId } from '@harnessdesk/protocol'
import { ActionError, Button, Checkbox, Chip, Dialog, Field, Fieldset, FormStack, Input, Note, Row, Rows, SectionHead, Text, Toolbar } from '../design'
import { useStore } from '../state/context'
import type { LibraryColumn } from './LibraryActions'

/** A fetched revision stays a choice until the ordinary plan is confirmed. */
export const LibraryGithub = ({ library, columns, onClose, onPlan }: {
  library: Library
  columns: readonly LibraryColumn[]
  onClose: () => void
  onPlan: (title: string, intents: readonly LibraryIntent[]) => void
}) => {
  const store = useStore()
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [result, setResult] = useState<LibrarySourceResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [skills, setSkills] = useState<ReadonlySet<string>>(new Set())
  const [agents, setAgents] = useState<ReadonlySet<RuntimeId>>(new Set())
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const edit = () => { generation.current++; setResult(null); setFailed(null); setSkills(new Set()) }
  const find = async () => {
    const current = ++generation.current
    setBusy(true); setFailed(null); setResult(null); setSkills(new Set())
    try {
      const answer = await store.transport.request('library/source/fetch', { url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) })
      if (current !== generation.current) return
      setResult(answer)
      setSkills(new Set(answer.skills.filter(s => s.runnable === 0 && s.binary === 0).map(s => s.dir)))
    } catch (error) {
      if (current === generation.current) setFailed(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }
  const targets = columns.filter(c => library.locations.some(l => l.kind === 'skill' && l.runtime === c.id))
  const picked = result?.skills.filter(s => skills.has(s.dir)) ?? []
  const chosenAgents = targets.filter(c => agents.has(c.id))
  const disabledReason = picked.length === 0 ? 'Choose at least one skill.' : chosenAgents.length === 0 ? 'Choose at least one agent.' : undefined
  const review = () => {
    if (!result || disabledReason) return
    onPlan(picked.length === 1 ? `Install ${picked[0]!.name}` : `Install ${picked.length} skills`, picked.flatMap(skill => chosenAgents.map(agent => ({
      kind: 'installSkill' as const, name: skill.name, sourcePath: skill.sourcePath, targetRuntime: agent.id,
      origin: { url: result.url, ref: result.ref, commit: result.commit, path: skill.dir, bundle: skill.bundle },
    }))))
  }
  return <Dialog title="Add from GitHub" description="Fetches the files and pins the commit. Nothing reaches an agent until you install it." size="xl" onClose={onClose}
    footer={<><Button disabled={!!disabledReason} title={disabledReason} onClick={review}>Review {picked.length} skills…</Button><Button variant="secondary" onClick={onClose}>Cancel</Button></>}>
    <Field label="Repository or folder">{control => <Input {...control} value={url} placeholder="https://github.com/acme-dev/skills" onChange={e => { setUrl(e.target.value); edit() }} />}</Field>
    <Field label="Branch, tag or commit" hint="Pinned to the commit it names now. Leave empty for the default branch.">{control => <Input {...control} value={ref} onChange={e => { setRef(e.target.value); edit() }} />}</Field>
    <Toolbar><Button variant="secondary" disabled={busy || !url.trim()} onClick={() => void find()}>{busy ? 'Finding…' : 'Find skills'}</Button></Toolbar>
    {failed !== null && <ActionError>{failed}</ActionError>}
    {result && <FormStack>
      {result.skills.length > 0 && <>
        <SectionHead level="label" name={`Found ${result.skills.length} skills · ${result.repo} @ ${result.commit.slice(0, 7)}`} />
        <Rows>{result.skills.map(skill => <Row key={skill.dir} title={<Checkbox label={skill.name} checked={skills.has(skill.dir)} onCheckedChange={checked => setSkills(current => { const next = new Set(current); if (checked) next.add(skill.dir); else next.delete(skill.dir); return next })} />}
          desc={skill.dir || result.repo}
          control={<Toolbar><Text role="meta">{skill.files} {skill.files === 1 ? 'file' : 'files'}</Text>{skill.runnable > 0 && <Chip tone="warning" size="sm">{skill.runnable} can run</Chip>}{skill.binary > 0 && <Chip tone="warning" size="sm">{skill.binary} binary</Chip>}</Toolbar>} />)}</Rows>
      </>}
      {result.refused.map(one => <Note key={one.dir}>{one.dir || result.repo} was not fetched: {one.reason}</Note>)}
    </FormStack>}
    <Fieldset legend="Install for"><Toolbar>{targets.map(agent => <Checkbox key={agent.id} label={agent.label} checked={agents.has(agent.id)} onCheckedChange={checked => setAgents(current => { const next = new Set(current); if (checked) next.add(agent.id); else next.delete(agent.id); return next })} />)}</Toolbar></Fieldset>
  </Dialog>
}
