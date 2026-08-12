export const CODE_TTL_SECONDS = 600;
export const MAX_ATTEMPTS = 5;

export interface StoredCode {
  code: string;
  attempts: number;
  issuedAt: number;
}

export function generateCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (array[0] % 1_000_000).toString().padStart(6, "0");
}

export async function storeCode(
  kv: KVNamespace,
  email: string,
  code: string
): Promise<void> {
  const payload: StoredCode = { code, attempts: 0, issuedAt: Date.now() };
  await kv.put(`code:${email}`, JSON.stringify(payload), {
    expirationTtl: CODE_TTL_SECONDS,
  });
}

export async function readCode(
  kv: KVNamespace,
  email: string
): Promise<StoredCode | null> {
  const raw = await kv.get(`code:${email}`);
  return raw ? (JSON.parse(raw) as StoredCode) : null;
}

export async function deleteCode(kv: KVNamespace, email: string): Promise<void> {
  await kv.delete(`code:${email}`);
}

export async function incrementAttempts(
  kv: KVNamespace,
  email: string,
  stored: StoredCode
): Promise<number> {
  stored.attempts += 1;
  const remainingTtl = Math.max(
    1,
    CODE_TTL_SECONDS - Math.floor((Date.now() - stored.issuedAt) / 1000)
  );
  await kv.put(`code:${email}`, JSON.stringify(stored), {
    expirationTtl: remainingTtl,
  });
  return stored.attempts;
}
