import { describe, expect, it } from 'vitest'

import type { AgentEntry, RuntimeInfo, SeatCandidate, SeatLeft, SeatPlan, SeatReason } from '@harnessdesk/protocol'

import {
  anyBroken,
  anyOpened,
  blockedWords,
  bySection,
  ceilingWords,
  fileWords,
  firstParagraph,
  firstReason,
  fixWords,
  leftWords,
  markFor,
  originWords,
  projectName,
  reasonWords,
  refusalOf,
  seatTaken,
} from './agents'

/**
 * Agents in words: never a wire id, a seat spec or a digest, and every
 * ceiling asked rather than held until something holds it.
 */

const entry = (id: string, over: Partial<AgentEntry> = {}): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/Applications/HarnessDesk.app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name: id,
    description: null,
    permission: 'read',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'First.\n\nSecond.',
  },
  ...over,
})

const plan = (over: Partial<SeatPlan> = {}): SeatPlan => ({
  id: 'code-reviewer',
  from: 'prefer',
  winner: 1,
  blocked: null,
  candidates: [
    {
      seat: { runtime: 'cursor' },
      label: 'Cursor',
      runtimeName: 'Cursor',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'cursor' },
    },
    { seat: { runtime: 'claude-code' }, label: 'Claude', runtimeName: 'Claude', state: 'taken', reason: null, fix: null },
  ],
  ...over,
})

describe('agents in words', () => {
  it('says every ceiling is asked, because nothing holds one yet', () => {
    expect(ceilingWords('read')).toBe('Read · asked')
    expect(ceilingWords('publish')).toBe('Publish · asked')
    expect(ceilingWords('merge')).toBe('Merge · asked')
  })

  it('heads each section by where it was found, the project by its name', () => {
    expect(originWords('project', 'storefront')).toBe('In storefront')
    expect(originWords('user', 'storefront')).toBe('Yours')
    expect(originWords('builtin', null)).toBe('Built in')
    expect(
      projectName({
        path: '/w/storefront/pkg',
        name: 'pkg',
        lastOpenedAt: 1,
        repo: { root: '/w/storefront', worktree: false },
        checkoutRoot: '/w/storefront',
      }),
    ).toBe('storefront')
    expect(
      projectName({
        path: '/w/tree',
        name: 'tree',
        lastOpenedAt: 1,
        repo: { root: '/w/storefront', worktree: true },
        checkoutRoot: '/w/tree',
      }),
    ).toBe('tree')
    /*
     * A linked worktree opened at a subfolder of itself: `repo.root` is the
     * *main* checkout on purpose (so the session list can group the worktree
     * under the project it is a checkout of), which is the wrong folder to
     * name this project after — it is `checkoutRoot`, the worktree's own top,
     * that says what folder this actually is.
     */
    expect(
      projectName({
        path: '/w/tree/pkg',
        name: 'pkg',
        lastOpenedAt: 1,
        repo: { root: '/w/storefront', worktree: true },
        checkoutRoot: '/w/tree',
      }),
    ).toBe('tree')
    // No `checkoutRoot` at all (an older host, or outside git): the open folder itself is the best that is known.
    expect(projectName({ path: '/w/lone', name: 'lone', lastOpenedAt: 1 })).toBe('lone')
  })

  it('names a shipped Agent inside the app, and anything else by its path from home', () => {
    expect(fileWords({ id: 'judge', origin: 'builtin', path: '/Applications/HarnessDesk.app/x/judge/AGENT.md' }, '/Users/dev')).toBe(
      'HarnessDesk › agents/judge/AGENT.md',
    )
    expect(fileWords({ id: 'scout', origin: 'user', path: '/Users/dev/.harnessdesk/agents/scout/AGENT.md' }, '/Users/dev')).toBe(
      '~/.harnessdesk/agents/scout/AGENT.md',
    )
  })

  /*
   * Every kind `SeatReason` names today (`packages/protocol/src/agent.ts`),
   * so a kind nobody worded here is caught by this test rather than by a
   * blank row in the app. `reasonWords`'s own switch has no `default`, so a
   * kind added later fails the typecheck first.
   */
  it('words every reason by the runtime\'s name, never its id', () => {
    expect(reasonWords({ kind: 'notInstalled', added: false }, 'Codex')).toBe('Codex is not added to HarnessDesk')
    expect(reasonWords({ kind: 'notInstalled', added: true }, 'Codex')).toBe('Codex is not installed on this Mac')
    expect(reasonWords({ kind: 'unknownRuntime' }, 'Wanda')).toBe('Wanda is not a runtime HarnessDesk knows how to add')
    expect(reasonWords({ kind: 'unavailable', detail: 'crashed on launch' }, 'Codex')).toBe('Codex is unavailable: crashed on launch')
    // No number in the words, whatever `after` was — a person acts on "it did not answer", not on a millisecond count.
    expect(reasonWords({ kind: 'noAnswer', after: 4_000 }, 'Cursor')).toBe('Cursor did not answer in time')
    expect(reasonWords({ kind: 'signedOut' }, 'Cursor')).toBe('Cursor is signed out')
    expect(reasonWords({ kind: 'spent' }, 'Codex')).toBe("Codex's plan window is used up")
    expect(reasonWords({ kind: 'spentModel', model: 'opus-5' }, 'Claude')).toBe("Claude's window for opus-5 is used up")
    expect(reasonWords({ kind: 'modelsUnread', model: 'opus-5' }, 'Claude')).toBe("Claude's models could not be read")
    expect(reasonWords({ kind: 'noModel', model: 'opus-5' }, 'Claude')).toBe('Claude does not offer opus-5')
    // Effort always reads by its known word — there is no excuse for a raw "xhigh" when this vocabulary is universal.
    expect(reasonWords({ kind: 'noEffort', effort: 'xhigh' }, 'Claude')).toBe('Claude does not offer Extra high effort')
    expect(reasonWords({ kind: 'couldNotOpen', detail: 'timed out' }, 'Cursor')).toBe('Cursor could not open a conversation: timed out')
    expect(
      reasonWords({ kind: 'openedOtherwise', differences: [{ field: 'model', asked: 'opus-5', running: 'sonnet-5' }] }, 'Claude'),
    ).toBe('Claude opened it on sonnet-5, instead of opus-5')
    expect(
      reasonWords(
        {
          kind: 'openedOtherwise',
          differences: [
            { field: 'effort', asked: 'high', running: 'low' },
            { field: 'thinking', asked: true, running: false },
          ],
        },
        'Claude',
      ),
    ).toBe('Claude opened it at Low effort, instead of High, and without thinking, though it was asked for')
  })

  /*
   * A model catalogue is per runtime and nobody has one to hand `reasonWords`
   * yet, so it falls back to the raw id everywhere above. This proves the
   * seam is real rather than merely typed: given a resolver, a known model
   * reads by its label, and an unknown one still falls back to raw — never a
   * blank, never a thrown error.
   */
  it('names a model by the runtime\'s own label once a caller has one to give — raw only when nobody does', () => {
    const label = (id: string) => (id === 'opus-5' ? 'Opus 5' : null)
    expect(reasonWords({ kind: 'noModel', model: 'opus-5' }, 'Claude', label)).toBe('Claude does not offer Opus 5')
    expect(reasonWords({ kind: 'noModel', model: 'unknown-model' }, 'Claude', label)).toBe('Claude does not offer unknown-model')
    expect(reasonWords({ kind: 'spentModel', model: 'opus-5' }, 'Claude', label)).toBe("Claude's window for Opus 5 is used up")
    expect(
      reasonWords(
        { kind: 'openedOtherwise', differences: [{ field: 'model', asked: 'opus-5', running: 'unknown-model' }] },
        'Claude',
        label,
      ),
    ).toBe('Claude opened it on unknown-model, instead of Opus 5')
  })

  it('words a reason\'s fix by the runtime\'s name, never its id', () => {
    expect(fixWords({ kind: 'signIn', runtime: 'cursor' }, 'Cursor')).toBe('Sign in to Cursor')
    expect(fixWords({ kind: 'add', runtime: 'codex' }, 'Codex')).toBe('Add Codex')
    expect(fixWords({ kind: 'install', runtime: 'codex' }, 'Codex')).toBe('Install Codex')
    expect(fixWords({ kind: 'usage', runtime: 'codex' }, 'Codex')).toBe('See when it resets')
    expect(fixWords({ kind: 'runtime', runtime: 'codex' }, 'Codex')).toBe('Open Codex in Settings')
    expect(fixWords({ kind: 'seats' }, 'Claude')).toBe('Edit seats for this Mac')
  })

  it('reads a plan: the seat it takes, or the first thing wrong', () => {
    expect(seatTaken(plan())?.label).toBe('Claude')
    expect(firstReason(plan())).toBeNull()
    const refused = plan({ winner: null, candidates: [plan().candidates[0]!] })
    expect(seatTaken(refused)).toBeNull()
    expect(firstReason(refused)).toBe('Cursor is signed out')
    expect(firstReason(plan({ winner: null, candidates: [] }))).toBe('It names no seat to try')
  })

  /*
   * `plan.blocked` is the host's own sentence (`unusable()` in
   * `methods/agents.ts`) and starts with the Agent file's absolute path — a
   * fact this file never shows raw. A blocked plan reads as one plain
   * sentence instead, whatever the host's string said.
   */
  it('never lets a blocked plan\'s sentence — or the path inside it — reach the words', () => {
    const blocked = plan({
      winner: null,
      candidates: [],
      blocked: '/Users/dev/.harnessdesk/agents/draft/AGENT.md will not parse: "admin" is not a permission',
    })
    expect(firstReason(blocked)).toBe('Its file has a problem')
    expect(firstReason(blocked)).not.toMatch(/\//)
  })

  it('splits the roster by where it was found, and knows when one will not parse', () => {
    const roster = [entry('a', { origin: 'project' }), entry('b', { origin: 'user' }), entry('c')]
    expect(Object.values(bySection(roster)).map((one) => one.map((item) => item.id))).toEqual([['a'], ['b'], ['c']])
    expect(anyBroken(roster)).toBe(false)
    expect(anyBroken([...roster, entry('d', { definition: null, problems: [{ level: 'error', at: 'brief', text: 'x' }] })])).toBe(true)
    // A warning is not a failure to parse.
    expect(anyBroken([entry('e', { problems: [{ level: 'warning', at: 'name', text: 'x' }] })])).toBe(false)
  })

  it('draws a runtime nobody added by the name the desk gave it', () => {
    const runtimes = [{ id: 'claude-code', presentation: { name: 'Claude' } }] as unknown as RuntimeInfo[]
    expect(markFor(plan().candidates[1]!, runtimes)).toBe(runtimes[0])
    expect(markFor(plan().candidates[0]!, runtimes)).toEqual({ id: 'cursor', presentation: { name: 'Cursor' } })
  })

  it('opens a brief on its first paragraph', () => {
    expect(firstParagraph('You review a change.\nSomebody else wrote it.\n\n## What to review')).toBe(
      'You review a change. Somebody else wrote it.',
    )
  })

  it('keeps the exhaustive switch honest: every SeatReason kind is a case above', () => {
    // A compile-time check as much as a runtime one: if this file's switch
    // ever drops a branch, the object below stops satisfying `SeatReason` and
    // the typecheck — not just this test — fails.
    const kinds: readonly SeatReason['kind'][] = [
      'notInstalled',
      'unknownRuntime',
      'unavailable',
      'noAnswer',
      'signedOut',
      'spent',
      'spentModel',
      'modelsUnread',
      'noModel',
      'noEffort',
      'couldNotOpen',
      'openedOtherwise',
    ]
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  /*
   * `refusalOf` reads a wire refusal, so every candidate is narrowed rather
   * than cast — the Task 5 review's carry-forward for this file.
   */
  it('reads a seatRefused error’s candidates, and only a seatRefused error’s', () => {
    const candidate = {
      seat: { runtime: 'cursor' },
      label: 'Cursor',
      runtimeName: 'Cursor',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'cursor' },
    }
    expect(refusalOf({ code: 'seatRefused', data: { candidates: [candidate] } })).toEqual([candidate])
    // Not that code: not a refusal, whatever shape `data` has.
    expect(refusalOf({ code: 'notFound', data: { candidates: [candidate] } })).toBeNull()
    expect(refusalOf(new Error('boom'))).toBeNull()
    expect(refusalOf(null)).toBeNull()
  })

  it('drops a malformed candidate rather than sinking the whole refusal', () => {
    const good = {
      seat: { runtime: 'codex' },
      label: 'Codex',
      runtimeName: 'Codex',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'codex' },
    }
    const missingRuntime = { ...good, seat: {} }
    const unknownReasonKind = { ...good, reason: { kind: 'somethingNew' } }
    const badLeft = { ...good, left: { kind: 'kept' } } // no `archived`
    for (const bad of [missingRuntime, unknownReasonKind, badLeft]) {
      expect(refusalOf({ code: 'seatRefused', data: { candidates: [bad, good] } })).toEqual([good])
    }
    // Never the error's own message: that is the host's sentence, with a runtime id and a seat spec in it.
    expect(refusalOf({ code: 'seatRefused', message: 'seat cursor=opus-5 refused', data: { candidates: [good] } })).toEqual([good])
  })

  /*
   * Every `SeatLeft` kind (`packages/protocol/src/agent.ts`), and every
   * `SeatArchived` value where a kind carries one.
   */
  it('words what a passed-over seat may have left behind, for every kind and every archived value', () => {
    expect(leftWords({ kind: 'kept', archived: 'here' }, 'Codex')).toBe(
      'Codex may keep the empty conversation it opened — it was put here',
    )
    expect(leftWords({ kind: 'kept', archived: 'runtime' }, 'Codex')).toBe(
      "Codex may keep the empty conversation it opened — it was put in Codex's own archive",
    )
    expect(leftWords({ kind: 'kept', archived: 'failed' }, 'Codex')).toBe(
      'Codex may keep the empty conversation it opened — it was put nowhere, because archiving it failed, so it may still be listed',
    )
    expect(leftWords({ kind: 'undeleted', detail: 'no permission', archived: 'here' }, 'Cursor')).toBe(
      'Cursor refused to delete it ("no permission") — it was put here',
    )
    expect(leftWords({ kind: 'undeleted', detail: 'no permission', archived: 'runtime' }, 'Cursor')).toBe(
      'Cursor refused to delete it ("no permission") — it was put in Cursor\'s own archive',
    )
    expect(leftWords({ kind: 'undeleted', detail: 'no permission', archived: 'failed' }, 'Cursor')).toBe(
      'Cursor refused to delete it ("no permission") — it was put nowhere, because archiving it failed, so it may still be listed',
    )
    expect(leftWords({ kind: 'inUse' }, 'Claude')).toBe('Somebody used the conversation while it was open, so it was left as it is')
    expect(leftWords({ kind: 'alreadyHeld' }, 'Claude')).toBe(
      'Claude answered with a conversation already open here, which was left untouched',
    )
    expect(leftWords({ kind: 'unasked' }, 'Gemini CLI')).toBe(
      'Gemini CLI was gone before it could be asked to delete it, so it may still be in its history',
    )
  })

  it('keeps the exhaustive switch honest: every SeatLeft kind is a case above', () => {
    const kinds: readonly SeatLeft['kind'][] = ['kept', 'undeleted', 'inUse', 'alreadyHeld', 'unasked']
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('says whether a candidate shows a real attempt, never from the dry run alone', () => {
    const passedOver: SeatCandidate = {
      seat: { runtime: 'cursor' },
      label: 'Cursor',
      runtimeName: 'Cursor',
      state: 'passed',
      reason: { kind: 'signedOut' },
      fix: { kind: 'signIn', runtime: 'cursor' },
    }
    expect(anyOpened([passedOver])).toBe(false)
    expect(anyOpened([{ ...passedOver, left: { kind: 'kept', archived: 'here' } }])).toBe(true)
    expect(anyOpened([{ ...passedOver, reason: { kind: 'couldNotOpen', detail: 'timed out' } }])).toBe(true)
    expect(
      anyOpened([{ ...passedOver, reason: { kind: 'openedOtherwise', differences: [{ field: 'model', asked: 'a', running: 'b' }] } }]),
    ).toBe(true)
  })

  /*
   * `plan.blocked` is never shown raw (the test above, on `firstReason`) —
   * this is the sheet's own, roomier wording, read from the entry rather
   * than the host's sentence.
   */
  it('words why an Agent could not be weighed at all, from its own entry — never the host’s path', () => {
    const broken = entry('draft', {
      origin: 'user',
      path: '/Users/dev/.harnessdesk/agents/draft/AGENT.md',
      problems: [{ level: 'error', at: 'prefer[1]', text: '"cursor=" names no seat after the equals sign' }],
    })
    expect(blockedWords(broken, '/Users/dev')).toBe(
      '~/.harnessdesk/agents/draft/AGENT.md: prefer[1] — "cursor=" names no seat after the equals sign',
    )
    // A seating-file problem, or an id nothing answers to, has no entry to read: generic, and names no folder.
    expect(blockedWords(undefined, '/Users/dev')).not.toMatch(/\/Users|~\//)
    expect(blockedWords(entry('clean'), '/Users/dev')).not.toMatch(/\/Users|~\//)
  })
})
