import type { TeamState } from '@harnessdesk/protocol'

/** Room-only projects: two Teams in a deleted clone and one existing project. */
const root = '/work/storefront'
const deleted = '/work/completed-clone'
const room = (id: string, name: string, root: string, folderGone: boolean): TeamState => ({
  id, name, root, folderGone, updatedAt: 1, members: [], intents: [], channel: [], messaging: true,
})
export const goneRoomFoldersCase = {
  root, deleted,
  teams: [room('active', 'Check the release notes', root, false),
    room('completed', 'Repair the checkout retry', deleted, true),
    room('reviewed', 'Review the checkout retry', deleted, true)],
}
