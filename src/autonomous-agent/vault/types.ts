import { z } from "zod";

// ── Credential types stored in the vault ──────────────────────────────────────

export const CredentialKindSchema = z.enum([
  "api-token",
  "oauth-token",
  "email-imap",
  "email-smtp",
  "webhook-secret",
  "ssh-key",
  "generic",
]);

export type CredentialKind = z.infer<typeof CredentialKindSchema>;

export const VaultEntrySchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  kind: CredentialKindSchema,
  label: z.string().optional(),
  /** Encrypted payload — opaque base64 blob */
  ciphertext: z.string(),
  /** IV for AES-GCM */
  iv: z.string(),
  /** Auth tag for AES-GCM */
  authTag: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Optional TTL in ms — vault auto-expires entries */
  ttlMs: z.number().int().nonnegative().optional(),
  /** Metadata for rotation tracking */
  rotatedFrom: z.string().optional(),
});

export type VaultEntry = z.infer<typeof VaultEntrySchema>;

export const VaultStoreSchema = z.object({
  version: z.literal(1),
  entries: z.array(VaultEntrySchema),
  masterKeyHash: z.string(),
});

export type VaultStore = z.infer<typeof VaultStoreSchema>;

// ── Vault operations ─────────────────────────────────────────────────────────

export type VaultGetOptions = {
  service: string;
  kind?: CredentialKind;
  label?: string;
};

export type VaultPutOptions = {
  id?: string;
  service: string;
  kind: CredentialKind;
  label?: string;
  plaintext: string;
  ttlMs?: number;
};

export type VaultDeleteOptions = {
  id: string;
};

export type VaultListResult = {
  id: string;
  service: string;
  kind: CredentialKind;
  label?: string;
  createdAt: string;
  updatedAt: string;
  expired: boolean;
};
