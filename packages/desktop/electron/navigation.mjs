/**
 * Whether a navigation target is the app itself.
 *
 * The window must never navigate away from the host — links belong in the
 * user's own browser — so this decides one question and the caller acts on it.
 *
 * It exists as its own module because the check it replaces was a string
 * prefix (`target.startsWith(appUrl.split('/?')[0])`), and a URL is not a
 * string for this purpose. `http://127.0.0.1:54321@evil.com/` carries the app's
 * own prefix and resolves to `evil.com`: everything before the `@` is userinfo.
 * A prefix test cannot see that, and there is no test file for `main.mjs`.
 */

/**
 * @param {string | null | undefined} appUrl the URL the window was opened on
 * @param {string} target where it is being asked to go
 * @returns {boolean} true only when `target` is the same origin as `appUrl`
 */
export const isAppNavigation = (appUrl, target) => {
  if (typeof appUrl !== 'string' || typeof target !== 'string') return false
  let app
  let to
  try {
    app = new URL(appUrl)
  } catch {
    return false
  }
  try {
    to = new URL(target, appUrl)
  } catch {
    return false
  }
  /* An opaque origin serialises as the string "null" — file:, data:, blob:
     without a base — and every opaque origin equals every other one. Comparing
     those would make "null" === "null" an identity, which is how a file: URL
     would come to count as the app. Identity has to be a real origin. */
  if (app.origin === 'null' || to.origin === 'null') return false
  return to.origin === app.origin
}
