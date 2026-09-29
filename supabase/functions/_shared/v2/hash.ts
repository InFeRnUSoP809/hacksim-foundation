import { shortHash } from "../ai.ts";

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function snippetHash(text: string): Promise<string> {
  return (await sha256Hex(text.slice(0, 4000))).slice(0, 32);
}

export async function packetHash(parts: unknown[]): Promise<string> {
  return shortHash(JSON.stringify(parts));
}
