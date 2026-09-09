/**
 * Tests for commit message trailer composition.
 *
 * Trailers are a footer, not free text: git only recognises them in the last
 * paragraph, one per line, after a blank line. These tests pin the rules that
 * make a `Signed-off-by:`/`Co-authored-by:` line actually count.
 */

import { expect } from '@open-wc/testing';
import {
  adoptTrailers,
  applyTrailers,
  coAuthoredByTrailer,
  composeMessage,
  formatIdentity,
  formatTrailer,
  mergeTrailers,
  parseCoAuthorInput,
  parseIdentityValue,
  sameCoAuthor,
  signedOffByTrailer,
  splitTrailers,
  type Trailer,
} from '../commit-trailers.ts';

const ME = { name: 'Ada Lovelace', email: 'ada@example.com' };
const PAIR = { name: 'Grace Hopper', email: 'grace@example.com' };

describe('commit-trailers', () => {
  describe('formatting', () => {
    it('formats an identity as Name <email>', () => {
      expect(formatIdentity('Ada Lovelace', 'ada@example.com')).to.equal(
        'Ada Lovelace <ada@example.com>'
      );
    });

    it('trims stray whitespace out of the identity', () => {
      expect(formatIdentity('  Ada  ', ' ada@example.com ')).to.equal('Ada <ada@example.com>');
    });

    it('formats a trailer line as Token: value', () => {
      expect(formatTrailer(signedOffByTrailer(ME.name, ME.email))).to.equal(
        'Signed-off-by: Ada Lovelace <ada@example.com>'
      );
      expect(formatTrailer(coAuthoredByTrailer(PAIR))).to.equal(
        'Co-authored-by: Grace Hopper <grace@example.com>'
      );
    });
  });

  describe('composeMessage', () => {
    it('separates the footer from the body with exactly one blank line', () => {
      const message = composeMessage('feat: add login\n\nSome body text', [
        signedOffByTrailer(ME.name, ME.email),
      ]);
      expect(message).to.equal(
        'feat: add login\n\nSome body text\n\nSigned-off-by: Ada Lovelace <ada@example.com>'
      );
    });

    it('collapses trailing blank lines in the body rather than stacking them', () => {
      const message = composeMessage('subject\n\nbody\n\n\n', [coAuthoredByTrailer(PAIR)]);
      expect(message).to.equal('subject\n\nbody\n\nCo-authored-by: Grace Hopper <grace@example.com>');
    });

    it('puts one trailer per line', () => {
      const message = composeMessage('subject', [
        signedOffByTrailer(ME.name, ME.email),
        coAuthoredByTrailer(PAIR),
      ]);
      expect(message.split('\n').slice(-2)).to.deep.equal([
        'Signed-off-by: Ada Lovelace <ada@example.com>',
        'Co-authored-by: Grace Hopper <grace@example.com>',
      ]);
    });

    it('returns the body untouched when there are no trailers', () => {
      expect(composeMessage('subject\n\nbody', [])).to.equal('subject\n\nbody');
    });
  });

  describe('splitTrailers', () => {
    it('splits a trailing trailer paragraph off the body', () => {
      const { body, trailers } = splitTrailers(
        'subject\n\nbody\n\nSigned-off-by: Ada Lovelace <ada@example.com>'
      );
      expect(body).to.equal('subject\n\nbody');
      expect(trailers).to.deep.equal([
        { token: 'Signed-off-by', value: 'Ada Lovelace <ada@example.com>' },
      ]);
    });

    it('never reads the subject line as a trailer', () => {
      // A one-line message is the subject, even when it is shaped like one.
      const { body, trailers } = splitTrailers('Signed-off-by: Ada Lovelace <ada@example.com>');
      expect(trailers).to.deep.equal([]);
      expect(body).to.equal('Signed-off-by: Ada Lovelace <ada@example.com>');
    });

    it('reads a lone paragraph as trailers when the subject was already split off', () => {
      const { body, trailers } = splitTrailers('Co-authored-by: Grace Hopper <grace@example.com>', {
        allowSingleParagraph: true,
      });
      expect(body).to.equal('');
      expect(trailers).to.have.lengthOf(1);
    });

    it('leaves a mixed final paragraph alone rather than rewriting it', () => {
      const message = 'subject\n\nSee: the docs\nand also this prose line';
      const { body, trailers } = splitTrailers(message);
      expect(trailers).to.deep.equal([]);
      expect(body).to.equal(message);
    });

    it('ignores trailer-looking lines that are not in the last paragraph', () => {
      const message = 'subject\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n\nreal body';
      const { trailers } = splitTrailers(message);
      expect(trailers).to.deep.equal([]);
    });
  });

  describe('mergeTrailers', () => {
    it('drops an exact duplicate', () => {
      const merged = mergeTrailers(
        [coAuthoredByTrailer(PAIR)],
        [coAuthoredByTrailer(PAIR)]
      );
      expect(merged).to.have.lengthOf(1);
    });

    it('treats token and value case-insensitively when de-duplicating', () => {
      const existing: Trailer[] = [
        { token: 'co-authored-by', value: 'Grace Hopper <GRACE@example.com>' },
      ];
      const merged = mergeTrailers(existing, [coAuthoredByTrailer(PAIR)]);
      expect(merged).to.have.lengthOf(1);
    });

    it('keeps distinct trailers in order', () => {
      const merged = mergeTrailers(
        [signedOffByTrailer(ME.name, ME.email)],
        [coAuthoredByTrailer(PAIR)]
      );
      expect(merged.map(formatTrailer)).to.deep.equal([
        'Signed-off-by: Ada Lovelace <ada@example.com>',
        'Co-authored-by: Grace Hopper <grace@example.com>',
      ]);
    });
  });

  describe('applyTrailers', () => {
    it('returns the message byte-for-byte when nothing is armed', () => {
      const message = 'subject\n\nbody with  odd   spacing\n\n\n';
      expect(applyTrailers(message, [])).to.equal(message);
    });

    it('appends the footer to a body-less message', () => {
      expect(applyTrailers('fix: typo', [signedOffByTrailer(ME.name, ME.email)])).to.equal(
        'fix: typo\n\nSigned-off-by: Ada Lovelace <ada@example.com>'
      );
    });

    it('composes with a conventional-commit subject', () => {
      const message = applyTrailers('feat(auth): add SSO\n\nWhy this matters.', [
        signedOffByTrailer(ME.name, ME.email),
        coAuthoredByTrailer(PAIR),
      ]);
      expect(message).to.equal(
        'feat(auth): add SSO\n\nWhy this matters.\n\n' +
          'Signed-off-by: Ada Lovelace <ada@example.com>\n' +
          'Co-authored-by: Grace Hopper <grace@example.com>'
      );
    });

    it('does not duplicate a trailer the message already carries (amend)', () => {
      const existing =
        'fix: bug\n\nBody.\n\nSigned-off-by: Ada Lovelace <ada@example.com>';
      const message = applyTrailers(existing, [signedOffByTrailer(ME.name, ME.email)]);
      expect(message).to.equal(existing);
      expect(message.match(/Signed-off-by/g)).to.have.lengthOf(1);
    });

    it('joins the existing footer instead of starting a second one', () => {
      // `Refs: #42` is already a trailer paragraph, so the new line belongs in
      // it — a blank line between them would split the footer in two.
      const message = applyTrailers('fix: bug\n\nRefs: #42', [coAuthoredByTrailer(PAIR)]);
      expect(message).to.equal(
        'fix: bug\n\nRefs: #42\nCo-authored-by: Grace Hopper <grace@example.com>'
      );
    });

    it('keeps the footer as one paragraph when a trailer is added twice over', () => {
      const once = applyTrailers('subject', [coAuthoredByTrailer(PAIR)]);
      const twice = applyTrailers(once, [coAuthoredByTrailer(PAIR)]);
      expect(twice).to.equal(once);
    });
  });

  describe('parseIdentityValue / parseCoAuthorInput', () => {
    it('parses Name <email>', () => {
      expect(parseIdentityValue('Grace Hopper <grace@example.com>')).to.deep.equal(PAIR);
    });

    it('rejects a value without an email', () => {
      expect(parseIdentityValue('Grace Hopper')).to.equal(null);
    });

    it('rejects a value without a name', () => {
      expect(parseIdentityValue('<grace@example.com>')).to.equal(null);
    });

    it('explains what is wrong instead of silently dropping the entry', () => {
      const empty = parseCoAuthorInput('   ');
      expect(empty.coAuthor).to.equal(undefined);
      expect(empty.error).to.contain('Name <email');

      const bare = parseCoAuthorInput('grace@example.com');
      expect(bare.coAuthor).to.equal(undefined);
      expect(bare.error).to.contain('not a valid co-author');
    });

    it('accepts a well-formed entry', () => {
      expect(parseCoAuthorInput('  Grace Hopper <grace@example.com> ').coAuthor).to.deep.equal(PAIR);
    });
  });

  describe('sameCoAuthor', () => {
    it('matches on email, ignoring case and display name', () => {
      expect(sameCoAuthor(PAIR, { name: 'G. Hopper', email: 'GRACE@Example.com' })).to.be.true;
      expect(sameCoAuthor(PAIR, ME)).to.be.false;
    });
  });

  describe('adoptTrailers', () => {
    it('lifts co-authors out of an existing message', () => {
      const adopted = adoptTrailers(
        'Body text.\n\nCo-authored-by: Grace Hopper <grace@example.com>',
        ME,
        { allowSingleParagraph: true }
      );
      expect(adopted.coAuthors).to.deep.equal([PAIR]);
      expect(adopted.message).to.equal('Body text.');
      expect(adopted.signedOff).to.be.false;
    });

    it('recognises a sign-off by the current identity', () => {
      const adopted = adoptTrailers('Signed-off-by: Ada Lovelace <ada@example.com>', ME, {
        allowSingleParagraph: true,
      });
      expect(adopted.signedOff).to.be.true;
      expect(adopted.message).to.equal('');
    });

    it('keeps a sign-off by somebody else in the message', () => {
      // There is no control that could put it back, so removing it would lose it.
      const adopted = adoptTrailers('Signed-off-by: Grace Hopper <grace@example.com>', ME, {
        allowSingleParagraph: true,
      });
      expect(adopted.signedOff).to.be.false;
      expect(adopted.message).to.equal('Signed-off-by: Grace Hopper <grace@example.com>');
    });

    it('keeps unrelated trailers and adopts only what the UI can show', () => {
      const adopted = adoptTrailers(
        'Body.\n\nRefs: #42\nCo-authored-by: Grace Hopper <grace@example.com>',
        ME,
        { allowSingleParagraph: true }
      );
      expect(adopted.coAuthors).to.deep.equal([PAIR]);
      expect(adopted.message).to.equal('Body.\n\nRefs: #42');
    });

    it('de-duplicates a co-author listed twice', () => {
      const adopted = adoptTrailers(
        'Co-authored-by: Grace Hopper <grace@example.com>\n' +
          'Co-authored-by: G. Hopper <GRACE@example.com>',
        ME,
        { allowSingleParagraph: true }
      );
      expect(adopted.coAuthors).to.have.lengthOf(1);
    });

    it('leaves a message with no footer completely alone', () => {
      const adopted = adoptTrailers('Just a body.', ME, { allowSingleParagraph: true });
      expect(adopted.message).to.equal('Just a body.');
      expect(adopted.coAuthors).to.deep.equal([]);
      expect(adopted.signedOff).to.be.false;
    });

    it('cannot adopt a sign-off when there is no identity to compare against', () => {
      const adopted = adoptTrailers('Signed-off-by: Ada Lovelace <ada@example.com>', null, {
        allowSingleParagraph: true,
      });
      expect(adopted.signedOff).to.be.false;
      expect(adopted.message).to.equal('Signed-off-by: Ada Lovelace <ada@example.com>');
    });
  });
});
