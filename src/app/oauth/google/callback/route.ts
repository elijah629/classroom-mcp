import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { seal, unseal } from "@/lib/crypto";
import {
  assertGoogleUserAllowed,
  exchangeGoogleCode,
  googleUserInfo,
} from "@/lib/google-auth";
import { oauthErrorRedirect } from "@/lib/oauth";

export const dynamic = "force-dynamic";

type GoogleState = {
  clientId: string;
  redirectUri: string;
  clientState?: string | null;
  codeChallenge: string;
  scopes: string[];
  resource: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");
  if (!stateToken)
    return NextResponse.json({ error: "missing_state" }, { status: 400 });

  let state: GoogleState & { exp: number; typ: string; iat: number };
  try {
    state = await unseal<GoogleState>(stateToken, "google-oauth-state");
  } catch {
    return NextResponse.json(
      { error: "invalid_or_expired_state" },
      { status: 400 },
    );
  }

  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    const redirect = oauthErrorRedirect(
      state.redirectUri,
      state.clientState ?? null,
      "access_denied",
      url.searchParams.get("error_description") ?? upstreamError,
    );
    redirect.searchParams.set("iss", config.origin);
    return NextResponse.redirect(redirect);
  }

  try {
    const code = url.searchParams.get("code");
    if (!code) throw new Error("missing_google_authorization_code");
    const google = await exchangeGoogleCode(code);
    if (!google.refresh_token) {
      throw new Error(
        "Google did not issue a refresh token. Reconnect and grant offline access again.",
      );
    }
    const user = await googleUserInfo(google.access_token);
    assertGoogleUserAllowed(user);

    const authorizationCode = await seal(
      "mcp-authorization-code",
      {
        clientId: state.clientId,
        redirectUri: state.redirectUri,
        codeChallenge: state.codeChallenge,
        scopes: state.scopes,
        googleScopes: google.scope?.split(/\s+/).filter(Boolean) ?? [],
        resource: state.resource,
        googleSub: user.sub,
        googleEmail: user.email,
        googleAccessToken: google.access_token,
        googleAccessExpiresIn: google.expires_in,
        googleRefreshToken: google.refresh_token,
      },
      5 * 60,
    );

    const redirect = new URL(state.redirectUri);
    redirect.searchParams.set("code", authorizationCode);
    if (state.clientState)
      redirect.searchParams.set("state", state.clientState);
    // RFC 9207 authorization response issuer parameter.
    redirect.searchParams.set("iss", config.origin);
    return NextResponse.redirect(redirect);
  } catch (error) {
    const redirect = oauthErrorRedirect(
      state.redirectUri,
      state.clientState ?? null,
      "server_error",
      error instanceof Error ? error.message : String(error),
    );
    redirect.searchParams.set("iss", config.origin);
    return NextResponse.redirect(redirect);
  }
}
