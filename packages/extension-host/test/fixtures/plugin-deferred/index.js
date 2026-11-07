/** A hook with a late priority on the same tool the good plugin's hook vetoes. */
export const plugin = {
  name: 'deferred',
  inject: ['hooks'],
  apply(ctx) {
    ctx.hooks.register({
      event: 'preToolUse',
      match: ['forbidden_tool'],
      priority: 50,
      handle: () => ({ decision: 'deny', reason: 'the late hook says no' }),
    })
  },
}
