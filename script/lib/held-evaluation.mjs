/**
 * An expression for `Runtime.evaluate` with `awaitPromise`, wrapped so the page
 * keeps its promise alive until the debugger has read the answer.
 *
 * The V8 in Electron 42 holds the promise it awaits only weakly. Once the
 * promise settles, nothing in the page refers to it any more: its reactions
 * have been queued as microtasks, and none of them holds the promise itself.
 * The debugger's own reaction is the last one queued. A full garbage
 * collection that runs in one of the microtasks ahead of it collects the
 * promise, and the debugger answers "Promise was collected" for a call that
 * has already succeeded. A busy renderer collects often, so on a long-lived
 * desk this failed one run in five, and a retry could send the same message
 * twice.
 *
 * The page holds the promise in a set until a timer after it settles. Every
 * reaction already queued runs before any timer does, the debugger's included.
 * The expression is evaluated exactly as before: a value that is not a
 * promise (a thenable included, which the debugger does not await either) is
 * returned as itself, and a synchronous throw still reaches the caller as the
 * evaluation's exception.
 */
export const HELD_PROMISES = '__hdHeldEvaluations'

export const heldExpression = (expression) => `(() => {
  const value = (
${expression}
  );
  if (!(value instanceof Promise)) return value;
  const held = globalThis[${JSON.stringify(HELD_PROMISES)}] ??= new Set();
  held.add(value);
  const release = () => { setTimeout(() => held.delete(value), 0) };
  value.then(release, release);
  return value;
})()`
