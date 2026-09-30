export function isContextLengthExceededError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /context_length_exceeded/i.test(message) ||
    /input exceeds the context limit/i.test(message) ||
    /context[_\s-]?window[_\s-]?(?:exceeded|too (?:long|large))/i.test(message) ||
    /maximum context length (?:is )?\d+/i.test(message) ||
    /prompt is too long/i.test(message)
  );
}
