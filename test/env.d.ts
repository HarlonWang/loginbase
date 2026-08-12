declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    EMAIL_CODES: KVNamespace;
    JWT_SECRET: string;
    EMAIL_FROM_ADDRESS: string;
    RESEND_API_KEY: string;
  }
}
