import type { TeamState } from '@harnessdesk/protocol'

/** Merge only fresh host measurements; unchanged boards cannot undo a later read. */
export const roomFoldersGone = (
  gone: ReadonlyMap<string, string>,
  before: ReadonlyMap<string, TeamState>,
  rooms?: ReadonlyMap<string, TeamState>,
): ReadonlyMap<string, string> => {
  if (!rooms) return gone
  const measured = new Map<string, boolean>()
  for (const [id, room] of rooms) {
    if (room === before.get(id) || !room.root || room.folderGone === undefined) continue
    measured.set(room.root, room.folderGone || measured.get(room.root) === true)
  }
  let next: Map<string, string> | undefined
  for (const [root, missing] of measured) {
    if (missing === gone.has(root)) continue
    next ??= new Map(gone)
    if (missing) next.set(root, `This project's folder no longer exists (${root}).`)
    else next.delete(root)
  }
  return next ?? gone
}

/** Count session and room roots together, once, until the person forgets them. */
export const goneProjectFolders = (
  gone: ReadonlyMap<string, string>,
  forgotten: ReadonlySet<string>,
  sessionRoots: readonly string[],
  roomRoots: string,
  searching: boolean,
): string[] => searching ? [] : [...new Set([...sessionRoots, ...roomRoots.split('\u0000')])]
  .filter(root => gone.has(root) && !forgotten.has(root)).sort()
