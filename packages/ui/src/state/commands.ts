import type { CapabilityContribution, ConfigOption, RuntimeId } from '@harnessdesk/protocol'

import { offeredHere } from '../lib/contributions'
import { summonable } from '../panels/views'
import type { AppSnapshot, AppStore } from './store'

/**
 * The command surface.
 *
 * Built-in commands and plugin-contributed ones resolve through one registry, so
 * `/deploy` from a plugin behaves exactly like `/model`. Commands either run
 * immediately or open a chooser; that distinction is data, not two code paths.
 */

export interface CommandChoice {
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly selected?: boolean
}

export type CommandKind =
  | { readonly type: 'action'; run(store: AppStore, argument: string): void | Promise<void> }
  | {
      readonly type: 'choose'
      readonly title: string
      choices(snapshot: AppSnapshot): readonly CommandChoice[]
      pick(store: AppStore, choiceId: string): void | Promise<void>
    }

export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  /** Absent means always available. */
  readonly available?: (snapshot: AppSnapshot) => boolean
  readonly kind: CommandKind
  /** Set for plugin-contributed commands, so the menu can attribute them. */
  readonly source?: string
}

const hasSession = (snapshot: AppSnapshot): boolean => snapshot.activeSessionKey !== null

const activeOptions = (snapshot: AppSnapshot): readonly ConfigOption[] =>
  (snapshot.activeSessionKey
    ? snapshot.sessions.get(snapshot.activeSessionKey)?.options
    : undefined) ?? []

/**
 * One command per option the runtime declares — `/model`, `/effort`,
 * `/permissions`, and whatever else it offers — so the slash menu is exactly
 * as wide as the capability surface. A select opens a chooser; a toggle
 * flips. The names are the runtime's option ids, which is why adapters keep
 * them short and stable.
 */
export const optionCommands = (snapshot: AppSnapshot): CommandDefinition[] =>
  activeOptions(snapshot).map((option) =>
    option.type === 'select'
      ? {
          name: option.id,
          description: option.description ?? option.label,
          kind: {
            type: 'choose',
            title: option.label,
            // Re-read at choose time: the list may have changed since the menu
            // was built, and the chooser should show what is true now.
            choices: (current) => {
              const live = activeOptions(current).find((entry) => entry.id === option.id)
              const select = live?.type === 'select' ? live : option
              return select.choices.map((choice) => ({
                id: choice.value,
                label: choice.label,
                ...(choice.description ? { hint: choice.description } : {}),
                selected: choice.value === select.currentValue,
              }))
            },
            pick: (store, choiceId) => store.setOption(option.id, choiceId),
          },
        }
      : {
          name: option.id,
          description: `${option.currentValue ? 'Turn off' : 'Turn on'}: ${option.description ?? option.label}`,
          kind: {
            type: 'action',
            run: (store) => store.setOption(option.id, !option.currentValue),
          },
        },
  )

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  {
    name: 'new',
    description: 'Start a new session in this workspace',
    kind: { type: 'action', run: (store) => store.newDraft() },
  },
  {
    name: 'race',
    description: 'Send one task to two agents, each in its own worktree; the second waits in the sidebar',
    argumentHint: '<task>',
    available: (snapshot) => snapshot.runtimes.length > 1 && Boolean(snapshot.workspace?.git?.branch),
    kind: { type: 'action', run: (store, argument) => void store.raceAgents(argument) },
  },
  {
    name: 'fork',
    description: 'Branch this session, keeping its history',
    available: hasSession,
    kind: { type: 'action', run: (store) => store.forkSession() },
  },
  {
    name: 'rename',
    description: 'Rename this session',
    argumentHint: '<title>',
    available: hasSession,
    kind: {
      type: 'action',
      run: (store, argument) => {
        if (argument.trim().length > 0) return store.renameSession(argument.trim())
        store.notice('info', 'Give the session a name: /rename My session')
      },
    },
  },
  /*
   * Back and forward, as commands as well as keys.
   *
   * The arrows in the window controls were the only route to
   * `navigateBack`/`navigateForward`, and a header narrower than 520px folds
   * them — which a 1000px window reaches with a panel docked and the sidebar
   * away. The palette and the composer read this one list, so an entry here is
   * a palette row and a slash command at once, and neither depends on how much
   * room the header has. The arrows are unchanged; this is a second way in.
   *
   * Offered exactly when there is somewhere to go, which is what the arrows
   * say by being enabled. A palette has no greyed row, so the alternative to
   * withdrawing the entry is offering one that does nothing.
   */
  {
    name: 'back',
    description: 'Go back to what the middle showed before',
    available: (snapshot) => snapshot.navCanBack,
    kind: { type: 'action', run: (store) => store.navigateBack() },
  },
  {
    name: 'forward',
    description: 'Go forward again, after going back',
    available: (snapshot) => snapshot.navCanForward,
    kind: { type: 'action', run: (store) => store.navigateForward() },
  },
  {
    name: 'terminal',
    description: 'Open a terminal beside this pane, inside the runtime’s sandbox',
    kind: { type: 'action', run: (store) => store.openTerminal() },
  },
  {
    name: 'run',
    description: 'Run a command in the sandbox and show its output',
    argumentHint: '<command>',
    kind: {
      type: 'action',
      run: (store, argument) => {
        const command = argument.trim()
        if (command.length === 0) {
          store.notice('info', 'Give it a command: /run npm test')
          return
        }
        return store.openTerminal({ command: ['/bin/sh', '-lc', command] })
      },
    },
  },
  {
    name: 'dev',
    description: 'Start the dev server and open the app when its port appears',
    argumentHint: '[script]',
    kind: {
      type: 'action',
      run: async (store, argument) => {
        const root = storeWorkspaceRoot(store)
        if (!root) {
          store.notice('info', 'Open a project folder first.')
          return
        }
        let script = argument.trim()
        if (!script) {
          try {
            const raw = await store.transport.request('workspace/readFile', {
              runtime: storeRuntime(store),
              path: `${root}/package.json`,
            })
            const parsed = JSON.parse(raw.content) as { scripts?: Record<string, string> }
            script = parsed.scripts?.['dev'] ? 'dev' : parsed.scripts?.['start'] ? 'start' : ''
          } catch {
            // no package.json — fall through to the hint below
          }
        }
        if (!script) {
          store.notice('info', 'No dev or start script found. Name one: /dev serve')
          return
        }
        await store.openTerminal({ command: ['/bin/sh', '-lc', `npm run ${script}`] })
        store.notice('info', `Running npm run ${script} — watching for its port…`)
        store.watchDevServerPort()
      },
    },
  },
  {
    name: 'open',
    description: 'Open a file beside this pane',
    argumentHint: '<path>',
    kind: {
      type: 'action',
      run: (store, argument) => {
        const path = resolvePath(store, argument)
        if (path) store.openFile(path)
        else store.notice('info', 'Give it a path: /open src/index.ts')
      },
    },
  },
  {
    name: 'preview',
    description: 'Preview an HTML, PDF or Markdown file beside this pane',
    argumentHint: '<path>',
    kind: {
      type: 'action',
      run: (store, argument) => {
        const path = resolvePath(store, argument)
        if (path) store.openPreview(path)
        else store.notice('info', 'Give it a path: /preview docs/index.html')
      },
    },
  },
  {
    name: 'workspace',
    description: 'Open a different project folder',
    kind: { type: 'action', run: (store) => store.requestFolderPicker() },
  },
]

/**
 * One command per view that can be summoned by name.
 *
 * Written out by hand until now, which is why `/changes`, `/history`, `/room`
 * and `/board` existed and `/trajectory`, `/agents` and `/activity` did not —
 * three views reachable only from a menu that itself was a hand-written list.
 * A view declares `command` once in `panels/builtins.tsx` and appears here and
 * in the conversation header's View group, or in neither.
 */
const viewCommands = (): CommandDefinition[] =>
  summonable()
    .filter((definition) => definition.command !== undefined)
    .map((definition) => ({
      name: definition.command as string,
      description: `Show ${definition.label}`,
      kind: {
        type: 'action' as const,
        run: (store: AppStore) => store.showView(definition.kind),
      },
    }))

const storeWorkspaceRoot = (store: AppStore): string | null =>
  store.getSnapshot().workspace?.path ?? null

const storeRuntime = (store: AppStore): RuntimeId =>
  (store.getSnapshot().activeRuntime ?? 'codex') as RuntimeId

/** A path argument, resolved against the focused conversation's directory or the workspace. */
const resolvePath = (store: AppStore, argument: string): string | null => {
  const raw = argument.trim()
  if (raw.length === 0) return null
  if (raw.startsWith('/')) return raw
  const snapshot = store.getSnapshot()
  const session = snapshot.activeSessionKey ? snapshot.sessions.get(snapshot.activeSessionKey) : undefined
  const root = session?.cwd ?? snapshot.workspace?.path
  return root ? `${root.replace(/\/$/, '')}/${raw}` : null
}

/** Built-ins plus whatever plugins currently contribute, filtered by availability. */
export const availableCommands = (snapshot: AppSnapshot): CommandDefinition[] => {
  /* What applies where the palette was opened. The renderer is pushed every
     contribution whatever its scope, so a command narrowed to one project,
     one agent or one conversation was listed in all of them — and `command/run`
     would then not find it, because the host applies the scope the palette
     did not. `lib/contributions.ts`. */
  const offered = offeredHere(snapshot, snapshot.activeSessionKey)
  const contributed: CommandDefinition[] = offered
    .filter((entry): entry is Extract<typeof entry, { kind: 'command' }> => entry.kind === 'command')
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
      source: pluginNameOf(snapshot, entry.owner),
      kind: {
        type: 'action' as const,
        run: async (store: AppStore, argument: string) => {
          const handled = await store.runCommand(entry.name, argument)
          if (!handled) store.notice('warning', `Nothing handled /${entry.name}.`)
        },
      },
    }))

  const agentRuntime = snapshot.runtimes.find((entry) => entry.id === snapshot.activeRuntime)
  const agentName = agentRuntime?.presentation.name
  const agentCommands: CommandDefinition[] = snapshot.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: agentName,
    kind: {
      type: 'action' as const,
      run: async (store: AppStore, argument: string) => {
        const text = argument ? `/${skill.name} ${argument}` : `/${skill.name}`
        await store.send([{ type: 'text', text }])
      },
    },
  }))

  return [
    ...optionCommands(snapshot),
    ...BUILTIN_COMMANDS,
    ...viewCommands(),
    ...panelCommands(snapshot, offered),
    ...contributed,
    ...agentCommands,
  ].filter((command) => !command.available || command.available(snapshot))
}

/**
 * One command per plugin panel, so a contributed panel has a way in.
 *
 * A panel with no entry point is a panel nobody can open, and the palette is
 * where the app's own panels are already opened from — `/changes`, `/history`,
 * `/board`. A plugin's arrives beside them rather than needing a place of its
 * own to be discovered.
 *
 * The command opens it in the first area the contribution declares; where it
 * goes after that is the person's, and is remembered per project.
 */
const panelCommands = (
  snapshot: AppSnapshot,
  offered: readonly CapabilityContribution[],
): CommandDefinition[] =>
  offered
    .filter(
      (entry): entry is Extract<CapabilityContribution, { kind: 'ui' }> =>
        entry.kind === 'ui' && Array.isArray(entry.mounts) && entry.mounts.length > 0,
    )
    .map((entry) => ({
      name: entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      description: `Show the ${entry.label} panel`,
      source: pluginNameOf(snapshot, entry.owner),
      kind: {
        type: 'action' as const,
        run: (store: AppStore) => {
          const mounts = entry.mounts ?? []
          const area = mounts[0]
          if (!area) return
          store.showViewIn(area, {
            kind: 'plugin',
            contribution: String(entry.id),
            label: entry.label,
            mounts,
          })
        },
      },
    }))

const pluginNameOf = (snapshot: AppSnapshot, owner: string): string | undefined =>
  snapshot.plugins.find((plugin) => plugin.instanceId === owner)?.identity.name

/** Ranks commands for the `/` menu: prefix matches first, then substring. */
export const matchCommands = (
  commands: readonly CommandDefinition[],
  query: string,
): CommandDefinition[] => {
  const needle = query.toLowerCase()
  if (needle.length === 0) return [...commands]
  return commands
    .map((command) => {
      const name = command.name.toLowerCase()
      if (name.startsWith(needle)) return { command, score: 0 }
      if (name.includes(needle)) return { command, score: 1 }
      if (command.description.toLowerCase().includes(needle)) return { command, score: 2 }
      return null
    })
    .filter((entry): entry is { command: CommandDefinition; score: number } => entry !== null)
    .sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name))
    .map((entry) => entry.command)
}
