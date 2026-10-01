import {
  boardToolLabel,
  boardToolNote,
  boardToolPlacement,
  offersPermanentGrant,
  type GrantOption,
} from '../lib/board-tool-note'
import { boardToolPhrase } from '../lib/tool-names'

/** Synthetic runtime facts for the board-tool approval examples. */
export const PREVIEW_GEMINI_APPROVAL = {
  capabilities: { perToolMcpApproval: true },
  presentation: {
    name: 'Gemini CLI',
    boardToolApproval: {
      permanentApprovalSetting: 'security.enablePermanentToolApproval',
      sessionOptionLabel: 'Allow for this session',
    },
  },
} as const

const DENY: GrantOption = { id: 'deny', label: 'Deny', intent: 'deny' }
const ONCE: GrantOption = { id: 'once', label: 'Allow once', intent: 'approve' }
const SESSION_GRANT: GrantOption = {
  id: 'session', label: 'Allow tool for this session', description: 'Allows this tool for the rest of this session.', intent: 'approveAlways',
}
const FUTURE_GRANT: GrantOption = {
  id: 'future', label: 'Allow tool for all future sessions', description: 'Saves approval for this tool in future sessions.', intent: 'approveAlways',
}

/** The three states the card has: a grant that ends with the session, one that outlives it, and none. */
export const BOARD_TOOL_FRAME_OPTIONS = {
  session: [DENY, SESSION_GRANT, ONCE],
  permanent: [DENY, SESSION_GRANT, FUTURE_GRANT, ONCE],
  none: [DENY, ONCE],
} as const satisfies Record<string, readonly GrantOption[]>

/**
 * One state of the card, built by the same functions the real card uses: the buttons' labels and places, and the
 * note. The catalogue and the preview draw this, so they cannot say something the product doesn't.
 */
export const boardToolFrame = (
  state: keyof typeof BOARD_TOOL_FRAME_OPTIONS,
  onSelect: () => void,
) => {
  const options: readonly GrantOption[] = BOARD_TOOL_FRAME_OPTIONS[state]
  const approval = PREVIEW_GEMINI_APPROVAL.presentation.boardToolApproval
  return {
    actions: options.map((option, index) => ({
      id: option.id,
      label: boardToolLabel(option, options, approval.sessionOptionLabel),
      ...(option.description ? { description: option.description } : {}),
      shortcut: index + 1,
      placement: boardToolPlacement(option),
      ...(option.intent === 'deny' ? { tone: 'destructive' as const } : {}),
      onSelect,
    })),
    note: boardToolNote({
      phrase: boardToolPhrase('list_intents'),
      runtimeName: PREVIEW_GEMINI_APPROVAL.presentation.name,
      permanentApprovalSetting: approval.permanentApprovalSetting,
      hasPermanentOption: offersPermanentGrant(options),
    }),
  }
}

/** The three frames, in the order the catalogue and the preview draw them, with the ids the coverage spec reads. */
export const BOARD_TOOL_FRAMES = [
  { state: 'session', caseId: 'board-tool-approval-always', title: 'Permission — a grant that ends with the session' },
  { state: 'permanent', caseId: 'board-tool-approval-permanent', title: 'Permission — a grant that outlives the session' },
  { state: 'none', caseId: 'board-tool-approval-setting', title: 'Permission — no grant offered' },
] as const satisfies readonly { state: keyof typeof BOARD_TOOL_FRAME_OPTIONS; caseId: string; title: string }[]
