/** Internal bounded race history. Not part of the package's public exports. */

interface ResourceEpoch {
  epoch: number;
  authoritativeEpoch: number;
  conservative?: boolean;
}

export const MAX_RESOURCE_EPOCH_ENTRIES = 1_024;

/**
 * Missing keys use conservative eviction watermarks, never epoch zero. This
 * prevents forgotten authority from making an older response eligible again.
 * Separate watermarks keep speculative prefetch from vetoing navigation.
 */
export class ResourceEpochMap extends Map<string, ResourceEpoch> {
  private evictedEpoch = 0;
  private evictedAuthoritativeEpoch = 0;

  override get(key: string): ResourceEpoch | undefined {
    return super.get(key) ?? (this.evictedEpoch === 0 ? undefined : {
      epoch: this.evictedEpoch,
      authoritativeEpoch: this.evictedAuthoritativeEpoch,
      conservative: true,
    });
  }

  override set(key: string, value: ResourceEpoch): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > MAX_RESOURCE_EPOCH_ENTRIES) {
      const oldest = this.keys().next().value!;
      const evicted = super.get(oldest)!;
      this.evictedEpoch = Math.max(this.evictedEpoch, evicted.epoch);
      this.evictedAuthoritativeEpoch = Math.max(
        this.evictedAuthoritativeEpoch, evicted.authoritativeEpoch
      );
      super.delete(oldest);
    }
    return this;
  }

  override clear(): void {
    super.clear();
    this.evictedEpoch = 0;
    this.evictedAuthoritativeEpoch = 0;
  }
}
