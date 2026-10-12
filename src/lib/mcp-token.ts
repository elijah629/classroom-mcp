import type { AuthInfo } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { config } from "./config";
import { seal, unseal } from "./crypto";

export interface McpIdentity {
  clientId: string;
  googleSub: string;
  googleEmail: string;
  scopes: string[];
  googleScopes?: string[];
}

export interface McpAccessPayload extends McpIdentity {
  googleAccessToken: string;
}

export interface McpRefreshPayload extends McpIdentity {
  googleRefreshToken: string;
}

export interface McpAccessContext extends McpAccessPayload {
  exp: number;
}

export async function issueMcpAccessToken(
  payload: McpAccessPayload,
  requestedExpiresIn = 60 * 60,
): Promise<{ token: string; expiresIn: number }> {
  // Leave a small safety margin relative to Google's normal access-token lifetime.
  const expiresIn = Math.max(60, Math.min(requestedExpiresIn, 55 * 60));
  return {
    token: await seal("mcp-access", payload, expiresIn),
    expiresIn,
  };
}

export async function issueMcpRefreshToken(
  payload: McpRefreshPayload,
): Promise<string> {
  return seal("mcp-refresh", payload, 90 * 24 * 60 * 60);
}

export async function readMcpAccessToken(
  token: string,
): Promise<McpAccessContext> {
  const payload = await unseal<McpAccessPayload>(token, "mcp-access");
  return {
    clientId: payload.clientId,
    googleSub: payload.googleSub,
    googleEmail: payload.googleEmail,
    googleAccessToken: payload.googleAccessToken,
    scopes: payload.scopes,
    googleScopes: payload.googleScopes,
    exp: payload.exp,
  };
}

export async function readMcpRefreshToken(
  token: string,
): Promise<McpRefreshPayload> {
  const payload = await unseal<McpRefreshPayload>(token, "mcp-refresh");
  return {
    clientId: payload.clientId,
    googleSub: payload.googleSub,
    googleEmail: payload.googleEmail,
    googleRefreshToken: payload.googleRefreshToken,
    scopes: payload.scopes,
    googleScopes: payload.googleScopes,
  };
}

export async function verifyMcpAccessToken(token: string): Promise<AuthInfo> {
  try {
    const payload = await readMcpAccessToken(token);
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes,
      expiresAt: payload.exp,
      resource: new URL(config.mcpUrl),
      extra: {
        googleSub: payload.googleSub,
        googleEmail: payload.googleEmail,
        googleAccessToken: payload.googleAccessToken,
        googleScopes: payload.googleScopes,
      },
    };
  } catch {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "Invalid or expired MCP access token",
    );
  }
}

export function googleAccessTokenFromAuthInfo(auth: AuthInfo): string {
  const accessToken = auth.extra?.googleAccessToken;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("authenticated_token_missing_google_access_token");
  }
  return accessToken;
}

export function googleScopesFromAuthInfo(auth: AuthInfo): string[] | undefined {
  const scopes = auth.extra?.googleScopes;
  return Array.isArray(scopes) &&
    scopes.every((scope) => typeof scope === "string")
    ? scopes
    : undefined;
}
