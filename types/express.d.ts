import type { JwtUserPayload } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: JwtUserPayload;
      authToken?: string;
      authSession?: {
        jti: string;
      };
      traceId?: string;
      // Set by service-token verification once services authenticate to each other.
      service?: {
        id: string;
      };
    }
  }
}

export {};
