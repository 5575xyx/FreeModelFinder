/**
 * A failed upstream HTTP call, with the wire-level detail preserved.
 *
 * Providers used to throw `Error('openrouter chat failed 429: <body>')`, which
 * discarded the whole `Response`. A `Retry-After: 45` sent in a header then
 * never reached the router — the only surviving channel was the response BODY,
 * which most upstreams never echo. Nearly every 429 therefore fell through to
 * a guessed default cooldown.
 *
 * The status and the hint now travel as fields instead of as prose, so nothing
 * depends on the shape of an error message. The message itself keeps its old
 * `<provider> <action> failed <status>:` form on purpose: the router classifies
 * failures by matching that text, and changing it would be a needless second
 * breaking change.
 */
export class UpstreamError extends Error {
  readonly status: number;

  /**
   * The upstream's back-off hint, verbatim from the `Retry-After` header.
   *
   * Deliberately kept as a string: per RFC 9110 the field is either
   * delay-seconds or an HTTP-date, and deciding between them is the parser's
   * job. Collapsing them here would let an HTTP-date become "2026 seconds".
   */
  readonly retryAfter?: string;

  constructor(message: string, response: Response) {
    super(message);
    this.name = 'UpstreamError';
    this.status = response.status;
    const hint = response.headers.get('retry-after');
    this.retryAfter = hint && hint.trim() !== '' ? hint.trim() : undefined;
  }
}
