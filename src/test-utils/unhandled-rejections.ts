/**
 * Capture the unhandled promise rejections raised while a test step runs.
 *
 * A rejection nobody awaits is reported by the test runner "outside a test"
 * and charged to whichever test happens to be running when it lands — so a
 * teardown that rejects (a Tauri `unlisten` called where there is no event
 * bridge, a render that throws) fails some OTHER test, intermittently, and
 * only under load. Tests for such paths assert directly that none fires.
 */
export async function collectUnhandledRejections(
  step: () => Promise<void> | void,
): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent): void => {
    reasons.push(event.reason);
    // Keep the runner from ALSO charging it to this test: the assertion on the
    // returned list is the report.
    event.preventDefault();
  };
  window.addEventListener('unhandledrejection', onRejection);
  try {
    await step();
    // `unhandledrejection` is dispatched as its own task after the microtask
    // checkpoint that left the promise unhandled, so give the event loop a few
    // turns for a rejection raised by the step to be reported.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    window.removeEventListener('unhandledrejection', onRejection);
  }
  return reasons;
}
