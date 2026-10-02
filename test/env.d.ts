declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    EMAIL_CODES: KVNamespace;
    JWT_SECRET: string;
    EMAIL_FROM_ADDRESS: string;
  }
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}
