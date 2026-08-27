import { oauthMetadata } from "@/lib/oauth";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(oauthMetadata, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
