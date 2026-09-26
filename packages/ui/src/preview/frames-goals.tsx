import { useState } from 'react'

import type { AuthoringSaveInput, FindingRunView, Intent } from '@harnessdesk/protocol'

import { AddMember } from '../components/AddMember'
import { AddWork } from '../components/AddWork'
import { FindingCarry } from '../components/FindingCarry'
import { FindingDecision } from '../components/FindingDecision'
import { FindingDetail } from '../components/FindingDetail'
import { FindingPublications } from '../components/FindingPublications'
import { FindingRoundStatus } from '../components/FindingRoundStatus'
import { FrontDoor } from '../components/FrontDoor'
import { GoalAssign } from '../components/GoalAssign'
import { GoalCreate } from '../components/GoalCreate'
import { GoalFindings } from '../components/GoalFindings'
import { GoalReceipt } from '../components/GoalReceipt'
import { GoalReceiptCost } from '../components/GoalReceiptCost'
import { GoalWrap } from '../components/GoalWrap'
import { HandOut } from '../components/HandOut'
import { InsightCost } from '../components/InsightCost'
import { ShapeEditor } from '../components/ShapeEditor'
import { ShapeGraph } from '../components/ShapeGraph'
import { ShapeRule } from '../components/ShapeRule'
import { ShapeSave } from '../components/ShapeSave'
import { TriggerCreate } from '../components/TriggerCreate'
import { TriggerMenu } from '../components/TriggerMenu'
import { defaultRule, emptyShapePolicy } from '../lib/shapes'
import { Dial, Frame } from './main'
import { PREVIEW_FLOW_SOURCE } from './flow-fixture'
import { PREVIEW_FINDINGS, findingDetail } from './findings-fixture'
import { PREVIEW_GOAL, PREVIEW_GOALS } from './goal-fixture'
import { PREVIEW_ROOT } from './sidebar-fixture'

/** `goal-wrapped`'s own receipt, given the one thing it does not otherwise carry: unresolved findings for `FindingCarry` to offer forward. */
const WRAPPED_WITH_FINDINGS = PREVIEW_GOALS.find((one) => one.goal.id === 'goal-wrapped')!
const CARRY_SOURCE = {
  ...WRAPPED_WITH_FINDINGS,
  receipt: {
    ...WRAPPED_WITH_FINDINGS.receipt!,
    findings: { version: 1 as const, evidence: [], findings: PREVIEW_FINDINGS.filter((one) => !one.lifecycle.confirmed), overrides: [] },
  },
}

const RUN_VIEW: FindingRunView = {
  run: 'run-preview',
  goal: PREVIEW_GOAL.goal.id,
  round: 2,
  finished: 1,
  total: 3,
  embargoed: true,
  open: 2,
  blocking: 1,
  reason: 'Two findings are still open, one of them blocking.',
  stamp: 'preview-stamp',
  publication: 'pending',
  reviewersFinished: 1,
  reviewersTotal: 3,
  pendingExceptions: [],
  repair: null,
  boundPr: { repo: 'harnessdesk/harnessdesk', pr: 42 },
  unbound: null,
  undecidable: null,
}

const PREVIEW_INTENTS: readonly Intent[] = PREVIEW_GOAL.board.intents

const SHAPE_SAVE_INPUT: AuthoringSaveInput = {
  target: { kind: 'flow', origin: 'project', id: 'new-flow', root: PREVIEW_ROOT },
  expected: null,
  source: PREVIEW_FLOW_SOURCE['fix']!,
}

const TRIGGER_MENU_ITEMS = [
  { id: 'reviewer', name: 'Code reviewer', hint: 'Reads a diff', mono: false },
  { id: 'notes', name: 'notes.md', badge: 'file', pathStyle: true },
  { id: 'active', name: 'Alpha', badge: 'in this turn', badgeTone: 'live' as const },
]

const SHAPE_POLICY_WITH_RULE = (() => {
  const policy = emptyShapePolicy()
  const rule = defaultRule('rule-1', 'review', 'review')
  return { policy: { ...policy, rules: [rule] }, rule }
})()

const DIALOG_OPTIONS = [
  'off', 'goal create', 'goal assign', 'goal wrap', 'finding carry', 'finding decision',
  'finding detail', 'finding publications', 'add member', 'add work', 'hand out', 'shape save', 'front door',
] as const
type DialogOption = (typeof DIALOG_OPTIONS)[number]

/**
 * Goals, findings and shapes: a "goals dialog" dial for the sheets that cover
 * the page (create, assign, wrap, carry, decide, publish, add a member, add
 * work, hand work out, save a shape, the front door), and plain frames below
 * it for the parts a Goal's own page or rail already draws inline — the
 * findings rail, a round's status, a receipt as it reads once wrapped, its
 * accounting, the shape editor's steps and graph, one of its rules, and the
 * `/`-menu every composer opens.
 */
export const GoalFrames = () => {
  const [dialog, setDialog] = useState<DialogOption>('off')
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial label="goals dialog" value={dialog} options={DIALOG_OPTIONS} onChange={setDialog} />
      </div>
      {dialog === 'goal create' && <GoalCreate root={PREVIEW_ROOT} onClose={() => setDialog('off')} />}
      {dialog === 'goal assign' && <GoalAssign view={PREVIEW_GOAL} card={PREVIEW_INTENTS[0]?.id ?? 1} onClose={() => setDialog('off')} />}
      {dialog === 'goal wrap' && <GoalWrap view={PREVIEW_GOAL} onClose={() => setDialog('off')} />}
      {dialog === 'finding carry' && <FindingCarry source={CARRY_SOURCE} />}
      {dialog === 'finding decision' && <FindingDecision goal={PREVIEW_GOAL.goal.id} view={RUN_VIEW} onClose={() => setDialog('off')} />}
      {dialog === 'finding detail' && (
        <FindingDetail goal={PREVIEW_GOAL.goal.id} finding={findingDetail('finding-open-1').finding.id} decide={RUN_VIEW} onClose={() => setDialog('off')} />
      )}
      {dialog === 'finding publications' && <FindingPublications goal={PREVIEW_GOAL.goal.id} run="run-preview" stamp="preview-stamp" />}
      {dialog === 'add member' && <AddMember room={PREVIEW_GOAL.goal.id} root={PREVIEW_ROOT} onClose={() => setDialog('off')} />}
      {dialog === 'add work' && <AddWork room={PREVIEW_GOAL.goal.id} intents={PREVIEW_INTENTS} onClose={() => setDialog('off')} />}
      {dialog === 'hand out' && (
        <HandOut room={PREVIEW_GOAL.goal.id} intents={PREVIEW_INTENTS} peers={[]} onClose={() => setDialog('off')} onTrouble={() => {}} />
      )}
      {dialog === 'shape save' && <ShapeSave input={SHAPE_SAVE_INPUT} onSaved={() => setDialog('off')} onClose={() => setDialog('off')} />}
      {dialog === 'front door' && (
        <FrontDoor context={{ kind: 'project', root: PREVIEW_ROOT }} onClose={() => setDialog('off')} onStarted={() => setDialog('off')} />
      )}

      <Frame title="Goal — its findings rail">
        <div className="max-h-[480px] overflow-y-auto p-4">
          <GoalFindings goal={PREVIEW_GOAL.goal.id} />
        </div>
      </Frame>
      <Frame title="Finding — a review round's status">
        <div className="p-4">
          <FindingRoundStatus view={RUN_VIEW} />
        </div>
      </Frame>
      <Frame title="Goal — its receipt, as recorded when wrapped">
        <div className="max-h-[560px] overflow-y-auto p-4">
          <GoalReceipt receipt={WRAPPED_WITH_FINDINGS.receipt!} root={PREVIEW_ROOT} onOpenFinding={() => {}} />
        </div>
      </Frame>
      <Frame title="Goal — its receipt's own accounting">
        <div className="p-4">
          <GoalReceiptCost receipt={WRAPPED_WITH_FINDINGS.receipt!} />
        </div>
      </Frame>
      <Frame title="Insight — recorded usage, loading">
        <div className="p-4">
          <InsightCost report={null} loading problem={null} onRefresh={() => {}} />
        </div>
      </Frame>
      {/* The editor opens on its own "steps" tab (`ShapeStep`, one row per
          role); its own Graph and Source tabs, real buttons drawn by
          `ShapeEditor` itself, reach `ShapeGraph` the same way a person's own
          click would — nothing here needs to duplicate that switch. */}
      <Frame title="Your own shape — steps, graph and source">
        <div className="h-[720px]">
          <ShapeEditor
            root={PREVIEW_ROOT}
            context={{ kind: 'project', root: PREVIEW_ROOT }}
            initialSource={PREVIEW_FLOW_SOURCE['fix']}
            onClose={() => {}}
            onStarted={() => {}}
          />
        </div>
      </Frame>
      <Frame title="Shape — one rule's own form">
        <div className="max-w-[520px] p-4">
          <ShapeRule rule={SHAPE_POLICY_WITH_RULE.rule} policy={SHAPE_POLICY_WITH_RULE.policy} onChange={() => {}} />
        </div>
      </Frame>
      {/* `ShapeEditor`'s own Graph tab reaches this same component from a real
          click; mounted directly too, so the graph is on the page whether or
          not that click happened. */}
      <Frame title="Shape — the graph">
        <div className="h-[420px] p-4">
          <ShapeGraph policy={SHAPE_POLICY_WITH_RULE.policy} selected={null} onSelect={() => {}} onPositions={() => {}} onEditRule={() => {}} />
        </div>
      </Frame>
      <Frame title="Every time — a trigger, from a shape or an Agent">
        <TriggerCreate root={PREVIEW_ROOT} opens={{ agent: 'code-reviewer' }} onSaved={() => {}} onClose={() => {}} />
      </Frame>
      <Frame title="The `/` and `@` menu">
        <div className="w-[320px] p-4">
          <TriggerMenu title="Agents" items={TRIGGER_MENU_ITEMS} activeIndex={0} onHover={() => {}} onPick={() => {}} />
        </div>
      </Frame>
    </>
  )
}
