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

type ApiService = "Lunch Money" | "Splitwise";

function apiErrorPrefix(service: ApiService, status: number): string {
  return `${service} API error (${status})`;
}

export function apiError(service: ApiService, status: number, error: unknown): Error {
  return new Error(`${apiErrorPrefix(service, status)}: ${describeError(error)}`);
}

export type SyncFailureReason = "lunch-money-key" | "splitwise-access" | "interrupted" | "other";

export const INTERRUPTED_MESSAGE = "Process interrupted";

// Takes describeError's text rather than the Error, so it also reads sync_log.error_message.
export function classifySyncError(message: string): SyncFailureReason {
  if (message.startsWith(apiErrorPrefix("Lunch Money", 401))) return "lunch-money-key";
  if (message.startsWith(apiErrorPrefix("Splitwise", 401))) return "splitwise-access";
  if (message === INTERRUPTED_MESSAGE) return "interrupted";
  return "other";
}
