/* Shared multi-select filter dropdown.
 *
 * Drop-in replacement for a native <select class="colf" id="...">-style
 * column/list filter. Renders as a button that looks like the select it
 * replaces (it inherits whatever class/style the host tag carries), opens a
 * checkbox panel of options, and fires a plain 'change' CustomEvent whose
 * detail.values is the array of currently-checked option values -- an empty
 * array means "no filter, show everything", matching the native select's
 * "All ..." option.
 *
 * Usage (mirrors the native select it replaces):
 *   <olh-multiselect id="fComm" placeholder="All communities" class="colf"></olh-multiselect>
 *   ...
 *   var el = document.getElementById('fComm');
 *   el.setOptions(['Avalon Park', 'Storey Park', ...]);       // strings, or
 *   el.setOptions([{value:'a', label:'Avalon Park'}, ...]);   // {value,label}
 *   el.addEventListener('change', function(e){ applyFilter(e.detail.values); });
 *   el.getValues();      // -> ['Avalon Park']
 *   el.setValues([]);    // clear, e.g. from a page's "Clear Filters" button
 *
 * Self-contained, no framework dependency -- safe to use on both the plain
 * pages (keys, missed-walks, walks-to-schedule) and, later, inside a
 * bundler page's template via sc-raw-select's usual on-change wiring.
 */
(function () {
  'use strict';

  class OlhMultiselect extends HTMLElement {
    constructor() {
      super();
      this._options = [];   // [{value, label}]
      this._selected = new Set();
      this._open = false;
    }

    connectedCallback() {
      this.style.position = 'relative';
      this.style.display = 'inline-block';
      if (!this.style.width) this.style.width = '100%';
      // connectedCallback can fire more than once for the SAME element --
      // any reconciler that ever removes-then-reappends this node (a plain
      // custom element with no special-cased "don't touch me" handling in
      // the bundler's templating engine, unlike its own sc-raw-select) will
      // trigger it again. _build() unconditionally appends a fresh _btn and
      // _panel without removing whatever it appended last time, so a second
      // call stacks a second, orphaned button+dropdown inside the same host
      // -- the "duplicated" dropdown seen on tracker.html. Guard so the
      // actual DOM only ever gets built once per instance; a reconnect just
      // needs its outside-click listener re-armed, not a rebuild.
      if (!this._built) { this._built = true; this._build(); }
      this._outsideHandler = (e) => { if (!this.contains(e.target)) this._setOpen(false); };
      document.addEventListener('mousedown', this._outsideHandler);
    }

    disconnectedCallback() {
      document.removeEventListener('mousedown', this._outsideHandler);
    }

    _build() {
      // Whatever gets this element built twice -- a real second
      // connectedCallback on the same instance despite the _built guard
      // above (belt and braces, kept as a cheap skip), or the actual cause
      // measured on completion.html: the bundler's boot() does an initial
      // DOMParser-based render, then hands off to a second (React-based)
      // pass that clones/imports that already-built subtree. cloneNode/
      // importNode constructs a genuinely NEW custom element instance --
      // so this._built is undefined again, same as any fresh element -- but
      // it carries over the light-DOM CHILDREN of the node it cloned
      // (button + panel from the first build) structurally, since those are
      // plain DOM nodes, not JS instance state. The guard above can't see
      // that; this can. Never build on top of whatever is already there.
      this.innerHTML = '';
      const hostStyle = this.getAttribute('style') || '';
      // The button takes over the visual role the host element used to
      // play as a native <select>; the host itself becomes an inline-block
      // wrapper so its own class/style (e.g. .colf) still governs sizing.
      this._btn = document.createElement('button');
      this._btn.type = 'button';
      this._btn.style.cssText =
        'all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;' +
        'gap:6px;width:100%;height:100%;min-height:inherit;padding:0 22px 0 9px;cursor:pointer;' +
        'font:inherit;color:inherit;background:inherit;border-radius:inherit;';
      // Fall back to sane visual defaults when the host has no class/style
      // of its own (e.g. dropped in ahead of its usual .colf/inline styling).
      if (!this.className && !hostStyle) {
        this.style.height = '30px';
        this.style.border = '1px solid #BFB8AB';
        this.style.borderRadius = '4px';
        this.style.background = '#fff';
        this.style.fontSize = '12.5px';
        this.style.color = '#303030';
      }
      this._label = document.createElement('span');
      this._label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;text-align:left';
      const caret = document.createElement('span');
      caret.textContent = '\u25BE';
      caret.style.cssText = 'flex:0 0 auto;font-size:9px;color:#908A82;margin-left:4px';
      this._btn.appendChild(this._label);
      this._btn.appendChild(caret);
      this._btn.addEventListener('click', () => this._setOpen(!this._open));

      this._panel = document.createElement('div');
      this._panel.style.cssText =
        'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:40;min-width:100%;' +
        'max-width:280px;max-height:260px;overflow:auto;padding:6px;border:1px solid #BFB8AB;' +
        'border-radius:6px;background:#fff;box-shadow:0 8px 24px rgba(48,48,48,.16);font-size:12.5px;';

      this.appendChild(this._btn);
      this.appendChild(this._panel);
      this._renderPanel();
      this._renderLabel();
    }

    _setOpen(open) {
      this._open = open;
      this._panel.style.display = open ? 'block' : 'none';
    }

    _renderLabel() {
      const ph = this.getAttribute('placeholder') || 'All';
      if (!this._selected.size) { this._label.textContent = ph; return; }
      if (this._selected.size === 1) {
        const v = [...this._selected][0];
        const opt = this._options.find(o => o.value === v);
        this._label.textContent = opt ? opt.label : v;
        return;
      }
      this._label.textContent = this._selected.size + ' selected';
    }

    _renderPanel() {
      this._panel.innerHTML = '';
      if (!this._options.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No options';
        empty.style.cssText = 'padding:6px 8px;color:#908A82';
        this._panel.appendChild(empty);
        return;
      }
      const clearRow = document.createElement('button');
      clearRow.type = 'button';
      clearRow.textContent = 'Clear selection';
      clearRow.style.cssText =
        'all:unset;display:block;width:100%;box-sizing:border-box;padding:5px 8px;margin-bottom:3px;' +
        'cursor:pointer;color:#005DAA;font-size:11.5px;font-weight:600;border-bottom:1px solid #F1EBE1';
      clearRow.addEventListener('click', () => { this.setValues([]); this._emit(); });
      this._panel.appendChild(clearRow);

      this._options.forEach((o) => {
        const row = document.createElement('label');
        row.style.cssText =
          'display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;white-space:nowrap';
        row.addEventListener('mouseenter', () => { row.style.background = '#F6F2EA'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this._selected.has(o.value);
        cb.addEventListener('change', () => {
          if (cb.checked) this._selected.add(o.value); else this._selected.delete(o.value);
          this._renderLabel();
          this._emit();
        });
        const txt = document.createElement('span');
        txt.textContent = o.label;
        txt.style.cssText = 'overflow:hidden;text-overflow:ellipsis';
        row.appendChild(cb);
        row.appendChild(txt);
        this._panel.appendChild(row);
      });
    }

    _emit() {
      this.dispatchEvent(new CustomEvent('change', { detail: { values: this.getValues() } }));
    }

    /** options: array of strings, or array of {value,label} / {v,l}. Every
     *  real caller in this codebase (tracker.html's _filterOptions,
     *  qa-management.html, completion.html's opts()) produces {v,l} --
     *  the same shape the old <sc-raw-select>'s <option value="{{o.v}}">
     *  {{o.l}}</option> templates read. This originally only accepted
     *  {value,label}, so o.value/o.label were always undefined and every
     *  option rendered its label as the literal string "undefined". */
    setOptions(options) {
      const next = (options || []).map((o) => {
        if (o && typeof o === 'object') {
          const value = o.value !== undefined ? o.value : o.v;
          const label = o.label != null ? o.label : (o.l != null ? o.l : value);
          return { value: String(value), label: String(label) };
        }
        return { value: String(o), label: String(o) };
      });
      // Callers like syncSelects() (pushing a freshly-recomputed options
      // list down to every ref on every componentDidUpdate) call this on
      // EVERY render, not just when the list actually changed. Without this
      // guard, _renderPanel() below wipes and rebuilds the checkbox list
      // every single time -- including while the panel is open and the
      // user is mid-click, which reads as the dropdown "not working"/losing
      // its state constantly. Skip the rebuild when nothing changed.
      const same = next.length === this._options.length &&
        next.every((o, i) => o.value === this._options[i].value && o.label === this._options[i].label);
      if (same) return;
      this._options = next;
      // Drop selections that no longer exist (e.g. a community list refreshed).
      this._selected = new Set([...this._selected].filter(v => this._options.some(o => o.value === v)));
      if (this._panel) { this._renderPanel(); this._renderLabel(); }
    }

    getValues() { return [...this._selected]; }

    setValues(values) {
      const next = new Set((values || []).map(String));
      // No-op when nothing actually changed. Callers like a page's
      // syncSelects() (pushing this.state down to the DOM after every
      // render) call this unconditionally on every update, not just on a
      // real change -- rebuilding the panel each time would close it out
      // from under the user mid-click.
      if (next.size === this._selected.size && [...next].every((v) => this._selected.has(v))) return;
      this._selected = next;
      if (this._panel) { this._renderPanel(); this._renderLabel(); }
    }

    // Convenience alias so this element can drop into code written for a
    // native <select>'s .value (a plain string) with minimal changes: reads
    // and writes the same array getValues()/setValues() use, just via the
    // property name that kind of code already reads and assigns.
    get value() { return this.getValues(); }
    set value(v) { this.setValues(v); }
  }

  if (!customElements.get('olh-multiselect')) customElements.define('olh-multiselect', OlhMultiselect);
})();
