/**
 * The envelope HarnessDesk wraps injected context in.
 *
 * The definition moved to `@harnessdesk/protocol` the day the host became a
 * writer too — an inter-agent message travels in this envelope, composed on
 * the host side. Re-exported here so the renderer's many callers keep their
 * import path.
 */

export {
  AGENT_MESSAGE_NOTICE,
  AGENT_MESSAGE_PREFIX,
  CONTEXT_OPEN,
  HANDOFF_PREFIX,
  agentMessageSource,
  isAgentMessageSource,
  isHandoffSource,
  noteKey,
  openingOf,
  opensEnvelope,
  splitContext,
  wrapContext,
  type ContextBlock,
  type SplitText,
} from '@harnessdesk/protocol'
