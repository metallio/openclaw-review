import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  VaultDeleteOptions,
  VaultEntry,
  VaultGetOptions,
  VaultListResult,
  VaultPutOptions,
  VaultStore,
} from "./types.js";
import { VaultStoreSchema } from "./types.js";
import { decrypt, deriveMasterKey, encrypt, generateSalt, hashMasterKey } from "./crypto.js";

/**
 * SecureVault — encrypted, file-based credential store.
 *
 * Each agent instance has its own vault file, encrypted with a local master key.
 * No credentials ever leave the host machine in plaintext.
 */
export class SecureVault {
  private store: VaultStore | null = null;
  private key: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(
    private readonly vaultPath: string,
    private readonly saltPath: string,
  ) {}

  /**
   * Opens (or creates) the vault with the given master password.
   */
  async open(masterPassword: string): Promise<void> {
    // Load or generate salt
    try {
      this.salt = Buffer.from(await fs.readFile(this.saltPath, "utf8"), "base64");
    } catch {
      this.salt = generateSalt();
      await fs.mkdir(path.dirname(this.saltPath), { recursive: true });
      await fs.writeFile(this.saltPath, this.salt.toString("base64"), "utf8");
    }

    this.key = deriveMasterKey(masterPassword, this.salt);
    const masterKeyHash = hashMasterKey(masterPassword);

    // Try loading existing vault
    try {
      const raw = await fs.readFile(this.vaultPath, "utf8");
      const parsed = VaultStoreSchema.parse(JSON.parse(raw));

      if (parsed.masterKeyHash !== masterKeyHash) {
        throw new Error("Vault master key mismatch — wrong password");
      }
      this.store = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.store = { version: 1, entries: [], masterKeyHash };
        await this.persist();
      } else {
        throw err;
      }
    }
  }

  /**
   * Stores a credential in the vault.
   */
  async put(opts: VaultPutOptions): Promise<string> {
    this.ensureOpen();

    const { ciphertext, iv, authTag } = encrypt(opts.plaintext, this.key!);
    const now = new Date().toISOString();
    const id = opts.id ?? randomUUID();

    // Remove existing entry with same id if updating
    this.store!.entries = this.store!.entries.filter((e) => e.id !== id);

    const entry: VaultEntry = {
      id,
      service: opts.service,
      kind: opts.kind,
      label: opts.label,
      ciphertext,
      iv,
      authTag,
      createdAt: now,
      updatedAt: now,
      ttlMs: opts.ttlMs,
    };

    this.store!.entries.push(entry);
    await this.persist();
    return id;
  }

  /**
   * Retrieves a decrypted credential from the vault.
   */
  get(opts: VaultGetOptions): string | null {
    this.ensureOpen();

    const entry = this.findEntry(opts);
    if (!entry) return null;

    if (this.isExpired(entry)) return null;

    return decrypt(entry.ciphertext, entry.iv, entry.authTag, this.key!);
  }

  /**
   * Lists credentials without decrypting them.
   */
  list(service?: string): VaultListResult[] {
    this.ensureOpen();

    return this.store!.entries
      .filter((e) => !service || e.service === service)
      .map((e) => ({
        id: e.id,
        service: e.service,
        kind: e.kind,
        label: e.label,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        expired: this.isExpired(e),
      }));
  }

  /**
   * Deletes a credential from the vault.
   */
  async delete(opts: VaultDeleteOptions): Promise<boolean> {
    this.ensureOpen();

    const before = this.store!.entries.length;
    this.store!.entries = this.store!.entries.filter((e) => e.id !== opts.id);
    const removed = this.store!.entries.length < before;

    if (removed) await this.persist();
    return removed;
  }

  /**
   * Rotates a credential: stores new value with reference to old entry id.
   */
  async rotate(id: string, newPlaintext: string): Promise<string> {
    this.ensureOpen();

    const existing = this.store!.entries.find((e) => e.id === id);
    if (!existing) throw new Error(`Vault entry ${id} not found for rotation`);

    const { ciphertext, iv, authTag } = encrypt(newPlaintext, this.key!);
    const now = new Date().toISOString();
    const newId = randomUUID();

    const rotated: VaultEntry = {
      ...existing,
      id: newId,
      ciphertext,
      iv,
      authTag,
      updatedAt: now,
      rotatedFrom: id,
    };

    // Replace old entry
    this.store!.entries = this.store!.entries.filter((e) => e.id !== id);
    this.store!.entries.push(rotated);

    await this.persist();
    return newId;
  }

  /**
   * Purges expired entries from storage.
   */
  async purgeExpired(): Promise<number> {
    this.ensureOpen();

    const before = this.store!.entries.length;
    this.store!.entries = this.store!.entries.filter((e) => !this.isExpired(e));
    const purged = before - this.store!.entries.length;

    if (purged > 0) await this.persist();
    return purged;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private ensureOpen(): asserts this is { store: VaultStore; key: Buffer } {
    if (!this.store || !this.key) {
      throw new Error("Vault is not open — call open() first");
    }
  }

  private findEntry(opts: VaultGetOptions): VaultEntry | undefined {
    return this.store!.entries.find(
      (e) =>
        e.service === opts.service &&
        (!opts.kind || e.kind === opts.kind) &&
        (!opts.label || e.label === opts.label),
    );
  }

  private isExpired(entry: VaultEntry): boolean {
    if (!entry.ttlMs) return false;
    const created = new Date(entry.createdAt).getTime();
    return Date.now() > created + entry.ttlMs;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.vaultPath), { recursive: true });
    await fs.writeFile(this.vaultPath, JSON.stringify(this.store, null, 2), "utf8");
  }
}
