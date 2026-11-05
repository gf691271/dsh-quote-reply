/**
 * Quote & Reply Queue — a Client-only feature for the Harness Web UI.
 *
 * Flow (Claude Code parity):
 *   1. Select text inside the transcript -> a floating "引用文本" pill appears.
 *   2. Click it -> a popover asks for the reply.
 *   3. Enter -> the pair becomes one block card sitting above the composer.
 *      Repeat: several blocks coexist, each editable and removable, and the
 *      composer still accepts ordinary typed text beside them.
 *   4. Sending turns the blocks into `quote\nreply` text for one message.
 *
 * Sections, in order:
 *   1. Copy            — dictionaries + the host-bound translator (ctx.locale)
 *   2. Selection       — rect geometry, text normalisation, readSelection()
 *   3. Host coupling   — send-button detection + the quote-bar composer
 *   4. Manager         — the whole state machine (selection, popover, blocks,
 *                        per-session queues, send)
 *   5. React glue      — useSnapshot over the manager
 *   6. Styles          — one static stylesheet, host theme tokens only
 *   7. Components      — pill, popover, tile, strip, transcript renderer
 *   8. apply()         — slot registrations and the locale wiring
 *
 * Why one file: a plain Client plugin is loaded through
 * `window.__ModuleLoader__.load({ factory(require) })`, where `require` resolves
 * only declared external modules (React here) — relative imports do not exist
 * at runtime. Splitting this into modules would need a bundler step, which buys
 * nothing for a plugin DSH installs straight from a directory or a git URL.
 * Keep the sections in this order and the file stays navigable.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quote-reply',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const FRAG = React.Fragment;

    const POPOVER_WIDTH = 392;

    const I18N = {
      zh: {
        quote: '引用文本',
        placeholder: '回复这段文字…',
        add: '加入',
        send: '发送',
        sending: '发送中…',
        sendFailed: '未发送成功，已退回',
        sendFileBlocked: '文件附件无法随引用发送，请先移除',
        showMore: '显示更多（还有 {count} 组）',
        save: '保存',
        hintAdd: 'Enter 加入 · Shift+Enter 换行 · Esc 取消',
        hintSave: 'Enter 保存 · Shift+Enter 换行 · Esc 取消',
        edit: '编辑',
        remove: '删除',
      },
      en: {
        quote: 'Quote Text',
        placeholder: 'Reply to this passage…',
        add: 'Add',
        send: 'Send',
        sending: 'Sending…',
        sendFailed: 'Not sent — restored',
        sendFileBlocked: 'A file attachment cannot be sent with a quote',
        showMore: 'Show {count} more',
        save: 'Save',
        hintAdd: 'Enter to add · Shift+Enter for newline · Esc to cancel',
        hintSave: 'Enter to save · Shift+Enter for newline · Esc to cancel',
        edit: 'Edit',
        remove: 'Remove',
      },
    };

    /** The Harness locale service, captured in apply; null outside the app. */
    let localeService = null;
    /** The sessions service: `binding(id).session.prompt()` sends without the composer. */
    let sessionsService = null;
    /** Bound translator from the Client locale service, when it is available. */
    let translate = null;
    const NS = 'quote-reply';

    function detectLang() {
      try {
        const snapshot = localeService ? localeService.getLocale() : null;
        const active = snapshot && snapshot.active;
        if (typeof active === 'string' && active !== '') {
          return /^en/i.test(active) ? 'en' : 'zh';
        }
      } catch (_error) {
        /* fall through to the document language */
      }
      try {
        const raw = document.documentElement.getAttribute('lang') || navigator.language || 'zh';
        return /^en/i.test(raw) ? 'en' : 'zh';
      } catch (_error) {
        return 'zh';
      }
    }

    /**
     * Copy for this plugin. The Harness dictionary owns the active language and
     * its fallback chain; the local table is only the fallback when the locale
     * service is missing (tests, a stripped-down profile).
     */
    function t(key, values) {
      let text;
      if (translate !== null) {
        try {
          const value = translate(key);
          if (typeof value === 'string' && value !== '' && value !== key) text = value;
        } catch (_error) {
          /* fall through to the local table */
        }
      }
      if (text === undefined) {
        const table = I18N[detectLang()] || I18N.zh;
        text = table[key] || I18N.zh[key] || key;
      }
      if (!values) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) =>
        values[name] === undefined ? match : String(values[name]),
      );
    }

    // ---------------------------------------------------------------- selection

    /**
     * Geometry for a selection: the union box, plus the first *line* box. A line
     * can arrive as several rects (inline chips, styled spans), so the first line
     * is every rect sharing the topmost edge, unioned — centring on the first
     * fragment alone parks the pill at the left edge of the line.
     */
    function selectionRect(range) {
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      const fallback = range.getBoundingClientRect();
      if (rects.length === 0) {
        if (fallback.width <= 0 || fallback.height <= 0) return null;
        rects.push(fallback);
      }
      let top = Infinity;
      let left = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      let firstTop = Infinity;
      for (const rect of rects) {
        top = Math.min(top, rect.top);
        left = Math.min(left, rect.left);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
        firstTop = Math.min(firstTop, rect.top);
      }
      if (!Number.isFinite(top) || right <= left) return null;
      const lineRects = rects.filter((rect) => Math.abs(rect.top - firstTop) <= 4);
      const lineLeft = Math.min(...lineRects.map((rect) => rect.left));
      const lineRight = Math.max(...lineRects.map((rect) => rect.right));
      const lineBottom = Math.max(...lineRects.map((rect) => rect.bottom));
      return {
        union: { top, left, right, bottom, width: right - left, height: bottom - top },
        first: {
          top: firstTop,
          left: lineLeft,
          bottom: lineBottom,
          width: Math.max(lineRight - lineLeft, 0),
          height: lineBottom - firstTop,
        },
      };
    }

    function normalizeQuote(text) {
      return String(text)
        .replace(/\r\n?/g, '\n')
        // Selecting part of an earlier quote-and-reply message carries that
        // message's own quote bars in; they would nest and read as old text.
        .replace(/^[ \t]*[│▌][ \t]*/gm, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    /** The live selection when it sits in transcript text and out of every control. */
    function readSelection() {
      let selection;
      try {
        selection = window.getSelection();
      } catch (_error) {
        return null;
      }
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node && node.nodeType === 1 ? node : node && node.parentElement;
      if (!element || !element.closest) return null;
      if (element.closest('[data-quote-reply-ui]')) return null;
      if (
        element.closest(
          'textarea, input, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
        )
      ) {
        return null;
      }
      if (!element.closest('[data-conversation-region="chat"]')) return null;
      const text = normalizeQuote(selection.toString());
      if (!text) return null;
      const box = selectionRect(range);
      if (!box) return null;
      return { text, rect: box.union, line: box.first };
    }

    function sameTarget(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      return (
        a.text === b.text &&
        Math.abs(a.rect.top - b.rect.top) < 1 &&
        Math.abs(a.rect.left - b.rect.left) < 1 &&
        Math.abs(a.rect.width - b.rect.width) < 1
      );
    }

    function classEndsWith(element, suffix) {
      for (const token of Array.from(element.classList || [])) {
        if (token === suffix || token.endsWith('_' + suffix) || token.endsWith('-' + suffix)) {
          return true;
        }
      }
      return false;
    }

    /** The composer's primary (send) button, without depending on its hashed class. */
    /**
     * True when this button is the composer's primary (send) button.
     *
     * The same element turns into Stop while a turn runs with an empty composer,
     * so the label guard runs first for every candidate: hijacking Stop would
     * both deny the interrupt and queue a message the user did not send.
     */
    function isSendButton(button, card) {
      const label = String(button.getAttribute('aria-label') || '').trim();
      if (label && /停止|中止|Stop|Cancel|取消/i.test(label)) return false;
      const primaries = Array.from(card.querySelectorAll('button')).filter((candidate) => {
        if (candidate.closest('[data-quote-reply-ui]')) return false;
        if (candidate.closest('[data-composer-overlay]')) return false;
        return classEndsWith(candidate, 'primary');
      });
      if (primaries.length > 0) return primaries[primaries.length - 1] === button;
      if (!label) return false;
      return /发送|排队|转向|Send|Queue|Steer/i.test(label);
    }

    /**
     * A quotation in message text. The transcript renders plain text, so a
     * Markdown ">" would show up as a literal character: a solid left bar
     * glyph per line reads as the quote rule instead.
     */
    function quoteWithBar(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return '';
      return trimmed
        .split('\n')
        .map((line) => (line.trim() === '' ? '│' : '│ ' + line))
        .join('\n');
    }

    // ------------------------------------------------------------------ manager

    const manager = {
      listeners: new Set(),
      snap: null,
      session: null,
      draft: '',
      blocks: [],
      /** Per-session quote queues, so a session switch never eats a draft. */
      queues: new Map(),
      target: null,
      popover: null,
      mounted: null,
      seq: 0,
      scanTimer: 0,
      frame: 0,
      clearTimer: 0,
      sending: false,
      /** Whether the session currently has a running turn (Stop is the primary). */
      running: false,
      /** Send attempt counter and its watchdog timer. */
      sendSeq: 0,
      sendGuard: 0,
      /** Visible send state: '' | 'sending' | 'failed' | 'fileBlocked'. */
      status: '',
      statusTimer: 0,
      /** Comma-joined draft attachment ids the next send must carry. */
      attachmentIds: '',

      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },

      buildSnapshot() {
        return {
          sessionId: this.session ? this.session.sessionId : null,
          hasSession: this.session !== null,
          blocks: this.blocks.slice(),
          target: this.target,
          popover: this.popover,
          status: this.status,
        };
      },

      snapshot() {
        if (this.snap === null) this.snap = this.buildSnapshot();
        return this.snap;
      },

      notify() {
        this.snap = this.buildSnapshot();
        for (const listener of Array.from(this.listeners)) {
          try {
            listener();
          } catch (error) {
            console.error('quote-reply: listener failed', error);
          }
        }
      },

      attach(sessionId, actions) {
        if (typeof sessionId !== 'string' || sessionId === '') return;
        if (this.session && this.session.sessionId === sessionId && this.session.actions === actions) {
          return;
        }
        const changedSession = !this.session || this.session.sessionId !== sessionId;
        if (changedSession && this.session !== null) {
          // Each conversation keeps its own queue: switching away must not eat it.
          this.queues.set(this.session.sessionId, this.blocks);
        }
        this.session = { sessionId, actions };
        if (changedSession) {
          this.blocks = this.queues.get(sessionId) || [];
          this.target = null;
          this.popover = null;
        }
        // Bound the per-session cache; a long-lived app visits many sessions.
        while (this.queues.size > 20) {
          const oldest = this.queues.keys().next().value;
          if (oldest === sessionId) break;
          this.queues.delete(oldest);
        }
        this.notify();
      },

      detach(sessionId) {
        if (!this.session || this.session.sessionId !== sessionId) return;
        this.queues.set(sessionId, this.blocks);
        this.session = null;
        this.blocks = [];
        this.target = null;
        this.popover = null;
        this.sending = false;
        this.notify();
      },

      /** Draft text, defensively stripped of the zero-width carrier older builds wrote. */
      cleanDraft() {
        return String(this.draft || '').replace(/\u200B/g, '');
      },

      /** Draft attachments reported by the composer (comma-joined ids). */
      setAttachments(value) {
        this.attachmentIds = typeof value === 'string' ? value : '';
      },

      /** Running-turn state: the composer's primary button becomes Stop. */
      setRunning(value) {
        this.running = value === true;
      },

      /**
       * Track the live draft. Nothing here writes back into the composer; the
       * only writes are the composed send (in the fallback) and clearing the
       * text a successful prompt already carried.
       */
      setDraft(text) {
        this.draft = typeof text === 'string' ? text : '';
        if (this.clearTimer) {
          window.clearTimeout(this.clearTimer);
          this.clearTimer = 0;
        }
      },

      // -------------------------------------------------------------- selection

      mount() {
        if (this.mounted) return this.mounted;
        const schedule = () => this.scheduleScan();
        const onPointerUp = () => schedule();
        const onKeyUp = (event) => {
          if (
            event.shiftKey ||
            event.key === 'Shift' ||
            event.key === 'ArrowUp' ||
            event.key === 'ArrowDown'
          ) {
            schedule();
          }
        };
        const onSelectionChange = () => {
          if (this.popover) return;
          schedule();
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (target && target.closest && target.closest('[data-quote-reply-ui]')) return;
          if (this.popover) this.closePopover();
          else this.clearTarget();
        };
        /**
         * A streaming turn scrolls the transcript constantly. Clearing on scroll
         * pulled the pill away before it could be clicked, so scrolling only
         * re-measures the selection: the pill follows the text, and the reply
         * window (anchored to a fixed rect) is left alone.
         */
        const onViewportChange = () => {
          if (this.popover) return;
          this.scheduleScan();
        };
        const onKeyDown = (event) => this.handleKeyDown(event);
        const onClick = (event) => this.handleClick(event);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('keyup', onKeyUp, true);
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('click', onClick, true);
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);
        this.mounted = () => {
          document.removeEventListener('pointerup', onPointerUp, true);
          document.removeEventListener('keyup', onKeyUp, true);
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('click', onClick, true);
          window.removeEventListener('scroll', onViewportChange, true);
          window.removeEventListener('resize', onViewportChange);
          if (this.scanTimer) window.clearTimeout(this.scanTimer);
          if (this.frame) window.cancelAnimationFrame(this.frame);
          if (this.clearTimer) window.clearTimeout(this.clearTimer);
          this.scanTimer = 0;
          this.frame = 0;
          this.clearTimer = 0;
          this.mounted = null;
        };
        return this.mounted;
      },

      /**
       * Enter inside the composer sends the blocks together with any typed text.
       * A document-capture listener wins over the editor's own keymap, so the
       * composed draft is what the host submits.
       */
      handleKeyDown(event) {
        if (event.defaultPrevented) return;
        // Shift+Enter inserts a line break; Alt+Enter belongs to the editor.
        // Ctrl/Cmd+Enter is the host's "send" too, so it takes the same detour
        // as a plain Enter — otherwise those blocks would be left behind.
        if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
        if (event.isComposing || event.keyCode === 229) return;
        if (this.blocks.length === 0 || this.sending) return;
        const target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('[data-quote-reply-ui]')) return;
        const card = target.closest('[data-composer-card]');
        if (!card) return;
        if (target.closest('textarea, input, select, [data-composer-overlay]')) return;
        event.preventDefault();
        event.stopPropagation();
        this.sendNow();
      },

      /** The send button takes the same detour while blocks are waiting. */
      handleClick(event) {
        if (event.defaultPrevented) return;
        if (this.blocks.length === 0 || this.sending) return;
        const target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('[data-quote-reply-ui]')) return;
        const card = target.closest('[data-composer-card]');
        if (!card) return;
        const button = target.closest('button');
        if (!button || !isSendButton(button, card)) return;
        // While a turn runs the primary button *is* Stop whenever the composer is
        // empty; that click belongs to the host's interrupt, never to this plugin.
        if (this.running && this.cleanDraft().trim() === '') return;
        event.preventDefault();
        event.stopPropagation();
        this.sendNow();
      },

      scheduleScan() {
        if (this.scanTimer) window.clearTimeout(this.scanTimer);
        this.scanTimer = window.setTimeout(() => {
          this.scanTimer = 0;
          if (this.frame) window.cancelAnimationFrame(this.frame);
          this.frame = window.requestAnimationFrame(() => {
            this.frame = 0;
            this.scan();
          });
        }, 60);
      },

      scan() {
        if (this.popover) return;
        const found = readSelection();
        if (!found) {
          this.clearTarget();
          return;
        }
        // Scrolled fully out of view: nothing left to click, so drop it. A
        // partially visible selection keeps its pill and gets re-measured.
        if (found.rect.bottom < 0 || found.rect.top > window.innerHeight) {
          this.clearTarget();
          return;
        }
        if (sameTarget(this.target, found)) return;
        this.target = found;
        this.notify();
      },

      clearTarget() {
        if (this.target === null) return;
        this.target = null;
        this.notify();
      },

      // ---------------------------------------------------------------- popover

      openPopover(options) {
        const source = options || {};
        if (!source.rect || !this.session) return;
        this.seq += 1;
        this.popover = {
          id: this.seq,
          quote: source.text || '',
          reply: source.reply || '',
          blockId: source.blockId || null,
          rect: source.rect,
        };
        this.target = null;
        this.notify();
      },

      closePopover() {
        if (this.popover === null) return;
        this.popover = null;
        this.notify();
      },

      // ----------------------------------------------------------------- blocks

      commit(value) {
        const popover = this.popover;
        if (!popover) return false;
        const reply = String(value || '').trim();
        if (!reply) return false;
        if (popover.blockId !== null) {
          const block = this.blocks.find((candidate) => candidate.id === popover.blockId);
          if (block) {
            block.reply = reply;
            block.quote = popover.quote;
          }
        } else {
          this.seq += 1;
          this.blocks.push({ id: this.seq, quote: popover.quote, reply });
        }
        this.popover = null;
        try {
          const selection = window.getSelection();
          if (selection) selection.removeAllRanges();
        } catch (_error) {
          /* ignore */
        }
        this.notify();
        this.focusComposer();
        return true;
      },

      removeBlock(id) {
        const index = this.blocks.findIndex((block) => block.id === id);
        if (index < 0) return;
        this.blocks.splice(index, 1);
        this.notify();
      },

      /**
       * The draft as it really is right now. The host's published value is the
       * authority whenever it has anything to say; the editor is only consulted
       * to catch a keystroke the store has not published yet, never to declare
       * the composer empty against the host.
       */
      liveDraft() {
        const tracked = this.cleanDraft();
        if (tracked.trim() !== '') return tracked;
        try {
          const root = document.querySelector('[data-composer-card] [contenteditable="true"]');
          if (root) {
            const inline = String(root.innerText || '').replace(/\u200B/g, '');
            if (inline.trim() !== '') return inline;
          }
        } catch (_error) {
          /* fall through to the tracked value */
        }
        return tracked;
      },

      compose() {
        const typed = this.liveDraft().trim();
        const body = this.blocks
          .map((block) => {
            const quote = quoteWithBar(block.quote);
            return quote ? quote + '\n' + block.reply : block.reply;
          })
          .join('\n\n');
        if (!typed) return body;
        if (!body) return typed;
        // The composer's own typing sits under the blocks on screen, so it
        // lands last in the message too.
        return body + '\n\n' + typed;
      },

      /**
       * Send the composed message — one path only.
       *
       * The Session prompt is the harness's own send API: the composer is never
       * written to (except to clear what this send carried), there is no submit
       * race to lose, and queueing during a running turn stays the host's job.
       * A draft the prompt cannot carry (a file attachment) is refused with a
       * notice rather than falling back to a second, racy path.
       */
      sendNow() {
        if (this.sending) return;
        const session = this.session;
        if (!session) return;
        const actions = session.actions || {};
        const typed = this.liveDraft().trim();
        const text = this.compose();
        if (!text) return;
        const blocks = this.blocks.slice();
        let binding = null;
        try {
          binding =
            sessionsService && typeof sessionsService.binding === 'function'
              ? sessionsService.binding(session.sessionId)
              : null;
        } catch (error) {
          // A binding is only borrowable while the session is retained; a throw
          // here just means this send cannot use the direct path.
          console.error('quote-reply: session binding unavailable', error);
          binding = null;
        }
        const prompt =
          binding && binding.session && typeof binding.session.prompt === 'function'
            ? binding.session.prompt.bind(binding.session)
            : null;
        if (prompt === null) {
          // Profile without the sessions service: hand the text over instead of
          // pretending to send it. Submitting here would need a second code path
          // whose timing we cannot observe.
          this.writeDraft(text);
          this.blocks = [];
          this.setStatus('');
          this.notify();
          return;
        }
        const attachmentIds = this.attachmentIds === '' ? [] : this.attachmentIds.split(',');
        const token = ++this.sendSeq;
        this.sending = true;
        this.setStatus('sending');
        this.notify();
        // A prompt that never settles must not lock the send button forever.
        this.sendGuard = window.setTimeout(() => {
          this.sendGuard = 0;
          if (this.sendSeq !== token) return;
          // Invalidate the attempt: a settle that arrives after the watchdog must
          // not clear blocks the user has already been told stayed.
          this.sendSeq += 1;
          this.sending = false;
          this.setStatus('failed');
          this.notify();
        }, 30000);
        this.collectAttachmentParts(binding.session, attachmentIds)
          .then((collected) => {
            if (collected.sentIds.length < attachmentIds.length) {
              // A file attachment cannot become a prompt part: refuse, keep
              // everything, and say why.
              this.sending = false;
              this.setStatus('fileBlocked');
              this.notify();
              return null;
            }
            return Promise.resolve(prompt([{ type: 'text', text }, ...collected.parts], 'queue')).then(
              (result) => ({ result, collected }),
            );
          })
          .then(
            (settled) => {
              if (settled === null) return;
              const { result, collected } = settled;
              if (this.sendGuard) {
                window.clearTimeout(this.sendGuard);
                this.sendGuard = 0;
              }
              if (this.sendSeq !== token) return;
              this.sending = false;
              if (!result || result.ok !== true) {
                this.blocks = blocks;
                this.setStatus('failed');
                this.notify();
                return;
              }
              this.blocks = [];
              // The typed text travelled with the message, so it leaves the
              // composer. Clearing is unconditional: the published draft rarely
              // equals the trimmed capture byte for byte (trailing paragraphs,
              // placeholders), and gating on that equality left the text in the
              // input after a successful send. A short retry covers a host that
              // publishes the clear a frame later.
              if (typed !== '') {
                this.writeDraft('');
                this.clearTimer = window.setTimeout(() => {
                  this.clearTimer = 0;
                  if (this.cleanDraft().trim() !== '') this.writeDraft('');
                }, 150);
              }
              for (const id of collected.sentIds) {
                try {
                  if (typeof actions.removeAttachment === 'function') actions.removeAttachment(id);
                } catch (_error) {
                  /* the attachment rail is the host's; failing to prune is cosmetic */
                }
              }
              this.setStatus('');
              this.notify();
            },
            (error) => {
              console.error('quote-reply: prompt failed', error);
              if (this.sendGuard) {
                window.clearTimeout(this.sendGuard);
                this.sendGuard = 0;
              }
              if (this.sendSeq !== token) return;
              this.sending = false;
              this.blocks = blocks;
              this.setStatus('failed');
              this.notify();
            },
          );
      },

      /**
       * Read draft images into prompt content parts. A draft attachment the
       * session cannot read (a file receipt, an expired upload) is left in the
       * composer instead of failing the whole send.
       */
      collectAttachmentParts(session, ids) {
        if (ids.length === 0 || typeof session.readAttachment !== 'function') {
          return Promise.resolve({ parts: [], sentIds: [] });
        }
        return Promise.all(
          ids.map((id) =>
            Promise.resolve(session.readAttachment(id)).then(
              (result) => {
                if (!result || result.ok !== true) return { part: null, id };
                const { attachment, data } = result.value;
                let binary = '';
                const bytes = data || new Uint8Array(0);
                for (let index = 0; index < bytes.length; index += 0x8000) {
                  binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
                }
                return {
                  id,
                  part: {
                    type: 'image',
                    mediaType: attachment.mediaType,
                    data: window.btoa(binary),
                    ...(attachment.name === undefined ? {} : { name: attachment.name }),
                  },
                };
              },
              () => ({ part: null, id }),
            ),
          ),
        ).then((results) => ({
          parts: results.filter((entry) => entry.part !== null).map((entry) => entry.part),
          sentIds: results.filter((entry) => entry.part !== null).map((entry) => entry.id),
        }));
      },

      /** One guarded draft write; no other path writes to the composer. */
      writeDraft(next) {
        const actions = (this.session && this.session.actions) || {};
        if (typeof actions.setDraft !== 'function') return false;
        try {
          actions.setDraft(next);
          this.draft = next;
          return true;
        } catch (error) {
          console.error('quote-reply: draft write failed', error);
          return false;
        }
      },

      /** One short-lived visible status; notices clear themselves. */
      setStatus(status) {
        if (this.statusTimer) {
          window.clearTimeout(this.statusTimer);
          this.statusTimer = 0;
        }
        this.status = status;
        if (status === '' || status === 'sending') return;
        this.statusTimer = window.setTimeout(() => {
          this.statusTimer = 0;
          this.status = '';
          this.notify();
        }, 4000);
      },

      focusComposer() {
        try {
          const seat = document.querySelector('[data-composer-seat]');
          const editable = seat && seat.querySelector('[contenteditable="true"]');
          if (editable && typeof editable.focus === 'function') editable.focus({ preventScroll: true });
        } catch (_error) {
          /* focus is a convenience, never a failure */
        }
      },
    };

    // ---------------------------------------------------------------- react glue

    function useSnapshot() {
      const [, force] = React.useState(0);
      React.useEffect(() => manager.subscribe(() => force((value) => value + 1)), []);
      return manager.snapshot();
    }

    // ---------------------------------------------------------------------- CSS

    const CSS = `
/* The Harness brand token is monochrome (white in the dark theme), so the
   accent is this plugin's own terracotta: it stays legible on both surfaces. */
[data-quote-reply-ui]{--dqr-accent:#d97757;--dqr-accent-ink:#ffffff;}
.dqr-pill{position:fixed;z-index:2147482000;pointer-events:auto;display:inline-flex;align-items:center;
  height:32px;padding:0 12px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  border-radius:10px;background:var(--dsw-alias-bg-overlay, #fff);
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;font-weight:500;line-height:1;
  letter-spacing:.01em;cursor:pointer;-webkit-user-select:none;user-select:none;white-space:nowrap;
  box-shadow:0 12px 34px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.10);
  animation:dqr-pop .13s cubic-bezier(.2,.8,.3,1) both;}
.dqr-pill:hover{background:var(--dsw-alias-bg-layer-1, #f7f7f5);}
.dqr-pop{position:fixed;z-index:2147482001;pointer-events:auto;box-sizing:border-box;display:flex;
  flex-direction:column;gap:10px;padding:13px 14px 11px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  font-family:inherit;width:min(${POPOVER_WIDTH}px, calc(100vw - 24px));
  box-shadow:0 24px 60px rgba(0,0,0,.22),0 3px 10px rgba(0,0,0,.08);
  animation:dqr-fade .12s ease-out both;}
.dqr-quote{position:relative;max-height:66px;overflow:hidden;padding-left:11px;
  color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;}
.dqr-quote::before{content:'';position:absolute;left:0;top:2px;bottom:2px;width:2px;border-radius:2px;
  background:var(--dqr-accent);opacity:.85;}
.dqr-row{display:flex;align-items:flex-end;gap:10px;padding-top:10px;
  border-top:1px solid var(--dsw-alias-border-l1);}
.dqr-input{box-sizing:border-box;flex:1 1 auto;width:100%;min-height:24px;max-height:200px;padding:2px 0;
  border:0;outline:0;resize:none;background:transparent;color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13.5px;line-height:1.6;overflow-y:auto;caret-color:var(--dqr-accent);}
.dqr-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72;}
.dqr-sendicon{flex:0 0 auto;box-sizing:border-box;width:28px;height:28px;padding:0;border:0;border-radius:50%;
  display:grid;place-items:center;background:var(--dqr-accent);color:#fff;cursor:pointer;
  box-shadow:0 1px 2px rgba(0,0,0,.18);transition:filter .12s ease,background .12s ease;}
.dqr-sendicon:disabled{background:transparent;color:var(--dsw-alias-label-secondary);opacity:.45;
  box-shadow:none;cursor:default;}
.dqr-sendicon:not(:disabled):hover{filter:brightness(1.07);}
.dqr-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4;opacity:.75;}
.dqr-strip{box-sizing:border-box;display:flex;flex-wrap:wrap;gap:6px;
  width:calc(100% - var(--dsh-composer-side-clearance, 6px) * 2);
  max-width:var(--dsh-composer-card-max-width, 100%);
  margin:0 auto calc(-8px - var(--dsh-composer-stack-gap, 6px));padding:8px 10px 9px;
  background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1));
  border-radius:var(--dsw-radius-panel, 14px) var(--dsw-radius-panel, 14px) 0 0;
  position:relative;z-index:2;max-height:196px;overflow-y:auto;scrollbar-width:thin;}
/* 76 = 2 border + 7 top + 4 bottom padding + 30 quote + 3 gap + 30 answer.
   The gap is what separates a full quote from a full answer; the bottom keeps
   only the padding, so a two-line answer sits flush instead of floating. */
.dqr-tile{position:relative;flex:0 0 auto;box-sizing:border-box;width:76px;height:76px;padding:7px 7px 4px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  /* Lift whichever way the theme goes: 7% of the text colour over the card. */
  background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%,
    var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2)));
  box-shadow:0 1px 2px rgba(0,0,0,.06);overflow:hidden;}
.dqr-tile:hover{border-color:var(--dsw-alias-border-l2);}
.dqr-tile-quote{box-sizing:border-box;height:30px;overflow:hidden;}
.dqr-tile-quote-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  padding-left:6px;border-left:2px solid var(--dqr-accent);color:var(--dsw-alias-label-secondary);
  font-size:10.5px;line-height:15px;word-break:break-word;overflow-wrap:anywhere;}
.dqr-tile-reply{box-sizing:border-box;height:30px;margin-top:3px;
  display:flex;flex-direction:column;justify-content:flex-end;
  overflow:hidden;color:var(--dsw-alias-label-primary);font-size:10.5px;line-height:15px;}
.dqr-tile-reply-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  word-break:break-word;overflow-wrap:anywhere;}
.dqr-tile-tools{position:absolute;top:2px;right:2px;display:flex;gap:1px;padding:1px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay));opacity:0;
  transition:opacity .12s ease;box-shadow:0 1px 2px rgba(0,0,0,.10);}
.dqr-tile:hover .dqr-tile-tools,.dqr-tile:focus-within .dqr-tile-tools{opacity:1;}
.dqr-msg-quote{display:inline-block;box-sizing:border-box;width:100%;margin:1px 0;padding-left:10px;border-left:2px solid;
  border-color:var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 35%, transparent));
  color:var(--dsw-alias-label-secondary);}
.dqr-more{display:inline-block;margin:2px 0 0;padding:0;border:0;background:none;
  color:var(--dqr-accent);font:inherit;font-size:12.5px;line-height:1.5;cursor:pointer;
  text-decoration:underline;text-underline-offset:2px;}
.dqr-more:hover{filter:brightness(1.1);}
.dqr-tool{width:18px;height:18px;display:grid;place-items:center;padding:0;border:0;border-radius:5px;
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.dqr-tool:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16));
  color:var(--dsw-alias-label-primary);}
.dqr-send{flex:0 0 auto;align-self:center;margin-left:auto;height:28px;padding:0 13px;border:0;border-radius:8px;
  background:var(--dqr-accent);color:var(--dqr-accent-ink);font-family:inherit;font-size:12px;font-weight:500;
  line-height:1;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.16);}
.dqr-send:hover{filter:brightness(1.07);}
.dqr-send:disabled{opacity:.55;cursor:default;filter:none;}
.dqr-status{margin-left:auto;align-self:center;font-size:11.5px;line-height:1.4;
  color:var(--dsw-alias-label-secondary);}
.dqr-status-failed{color:var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary));}
.dqr-status + .dqr-send{margin-left:8px;}
@keyframes dqr-fade{from{opacity:0;}to{opacity:1;}}
@keyframes dqr-pop{from{opacity:0;transform:translate(-50%,2px) scale(.94);}
  to{opacity:1;transform:translate(-50%,0) scale(1);}}
`;

    // ---------------------------------------------------------------- components

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max));
    }

    /**
     * Above the first line of the selection, a few pixels off it and centred on
     * that line — a tooltip anchored to where the eye starts, not to the middle
     * of a tall multi-line selection.
     */
    function pillPosition(target) {
      const height = 32;
      const gap = 6;
      const margin = 8;
      const line = target.line || target.rect;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const placeAbove = line.top - height - gap >= margin;
      const raw = placeAbove ? line.top - height - gap : line.top + (line.height || 20) + gap;
      return {
        top: clamp(raw, margin, viewportHeight - height - margin),
        left: clamp(line.left + line.width / 2, 52, viewportWidth - 52),
        placement: placeAbove ? 'above' : 'below',
      };
    }

    function popoverPosition(rect) {
      const margin = 12;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(POPOVER_WIDTH, viewportWidth - margin * 2);
      const center = rect.left + rect.width / 2;
      const left = clamp(center - width / 2, margin, viewportWidth - width - margin);
      const below = rect.bottom + 8;
      const above = rect.top - 8;
      const placeAbove = viewportHeight - below < 250 && above > 250;
      return {
        left,
        top: placeAbove ? above : below,
        transform: placeAbove ? 'translateY(-100%)' : 'none',
      };
    }

    function QuotePill({ target }) {
      const position = pillPosition(target);
      return h(
        'button',
        {
          type: 'button',
          className: 'dqr-pill',
          'data-quote-reply-ui': '',
          style: { top: position.top, left: position.left, transform: 'translate(-50%,0)' },
          onMouseDown: (event) => event.preventDefault(),
          onClick: () =>
            manager.openPopover({ text: target.text, rect: target.line || target.rect }),
        },
        t('quote'),
      );
    }

    function QuotePopover({ data }) {
      const [value, setValue] = React.useState(data.reply || '');
      const inputRef = React.useRef(null);
      const position = popoverPosition(data.rect);
      const editing = data.blockId !== null;

      React.useEffect(() => {
        const element = inputRef.current;
        if (!element) return;
        element.focus({ preventScroll: true });
        const end = element.value.length;
        try {
          element.setSelectionRange(end, end);
        } catch (_error) {
          /* ignore */
        }
      }, []);

      React.useEffect(() => {
        const element = inputRef.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
      }, [value]);

      const canCommit = value.trim().length > 0;
      const submit = () => {
        if (!canCommit) return;
        manager.commit(value);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          manager.closePopover();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          const native = event.nativeEvent || {};
          if (native.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          submit();
        }
      };

      return h(
        'div',
        {
          className: 'dqr-pop',
          'data-quote-reply-ui': '',
          role: 'dialog',
          'aria-label': t('quote'),
          style: position,
          onMouseDown: (event) => event.stopPropagation(),
        },
        h('div', { className: 'dqr-quote' }, data.quote),
        h(
          'div',
          { className: 'dqr-row' },
          h('textarea', {
            ref: inputRef,
            className: 'dqr-input',
            value,
            rows: 1,
            placeholder: t('placeholder'),
            spellCheck: false,
            onChange: (event) => setValue(event.target.value),
            onKeyDown,
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dqr-sendicon',
              disabled: !canCommit,
              title: editing ? t('save') : t('add'),
              'aria-label': editing ? t('save') : t('add'),
              onMouseDown: (event) => event.preventDefault(),
              onClick: submit,
            },
            h(ArrowUpGlyph, null),
          ),
        ),
        h('div', { className: 'dqr-hint' }, editing ? t('hintSave') : t('hintAdd')),
      );
    }

    function ArrowUpGlyph() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          fill: 'currentColor',
          d: 'M8.6 3.1v8.4H7.4V3.1L4.2 6.3 3.4 5.5 8 0.9l4.6 4.6-.8.8-3.2-3.2Z',
        }),
      );
    }

    function PencilGlyph() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          fill: 'currentColor',
          d: 'M11.7 1.4a1.9 1.9 0 0 1 2.7 2.7l-8.1 8.1-3.6 1 1-3.6 8-8.2Zm1.3 1.4a.4.4 0 0 0-.6 0l-.9.9 1.4 1.4.9-.9a.4.4 0 0 0 0-.6l-.8-.8ZM11.6 6.4l-1.4-1.4-6.5 6.6-.4 1.4 1.4-.4 6.9-6.2Z',
        }),
      );
    }

    function CrossGlyph() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          fill: 'currentColor',
          d: 'M8 6.9 4.9 3.8 3.8 4.9 6.9 8l-3.1 3.1 1.1 1.1L8 9.1l3.1 3.1 1.1-1.1L9.1 8l3.1-3.1-1.1-1.1L8 6.9Z',
        }),
      );
    }

    /** Square tile: the opening of the quoted passage, truncated to fit. */
    function QuoteTile({ block }) {
      const openEditor = (event) => {
        const tile = event.currentTarget.closest('.dqr-tile');
        const rect = tile ? tile.getBoundingClientRect() : null;
        if (!rect) return;
        manager.openPopover({
          text: block.quote,
          rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          reply: block.reply,
          blockId: block.id,
        });
      };
      const quotePreview = block.quote.replace(/\s+/g, ' ').trim();
      const replyPreview = block.reply.replace(/\s+/g, ' ').trim();
      return h(
        'div',
        {
          className: 'dqr-tile',
          'data-quote-reply-ui': '',
          role: 'listitem',
          title: `${block.quote}\n\n${block.reply}`,
        },
        h(
          'div',
          { className: 'dqr-tile-quote' },
          h('div', { className: 'dqr-tile-quote-text' }, quotePreview || replyPreview),
        ),
        h(
          'div',
          { className: 'dqr-tile-reply' },
          h('div', { className: 'dqr-tile-reply-text' }, quotePreview ? replyPreview : ''),
        ),
        h(
          'div',
          { className: 'dqr-tile-tools' },
          h(
            'button',
            {
              type: 'button',
              className: 'dqr-tool',
              title: t('edit'),
              'aria-label': t('edit'),
              onMouseDown: (event) => event.preventDefault(),
              onClick: openEditor,
            },
            h(PencilGlyph, null),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dqr-tool',
              title: t('remove'),
              'aria-label': t('remove'),
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => manager.removeBlock(block.id),
            },
            h(CrossGlyph, null),
          ),
        ),
      );
    }

    function QuoteReplyOverlay() {
      const state = useSnapshot();
      React.useEffect(() => manager.mount(), []);
      const visible = state.hasSession;
      return h(
        FRAG,
        null,
        // Rendered unconditionally: a session flip would otherwise unmount and
        // remount the stylesheet, and the transcript rule would blink with it.
        h('style', null, CSS),
        visible && state.target ? h(QuotePill, { key: 'pill', target: state.target }) : null,
        visible && state.popover
          ? h(QuotePopover, { key: `popover-${state.popover.id}`, data: state.popover })
          : null,
      );
    }

    /** The published composer draft (InputState.draft, not a DOM read). */
    const selectDraft = (state) => (state && typeof state.draft === 'string' ? state.draft : '');
    /** Draft attachment ids, joined so the selector stays referentially stable. */
    const selectAttachments = (state) =>
      state && Array.isArray(state.attachmentIds) ? state.attachmentIds.join(',') : '';

    function QuoteStrip({ sessionId }) {
      const state = useSnapshot();
      if (state.sessionId !== sessionId || state.blocks.length === 0) return null;
      const sending = state.status === 'sending';
      return h(
        'div',
        { className: 'dqr-strip', 'data-quote-reply-ui': '', role: 'list' },
        state.blocks.map((block) => h(QuoteTile, { key: block.id, block })),
        state.status === ''
          ? null
          : h(
              'span',
              {
                className: `dqr-status${state.status === 'failed' ? ' dqr-status-failed' : ''}`,
                role: 'status',
              },
              t(
                state.status === 'failed'
                  ? 'sendFailed'
                  : state.status === 'fileBlocked'
                    ? 'sendFileBlocked'
                    : 'sending',
              ),
            ),
        h(
          'button',
          {
            type: 'button',
            className: 'dqr-send',
            title: t('send'),
            disabled: sending,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => manager.sendNow(),
          },
          t('send'),
        ),
      );
    }

    /** Live face: the slot hands down the composer's selector hook and actions. */
    function LiveQuoteReplyBridge(props) {
      const draft = props.useInput(selectDraft);
      const attachments = props.useInput(selectAttachments);
      // useSession is a standard prop of the same slot; without it the plugin
      // simply never believes a turn is running (Stop stays the host's).
      const running =
        typeof props.useSession === 'function'
          ? props.useSession((snapshot) => (snapshot && snapshot.running === true))
          : false;
      React.useEffect(() => {
        manager.attach(props.sessionId, props.inputActions);
      }, [props.sessionId, props.inputActions]);
      React.useEffect(() => {
        manager.setDraft(draft);
      }, [draft, props.sessionId]);
      React.useEffect(() => {
        manager.setAttachments(attachments);
      }, [attachments, props.sessionId]);
      React.useEffect(() => {
        manager.setRunning(running === true);
      }, [running, props.sessionId]);
      React.useEffect(() => () => manager.detach(props.sessionId), [props.sessionId]);
      return h(QuoteStrip, { sessionId: props.sessionId });
    }

    /** Idle face: no composer hook to read, so the tracked draft stays as-is. */
    function IdleQuoteReplyBridge(props) {
      React.useEffect(() => {
        manager.attach(props.sessionId, props.inputActions);
      }, [props.sessionId, props.inputActions]);
      React.useEffect(() => () => manager.detach(props.sessionId), [props.sessionId]);
      return h(QuoteStrip, { sessionId: props.sessionId });
    }

    /**
     * Session-scoped bridge. The two faces are separate components on purpose:
     * swapping hooks inside one instance (host hook vs fallback hook) changes the
     * hook count between renders and tears the composer down on a session switch.
     */
    function QuoteReplyBridge(props) {
      return typeof props.useInput === 'function'
        ? h(LiveQuoteReplyBridge, props)
        : h(IdleQuoteReplyBridge, props);
    }

    /**
     * Plain user text normally renders as raw text, so the quote marker would
     * show as a "│" character. This renderer draws those lines as a real quote
     * rule instead, and leaves every other message byte-for-byte as before.
     */
    function QuoteAwareUserText(props) {
      const node = props.node || {};
      const data = node.data || {};
      const text = String(data.display != null ? data.display : data.text != null ? data.text : props.raw || '');
      const isBar = (line) => line === '│' || line.startsWith('│ ');
      if (!text.split('\n').some(isBar)) {
        return h('span', { style: { whiteSpace: 'pre-wrap' } }, text);
      }
      const lines = text.split('\n');
      // One group is a quote run plus the answer (and typing) that follows it.
      const groups = [];
      let index = 0;
      while (index < lines.length) {
        if (!isBar(lines[index])) {
          let end = index;
          while (end < lines.length && !isBar(lines[end])) end += 1;
          groups.push({ quote: null, body: lines.slice(index, end) });
          index = end;
          continue;
        }
        let end = index;
        while (end < lines.length && isBar(lines[end])) end += 1;
        const quote = lines
          .slice(index, end)
          .map((line) => (line === '│' ? '' : line.slice(2)))
          .join('\n');
        let tail = end;
        while (tail < lines.length && !isBar(lines[tail])) tail += 1;
        groups.push({ quote, body: lines.slice(end, tail) });
        index = tail;
      }
      return h(QuoteMessage, { groups, key: 'q-reply' });
    }

    /** Long multi-quote messages collapse the way Claude shows a long paste. */
    const QUOTE_VISIBLE_GROUPS = 2;

    function QuoteMessage({ groups }) {
      const [expanded, setExpanded] = React.useState(false);
      const collapsible = groups.length > QUOTE_VISIBLE_GROUPS;
      const visible = collapsible && !expanded ? groups.slice(0, QUOTE_VISIBLE_GROUPS) : groups;
      const hidden = groups.length - visible.length;
      const out = [];
      visible.forEach((group) => {
        if (group.quote !== null) {
          // A block element swallows the newline that preceded it; the blank
          // line between a reply and the next quote has to be put back.
          if (out.length > 0) out.push('\n');
          out.push(h('span', { key: `q${out.length}`, className: 'dqr-msg-quote' }, group.quote));
        }
        if (group.body.length > 0) {
          out.push(h('span', { key: `t${out.length}` }, group.body.join('\n')));
        }
      });
      if (hidden > 0) {
        out.push(
          h(
            'button',
            {
              key: 'more',
              type: 'button',
              className: 'dqr-more',
              'data-quote-reply-ui': '',
              onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                setExpanded(true);
              },
            },
            t('showMore', { count: hidden }),
          ),
        );
      }
      return h('span', { style: { whiteSpace: 'pre-wrap' } }, out);
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        // Copy lives in the Harness dictionary: the service resolves the active
        // language and its fallback chain, and live-switches with the app.
        try {
          localeService = ctx.get('locale') || null;
          if (localeService) {
            ctx.effect(() => localeService.register(NS, 'en', I18N.en), 'quote-reply: en');
            ctx.effect(() => localeService.register(NS, 'zh', I18N.zh), 'quote-reply: zh');
            translate = localeService.bind(NS);
          }
          const release = ctx.on('locale/change', () => {
            manager.notify();
          });
          ctx.effect(() => release, 'quote-reply: locale');
        } catch (_error) {
          /* a missing locale service keeps the browser-derived table */
        }
        // Direct send path: the Session prompt owns queueing while a turn runs.
        try {
          sessionsService = ctx.get('sessions') || null;
        } catch (_error) {
          sessionsService = null;
        }
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'quote-reply-overlay', order: 50 }, QuoteReplyOverlay),
        );
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'quote-reply', order: 60 }, QuoteReplyBridge),
        );
        // Priority order is ascending: the first live entry of the cell wins,
        // so a smaller number than the shipped 100 is what shadows it.
        ctx.slots.inject('conversation.user.text.node', () =>
          ctx.slots.register(
            { name: 'conversation.user.text.node', key: 'text', priority: 10 },
            QuoteAwareUserText,
          ),
        );
      },
    };
  },
});

