import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const SCRYPT_COST = 16384;

/**
 * Derives a 256-bit key from the master password using scrypt.
 */
export function deriveMasterKey(masterPassword: string, salt: Buffer): Buffer {
  return scryptSync(masterPassword, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: 8,
    p: 1,
  });
}

/**
 * Generates a deterministic hash of the master password for vault integrity verification.
 * This hash is stored alongside the vault to verify the correct master key is used on open.
 */
export function hashMasterKey(masterPassword: string): string {
  const salt = "openclaw-vault-verify";
  return createHash("sha256").update(`${salt}:${masterPassword}`).digest("hex");
}

/**
 * Encrypts plaintext with AES-256-GCM using the derived key.
 * Returns { ciphertext, iv, authTag } — all as base64 strings.
 */
export function encrypt(
  plaintext: string,
  key: Buffer,
): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");

  return {
    ciphertext: encrypted,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypts a vault entry payload.
 */
export function decrypt(
  ciphertext: string,
  iv: string,
  authTag: string,
  key: Buffer,
): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Generates a random salt for key derivation.
 */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}
