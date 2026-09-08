import { useEffect, useState } from 'react'

import { Btn } from '..'
import { BOARDS } from './boards'
import { COMPOSITION_BOARDS } from './boards-compositions'
import { ComposerBoard } from '../showcase/ComposerBoard'
import { ConversationPage } from '../showcase/ConversationPage'
import { GitHistoryPage } from '../showcase/GitHistoryPage'
import { GroupProject } from '../showcase/GroupProject'
import { PanelPlayground } from '../showcase/PanelPlayground'
import { RailBoard } from '../showcase/RailBoard'
import { Showcase } from '../showcase/Showcase'
import { ToolsPage } from '../showcase/ToolsPage'
import { FOUNDATIONS, TOKEN_GROUPS, useResolvedTokens } from './foundation'
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
 * question a board cannot: "does the set of pieces make a screen". They are
 * listed here rather than in `BOARDS` because they render a page and take the
 * body's whole width, and because none of them is a component anyone imports.
 */
const SURFACES = [
  {
    id: 'showcase',
    title: 'Dashboard',
    about:
      'A page that does not exist, built only out of parts that do. Every board here shows a component against a plain ground with its states beside it, which is the right way to check one and a poor way to judge one: a stat tile that looks confident alone can be illegible in a row of four. The knobs below change the composition; the bar above changes the design underneath it.',
    render: Showcase,
  },
  {
    id: 'group',
    title: 'Group project',
    about:
      'Several harnesses on one goal, with a board between them. Three claims the layout is built to make true: a group project is a project rather than a mode, so it stands in the workspace list beside ordinary sessions under its own mark; the agents are deliberately not alike, so the harness mark appears wherever a member does; and the board, the agent and the conversation are one triangle — a task names the harness holding it, pressing that harness opens its conversation, and the conversation names the task and offers the way back. Press a harness on a card, or Claim with on an unclaimed one.',
    render: GroupProject,
  },
  {
    id: 'conversation',
    title: 'Conversation',
    about:
      'One transcript carrying every kind of thing a transcript can carry — prose, thinking, a published plan, nine tool calls with one of them refused and one failed, a diff, attachments, an approval that stops you, a compaction, and a turn still running. Not a tidy sample: the grading only proves itself under all of it at once, in one column, at the width the app actually gives it.',
    render: ConversationPage,
  },
  {
    id: 'composer',
    title: 'Composer',
    about:
      'The one component a user touches on every turn, in the five states it is really in — resting, carrying attachments, running, queueing behind a turn, and nearly out of context. All five are the same shell; what differs is what is inside it, which is the test that the shell is right.',
    render: ComposerBoard,
  },
  {
    id: 'rail',
    title: 'Left bar',
    about:
      'The sidebar at the density it actually stands at, inside a frame the width of a window — because the whole question about a rail is how much attention it takes from the work beside it, and a rail alone on a white page always looks fine.',
    render: RailBoard,
  },
  {
    id: 'git',
    title: 'Git history',
    about:
      'The repository as history rather than status: a graph that answers what happened, a detail pane that answers what exactly, and lanes coloured by identity rather than by judgement. Click a row.',
    render: GitHistoryPage,
  },
  {
    id: 'panels',
    title: 'Panels',
    about:
      'The panel system, driven by nothing but itself: the real chrome over the real model, with `useState` where the app has a store and coloured stubs where the app has features. That is the argument, made by construction — if docking, resizing, collapsing and expanding all work with no store, no socket and no agent, then the model owes nothing to the features and a feature owes nothing to its position. Drag a tab onto another area; only the areas that view declares will light up. Press Expand twice. Collapse the bottom panel and note that its tabs stay, because that is the way back.',
    render: PanelPlayground,
  },
  {
    id: 'tools',
    title: 'Browser · Terminal · Editor',
    about:
      'Every tool in the frame they share. What differs between the panes is only what a terminal genuinely is versus what a browser genuinely is; everything else — the header, the mark, the subject line, the tab strip, whether the body pads or bleeds — is one component, which is what stops five panes drifting into five layouts.',
    render: ToolsPage,
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
 * Deliberately NOT `Kit.Row`: a settings row is never one of a set, so it has
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
  <button
    type="button"
    className={styles.navItem}
    onClick={onClick}
    {...(selected ? { 'data-selected': '' } : {})}
  >
    {title}
  </button>
)

export const Explorer = () => {
  const [boardId, setBoardId] = useState<string>('showcase')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  const [foundation, setFoundation] = useState<string>(FOUNDATIONS[0]?.id ?? 'current')
  const [dials, setDials] = useState<DialState>(DIAL_DEFAULTS)

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

  return (
    <div className={styles.shell}>
      <nav className={styles.nav}>
        <div className={styles.brand}>Design system</div>
        <div className={styles.section}>Foundation</div>
        <NavItem
          title="Tokens"
          selected={boardId === 'foundation'}
          onClick={() => setBoardId('foundation')}
        />
        <div className={styles.section}>Primitives</div>
        {BOARDS.map((one) => (
          <NavItem
            key={one.id}
            title={one.title}
            selected={boardId === one.id}
            onClick={() => setBoardId(one.id)}
          />
        ))}
        <div className={styles.section}>Compositions</div>
        {COMPOSITION_BOARDS.map((one) => (
          <NavItem
            key={one.id}
            title={one.title}
            selected={boardId === one.id}
            onClick={() => setBoardId(one.id)}
          />
        ))}
        <div className={styles.section}>Surfaces</div>
        {SURFACES.map((one) => (
          <NavItem
            key={one.id}
            title={one.title}
            selected={boardId === one.id}
            onClick={() => setBoardId(one.id)}
          />
        ))}
      </nav>
      <main className={styles.main}>
        <div className={styles.bar}>
          {DIALS.map((dial) => (
            <div key={dial.id} className={styles.switch}>
              <span className={styles.switchLabel}>{dial.label}</span>
              {dial.options.map((option) => (
                <Btn
                  key={option.value}
                  small
                  variant={dials[dial.id] === option.value ? 'primary' : 'quiet'}
                  onClick={() => setDials((prior) => ({ ...prior, [dial.id]: option.value }))}
                >
                  {option.label}
                </Btn>
              ))}
            </div>
          ))}
          <span className={styles.barSpacer} />
          <div className={styles.switch}>
            <span className={styles.switchLabel}>Foundation</span>
            {FOUNDATIONS.map((one) => (
              <Btn
                key={one.id}
                small
                variant={foundation === one.id ? 'primary' : 'quiet'}
                onClick={() => setFoundation(one.id)}
                title={one.about}
              >
                {one.title}
              </Btn>
            ))}
          </div>
          <div className={styles.switch}>
            <span className={styles.switchLabel}>Theme</span>
            {(['light', 'dark', 'system'] as const).map((one) => (
              <Btn
                key={one}
                small
                variant={theme === one ? 'primary' : 'quiet'}
                onClick={() => setTheme(one)}
              >
                {one}
              </Btn>
            ))}
          </div>
        </div>
        <div className={styles.body}>
          {surface ? (
            <>
              <h1 className={styles.boardTitle}>{surface.title}</h1>
              <p className={styles.boardAbout}>{surface.about}</p>
              <surface.render />
            </>
          ) : board ? (
            <>
              <h1 className={styles.boardTitle}>{board.title}</h1>
              <p className={styles.boardAbout}>{board.about}</p>
              <board.render />
            </>
          ) : (
            <FoundationBoard />
          )}
        </div>
      </main>
    </div>
  )
}

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
          <div className={styles.section}>{group.title}</div>
          <div className={styles.tokens}>
            {tokens
              .filter((token) => group.match(token.name))
              .map((token) => (
                <div key={token.name} className={styles.token}>
                  {group.kind === 'color' && (
                    <span className={styles.swatch} style={{ background: token.value }} />
                  )}
                  {group.kind === 'space' && (
                    <span className={styles.swatch} style={{ width: token.value, background: 'var(--hd-primary)' }} />
                  )}
                  <span className={styles.tokenName}>{token.name}</span>
                  <span className={styles.tokenValue}>{token.value}</span>
                </div>
              ))}
          </div>
        </section>
      ))}
    </>
  )
}
