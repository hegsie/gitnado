/**
 * The overlay stack (src/utils/overlay-stack.ts) decides which dialog owns
 * Escape. It only works if EVERY dialog that can close on Escape joins it.
 *
 * That membership started as a hand-written list and went stale immediately:
 * fourteen dialogs own a document-level Escape listener, ten were migrated,
 * and the three that were missed reproduced the exact bug the stack exists to
 * prevent — a dialog opened over another dismissed both, taking the clean
 * dialog's file selection with it.
 *
 * So the invariant is enforced here instead of remembered. A dialog that
 * listens for keydown on `document` must also register with the stack.
 */

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'dialogs listening for keydown on document must join the overlay stack',
    },
    schema: [],
    messages: {
      missingPush:
        'This component dismisses on Escape from a global keydown listener but never ' +
        'consults isTopOverlay(). Every such listener fires on the same keypress, so a ' +
        'dialog opened over this one will dismiss BOTH. Gate the Escape branch on ' +
        'isTopOverlay(this) from src/utils/overlay-stack.ts; if this component is itself ' +
        'an overlay, also push on open and remove on close and disconnect.',
      missingRemove:
        'This dialog calls pushOverlay() but never removeOverlay(). A leaked entry sits on ' +
        'top of the stack forever and takes Escape away from every dialog below it.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // The shared modal wrapper registers on behalf of its hosts.
    if (filename.endsWith('gn-modal.ts')) return {};

    let addsDocumentKeydown = false;
    let handlesEscape = false;
    let consultsStack = false;
    let pushes = false;
    let removes = false;
    let firstNode = null;

    return {
      Program(node) {
        firstNode = node;
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          // `window` counts too. The first version matched only `document`,
          // so a window+capture listener — which pre-empts every document
          // listener in the app — sailed straight past the rule.
          (callee.object.name === 'document' || callee.object.name === 'window') &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'addEventListener' &&
          node.arguments[0]?.type === 'Literal' &&
          node.arguments[0].value === 'keydown'
        ) {
          addsDocumentKeydown = true;
        }
        if (callee.type === 'Identifier' && callee.name === 'pushOverlay') pushes = true;
        if (callee.type === 'Identifier' && callee.name === 'removeOverlay') removes = true;
        // NOTE: a bare call is deliberately NOT enough — see IfStatement below.
      },
      Literal(node) {
        if (node.value === 'Escape') handlesEscape = true;
      },
      /**
       * The guard must actually GUARD. Counting any call to isTopOverlay let a
       * component satisfy the rule with `void isTopOverlay(this);` and then
       * close on Escape unconditionally — reintroducing the exact double
       * dismissal the stack exists to prevent, with a green lint. Require the
       * call to sit in the test of an `if` that bails.
       */
      IfStatement(node) {
        const testMentionsGuard = (n) => {
          if (!n || typeof n !== 'object') return false;
          if (n.type === 'CallExpression' && n.callee?.name === 'isTopOverlay') return true;
          return ['argument', 'left', 'right', 'expression', 'test', 'consequent', 'alternate']
            .some((k) => testMentionsGuard(n[k]));
        };
        // Any `if` whose TEST consults the stack counts, whichever way round
        // it is written — both of these are correct and both appear in the
        // codebase:
        //   if (!this.open || !isTopOverlay(this)) return;      // bail form
        //   if (e.key === 'Escape' && isTopOverlay(this)) {...} // inline form
        // What this rejects is the call appearing only as a standalone
        // expression whose result is thrown away, which "consults" the stack
        // without letting it decide anything.
        if (testMentionsGuard(node.test)) {
          consultsStack = true;
        }
      },
      'Program:exit'() {
        // The invariant is about DISMISSAL, not about listening. A component
        // that listens for navigation keys only (j/k, arrows) is not an
        // overlay and must not be dragged into the stack; one that acts on
        // Escape must first check that the key is aimed at it.
        if (addsDocumentKeydown && handlesEscape && !consultsStack) {
          context.report({ node: firstNode, messageId: 'missingPush' });
        }
        if (pushes && !removes) {
          context.report({ node: firstNode, messageId: 'missingRemove' });
        }
      },
    };
  },
};

export default rule;
