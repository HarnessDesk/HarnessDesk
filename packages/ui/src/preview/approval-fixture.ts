import { boardToolNote } from '../lib/board-tool-note'

/** Synthetic runtime facts for the board-tool approval examples. */
export const PREVIEW_GEMINI_APPROVAL = {
  capabilities: { perToolMcpApproval: true },
  presentation: {
    name: 'Gemini CLI',
    boardToolApproval: { permanentApprovalSetting: 'security.enablePermanentToolApproval' },
  },
} as const

/** The real note, for the catalogue and the preview: built by the function the card uses. */
export const boardToolApprovalNote = (alwaysChoice?: { readonly label: string; readonly description: string }): string =>
  boardToolNote({
    tool: 'list_intents',
    runtimeName: PREVIEW_GEMINI_APPROVAL.presentation.name,
    permanentApprovalSetting: PREVIEW_GEMINI_APPROVAL.presentation.boardToolApproval.permanentApprovalSetting,
    always: alwaysChoice ? [alwaysChoice] : [],
  })
