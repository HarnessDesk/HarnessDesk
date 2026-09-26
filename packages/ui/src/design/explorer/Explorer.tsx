import { Suspense, lazy, useEffect, useState } from 'react'

import { Boundary } from '../../preview/boundary'
import { PropagationPage } from '../showcase/PropagationPage'

import { Button, GroupLabel, Input, Segmented } from '..'
import { CATALOG_ENTRIES } from '../catalog/manifest'
import { BOARDS } from './boards'
import { COMPOSITION_BOARDS } from './boards-compositions'

/**
 * The whole-screen surfaces, behind a split.
 *
 * They mount the app's own screens, so they drag in the store, the layout
 * model and every component a screen reaches for. Loading that eagerly would
 * put it in the same chunk as the primitive boards and quietly retire the one
 * thing this entry proves by building at all: that a primitive needs none of
 * it. Split here, the proof survives and the surfaces still show the shipped
 * screen rather than a drawing of one.
 *
 * Each handle writes its own `import(…).then((m) => m.X)` rather than sharing
 * a helper that returns the import. Vite emits one chunk either way; what
 * differs is what `script/ui-catalog.mjs` can read. This shape names the one
 * export a tab loads, which is what lets the catalogue check that the tab for
 * a row mounts that row's screen — a shared helper hides the export, and
 * every tab then looks like it loads all of them.
 */
const ComposerSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.ComposerSurface })))
const DashboardSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.DashboardSurface })))
const ConversationSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.ConversationSurface })))
const GitSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.GitSurface })))
const GroupSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.GroupSurface })))
const PanelsSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.PanelsSurface })))
const RailSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.RailSurface })))
const ToolsSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.ToolsSurface })))
const SignInSurface = lazy(() => import('../surfaces/surfaces').then((m) => ({ default: m.SignInSurface })))
import { FOUNDATIONS, TOKEN_GROUPS, tokenVisual, useResolvedTokens } from './foundation'
import styles from './explorer.module.css'

/**
 * The dials, live.
 *
 * A foundation is a whole design swapped at once, which answers "what would
 * this look like as a different product". These answer the smaller question
 * asked far more often — *is this one value right* — by writing a single token
 * onto `body`, which is the same mechanism a foundation uses and the same one a
 * user-defined theme would.
 *
 * Only three, and each is a value the whole interface turns on: how round
 * things are, how tall a control is, and what the brand colour is. A dial per
 * token would be a token inspector, which the Tokens board already is.
 */
const DIALS = [
  {
    id: 'radius',
    label: 'Corners',
    token: '--hd-radius',
    /* The three shapes also move the control radius with them, so a squared
       foundation does not leave pill-shaped buttons behind. */
    also: (value: string) => ({
      '--hd-radius-sm': value === '0px' ? '0px' : value === '14px' ? '10px' : '6px',
      '--hd-radius-lg': value === '0px' ? '0px' : value === '14px' ? '18px' : '14px',
    }),
    options: [
      { value: '0px', label: 'square' },
      { value: '10px', label: 'default' },
      { value: '14px', label: 'round' },
    ],
  },
  {
    id: 'density',
    label: 'Density',
    token: '--hd-control-h',
    also: (value: string) => ({
      '--hd-row-h': value === '24px' ? '28px' : value === '32px' ? '36px' : '30px',
      '--hd-chip-h': value === '24px' ? '20px' : value === '32px' ? '24px' : '22px',
    }),
    options: [
      { value: '24px', label: 'tight' },
      { value: '26px', label: 'default' },
      { value: '32px', label: 'roomy' },
    ],
  },
  {
    id: 'accent',
    label: 'Accent',
    token: '--hd-accent',
    also: (value: string) => ({ '--hd-accent-hover': value, '--hd-accent-dim': `color-mix(in srgb, ${value} 14%, transparent)` }),
    /* The desk's own blue is this dial's first option and its default; the
       others are here to prove the layer follows an accent, not to propose a
       rebrand. */
    fallback: 0,
    options: [
      { value: 'rgb(86, 118, 232)', label: 'desk' },
      { value: 'rgb(15, 152, 137)', label: 'teal' },
      { value: 'rgb(118, 75, 220)', label: 'violet' },
      { value: 'rgb(23, 23, 23)', label: 'ink' },
    ],
  },
] as const

/**
 * The surface pages: whole screens rather than component matrices.
 *
 * A component board asks "is this piece right in all its states". These ask the
 * question a board cannot: "does the set of pieces make a screen". Each one
 * mounts a screen the app ships (`design/surfaces/surfaces.tsx`), so the
 * `about` under it describes what that screen shows *on this page's fixture*
 * — which is less than every state the screen has. Say what is on the page,
 * and name what is not: a description written for a richer picture than the
 * tab renders is the same lie as a drawing, in words.
 */
const SURFACES = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    about:
      "The shipped Dashboard — what is left on each plan, what it cost and where it went — as ⌘U opens it, on the preview's four agents. It is a window of its own, so it sits in a window-sized frame here.",
    render: DashboardSurface,
  },
  {
    id: 'group',
    title: 'Group project',
    about:
      'The team board and the room it belongs to, side by side — the shipped `TeamBoardPane` and `TeamRoomPane` on the preview\'s Checkout rewrite room: five columns of work, the claimed card naming the agent session that holds it, and the room\'s chat and members beside. Where the room stands in the workspace list is on the Left bar tab.',
    render: GroupSurface,
  },
  {
    id: 'conversation',
    title: 'Conversation',
    about:
      'The shipped conversation — header, transcript and composer — on the preview\'s Worktree Management session: a question, the agent\'s thinking, one command, one file change, and the answer. It does not yet show an approval, a refused or failed tool call, a plan, attachments, a compaction or a turn still running: the fixture has no session in those states, and this tab shows the fixture.',
    render: ConversationSurface,
  },
  {
    id: 'composer',
    title: 'Composer',
    about:
      'The shipped composer alone, at the width the conversation gives it, resting on an idle session. Its other states — carrying attachments, running, queued behind a turn, nearly out of context — need a session in that state, and the fixture has none yet.',
    render: ComposerSurface,
  },
  {
    id: 'rail',
    title: 'Left bar',
    about:
      'The sidebar at the density it actually stands at, inside a frame the width of a window — because the whole question about a rail is how much attention it takes from the work beside it, and a rail alone on a white page always looks fine.',
    render: RailSurface,
  },
  {
    id: 'git',
    title: 'Git history',
    about:
      'The shipped repository pane on a small fixture history: a feature branch merged back, one still open, a tag, a remote a commit ahead, and a stash, with lanes coloured by identity rather than by judgement. Click a row for the commit.',
    render: GitSurface,
  },
  {
    id: 'panels',
    title: 'Panels',
    about:
      'The workbench the window renders — sidebar, main area, Changes and Trajectory in the right dock, a terminal in the bottom — on a store of its own so its docks start full; the app itself opens with them empty. Its controls are real: switching a tab, hiding a dock, moving, splitting and resizing run the same functions the app\'s store runs. Press Hide this panel.',
    render: PanelsSurface,
  },
  {
    id: 'tools',
    title: 'Browser · Terminal · Editor',
    about:
      'The shipped browser, editor and terminal panes, in the frame they share. What differs between them is only what each tool genuinely is; the header, the mark, the subject line, the tab strip and whether the body pads or bleeds are one component. On this page the browser can only plan pages, the editor shows the real source of `lib/brands.ts`, and the terminal redraws a fixture\'s scrollback with no shell behind it — nothing new arrives, and typing goes nowhere.',
    render: ToolsSurface,
  },
  {
    id: 'signin',
    title: 'Sign in',
    about:
      'The shipped Sign in dialog on the sign-in preview\'s roster, open on Claude while its browser sign-in waits: the command asked for the code the page shows when it cannot finish by itself, so the card asks for it in a password field, beside the page and the cancel. The dialog\'s other states — a refusal, a key, a device code, an account connected — are scenes of `/preview.html`, not of this tab.',
    render: SignInSurface,
  },
  {
    id: 'propagation',
    title: 'Foundation propagation',
    about:
      'Not a screen — a test rig, kept on this page because two browser specs drive it. Every part of it is a production implementation (Settings furniture, Composer, a portal dialog, a menu, a board, CodeMirror, the xterm option bridge) gathered under one test-only token scope, so that one token change can be shown reaching all of them at once.',
    render: PropagationPage,
  },
] as const

type DialState = Record<string, string>

const DIAL_DEFAULTS: DialState = Object.fromEntries(
  DIALS.map((dial) => [
    dial.id,
    dial.options[('fallback' in dial ? dial.fallback : 1) as number]?.value ??
      dial.options[0]!.value,
  ]),
)

/**
 * The design system, rendered by the design system.
 *
 * Two switches at the top, and between them they answer the question a
 * redesign actually poses: *what would everything look like if we did this?*
 *
 *   theme        light · dark · system
 *   foundation   the token set in force
 *
 * Because every board below renders the real component, pointing the page at
 * a candidate foundation shows the whole system under a proposed design
 * before a single product file is touched. A shadcn evaluation is: write the
 * candidate token file, flip this switch, look.
 */
/**
 * The explorer's own nav item.
 *
 * Deliberately not a `SettingsRow`: a catalog item is never one of a settings set, so it has
 * no selected state, and giving it one to serve this page would push a
 * requirement from the documentation up into the system it documents. The
 * explorer is a screen like any other, and screens own their own furniture.
 */
const NavItem = ({
  title,
  selected,
  onClick,
}: {
  title: string
  selected: boolean
  onClick: () => void
}) => (
  <Button
    variant="navigation"
    size="navigation"
    data-selected={selected || undefined}
    className={styles.navControl}
    onClick={onClick}
  >
    {title}
  </Button>
)

export const Explorer = () => {
  const [boardId, setBoardId] = useState<string>(() => new URLSearchParams(window.location.search).get('view') ?? 'showcase')
  const [query, setQuery] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  const [foundation, setFoundation] = useState<string>(FOUNDATIONS[0]?.id ?? 'current')
  const [dials, setDials] = useState<DialState>(DIAL_DEFAULTS)

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('view', boardId)
    window.history.replaceState(null, '', url)
  }, [boardId])

  useEffect(() => {
    const dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    // The same attribute the product writes (see state/theme.ts). It was
    // `data-ds-dark-theme` here for as long as this page has existed, which no
    // stylesheet has ever matched: every board rendered light, the toggle did
    // nothing, and the one page whose job is to prove the tokens work was the
    // one page that could not show half of them.
    document.body.toggleAttribute('data-hd-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [theme])

  useEffect(() => {
    /* Written after the foundation's own overrides so a dial is the last word,
       and removed on change so turning one back to its default really restores
       the token rather than pinning it at the value it happened to have. */
    for (const dial of DIALS) {
      const value = dials[dial.id]
      if (value == null) continue
      document.body.style.setProperty(dial.token, value)
      for (const [name, extra] of Object.entries(dial.also(value))) {
        document.body.style.setProperty(name, extra)
      }
    }
    return () => {
      for (const dial of DIALS) {
        document.body.style.removeProperty(dial.token)
        for (const name of Object.keys(dial.also(dials[dial.id] ?? ''))) {
          document.body.style.removeProperty(name)
        }
      }
    }
  }, [dials])

  useEffect(() => {
    const chosen = FOUNDATIONS.find((one) => one.id === foundation)
    // A foundation is a set of token overrides, applied where the cascade puts
    // them last. This is exactly the mechanism a user-defined theme would use.
    for (const [name, value] of Object.entries(chosen?.overrides ?? {})) {
      document.body.style.setProperty(name, value)
    }
    return () => {
      for (const name of Object.keys(chosen?.overrides ?? {})) {
        document.body.style.removeProperty(name)
      }
    }
  }, [foundation])

  const board = [...BOARDS, ...COMPOSITION_BOARDS].find((one) => one.id === boardId)
  const surface = SURFACES.find((one) => one.id === boardId)
  const match = (title: string): boolean => title.toLowerCase().includes(query.trim().toLowerCase())
  const primitiveBoards = BOARDS.filter((one) => match(one.title))
  const patternBoards = COMPOSITION_BOARDS.filter((one) => match(one.title))
  const productSurfaces = SURFACES.filter((one) => match(one.title))

  return (
    <div className={styles.shell}>
      <nav className={styles.nav}>
        <div className={styles.brand}>Design system</div>
        <Input
          className={styles.navSearch}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find components"
          aria-label="Find components"
        />
        <GroupLabel as="div" className={styles.section}>Foundation</GroupLabel>
        <NavItem
          title="Foundation"
          selected={boardId === 'foundation'}
          onClick={() => setBoardId('foundation')}
        />
        <GroupLabel as="div" className={styles.section}>Primitives</GroupLabel>
        {primitiveBoards.map((one) => (
          <NavItem
            key={one.id}
            title={one.title}
            selected={boardId === one.id}
            onClick={() => setBoardId(one.id)}
          />
        ))}
        <GroupLabel as="div" className={styles.section}>Patterns</GroupLabel>
        {patternBoards.map((one) => (
          <NavItem
            key={one.id}
            title={one.title}
            selected={boardId === one.id}
            onClick={() => setBoardId(one.id)}
          />
        ))}
        <GroupLabel as="div" className={styles.section}>Product Surfaces</GroupLabel>
        {productSurfaces.map((one) => (
          <NavItem
            key={one.id}
            title={one.title}
            selected={boardId === one.id}
            onClick={() => setBoardId(one.id)}
          />
        ))}
        <GroupLabel as="div" className={styles.section}>Coverage</GroupLabel>
        <NavItem title="Manifest" selected={boardId === 'coverage'} onClick={() => setBoardId('coverage')} />
      </nav>
      <main className={styles.main}>
        <div className={styles.bar}>
          {DIALS.map((dial) => (
            <div key={dial.id} className={styles.dial}>
              <span className={styles.switchLabel}>{dial.label}</span>
              <Segmented
                label={dial.label}
                value={dials[dial.id] ?? dial.options[0]!.value}
                onChange={(next) => setDials((prior) => ({ ...prior, [dial.id]: next }))}
                options={dial.options}
              />
            </div>
          ))}
          <div className={styles.dial}>
            <span className={styles.switchLabel}>Foundation</span>
            <Segmented
              label="Foundation"
              value={foundation}
              onChange={setFoundation}
              options={FOUNDATIONS.map((one) => ({ value: one.id, label: one.title }))}
            />
          </div>
          <div className={styles.dial}>
            <span className={styles.switchLabel}>Theme</span>
            <Segmented
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: 'light' },
                { value: 'dark', label: 'dark' },
                { value: 'system', label: 'system' },
              ]}
            />
          </div>
        </div>
        <div className={styles.body}>
          {boardId === 'coverage' ? (
            <CoverageBoard />
          ) : surface ? (
            <>
              <h1 className={styles.boardTitle}>{surface.title}</h1>
              <p className={styles.boardAbout}>{surface.about}</p>
              <Boundary key={surface.id}>
                <Suspense fallback={<p className={styles.boardAbout}>Mounting the screen…</p>}>
                  <surface.render />
                </Suspense>
              </Boundary>
            </>
          ) : board ? (
            <>
              <h1 className={styles.boardTitle}>{board.title}</h1>
              <p className={styles.boardAbout}>{board.about}</p>
              {/* One board's crash is one board's crash. Without this an
                  uncaught render error unmounts the whole explorer, and every
                  tab after the broken one disappears with it — which is how a
                  bad icon board once took thirty tabs down with it. Keyed so a
                  latched error clears when you move to another board. */}
              <Boundary key={board.id}>
                <board.render />
              </Boundary>
            </>
          ) : (
            <FoundationBoard />
          )}
        </div>
      </main>
    </div>
  )
}

const CoverageBoard = () => (
  <>
    <h1 className={styles.boardTitle}>Coverage</h1>
    <p className={styles.boardAbout}>
      The checked-in catalog manifest ties every canonical implementation to its live example and
      representative production consumers. The catalog gate fails when a primitive or pattern is
      added or removed without updating this registry.
    </p>
    <div className={styles.coverage}>
      {CATALOG_ENTRIES.map((entry) => (
        <div className={styles.coverageRow} key={entry.id}>
          <code>{entry.id}</code>
          <span>{entry.category}</span>
          <span>{entry.purpose}</span>
          <span className={styles.coverageStates}>
            {entry.variants.join(' · ')} / {entry.states.join(' · ')}
          </span>
          <a href={`?view=${entry.exampleId}`}>Open example</a>
        </div>
      ))}
    </div>
  </>
)

/** What every token currently resolves to, read from the live document. */
const FoundationBoard = () => {
  const tokens = useResolvedTokens()
  return (
    <>
      <h1 className={styles.boardTitle}>Tokens</h1>
      <p className={styles.boardAbout}>
        Every value the system decides, read from the live document rather than from a list someone
        maintains. Change the foundation or the theme above and these change with it — if a value
        here is wrong, the app is wrong.
      </p>
      {TOKEN_GROUPS.map((group) => (
        <section key={group.title}>
          <GroupLabel as="div" className={styles.section}>{group.title}</GroupLabel>
          <div className={styles.tokens}>
            {tokens
              .filter((token) => group.match(token.name))
              .map((token) => {
                const visual = tokenVisual(token.name, group.kind, token.value)
                return (
                  <div key={token.name} className={styles.token}>
                    <span className={styles.tokenSlot}>
                      {visual === 'color' && (
                        <span className={styles.swatch} style={{ background: token.value }} />
                      )}
                      {visual === 'space' && (
                        <span className={styles.spaceBar} style={{ width: token.value }} />
                      )}
                      {visual === 'radius' && (
                        <span className={styles.radiusSample} style={{ borderRadius: token.value }} />
                      )}
                      {visual === 'shadow' && (
                        <span className={styles.shadowSample} style={{ boxShadow: token.value }} />
                      )}
                    </span>
                    <span className={styles.tokenName}>{token.name}</span>
                    <span className={styles.tokenValue} title={token.value}>{token.value}</span>
                  </div>
                )
              })}
          </div>
        </section>
      ))}
    </>
  )
}
