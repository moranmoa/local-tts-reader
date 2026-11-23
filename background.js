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

const DEFAULTS = { voiceName: "", rate: 1, volume: 1, liveOnlyNew: true, backlog: 5, autoLang: true };
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

// ---------- player ----------
// status: "idle" (nothing loaded) | "playing" | "paused" | "stopped" | "done" (reached the end)

const MAX_LIVE_ITEMS = 300;

const player = {
  id: 0,          // changes whenever a new list is loaded (popup re-renders the list)
  items: [],
  index: -1,
  status: "idle",
  live: false,    // chat section: new messages are appended
  tabId: null,
  token: 0,       // bumped on every start/stop so late "ended" events are ignored
};

function saveState() {
  const { id, items, index, status, live, tabId } = player;
  ext.storage.session.set({ player: { id, items, index, status, live, tabId } }).catch(() => {});
}

// The background can be unloaded between events: restore the list (speech itself is gone).
const restored = (async () => {
  try {
    const { player: saved } = await ext.storage.session.get("player");
    if (saved) {
      Object.assign(player, saved);
      if (player.status === "playing") player.status = "paused";
    }
  } catch (_) {}
})();

async function playCurrent() {
  const item = player.items[player.index];
  if (!item) return;
  const token = ++player.token;
  player.status = "playing";
  saveState();
  const settings = await getSettings();
  if (token !== player.token) return; // something else happened meanwhile
  const done = () => { if (token === player.token) onItemEnd(); };
  try {
    if (HAS_EXT_TTS) await output.speakChrome(item, settings, done);
    else await output.speakFirefox(item, settings, token, player.tabId);
  } catch (_) {
    if (token === player.token) { player.status = "stopped"; saveState(); }
  }
}

function onItemEnd() {
  if (player.index < player.items.length - 1) {
    player.index++;
    playCurrent();
  } else {
    player.status = "done"; // live chat: the next message will continue from here
    player.token++;
    saveState();
  }
}

function silence() {
  player.token++;
  output.stop(player.tabId);
}

const playerApi = {
  async load(items, tabId, live = false) {
    if (!items.length) return { ok: false, error: "No text found." };
    silence();
    player.id++;
    player.items = items;
    player.index = 0;
    player.live = live;
    player.tabId = tabId;
    if (!HAS_EXT_TTS && tabId != null) await injectContent(tabId);
    playCurrent();
    return { ok: true };
  },

  // Chat messages: append; keep only the newest `backlog` messages that are still waiting.
  async addLive(items, tabId) {
    if (!items.length) return { ok: true };
    const { backlog } = await getSettings();
    if (!player.live || player.tabId !== tabId || player.status === "idle" || player.status === "stopped") {
      const r = await playerApi.load(items, tabId, true);
      trimBacklog(backlog);
      return r;
    }
    player.items.push(...items);
    trimBacklog(backlog);
    if (player.items.length > MAX_LIVE_ITEMS) {
      const drop = player.items.length - MAX_LIVE_ITEMS;
      player.items.splice(0, drop);
      player.index = Math.max(0, player.index - drop);
    }
    if (player.status === "done") {
      player.index++;
      playCurrent();
    } else {
      saveState();
    }
    return { ok: true };
  },

  jump(index) {
    if (!player.items.length) return;
    player.index = Math.max(0, Math.min(player.items.length - 1, index));
    silence();
    playCurrent();
  },

  pause() {
    if (player.status !== "playing") return;
    silence();
    player.status = "paused";
    saveState();
  },

  resume() {
    if (!player.items.length) return;
    if (player.status === "done") player.index = Math.min(player.index, player.items.length - 1);
    silence();
    playCurrent(); // restarts the current paragraph
  },

  stop() {
    silence();
    if (player.items.length) player.status = "stopped";
    saveState();
  },

  state() {
    return {
      id: player.id,
      status: player.status,
      index: player.index,
      live: player.live,
      texts: player.items.map((i) => i.text),
    };
  },
};

function trimBacklog(backlog) {
  // waiting = items after the one being read (when done, the current one was already read)
  const firstWaiting = player.index + 1;
  const waiting = player.items.length - firstWaiting;
  if (waiting > backlog) player.items.splice(firstWaiting, waiting - backlog);
}

// Serialize player operations so chat messages keep their order (item building is async).
let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(async () => { await restored; return fn(); });
  chain = run.catch(() => {});
  return run;
}

async function readText(text, tabId) {
  const { autoLang } = await getSettings();
  return playerApi.load(await makeItems(text, autoLang, true), tabId);
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

async function getPageText(tabId) {
  const [res] = await ext.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      const root = document.querySelector("article") || document.querySelector("main") || document.body;
      return root ? root.innerText : "";
    },
  });
  return res?.result || "";
}

async function stopAll(tabId) {
  playerApi.stop();
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
  // Firefox speaks inside the page, so leaving the page ends the speech.
  if (!HAS_EXT_TTS && tabId === player.tabId && player.status === "playing") {
    queued(() => { player.token++; player.status = "stopped"; saveState(); });
  }
});
ext.tabs.onRemoved.addListener((tabId) => setWatching(tabId, false).catch(() => {}));

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
          await queued(() => playerApi.stop());
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
              return playerApi.load(await makeItems(msg.texts.join("\n"), autoLang, true), tabId, true);
            }
            const items = [];
            for (const t of msg.texts) items.push(...(await makeItems(t, autoLang, false)));
            return playerApi.addLive(items, tabId);
          }));
        }
        case "ttsItemEnd": // Firefox: the page finished speaking an item
          await queued(() => { if (msg.token === player.token) onItemEnd(); });
          return sendResponse({ ok: true });
        case "getState":
          await restored;
          return sendResponse({
            ok: true,
            ...playerApi.state(),
            watching: msg.tabId != null && (await isWatching(msg.tabId)),
          });
        case "pause":
          await queued(() => playerApi.pause());
          return sendResponse({ ok: true });
        case "resume":
          await queued(() => playerApi.resume());
          return sendResponse({ ok: true });
        case "jump":
          await queued(() => playerApi.jump(msg.index));
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
