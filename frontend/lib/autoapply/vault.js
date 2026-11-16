/**
 * AutoApply vault — AES-256-GCM, byte-compatible with the Python workers
 * (cryptography AESGCM). Contract: docs/autoapply-contract.md "Vault format".
 *
 *   key   = base64 of 32 bytes (env AA_VAULT_KEY)
 *   AAD   = `${user_id}|${tenant_host}`
 *   blob  = base64(nonce[12] || ciphertext || tag[16])
 */
import crypto from "node:crypto";

export function loadKey(b64 = process.env.AA_VAULT_KEY) {
  if (!b64) {
    const e = new Error("AA_VAULT_KEY is not set.");
    e.code = "vault_unconfigured";
    throw e;
  }
  const key = Buffer.from(String(b64).trim(), "base64");
  if (key.length !== 32) {
    const e = new Error("AA_VAULT_KEY must be base64 of exactly 32 bytes.");
    e.code = "vault_unconfigured";
    throw e;
  }
  return key;
}

export const aadFor = (userId, tenantHost) => Buffer.from(`${userId}|${tenantHost}`, "utf8");

export function encryptSecret(plaintext, userId, tenantHost, { key, nonce } = {}) {
  const k = key ? (Buffer.isBuffer(key) ? key : loadKey(key)) : loadKey();
  const iv = nonce || crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(aadFor(userId, tenantHost));
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}

export function decryptSecret(blobB64, userId, tenantHost, { key } = {}) {
  const k = key ? (Buffer.isBuffer(key) ? key : loadKey(key)) : loadKey();
  const raw = Buffer.from(String(blobB64 || ""), "base64");
  if (raw.length < 12 + 16) {
    const e = new Error("ciphertext too short");
    e.code = "decrypt_failed";
    throw e;
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
    d.setAAD(aadFor(userId, tenantHost));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    const e = new Error("decrypt failed (wrong key, AAD or tampered blob)");
    e.code = "decrypt_failed";
    throw e;
  }
}
