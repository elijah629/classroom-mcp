export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export async function googleFetch(
  accessToken: string,
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const response = await fetch(input, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    const body = await response.text();
    throw new GoogleApiError(
      `Google API request failed (${response.status})`,
      response.status,
      body,
    );
  }
  return response;
}

export async function googleJson<T>(
  accessToken: string,
  input: string | URL,
  init: RequestInit = {},
): Promise<T> {
  return (await googleFetch(accessToken, input, init)).json() as Promise<T>;
}

export async function paginate<T>(options: {
  accessToken: string;
  baseUrl: URL;
  arrayField: string;
  maxPages?: number;
}): Promise<T[]> {
  const { accessToken, arrayField } = options;
  const maxPages = options.maxPages ?? 20;
  const all: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(options.baseUrl);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson<Record<string, unknown>>(accessToken, url);
    const items = data[arrayField];
    if (Array.isArray(items)) all.push(...(items as T[]));
    pageToken =
      typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return all;
}

export function limitText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
