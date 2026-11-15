import type { AvatarId } from './avatars'

/**
 * Legacy local profile preferences, retained for compatibility.
 *
 * Account identity and desk naming have separate owners. The old avatar is
 * used only as an application-icon migration fallback until appIcon is
 * explicitly chosen or reset. Reading never rewrites this profile: names,
 * unknown artwork and future fields survive through storedProfile unchanged,
 * apart from the unsafe text controls described below. Existing callers may
 * still edit the legacy shape; account edits never pass through it.
 */
export interface Profile {
  /**
   * What you are called, as stored: tidied when typed here, as written when
   * not — less the controls no name carries (`HIDDEN_CONTROLS`). Absent means
   * the default.
   */
  readonly name?: string
  /**
   * Which face, as stored: one of the ids this build ships, or whatever a
   * later build wrote there — kept, and drawn as the house mark. Absent is the
   * house mark.
   */
  readonly avatar?: unknown
  /**
   * Every other field the stored profile had — a later build's — kept as it
   * was and written back beside the two this build knows (`storedProfile`). In
   * a bag of its own rather than under an index signature, so the interface
   * stays closed: a misspelled read of `name` or `avatar` fails to compile,
   * where it would otherwise draw the default forever.
   */
  readonly later?: Readonly<Record<string, unknown>>
}

/** A change to the profile. `null` puts that field back to its default. */
export interface ProfilePatch {
  readonly name?: string | null
  readonly avatar?: AvatarId | null
}

/** The name nobody chose: the product's own, until you give it yours. */
export const DEFAULT_PROFILE_NAME = 'HarnessDesk'

/**
 * Long enough for a full name, short enough that the seat's row cuts it with
 * an ellipsis rather than the name crowding out the agent badge beside it.
 * Counted in characters as a person sees them — a flag or a family emoji is
 * one, and none is cut in half — here, and by the field that types it. It
 * holds what is typed here: a name a later build let run longer is kept as it
 * is until it is edited.
 */
export const PROFILE_NAME_MAX = 40

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/**
 * A string as the characters a person sees: grapheme clusters, so 🇺🇸 is one
 * and not two. Code points where `Intl.Segmenter` is missing.
 */
export const characters = (text: string): string[] =>
  graphemes ? Array.from(graphemes.segment(text), (part) => part.segment) : Array.from(text)

/**
 * The invisible controls a name may not carry, wherever it came from: the
 * bidirectional embeddings, overrides and isolates (U+202A–U+202E,
 * U+2066–U+2069), which reorder the characters around them, and the zero-width
 * space (U+200B), which hides itself inside the name. None of them is spelling,
 * and a name that reads one way in the seat and another beside a message in a
 * room is not a name.
 *
 * Deliberately *not* every invisible, which is why this is a list rather than
 * "the format characters". The zero-width joiner (U+200D) is what makes a
 * family emoji one face rather than three, and the zero-width non-joiner
 * (U+200C) is required spelling in Persian and other scripts. Stripping those
 * to be thorough would mangle real names silently, which is a worse defect
 * than the reordering it would prevent (#235).
 */
const HIDDEN_CONTROLS = /[​‪-‮⁦-⁩]/g

/**
 * A name as this desk reads one.
 *
 * Applied where a name arrives — the stored file, an edit made here, and one
 * day an account — and again where it is drawn, so every surface draws the
 * same string. Keeping the string untouched and isolating it at each drawing
 * surface was the other answer: it never alters a name, but it makes every
 * future surface responsible for remembering, and a surface that forgets is
 * the same defect again.
 */
const readName = (name: string): string => name.replace(HIDDEN_CONTROLS, '')

const tidyName = (name: string): string =>
  characters(readName(name).replace(/\s+/g, ' ').trim())
    .slice(0, PROFILE_NAME_MAX)
    .join('')
    .trim()

/**
 * What an edit leaves in the name field, held to the cap by character.
 *
 * The part of the old name the edit did not touch is kept whole, and only what
 * the edit put in is cut to fit — what a field's own length limit does, counted
 * in characters as a person sees them rather than in UTF-16 units. So typing
 * into a full field changes nothing, a paste over a selection keeps as much of
 * the paste as fits, a paste at the front never pushes the end of the name
 * out, and an edit that only takes characters away always goes through, even
 * on a name a later build let run longer. Where the edit ended is the caret:
 * comparing the two strings alone cannot tell which of two identical
 * characters was the one typed. `caret` is where to put it back, in the
 * field's own units, when the text was cut.
 */
export const editName = (was: string, next: string, caret: number | null): { value: string; caret: number } => {
  // No more UTF-16 units than the cap is no more characters than the cap,
  // so an ordinary name is never segmented at all.
  if (next.length <= PROFILE_NAME_MAX) return { value: next, caret: caret ?? next.length }
  const after = characters(next)
  if (after.length <= PROFILE_NAME_MAX) return { value: next, caret: caret ?? next.length }
  const before = characters(was)
  const end = characters(next.slice(0, caret ?? next.length)).length
  // After the caret is the old name's end; before the edit, its start.
  let tail = 0
  const tailMost = Math.min(before.length, after.length - end)
  while (tail < tailMost && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  let head = 0
  const headMost = Math.min(before.length - tail, end)
  while (head < headMost && before[head] === after[head]) head += 1
  const room = Math.max(0, PROFILE_NAME_MAX - head - tail)
  const kept = [...after.slice(0, head), ...after.slice(head, after.length - tail).slice(0, room)]
  return { value: [...kept, ...after.slice(after.length - tail)].join(''), caret: kept.join('').length }
}

/**
 * A name as typed here, as this build keeps it: tidied, and nothing at all
 * when that leaves it empty or the default.
 */
const typedName = (name: string | null): string | undefined => {
  const tidy = name === null ? '' : tidyName(name)
  return tidy === '' || tidy === DEFAULT_PROFILE_NAME ? undefined : tidy
}

const settle = (
  later: Readonly<Record<string, unknown>> | undefined,
  name: string | undefined,
  avatar: unknown,
): Profile => ({
  ...(name !== undefined ? { name } : {}),
  ...(avatar !== undefined && avatar !== null && avatar !== '' ? { avatar } : {}),
  ...(later && Object.keys(later).length > 0 ? { later } : {}),
})

/**
 * The profile with `patch` applied. A field the patch does not mention is
 * kept exactly — including any this build does not know, and a name no edit
 * here has touched; the name a patch brings is tidied. An empty name is the
 * way back to the default, because clearing the field is what a person does
 * to mean it.
 */
export const applyProfile = (profile: Profile, patch: ProfilePatch): Profile =>
  settle(
    profile.later,
    patch.name === undefined ? profile.name : typedName(patch.name),
    patch.avatar === undefined ? profile.avatar : patch.avatar,
  )

/**
 * A stored profile, read defensively and forward. The preferences file is the
 * user's: a hand edit this build cannot read must not take the seat down, so
 * an unreadable name is simply the default — and what a later build stored is
 * kept as it was, the name untidied, so the next whole write carries it back.
 */
export const readProfile = (raw: unknown): Profile => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Readonly<Record<string, unknown>>
  const later = Object.fromEntries(Object.entries(record).filter(([field]) => field !== 'name' && field !== 'avatar'))
  const name = record['name']
  const read = typeof name === 'string' ? readName(name) : ''
  return settle(later, read.trim() !== '' ? read : undefined, record['avatar'])
}

/**
 * The profile as the preferences file holds it: what a later build stored,
 * back at the top level beside the two fields this build knows — the shape
 * `readProfile` reads, so a profile passes through this build unchanged.
 */
export const storedProfile = (profile: Profile): Readonly<Record<string, unknown>> => ({
  ...profile.later,
  ...(profile.name !== undefined ? { name: profile.name } : {}),
  ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
})

/**
 * What to call you on screen — and the last read before any surface draws it,
 * so a name that reached the field by a path this build does not have yet is
 * still held to `HIDDEN_CONTROLS`.
 */
export const profileName = (profile: Profile): string =>
  readName(profile.name ?? '').trim() || DEFAULT_PROFILE_NAME

/** Whether anything has been chosen — the question a "Reset" answers. */
export const isDefaultProfile = (profile: Profile): boolean =>
  profile.name === undefined && profile.avatar === undefined

/**
 * A value as the file would hold it, every object's keys in one order — so
 * profiles compare by what they hold rather than by which object holds it: a
 * later build's fields, or a face this build cannot draw, read twice are
 * still the same profile.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  )

/** Whether two profiles would store the same thing — the store's gate on writing at all. */
export const sameProfile = (a: Profile, b: Profile): boolean =>
  a.name === b.name && canonical(a.avatar) === canonical(b.avatar) && canonical(a.later ?? {}) === canonical(b.later ?? {})

/** An own appIcon key, including null or unknown future values, ends legacy fallback. */
export const readAppIcon = (preferences: Readonly<Record<string, unknown>>): unknown =>
  Object.hasOwn(preferences, 'appIcon') ? preferences['appIcon'] : readProfile(preferences['profile']).avatar ?? null
