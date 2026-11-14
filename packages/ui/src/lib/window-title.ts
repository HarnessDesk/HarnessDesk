import type { Destination } from '../state/destinations'
import { sessionLabel, shortLabel } from './sessions'

/**
 * What the window is called, from the page in front. A page that is not a conversation names itself: Settings
 * opened from a chat is still Settings in Mission Control and the Window menu, never the chat behind it.
 */
export const windowTitleOf = (
  current: Destination,
  leadName: 'dex' | 'lex' | null,
  session: { readonly title?: string | null; readonly preview?: string | null } | null,
): string =>
  current.kind === 'lead' ? leadName === 'lex' ? 'Lex' : leadName === 'dex' ? 'Dex' : 'Lead'
    : current.kind === 'settings' ? 'Settings'
      : session ? shortLabel(sessionLabel(session.title, session.preview, 'HarnessDesk')) : 'HarnessDesk'
