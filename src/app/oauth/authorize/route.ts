import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { seal } from "@/lib/crypto";
import { googleAuthorizationUrl } from "@/lib/google-auth";
import { normalizeRequestedScopes, resolveOAuthClient } from "@/lib/oauth";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const responseType = url.searchParams.get("response_type");
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");
    const state = url.searchParams.get("state");
    const resource = url.searchParams.get("resource");

    if (responseType !== "code")
      return NextResponse.json(
        { error: "unsupported_response_type" },
        { status: 400 },
      );
    if (!clientId || !redirectUri)
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return NextResponse.json(
        {
          error: "invalid_request",
          error_description: "PKCE S256 is required",
        },
        { status: 400 },
      );
    }
    if (resource && resource !== config.mcpUrl) {
      return NextResponse.json(
        {
          error: "invalid_target",
          error_description: "Unexpected OAuth resource",
        },
        { status: 400 },
      );
    }

    const client = await resolveOAuthClient(clientId);
    if (!client.redirectUris.includes(redirectUri)) {
      return NextResponse.json(
        {
          error: "invalid_request",
          error_description: "redirect_uri is not registered",
        },
        { status: 400 },
      );
    }

    const scopes = normalizeRequestedScopes(url.searchParams.get("scope"));
    const googleState = await seal(
      "google-oauth-state",
      {
        clientId,
        redirectUri,
        clientState: state,
        codeChallenge,
        scopes,
        resource: resource ?? config.mcpUrl,
      },
      10 * 60,
    );

    return NextResponse.redirect(googleAuthorizationUrl(googleState));
  } catch (error) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description:
          error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
}
