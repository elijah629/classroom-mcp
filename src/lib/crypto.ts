import { CompactEncrypt, compactDecrypt } from "jose";
import { config } from "./config";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let keyPromise: Promise<Uint8Array> | undefined;

async function encryptionKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    keyPromise = crypto.subtle
      .digest("SHA-256", encoder.encode(config.authSecret))
      .then((hash) => new Uint8Array(hash));
  }
  return keyPromise;
}

export interface EnvelopeBase {
  typ: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export async function seal<T extends object>(
  typ: string,
  data: T,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: EnvelopeBase = {
    ...data,
    typ,
    iat: now,
    exp: now + ttlSeconds,
  };
  return new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .encrypt(await encryptionKey());
}

export async function unseal<T extends object>(
  token: string,
  expectedType: string,
): Promise<T & EnvelopeBase> {
  const { plaintext } = await compactDecrypt(token, await encryptionKey());
  const parsed = JSON.parse(decoder.decode(plaintext)) as T & EnvelopeBase;
  const now = Math.floor(Date.now() / 1000);
  if (parsed.typ !== expectedType) throw new Error("invalid_token_type");
  if (!parsed.exp || parsed.exp <= now) throw new Error("expired_token");
  return parsed;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function sha256Base64url(value: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64url(data);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
