import { NextResponse } from "next/server";
import { issueDcrClient } from "@/lib/oauth";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((v): v is string => typeof v === "string")
      : [];
    if (!redirectUris.length) {
      return NextResponse.json(
        {
          error: "invalid_client_metadata",
          error_description: "redirect_uris required",
        },
        { status: 400 },
      );
    }
    const clientId = await issueDcrClient({
      redirect_uris: redirectUris,
      client_name:
        typeof body.client_name === "string" ? body.client_name : undefined,
    });
    return NextResponse.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        client_name:
          typeof body.client_name === "string" ? body.client_name : undefined,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description:
          error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
