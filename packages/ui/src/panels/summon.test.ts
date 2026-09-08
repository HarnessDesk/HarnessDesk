import { expect, it, vi } from 'vitest'

import { sessionKey } from '@harnessdesk/protocol'

import { availableCommands } from '../state/commands'
import { holdsMain } from '../state/layout'
import { emptySnapshot } from '../state/store'
import { summonable, views } from './views'
import './builtins'

/**
 * How a person reaches a view, and the drift this replaces.
 *
 * The panel system settled where a feature *lives* and left how you *summon*
 * it exactly as scattered as it had always been. Measured before this changed:
 * Changes had six entry points, Trajectory had one — a hand-written menu that
 * had already drifted from the list it claimed to draw — and the repository,
 * the board and the room had no header control at all.
 *
 * The entry points are declared on the view now, in `builtins.tsx`, and both
 * surfaces are generated from that. What this pins is the property that makes
 * the change worth anything: **a view is reachable from both places or from
 * neither.** A view added with a `command` and no `menu` is reachable by
 * someone who already knows its name, which is not reachable.
 */

it('every summonable view declares a way in, and it is not half a way', () => {
  for (const definition of summonable()) {
    // `menu` alone is allowed — the browser and the terminal already own
    // commands that take an argument, and a second bare one would shadow them.
    // `tree` is the other way in: a view that takes the *middle* is a
    // destination rather than a panel, so it lives in the session tree beside
    // the conversations. The contract is unchanged — declare a way in, and a
    // whole one — only the set of doors it recognises has grown.
    expect(
      definition.menu === true || definition.tree === true,
      `${definition.kind} is summonable but declares no way in`,
    ).toBe(true)
  }
})

it('and says what it is, so the menu can show it and the palette can search it', () => {
  // The sentences used to live in a table in `Details.tsx` that both surfaces
  // read. Both moved to the registry and the sentences did not, so the menu's
  // hover description became nothing and the palette lost every keyword but
  // the view's own name — with no failure anywhere.
  for (const definition of summonable()) {
    expect(definition.hint, `${definition.kind} has no description`).toBeTruthy()
  }
})

it('the palette offers one command per view that names one', () => {
  const commands = availableCommands(emptySnapshot()).map((entry) => entry.name)
  for (const definition of summonable()) {
    if (definition.command === undefined) continue
    expect(commands, `/${definition.command} is declared but the palette does not offer it`).toContain(
      definition.command,
    )
  }
})

it('and the three that used to be menu-only are now named too', () => {
  // The regression this exists to catch: Trajectory, Agents and Activity were
  // reachable only from a menu that could not be seen until a panel was
  // already open on something else.
  const commands = availableCommands(emptySnapshot()).map((entry) => entry.name)
  for (const name of ['trajectory', 'agents', 'activity']) expect(commands).toContain(name)
})

it('every view says where it opens, rather than leaving it to array order', () => {
  // A default hidden in `mounts[0]` is a behaviour change anyone can cause by
  // tidying a list, and nothing would fail. It is a field now, and it has to
  // name an area the view actually declares.
  for (const definition of views.all()) {
    expect(definition.defaultMount, `${definition.kind} has no default`).toBeDefined()
    expect(
      definition.mounts,
      `${definition.kind} opens somewhere it does not declare`,
    ).toContain(definition.defaultMount)
  }
})

it('a view that needs an argument is not summoned by a bare name', () => {
  // "Open" is not answerable without "open *what*", so a file and a preview
  // keep their own commands and stay out of this list.
  for (const kind of ['file', 'preview', 'conversation']) {
    const definition = views.get(kind)
    expect(definition?.menu ?? false, `${kind} cannot be summoned bare`).toBe(false)
    expect(definition?.command, `${kind} cannot be summoned bare`).toBeUndefined()
  }
})

it('summoning a kind goes through one dispatcher', async () => {
  // Two implementations of "show me Changes" is how six entry points came to
  // disagree about whether it toggles.
  const { AppStore } = await import('../state/store')
  const store = {
    openGitHistory: vi.fn(),
    openTeamBoard: vi.fn(),
    openTeamRoom: vi.fn(),
    openBrowser: vi.fn(),
    openTerminal: vi.fn().mockResolvedValue(undefined),
    setDetailsTab: vi.fn(),
  }
  const showView = (AppStore.prototype as unknown as Record<string, (this: unknown, kind: string) => void>)['showView']
  if (!showView) throw new Error('showView is not on the prototype')
  showView.call(store, 'git')
  showView.call(store, 'activity')
  expect(store.openGitHistory).toHaveBeenCalledOnce()
  expect(store.setDetailsTab).toHaveBeenCalledWith('activity')
})

/**
 * The middle's invariant, said in two places, held to one answer.
 *
 * `holdsMain` is a literal pair in the state layer, because the view registry
 * is a layer above it and cannot be imported there. That is a duplicate, and a
 * duplicate that drifts is worse than the import it avoided: the registry could
 * gain a third view that mounts in `main` while `readWorkbench` went on
 * emptying it out of every saved layout, silently.
 */
it('holdsMain names exactly the views the registry lets into main', () => {
  const declared = views
    .all()
    .filter((definition) => definition.mounts.includes('main'))
    .map((definition) => definition.kind)
    .sort()
  expect(declared).toEqual(['conversation', 'room'])
  for (const definition of views.all()) {
    expect(holdsMain(definition.kind), definition.kind).toBe(declared.includes(definition.kind))
  }
})

it('every view opens somewhere it is allowed to be', () => {
  // `defaultMount` and `mounts` are two fields that must agree; narrowing one
  // without the other is how a view ends up with a default it cannot take.
  for (const definition of views.all()) {
    expect(definition.mounts, `${definition.kind} declares somewhere to mount`).not.toHaveLength(0)
    expect(definition.mounts, `${definition.kind} opens in an area it declares`).toContain(
      definition.defaultMount,
    )
  }
})

it('the background-task panel says when it has something still going, for the doors that wear a dot', () => {
  // Every door to a view — the ⋯ item, the docked tab, the sidebar row —
  // reads one predicate, so "there is something in here to look at" cannot
  // be true on one door and false on another.
  const definition = views.get('tasks')
  if (!definition?.live) throw new Error('the tasks view declares no liveness')
  const key = sessionKey('alpha', 's1')
  const running = { id: 't1', label: 'Watch', kind: 'command', state: 'running', stoppable: true } as const
  const over = { ...running, id: 't2', state: 'completed', stoppable: false } as const
  const idle = emptySnapshot()
  expect(definition.live(idle)).toBe(false)
  expect(definition.live({ ...idle, activeSessionKey: key, tasks: new Map([[key, [over]]]) })).toBe(false)
  expect(definition.live({ ...idle, activeSessionKey: key, tasks: new Map([[key, [over, running]]]) })).toBe(true)
  // Another conversation's task is that conversation's business.
  expect(definition.live({ ...idle, activeSessionKey: sessionKey('alpha', 's2'), tasks: new Map([[key, [running]]]) })).toBe(false)
})
