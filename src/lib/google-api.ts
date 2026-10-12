export class GoogleApiError extends Error {
  readonly google: Record<string, unknown>;
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    try {
      const parsed = JSON.parse(body);
      this.google = parsed.error ?? parsed;
      if (typeof this.google.message === "string")
        this.message = this.google.message;
    } catch {
      this.google = { message: body };
    }
  }
}
export class MissingGoogleScopeError extends Error {
  constructor(readonly requiredAny: readonly string[]) {
    super(
      "Reconnect this MCP and grant the required Google scopes; existing connection lacks a usable grant.",
    );
  }
}
export function assertGoogleScopes(
  granted: readonly string[] | undefined,
  requiredAny: readonly string[],
) {
  if (
    requiredAny.length &&
    (!granted || !requiredAny.some((scope) => granted.includes(scope)))
  )
    throw new MissingGoogleScopeError(requiredAny);
}
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof MissingGoogleScopeError)
    return {
      kind: "missing_scope",
      message: error.message,
      requiredAny: error.requiredAny,
      reconnectRequired: true,
    };
  if (error instanceof GoogleApiError) {
    const text = JSON.stringify(error.google).toLowerCase();
    let kind =
      error.status === 404
        ? "not_found"
        : error.status === 401
          ? "expired_or_invalid_token"
          : error.status === 429
            ? "quota"
            : "google_api_error";
    if (/scope|access_token_scope_insufficient/.test(text))
      kind = "missing_scope";
    else if (
      /associated|developer console project|projectpermissiondenied|project permission|project.*association/.test(
        text,
      )
    )
      kind = "project_association";
    else if (error.status === 403) kind = "permission_denied";
    return {
      kind,
      status: error.status,
      google: error.google,
      message: error.message,
      ...(kind === "missing_scope" ? { reconnectRequired: true } : {}),
      ...(kind === "permission_denied"
        ? {
            note: "Google may require a different role, project association, or license; its details are authoritative.",
          }
        : {}),
    };
  }
  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}
export async function googleFetch(
  accessToken: string,
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const response = await fetch(input, {
    ...init,
    headers,
    cache: "no-store",
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(25_000),
  });
  if (!response.ok)
    throw new GoogleApiError(
      `Google API request failed (${response.status})`,
      response.status,
      await response.text(),
    );
  return response;
}
export async function googleJson<T>(
  accessToken: string,
  input: string | URL,
  init: RequestInit = {},
): Promise<T> {
  const response = await googleFetch(accessToken, input, init);
  const text = await response.text();
  return (text.trim() ? JSON.parse(text) : {}) as T;
}
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  action: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await action(items[index], index);
      }
    }),
  );
  return results;
}
