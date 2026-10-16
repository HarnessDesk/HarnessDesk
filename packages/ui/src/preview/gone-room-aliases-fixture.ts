import { runtimeId, sessionId, type SessionSummary } from '@harnessdesk/protocol'
import { goneRoomFoldersCase } from './gone-room-folders-fixture'

/** The missing clone remains an alias of the live project through history. */
export const goneRoomAliasesCase = {
  ...goneRoomFoldersCase,
  history: [goneRoomFoldersCase.root, goneRoomFoldersCase.deleted].map((cwd, index): SessionSummary => ({
    id: sessionId(`clone-${index}`), runtime: runtimeId('preview'), title: `Checkout notes ${index + 1}`, preview: null,
    cwd, status: { type: 'notLoaded' }, createdAt: index + 1, updatedAt: index + 1,
    git: { sha: 'x', branch: 'main', originUrl: 'https://acme.dev/storefront.git' },
    folderGone: cwd === goneRoomFoldersCase.deleted,
  })),
}
