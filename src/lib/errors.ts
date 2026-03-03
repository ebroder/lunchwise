/** Extract a useful error message, including libsql error codes when available. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    if (typeof err === "object" && err !== null) return JSON.stringify(err);
    return String(err);
  }
  const e = err as unknown as Record<string, unknown>;
  const parts: string[] = [];
  // Error class name (e.g. LibsqlError vs Error)
  if (err.constructor.name !== "Error") parts.push(`[${err.constructor.name}]`);
  if (e.code) parts.push(`code=${e.code}`);
  if (e.rawCode !== undefined) parts.push(`rawCode=${e.rawCode}`);
  parts.push(err.message);
  // Check for a wrapped cause
  if (err.cause instanceof Error) {
    parts.push(`| cause: ${describeError(err.cause)}`);
  }
  return parts.join(" ");
}
