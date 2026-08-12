import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const ACCESS_TTL_SECONDS = 3600;

export interface AccessPayload extends JWTPayload {
  sub: string;
  sid: string;
}

export async function signAccessToken(
  secret: string,
  userId: string,
  sessionId: string,
  ttlSeconds: number = ACCESS_TTL_SECONDS
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ sub: userId, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyAccessToken(
  secret: string,
  token: string
): Promise<AccessPayload> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key);
  return payload as AccessPayload;
}
