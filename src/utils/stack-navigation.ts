import type { Stack, StackBranch } from '../types/git.types.ts';

export type StackDirection = 'up' | 'down';

/** Where moving up or down a stack from `current` leads, or why it cannot. */
export type StackStep =
  | { target: string; note?: string }
  | { target?: undefined; reason: string };

/** The stack entry for `branch`, if it is stacked on something. */
export function findStackBranch(stacks: Stack[], branch: string): StackBranch | undefined {
  for (const stack of stacks) {
    const hit = stack.branches.find((b) => b.name === branch);
    if (hit) return hit;
  }
  return undefined;
}

/** Branches stacked directly on `branch`, in stack order. */
export function stackChildren(stacks: Stack[], branch: string): string[] {
  return stacks.flatMap((s) => s.branches.filter((b) => b.parent === branch).map((b) => b.name));
}

/**
 * The branch one level up (towards the top of the stack: a branch stacked on
 * `current`) or down (towards the base: `current`'s parent).
 */
export function stackStep(stacks: Stack[], current: string | null, direction: StackDirection): StackStep {
  if (!current) return { reason: 'HEAD is detached, so it is not on a stack' };
  const entry = findStackBranch(stacks, current);
  const children = stackChildren(stacks, current);
  if (!entry && children.length === 0) {
    return { reason: `${current} is not part of a stack` };
  }
  if (direction === 'down') {
    if (!entry) return { reason: `${current} is the base of its stack` };
    if (entry.parentMissing) return { reason: `${current}'s parent ${entry.parent} no longer exists` };
    return { target: entry.parent };
  }
  if (children.length === 0) return { reason: `${current} is the top of its stack` };
  const [first, ...others] = children;
  return others.length > 0
    ? { target: first, note: `${current} has ${children.length} branches stacked on it; switched to ${first}` }
    : { target: first };
}
