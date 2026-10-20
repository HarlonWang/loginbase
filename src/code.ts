export const CODE_TTL_SECONDS = 600;
export const MAX_ATTEMPTS = 5;

/**
 * 验证码用途（3.1.0 起）：登录码与删号码分存不同键位，互不可代用——
 * 否则拿到一封登录邮件里的码就能删号，反之亦然。
 */
export type CodePurpose = "sign_in" | "delete_account";

const KEY_PREFIX: Record<CodePurpose, string> = {
  sign_in: "code",
  delete_account: "delete_code",
};
const codeKey = (email: string, purpose: CodePurpose) => `${KEY_PREFIX[purpose]}:${email}`;

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
  code: string,
  purpose: CodePurpose = "sign_in"
): Promise<void> {
  const payload: StoredCode = { code, attempts: 0, issuedAt: Date.now() };
  await kv.put(codeKey(email, purpose), JSON.stringify(payload), {
    expirationTtl: CODE_TTL_SECONDS,
  });
}

export async function readCode(
  kv: KVNamespace,
  email: string,
  purpose: CodePurpose = "sign_in"
): Promise<StoredCode | null> {
  const raw = await kv.get(codeKey(email, purpose));
  return raw ? (JSON.parse(raw) as StoredCode) : null;
}

export async function deleteCode(
  kv: KVNamespace,
  email: string,
  purpose: CodePurpose = "sign_in"
): Promise<void> {
  await kv.delete(codeKey(email, purpose));
}

export async function incrementAttempts(
  kv: KVNamespace,
  email: string,
  stored: StoredCode,
  purpose: CodePurpose = "sign_in"
): Promise<number> {
  stored.attempts += 1;
  const remainingTtl = Math.max(
    1,
    CODE_TTL_SECONDS - Math.floor((Date.now() - stored.issuedAt) / 1000)
  );
  await kv.put(codeKey(email, purpose), JSON.stringify(stored), {
    expirationTtl: remainingTtl,
  });
  return stored.attempts;
}
