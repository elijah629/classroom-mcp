import { NextResponse } from "next/server";
import { constantTimeEqual, sha256Base64url, unseal } from "@/lib/crypto";
import { refreshGoogleAccessToken } from "@/lib/google-auth";
import {
  issueMcpAccessToken,
  issueMcpRefreshToken,
  readMcpRefreshToken,
} from "@/lib/mcp-token";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type AuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  googleSub: string;
  googleEmail: string;
  googleAccessToken: string;
  googleAccessExpiresIn: number;
  googleRefreshToken: string;
};

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const grantType = String(form.get("grant_type") ?? "");
    const clientId = String(form.get("client_id") ?? "");

    if (grantType === "authorization_code") {
      const code = String(form.get("code") ?? "");
      const redirectUri = String(form.get("redirect_uri") ?? "");
      const codeVerifier = String(form.get("code_verifier") ?? "");
      if (!code || !clientId || !redirectUri || !codeVerifier) {
        return tokenResponse({ error: "invalid_request" }, 400);
      }

      const authCode = await unseal<AuthCode>(code, "mcp-authorization-code");
      if (
        authCode.clientId !== clientId ||
        authCode.redirectUri !== redirectUri
      ) {
        return tokenResponse({ error: "invalid_grant" }, 400);
      }
      const resource = form.get("resource");
      if (resource && String(resource) !== authCode.resource) {
        return tokenResponse({ error: "invalid_target" }, 400);
      }
      const computed = await sha256Base64url(codeVerifier);
      if (!constantTimeEqual(computed, authCode.codeChallenge)) {
        return tokenResponse(
          {
            error: "invalid_grant",
            error_description: "PKCE verification failed",
          },
          400,
        );
      }

      const identity = {
        clientId: authCode.clientId,
        googleSub: authCode.googleSub,
        googleEmail: authCode.googleEmail,
        scopes: authCode.scopes,
      };
      const access = await issueMcpAccessToken(
        { ...identity, googleAccessToken: authCode.googleAccessToken },
        authCode.googleAccessExpiresIn,
      );
      const refresh = await issueMcpRefreshToken({
        ...identity,
        googleRefreshToken: authCode.googleRefreshToken,
      });
      return tokenResponse({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: access.expiresIn,
        refresh_token: refresh,
        scope: authCode.scopes.join(" "),
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(form.get("refresh_token") ?? "");
      if (!refreshToken)
        return tokenResponse({ error: "invalid_request" }, 400);
      const stored = await readMcpRefreshToken(refreshToken);
      if (clientId && stored.clientId !== clientId) {
        return tokenResponse({ error: "invalid_grant" }, 400);
      }

      const google = await refreshGoogleAccessToken(stored.googleRefreshToken);
      const access = await issueMcpAccessToken(
        {
          clientId: stored.clientId,
          googleSub: stored.googleSub,
          googleEmail: stored.googleEmail,
          scopes: stored.scopes,
          googleAccessToken: google.access_token,
        },
        google.expires_in,
      );
      // Reissue our opaque refresh token while preserving Google's refresh grant.
      const rotatedRefresh = await issueMcpRefreshToken(stored);
      return tokenResponse({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: access.expiresIn,
        refresh_token: rotatedRefresh,
        scope: stored.scopes.join(" "),
      });
    }

    return tokenResponse({ error: "unsupported_grant_type" }, 400);
  } catch (error) {
    return tokenResponse(
      {
        error: "invalid_grant",
        error_description:
          error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
