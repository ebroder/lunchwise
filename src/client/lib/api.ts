export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
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

  const data = await res.json();

  if (!res.ok) {
    throw new ApiError(res.status, data.error || "Request failed");
  }

  return data as T;
}

export function apiJson<T>(
  path: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  return api<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
