// Local TTS Reader - background script (service worker in Chrome, event page in Firefox).
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

// ---------- text helpers ----------

function cleanText(text) {
  return (text || "")
    .replace(/https?:\/\/\S+/gi, " link ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkText(text) {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
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

// text -> [{ text, lang }]
async function prepare(text, autoLang) {
  const chunks = chunkText(text);
  if (!autoLang) return chunks.map((t) => ({ text: t, lang: null }));
  // Language for Latin-script parts: detect on all Latin text of the message (short parts are unreliable).
  const latinText = splitByScript(text).filter((r) => r.script === "latin").map((r) => r.text).join(" ");
  const latinLang = latinText ? await detectCld(latinText.slice(0, 1000)) : null;
  const hasKana = /[぀-ヿ]/.test(text);

  const items = [];
  for (const chunk of chunks) {
    for (const run of splitByScript(chunk)) {
      let lang;
      if (run.script === "latin" || !run.script) lang = (await detectCld(run.text)) || latinLang;
      else if (run.script === "cjk") lang = hasKana ? "ja" : "zh";
      else lang = (await detectCld(run.text)) || run.script; // e.g. Cyrillic may be uk, Arabic may be fa
      items.push({ text: run.text.trim(), lang });
    }
  }
  return items;
}

// ---------- speech (Chrome) ----------

const engine = {
  pending: 0,      // chunks queued in chrome.tts or speaking
  generation: 0,   // bumped on stop so late events from old speech are ignored
  liveQueue: [],   // waiting chat messages (only the newest `backlog` are kept)
};

function engineStop() {
  engine.generation++;
  engine.liveQueue = [];
  engine.pending = 0;
  ext.tts.stop();
}

async function engineSpeak(items, settings) {
  const voices = await getLocalVoices();
  if (!voices.length) throw new Error("No local voices installed.");
  const gen = engine.generation;
  for (const { text, lang } of items) {
    const { voice, missing } = resolveVoice(voices, settings.voiceName, lang, settings.autoLang);
    if (missing) reportMissingVoice(missing);
    engine.pending++;
    ext.tts.speak(text, {
      voiceName: voice.name,
      rate: settings.rate,
      volume: settings.volume,
      enqueue: true,
      onEvent: (e) => {
        if (gen !== engine.generation) return;
        if (!["end", "interrupted", "cancelled", "error"].includes(e.type)) return;
        engine.pending = Math.max(0, engine.pending - 1);
        if (engine.pending === 0) playNextLive();
      },
    });
  }
}

function playNextLive() {
  const next = engine.liveQueue.shift();
  if (next) engineSpeak(next.items, next.settings).catch(() => {});
}

// ---------- speak API ----------

/**
 * @param {string[]} texts
 * @param {"replace"|"queue"|"live"} mode
 *   replace - stop whatever is playing and read this
 *   queue   - add after current speech
 *   live    - chat mode: messages wait in a backlog that keeps only the newest N
 *             (N = settings.backlog); older waiting ones are dropped
 * @param {number} tabId - tab the text came from (Firefox speaks inside that tab)
 */
async function speakNow(texts, mode, tabId) {
  texts = texts.map(cleanText).filter(Boolean);
  if (!texts.length) return { ok: false, error: "No text found." };

  const settings = await getSettings();
  const prepared = [];
  for (const t of texts) prepared.push(await prepare(t, settings.autoLang)); // one entry per message

  if (!HAS_EXT_TTS) return speakInTab(tabId, prepared, mode, settings);

  if (mode === "replace") engineStop();
  if (mode === "live") {
    for (const items of prepared) engine.liveQueue.push({ items, settings });
    engine.liveQueue = engine.liveQueue.slice(-settings.backlog);
    if (engine.pending === 0) playNextLive();
  } else {
    await engineSpeak(prepared.flat(), settings);
  }
  return { ok: true };
}

// Serialize calls so chat messages keep their order even though detection is async.
let chain = Promise.resolve();
function speak(texts, mode, tabId) {
  const run = chain.then(() => speakNow(texts, mode, tabId));
  chain = run.catch(() => {});
  return run;
}

// Firefox: the top frame of the tab speaks with window.speechSynthesis.
async function speakInTab(tabId, messages, mode, settings) {
  if (tabId == null) return { ok: false, error: "No tab to read in." };
  await injectContent(tabId);
  await ext.tabs.sendMessage(tabId, { type: "ttsSpeak", messages, mode, settings }, { frameId: 0 });
  return { ok: true };
}

function stopSpeech(tabId) {
  if (HAS_EXT_TTS) engineStop();
  else if (tabId != null) ext.tabs.sendMessage(tabId, { type: "ttsStop" }, { frameId: 0 }).catch(() => {});
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
  stopSpeech(tabId);
  if (tabId != null) {
    setWatching(tabId, false);
    ext.tabs.sendMessage(tabId, { type: "stopWatch" }).catch(() => {});
    ext.tabs.sendMessage(tabId, { type: "cancelPick" }).catch(() => {});
  }
}

// ---------- state for the popup (is something being read / watched?) ----------
// Kept in storage.session so it survives the background being unloaded.

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

async function isSpeaking(tabId) {
  if (HAS_EXT_TTS) return engine.pending > 0 || (await ext.tts.isSpeaking());
  if (tabId == null) return false;
  try {
    return !!(await ext.tabs.sendMessage(tabId, { type: "ttsState" }, { frameId: 0 }));
  } catch (_) {
    return false; // no content script in the tab
  }
}

// A reload or navigation removes the watched element.
ext.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") setWatching(tabId, false).catch(() => {});
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
          return sendResponse(await speak([text], "replace", msg.tabId));
        }
        case "readAll":
          return sendResponse(await speak([await getPageText(msg.tabId)], "replace", msg.tabId));
        case "startPick":
          stopSpeech(msg.tabId);
          await setWatching(msg.tabId, false); // starting a new pick stops the old watch
          await injectContent(msg.tabId);
          await ext.tabs.sendMessage(msg.tabId, { type: "startPick", liveOnlyNew: msg.liveOnlyNew });
          return sendResponse({ ok: true });
        case "getState":
          return sendResponse({
            ok: true,
            speaking: await isSpeaking(msg.tabId),
            watching: msg.tabId != null && (await isWatching(msg.tabId)),
          });
        case "picked":
          await setWatching(sender.tab.id, true);
          // a frame picked an element: cancel the picker in all other frames
          ext.tabs.sendMessage(sender.tab.id, { type: "cancelPick" }).catch(() => {});
          return sendResponse({ ok: true });
        case "speak": // from content script (section reading)
          return sendResponse(await speak(msg.texts, msg.mode || "queue", sender.tab?.id));
        case "stop":
          await stopAll(msg.tabId);
          return sendResponse({ ok: true });
        case "pickFrame": // a frame started highlighting: tell the others to hide their picker UI
          ext.tabs.sendMessage(sender.tab.id, { type: "pickFrame", token: msg.token }).catch(() => {});
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
    if (info.menuItemId === "read-selection") speak([info.selectionText], "replace", tab?.id).catch(() => {});
  });
}

ext.commands?.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (command === "stop-reading") return stopAll(tabId);
  if (command === "read-selection" && tabId != null) {
    try {
      const text = await getSelectionText(tabId);
      if (text.trim()) await speak([text], "replace", tabId);
    } catch (_) { /* restricted page */ }
  }
});
