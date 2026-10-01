import { approvalChoiceOrder } from '../lib/approval-order'
import {
  boardToolLabel,
  boardToolNote,
  boardToolPlacement,
  offersPermanentGrant,
  type GrantOption,
} from '../lib/board-tool-note'
import { boardToolPhrase } from '../lib/tool-names'

/** Synthetic runtime facts for the board-tool approval examples: what a Gemini-style adapter declares. */
export const PREVIEW_GEMINI_APPROVAL = {
  capabilities: { perToolMcpApproval: true },
  presentation: {
    name: 'Gemini CLI',
    boardToolApproval: {
      permanentApprovalSetting: 'security.enablePermanentToolApproval',
      sessionOptionLabel: 'Allow for this session',
      onceOptionLabel: 'Allow once',
    },
  },
} as const

// The choices Gemini 0.62 sends for an MCP tool, in its words and its order: its grants, then its plain Allow and Reject.
const SERVER_GRANT: GrantOption = {
  id: 'proceed_always_server', label: 'Allow all server tools for this session',
  description: 'Allows every tool from this server for this session.', intent: 'approveAlways', grant: 'session-server',
}
const TOOL_GRANT: GrantOption = {
  id: 'proceed_always_tool', label: 'Allow tool for this session',
  description: 'Allows this tool for the rest of this session.', intent: 'approveAlways', grant: 'session-tool',
}
const FUTURE_GRANT: GrantOption = {
  id: 'proceed_always_and_save', label: 'Allow tool for all future sessions',
  description: 'Saves approval for this tool in future sessions.', intent: 'approveAlways', grant: 'permanent',
}
const ALLOW: GrantOption = { id: 'proceed_once', label: 'Allow', intent: 'approve' }
const REJECT: GrantOption = { id: 'cancel', label: 'Reject', intent: 'cancel' }

/**
 * The three states the card has: session grants only (Gemini's default), a grant that outlives the session (its
 * permanent-approval setting is on), and no grant at all (its always-allow is disabled).
 */
export const BOARD_TOOL_FRAME_OPTIONS = {
  session: [SERVER_GRANT, TOOL_GRANT, ALLOW, REJECT],
  permanent: [SERVER_GRANT, TOOL_GRANT, FUTURE_GRANT, ALLOW, REJECT],
  none: [ALLOW, REJECT],
} as const satisfies Record<string, readonly GrantOption[]>

/**
 * One state of the card, built by the same functions the real card uses: the order of the buttons, their labels and
 * places, and the note. The catalogue and the preview draw this, so they cannot say something the product doesn't.
 */
export const boardToolFrame = (
  state: keyof typeof BOARD_TOOL_FRAME_OPTIONS,
  onSelect: () => void,
) => {
  const options: readonly GrantOption[] = BOARD_TOOL_FRAME_OPTIONS[state]
  const approval = PREVIEW_GEMINI_APPROVAL.presentation.boardToolApproval
  return {
    actions: approvalChoiceOrder(options as never).map((choice) => {
      const option = choice as unknown as GrantOption
      return {
        id: option.id,
        label: boardToolLabel(option, options, { session: approval.sessionOptionLabel, once: approval.onceOptionLabel }),
        ...(option.description ? { description: option.description } : {}),
        shortcut: options.indexOf(option) + 1,
        placement: boardToolPlacement(option),
        ...(option.intent === 'deny' ? { tone: 'destructive' as const } : {}),
        onSelect,
      }
    }),
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
  { state: 'session', caseId: 'board-tool-approval-always', title: 'Permission — session grants only' },
  { state: 'permanent', caseId: 'board-tool-approval-permanent', title: 'Permission — a grant that outlives the session' },
  { state: 'none', caseId: 'board-tool-approval-setting', title: 'Permission — no grant offered' },
] as const satisfies readonly { state: keyof typeof BOARD_TOOL_FRAME_OPTIONS; caseId: string; title: string }[]
