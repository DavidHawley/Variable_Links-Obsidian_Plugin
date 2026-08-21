import { App } from 'obsidian';
import Resolver from './resolver';
import Registry from './registry';
import Indexer from './indexer';
import InfoCard from './card';

const TOKEN_REGEX = /\{\{\s*([^\}\s]+)\s*\}\}/g;

export class EditRenderer {
  app: App;
  registry: Registry;
  indexer: Indexer;
  resolver: Resolver;
  infoCard: InfoCard;
  private active = false;
  private activeLeafHandler = () => this.onActiveLeafChange();

  // Map of editor -> state
  editorState: Map<any, any> = new Map();

  constructor(app: App, registry: Registry, indexer: Indexer, resolver: Resolver) {
    this.app = app;
    this.registry = registry;
    this.indexer = indexer;
    this.resolver = resolver;
    this.infoCard = new InfoCard(app);
  }

  attach() {
    if (this.active) return;
    this.active = true;
    this.app.workspace.on('active-leaf-change', this.activeLeafHandler);
    this.onActiveLeafChange();
  }

  detach() {
    if (!this.active) return;
    this.active = false;
    this.app.workspace.off('active-leaf-change', this.activeLeafHandler);
    for (const editor of Array.from(this.editorState.keys())) this.disableForEditor(editor);
    this.infoCard.destroy();
  }

  onActiveLeafChange() {
    if (!this.active) return;
    const leaves = (this.app.workspace as any).getLeavesOfType?.('markdown') || [];
    for (const leaf of leaves) {
      const view = leaf.view;
      const editor = view?.editor;
      if (!editor) continue;
      if (this.editorState.has(editor)) continue;
      this.enableForEditor(editor);
    }
  }

  enableForEditor(editor: any) {
    if (!this.active) return;
    // CM5 path
    if (typeof editor.markText === 'function') {
      this.enableForEditorCM5(editor);
      return;
    }

    // CM6 Live Preview exposes an EditorView through editor.cm.
    const cm = editor && editor.cm;
    if (cm && cm.contentDOM) {
      this.enableForEditorCM6(editor, cm);
      return;
    }

    // otherwise give up silently
  }

  enableForEditorCM5(editor: any) {
    const state: any = { mode: 'cm5', marks: [], onChange: null, onCursorActivity: null, onCopy: null };
    state.onChange = () => this.updateMarksCM5(editor);
    state.onCursorActivity = () => this.updateMarksCM5(editor);

    const wrapper = (editor as any).getWrapperElement ? editor.getWrapperElement() : null;
    state.onCopy = (ev: ClipboardEvent) => {
      try {
        const sel = editor.getSelection();
        if (sel && sel.length > 0) {
          ev.preventDefault();
          (ev.clipboardData || (window as any).clipboardData).setData('text/plain', sel);
        }
      } catch (e) { }
    };

    if (typeof editor.on === 'function') editor.on('change', state.onChange);
    if (typeof editor.on === 'function') editor.on('cursorActivity', state.onCursorActivity);
    if (wrapper) wrapper.addEventListener('copy', state.onCopy);

    this.editorState.set(editor, state);
    this.updateMarksCM5(editor);
  }

  disableForEditor(editor: any) {
    const state = this.editorState.get(editor);
    if (!state) return;
    if (state.mode === 'cm5') {
      if (typeof editor.off === 'function') editor.off('change', state.onChange);
      if (typeof editor.off === 'function') editor.off('cursorActivity', state.onCursorActivity);
      const wrapper = (editor as any).getWrapperElement ? editor.getWrapperElement() : null;
      if (wrapper) wrapper.removeEventListener('copy', state.onCopy);
      for (const m of state.marks || []) {
        try { m.clear(); } catch (e) { }
      }
    } else if (state.mode === 'cm6') {
      // remove overlays and observers
      if (state.rafId) cancelAnimationFrame(state.rafId);
      if (state.observer) state.observer.disconnect();
      if (state.contentDOM && state.copyHandler) {
        try { state.contentDOM.removeEventListener('copy', state.copyHandler); } catch(e) {}
      }
      if (state.scrollEl && state.scrollHandler) state.scrollEl.removeEventListener('scroll', state.scrollHandler, true);
      if (state.resizeHandler) window.removeEventListener('resize', state.resizeHandler);
      for (const [event, handler] of state.updateHandlers || []) {
        try {
          if (event === '__document_selectionchange__') document.removeEventListener('selectionchange', handler);
          else state.contentDOM?.removeEventListener(event, handler);
        } catch (e) { }
      }
      for (const n of state.overlays || []) {
        try { n.remove(); } catch (e) { }
      }
    }
    this.editorState.delete(editor);
  }

  // --- CM5 implementation (unchanged logic moved to its own fn)
  clearMarksForEditorCM5(editor: any) {
    const state = this.editorState.get(editor);
    if (!state || state.mode !== 'cm5') return;
    for (const m of state.marks || []) {
      try { m.clear(); } catch (e) { }
    }
    state.marks = [];
  }

  async updateMarksCM5(editor: any) {
    const state = this.editorState.get(editor);
    if (!state) return;
    this.clearMarksForEditorCM5(editor);

    const doc = editor.getValue();
    let match: RegExpExecArray | null;
    TOKEN_REGEX.lastIndex = 0;

    const cursor = editor.getCursor();

    while ((match = TOKEN_REGEX.exec(doc)) !== null) {
      const varName = match[1].trim();
      const startIndex = match.index;
      const endIndex = TOKEN_REGEX.lastIndex;

      const fromPos = editor.posFromIndex(startIndex);
      const toPos = editor.posFromIndex(endIndex);

      const cursorIndex = editor.indexFromPos(cursor);
      if (cursorIndex >= startIndex && cursorIndex <= endIndex) continue;

      const node = document.createElement('span');
      node.className = 'variable-links-token variable-links-token-edit';
      node.textContent = '…';
      node.setAttribute('data-var', varName);

      this.resolver.resolve(varName).then(res => {
        if (!this.active || this.editorState.get(editor) !== state) return;
        if (!res.ok) {
          node.textContent = `[Missing: ${varName}]`;
          node.classList.add('missing');
          node.title = res.error || '';
          return;
        }
        let display = '';
        if (res.type === 'array') display = (res.value as any[]).join(', ');
        else display = String(res.value);
        node.textContent = display;

        node.addEventListener('click', (ev) => {
          if (res.sourceFile) {
            try { this.app.workspace.openLinkText(res.sourceFile.path.replace(/\.md$/i, ''), '', false); } catch (e) { this.app.workspace.openFile(res.sourceFile); }
          }
          ev.stopPropagation();
        });

      });

      try {
        const mark = editor.markText(fromPos, toPos, { replacedWith: node, handleMouseEvents: true });
        state.marks.push(mark);
      } catch (e) {}
    }
  }

  // --- CM6 implementation: overlays positioned over contentDOM
  enableForEditorCM6(editor: any, cm: any) {
    const state: any = { mode: 'cm6', overlays: [], rafId: 0, scheduled: false, observer: null, scrollEl: null, scrollHandler: null, resizeHandler: null, updateHandlers: [] };

    // schedule update on content changes using MutationObserver + scroll/resize
    const contentDOM = cm.contentDOM;
    const schedule = () => {
      if (!this.active || this.editorState.get(editor) !== state) return;
      if (state.scheduled) return;
      state.scheduled = true;
      state.rafId = requestAnimationFrame(() => {
        state.rafId = 0;
        state.scheduled = false;
        if (!this.active || this.editorState.get(editor) !== state) return;
        this.updateMarksCM6(editor, cm);
      });
    };

    state.observer = new MutationObserver(schedule);
    try { state.observer.observe(contentDOM, { childList: true, subtree: true, characterData: true }); } catch (e) { }

    // copy interception for CM6: prefer underlying editor selection
    state.contentDOM = contentDOM;
    state.copyHandler = (ev: ClipboardEvent) => {
      try {
        const sel = editor.getSelection && editor.getSelection();
        if (sel && sel.length > 0) {
          ev.preventDefault();
          (ev.clipboardData || (window as any).clipboardData).setData('text/plain', sel);
        }
      } catch (e) { }
    };
    try { contentDOM.addEventListener('copy', state.copyHandler); } catch (e) { }

    // scroll container
    const scrollEl = cm.dom && cm.dom.parentElement ? cm.dom.parentElement : contentDOM;
    state.scrollEl = scrollEl;
    state.scrollHandler = schedule;
    scrollEl.addEventListener('scroll', state.scrollHandler, true);

    state.resizeHandler = schedule;
    window.addEventListener('resize', state.resizeHandler);

    // Cursor moves do not necessarily mutate the editor DOM. Re-render on the
    // interactions that move a Live Preview selection so its token is revealed.
    for (const event of ['keyup', 'mouseup', 'focusin']) {
      contentDOM.addEventListener(event, schedule);
      state.updateHandlers.push([event, schedule]);
    }
    const selectionHandler = () => {
      if (document.activeElement && contentDOM.contains(document.activeElement)) schedule();
    };
    document.addEventListener('selectionchange', selectionHandler);
    state.updateHandlers.push(['__document_selectionchange__', selectionHandler]);

    this.editorState.set(editor, state);

    // initial render
    this.updateMarksCM6(editor, cm);
  }

  clearOverlaysCM6(state: any) {
    if (!state) return;
    for (const n of state.overlays || []) {
      try { n.remove(); } catch (e) { }
    }
    state.overlays = [];
  }

  async updateMarksCM6(editor: any, cm: any) {
    const state = this.editorState.get(editor);
    if (!state || state.mode !== 'cm6') return;
    this.clearOverlaysCM6(state);

    const doc = editor.getValue();
    let match: RegExpExecArray | null;
    TOKEN_REGEX.lastIndex = 0;

    // attempt to get CM6 view which may provide coordsAtPos
    const cmView = (typeof cm.coordsAtPos === 'function' ? cm : null) || (cm.docView && cm.docView.view) || (cm.viewState && cm.viewState.view) || null;

    // bounding rect of contentDOM to position overlays
    const contentRect = cm.contentDOM.getBoundingClientRect();

    // selection/caret from CM6 view if available
    let selFrom = -1, selTo = -1;
    if (cmView && cmView.state && cmView.state.selection && cmView.state.selection.main) {
      try {
        selFrom = cmView.state.selection.main.from;
        selTo = cmView.state.selection.main.to;
      } catch (e) { selFrom = -1; selTo = -1; }
    } else {
      // fallback: try editor.getSelection index-of check
      try {
        const s = editor.getSelection && editor.getSelection();
        if (s && s.length > 0) {
          // best-effort set to include token if selection text includes token
          // handled per-token below
          selFrom = -1; selTo = -1;
        }
      } catch (e) { }
    }

    let foundAny = false;
    let count = 0;
    while ((match = TOKEN_REGEX.exec(doc)) !== null) {
      const varName = match[1].trim();
      const startIndex = match.index;
      const endIndex = TOKEN_REGEX.lastIndex;

      // skip if selection/cursor inside token
      let skip = false;
      if (selFrom >= 0 && selTo >= 0) {
        if (!(selTo < startIndex || selFrom > endIndex)) skip = true;
      } else {
        try {
          const sels = editor.getSelection && editor.getSelection();
          if (sels && sels.length > 0) {
            const full = doc.slice(startIndex, endIndex);
            if (sels.indexOf(full) !== -1 || full.indexOf(sels) !== -1) skip = true;
          }
        } catch (e) { }
      }
      if (skip) continue;

      foundAny = true;

      // create overlay element
      const node = document.createElement('div');
      node.className = 'variable-links-token variable-links-token-edit variable-links-overlay';
      node.textContent = '…';
      node.setAttribute('data-var', varName);
      node.style.position = 'absolute';
      node.style.pointerEvents = 'auto';
      node.style.zIndex = '20';
      node.style.whiteSpace = 'nowrap';

      // append to editor container (position relative to viewport)
      const rootEl = cm.dom && cm.dom.closest ? (cm.dom.closest('.workspace')) || document.body : document.body;
      // append to body but we'll use absolute coords
      document.body.appendChild(node);
      state.overlays.push(node);
      count++;

      // resolve value and attach handlers
      this.resolver.resolve(varName).then(res => {
        if (!this.active || this.editorState.get(editor) !== state || !node.isConnected) return;
        if (!res.ok) {
          node.textContent = `[Missing: ${varName}]`;
          node.classList.add('missing');
          node.title = res.error || '';
        } else {
          let display = '';
          if (res.type === 'array') display = (res.value as any[]).join(', ');
          else display = String(res.value);
          node.textContent = display;
        }

        node.addEventListener('click', (ev) => {
          if (res.sourceFile) {
            try { this.app.workspace.openLinkText(res.sourceFile.path.replace(/\.md$/i, ''), '', false); } catch (e) { this.app.workspace.openFile(res.sourceFile); }
          }
          ev.stopPropagation();
        });

      });

      // Hover cards disabled in editor mode (cards only shown in Preview).

      // position overlay: use cmView.coordsAtPos if available
      try {
        // style overlay to visually cover underlying token
        try {
          const cs = window.getComputedStyle(cm.contentDOM);
          node.style.background = cs.backgroundColor || 'var(--background-primary)';
          node.style.color = cs.color || 'var(--text-normal)';
          node.style.padding = '0 2px';
          node.style.borderRadius = '3px';
          node.style.lineHeight = cs.lineHeight || '1';
          node.style.zIndex = '9999';
          node.style.boxSizing = 'border-box';
          node.style.overflow = 'hidden';
          node.style.textOverflow = 'ellipsis';
        } catch (e) {}

        let coordsFrom = null;
        let coordsTo = null;
        if (cmView && typeof cmView.coordsAtPos === 'function') {
          try {
            coordsFrom = cmView.coordsAtPos(startIndex);
            coordsTo = cmView.coordsAtPos(endIndex);
          } catch (e) { coordsFrom = null; coordsTo = null; }
        }

        if (coordsFrom && coordsTo) {
          // coords are viewport-relative
          const left = coordsFrom.left;
          const top = coordsFrom.top;
          const right = coordsTo.left;
          node.style.left = (left) + 'px';
          node.style.top = (top) + 'px';
        } else {
          // fallback: try to find a child text node in contentDOM using a simple heuristic
          // find first line element and place overlay at its top-left
          const firstLine = cm.contentDOM.querySelector('.cm-line');
          if (firstLine) {
            const r = firstLine.getBoundingClientRect();
            node.style.left = (r.left) + 'px';
            node.style.top = (r.top) + 'px';
          } else {
            // absolute fallback: place near content rect
            node.style.left = (contentRect.left) + 'px';
            node.style.top = (contentRect.top) + 'px';
          }
        }
      } catch (e) {
        // ignore positioning errors
      }
    }

  }
}

export default EditRenderer;
