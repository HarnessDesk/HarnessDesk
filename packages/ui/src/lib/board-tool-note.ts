/**
 * The note a permission card carries when an agent that asks per MCP tool names one of the desk's own board
 * tools. One function, so the card, the preview and the catalogue say the same sentence.
 *
 * It never claims the tool is verified: the agent's title can be imitated, so it says what the request names, that
 * the desk can't confirm which server asked, and what a permanent choice does, or how the agent turns one on.
 */
export interface BoardToolNoteInput {
  readonly tool: string
  readonly runtimeName: string
  readonly permanentApprovalSetting: string
  /** The agent's own permanent-grant options, in its words; empty when it offered none. */
  readonly always: readonly { readonly label: string; readonly description?: string | undefined }[]
}

/** An option's own description as the tail of a sentence: no capital, no full stop. */
const grantScope = (description: string | undefined): string | null =>
  description ? description.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()) : null

export const boardToolNote = ({ tool, runtimeName, permanentApprovalSetting, always }: BoardToolNoteInput): string => [
  `This asks for HarnessDesk's board tool \`${tool}\`. HarnessDesk can't confirm which server is asking.`,
  always.length
    ? `If you trust this folder's ${runtimeName} setup, you can choose ${always
      .map((option) => `“${option.label}” — ${grantScope(option.description) ?? `${runtimeName} stops asking for this tool`}`)
      .join(' or ')}.`
    : `${runtimeName} offers permanent “Always allow” only when its own \`${permanentApprovalSetting}\` setting is on.`,
].join(' ')
