import { describe, expect, it } from 'vitest'

import { applyPlanEdits, livePlanEdits, planEditNote, withPlanEdit } from './plan-edits'
import type { Todo } from './todos'

/**
 * A task the person reworded.
 *
 * The panel is a read of the conversation, so an edit is the one thing in it
 * the transcript does not say. What is pinned here is the whole of how that
 * stays honest: the edit attaches to what the *agent* wrote, it is told to the
 * agent, and it stops existing the moment the agent adopts it.
 */

const todos = (...labels: string[]): Todo[] =>
  labels.map((label) => ({ label, done: false, active: false }))

describe('applyPlanEdits', () => {
  it('shows the person’s wording, and remembers whose task it was', () => {
    const shown = applyPlanEdits(todos('Buffer the request body', 'Re-run the suite'), [
      { from: 'Buffer the request body', to: 'Buffer the body, re-arm per attempt' },
    ])
    expect(shown[0]).toMatchObject({
      label: 'Buffer the body, re-arm per attempt',
      source: 'Buffer the request body',
      edited: true,
    })
    expect(shown[1]).toMatchObject({ label: 'Re-run the suite', source: 'Re-run the suite', edited: false })
  })

  it('follows the task when the agent reorders the plan', () => {
    // Keyed on the label rather than the position: a step inserted at the top
    // would otherwise move every edit onto the wrong task.
    const edits = [{ from: 'Re-run the suite', to: 'Re-run the whole suite' }]
    const shown = applyPlanEdits(todos('A new first step', 'Buffer the body', 'Re-run the suite'), edits)
    expect(shown.map((todo) => todo.edited)).toEqual([false, false, true])
    expect(shown[2]?.label).toBe('Re-run the whole suite')
  })

  it('leaves the plan alone when the task it named is gone', () => {
    const shown = applyPlanEdits(todos('Something else entirely'), [{ from: 'Gone', to: 'Reworded' }])
    expect(shown.map((todo) => todo.label)).toEqual(['Something else entirely'])
    expect(shown[0]?.edited).toBe(false)
  })
})

describe('a plan that repeats a label', () => {
  it('rewords the occurrence that was edited, and only that one', () => {
    // "run the tests" after each of two changes is a real plan. Keyed on the
    // label alone, one edit reworded both rows and the second was unreachable.
    const plan = todos('Change the reader', 'Run the tests', 'Change the writer', 'Run the tests')
    const shown = applyPlanEdits(plan, [{ from: 'Run the tests', to: 'Run the unit tests', at: 1 }])
    expect(shown.map((todo) => todo.label)).toEqual([
      'Change the reader', 'Run the tests', 'Change the writer', 'Run the unit tests',
    ])
    expect(shown.map((todo) => todo.at)).toEqual([0, 0, 0, 1])
  })

  it('keeps the two occurrences' + String.fromCharCode(8217) + ' edits apart', () => {
    let edits = withPlanEdit([], 'Run the tests', 'Run the unit tests', 0)
    edits = withPlanEdit(edits, 'Run the tests', 'Run the whole suite', 1)
    expect(edits).toHaveLength(2)
    const shown = applyPlanEdits(todos('Run the tests', 'Run the tests'), edits)
    expect(shown.map((todo) => todo.label)).toEqual(['Run the unit tests', 'Run the whole suite'])
  })
})

describe('withPlanEdit', () => {
  it('replaces the edit a task already had rather than stacking a second', () => {
    // The second edit is keyed on what the transcript says, not on what the
    // panel is showing — otherwise its `from` would match nothing, ever.
    const once = withPlanEdit([], 'Buffer the request body', 'Buffer the body')
    const twice = withPlanEdit(once, 'Buffer the request body', 'Buffer it once, re-arm per attempt')
    expect(twice).toEqual([
      { from: 'Buffer the request body', to: 'Buffer it once, re-arm per attempt' },
    ])
  })

  it('reads typing the original wording back as undoing the edit', () => {
    const edits = withPlanEdit([], 'Re-run the suite', 'Re-run everything')
    expect(withPlanEdit(edits, 'Re-run the suite', 'Re-run the suite')).toEqual([])
    expect(withPlanEdit(edits, 'Re-run the suite', '   ')).toEqual([])
  })
})

describe('livePlanEdits', () => {
  it('retires an edit the agent has adopted', () => {
    // The wording is in the plan now: the panel and the transcript agree, and
    // keeping the edit would only risk rewriting a later task that reused the
    // old label.
    const edits = [{ from: 'Buffer the request body', to: 'Buffer the body, re-arm per attempt' }]
    expect(livePlanEdits(todos('Buffer the body, re-arm per attempt'), edits)).toEqual([])
  })

  it('retires an edit whose task the agent reworded its own way', () => {
    // Agents adopt a paraphrase far more often than the exact words. Keeping
    // an edit that matched neither `from` nor `to` left it alive to rewrite
    // some later task that happened to reuse the old label.
    const edits = [{ from: 'verify the specs', to: 'verify the install specs, all ten agents' }]
    expect(livePlanEdits(todos('verify the install specs across ten agents'), edits)).toEqual([])
  })

  it('does not read a collision as adoption', () => {
    // Rewording one task to match another the plan already contains is not
    // the agent taking the wording up. Dropped here, the panel snapped back
    // to the agent's words and `planEditNote` had nothing to tell it.
    const edits = [{ from: 'Run the suite', to: 'Run tests' }]
    expect(livePlanEdits(todos('Run the suite', 'Run tests'), edits)).toEqual(edits)
    expect(planEditNote(todos('Run the suite', 'Run tests'), edits)).toContain('Run tests')
    // And once the old wording is gone, it is adoption after all.
    expect(livePlanEdits(todos('Run tests'), edits)).toEqual([])
  })

  it('keeps an edit whose task is momentarily absent', () => {
    // A plan is often cleared and rewritten inside one turn; retiring on the
    // empty moment would throw away a correction made seconds earlier.
    const edits = [{ from: 'Buffer the request body', to: 'Buffer the body' }]
    expect(livePlanEdits([], edits)).toEqual(edits)
  })
})

describe('planEditNote', () => {
  it('tells the agent what was reworded, and only what still stands', () => {
    const note = planEditNote(todos('Buffer the request body', 'Already adopted'), [
      { from: 'Buffer the request body', to: 'Buffer the body, re-arm per attempt' },
      { from: 'Something older', to: 'Already adopted' },
    ])
    expect(note).toContain('I reworded one task')
    expect(note).toContain('“Buffer the request body” → “Buffer the body, re-arm per attempt”')
    // Adopted, so not news.
    expect(note).not.toContain('Something older')
    // The statuses are the agent's; the note says so.
    expect(note).toContain('statuses are still yours')
  })

  it('says nothing at all when there is nothing standing', () => {
    expect(planEditNote(todos('A', 'B'), [])).toBeNull()
    // The edit's task is not in this plan, so there is nothing to correct.
    expect(planEditNote(todos('A'), [{ from: 'Gone', to: 'Reworded' }])).toBeNull()
  })
})

describe('an edit to a duplicate task', () => {
  it('retires an edit to a duplicate the plan no longer has', () => {
    // #86: liveness asked only whether the label was there, so an edit to its second occurrence
    // outlived that row and waited to reword the next duplicate the agent wrote.
    const edits = [{ from: 'Run the tests', to: 'Run the tests again', at: 1 }]
    expect(livePlanEdits(todos('Run the tests', 'Ship', 'Run the tests'), edits)).toEqual(edits)
    expect(livePlanEdits(todos('Run the tests', 'Ship'), edits)).toEqual([])
  })
})

describe('a stored edit that names no row', () => {
  it('drops a stored edit whose occurrence is not a count from zero', () => {
    // Round 1 of #170: a malformed occurrence was compared as a number, and 0 > -1 kept it alive.
    expect(livePlanEdits(todos('Ship'), [{ from: 'Gone', to: 'x', at: -1 }])).toEqual([])
    expect(livePlanEdits(todos('Ship'), [{ from: 'Ship', to: 'Ship it', at: 0.5 }])).toEqual([])
    expect(livePlanEdits(todos('Ship'), [{ from: 'Ship', to: 'Ship it' }])).toEqual([{ from: 'Ship', to: 'Ship it' }])
  })

  it('the note names an edit to a duplicate while its row is there, and not after', () => {
    // Round 1 of #170: planEditNote with an `at` edit was not pinned.
    const edits = [{ from: 'Run the tests', to: 'Run the tests again', at: 1 }]
    expect(planEditNote(todos('Run the tests', 'Ship', 'Run the tests'), edits)).toContain('Run the tests again')
    expect(planEditNote(todos('Run the tests', 'Ship'), edits) ?? '').not.toContain('Run the tests again')
  })
})
