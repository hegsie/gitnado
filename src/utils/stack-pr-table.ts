import type { Stack } from '../types/git.types.ts';

export const STACK_SECTION_START = '<!-- gitnado-stack:start -->';
export const STACK_SECTION_END = '<!-- gitnado-stack:end -->';

export interface StackPrRef {
  number: number;
  url: string;
}

/**
 * The stack table written into every request of a stack: top to bottom, each
 * branch linked to its request, the reader's own request marked, the base
 * last. Wrapped in markers so later syncs replace it in place and leave the
 * rest of the description alone.
 */
export function renderStackSection(
  stack: Stack,
  prs: Map<string, StackPrRef>,
  current: string,
  refPrefix: '#' | '!',
): string {
  const lines = [...stack.branches].reverse().map((b) => {
    const pr = prs.get(b.name);
    const label = pr ? `[${refPrefix}${pr.number}](${pr.url}) \`${b.name}\`` : `\`${b.name}\``;
    return `- ${label}${b.name === current ? ' ← this one' : ''}`;
  });
  return [
    STACK_SECTION_START,
    '**Stack** (top to bottom; kept up to date by Gitnado)',
    '',
    ...lines,
    `- \`${stack.base}\``,
    STACK_SECTION_END,
  ].join('\n');
}

/** Replace the stack section in a description, or append it. */
export function spliceStackSection(body: string | null | undefined, section: string): string {
  const text = body ?? '';
  const start = text.indexOf(STACK_SECTION_START);
  const end = text.indexOf(STACK_SECTION_END, start + 1);
  if (start !== -1 && end !== -1) {
    return text.slice(0, start) + section + text.slice(end + STACK_SECTION_END.length);
  }
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n${section}` : section;
}
