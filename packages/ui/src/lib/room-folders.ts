import type { TeamState, WorkspaceEntry } from '@harnessdesk/protocol'
import { roomGroupRootOf } from './projects'

/** Filter by the room's own root before project aliases can file it elsewhere. */
export const roomsByProjectFor = (
  rooms: ReadonlyMap<string, TeamState>,
  gone: ReadonlyMap<string, string>,
  open: readonly (WorkspaceEntry | null | undefined)[],
  searching: boolean,
): Map<string, TeamState[]> => {
  const out = new Map<string, TeamState[]>()
  for (const team of rooms.values()) {
    if (!searching && gone.has(team.root)) continue
    const root = roomGroupRootOf(team, open)
    const held = out.get(root)
    if (held) held.push(team)
    else out.set(root, [team])
  }
  return out
}

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
