import type { AccountStatus } from '@harnessdesk/protocol'

/** An agent's own words for "nobody is signed in", as the ACP adapter recognises them. */
const SIGN_IN_REFUSAL = /authentication required|not authenticated|unauthenticated|auth[_ -]?required|(?:sign|log)[- ]?in required|not (?:signed|logged) in/i

/**
 * Whether a failed read is the agent saying it is not signed in, while the
 * desk already shows it signed out — or has not heard who is. Its page says
 * so in the banner and the Accounts card; the refusal repeated it as a
 * paragraph of protocol text, as a toast that stayed up on the next agent's
 * page and as a warning in the page's own new-conversation section (#1775).
 * A refusal from an agent the desk shows signed in is news, and is still
 * shown, like any other failure.
 */
export const explainedBySignIn = (error: unknown, account: AccountStatus | null | undefined): boolean =>
  SIGN_IN_REFUSAL.test(error instanceof Error ? error.message : String(error)) &&
  (!account || account.accounts.length === 0)
