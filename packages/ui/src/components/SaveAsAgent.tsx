import { useState } from 'react'

import { CEILING_LEVELS, type CeilingLevel, type Session } from '@harnessdesk/protocol'

import { Button, Dialog, Field, FormStack, Input, Note, RowChoice, Rows, SectionHead } from '../design'
import { ceilingMeaning, ceilingWords, projectName, seatOf, seatWordsOf } from '../lib/agents'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { BriefIcon } from './Icons'

/**
 * *Save as an Agent…*: this conversation's seat, kept under a name, with what
 * it is for and the most it may do, written to you or to the open project —
 * and then its brief, a skeleton, opened in the editor to be written.
 *
 * Saved to the project, the file names the runtime alone and this Mac keeps
 * the exact seat in `seating.json`, because a committed model name breaks the
 * Agent on every other machine. The choice says so.
 */
export const SaveAsAgentDialog = ({ session, onClose }: { readonly session: Session; readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [ceiling, setCeiling] = useState<CeilingLevel>('read')
  const [to, setTo] = useState<'user' | 'project'>(snapshot.workspace ? 'project' : 'user')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const words = seatWordsOf(session, snapshot.runtimes)
  const runtime = snapshot.runtimes.find((one) => one.id === session.runtime)?.presentation.name ?? String(session.runtime)
  const project = projectName(snapshot.workspace)
  const yours = snapshot.stateDir ? shortPath(`${snapshot.stateDir}/agents`, snapshot.home) : 'your Agents'

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const entry = await store.saveAsAgent({
        name: name.trim(),
        description: description.trim(),
        ceiling,
        seat: seatOf(session),
        to,
      })
      store.openFile(entry.path)
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The Agent was not saved.')
    }
  }

  return (
    <Dialog
      title="Save as an Agent"
      icon={<BriefIcon size={15} />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || name.trim() === ''} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save and open the brief'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <FormStack>
        <Note>{`Its first seat is the one this conversation is on: ${words}.`}</Note>
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              autoFocus
              value={name}
              placeholder="Checkout reviewer"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="What it is for" hint="One line. The roster shows it under the name.">
          {(control) => (
            <Input {...control} value={description} maxLength={120} onChange={(event) => setDescription(event.target.value)} />
          )}
        </Field>
        <SectionHead name="The most it may do" />
        <Rows role="radiogroup" aria-label="The most it may do">
              {CEILING_LEVELS.map((one) => (
            <RowChoice
              key={one}
              title={ceilingWords(one)}
              desc={<span className="whitespace-normal">{ceilingMeaning(one)}</span>}
                  selected={ceiling === one}
                  onClick={() => setCeiling(one)}
            />
          ))}
        </Rows>
        <SectionHead name="Where it is kept" />
        <Rows role="radiogroup" aria-label="Where it is kept">
          {snapshot.workspace && (
            <RowChoice
              title={`For ${project ?? 'this project'}`}
              desc={
                <span className="whitespace-normal">
                  {`Committed with the code, naming ${runtime} alone; this Mac keeps ${words} in seating.json.`}
                </span>
              }
              selected={to === 'project'}
              onClick={() => setTo('project')}
            />
          )}
          <RowChoice
            title="For you"
            desc={<span className="whitespace-normal">{`In ${yours}, on this Mac only.`}</span>}
            selected={to === 'user'}
            onClick={() => setTo('user')}
          />
        </Rows>
        {problem && <Note tone="bad">{problem}</Note>}
      </FormStack>
    </Dialog>
  )
}
