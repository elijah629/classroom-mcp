import { config, MCP_SCOPES } from "./config";
import { seal, unseal } from "./crypto";

export const oauthMetadata = {
  issuer: config.origin,
  authorization_endpoint: `${config.origin}/oauth/authorize`,
  token_endpoint: `${config.origin}/oauth/token`,
  registration_endpoint: `${config.origin}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [...MCP_SCOPES],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: true,
};

export const protectedResourceMetadata = {
  resource: config.mcpUrl,
  authorization_servers: [config.origin],
  scopes_supported: ["mcp"],
  bearer_methods_supported: ["header"],
};

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

function isPrivateLiteral(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
}

function validRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

async function clientFromCimd(clientId: string): Promise<OAuthClient> {
  const url = new URL(clientId);
  if (url.protocol !== "https:" || !url.pathname || url.pathname === "/") {
    throw new Error("invalid_client_metadata_url");
  }
  if (isPrivateLiteral(url.hostname))
    throw new Error("private_client_metadata_host_rejected");

  const allow = config.allowedCimdHosts;
  if (
    allow.length &&
    !allow.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  ) {
    throw new Error("client_metadata_host_not_allowed");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("client_metadata_fetch_failed");
    const doc = (await response.json()) as Record<string, unknown>;
    if (doc.client_id !== clientId)
      throw new Error("client_id_metadata_mismatch");
    const redirectUris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter(
          (v): v is string => typeof v === "string" && validRedirectUri(v),
        )
      : [];
    if (!redirectUris.length)
      throw new Error("client_has_no_valid_redirect_uris");
    return {
      clientId,
      redirectUris,
      clientName:
        typeof doc.client_name === "string" ? doc.client_name : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function issueDcrClient(metadata: {
  redirect_uris: string[];
  client_name?: string;
}): Promise<string> {
  const redirectUris = metadata.redirect_uris.filter(validRedirectUri);
  if (
    !redirectUris.length ||
    redirectUris.length !== metadata.redirect_uris.length
  ) {
    throw new Error("invalid_redirect_uri");
  }
  return seal(
    "dcr-client",
    {
      redirectUris,
      clientName: metadata.client_name,
    },
    365 * 24 * 60 * 60,
  );
}

export async function resolveOAuthClient(
  clientId: string,
): Promise<OAuthClient> {
  if (clientId.startsWith("https://")) return clientFromCimd(clientId);
  const payload = await unseal<{ redirectUris: string[]; clientName?: string }>(
    clientId,
    "dcr-client",
  );
  return {
    clientId,
    redirectUris: payload.redirectUris,
    clientName: payload.clientName,
  };
}

export function normalizeRequestedScopes(scope: string | null): string[] {
  const requested = (scope ?? "mcp offline_access")
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);
  const supported = new Set<string>(MCP_SCOPES);
  const filtered = requested.filter((s) => supported.has(s));
  if (!filtered.includes("mcp")) filtered.unshift("mcp");
  // ChatGPT can keep the connector authenticated only when refresh/offline access is advertised and granted.
  if (!filtered.includes("offline_access")) filtered.push("offline_access");
  return [...new Set(filtered)];
}

export function oauthErrorRedirect(
  redirectUri: string,
  state: string | null,
  error: string,
  description?: string,
) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url;
}
