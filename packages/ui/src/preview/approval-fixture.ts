import { boardToolNote } from '../lib/board-tool-note'
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

/** The real note, for the catalogue and the preview: built by the function the card uses. */
export const boardToolApprovalNote = (hasPermanentOption = false) =>
  boardToolNote({
    phrase: boardToolPhrase('list_intents'),
    runtimeName: PREVIEW_GEMINI_APPROVAL.presentation.name,
    permanentApprovalSetting: PREVIEW_GEMINI_APPROVAL.presentation.boardToolApproval.permanentApprovalSetting,
    hasPermanentOption,
  })
