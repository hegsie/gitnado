/**
 * Commit message trailers (`Signed-off-by:`, `Co-authored-by:`).
 *
 * Git treats trailers as a *footer*: the last paragraph of the message, one
 * `Token: value` per line, separated from the body by a blank line. Everything
 * here is pure string work so the composition rules can be tested on their own
 * and reused by the commit panel for both fresh commits and amends.
 */

export interface Trailer {
  token: string;
  value: string;
}

export interface CoAuthor {
  name: string;
  email: string;
}

export const SIGNED_OFF_BY = 'Signed-off-by';
export const CO_AUTHORED_BY = 'Co-authored-by';

/**
 * One trailer line. Git's own parser is looser (it accepts folded continuation
 * lines and a mixed block), but recognising *less* is the safe direction: an
 * unrecognised paragraph is simply left in the body untouched instead of being
 * rewritten.
 */
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(\S.*?)[ \t\r]*$/;

/** `Name <email>` as it appears in a trailer value. */
const IDENTITY_VALUE = /^(.*?)\s*<([^<>]+)>$/;

/** Deliberately permissive: git does not validate emails either. */
const EMAIL = /^[^\s<>@]+@[^\s<>@]+$/;

/** Render one trailer as the line that goes in the message. */
export function formatTrailer(trailer: Trailer): string {
  return `${trailer.token}: ${trailer.value}`;
}

/**
 * Identity key for de-duplication. Trailer tokens are case-insensitive in git
 * (`git interpret-trailers` matches them that way), and so are email domains
 * in practice — GitHub attributes co-authors by email regardless of case.
 */
export function trailerKey(trailer: Trailer): string {
  return `${trailer.token.toLowerCase()}:${trailer.value.trim().toLowerCase()}`;
}

/** `Name <email>`, the shape both trailers require. */
export function formatIdentity(name: string, email: string): string {
  return `${name.trim()} <${email.trim()}>`;
}

export function signedOffByTrailer(name: string, email: string): Trailer {
  return { token: SIGNED_OFF_BY, value: formatIdentity(name, email) };
}

export function coAuthoredByTrailer(coAuthor: CoAuthor): Trailer {
  return { token: CO_AUTHORED_BY, value: formatIdentity(coAuthor.name, coAuthor.email) };
}

/** Two identities are the same person when their emails match, case-insensitively. */
export function sameCoAuthor(a: CoAuthor, b: CoAuthor): boolean {
  return a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
}

/** Parse a trailer value of the form `Name <email>`. Returns null otherwise. */
export function parseIdentityValue(value: string): CoAuthor | null {
  const match = IDENTITY_VALUE.exec(value.trim());
  if (!match) return null;
  const name = match[1].trim();
  const email = match[2].trim();
  if (!name || !EMAIL.test(email)) return null;
  return { name, email };
}

/**
 * Parse what the user typed into the co-author box.
 *
 * Returns an error string rather than throwing so the caller always has
 * something concrete to show: a silently ignored entry is the worst outcome.
 */
export function parseCoAuthorInput(input: string): { coAuthor?: CoAuthor; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: 'Enter a co-author as: Name <email@example.com>' };
  }
  const coAuthor = parseIdentityValue(trimmed);
  if (!coAuthor) {
    return { error: `"${trimmed}" is not a valid co-author. Use: Name <email@example.com>` };
  }
  return { coAuthor };
}

export interface SplitMessage {
  /** The message without its trailer footer (trailing blank lines removed). */
  body: string;
  /** The trailers found in the footer, in the order they appear. */
  trailers: Trailer[];
}

export interface SplitOptions {
  /**
   * Allow the *only* paragraph to be the trailer block. Off by default because
   * in a full commit message that paragraph is the subject line — `git` never
   * reads the subject as a trailer. Turn it on when parsing a message body that
   * has already had its subject split off.
   */
  allowSingleParagraph?: boolean;
}

/**
 * Split a commit message into its body and its trailer footer.
 *
 * The footer is only recognised when the last paragraph consists *entirely* of
 * trailer lines; otherwise the message is returned untouched with no trailers,
 * so a hand-written footer that merely looks close to one is never rewritten.
 */
export function splitTrailers(message: string, options: SplitOptions = {}): SplitMessage {
  const lines = message.split('\n');

  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end === 0) return { body: message, trailers: [] };

  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '') start--;

  if (start === 0 && !options.allowSingleParagraph) {
    // The last paragraph is also the first — that is the subject, not a footer.
    return { body: message, trailers: [] };
  }

  const block = lines.slice(start, end);
  const trailers: Trailer[] = [];
  for (const line of block) {
    const match = TRAILER_LINE.exec(line);
    if (!match) return { body: message, trailers: [] };
    trailers.push({ token: match[1], value: match[2] });
  }

  const body = lines.slice(0, start).join('\n').replace(/\n+$/, '');
  return { body, trailers };
}

/**
 * Append `additions` to `existing`, skipping any that are already present.
 * Adding the same co-author twice is a no-op.
 */
export function mergeTrailers(existing: Trailer[], additions: Trailer[]): Trailer[] {
  const seen = new Set(existing.map(trailerKey));
  const merged = [...existing];
  for (const trailer of additions) {
    const key = trailerKey(trailer);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trailer);
  }
  return merged;
}

/** Join a body and a trailer footer with exactly one blank line between them. */
export function composeMessage(body: string, trailers: Trailer[]): string {
  const trimmedBody = body.replace(/\n+$/, '');
  if (trailers.length === 0) return trimmedBody;
  const footer = trailers.map(formatTrailer).join('\n');
  return trimmedBody ? `${trimmedBody}\n\n${footer}` : footer;
}

/**
 * Add trailers to a message: existing footer trailers are kept in place, new
 * ones are appended after them, and duplicates are dropped.
 *
 * With nothing to add the message is returned byte-for-byte unchanged — a
 * user's hand-formatted message is never reflowed by a feature they aren't
 * using.
 */
export function applyTrailers(message: string, additions: Trailer[]): string {
  if (additions.length === 0) return message;
  const { body, trailers } = splitTrailers(message);
  return composeMessage(body, mergeTrailers(trailers, additions));
}

export interface AdoptedTrailers {
  /** The message with the adopted trailer lines removed. */
  message: string;
  /** Co-authors found in the footer. */
  coAuthors: CoAuthor[];
  /** True when the footer already signs off as `identity`. */
  signedOff: boolean;
}

/**
 * Take over the trailers of an existing message (an amend) so the panel's
 * controls show the real state instead of silently re-adding what is already
 * there.
 *
 * Only trailers the UI can represent are removed from the text: co-authors, and
 * a sign-off by `identity`. Anything else — including a sign-off by somebody
 * else — stays in the message untouched, because dropping a line the user has
 * no control to restore would lose it.
 */
export function adoptTrailers(
  message: string,
  identity: CoAuthor | null,
  options: SplitOptions = {},
): AdoptedTrailers {
  const { body, trailers } = splitTrailers(message, options);
  if (trailers.length === 0) {
    return { message, coAuthors: [], signedOff: false };
  }

  const coAuthors: CoAuthor[] = [];
  const kept: Trailer[] = [];
  let signedOff = false;

  for (const trailer of trailers) {
    const token = trailer.token.toLowerCase();
    const parsed = parseIdentityValue(trailer.value);

    if (token === CO_AUTHORED_BY.toLowerCase() && parsed) {
      if (!coAuthors.some((c) => sameCoAuthor(c, parsed))) coAuthors.push(parsed);
      continue;
    }
    if (
      token === SIGNED_OFF_BY.toLowerCase() &&
      parsed &&
      identity &&
      sameCoAuthor(parsed, identity)
    ) {
      signedOff = true;
      continue;
    }
    kept.push(trailer);
  }

  return { message: composeMessage(body, kept), coAuthors, signedOff };
}
