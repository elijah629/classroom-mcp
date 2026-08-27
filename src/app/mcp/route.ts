import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { config } from "@/lib/config";
import { buildMcpServer } from "@/lib/mcp-server";
import { verifyMcpAccessToken } from "@/lib/mcp-token";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const verifier: OAuthTokenVerifier = {
  verifyAccessToken: verifyMcpAccessToken,
};

const gate = requireBearerAuth({
  verifier,
  requiredScopes: ["mcp"],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
    new URL(config.mcpUrl),
  ),
});

const handler = createMcpHandler(({ authInfo }) => buildMcpServer(authInfo));

async function serve(request: Request): Promise<Response> {
  const expectedHost = new URL(config.origin).hostname;
  const rejected = hostHeaderValidationResponse(request, [expectedHost]);
  if (rejected) return rejected;

  const auth = await gate(request);
  if (auth instanceof Response) return auth;
  return handler.fetch(request, { authInfo: auth });
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
export const OPTIONS = serve;
