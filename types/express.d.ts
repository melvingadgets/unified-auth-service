import type { ServiceCaller, UserCaller } from "@melvingadgets/platform-kit";
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
      // A calling service, verified by its service token or, at /oauth/token, its client secret.
      service?: ServiceCaller | { id: string };
      // A person verified from an RS256 user token.
      person?: UserCaller;
      // Set by the platform kit's route guards; the request log records only verified callers.
      caller?: { type: "service" | "user" | "anonymous"; id?: string };
    }
  }
}

export {};
