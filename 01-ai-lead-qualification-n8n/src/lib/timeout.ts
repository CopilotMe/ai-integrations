/**
 * Runs `fn` with an AbortSignal that fires after `ms`, and rejects with
 * `onTimeout()` if it does. The signal is passed down to the SDK so the
 * underlying socket is actually torn down, rather than left dangling.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut) throw onTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
