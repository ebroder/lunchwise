export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
  });

  if (res.status === 401) {
    window.location.replace("/");
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    let message = "Request failed";
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // Non-JSON error body (e.g. Cloudflare 502 HTML page)
    }
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}

export function apiJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  return api<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
