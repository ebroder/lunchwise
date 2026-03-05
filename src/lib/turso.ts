import { env } from "./env.js";

const TURSO_PLATFORM_API_BASE = "https://api.turso.tech";

interface CreateDatabaseResponse {
  database: {
    Name: string;
    Hostname: string;
  };
}

export async function createTursoDatabase(name: string): Promise<string> {
  const apiToken = env.TURSO_PLATFORM_API_TOKEN;
  const org = env.TURSO_ORG;
  const group = env.TURSO_GROUP || "default";

  // Local dev: no Platform API credentials, use file-based SQLite
  if (!apiToken || !org) {
    return `file:local-user-${name}.db`;
  }

  const res = await fetch(`${TURSO_PLATFORM_API_BASE}/v1/organizations/${org}/databases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, group }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Turso Platform API error (${res.status}): ${body}`);
  }

  let data: CreateDatabaseResponse;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Turso Platform API returned invalid JSON (${res.status})`);
  }

  const hostname = data.database?.Hostname;
  if (!hostname) {
    throw new Error(`Turso Platform API response missing database.Hostname`);
  }

  return `libsql://${hostname}`;
}
