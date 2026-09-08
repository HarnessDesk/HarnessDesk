import type * as React from 'react'

import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from './avatar'
import { softTint, tintFor } from './tone'

/**
 * Who is on this, in the width of one avatar and a bit.
 *
 * The overlap is the whole point — it says *these people belong to this one
 * thing* in a way a row of separated squares does not, and it costs a fixed
 * amount of space no matter how many there are. Past `max` the remainder
 * collapses into a count, because a card assigned to nine agents needs to
 * report the nine, not draw them.
 *
 * The ring around each face is the card's own colour rather than white: an
 * avatar stack sits on a card in dark mode as often as in light, and a white
 * hairline there reads as a mistake.
 *
 * A member with no image falls back to initials on a tint chosen from its own
 * name — the same face gets the same colour on every screen, without anyone
 * storing a colour per user. The tint identifies and does not judge, which is
 * the rule tone.ts sets out.
 */

export type StackMember = {
  /** Shown in the tooltip and used to pick the fallback tint. */
  name: string
  src?: string
  /** Two characters at most; derived from the name when absent. */
  initials?: string
  /**
   * A glyph to wear instead of initials &mdash; the agent's harness mark.
   *
   * In a group project the members are not people, they are runtimes, and
   * *which harness* is the decision somebody made. "CC" and "CO" are two
   * letters a reader has to learn; the Claude and Codex marks are the thing
   * they already know from the sign-in screen and the model picker.
   */
  mark?: React.ReactNode
}

/*
 * Two characters, and for a one-word name they are the first two rather than
 * the first one. "Codex" and "Cursor" both reduce to C otherwise, which on a
 * board of agent avatars is not a cosmetic problem: two different agents wear
 * the same mark, and the tint that would have told them apart is derived from
 * the name and so differs — leaving one letter in two colours, which reads as
 * a rendering bug rather than as two agents.
 */
const initialsFor = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase()
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}

type AvatarStackProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  members: StackMember[]
  /** How many faces before the rest become a count. */
  max?: number
  size?: 'sm' | 'default'
  /** Circles read as people, squares as things. The app's default is squares. */
  shape?: 'square' | 'round'
}

const AvatarStack = ({
  className,
  members,
  max = 4,
  size = 'default',
  shape = 'square',
  ...props
}: AvatarStackProps) => {
  const shown = members.slice(0, max)
  const overflow = members.length - shown.length
  const box = size === 'sm' ? 'size-5 text-xs' : 'size-6 text-xs'
  const corner = shape === 'round' ? 'rounded-full' : 'rounded-md'

  return (
    <div
      data-slot="avatar-stack"
      /* The ring is drawn with a border in the card's colour so the faces
         separate without a gap; `-space-x` pulls them back over each other. */
      className={cn('flex items-center', size === 'sm' ? '-space-x-1' : '-space-x-1.5', className)}
      {...props}
    >
      {shown.map((member) => (
        <Avatar
          key={member.name}
          title={member.name}
          /* The name, on the root, always. Initials happen to spell it; a
             `BrandMark` is `aria-hidden` and spells nothing, so a member
             wearing a mark would otherwise be an unnamed image with a `title`
             &mdash; and `title` is not an accessible name any screen reader can
             be relied on to read. */
          role="img"
          aria-label={member.name}
          className={cn(box, corner, 'border border-(--hd-card) bg-(--hd-card)')}
        >
          {/* The root carries the name, so the image must not repeat it. */}
          {member.src && <AvatarImage src={member.src} alt="" />}
          <AvatarFallback
            aria-hidden="true"
            className={cn(
              corner,
              'font-medium [&_svg]:size-3.5',
              softTint({ tint: tintFor(member.name) }),
            )}
          >
            {member.mark ?? member.initials ?? initialsFor(member.name)}
          </AvatarFallback>
        </Avatar>
      ))}
      {overflow > 0 && (
        <span
          title={members
            .slice(max)
            .map((member) => member.name)
            .join(', ')}
          className={cn(
            box,
            corner,
            'flex items-center justify-center border border-(--hd-card) bg-(--hd-muted) font-medium text-(--hd-muted-foreground) tabular-nums',
          )}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

export { AvatarStack }
