import type { AgentEntry, FlowPolicyRole } from '@harnessdesk/protocol'

import { Card, Checkbox, Field, FormStack, Input, NativeSelect, Row, Rows, SectionHead, Textarea } from '../design'
import { agentName } from '../lib/agents'
import {
  CEILINGS, defaultRole, exitLines, parseExitLines, parseWordLines, ROLE_KIND_WORDS, ROLE_KINDS, wordLines,
} from '../lib/shapes'

/**
 * One step, edited by its own kind's controls — Agent, Check or Person, named
 * in plain words. Every choice here is a field on the role object; nothing
 * previews or writes until the editor above renders the whole document.
 *
 * Selection lists are resolved Agents (`agents`), never a role-name
 * heuristic: an Agent step's "uses" is a checkbox per real Agent this
 * project or this Mac already has, exactly as `agent/list` returns it.
 *
 * Reordering and removal are not this component's job — they live in the row
 * header above it (an overflow menu shared with `ShapeRule`), the one place a
 * step is one among several. This is only ever the one step's own form.
 */
export interface ShapeStepProps {
  readonly role: FlowPolicyRole
  readonly agents: readonly AgentEntry[]
  readonly onChange: (role: FlowPolicyRole) => void
}

export const ShapeStep = ({ role, agents, onChange }: ShapeStepProps) => {
  const setId = (id: string): void => onChange({ ...role, id })
  const setKind = (kind: FlowPolicyRole['kind']): void => {
    if (kind === role.kind) return
    onChange(defaultRole(kind, role.id))
  }

  return (
    <Card spacing="compact">
        <FormStack>
          <Field label="Step name" hint="Other steps refer to this one by this name — renaming it updates every place that does.">
            {(control) => <Input {...control} value={role.id} onChange={(event) => setId(event.target.value)} />}
          </Field>
          <Field label="Kind">
            {(control) => (
              <NativeSelect {...control} aria-label={`Kind for ${role.id}`} value={role.kind} onChange={(event) => setKind(event.target.value as FlowPolicyRole['kind'])}>
                {ROLE_KINDS.map((kind) => <option key={kind} value={kind}>{ROLE_KIND_WORDS[kind]}</option>)}
              </NativeSelect>
            )}
          </Field>

          {role.kind === 'agent' && (
            <>
              <section aria-label={`Agents for ${role.id}`}>
                <SectionHead name="Uses" />
                <Rows>
                  {agents.length === 0 && <Row title="No Agents to choose from yet" />}
                  {agents.map((entry) => (
                    <Row
                      key={entry.id}
                      title={agentName(entry)}
                      control={(
                        <Checkbox
                          checked={role.uses.includes(entry.id)}
                          aria-label={`Use ${agentName(entry)} for ${role.id}`}
                          onCheckedChange={(checked) => onChange({
                            ...role,
                            uses: checked ? [...role.uses, entry.id] : role.uses.filter((id) => id !== entry.id),
                          })}
                        />
                      )}
                    />
                  ))}
                </Rows>
              </section>
              <Field label="Count" hint="Only used when Uses names one Agent and no seat override — a count above 1 repeats it.">
                {(control) => (
                  <Input
                    {...control}
                    type="number"
                    min={1}
                    max={32}
                    disabled={role.uses.length > 1 || role.seats.length > 1}
                    value={role.count ?? ''}
                    onChange={(event) => {
                      const value = event.target.value.trim()
                      const count = value ? Number(value) : undefined
                      onChange({ ...role, ...(count && count > 0 ? { count } : { count: undefined }) })
                    }}
                  />
                )}
              </Field>
              <Field label="Seat override" hint="Names a runtime only, so the shape stays portable — an exact model stays on a machine's own seating.">
                {(control) => (
                  <Input
                    {...control}
                    value={role.seats[0]?.runtime ?? ''}
                    onChange={(event) => {
                      const runtime = event.target.value.trim()
                      onChange({ ...role, seats: runtime ? [{ runtime }] : [] })
                    }}
                  />
                )}
              </Field>
              <Row
                title="Isolated"
                desc="Each seat works in a worktree of its own."
                control={<Checkbox checked={role.isolate} aria-label={`Isolate ${role.id}`} onCheckedChange={(checked) => onChange({ ...role, isolate: checked === true })} />}
              />
              <Field label="Grant">
                {(control) => (
                  <NativeSelect {...control} value={role.grant} onChange={(event) => onChange({ ...role, grant: event.target.value as typeof role.grant })}>
                    {CEILINGS.map((level) => <option key={level} value={level}>{level}</option>)}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Independent of" hint="Other Agent steps, one per line. This step must run on a different provider than each one — not just a different model.">
                {(control) => (
                  <Textarea
                    {...control}
                    rows={2}
                    value={wordLines(role.independentOf)}
                    onChange={(event) => onChange({ ...role, independentOf: parseWordLines(event.target.value) })}
                  />
                )}
              </Field>
              <Row
                title="Blind from its siblings"
                desc="While its round is open, this role cannot read a sibling's package or findings — publication still waits for the round to close either way."
                control={(
                  <Checkbox
                    checked={role.blind !== false}
                    aria-label={`Blind ${role.id} from its siblings`}
                    onCheckedChange={(checked) => onChange({ ...role, blind: checked === true ? undefined : false })}
                  />
                )}
              />
            </>
          )}

          {role.kind === 'check' && (
            <>
              <Field label="Run">
                {(control) => <Input {...control} value={role.check.run} onChange={(event) => onChange({ ...role, check: { ...role.check, run: event.target.value } })} />}
              </Field>
              <Field label="Working folder" hint="Relative to the project. Leave empty for the project root.">
                {(control) => (
                  <Input
                    {...control}
                    value={role.check.cwd ?? ''}
                    onChange={(event) => {
                      const cwd = event.target.value.trim()
                      onChange({ ...role, check: { ...role.check, ...(cwd ? { cwd } : { cwd: undefined }) } })
                    }}
                  />
                )}
              </Field>
              <Field label="Timeout (seconds)">
                {(control) => (
                  <Input
                    {...control}
                    type="number"
                    min={1}
                    value={role.check.timeout}
                    onChange={(event) => onChange({ ...role, check: { ...role.check, timeout: Number(event.target.value) || 1 } })}
                  />
                )}
              </Field>
              <Field label="Exit codes" hint="One per line: an exit status, a colon, the outcome it reports — for example 0: pass.">
                {(control) => (
                  <Textarea
                    {...control}
                    rows={3}
                    value={exitLines(role.check.exits)}
                    onChange={(event) => onChange({ ...role, check: { ...role.check, exits: parseExitLines(event.target.value) } })}
                  />
                )}
              </Field>
              <Field label="Otherwise" hint="What every other exit status reports, the timeout included.">
                {(control) => <Input {...control} value={role.check.otherwise} onChange={(event) => onChange({ ...role, check: { ...role.check, otherwise: event.target.value } })} />}
              </Field>
            </>
          )}

          {role.kind === 'person' && (
            <Field label="Outcomes" hint="One word per line — what this step may report. A rule branches only on a word declared here.">
              {(control) => (
                <Textarea {...control} rows={3} value={wordLines(role.outcomes)} onChange={(event) => onChange({ ...role, outcomes: parseWordLines(event.target.value) })} />
              )}
            </Field>
          )}
        </FormStack>
    </Card>
  )
}
