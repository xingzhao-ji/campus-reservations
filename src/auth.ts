import { createHash, timingSafeEqual } from "node:crypto";
import { Problem, type Principal } from "./service.js";
export const demoPrincipals: Record<string, Principal> = {
  alex: { id: "demo-alex", role: "member" },
  sam: { id: "demo-sam", role: "member" },
  admin: { id: "demo-admin", role: "admin" },
};
export function authentication(env: NodeJS.ProcessEnv = process.env) {
  const demo = env.DEMO_MODE === "true";
  if (demo && env.NODE_ENV === "production")
    throw new Error("DEMO_MODE is forbidden in production");
  let tokens: { digest: Buffer; principal: Principal }[] = [];
  if (!demo) {
    let entries: unknown;
    try {
      entries = JSON.parse(env.AUTH_TOKENS_JSON ?? "null");
    } catch {
      throw new Error("AUTH_TOKENS_JSON must be valid JSON");
    }
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error("Configure AUTH_TOKENS_JSON or explicit local DEMO_MODE");
    tokens = Object.entries(entries).map(([token, p]: [string, any]) => {
      if (
        token.length < 32 ||
        !p ||
        typeof p.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) ||
        !["admin", "member"].includes(p.role)
      )
        throw new Error("Invalid production credential configuration");
      return {
        digest: createHash("sha256").update(token).digest(),
        principal: { id: p.id, role: p.role },
      };
    });
    if (!tokens.length) throw new Error("At least one credential is required");
  }
  return {
    demo,
    resolve(headers: Record<string, any>): Principal {
      if (demo) {
        const name = String(headers["x-demo-principal"] ?? "");
        const p = Object.hasOwn(demoPrincipals, name)
          ? demoPrincipals[name]
          : undefined;
        if (!p) throw new Problem(401, "Choose a synthetic demo identity");
        return p;
      }
      const authorization = String(headers.authorization ?? "");
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const digest = createHash("sha256").update(token).digest();
      const found = tokens.find((entry) =>
        timingSafeEqual(entry.digest, digest),
      );
      if (!found) throw new Problem(401, "Valid bearer token required");
      return found.principal;
    },
  };
}
