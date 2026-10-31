export type AuthRole = "User" | "Admin" | "SuperAdmin";

/**
 * Narrow non-staff capabilities, granted on top of the global role (rbac-unification.md).
 * A domain role only ever adds permissions; it never ranks and never makes someone staff.
 */
export type DomainRole = "market:salesperson";

export const DOMAIN_ROLES: readonly DomainRole[] = ["market:salesperson"];

export type AuthApp = "easybuy" | "ecommerce" | "auth-service";

export type JwtUserPayload = {
  _id: string;
  email: string;
  fullName: string;
  role: AuthRole;
  domainRoles?: DomainRole[];
  jti: string;
  app: AuthApp;
};
