import { describe, expect, it } from 'vitest'

import type { Session } from '@harnessdesk/protocol'

import { findTodos, planOf, sessionPlan } from './todos'

/**
 * The plan a conversation is working to.
 *
 * One function answers three questions that used to be answered three
 * different ways and disagreed: what the sidebar shows, what a hand-off
 * carries, and which conversation either belongs to. So what is pinned here
 * is that it reads *this* session, that the last plan written wins whatever
 * wrote it, and that every agent's spelling of a plan counts as one.
 */

const session = (turns: unknown[]): Session =>
  ({
    id: 's1',
    runtime: 'alpha',
    cwd: '/w',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    itemsLoaded: true,
    turns,
  }) as unknown as Session

const call = (id: string, tool: string, args: unknown) => ({
  id,
  type: 'toolCall',
  tool,
  source: { kind: 'builtin' },
  status: 'completed',
  args,
})

describe('findTodos', () => {
  it("reads each agent's own spelling of a plan entry", () => {
    // Claude Code's TodoWrite, Cursor's task list, and HarnessDesk's own
    // `todo_write` — three nouns for the label, one list.
    expect(findTodos({ todos: [{ content: 'a', status: 'completed' }] })?.[0]).toEqual({
      label: 'a',
      done: true,
      active: false,
    })
    expect(findTodos([{ title: 'b', status: 'in_progress' }])?.[0]).toEqual({
      label: 'b',
      done: false,
      active: true,
    })
    expect(findTodos({ tasks: [{ task: 'c', status: 'pending' }] })?.[0]).toEqual({
      label: 'c',
      done: false,
      active: false,
    })
  })

  it('is not fooled by an array of something else', () => {
    expect(findTodos({ files: ['a.ts', 'b.ts'] })).toBeNull()
    expect(findTodos({ rows: [{ name: 'a', status: 'ok' }] })).toBeNull()
  })

  it('reads every spelling of the three states, including the ones Cursor sends', () => {
    const of = (status: string) => findTodos([{ content: 'x', status }])?.[0]
    expect(of('completed')).toMatchObject({ done: true })
    expect(of('TODO_STATUS_COMPLETED')).toMatchObject({ done: true })
    expect(of('in_progress')).toMatchObject({ active: true })
    expect(of('TODO_STATUS_IN_PROGRESS')).toMatchObject({ active: true })
    expect(of('TODO_STATUS_PENDING')).toMatchObject({ done: false, active: false })
  })

  it('refuses a label that is not a string rather than stringifying it', () => {
    expect(findTodos([{ content: { nested: 1 }, status: 'pending' }])).toBeNull()
  })
})

describe('planOf', () => {
  it("reads Cursor's real CreatePlan — todos beside an empty phases", () => {
    // Measured from this desk's own transcripts. A plainer reading of "an
    // empty plan array means cleared" blanks the panel on the very call that
    // set the plan, because `phases` arrives empty alongside a full `todos`.
    const plan = planOf({
      todos: [
        { id: 'a', content: 'enrich the agents', status: 'TODO_STATUS_IN_PROGRESS' },
        { id: 'b', content: 'verify the specs', status: 'TODO_STATUS_COMPLETED' },
      ],
      phases: [],
    })
    expect(plan?.map((todo) => todo.label)).toEqual(['enrich the agents', 'verify the specs'])
    expect(plan?.[0]?.active).toBe(true)
    expect(plan?.[1]?.done).toBe(true)
  })

  it('tells an emptied plan apart from a call that was never about one', () => {
    expect(planOf({ tasks: [] })).toEqual([])
    expect(planOf({ todos: [] })).toEqual([])
    expect(planOf({ file_path: '/x', content: 'hello' })).toBeNull()
  })

  it('takes a task with no status said, and a task that is only a string', () => {
    // Both are what `todo_write` documents and accepts. Requiring a status
    // meant an agent writing `{tasks: [{task: 'design'}]}` updated its own
    // list and the turn's context while the panel kept showing the plan
    // before it — a divergence between the two ends, again.
    expect(planOf({ tasks: [{ task: 'design' }] })?.map((todo) => todo.label)).toEqual(['design'])
    expect(planOf({ tasks: ['design', 'build'] })?.map((todo) => todo.label)).toEqual(['design', 'build'])
  })

  it('leaves a cancelled task off the plan rather than showing it as open', () => {
    // Shown as pending it reaches the next agent's hand-off as work to do.
    expect(
      planOf({ todos: [{ content: 'keep', status: 'pending' }, { content: 'dropped', status: 'cancelled' }] })?.map(
        (todo) => todo.label,
      ),
    ).toEqual(['keep'])
  })

  it('reads the same list todo_write takes: the first that holds a readable task, in the call\'s order', () => {
    expect(planOf({ tasks: [{}], todos: [{ task: 'ship' }] })?.map((todo) => todo.label)).toEqual(['ship'])
    expect(planOf({ todos: [{ task: 'b' }], tasks: [{ task: 'a' }] })?.map((todo) => todo.label)).toEqual(['b'])
  })

  it('reads a list whose tasks were all cancelled as a plan put down', () => {
    // #58, found in review: read as "said nothing", it brought back the plan before.
    expect(planOf({ tasks: [{ task: 'design', status: 'cancelled' }, { task: 'build', status: 'cancelled' }] })).toEqual([])
    // Entries with nothing readable are still not a plan at all.
    expect(planOf({ tasks: [{}, 42] })).toBeNull()
  })

  it('does not read a CI tool’s own steps as the conversation’s plan', () => {
    expect(planOf({ steps: [{ title: 'Build', status: 'completed' }] })).toBeNull()
  })

  it('is not a plan just because it is a list of labelled things with statuses', () => {
    // A tool listing issues or pipeline steps returns exactly this shape.
    // Anchoring on the key is what stops it replacing the agent's own plan.
    expect(planOf({ issues: [{ title: 'a bug', status: 'open' }] })).toBeNull()
    expect(planOf({ jobs: [{ description: 'deploy', status: 'queued' }] })).toBeNull()
  })
})

describe('sessionPlan', () => {
  it('returns the last plan written, so a new plan replaces the old one', () => {
    // The reported bug: an agent that planned once, then planned again with a
    // different tool, left the first list on screen with nothing able to
    // replace it.
    const plan = sessionPlan(
      session([
        {
          id: 't1',
          status: 'completed',
          items: [
            call('c1', 'TodoWrite', { todos: [{ content: 'explore', status: 'pending' }] }),
            call('c2', 'CreatePlan', {
              plan: [
                { title: 'move the worktree', status: 'completed' },
                { title: 'run the tests', status: 'in_progress' },
              ],
            }),
          ],
        },
      ]),
    )
    expect(plan?.map((todo) => todo.label)).toEqual(['move the worktree', 'run the tests'])
    expect(plan?.[0]?.done).toBe(true)
    expect(plan?.[1]?.active).toBe(true)
  })

  it('a plan whose tasks were all cancelled is put down, not replaced by the one before', () => {
    const plan = sessionPlan(
      session([
        { id: 't1', status: 'completed', items: [call('c1', 'todo_write', { tasks: [{ task: 'design' }, { task: 'build' }] })] },
        {
          id: 't2',
          status: 'completed',
          items: [call('c2', 'todo_write', { tasks: [{ task: 'design', status: 'cancelled' }, { task: 'build', status: 'cancelled' }] })],
        },
      ]),
    )
    expect(plan).toEqual([])
  })

  it("takes a turn's own plan updates, which is how Codex and ACP report one", () => {
    const plan = sessionPlan(
      session([
        {
          id: 't1',
          status: 'completed',
          items: [call('c1', 'TodoWrite', { todos: [{ content: 'old', status: 'pending' }] })],
          plan: [
            { step: 'read the file', status: 'completed' },
            { step: 'write the patch', status: 'inProgress' },
          ],
        },
      ]),
    )
    expect(plan?.map((todo) => todo.label)).toEqual(['read the file', 'write the patch'])
  })

  it('spans turns, keeping the latest and not the first', () => {
    const plan = sessionPlan(
      session([
        { id: 't1', status: 'completed', items: [call('c1', 'TodoWrite', { todos: [{ content: 'first', status: 'pending' }] })] },
        { id: 't2', status: 'completed', items: [] },
        { id: 't3', status: 'completed', items: [call('c2', 'TodoWrite', { todos: [{ content: 'second', status: 'pending' }] })] },
      ]),
    )
    expect(plan?.map((todo) => todo.label)).toEqual(['second'])
  })

  it('is cleared by a plan tool sent an empty list, by either route', () => {
    // An agent that finishes its work puts the plan down. Until this, a clear
    // read as "this call said nothing about a plan" and the finished list
    // stayed on screen and in every hand-off, permanently.
    expect(
      sessionPlan(
        session([
          {
            id: 't1',
            status: 'completed',
            items: [
              call('c1', 'TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }),
              call('c2', 'todo_write', { tasks: [] }),
            ],
          },
        ]),
      ),
    ).toEqual([])
    expect(
      sessionPlan(
        session([
          { id: 't1', status: 'completed', items: [], plan: [{ step: 'old', status: 'pending' }] },
          { id: 't2', status: 'completed', items: [], plan: [] },
        ]),
      ),
    ).toEqual([])
  })

  it('is replaced by a plan whose tasks carry no status', () => {
    // The half-fixed case: the plugin accepted this shape and the reader did
    // not, so the newest plan was skipped and the *previous* one stayed on
    // screen — worse than showing nothing, because it contradicted the list
    // the agent itself was being handed every turn.
    const plan = sessionPlan(
      session([
        {
          id: 't1',
          status: 'completed',
          items: [
            call('c1', 'TodoWrite', { todos: [{ content: 'the old plan', status: 'pending' }] }),
            call('c2', 'todo_write', { tasks: [{ task: 'the new plan' }] }),
          ],
        },
      ]),
    )
    expect(plan?.map((todo) => todo.label)).toEqual(['the new plan'])
  })

  it('is not taken over by a later tool call that merely returns a list', () => {
    const plan = sessionPlan(
      session([
        {
          id: 't1',
          status: 'completed',
          items: [
            call('c1', 'TodoWrite', { todos: [{ content: 'the real plan', status: 'pending' }] }),
            call('c2', 'list_issues', { issues: [{ title: 'a bug', status: 'open' }] }),
          ],
        },
      ]),
    )
    expect(plan?.map((todo) => todo.label)).toEqual(['the real plan'])
  })

  it('has nothing to say about a conversation that never planned', () => {
    expect(sessionPlan(session([{ id: 't1', status: 'completed', items: [] }]))).toBeNull()
    expect(sessionPlan(null)).toBeNull()
  })
})
