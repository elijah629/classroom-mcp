function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function origin(): string {
  const value = required("APP_ORIGIN").replace(/\/$/, "");
  const url = new URL(value);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("APP_ORIGIN must use HTTPS outside localhost");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "APP_ORIGIN must contain only scheme, host, and optional port",
    );
  }
  return url.origin;
}

function authSecret(): string {
  const value = required("AUTH_SECRET");
  if (value.length < 32)
    throw new Error("AUTH_SECRET must be at least 32 characters");
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  get origin() {
    return origin();
  },
  get mcpUrl() {
    return `${this.origin}/mcp`;
  },
  get googleClientId() {
    return required("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret() {
    return required("GOOGLE_CLIENT_SECRET");
  },
  get authSecret() {
    return authSecret();
  },
  get googleCallbackUrl() {
    return `${this.origin}/oauth/google/callback`;
  },
  get allowedGoogleEmails(): string[] {
    return (process.env.ALLOWED_GOOGLE_EMAILS ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
  },
  get allowedCimdHosts(): string[] {
    return (process.env.ALLOWED_CIMD_HOSTS ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
  },
  maxAttachmentTextChars: integer("MAX_ATTACHMENT_TEXT_CHARS", 80_000),
  maxPdfBytes: integer("MAX_PDF_BYTES", 12 * 1024 * 1024),
  maxPdfPages: integer("MAX_PDF_PAGES", 120),
} as const;

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.topics.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

export const MCP_SCOPES = ["mcp", "offline_access"] as const;
