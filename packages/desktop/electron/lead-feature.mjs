/** A startup opt-in owned by the desktop shell, never a live preference. */
export const leadEnabled = (env) => env.HARNESSDESK_LEAD === '1'
