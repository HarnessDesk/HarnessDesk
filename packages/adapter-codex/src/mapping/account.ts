import type { CodexProtocol } from '@harnessdesk/codex'
import type { Account, AuthMethod, LoginStart } from '@harnessdesk/protocol'

/** Source plan identifiers stay in the adapter; the renderer receives their presentation. */
const PLAN_LABELS: Record<CodexProtocol.PlanType, string> = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max',
  team: 'Team', self_serve_business_prolite: 'Business Pro Lite',
  self_serve_business_usage_based: 'Business Usage Based', business: 'Business',
  ent26: 'Enterprise', enterprise_cbp_automation: 'Enterprise Automation',
  enterprise_cbp_usage_based: 'Enterprise Usage Based', enterprise: 'Enterprise',
  edu: 'Education', edu_plus: 'Education Plus', edu_pro: 'Education Pro', unknown: 'Unknown',
}

export const mapPlanLabel = (raw: string | null | undefined): string | null => {
  if (raw == null || !raw.trim()) return null
  if (Object.hasOwn(PLAN_LABELS, raw)) return PLAN_LABELS[raw as CodexProtocol.PlanType]
  return raw.trim().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
    .replace(/^self\s+serve\s+/i, '').toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase())
}

/**
 * Codex's account model → the protocol's.
 *
 * Codex knows three kinds of identity and a configuration switch that can
 * forbid all but one way of signing in. Both are expressed as data here so the
 * interface renders what Codex permits rather than what a shell assumed.
 */

export const mapAccount = (account: CodexProtocol.v2.Account | null): Account[] => {
  if (!account) return []
  switch (account.type) {
    case 'chatgpt':
      return [
        {
          // 0.149.0 made `email` nullable — a ChatGPT identity can arrive
          // without one, and the row still has to render as something.
          kind: 'chatgpt',
          label: account.email ?? 'ChatGPT account',
          email: account.email,
          planType: String(account.planType),
        },
      ]
    case 'apiKey':
      return [{ kind: 'apiKey', label: 'API key' }]
    case 'amazonBedrock':
      return [{ kind: 'amazonBedrock', label: 'Amazon Bedrock' }]
  }
}

/** The two ChatGPT flows Codex can drive for a client, by `LoginAccountParams.type`. */
const CHATGPT_BROWSER: AuthMethod = {
  id: 'chatgpt',
  label: 'Sign in with ChatGPT',
  description: 'Opens your browser to sign in. Best on this machine.',
  flow: 'browser',
}

const CHATGPT_DEVICE_CODE: AuthMethod = {
  id: 'chatgptDeviceCode',
  label: 'Sign in with a code',
  description:
    'Shows a one-time code to enter on another device. Use this when a browser here cannot reach localhost.',
  flow: 'deviceCode',
}

/**
 * API-key sign-in takes a secret typed into the interface, and the renderer
 * has no designed path for handling one yet. Until the credential broker
 * exists, the honest offer is the CLI.
 */
const API_KEY_EXTERNAL: AuthMethod = {
  id: 'apiKey',
  label: 'Use an API key',
  description: 'Run codex login --with-api-key in a terminal, then return here.',
  flow: 'external',
}

/**
 * Which sign-in methods to offer, given `forced_login_method` from the
 * configuration. A managed config that forces `api` leaves nothing the
 * interface can drive — and says so rather than offering a flow that would
 * be refused.
 */
export const signInMethods = (
  forced: CodexProtocol.ForcedLoginMethod | null | undefined,
): AuthMethod[] => {
  switch (forced) {
    case 'api':
      return [API_KEY_EXTERNAL]
    case 'chatgpt':
      return [CHATGPT_BROWSER, CHATGPT_DEVICE_CODE]
    default:
      return [CHATGPT_BROWSER, CHATGPT_DEVICE_CODE, API_KEY_EXTERNAL]
  }
}

/** The app-server params that start a given method, or null when it cannot be driven. */
export const loginParamsFor = (method: string): CodexProtocol.v2.LoginAccountParams | null => {
  switch (method) {
    case 'chatgpt':
      return { type: 'chatgpt' }
    case 'chatgptDeviceCode':
      return { type: 'chatgptDeviceCode' }
    default:
      return null
  }
}

export const mapLoginStart = (response: CodexProtocol.v2.LoginAccountResponse): LoginStart => {
  switch (response.type) {
    case 'chatgpt':
      return { type: 'browser', loginId: response.loginId, url: response.authUrl }
    case 'chatgptDeviceCode':
      return {
        type: 'deviceCode',
        loginId: response.loginId,
        url: response.verificationUrl,
        code: response.userCode,
      }
    default:
      // `apiKey` and `chatgptAuthTokens` complete synchronously and are never
      // started from here; reaching this means the method table above drifted.
      throw new Error(`Codex started a ${response.type} login, which the interface cannot drive.`)
  }
}
