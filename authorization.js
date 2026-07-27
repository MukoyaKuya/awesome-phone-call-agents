import { createHash } from "node:crypto";

export function actorFromClaims(payload, issuer) {
  if (typeof payload?.sub !== "string" || !payload.sub.trim()) return null;
  const permissions = new Set();
  for (const claim of [payload.scope, payload.scp]) {
    if (typeof claim === "string") for (const value of claim.split(/\s+/).filter(Boolean)) permissions.add(value);
  }
  const roles = Array.isArray(payload.roles) ? payload.roles : typeof payload.roles === "string" ? [payload.roles] : [];
  for (const role of roles) if (typeof role === "string" && role) permissions.add(role);
  return {
    subject: createHash("sha256").update(`${issuer}\0${payload.sub}`).digest("hex"),
    permissions
  };
}

export function hasPermission(actor, permission) {
  return Boolean(actor?.permissions?.has(permission));
}
