import { useState } from 'react'

import type { AgentEntry, CeilingLevel } from '@harnessdesk/protocol'

import { agentName, bySection, ceilingWords } from '../lib/agents'
import { Banner, Button, Card, Dialog, Field, FormStack, Input, NativeSelect, Note, RowChoice, Rows, Textarea } from '../design'
import { useSnapshot, useStore } from '../state/context'

/**
 * New Agent: from a shipped one, or a complete blank draft — neither needs a
 * conversation already seated somewhere, which is what phase 2's
 * `agent/create` (a real seat, so a Seat can point at it) would otherwise
 * force. A template goes through the existing `agent/copy` (`customizeAgent`)
 * so its supporting files come with it, in one request; a blank draft is
 * built here as plain `AGENT.md` bytes and previewed and saved through the
 * same authoring transaction `AgentFields` uses — writing nothing until
 * *Create*.
 */
export interface AgentNewProps {
  readonly root?: string
  readonly from?: { readonly id: string; readonly origin: AgentEntry['origin'] }
  readonly onCreated: (entry: AgentEntry) => void
  readonly onClose: () => void
}

const CEILINGS: readonly CeilingLevel[] = ['read', 'edit', 'publish', 'merge']
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** A folder name from a typed display name — the id a person can still change before Create; never after. */
const slugify = (name: string): string => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug || 'agent'
}

/** A brand new `AGENT.md`, built from what a blank draft asked for. `preview()` is still the judge: a mistake here is shown as an issue, never written. */
const buildSource = (name: string, description: string, ceiling: CeilingLevel, brief: string): string => {
  const front = [`name: ${JSON.stringify(name.trim())}`]
  if (description.trim()) front.push(`description: ${JSON.stringify(description.trim())}`)
  front.push(`ceiling: ${ceiling}`)
  return `---\n${front.join('\n')}\n---\n\n${brief.trim()}\n`
}

export const AgentNew = ({ root, from, onCreated, onClose }: AgentNewProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const builtins = bySection(snapshot.agents ?? []).builtin
  const [mode, setMode] = useState<'template' | 'blank'>(from || builtins.length > 0 ? 'template' : 'blank')
  const [templateId, setTemplateId] = useState(from?.id ?? builtins[0]?.id ?? '')
  const [to, setTo] = useState<'user' | 'project'>(root ? 'project' : 'user')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [ceiling, setCeiling] = useState<CeilingLevel>('read')
  const [brief, setBrief] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const effectiveId = idTouched ? id : slugify(name)
  const validId = AGENT_ID.test(effectiveId)
  const canCreate = name.trim().length > 0 && brief.trim().length > 0 && validId

  const copyTemplate = async (): Promise<void> => {
    if (busy || !templateId) return
    setBusy(true)
    setProblem(null)
    try {
      onCreated(await store.customizeAgent(templateId, 'builtin', to))
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not copy it.')
    }
  }

  const createBlank = async (): Promise<void> => {
    if (busy || !canCreate) return
    setBusy(true)
    setProblem(null)
    try {
      const source = buildSource(name, description, ceiling, brief)
      const preview = await store.previewAuthoringSave({
        target: { kind: 'agent', origin: to, id: effectiveId, ...(to === 'project' && root ? { root } : {}) },
        expected: null,
        source,
      })
      if (!preview.token) {
        setBusy(false)
        setProblem(preview.issues[0]?.text ?? 'This Agent could not be saved.')
        return
      }
      const result = await store.applyAuthoringSave(preview.token)
      if (result.state !== 'applied') {
        setBusy(false)
        setProblem(result.message)
        return
      }
      const [entry] = await Promise.all([
        store.readAgent(effectiveId, to === 'project' ? root : undefined),
        store.loadAgents(),
      ])
      if (entry) {
        onCreated(entry)
      } else {
        setBusy(false)
        setProblem('Saved, but it could not be read back. Open Agents to find it.')
      }
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not save it.')
    }
  }

  return (
    <Dialog
      title="New Agent"
      size="lg"
      onClose={onClose}
      footer={
        <>
          {mode === 'template' ? (
            <Button variant="default" disabled={busy || !templateId} onClick={() => void copyTemplate()}>
              {busy ? 'Copying…' : 'Copy and open'}
            </Button>
          ) : (
            <Button variant="default" disabled={busy || !canCreate} onClick={() => void createBlank()}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {builtins.length > 0 && !from && (
        <Rows role="radiogroup" aria-label="Start from">
          <RowChoice
            title="From a template"
            desc="Copy a shipped Agent's files, then edit its name and brief on its own page."
            selected={mode === 'template'}
            disabled={busy}
            onClick={() => setMode('template')}
          />
          <RowChoice
            title="A blank Agent"
            desc="Write its name, ceiling and brief from scratch."
            selected={mode === 'blank'}
            disabled={busy}
            onClick={() => setMode('blank')}
          />
        </Rows>
      )}

      {mode === 'template' && (
        <Field label="Template">
          {(control) => (
            <NativeSelect
              {...control}
              value={templateId}
              disabled={busy || Boolean(from)}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              {builtins.map((entry) => (
                <option key={entry.id} value={entry.id}>{agentName(entry)}</option>
              ))}
            </NativeSelect>
          )}
        </Field>
      )}

      {mode === 'blank' && (
        <Card>
          <FormStack>
            <Field label="Name">
              {(control) => <Input {...control} autoFocus disabled={busy} value={name} onChange={(event) => setName(event.target.value)} />}
            </Field>
            <Field label="Description">
              {(control) => <Input {...control} disabled={busy} value={description} onChange={(event) => setDescription(event.target.value)} />}
            </Field>
            <Field label="Folder name" hint="Lowercase letters, digits and -. Chosen now — renaming the Agent later does not move this.">
              {(control) => (
                <Input
                  {...control}
                  disabled={busy}
                  value={effectiveId}
                  onChange={(event) => {
                    setIdTouched(true)
                    setId(event.target.value)
                  }}
                />
              )}
            </Field>
            <Field label="Ceiling">
              {(control) => (
                <NativeSelect {...control} value={ceiling} disabled={busy} onChange={(event) => setCeiling(event.target.value as CeilingLevel)}>
                  {CEILINGS.map((level) => <option key={level} value={level}>{ceilingWords(level)}</option>)}
                </NativeSelect>
              )}
            </Field>
            <Field label="Brief">
              {(control) => <Textarea {...control} rows={6} disabled={busy} value={brief} onChange={(event) => setBrief(event.target.value)} />}
            </Field>
          </FormStack>
        </Card>
      )}

      {mode === 'blank' && (
        <Rows role="radiogroup" aria-label="Where it is saved">
          <RowChoice title="For you" desc="On this Mac only." selected={to === 'user'} disabled={busy} onClick={() => setTo('user')} />
          {root && (
            <RowChoice
              title="For this project"
              desc="Committed with the code, for everyone who clones it."
              selected={to === 'project'}
              disabled={busy}
              onClick={() => setTo('project')}
            />
          )}
        </Rows>
      )}

      {mode === 'template' && root && (
        <Rows role="radiogroup" aria-label="Where the copy goes">
          <RowChoice title="For you" desc="On this Mac only." selected={to === 'user'} disabled={busy} onClick={() => setTo('user')} />
          <RowChoice
            title="For this project"
            desc="Committed with the code, for everyone who clones it."
            selected={to === 'project'}
            disabled={busy}
            onClick={() => setTo('project')}
          />
        </Rows>
      )}

      {mode === 'blank' && (
        <Note>New blank Agents begin with a read ceiling and no preferred seat — they may need Add a seat, or On this Mac, before they can run.</Note>
      )}

      {problem && <Banner tone="danger" title="This could not be saved">{problem}</Banner>}
    </Dialog>
  )
}
