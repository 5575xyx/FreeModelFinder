export function isMaxTokensTooLargeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /max_tokens is too large/i.test(message) ||
    /max_tokens must be/i.test(message) ||
    /"param"\s*:\s*"max_tokens"/.test(message)
  );
}

export function extractMaxTokensLimit(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const atMost = message.match(/at most (\d+)/i);
  if (atMost) return Number(atMost[1]);
  const lessThan = message.match(/less than (\d+)/i);
  if (lessThan) return Number(lessThan[1]);
  return undefined;
}
