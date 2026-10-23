import { createTokenSigner, createTokenVerifier, type TokenSigner, type TokenVerifier } from "@melvingadgets/platform-kit";
import { config } from "../config/Config.js";

// RS256 platform tokens (Shortwork/AGENTS.md §2). Null until signing keys are
// configured, so the service keeps working on legacy tokens alone (§7.1).
export const platformSigner: TokenSigner | null =
  config.signingKeys.length > 0
    ? createTokenSigner({ issuer: config.issuer, keys: config.signingKeys, activeKid: config.activeKid })
    : null;

// Auth checks the tokens it issued against its own keys, without an HTTP round trip.
let verifier: Promise<TokenVerifier> | null = null;
export const platformVerifier = (): Promise<TokenVerifier> | null => {
  if (!platformSigner) return null;
  verifier ??= platformSigner.jwks().then((jwks) => createTokenVerifier({ issuer: config.issuer, jwks }));
  return verifier;
};
