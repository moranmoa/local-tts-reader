// Local TTS Reader - background script (service worker in Chrome, event page in Firefox).
// All reading goes through one player: a list of paragraphs (items) with a current index,
// so the popup can show the text, pause, go back/forward and jump to any paragraph.
// Speech uses LOCAL voices only:
//   Chrome  -> chrome.tts with voices where remote === false
//   Firefox -> no chrome.tts, so the page's speechSynthesis (OS voices) is used via content.js
// Language: text is split into runs by script (Hebrew / Latin / Cyrillic ...), each run's
// language is detected offline (i18n.detectLanguage + script), and a local voice for that
// language is used when one is installed.

const ext = globalThis.browser || globalThis.chrome;
const HAS_EXT_TTS = !!(ext.tts && ext.tts.speak);

const DEFAULTS = { voiceName: "", rate: 1, volume: 1, liveOnlyNew: true, backlog: 5, autoLang: true, skipNav: true };
const CHUNK_MAX = 220;

// ---------- settings ----------

async function getSettings() {
  const s = await ext.storage.sync.get(DEFAULTS);
  return {
    ...s,
    rate: Number(s.rate) || 1,
    volume: Math.min(1, Math.max(0, Number(s.volume))),
    backlog: Math.max(1, Number(s.backlog) || 1),
  };
}

// ---------- language ----------

const baseLang = (l) => {
  const b = (l || "").toLowerCase().split(/[-_]/)[0];
  return b === "iw" ? "he" : b; // CLD reports Hebrew as "iw"
};

// Letter -> script group. Neutral characters (spaces, digits, punctuation, emoji) return null.
const SCRIPT_TESTS = [
  ["he", /[֐-׿]/],
  ["ar", /[؀-ۿ]/],
  ["ru", /[Ѐ-ӿ]/],
  ["el", /[Ͱ-Ͽ]/],
  ["th", /[฀-๿]/],
  ["hi", /[ऀ-ॿ]/],
  ["ko", /[가-힯]/],
  ["cjk", /[぀-ヿ一-鿿]/],
  ["latin", /[A-Za-zÀ-ɏ]/],
];
function charScript(ch) {
  for (const [s, re] of SCRIPT_TESTS) if (re.test(ch)) return s;
  return null;
}

// "Moran: שלום לכולם" -> [{script:"latin", text:"Moran: "}, {script:"he", text:"שלום לכולם"}]
// so each part can get a voice that can actually pronounce it.
function splitByScript(text) {
  const runs = [];
  let cur = null;
  for (const ch of text) {
    const s = charScript(ch);
    if (!cur) cur = { script: s, text: ch };
    else if (s && cur.script && s !== cur.script) { runs.push(cur); cur = { script: s, text: ch }; }
    else { cur.text += ch; if (!cur.script) cur.script = s; }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.text.trim());
}

// Offline detector (Chrome/Firefox built-in CLD). Returns a base language code, or null if unsure.
async function detectCld(text) {
  try {
    const r = await ext.i18n.detectLanguage(text);
    const top = r?.languages?.[0];
    if (r?.isReliable && top && top.language !== "und") return baseLang(top.language);
  } catch (_) { /* not available */ }
  return null;
}

// voices: [{ name, lang }]. Returns { voice, missing } - missing = detected language with no installed voice.
function resolveVoice(voices, preferredName, lang, autoLang) {
  if (!voices.length) return { voice: null, missing: null };
  const preferred = voices.find((v) => v.name === preferredName);
  const fallback = preferred || voices.find((v) => baseLang(v.lang) === "en") || voices[0];
  if (autoLang && lang) {
    if (preferred && baseLang(preferred.lang) === lang) return { voice: preferred, missing: null };
    const match = voices.find((v) => baseLang(v.lang) === lang);
    if (match) return { voice: match, missing: null };
    return { voice: fallback, missing: lang };
  }
  return { voice: fallback, missing: null };
}

function reportMissingVoice(lang) {
  ext.storage.local.set({ missingVoice: { lang, at: Date.now() } }).catch(() => {});
}

function getLocalVoices() {
  return new Promise((resolve) =>
    ext.tts.getVoices((v) =>
      resolve((v || []).filter((x) => !x.remote).map((x) => ({ name: x.voiceName, lang: x.lang })))
    )
  );
}

// ---------- text -> items ----------
// An "item" is one paragraph (or a piece of a long one, or one chat message). The popup lists
// items, and back / forward / click-to-jump move between them.
// item = { text, parts: [{ text, lang }] } - parts split mixed scripts (English name + Hebrew text).

function cleanText(text) {
  return (text || "")
    .replace(/https?:\/\/\S+/gi, " link ")
    .replace(/[^\S\n]+/g, " ")      // collapse spaces, keep line breaks
    .replace(/ *\n[\s]*/g, "\n")     // one break between paragraphs
    .trim();
}

function chunkParagraph(text) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let current = "";
  for (let s of sentences) {
    while (s.length > CHUNK_MAX) {
      // very long sentence: split at the last space before the limit
      let cut = s.lastIndexOf(" ", CHUNK_MAX);
      if (cut < 40) cut = CHUNK_MAX;
      if (current) { chunks.push(current); current = ""; }
      chunks.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if ((current + s).length > CHUNK_MAX) {
      if (current) chunks.push(current);
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

// Paragraphs stay separate items; long paragraphs are split at sentence ends.
function chunkText(text) {
  return text.split("\n").flatMap((p) => (p.trim() ? chunkParagraph(p.trim()) : []));
}

async function partsOf(text, ctx) {
  if (!ctx.autoLang) return [{ text, lang: null }];
  const parts = [];
  for (const run of splitByScript(text)) {
    let lang;
    if (run.script === "latin" || !run.script) lang = (await detectCld(run.text)) || ctx.latinLang;
    else if (run.script === "cjk") lang = ctx.hasKana ? "ja" : "zh";
    else lang = (await detectCld(run.text)) || run.script; // e.g. Cyrillic may be uk, Arabic may be fa
    parts.push({ text: run.text.trim(), lang });
  }
  return parts.length ? parts : [{ text, lang: null }];
}

// chunk = true: page text, split into paragraphs. chunk = false: one chat message = one item.
async function makeItems(text, autoLang, chunk) {
  text = cleanText(text);
  if (!text) return [];
  const pieces = chunk ? chunkText(text) : [text.replace(/\n+/g, " ")];
  const ctx = { autoLang, hasKana: /[぀-ヿ]/.test(text), latinLang: null };
  if (autoLang) {
    // Language for Latin-script parts, detected on all Latin text (short parts are unreliable).
    const latinText = splitByScript(text).filter((r) => r.script === "latin").map((r) => r.text).join(" ");
    ctx.latinLang = latinText ? await detectCld(latinText.slice(0, 1000)) : null;
  }
  const items = [];
  for (const p of pieces) items.push({ text: p, parts: await partsOf(p, ctx) });
  return items;
}

// ---------- output: speaks one item, calls onDone when it finished ----------

const output = {
  // Chrome: chrome.tts from here.
  async speakChrome(item, settings, onDone) {
    const voices = await getLocalVoices();
    if (!voices.length) throw new Error("No local voices installed.");
    item.parts.forEach((part, i) => {
      const { voice, missing } = resolveVoice(voices, settings.voiceName, part.lang, settings.autoLang);
      if (missing) reportMissingVoice(missing);
      const last = i === item.parts.length - 1;
      ext.tts.speak(part.text, {
        voiceName: voice.name,
        rate: settings.rate,
        volume: settings.volume,
        enqueue: i > 0, // first part interrupts anything still playing
        onEvent: (e) => {
          if (last && (e.type === "end" || e.type === "error")) onDone();
        },
      });
    });
  },

  // Firefox: the tab's top frame speaks with speechSynthesis and reports back ("ttsItemEnd").
  async speakFirefox(item, settings, token, tabId) {
    await ext.tabs.sendMessage(tabId, { type: "ttsItem", parts: item.parts, settings, token }, { frameId: 0 });
  },

  stop(tabId) {
    if (HAS_EXT_TTS) ext.tts.stop();
    else if (tabId != null) ext.tabs.sendMessage(tabId, { type: "ttsStop" }, { frameId: 0 }).catch(() => {});
  },
};

// ---------- players: one per tab, sharing one speech channel ----------
// Each tab has its own list (paragraphs or chat messages), position and status.
// The browser can only speak one thing at a time, so tabs that are playing take turns:
// one item per turn, round-robin. A user action in a tab (read, jump, resume) gives that
// tab the turn right away; an item cut off that way is read again on its tab's next turn.
// status: "idle" | "playing" (wants turns) | "paused" | "stopped" | "done" (reached the end)

const MAX_LIVE_ITEMS = 300;

const players = new Map();               // tabId -> { tabId, id, items, index, status, live }
const audio = { tabId: null, token: 0 }; // the tab whose item is being spoken now
let lastServed = null;                   // for round-robin
let listId = 0;                          // every new list gets a new id (popup re-renders)

function getPlayer(tabId) {
  let p = players.get(tabId);
  if (!p) {
    p = { tabId, id: ++listId, items: [], index: -1, status: "idle", live: false };
    players.set(tabId, p);
  }
  return p;
}

function saveState() {
  const list = [...players.values()].map(({ tabId, id, items, index, status, live }) => ({ tabId, id, items, index, status, live }));
  ext.storage.session.set({ players: list, listId }).catch(() => {});
}

// The background can be unloaded between events: restore the lists (speech itself is gone).
const restored = (async () => {
  try {
    const s = await ext.storage.session.get(["players", "listId"]);
    for (const p of s.players || []) {
      if (p.status === "playing") p.status = "paused";
      players.set(p.tabId, p);
    }
    listId = Math.max(listId, s.listId || 0);
  } catch (_) {}
})();

// Silence whatever is speaking. Its tab keeps its position, so the item is read again later.
function interrupt() {
  if (audio.tabId == null) return;
  const tabId = audio.tabId;
  audio.tabId = null;
  audio.token++;
  output.stop(tabId);
}

// Next tab that wants to speak: `prefer` first, otherwise round-robin by tab id.
function nextTab(prefer) {
  const ready = [...players.values()]
    .filter((p) => p.status === "playing" && p.items[p.index])
    .map((p) => p.tabId)
    .sort((a, b) => a - b);
  if (!ready.length) return null;
  if (prefer != null && ready.includes(prefer)) return prefer;
  return ready.find((id) => lastServed == null || id > lastServed) ?? ready[0];
}

async function schedule(prefer) {
  if (audio.tabId != null) return; // channel busy; we'll be called again when it ends
  const tabId = nextTab(prefer);
  saveState();
  if (tabId == null) return;
  const p = players.get(tabId);
  const item = p.items[p.index];
  const token = ++audio.token;
  audio.tabId = tabId;
  lastServed = tabId;
  const settings = await getSettings();
  if (token !== audio.token) return; // interrupted meanwhile
  const done = () => queued(() => onItemEnd(tabId, token));
  try {
    if (HAS_EXT_TTS) await output.speakChrome(item, settings, done);
    else await output.speakFirefox(item, settings, token, tabId);
  } catch (_) {
    if (token === audio.token) {
      audio.tabId = null;
      p.status = "stopped";
      schedule();
    }
  }
}

function onItemEnd(tabId, token) {
  if (token !== audio.token || audio.tabId !== tabId) return; // stale event
  audio.tabId = null;
  const p = players.get(tabId);
  if (p) {
    if (p.index < p.items.length - 1) p.index++;
    else p.status = "done"; // live chat: the next message continues from here
  }
  schedule();
}

// A user action in this tab: it gets the channel now.
function takeTurn(tabId) {
  interrupt();
  schedule(tabId);
}

function trimBacklog(p, backlog) {
  // waiting = items after the current one (the current one is being read or already was)
  const firstWaiting = p.index + 1;
  const waiting = p.items.length - firstWaiting;
  if (waiting > backlog) p.items.splice(firstWaiting, waiting - backlog);
}

const playerApi = {
  // interrupt = true for user actions (Read all, selection, picking a section).
  async load(tabId, items, live = false, interrupt = true) {
    if (!items.length) return { ok: false, error: "No text found." };
    const p = getPlayer(tabId);
    Object.assign(p, { id: ++listId, items, index: 0, live, status: "playing" });
    if (!HAS_EXT_TTS && tabId != null) await injectContent(tabId);
    if (interrupt) takeTurn(tabId);
    else schedule();
    return { ok: true };
  },

  // Chat messages: append; keep only the newest `backlog` messages that are still waiting.
  async addLive(tabId, items) {
    if (!items.length) return { ok: true };
    const { backlog } = await getSettings();
    const p = getPlayer(tabId);
    if (!p.live || p.status === "idle" || p.status === "stopped") {
      const r = await playerApi.load(tabId, items, true, false); // a chat message waits for its turn
      trimBacklog(p, backlog);
      return r;
    }
    p.items.push(...items);
    trimBacklog(p, backlog);
    if (p.items.length > MAX_LIVE_ITEMS) {
      const drop = p.items.length - MAX_LIVE_ITEMS;
      p.items.splice(0, drop);
      p.index = Math.max(0, p.index - drop);
    }
    if (p.status === "done") {
      p.index++;
      p.status = "playing";
    }
    schedule(); // no interrupt: chat messages wait for their turn
    return { ok: true };
  },

  jump(tabId, index) {
    const p = players.get(tabId);
    if (!p?.items.length) return;
    p.index = Math.max(0, Math.min(p.items.length - 1, index));
    p.status = "playing";
    takeTurn(tabId);
  },

  pause(tabId) {
    const p = players.get(tabId);
    if (p?.status !== "playing") return;
    p.status = "paused";
    if (audio.tabId === tabId) interrupt();
    schedule(); // other tabs keep going
  },

  resume(tabId) {
    const p = players.get(tabId);
    if (!p?.items.length) return;
    p.index = Math.min(Math.max(p.index, 0), p.items.length - 1);
    p.status = "playing";
    takeTurn(tabId); // restarts the current paragraph
  },

  stop(tabId) {
    const p = players.get(tabId);
    if (!p) return;
    if (p.items.length) p.status = "stopped";
    if (audio.tabId === tabId) interrupt();
    schedule();
  },

  remove(tabId) {
    if (audio.tabId === tabId) interrupt();
    players.delete(tabId);
    schedule();
  },

  state(tabId) {
    const p = players.get(tabId) || { id: 0, items: [], index: -1, status: "idle", live: false };
    const others = [...players.values()].filter((o) => o.tabId !== tabId && o.status === "playing").length;
    return {
      id: p.id,
      status: p.status,
      index: p.index,
      live: p.live,
      texts: p.items.map((i) => i.text),
      speakingHere: audio.tabId === tabId,
      othersPlaying: others,
    };
  },
};

// Serialize player operations so chat messages keep their order (item building is async).
let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(async () => { await restored; return fn(); });
  chain = run.catch(() => {});
  return run;
}

async function readText(text, tabId) {
  const { autoLang } = await getSettings();
  return playerApi.load(tabId, await makeItems(text, autoLang, true));
}

// ---------- page access ----------

async function injectContent(tabId) {
  try {
    await ext.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch (_) {
    // some frame refused injection; the top frame is enough to keep going
    await ext.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
  }
}

async function getSelectionText(tabId) {
  const results = await ext.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const el = document.activeElement;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && typeof el.selectionStart === "number") {
        const t = el.value.slice(el.selectionStart, el.selectionEnd);
        if (t.trim()) return t;
      }
      return String(window.getSelection() || "");
    },
  });
  const hit = results.map((r) => r.result).find((t) => t && t.trim());
  return hit || "";
}

// Runs inside the page. With skipNav, menus / navigation / link lists are left out:
// they are hidden for a moment (same task, so nothing flickers) while innerText is read.
function extractPageText(skipNav) {
  const root =
    document.querySelector("article") || document.querySelector("main, [role=main]") || document.body;
  if (!root) return "";
  if (!skipNav) return root.innerText;

  const skip = new Set(
    root.querySelectorAll(
      "nav, aside, form, button, select, [role=navigation], [role=banner], [role=contentinfo]," +
        " [role=complementary], [role=menu], [role=menubar], [role=toolbar], [role=search]," +
        " [role=tablist], [aria-hidden=true]"
    )
  );
  // Page header/footer bars - but not an article's own header (title, byline).
  for (const el of root.querySelectorAll("header, footer")) if (!el.closest("article")) skip.add(el);
  // Class / id names that mark site chrome.
  const NAMEY = /(^|[\s_-])(nav|navbar|navigation|menu|menubar|sidebar|breadcrumbs?|toolbar|tabs|cookie|share|social|jump-link|skip-link)([\s_-]|$)/i;
  for (const el of root.querySelectorAll("[class], [id]")) {
    const name = (typeof el.className === "string" ? el.className : "") + " " + el.id;
    if (NAMEY.test(name)) skip.add(el);
  }
  // Blocks that are almost only links (menus, link lists). Only letters/digits are counted,
  // so separators like "·" or "|" between links don't hide a link list.
  const letters = (s) => (s || "").replace(/[^\p{L}\p{N}]/gu, "").length;
  for (const el of root.querySelectorAll("ul, ol, table, div")) {
    if (skip.has(el)) continue;
    const total = letters(el.textContent);
    if (!total || total > 1500) continue;
    const links = el.querySelectorAll("a");
    if (links.length < 3) continue;
    let linkLen = 0;
    for (const a of links) linkLen += letters(a.textContent);
    if (linkLen / total > 0.75) skip.add(el);
  }

  // Hide with a temporary marker attribute + stylesheet (the page's own style attributes
  // are never touched), read the text, then remove both.
  const MARK = "data-local-tts-skip";
  const marked = [];
  for (const el of skip) {
    if (el === root || el.contains(root)) continue;
    el.setAttribute(MARK, "");
    marked.push(el);
  }
  const sheet = document.createElement("style");
  sheet.textContent = `[${MARK}] { display: none !important; }`;
  (document.head || document.documentElement).append(sheet);
  try {
    return root.innerText;
  } finally {
    sheet.remove();
    for (const el of marked) el.removeAttribute(MARK);
  }
}

async function getPageText(tabId) {
  const { skipNav } = await getSettings();
  const [res] = await ext.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: extractPageText,
    args: [skipNav],
  });
  return res?.result || "";
}

async function stopAll(tabId) {
  playerApi.stop(tabId);
  if (tabId != null) {
    setWatching(tabId, false);
    ext.tabs.sendMessage(tabId, { type: "stopWatch" }).catch(() => {});
    ext.tabs.sendMessage(tabId, { type: "cancelPick" }).catch(() => {});
  }
}

// ---------- watched sections (per tab, kept in storage.session) ----------

async function setWatching(tabId, on) {
  const { watchingTabs = [] } = await ext.storage.session.get("watchingTabs");
  const next = watchingTabs.filter((id) => id !== tabId);
  if (on) next.push(tabId);
  await ext.storage.session.set({ watchingTabs: next });
}

async function isWatching(tabId) {
  const { watchingTabs = [] } = await ext.storage.session.get("watchingTabs");
  return watchingTabs.includes(tabId);
}

ext.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading") return;
  setWatching(tabId, false).catch(() => {}); // a reload or navigation removes the watched element
  // Firefox speaks inside the page, so leaving the page ends that tab's reading.
  if (!HAS_EXT_TTS && players.get(tabId)?.status === "playing") queued(() => playerApi.stop(tabId));
});
ext.tabs.onRemoved.addListener((tabId) => {
  setWatching(tabId, false).catch(() => {});
  queued(() => playerApi.remove(tabId));
});

async function activeTabId() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// ---------- messages ----------

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "readSelection": {
          const text = await getSelectionText(msg.tabId);
          if (!text.trim()) return sendResponse({ ok: false, empty: true });
          return sendResponse(await queued(() => readText(text, msg.tabId)));
        }
        case "readAll": {
          const text = await getPageText(msg.tabId);
          return sendResponse(await queued(() => readText(text, msg.tabId)));
        }
        case "startPick":
          await queued(() => playerApi.stop(msg.tabId));
          await setWatching(msg.tabId, false); // starting a new pick stops the old watch
          await injectContent(msg.tabId);
          await ext.tabs.sendMessage(msg.tabId, { type: "startPick", liveOnlyNew: msg.liveOnlyNew });
          return sendResponse({ ok: true });
        case "picked":
          await setWatching(sender.tab.id, true);
          // a frame picked an element: cancel the picker in all other frames
          ext.tabs.sendMessage(sender.tab.id, { type: "cancelPick" }).catch(() => {});
          return sendResponse({ ok: true });
        case "speak": { // from content script: the picked section
          const tabId = sender.tab?.id;
          const { autoLang } = await getSettings();
          return sendResponse(await queued(async () => {
            if (msg.mode === "replace") {
              // whole section once, then new messages are appended (live list)
              return playerApi.load(tabId, await makeItems(msg.texts.join("\n"), autoLang, true), true);
            }
            const items = [];
            for (const t of msg.texts) items.push(...(await makeItems(t, autoLang, false)));
            return playerApi.addLive(tabId, items);
          }));
        }
        case "ttsItemEnd": // Firefox: the page finished speaking an item
          await queued(() => onItemEnd(sender.tab?.id, msg.token));
          return sendResponse({ ok: true });
        case "getState":
          await restored;
          return sendResponse({
            ok: true,
            ...playerApi.state(msg.tabId),
            watching: msg.tabId != null && (await isWatching(msg.tabId)),
          });
        case "pause":
          await queued(() => playerApi.pause(msg.tabId));
          return sendResponse({ ok: true });
        case "resume":
          await queued(() => playerApi.resume(msg.tabId));
          return sendResponse({ ok: true });
        case "jump":
          await queued(() => playerApi.jump(msg.tabId, msg.index));
          return sendResponse({ ok: true });
        case "stop":
          await queued(() => stopAll(msg.tabId));
          return sendResponse({ ok: true });
        case "pickFrame": // a frame started highlighting: tell the others to hide their picker UI
          ext.tabs.sendMessage(sender.tab.id, { type: "pickFrame", token: msg.token }).catch(() => {});
          return sendResponse({ ok: true });
        case "pickKey": // arrow/Enter/Escape pressed in a frame that doesn't hold the highlight
          ext.tabs.sendMessage(sender.tab.id, { type: "pickKey", key: msg.key }).catch(() => {});
          return sendResponse({ ok: true });
        case "missingVoice": // from the Firefox speech engine in content.js
          reportMissingVoice(msg.lang);
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // async response
});

// ---------- context menu & shortcuts (desktop only: Firefox for Android has neither) ----------

if (ext.contextMenus) {
  ext.runtime.onInstalled.addListener(() => {
    ext.contextMenus.create({ id: "read-selection", title: "Read selected text aloud", contexts: ["selection"] });
  });
  ext.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "read-selection") queued(() => readText(info.selectionText, tab?.id)).catch(() => {});
  });
}

ext.commands?.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (command === "stop-reading") return queued(() => stopAll(tabId));
  if (command === "read-selection" && tabId != null) {
    try {
      const text = await getSelectionText(tabId);
      if (text.trim()) await queued(() => readText(text, tabId));
    } catch (_) { /* restricted page */ }
  }
});
