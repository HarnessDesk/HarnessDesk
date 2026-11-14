let evaluations = 0

/**
 * `Runtime.evaluate` with `awaitPromise` and `returnByValue`, done so the page
 * cannot lose the promise before the debugger has read its answer.
 *
 * The V8 in Electron 42 holds the promise that `awaitPromise` waits on only
 * weakly. Once the promise settles, nothing in the page refers to it any more:
 * its reactions have been queued as microtasks, and none of them holds the
 * promise itself. The debugger's own reaction is the last one queued. A full
 * garbage collection that runs in one of the microtasks ahead of it collects
 * the promise, and the debugger answers "Promise was collected" for a call
 * that has already succeeded. A busy renderer collects often, so on a
 * long-lived desk this failed one run in five, and a retry could send the same
 * message twice.
 *
 * So the expression is evaluated without waiting, into an object group of its
 * own. The debugger keeps every object in a group strongly until the group is
 * released, which is what the weak wait lacks. A promise is then awaited by its
 * id, any other object is read back by value, and the group is released.
 *
 * The expression's source is passed through untouched: a statement list, a
 * trailing semicolon or comment, and top-level declarations all evaluate as
 * they did. The page's content security policy refuses `eval`, so wrapping the
 * source in one is not an option either.
 *
 * `send(method, params)` sends one debugger command and resolves to its
 * result. The answer has the shape `Runtime.evaluate` gives with both flags
 * set: `{ result, exceptionDetails? }`.
 */
export const evaluateHeld = async (send, expression) => {
  const objectGroup = `hd-held-${(evaluations += 1)}`
  try {
    const evaluated = await send('Runtime.evaluate', { expression, objectGroup, returnByValue: false })
    const { result, exceptionDetails } = evaluated
    if (exceptionDetails || !result?.objectId) return evaluated
    if (result.subtype === 'promise') {
      return await send('Runtime.awaitPromise', { promiseObjectId: result.objectId, returnByValue: true })
    }
    return await send('Runtime.callFunctionOn', {
      objectId: result.objectId,
      functionDeclaration: 'function () { return this }',
      returnByValue: true,
    })
  } finally {
    /* The group is the page holding the answer; nothing else lets go of it. */
    send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
  }
}
