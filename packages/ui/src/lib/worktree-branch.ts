/**
 * The branch a worktree's name becomes.
 *
 * The host's own rule (`slugify` in `packages/server/src/worktree.ts`), kept
 * here so a preview cannot promise a branch the host will not make: lower
 * case, dashes, nothing git rejects, namespaced `harnessdesk/` so it is
 * recognisable among a person's own branches and can never collide with one.
 * The dialog that asks for the name and the composer chip that shows it
 * afterwards both read it, and two copies of a rule are two rules.
 *
 * One difference, on purpose: the host gives an empty slug a timestamp, and
 * here an empty slug stays empty, because the dialog asks for a name rather
 * than inventing one.
 */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.\.+/g, '.')
    .slice(0, 48)

export const worktreeBranch = (name: string): string => `harnessdesk/${slugify(name)}`
