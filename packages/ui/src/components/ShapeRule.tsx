import type { FlowEvidenceGuard, FlowPolicy, FlowPolicyRule } from '@harnessdesk/protocol'

import { Button, Field, Input, NativeSelect, Row, Rows, SectionHead, Textarea } from '../design'
import { CrossIcon, PlusIcon } from './Icons'
import { parseWordLines, wordLines } from '../lib/shapes'

/**
 * One rule, edited by the finite vocabulary the engine actually reads: which
 * finished round it watches, any/every over the answers it declared, the
 * five supported evidence guards, and one target round to open. There is no
 * expression editor and no executable interpolation here — a value that does
 * not parse as one of these is simply not offered.
 *
 * Answer words are free text, not a picker bound to one role's Agents:
 * `ShapeRule` is handed the whole policy, not the roster, and an unknown
 * answer is the compiler's refusal to report at Save/Start, never a guess
 * this editor makes on its own.
 */
export interface ShapeRuleProps {
  readonly rule: FlowPolicyRule
  readonly policy: FlowPolicy
  readonly onChange: (rule: FlowPolicyRule) => void
  readonly onRemove: () => void
}

const GUARD_KINDS: readonly ('check' | 'ci' | 'review' | 'pr' | 'diff')[] = ['check', 'ci', 'review', 'pr', 'diff']
const GUARD_WORDS: Readonly<Record<(typeof GUARD_KINDS)[number], string>> = {
  check: 'A named check passed', ci: 'CI is green', review: 'A structured review named it', pr: 'The pull request state', diff: 'There is a diff',
}

const guardKind = (guard: FlowEvidenceGuard): (typeof GUARD_KINDS)[number] => (
  'check' in guard ? 'check' : 'ci' in guard ? 'ci' : 'review' in guard ? 'review' : 'pr' in guard ? 'pr' : 'diff'
)

const defaultGuard = (kind: (typeof GUARD_KINDS)[number]): FlowEvidenceGuard => (
  kind === 'check' ? { check: '' } : kind === 'ci' ? { ci: 'green' } : kind === 'review' ? { review: '' } : kind === 'pr' ? { pr: 'open' } : { diff: true }
)

export const ShapeRule = ({ rule, policy, onChange, onRemove }: ShapeRuleProps) => {
  const roleIds = policy.roles.map((role) => role.id)
  const every = rule.when?.every ?? []
  const any = rule.when?.any ?? []
  const evidence = rule.when?.evidence ?? []

  const setWhen = (next: Partial<NonNullable<FlowPolicyRule['when']>>): void => {
    const merged = { ...rule.when, ...next }
    const cleaned = {
      ...(merged.every?.length ? { every: merged.every } : {}),
      ...(merged.any?.length ? { any: merged.any } : {}),
      ...(merged.evidence?.length ? { evidence: merged.evidence } : {}),
    }
    onChange({ ...rule, ...(Object.keys(cleaned).length ? { when: cleaned } : { when: undefined }) })
  }

  const setGuard = (index: number, guard: FlowEvidenceGuard): void => {
    const next = [...evidence]
    next[index] = guard
    setWhen({ evidence: next })
  }
  const removeGuard = (index: number): void => setWhen({ evidence: evidence.filter((_, one) => one !== index) })
  const addGuard = (): void => setWhen({ evidence: [...evidence, defaultGuard('check')] })

  return (
    <div>
      <Field label="Id">
        {(control) => <Input {...control} value={rule.id} onChange={(event) => onChange({ ...rule, id: event.target.value })} />}
      </Field>
      <Field label="When this round finishes" hint="Which step's round ending is watched by this rule.">
        {(control) => (
          <NativeSelect {...control} value={rule.on} onChange={(event) => onChange({ ...rule, on: event.target.value })}>
            {roleIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </NativeSelect>
        )}
      </Field>

      <Field label="Every one of these answers" hint="One word per line. Every card of the round must have reported one of these.">
        {(control) => <Textarea {...control} rows={2} value={wordLines(every)} onChange={(event) => setWhen({ every: parseWordLines(event.target.value) })} />}
      </Field>
      <Field label="Any one of these answers" hint="One word per line. At least one card of the round reported one of these.">
        {(control) => <Textarea {...control} rows={2} value={wordLines(any)} onChange={(event) => setWhen({ any: parseWordLines(event.target.value) })} />}
      </Field>

      <section aria-label={`Evidence guards for ${rule.id}`}>
        <SectionHead name="Evidence" action={<Button size="sm" variant="outline" onClick={addGuard}><PlusIcon size={14} />Add a guard</Button>} />
        <Rows>
          {evidence.length === 0 && <Row title="No evidence guard — this rule fires on answers alone" />}
          {evidence.map((guard, index) => {
            const kind = guardKind(guard)
            return (
              <Row
                key={index}
                title={GUARD_WORDS[kind]}
                control={(
                  <span className="flex items-center gap-(--hd-space-2)">
                    <NativeSelect aria-label={`Guard ${index + 1} kind`} value={kind} onChange={(event) => setGuard(index, defaultGuard(event.target.value as (typeof GUARD_KINDS)[number]))}>
                      {GUARD_KINDS.map((one) => <option key={one} value={one}>{one}</option>)}
                    </NativeSelect>
                    {kind === 'check' && (
                      <Input aria-label={`Check name for guard ${index + 1}`} value={'check' in guard ? guard.check : ''} onChange={(event) => setGuard(index, { check: event.target.value })} />
                    )}
                    {kind === 'review' && (
                      <Input aria-label={`Review name for guard ${index + 1}`} value={'review' in guard ? guard.review : ''} onChange={(event) => setGuard(index, { review: event.target.value })} />
                    )}
                    {kind === 'pr' && (
                      <NativeSelect aria-label={`Pull request state for guard ${index + 1}`} value={'pr' in guard ? guard.pr : 'open'} onChange={(event) => setGuard(index, { pr: event.target.value as 'open' | 'merged' })}>
                        <option value="open">open</option>
                        <option value="merged">merged</option>
                      </NativeSelect>
                    )}
                    <Button size="sm" variant="outline" aria-label={`Remove guard ${index + 1}`} onClick={() => removeGuard(index)}>
                      <CrossIcon size={14} />
                    </Button>
                  </span>
                )}
              />
            )
          })}
        </Rows>
      </section>

      <Field label="Opens">
        {(control) => (
          <NativeSelect {...control} value={rule.then.role} onChange={(event) => onChange({ ...rule, then: { ...rule.then, role: event.target.value } })}>
            {roleIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </NativeSelect>
        )}
      </Field>
      <Field label="Card title">
        {(control) => <Input {...control} value={rule.then.title} onChange={(event) => onChange({ ...rule, then: { ...rule.then, title: event.target.value } })} />}
      </Field>
      <Field label="Card detail" hint="Optional. Shown below the title.">
        {(control) => (
          <Input
            {...control}
            value={rule.then.detail ?? ''}
            onChange={(event) => {
              const detail = event.target.value
              onChange({ ...rule, then: { ...rule.then, ...(detail ? { detail } : { detail: undefined }) } })
            }}
          />
        )}
      </Field>
      <Field label="Files" hint="Optional. Path patterns the opened round's cards own while claimed, one per line.">
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={wordLines(rule.then.files ?? [])}
            onChange={(event) => {
              const files = parseWordLines(event.target.value)
              onChange({ ...rule, then: { ...rule.then, ...(files.length ? { files } : { files: undefined }) } })
            }}
          />
        )}
      </Field>

      <Button variant="outline" size="sm" onClick={onRemove}>Remove this rule</Button>
    </div>
  )
}
