import { describe, it, expect } from "vitest";
import { isAllowedOrigin, buildPlatformCorsOptions } from "../Utils/corsHelper.js";

describe("CORS Helper & Origin Validation", () => {
  it("allows requests with no origin (curl, mobile native, server-to-server)", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("")).toBe(true);
  });

  it("allows localhost on standard and arbitrary development ports", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5174")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8080")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
  });

  it("allows official Melvin apex and subdomains", () => {
    expect(isAllowedOrigin("https://melvingadgets.com")).toBe(true);
    expect(isAllowedOrigin("https://www.melvingadgets.com")).toBe(true);
    expect(isAllowedOrigin("https://verifications.melvingadgets.app")).toBe(true);
    expect(isAllowedOrigin("https://sub.sub.melvingadgets.com")).toBe(true);
  });

  it("allows Melvin OS and sub-projects on Vercel", () => {
    expect(isAllowedOrigin("https://melvin-os-pink.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://melvin-os.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://melvin-os-preview-123.vercel.app")).toBe(true);
  });

  it("allows EasyBuy and Store frontends on Vercel including PR previews", () => {
    expect(isAllowedOrigin("https://aurapaytracker.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://easybuy-frontend-bbox.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://aurapaytrack-git-feat-apply-merge-melvingadgets-projects.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://store-melvingadgets-projects.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://store-52og2d0c9-melvingadgets-projects.vercel.app")).toBe(true);
  });

  it("allows explicit origins passed in config", () => {
    const custom = ["https://custom-partner.com", "https://staging-client.org"];
    expect(isAllowedOrigin("https://custom-partner.com", custom)).toBe(true);
    expect(isAllowedOrigin("https://staging-client.org", custom)).toBe(true);
    expect(isAllowedOrigin("https://unauthorized-partner.com", custom)).toBe(false);
  });

  it("rejects unauthorized and malicious origins", () => {
    expect(isAllowedOrigin("https://evil-attacker.com")).toBe(false);
    expect(isAllowedOrigin("https://melvingadgets.com.evil.org")).toBe(false);
    expect(isAllowedOrigin("https://melvin-os.attacker.com")).toBe(false);
    expect(isAllowedOrigin("https://random-app.vercel.app")).toBe(false);
  });

  it("builds cors options with credentials: true and appropriate headers", () => {
    const opts = buildPlatformCorsOptions(["https://custom.com"]);
    expect(opts.credentials).toBe(true);
    expect(opts.optionsSuccessStatus).toBe(204);
    expect(opts.allowedHeaders).toContain("Authorization");
    expect(opts.allowedHeaders).toContain("x-melvin-device");
    expect(opts.allowedHeaders).toContain("x-request-id");
    expect(opts.exposedHeaders).toContain("x-request-id");
  });
});
