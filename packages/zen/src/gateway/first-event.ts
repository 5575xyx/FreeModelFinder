// Attempt-phase classification for outbound Zen calls.
//
// Mirrors internal/gateway/first_event.go. The shared attempt deadline can fire
// at very different points of a single attempt — before a TCP connection is
// established, before the request is written, while waiting for response
// headers, or after upstream accepted the request and only the model's first
// SSE event is still outstanding. Those are not the same failure: only the
// last one means "upstream is healthy but slow", so it must neither mark a
// proxy bad nor retry. The phase is recorded when the error is raised (Go uses
// httptrace; Node has no equivalent hook, so http.ts approximates it from the
// socket and response events) and carried on a PhasedError.

export type AttemptPhase = 'dial' | 'write' | 'headers' | 'first_event';

/** Marks an abort raised by the per-attempt deadline. */
export const ATTEMPT_TIMEOUT_CODE = 'ERR_ATTEMPT_TIMEOUT';
/** Marks an abort raised while waiting for the model's first SSE event. */
export const FIRST_EVENT_TIMEOUT_CODE = 'ERR_FIRST_EVENT_TIMEOUT';

/**
 * An error that remembers how far its attempt got. `phase` is what the
 * classifier needs; `cause` keeps the underlying transport/timeout error so
 * callers that inspect `cause` still see the original.
 */
export class PhasedError extends Error {
  readonly phase: AttemptPhase;

  constructor(phase: AttemptPhase, cause: unknown) {
    super(`${phase}: ${messageOf(cause)}`, { cause });
    this.name = 'PhasedError';
    this.phase = phase;
  }
}

function phaseOf(error: unknown): AttemptPhase | undefined {
  return error instanceof PhasedError ? error.phase : undefined;
}

/** True when the attempt died after upstream had already accepted it. */
export function upstreamAccepted(error: unknown): boolean {
  return phaseOf(error) === 'first_event';
}

function withPhase(prefix: string, phase: AttemptPhase | undefined): string {
  return phase === undefined ? prefix : `${prefix}_${phase}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return String(error);
}

function* chain(error: unknown): Generator<unknown> {
  let current: unknown = error;
  let steps = 0;
  while (current !== undefined && current !== null && steps < 16) {
    yield current;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
    steps += 1;
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

function nameOf(error: unknown): string | undefined {
  const name = (error as { name?: unknown })?.name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Single-keystroke label for one failed attempt, for logs and telemetry.
 * Mirrors classifyAttemptError in internal/gateway/first_event.go:
 *   attempt_timeout_<phase>  the attempt deadline fired
 *   first_event              upstream accepted, the model never started
 *   timeout_<phase>          some other deadline (e.g. request-level) fired
 *   transport_<phase>        connection/refused/reset class
 * A non-phased error gets no suffix — there is no attempt to place it in.
 */
export function classifyAttemptError(error: unknown): string {
  const phase = phaseOf(error);
  for (const cause of chain(error)) {
    switch (codeOf(cause)) {
      case ATTEMPT_TIMEOUT_CODE:
        return withPhase('attempt_timeout', phase);
      case FIRST_EVENT_TIMEOUT_CODE:
        return 'first_event';
    }
    const name = nameOf(cause);
    if (name === 'TimeoutError' || name === 'DeadlineExceeded') {
      return withPhase('timeout', phase);
    }
  }
  return withPhase('transport', phase);
}
