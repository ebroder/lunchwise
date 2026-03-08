const REQUIRED_VARS = [
  "SESSION_SECRET",
  "TURSO_SHARED_DB_URL",
  "TURSO_AUTH_TOKEN",
  "SPLITWISE_CLIENT_ID",
  "SPLITWISE_CLIENT_SECRET",
  "APP_URL",
  "ENCRYPTION_KEYS",
  "TURSO_PLATFORM_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
] as const;

// After validateEnv() passes, required keys are guaranteed to be strings.
// Optional keys (NODE_ENV, LOG_LEVEL, etc.) remain string | undefined.
type Env = Record<(typeof REQUIRED_VARS)[number], string> & Record<string, string | undefined>;

export const env: Env = {} as Env;

export function validateEnv(): void {
  const isProduction = env.NODE_ENV === "production";
  const problems: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (!env[key]) {
      problems.push(`${key} is not set`);
    }
  }

  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
    problems.push("SESSION_SECRET must be at least 32 characters");
  }

  if (env.ENCRYPTION_KEYS) {
    try {
      const parsed = JSON.parse(env.ENCRYPTION_KEYS);
      if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length === 0) {
        problems.push("ENCRYPTION_KEYS must be a JSON object with at least one key");
      }
    } catch {
      problems.push("ENCRYPTION_KEYS is not valid JSON");
    }
  }

  if (problems.length === 0) return;

  if (isProduction) {
    throw new Error(`Environment validation failed:\n  ${problems.join("\n  ")}`);
  }

  for (const problem of problems) {
    console.warn(`[env] ${problem}`);
  }
}

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
  validateEnv();
}
