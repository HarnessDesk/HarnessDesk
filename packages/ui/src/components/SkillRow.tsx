import { useMemo } from 'react'

import {
  entryHasProblem,
  isReachProblem,
  type LibraryEntry,
  type ReachState,
} from '@harnessdesk/protocol'

import { RuntimeMark } from './BrandIcons'
import { Rows, RowButton, kit } from '../design/primitives/Kit'
import { Tooltip, TooltipContent, TooltipTrigger } from '../design/ui'
import { REACH_SENTENCE } from '../lib/reach-states'
import type { LibraryColumn } from './LibraryActions'
import styles from './SkillRow.module.css'

/**
 * A skill, as a line in a list of things you have.
 *
 * ——— why this is a Kit row ———
 *
 * It was a card grid first. Claude's skills directory and Codex's skills page
 * are both card grids, copying them read well in a fixture of six entries,
 * and then it was pointed at a real machine — 105 skills — and photographed
 * beside this app's own Plugins page, two rows down the same settings
 * sidebar. They did not look like the same product, and the reason was not
 * the tokens: both were built from `design/ui` on `--hd-` variables, which is
 * why every token, drift and design check passed while the page looked
 * foreign.
 *
 * The reason was the *component*. Every other page in Settings — Plugins,
 * Extensions, the per-agent Skills page, Accounts — draws its list with
 * `Kit.Rows` and `Kit.RowButton`: one bordered container at `--hd-radius-lg`,
 * 14/16 padding, a 34px neutral mark with an inset hairline, title over
 * description, controls and a chevron on the right. A settings page that
 * hand-rolls its own row out of a lower layer is a page that will drift from
 * its neighbours on the next density change, and had already drifted on this
 * one.
 *
 * So this *is* a Plugins row — the same component, not a copy of its look.
 * That is the only version of "consistent" that survives someone editing
 * Kit.module.css. The repo's rule is `design/ui` for new surfaces and `Kit`
 * for the rest; a list inside Settings is not a new surface, it is the same
 * list Settings has always had, with one more thing to say in the control
 * slot. `SkillSheet` stays on `design/ui`, because a dialog is its own
 * surface and every dialog in the app is already that layer.
 *
 * The information design is unchanged — that part was right:
 *
 *   the description is content, not a subtitle    it gets two full lines
 *   the name is also a command                    `/name`, beside the title
 *   who loads it is the thing only we know        agent marks, in the control
 *   reading it is one press                       the chevron, into the sheet
 *
 * One thing the real machine changed on its own merit: the control slot
 * carries a finding only when there *is* one. The first take printed "Never
 * fired here" on 104 of 105 rows — a fact about the machine, repeated until
 * it was worth reading on none of them. It lives in the banner, in the chip
 * that filters to it, and in the sheet.
 */

/**
 * The one or two letters on the mark.
 *
 * Word-initials where the name has words — `code-review` reads as CR, which
 * is recognisable — and the first two letters where it is a single word,
 * because one letter on a tile is a placeholder and two is a monogram.
 *
 * On Kit's own neutral ground, not a tint. A tint would be legitimate by
 * `IconTile`'s rule (it identifies rather than judges) and at a hundred rows
 * a hundred pastel squares stop identifying and start reading as decoration —
 * and every other mark in Settings is this grey.
 */
export const monogramFor = (name: string): string => {
  const words = name.split(/[-_.\s]+/).filter((one) => one !== '')
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase()
  }
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}

/**
 * One agent's mark, saying whether this entry reaches it.
 *
 * Three visual weights, not seven: **loads it** is full strength, **has a
 * problem** wears the warning ground, and everything else is the mark faded.
 * The distinction between `absent` and `unscanned` matters enormously — it is
 * the finding the whole library was built around — and it is a *sentence*,
 * not a shade. Faded means "not this one"; the tooltip and the sheet say
 * which flavour of not, because two greys three percent apart communicate
 * nothing and pretending otherwise invents a legend nobody reads.
 */
const ReachFace = ({
  column,
  state,
  note,
  name,
}: {
  column: LibraryColumn
  state: ReachState
  note?: string | undefined
  name: string
}) => {
  const sentence = note ? `${REACH_SENTENCE[state]} — ${note}` : REACH_SENTENCE[state]
  return (
    <Tooltip>
      {/* `asChild`: this is Radix, and its Trigger renders a <button> by
          default — a button inside the row's own button is invalid markup
          that React warns about and the browser un-nests. */}
      <TooltipTrigger asChild>
        <span
          data-slot="skill-reach"
          data-state={state}
          {...(isReachProblem(state) ? { 'data-problem': '' } : {})}
          aria-label={`${column.label}: ${sentence}`}
          role="img"
          className={styles.face}
        >
          {column.info ? (
            <RuntimeMark runtime={column.info} size={12} />
          ) : (
            <span className={styles.initial}>{column.label[0]}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {column.label} · {name} — {sentence}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The one thing worth saying about this entry in the control slot, or nothing.
 *
 * Ordered by **what the reader would do about it**, which is not the same as
 * by severity. `hollow`, `differs` and `off` all mean nothing reaches, so a
 * naive "reaches nobody first" rule captions an empty directory, a pair of
 * divergent copies and a thrown switch with the same words — naming a symptom
 * whose cause is sitting right there unsaid.
 *
 * Nothing is returned for a healthy entry, and that is the point: a row with
 * no finding is a row the eye can skip, which is what makes the twelve that
 * do have one findable in a list of a hundred.
 */
export const findingFor = (
  entry: LibraryEntry,
  columns: readonly LibraryColumn[],
): { text: string; tone: 'warn' | 'quiet' } | null => {
  if (entry.copies.some((copy) => copy.hollow)) return { text: 'Empty on disk', tone: 'warn' }
  // Before every other finding: an agent that read the definition and refused
  // it has told us something no amount of reading the disk could, and it is
  // the one thing on this row somebody can act on.
  const refused = entry.reach.filter((one) => one.state === 'rejected')
  if (refused.length > 0) {
    const only = refused[0]
    const label =
      refused.length === 1
        ? (columns.find((column) => column.id === only?.runtime)?.label ?? 'one agent')
        : `${refused.length} agents`
    return { text: `Refused by ${label}`, tone: 'warn' }
  }
  const digests = new Set(entry.copies.filter((one) => !one.hollow).map((one) => one.digest))
  if (digests.size > 1) return { text: `${digests.size} copies differ`, tone: 'warn' }

  const offColumns = entry.reach.filter((one) => one.state === 'off')
  if (offColumns.length > 0) {
    if (offColumns.length === entry.reach.length) return { text: 'Switched off', tone: 'quiet' }
    const only = offColumns[0]
    const label =
      offColumns.length === 1
        ? (columns.find((column) => column.id === only?.runtime)?.label ?? 'one agent')
        : `${offColumns.length} agents`
    return { text: `Off in ${label}`, tone: 'quiet' }
  }

  // Said before "loaded by nobody", and quietly: this is the row a second
  // after the page installed something, and the person is looking straight at
  // it to see whether it worked. It did — the caption is the sentence that
  // tells them the last step is the agent's, not theirs.
  const staleColumns = entry.reach.filter((one) => one.state === 'stale')
  if (staleColumns.length > 0) {
    const only = staleColumns[0]
    const label =
      staleColumns.length === 1
        ? (columns.find((column) => column.id === only?.runtime)?.label ?? 'one agent')
        : `${staleColumns.length} agents`
    return { text: `Not read yet by ${label}`, tone: 'quiet' }
  }

  if (entry.reach.length > 0 && entry.reach.every((one) => one.state !== 'reaches')) {
    // The two ways to reach nobody are worth telling apart: a copy in a
    // directory nothing scans is one move from working, and the move is
    // different from the one an absent skill needs.
    return {
      text: entry.copies.some((copy) => copy.readBy.length === 0)
        ? 'Where no agent looks'
        : 'Loaded by nobody',
      tone: 'warn',
    }
  }
  return null
}

/** One skill or one server, as a line. */
export const SkillRow = ({
  entry,
  columns,
  onOpen,
}: {
  entry: LibraryEntry
  columns: readonly LibraryColumn[]
  onOpen: () => void
}) => {
  const finding = useMemo(() => findingFor(entry, columns), [entry, columns])

  return (
    <RowButton
      data-slot="skill-row"
      {...(entryHasProblem(entry) ? { 'data-problem': '' } : {})}
      onClick={onOpen}
      mark={<span className={styles.monogram}>{monogramFor(entry.name)}</span>}
      title={
        <span className={styles.name}>
          <span className={styles.label}>{entry.title ?? entry.name}</span>
          {/* The name written the way it is typed. The identity a skill has on
              disk is the directory name; the identity it has in a composer is
              `/name`, and showing only the first leaves the second to
              guesswork. MCP servers get no slash — they are loaded, not
              invoked. */}
          <code className={`${kit.mono} ${styles.command}`}>
            {entry.kind === 'skill' ? `/${entry.name}` : entry.name}
          </code>
        </span>
      }
      desc={
        /* Clamped at two lines, unlike a plugin's description, because these
           are not ours: a real machine holds skills whose frontmatter runs to
           a paragraph, and one of them unclamped is taller than six rows. */
        <span className={styles.desc}>
          {entry.description ?? <span className={styles.blank}>No description in its frontmatter</span>}
        </span>
      }
      control={
        <>
          {finding && (
            <span className={styles.finding} data-tone={finding.tone}>
              {finding.text}
            </span>
          )}
          <span className={styles.faces}>
            {entry.reach.map((reach, index) => {
              const column = columns[index]
              if (!column) return null
              return (
                <ReachFace
                  key={reach.runtime}
                  column={column}
                  state={reach.state}
                  note={reach.note}
                  name={entry.title ?? entry.name}
                />
              )
            })}
          </span>
        </>
      }
    />
  )
}

/**
 * The rows together, in the container every other Settings list uses.
 *
 * `Kit.Rows` owns the border, the radius and the hairlines — including the
 * `:last-child` exception that a per-row border always forgets.
 */
export const SkillList = ({ children }: { children: React.ReactNode }) => (
  <Rows className={styles.list}>{children}</Rows>
)
