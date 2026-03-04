export const env: Record<string, string | undefined> = {};

export function initEnv(workerEnv: Record<string, unknown>): void {
  // Clear previous keys so removed secrets don't linger across calls
  for (const key of Object.keys(env)) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(workerEnv)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
}
