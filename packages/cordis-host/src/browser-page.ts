/**
 * What the browser service asks the *page* rather than the browser.
 *
 * The DevTools protocol answers everything about a page except the one
 * question a model actually asks first — "what is on it, and what can I
 * click?". CDP's own answer is `Accessibility.getFullAXTree`, and it is
 * deliberately not used here. Its nodes are `backendNodeId`s, which have to
 * be resolved through `DOM.resolveNode` before anything can be clicked, go
 * stale on the next mutation, and cost three round trips per interaction.
 * A walk of the live DOM answers in one `Runtime.evaluate`, keeps the
 * element itself rather than a number that stands for it, and reads the same
 * ARIA the AX tree reads. The AX tree is still there for anyone who wants
 * it — `browser_cdp` reaches every method this file chose not to use.
 *
 * References (`ref_3`) live in the page, on `window.__hdRefs`. That is not
 * laziness: a navigation destroys the array with the document, so a ref from
 * a page that has since navigated fails *loudly* instead of resolving to
 * whatever element happens to hold that index now.
 *
 * The script is re-installed on every call. It costs a few kilobytes over a
 * local socket and removes a whole class of bug — a page that reloaded
 * between two tool calls and lost its helpers.
 */

/** Roles that make an element worth handing a model a reference to. */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * The helpers, as source. Installed by prefixing it to whatever expression
 * the service wants to run, so every call is self-contained.
 */
export const PAGE_HELPERS = `(() => {
  const W = window;
  if (!Array.isArray(W.__hdRefs)) W.__hdRefs = [];
  const INTERACTIVE = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  const LANDMARKS = new Set(['main','navigation','banner','contentinfo','complementary','search','form','dialog','alert','status','table','list']);

  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    const style = W.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.tagName === 'OPTION';
  };

  /**
   * Fields whose value must never leave the page.
   *
   * A read of a page is not a considered act — an agent runs it on arrival,
   * before it knows what the page is — so a filled password field puts the
   * password in the model's context, in the transcript on disk, and in the
   * logs of whatever service answers the turn. None of those can be un-said.
   *
   * \`type="password"\` is the obvious one. \`autocomplete\` names the rest, and
   * it is the only declaration a one-time code has: an OTP field is usually
   * \`type="text"\` with \`inputmode="numeric"\`, and reads as an ordinary
   * textbox otherwise. The attribute is a token list — "section-blue billing
   * current-password" is legal — so it is matched per token, not whole.
   *
   * The card tokens are here for the same reason as the password ones and not
   * as a guess at what else might be sensitive: a PAN and its CVC are bearer
   * credentials that a checkout page renders into an ordinary \`type="text"\`
   * box, so a page read on a filled checkout form is the same accident as a
   * page read on a filled sign-in form. \`cc-name\` and \`cc-type\` are not
   * here — a cardholder's name and the word "Visa" are not the secret.
   */
  const SECRET_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  ]);

  const secret = (el) => {
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || 'text').toLowerCase() === 'password') return true;
    return clean(el.getAttribute('autocomplete')).toLowerCase().split(' ').some((token) => SECRET_AUTOCOMPLETE.has(token));
  };

  /**
   * Contenteditable, as both a live browser and a test DOM can answer it.
   * \`isContentEditable\` is the computed one and catches a child of an
   * editable ancestor; jsdom does not implement it at all, so the attribute
   * is asked as well and the union is what either environment agrees on.
   */
  const editable = (el) => el.isContentEditable === true || el.matches('[contenteditable="true"],[contenteditable=""]');

  /**
   * A control's value, as one string, read one way.
   *
   * A contenteditable keeps its value in its text rather than in \`.value\`,
   * where reading only \`.value\` gives \`undefined\` — and \`undefined\` is
   * falsy to the tree and truthy to a \`!== ''\` test, so the tree called such
   * a field empty in the same breath that fill() called it filled. Two
   * readings of one field is how that happens; this is the one reading.
   */
  const valueOf = (el) => {
    if (el.value != null) return String(el.value);
    if (editable(el)) return String(el.textContent == null ? '' : el.textContent);
    return '';
  };

  const inputRole = (el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'file') return 'file';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  };

  const TAG_ROLES = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    IMG: 'image', NAV: 'navigation', MAIN: 'main', HEADER: 'banner',
    FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form',
    TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem',
    SUMMARY: 'button', DETAILS: 'group', DIALOG: 'dialog', IFRAME: 'iframe',
    VIDEO: 'video', AUDIO: 'audio', SVG: 'image', LABEL: 'label',
    OPTION: 'option', TD: 'cell', TH: 'columnheader', TR: 'row',
    P: 'paragraph', BLOCKQUOTE: 'blockquote', CODE: 'code', PRE: 'code',
  };

  const role = (el) => {
    const explicit = clean(el.getAttribute('role'));
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'INPUT') return inputRole(el);
    if (tag === 'A' && !el.hasAttribute('href')) return 'generic';
    return TAG_ROLES[tag] || 'generic';
  };

  /**
   * An element's own words: its text, less whatever belongs to a control
   * inside it at any depth — that control has a line of its own, and a form
   * named after every option of every select in it is not a name.
   */
  const ownText = (el) => {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.nodeValue;
      else if (node.nodeType === 1 && !node.matches(INTERACTIVE)) out += ' ' + ownText(node) + ' ';
    }
    return clean(out);
  };

  /**
   * A label's own words. A <label> may wrap the control it names, and the
   * control's text is not part of its name — <label>Plan <select> with two
   * options read as "Plan FreePro", which no person calls it and no ref
   * lookup by label ever matches.
   */
  const textWithout = (root, skip) => {
    let out = '';
    for (const node of root.childNodes) {
      if (node === skip) continue;
      if (node.nodeType === 3) out += node.nodeValue;
      // Padded, so <span>First</span><span>Name</span> reads "First Name"
      // rather than running together; clean() folds the padding back.
      else if (node.nodeType === 1) out += ' ' + textWithout(node, skip) + ' ';
    }
    return clean(out);
  };

  const name = (el) => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const by = clean(el.getAttribute('aria-labelledby'));
    if (by) {
      const parts = by.split(' ').map((id) => {
        const target = document.getElementById(id);
        return target ? textWithout(target, el) : '';
      }).filter(Boolean).join(' ');
      if (parts) return parts;
    }
    if (el.id) {
      try {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label && textWithout(label, el)) return textWithout(label, el);
      } catch (_) { /* an id CSS.escape cannot express is not a label lookup */ }
    }
    if (el.matches('input,select,textarea')) {
      const wrapping = el.closest('label');
      if (wrapping && textWithout(wrapping, el)) return textWithout(wrapping, el).slice(0, 120);
      const placeholder = clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name'));
      if (placeholder) return placeholder;
    }
    if (el.tagName === 'IMG') return clean(el.getAttribute('alt'));
    const title = clean(el.getAttribute('title'));
    if (title) return title;
    /*
     * Everything above this line is a label the page's author wrote — an
     * aria-label, a <label>'s own words, a placeholder, a title. This line is
     * the element's own *content*, and for a secret field the content is the
     * secret: a <textarea autocomplete="current-password"> keeps its value in
     * a child text node, so ownText() reads it straight out, and so does a
     * contenteditable marked one-time-code. Redacting the value bit while
     * handing the same characters over as the name is not a redaction — and
     * name() is not only the tree: rect() returns it, and rect() is on the
     * path of every browser_click.
     *
     * An unlabelled secret field has no name. That is the page's own
     * accessibility failure and it is what a screen reader reports too; the
     * ref still identifies the field, so it stays clickable and fillable.
     */
    if (secret(el)) return '';
    return ownText(el).slice(0, 160);
  };

  const state = (el, elRole) => {
    const bits = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (elRole === 'checkbox' || elRole === 'radio' || elRole === 'switch') {
      const checked = el.checked != null ? el.checked : el.getAttribute('aria-checked') === 'true';
      bits.push(checked ? 'checked' : 'unchecked');
    }
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) bits.push('expanded=' + expanded);
    if (elRole === 'heading') {
      const level = el.getAttribute('aria-level') || (/^H([1-6])$/.exec(el.tagName) || [])[1];
      if (level) bits.push('level=' + level);
    }
    if (elRole === 'link') {
      const href = el.getAttribute('href');
      if (href) bits.push('href=' + JSON.stringify(href.slice(0, 120)));
    }
    if (elRole === 'textbox' || elRole === 'searchbox' || elRole === 'combobox' || elRole === 'slider') {
      const value = valueOf(el);
      // A secret field gets a bit, not a value. What an agent needs from a
      // password box is that it is there, that it takes a value, and whether
      // something is in it already — the same thing a person reads off the
      // dots. Chrome's own AX tree says exactly this: role textbox, flagged
      // protected. A stand-in value=\"(hidden)\" would put a lie in the slot
      // every other line uses for the truth, and an agent that believed it
      // would try to clear a field holding those nine characters.
      if (secret(el)) bits.push('secret', value ? 'filled' : 'empty');
      else bits.push('value=' + JSON.stringify(value.slice(0, 120)));
    }
    if (el.tagName === 'IFRAME') {
      const src = el.getAttribute('src');
      if (src) bits.push('src=' + JSON.stringify(src.slice(0, 120)));
    }
    return bits;
  };

  /**
   * The tree, as indented lines. Only elements that carry meaning are
   * emitted: everything interactive, every heading and landmark, and — in
   * 'all' — anything else with a name. A div that exists to hold a class
   * name is not information.
   */
  const tree = (options) => {
    const opts = options || {};
    const all = opts.filter === 'all';
    const query = opts.query ? String(opts.query).toLowerCase() : '';
    const limit = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 20000;
    W.__hdRefs = [];
    const lines = [];
    lines.push('- document ' + JSON.stringify(document.title || '') + ' url=' + JSON.stringify(location.href));

    const walk = (el, depth) => {
      if (!visible(el)) return;
      const elRole = role(el);
      const interactive = el.matches(INTERACTIVE);
      const label = name(el);
      const keep = interactive || elRole === 'heading' || LANDMARKS.has(elRole) || (all && label);
      let nextDepth = depth;
      if (keep) {
        let line = '  '.repeat(depth) + '- ' + elRole;
        if (label) line += ' ' + JSON.stringify(label);
        if (interactive) {
          W.__hdRefs.push(el);
          line += ' [ref_' + W.__hdRefs.length + ']';
        }
        const bits = state(el, elRole);
        if (bits.length) line += ' ' + bits.join(' ');
        lines.push(line);
        nextDepth = depth + 1;
      }
      for (const child of el.children) walk(child, nextDepth);
    };
    if (document.body) for (const child of document.body.children) walk(child, 1);

    let kept = lines;
    if (query) {
      kept = lines.filter((line, index) => index === 0 || line.toLowerCase().includes(query));
      if (kept.length === 1) kept.push('  (nothing on this page matches ' + JSON.stringify(opts.query) + ')');
    }
    let out = kept.join('\\n');
    if (out.length > limit) {
      out = out.slice(0, limit) + '\\n… truncated at ' + limit + ' characters; narrow it with a query or raise maxChars.';
    }
    return out;
  };

  /** The page as a person reads it: article or main first, body otherwise. */
  const text = (options) => {
    const limit = Number((options || {}).maxChars) > 0 ? Number((options || {}).maxChars) : 20000;
    const host = document.querySelector('article') || document.querySelector('main') || document.body;
    let out = host ? String(host.innerText || '') : '';
    /*
     * innerText leaves a form control's value alone — a password <input> is a
     * replaced element and its characters were never text. A contenteditable
     * marked secret is the exception: its value *is* its text, so it reads out
     * in the clear here even though the tree withholds it. Redacted by
     * replacement rather than by hiding the node, because blanking a live
     * element mid-read fires the page's own observers. The cost is that an
     * identical string elsewhere on the page is redacted too; a page with a
     * one-time-code contenteditable whose digits are also body copy is a
     * trade worth making in this direction.
     */
    for (const el of document.querySelectorAll('[contenteditable="true"],[contenteditable=""]')) {
      if (!secret(el)) continue;
      const shown = String(el.innerText == null ? '' : el.innerText).trim();
      if (shown) out = out.split(shown).join('(hidden)');
    }
    out = out.replace(/\\n{3,}/g, '\\n\\n').trim();
    return out.length > limit ? out.slice(0, limit) + '\\n… truncated at ' + limit + ' characters.' : out;
  };

  const lookup = (ref) => {
    const index = /^ref_(\\d+)$/.exec(String(ref));
    if (!index) throw new Error('A reference looks like ref_3; got ' + JSON.stringify(String(ref)) + '.');
    const el = W.__hdRefs[Number(index[1]) - 1];
    if (!el) throw new Error(ref + ' is not a reference this page handed out. Read the page again.');
    if (!el.isConnected) throw new Error(ref + ' pointed at an element the page has since removed. Read the page again.');
    return el;
  };

  /** Where to aim a pointer: the element's centre, in CSS pixels, on screen. */
  /**
   * The box to aim at. An inline element that wraps — a link at the end of
   * a line — has several boxes, and the centre of the one that bounds them
   * all is the gap between the lines: a click there landed on the paragraph
   * and the tool reported the link clicked. The largest line box is the one
   * a person would press.
   */
  const boxOf = (el) => {
    const boxes = Array.from(el.getClientRects ? el.getClientRects() : []).filter((r) => r.width > 0 && r.height > 0);
    if (boxes.length <= 1) return el.getBoundingClientRect();
    return boxes.reduce((best, r) => (r.width * r.height > best.width * best.height ? r : best), boxes[0]);
  };

  const rect = (ref) => {
    const el = lookup(ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const box = boxOf(el);
    return {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      width: box.width,
      height: box.height,
      role: role(el),
      name: name(el),
    };
  };

  /**
   * Focus, and put the caret after whatever is already there. Not
   * select-all: typing into a field appends, and replacing a value is what
   * fill() is for. Note this only sets document.activeElement — the frame
   * itself is focused by a real click, which is why the service clicks first.
   */
  const focus = (ref) => {
    const el = lookup(ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (typeof el.focus === 'function') el.focus();
    try {
      if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    } catch (_) { /* a number or date input refuses a selection range */ }
    return { role: role(el), name: name(el) };
  };

  /**
   * What fill() says it did. Writing a password is the whole point of a
   * sign-in, so the write itself is untouched — it is the *report* that is
   * redacted, because \`browser_fill\` hands its return value back to the
   * model verbatim and a round trip through the page is still a leak.
   */
  const wrote = (el, value) => {
    const out = { role: role(el), name: name(el) };
    if (secret(el)) { out.secret = true; out.filled = valueOf(el) !== ''; }
    else out.value = value;
    return out;
  };

  /**
   * Setting a form control's value. Native setters, then input+change —
   * React tracks the previous value on the node and ignores a plain
   * assignment, which is the difference between a filled form and a form
   * that looks filled and submits empty.
   */
  const fill = (ref, value) => {
    const el = lookup(ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (typeof el.focus === 'function') el.focus();
    const tag = el.tagName;
    if (tag === 'SELECT') {
      const wanted = String(value);
      const option = Array.from(el.options).find((o) => o.value === wanted || clean(o.textContent) === wanted);
      if (!option) throw new Error('No option matches ' + JSON.stringify(wanted) + ' in that select.');
      el.value = option.value;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      const wanted = value === true || value === 'true' || value === 1 || value === '1';
      if (el.checked !== wanted) el.click();
      return wrote(el, el.checked);
    } else if (editable(el)) {
      el.textContent = String(value);
    } else {
      const proto = tag === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, String(value));
      else el.value = String(value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return wrote(el, valueOf(el));
  };

  /** Has the page reached the state the caller is waiting for? */
  const settled = (options) => {
    const opts = options || {};
    if (opts.selector) {
      const selector = String(opts.selector);
      /*
       * A wait is for a state, not for a value. \`[value^="a"]\` asked once a
       * letter is a character-by-character read of a field the tree
       * deliberately withholds — CSS attribute selectors match the value
       * *attribute*, which a server-rendered form delivers in its markup, so
       * a password sitting in the HTML can be spelled out one true/false at a
       * time. The shape that spells that question is refused rather than
       * answered, for every element: narrowing it to secret fields only would
       * still leave "#pw[value^=a]", which names no secret and asks the same
       * thing.
       */
      if (/\\[\\s*value\\s*[~^$*|]?=/.test(selector)) {
        throw new Error(
          'A wait cannot test a control’s value — [value=…] reads the field rather than watching for a state. ' +
            'Wait on a selector without it, or on text.',
        );
      }
      const found = document.querySelector(selector);
      return found ? visible(found) : false;
    }
    if (opts.text) {
      const needle = String(opts.text).toLowerCase();
      return String((document.body && document.body.innerText) || '').toLowerCase().includes(needle);
    }
    if (opts.gone) return !document.querySelector(String(opts.gone));
    return document.readyState === 'complete';
  };

  W.__hd = { tree, text, rect, focus, fill, settled, lookup };
})();`

/** The service's one way of running a helper: install, then call. */
export const callHelper = (call: string): string => `${PAGE_HELPERS} JSON.stringify(${call})`
