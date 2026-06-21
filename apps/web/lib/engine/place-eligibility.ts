// Pure block-placement decisions: whether the selected block can be placed (infinite resources, or at
// least one banked) and whether placing it should spend from the bag. The raycast, world write and
// inventory mutation stay in the glue; this resolves the yes/no, unit-tested.

export function canPlaceSelected({ infiniteResources, count }: { infiniteResources: boolean; count: number }): boolean {
  if (infiniteResources) return true;
  return count > 0;
}

export function shouldSpendBlock({ infiniteResources }: { infiniteResources: boolean }): boolean {
  return !infiniteResources;
}
