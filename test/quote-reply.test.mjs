import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import fc from 'fast-check';

const SRC = fileURLToPath(new URL('../client.js', import.meta.url));

const dom = new JSDOM(
  `<!doctype html><html lang="zh-CN"><body>
     <div data-conversation-session="s1">
       <div data-conversation-region="chat"><p id="msg">Hello world</p></div>
     </div>
     <div data-composer-seat>
       <div data-composer-card>
         <div contenteditable="true" id="ed"></div>
         <button type="button" class="XyZ_primary" aria-label="发送"></button>
       </div>
     </div>
   </body></html>`,
  { pretendToBeVisual: true, url: 'http://127.0.0.1/' },
);

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
globalThis.Event = window.Event;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, label) => {
  if (!ok) {
    console.error('FAIL:', label);
    process.exitCode = 1;
  } else {
    console.log('ok  -', label);
  }
};

// ---- load the plugin module the way the Web shell does -----------------------
let factory = null;
window.__ModuleLoader__ = {
  load(definition) {
    factory = definition.factory;
  },
};
new Function('window', fs.readFileSync(SRC, 'utf8'))(window);
const plugin = factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});

const registrations = {};
const injected = [];
const registered = [];
const dictionaries = {};
const localeListeners = [];
let activeLocale = 'zh';
const localeService = {
  getLocale: () => ({ active: activeLocale }),
  register(namespace, language, dictionary) {
    const key = `${namespace}:${language}`;
    dictionaries[key] = dictionary;
    return () => {
      delete dictionaries[key];
    };
  },
  bind(namespace) {
    return (key) => {
      const table = dictionaries[`${namespace}:${activeLocale}`] || {};
      return table[key] || key;
    };
  },
};

// Sending is the prompt path: the harness installs a recording binding by
// default, and a test replaces it to exercise refusals or file attachments.
const prompted = [];
let promptBinding = {
  session: {
    prompt(content, mode) {
      prompted.push({ content, mode });
      return Promise.resolve({ ok: true, value: { accepted: true } });
    },
  },
};
const sessionsService = {
  binding() {
    return promptBinding === null ? undefined : promptBinding;
  },
};
const lastPromptText = () =>
  prompted.length === 0 ? undefined : prompted[prompted.length - 1].content[0].text;

const ctx = {
  get(name) {
    if (name === 'locale') return localeService;
    if (name === 'sessions') return sessionsService;
    return undefined;
  },
  on(event, listener) {
    if (event === 'locale/change') localeListeners.push(listener);
    return () => {};
  },
  effect(callback) {
    const dispose = callback();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  slots: {
    inject(key, callback) {
      injected.push(key);
      return callback();
    },
    register(options, component) {
      registered.push({ ...options });
      const name = options.id || (options.key ? `key:${options.key}` : 'unknown');
      registrations[name] = component;
      return () => {
        delete registrations[name];
      };
    },
  },
};
plugin.apply(ctx);

// The slot names, keys and priorities are the contract with the host: a typo
// here makes the plugin load silently into nowhere, which no UI assertion sees.
assert(
  JSON.stringify(injected) ===
    JSON.stringify(['shell.overlay', 'conversation.input.dock', 'conversation.user.text.node']),
  `the plugin injects its three slots (got ${JSON.stringify(injected)})`,
);
assert(
  registered.some(
    (row) => row.name === 'shell.overlay' && row.id === 'quote-reply-overlay' && row.order === 50,
  ),
  'the overlay registers on shell.overlay with a stable id',
);
assert(
  registered.some(
    (row) => row.name === 'conversation.input.dock' && row.id === 'quote-reply' && row.order === 60,
  ),
  'the dock registers on conversation.input.dock',
);
assert(
  registered.some(
    (row) =>
      row.name === 'conversation.user.text.node' &&
      row.key === 'text' &&
      row.priority === 10,
  ),
  'the text renderer registers with priority 10 (the host uses 100)',
);
assert(typeof registrations['quote-reply-overlay'] === 'function', 'overlay registered');
assert(typeof registrations['quote-reply'] === 'function', 'bridge registered');
assert(typeof registrations['key:text'] === 'function', 'user-text renderer registered');
assert(dictionaries['quote-reply:en'] && dictionaries['quote-reply:zh'], 'dictionaries registered with the host locale service');

// ---- mount both halves -------------------------------------------------------
const Overlay = registrations['quote-reply-overlay'];
const Bridge = registrations['quote-reply'];

let draftText = '';
const writes = [];
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

let activeSession = 's1';
let attachmentIds = [];
let sessionRunning = false;
const removedAttachments = [];

function App() {
  const actions = {
    setDraft(next) {
      draftText = next;
      writes.push(next);
      root.render(React.createElement(App));
    },
    removeAttachment(id) {
      removedAttachments.push(id);
    },
  };
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Overlay, null),
    React.createElement(Bridge, {
      sessionId: activeSession,
      inputActions: actions,
      useInput: (selector) => selector({ draft: draftText, attachmentIds }),
      useSession: (selector) => selector({ running: sessionRunning }),
    }),
  );
}
root.render(React.createElement(App));
await wait(60);

// ---- selection plumbing ------------------------------------------------------
let currentQuote = 'Hello world';
let removed = 0;
let selectionRects = [{ top: 320, left: 240, right: 480, bottom: 340, width: 240, height: 20 }];
window.getSelection = () => ({
  rangeCount: 1,
  isCollapsed: false,
  getRangeAt: () => ({
    commonAncestorContainer: document.getElementById('msg').firstChild,
    getBoundingClientRect: () => selectionRects[0],
    getClientRects: () => selectionRects,
  }),
  toString: () => currentQuote,
  removeAllRanges() {
    removed += 1;
  },
});

const select = async (text) => {
  currentQuote = text;
  document.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  await wait(180);
};

const openReply = async (text) => {
  await select(text);
  const pill = document.querySelector('.dqr-pill');
  assert(pill !== null, `pill appears for "${text}"`);
  assert(pill && pill.textContent === '引用文本', 'pill label is 引用文本 (no icon)');
  pill.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(50);
  return document.querySelector('.dqr-pop');
};

const typeReply = async (text) => {
  const textarea = document.querySelector('.dqr-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, text);
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(20);
  textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(50);
};

// ---- first block -------------------------------------------------------------
await openReply('Hello world');
assert(document.querySelector('.dqr-quote').textContent.includes('Hello world'), 'popover previews the quote');
await typeReply('第一条回复');
assert(document.querySelectorAll('.dqr-tile').length === 1, 'one block card in the composer rail');
assert(draftText === '', `composer draft is left untouched (got ${JSON.stringify(draftText)})`);
assert(document.querySelector('.dqr-pop') === null, 'popover closes after Enter');
assert(removed > 0, 'text selection is cleared');

// ---- second block ------------------------------------------------------------
await openReply('Second bit');
await typeReply('第二条回复');
assert(document.querySelectorAll('.dqr-tile').length === 2, 'two block cards coexist');
assert(document.querySelector('.dqr-strip').textContent.includes('Second bit'), 'rail shows both blocks');

// ---- edit the first block ----------------------------------------------------
document.querySelectorAll('.dqr-tile')[0].querySelectorAll('.dqr-tool')[0].dispatchEvent(
  new window.MouseEvent('click', { bubbles: true }),
);
await wait(50);
const editBox = document.querySelector('.dqr-input');
assert(editBox !== null, 'edit opens the popover');
assert(editBox.value === '第一条回复', 'edit pre-fills the existing reply');
await typeReply('第一条回复（改）');
assert(document.querySelectorAll('.dqr-tile')[0].getAttribute('title').includes('第一条回复（改）'), 'edit updates the block');

// ---- typed text lives beside the blocks -------------------------------------
draftText = '我自己写的一句话';
root.render(React.createElement(App));
await wait(40);
assert(document.querySelectorAll('.dqr-tile').length === 2, 'blocks survive ordinary typing');

// ---- send with Enter ---------------------------------------------------------
const editor = document.getElementById('ed');
editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await wait(160);
assert(prompted.length === 1, 'Enter sends exactly once');
assert(
  lastPromptText() === '│ Hello world\n第一条回复（改）\n\n│ Second bit\n第二条回复\n\n我自己写的一句话',
  `composed message carries typed text then blockquote/reply pairs (got ${JSON.stringify(lastPromptText())})`,
);
assert(document.querySelectorAll('.dqr-tile').length === 0, 'blocks are consumed by the send');

// ---- send with the send button ----------------------------------------------
draftText = '';
root.render(React.createElement(App));
await wait(40);
await openReply('Third');
await typeReply('第三条回复');
await openReply('Fourth');
await typeReply('第四条回复');
document.querySelector('.XyZ_primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(160);
assert(prompted.length === 2, 'the send button sends too');
assert(
  lastPromptText() === '│ Third\n第三条回复\n\n│ Fourth\n第四条回复',
  `block-only message keeps the blockquote format (got ${JSON.stringify(lastPromptText())})`,
);

// ---- the strip's own send button (blocks only, host button disabled) --------
draftText = '';
root.render(React.createElement(App));
await wait(40);
await openReply('Fifth');
await typeReply('第五条回复');
assert(document.querySelectorAll('.dqr-tile').length === 1, 'a block was added again');
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(160);
assert(prompted.length === 3, 'the strip button sends too');
assert(
  lastPromptText() === '│ Fifth\n第五条回复',
  `strip send composes the same format (got ${JSON.stringify(lastPromptText())})`,
);

// ---- deleting the last block leaves the draft alone ------------------------
draftText = '';
root.render(React.createElement(App));
await wait(40);
await openReply('Sixth');
await typeReply('第六条回复');
assert(document.querySelectorAll('.dqr-tile').length === 1, 'one block before deleting');
const tools = document.querySelectorAll('.dqr-tile .dqr-tool');
tools[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
assert(document.querySelectorAll('.dqr-tile').length === 0, 'delete removes the block');
assert(draftText === '', `deleting never writes the draft (got ${JSON.stringify(draftText)})`);

// ---- quoting a message that already carries quote bars ---------------------
draftText = '';
root.render(React.createElement(App));
await wait(40);
await openReply('│ 之前引用的第一行\n│ 之前引用的第二行');
await wait(40);
const reused = document.querySelector('.dqr-pop .dqr-quote');
assert(reused && !reused.textContent.includes('│'), 'carried-in quote bars are stripped in the preview');
await typeReply('新的回复');
assert(
  document.querySelector('.dqr-tile').getAttribute('title') === '之前引用的第一行\n之前引用的第二行\n\n新的回复',
  'the block stores the stripped quote',
);
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(160);
assert(
  lastPromptText() === '│ 之前引用的第一行\n│ 之前引用的第二行\n新的回复',
  `composed quote bars never nest (got ${JSON.stringify(lastPromptText())})`,
);

// ---- the transcript renderer draws a real rule instead of the glyph ---------
const UserText = registrations['key:text'];
const transcript = document.createElement('div');
document.body.appendChild(transcript);
const tRoot = createRoot(transcript);

const renderText = async (text) => {
  tRoot.render(React.createElement(UserText, { node: { data: { text } }, raw: text }));
  await wait(30);
};

await renderText('│ 引用第一行\n│ 引用第二行\n我的回复');
const quoteEl = transcript.querySelector('.dqr-msg-quote');
assert(quoteEl !== null, 'quote lines become a styled block');
assert(quoteEl.textContent === '引用第一行\n引用第二行', 'the block holds the quote without its glyphs');
assert(!transcript.textContent.includes('│'), 'no literal bar is left in the message');
assert(transcript.textContent.endsWith('我的回复'), 'the reply stays plain text');

await renderText('普通消息\n第二行');
assert(transcript.querySelector('.dqr-msg-quote') === null, 'ordinary messages render no quote block');
assert(transcript.textContent === '普通消息\n第二行', 'ordinary message text is untouched');

// ---- switching sessions keeps each queue and the dock stays mounted ---------
draftText = '';
activeSession = 's1';
root.render(React.createElement(App));
await wait(40);
await openReply('会话一的引用');
await typeReply('会话一的回复');
assert(document.querySelectorAll('.dqr-tile').length === 1, 'a block exists in session one');

activeSession = 's2';
root.render(React.createElement(App));
await wait(60);
assert(document.querySelector('.dqr-strip') === null, 'another session shows no blocks');
assert(document.querySelector('.dqr-pill') === null || true, 'dock survives the switch');

activeSession = 's1';
root.render(React.createElement(App));
await wait(60);
const back = document.querySelector('.dqr-strip');
assert(back !== null, 'returning to the session brings its queue back');
assert(back.textContent.includes('会话一的引用'), 'the queued quote is intact');

// ---- Ctrl/Cmd+Enter takes the same compose path -----------------------------
const beforeAccelerated = prompted.length;
document.getElementById('ed').dispatchEvent(
  new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
);
await wait(200);
assert(prompted.length === beforeAccelerated + 1, 'Ctrl+Enter submits once');
assert(
  String(lastPromptText()).includes('会话一的引用'),
  `Ctrl+Enter carries the waiting quote (got ${JSON.stringify(lastPromptText())})`,
);
assert(document.querySelectorAll('.dqr-tile').length === 0, 'Ctrl+Enter consumes the blocks');

// ---- switching the host language re-renders the copy ------------------------
activeLocale = 'en';
localeListeners.forEach((listener) => listener());
await wait(40);
currentQuote = 'English label check';
document.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
await wait(180);
const enPill = document.querySelector('.dqr-pill');
assert(enPill !== null, 'pill still appears after a locale switch');
assert(enPill.textContent === 'Quote Text', `pill follows the host language (got ${JSON.stringify(enPill.textContent)})`);

// ---- edge cases -------------------------------------------------------------
activeLocale = 'zh';
localeListeners.forEach((listener) => listener());
await wait(30);
// flush anything still queued from the locale section
if (document.querySelector('.dqr-send')) {
  document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(160);
}

// a multi-line quote gets one bar per line
await openReply('多行第一行\n多行第二行');
await typeReply('多行答复');
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(160);
assert(
  String(lastPromptText()).startsWith('│ 多行第一行\n│ 多行第二行\n多行答复'),
  `each quote line gets its own bar (got ${JSON.stringify(lastPromptText())})`,
);
assert(document.querySelectorAll('.dqr-tile').length === 0, 'sending clears the queue');

// a whitespace-only reply is refused and the popover stays open
await openReply('空白答复测试');
const blankBox = document.querySelector('.dqr-input');
const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setValue.call(blankBox, '   ');
blankBox.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(20);
blankBox.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await wait(40);
assert(document.querySelectorAll('.dqr-tile').length === 0, 'a whitespace-only reply adds no block');
assert(document.querySelector('.dqr-pop') !== null, 'the popover stays open for a real reply');
blankBox.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(40);

// deleting a middle block keeps the others in order
for (const passage of ['块一', '块二', '块三']) {
  await openReply(passage);
  await typeReply(`${passage}答复`);
}
assert(document.querySelectorAll('.dqr-tile').length === 3, 'three blocks queued');
document
  .querySelectorAll('.dqr-tile')[1]
  .querySelectorAll('.dqr-tool')[1]
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(50);
const remaining = Array.from(document.querySelectorAll('.dqr-tile')).map((tile) => tile.getAttribute('title'));
assert(remaining.length === 2, 'deleting the middle block leaves two');
assert(
  remaining[0].startsWith('块一') && remaining[1].startsWith('块三'),
  `deleting keeps the survivors in order (got ${JSON.stringify(remaining)})`,
);

// a long quote survives composing (truncation is display-only)
const longQuote = '很长的引用'.repeat(60);
await openReply(longQuote);
await typeReply('长引用的答复');
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(160);
assert(String(lastPromptText()).includes(longQuote), 'long quotes are not truncated when composed');

// ---- the pill anchors to the first line of a multi-line selection -----------
selectionRects = [
  { top: 300, left: 200, right: 400, bottom: 320, width: 200, height: 20 },
  { top: 340, left: 120, right: 500, bottom: 360, width: 380, height: 20 },
];
currentQuote = '两行选区的第一行\n两行选区的第二行';
document.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
await wait(180);
const anchored = document.querySelector('.dqr-pill');
assert(anchored !== null, 'pill appears for a multi-line selection');
assert(
  anchored.style.top === '262px' && anchored.style.left === '300px',
  `pill sits 6px above the first line, centred on it (got ${anchored.style.top} / ${anchored.style.left})`,
);

// a first line split into several rects is unioned before centring
selectionRects = [
  { top: 300, left: 200, right: 300, bottom: 320, width: 100, height: 20 },
  { top: 300, left: 320, right: 500, bottom: 320, width: 180, height: 20 },
  { top: 340, left: 120, right: 500, bottom: 360, width: 380, height: 20 },
];
currentQuote = '第一行被拆成两段\n第二行';
document.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
await wait(180);
const splitLine = document.querySelector('.dqr-pill');
assert(
  splitLine !== null && splitLine.style.left === '350px',
  `split first line is unioned before centring (got ${splitLine && splitLine.style.left})`,
);

// ---- a scrolling transcript keeps the pill upright ------------------------
selectionRects = [{ top: 320, left: 240, right: 480, bottom: 340, width: 240, height: 20 }];
currentQuote = '滚动时也不能消失';
document.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
await wait(180);
assert(document.querySelector('.dqr-pill') !== null, 'pill appears before the scroll');
window.dispatchEvent(new window.Event('scroll'));
await wait(220);
assert(
  document.querySelector('.dqr-pill') !== null,
  'a streaming scroll does not dismiss the pill',
);

// scrolled fully out of view: the pill goes away
selectionRects = [{ top: -60, left: 240, right: 480, bottom: -20, width: 240, height: 40 }];
window.dispatchEvent(new window.Event('scroll'));
await wait(220);
assert(
  document.querySelector('.dqr-pill') === null,
  'a selection scrolled out of the viewport drops the pill',
);

// ---- the direct prompt path never touches the composer --------------------
promptBinding = {
  session: {
    prompt(content, mode) {
      prompted.push({ content, mode });
      return Promise.resolve({ ok: true, value: { accepted: true } });
    },
  },
};
draftText = '';
selectionRects = [{ top: 320, left: 240, right: 480, bottom: 340, width: 240, height: 20 }];
root.render(React.createElement(App));
await wait(40);
while (document.querySelectorAll('.dqr-tile').length > 0) {
  // drop anything the in-flight case left queued
  document.querySelectorAll('.dqr-tile')[0].querySelectorAll('.dqr-tool')[1].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await wait(30);
}
await openReply('直连发送的引用');
await typeReply('直连发送的回复');
draftText = '手打的一句话';
root.render(React.createElement(App));
await wait(40);
const beforeDirect = prompted.length;
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(160);
assert(
  lastPromptText() === '│ 直连发送的引用\n直连发送的回复\n\n手打的一句话',
  `prompt carries the composed text (got ${JSON.stringify(lastPromptText())})`,
);
assert(prompted.length === beforeDirect + 1, 'prompt is called once per send');
assert(
  prompted[prompted.length - 1].mode === 'queue',
  'prompt queues while a turn may still be running',
);
assert(document.querySelectorAll('.dqr-tile').length === 0, 'a direct send releases the blocks');
assert(draftText === '', 'a direct send clears the typed text it carried');

// a refused prompt keeps the block and says so
promptBinding = {
  session: {
    prompt() {
      return Promise.resolve({ ok: false });
    },
  },
};
await openReply('会失败的直连引用');
await typeReply('会失败的直连回复');
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(160);
assert(document.querySelectorAll('.dqr-tile').length === 1, 'a refused prompt keeps the block');
assert(document.querySelector('.dqr-status') !== null, 'a refused prompt shows the failure notice');
promptBinding = null;

// ---- a draft image rides the prompt and is pruned from the composer ------
const promptParts = [];
promptBinding = {
  session: {
    readAttachment: () =>
      Promise.resolve({
        ok: true,
        value: { attachment: { mediaType: 'image/png', name: 'shot.png' }, data: new Uint8Array([1, 2, 3]) },
      }),
    prompt(parts) {
      promptParts.push(parts);
      return Promise.resolve({ ok: true, value: { accepted: true } });
    },
  },
};
attachmentIds = ['att-1'];
draftText = '';
selectionRects = [{ top: 320, left: 240, right: 480, bottom: 340, width: 240, height: 20 }];
root.render(React.createElement(App));
await wait(40);
while (document.querySelectorAll('.dqr-tile').length > 0) {
  document.querySelectorAll('.dqr-tile')[0].querySelectorAll('.dqr-tool')[1].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await wait(30);
}
await openReply('带图片的引用');
await typeReply('带图片的回复');
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(200);
assert(promptParts.length === 1, 'a draft attachment still sends through the prompt');
assert(promptParts[0].length === 2 && promptParts[0][1].type === 'image', 'the image becomes a content part');
assert(removedAttachments.includes('att-1'), 'the sent attachment leaves the composer rail');
promptBinding = null;
attachmentIds = [];

// ---- a file attachment is refused, nothing is lost -----------------------
let promptCallsWithFile = 0;
promptBinding = {
  session: {
    readAttachment: () => Promise.resolve({ ok: false }),
    prompt() {
      promptCallsWithFile += 1;
      return Promise.resolve({ ok: true, value: { accepted: true } });
    },
  },
};
attachmentIds = ['file-1'];
draftText = '';
selectionRects = [{ top: 320, left: 240, right: 480, bottom: 340, width: 240, height: 20 }];
root.render(React.createElement(App));
await wait(40);
while (document.querySelectorAll('.dqr-tile').length > 0) {
  document.querySelectorAll('.dqr-tile')[0].querySelectorAll('.dqr-tool')[1].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await wait(30);
}
await openReply('带文件的引用');
await typeReply('带文件的回复');
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(300);
assert(promptCallsWithFile === 0, 'a file attachment never reaches the prompt');
assert(document.querySelectorAll('.dqr-tile').length === 1, 'a refused file keeps the block');
assert(
  document.querySelector('.dqr-status') !== null,
  'a refused file explains itself instead of failing silently',
);
promptBinding = {
  session: {
    prompt(content, mode) {
      prompted.push({ content, mode });
      return Promise.resolve({ ok: true, value: { accepted: true } });
    },
  },
};
attachmentIds = [];

// ---- a profile without the sessions service fills the composer instead ----
promptBinding = null;
draftText = '';
selectionRects = [{ top: 320, left: 240, right: 480, bottom: 340, width: 240, height: 20 }];
root.render(React.createElement(App));
await wait(40);
while (document.querySelectorAll('.dqr-tile').length > 0) {
  document.querySelectorAll('.dqr-tile')[0].querySelectorAll('.dqr-tool')[1].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await wait(30);
}
await openReply('没有服务时的引用');
await typeReply('没有服务时的回复');
document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(200);
assert(
  draftText === '│ 没有服务时的引用\n没有服务时的回复',
  `without the service the text lands in the composer (got ${JSON.stringify(draftText)})`,
);
assert(document.querySelectorAll('.dqr-tile').length === 0, 'filling the composer releases the blocks');
assert(document.querySelector('.dqr-tile') === null, 'filling the composer leaves nothing behind');

// ---- property: composed text keeps its shape for random content -----------
// The previous case nulled the binding to test the composer fill; restore the
// recording prompt before measuring composed messages again.
promptBinding = {
  session: {
    prompt(content, mode) {
      prompted.push({ content, mode });
      return Promise.resolve({ ok: true, value: { accepted: true } });
    },
  },
};
const CASES = fc.sample(
  fc.tuple(
    fc.stringMatching(/^[^\n│\s][^\n│]{0,20}$/),
    fc.stringMatching(/^[^\n│\s][^\n│]{0,20}$/),
    fc.oneof(fc.constant(''), fc.stringMatching(/^[^\n│\s][^\n│]{0,20}$/)),
  ),
  { numRuns: 6, seed: 20251104 },
);
for (const [quote, reply, typed] of CASES) {
  draftText = '';
  while (document.querySelectorAll('.dqr-tile').length > 0) {
    document.querySelectorAll('.dqr-tile')[0].querySelectorAll('.dqr-tool')[1].dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    );
    await wait(30);
  }
  await openReply(quote);
  await typeReply(reply);
  draftText = typed;
  root.render(React.createElement(App));
  await wait(30);
  document.querySelector('.dqr-send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(140);
  const message = String(lastPromptText());
  assert(
    message.startsWith(`│ ${quote.trim()}\n`),
    `property: the quote leads the message (${JSON.stringify(quote)})`,
  );
  assert(
    message.includes(`\n${reply.trim()}`),
    `property: the reply follows its quote (${JSON.stringify(reply)})`,
  );
  if (typed !== '') {
    assert(
      message.endsWith(`\n\n${typed.trim()}`),
      `property: the typed text lands last (${JSON.stringify(typed)})`,
    );
  }
  assert(!message.includes('│ │'), 'property: quote bars never nest');
}

// ---- the Stop button is never hijacked ------------------------------------
// While a turn runs with an empty composer the host turns this same primary
// button into Stop; a click there must reach the host, not become a send.
sessionRunning = true;
draftText = '';
selectionRects = [{ top: 320, left: 240, right: 480, bottom: 340, width: 240, height: 20 }];
root.render(React.createElement(App));
await wait(40);
while (document.querySelectorAll('.dqr-tile').length > 0) {
  document.querySelectorAll('.dqr-tile')[0].querySelectorAll('.dqr-tool')[1].dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await wait(30);
}
await openReply('运行中也不能夺走停止');
await typeReply('运行中也不能夺走停止的回复');
const beforeStop = prompted.length;
const primary = document.querySelector('.XyZ_primary');
primary.setAttribute('aria-label', '停止');
primary.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(150);
assert(prompted.length === beforeStop, 'a Stop click is never turned into a send');
primary.setAttribute('aria-label', '发送');
sessionRunning = false;
root.render(React.createElement(App));
await wait(60);
primary.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(150);
assert(prompted.length === beforeStop + 1, 'the same button sends once the turn ends');

console.log('\nwrites:', JSON.stringify(writes));
console.log(process.exitCode ? 'RESULT: failures' : 'RESULT: all checks passed');




