/**
 * Key material held in memory while unlocked: the account keypair and every vault key
 * this session has unwrapped, per `key_version`. `wipe` zeroes all of it on lock.
 */
export class Keyring {
  private readonly vaultKeys = new Map<string, Map<number, Uint8Array>>();
  private wiped = false;

  constructor(
    readonly publicKey: Uint8Array,
    private readonly secretKey: Uint8Array,
  ) {}

  get privateKey(): Uint8Array {
    if (this.wiped) throw new Error('keyring is wiped');
    return this.secretKey;
  }

  get isWiped(): boolean {
    return this.wiped;
  }

  get(vaultId: string, version: number): Uint8Array | undefined {
    return this.vaultKeys.get(vaultId)?.get(version);
  }

  set(vaultId: string, version: number, key: Uint8Array): void {
    let versions = this.vaultKeys.get(vaultId);
    if (!versions) this.vaultKeys.set(vaultId, (versions = new Map()));
    const old = versions.get(version);
    if (old && old !== key) old.fill(0);
    versions.set(version, key);
  }

  versions(vaultId: string): number[] {
    return [...(this.vaultKeys.get(vaultId)?.keys() ?? [])];
  }

  /** Forget one version of a vault key. */
  drop(vaultId: string, version: number): void {
    const versions = this.vaultKeys.get(vaultId);
    versions?.get(version)?.fill(0);
    versions?.delete(version);
  }

  /** Forget every key of a vault. */
  dropVault(vaultId: string): void {
    for (const key of this.vaultKeys.get(vaultId)?.values() ?? []) key.fill(0);
    this.vaultKeys.delete(vaultId);
  }

  wipe(): void {
    for (const vaultId of [...this.vaultKeys.keys()]) this.dropVault(vaultId);
    this.secretKey.fill(0);
    this.wiped = true;
  }
}
