export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function snippetHash(excerpt: string): Promise<string> {
  return sha256Hex(excerpt.trim().slice(0, 4000));
}

export async function packetHash(parts: string[]): Promise<string> {
  return sha256Hex(parts.join("\n---\n"));
}
