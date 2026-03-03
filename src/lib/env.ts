export const env: Record<string, string | undefined> = {};

export function initEnv(workerEnv: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(workerEnv)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
}
