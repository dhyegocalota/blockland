// Block resources, pure: mining a block banks one of its kind, placing spends one. The engine keeps
// a count per block id; this models the count math (never below zero, "have one to place") without
// any three.js or DOM, so it stays unit-tested. The display formatting lives here too: admins build
// freely (infinite) so their slots show no number, regular players see how many they banked.

export class BlockInventory {
  private readonly counts = new Map<number, number>();

  count(id: number): number {
    const have = this.counts.get(id);
    if (have === undefined) return 0;
    return have;
  }

  bank(id: number): void {
    this.counts.set(id, this.count(id) + 1);
  }

  canPlace(id: number): boolean {
    return this.count(id) > 0;
  }

  spend(id: number): void {
    if (!this.canPlace(id)) throw new Error(`cannot spend block ${id}: none banked`);
    this.counts.set(id, this.count(id) - 1);
  }
}

// Empty string hides the badge (infinite resources), otherwise the banked count.
export function hotbarCountLabel({ infiniteResources, count }: { infiniteResources: boolean; count: number }): string {
  if (infiniteResources) return '';
  return String(count);
}
