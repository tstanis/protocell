import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // The wire tests spawn a real server and wait on real sockets; the sim tests settle
    // fields over tens of thousands of steps. Neither fits in the 5 s default.
    //
    // `npm test` runs them in TWO passes (see package.json): the sim suite in parallel,
    // then the wire suite alone. The wire tests spawn a real server that must tick at
    // 120 Hz in WALL-CLOCK time and then assert things like "the nanobot reaches the
    // nucleus within 20 s", so keeping a dozen compute-bound sim workers off its back is
    // worth doing on its own merits.
    //
    // CORRECTION, recorded because the original diagnosis here was wrong. CPU starvation
    // was blamed for the intermittent wire failures. The actual defect was a RACE in the
    // test harness: `connect()` resolved on 'open' and the caller attached its 'message'
    // listener afterwards, so the `hello` the server sends on accept was emitted to an
    // EventEmitter with nobody listening and dropped. The test then waited 25 s for a
    // message that had already arrived. That is why it passed 10/10 alone and failed
    // inside a full run — load only widened the window. Fixed in wire.test.ts by attaching
    // the listener synchronously inside `connect()` and queueing.
    //
    // The lesson is the one this file keeps relearning: "it only fails under load" is a
    // symptom, not a cause, and treating it as one buys a plausible story instead of a fix.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    /**
     * Stated explicitly because a crashed worker must FAIL the run, not quietly shrink it.
     * This is already the default — it is here as documentation, NOT as a fix.
     *
     * The history is worth keeping, because the real failure was in how the run was being
     * READ rather than in how it was configured. `metabolism.test.ts` ran its worker out of
     * heap and died; vitest correctly reported "Worker exited unexpectedly" and dropped all
     * 12 of that file's tests. It looked green for several runs because the output was
     * being piped (`npm test | grep ... | head`), and a shell pipeline exits with the
     * status of its LAST command — so vitest's non-zero exit was replaced by head's zero.
     * The pass count kept climbing while a whole file had stopped running.
     *
     * Two rules fall out, and both are about reading results rather than producing them:
     *   - Never pipe a test run you intend to trust. Use `set -o pipefail`, or read the
     *     raw exit code.
     *   - Read the FILE count, not just the pass count. "8 passed (9)" is a failure.
     */
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
