import type { JwtUserPayload } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: JwtUserPayload;
      authToken?: string;
      authSession?: {
        jti: string;
      };
    }
  }
}

export {};
