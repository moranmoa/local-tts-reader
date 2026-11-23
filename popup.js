const ext = globalThis.browser || globalThis.chrome;
const DEFAULTS = { voiceName: "", rate: 1, volume: 1, liveOnlyNew: true, backlog: 5, autoLang: true };
const $ = (id) => document.getElementById(id);

// Local voices as [{ name, lang }]. Chrome: chrome.tts. Firefox: speechSynthesis.
function getLocalVoices() {
  if (ext.tts && ext.tts.getVoices) {
    return new Promise((resolve) =>
      ext.tts.getVoices((v) =>
        resolve((v || []).filter((x) => !x.remote).map((x) => ({ name: x.voiceName, lang: x.lang })))
      )
    );
  }
  return new Promise((resolve) => {
    const done = () =>
      resolve(speechSynthesis.getVoices().filter((v) => v.localService).map((v) => ({ name: v.name, lang: v.lang })));
    if (speechSynthesis.getVoices().length) return done();
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function getTabId() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

const send = (msg) => ext.runtime.sendMessage(msg);

function restrictedMessage(err) {
  return /cannot be scripted|chrome:\/\/|about:|Cannot access|extensions gallery|Missing host permission/i.test(err || "")
    ? "This page can't be read (browser-protected page)."
    : err || "Something went wrong.";
}

// ---------- sliders ----------

const SLIDERS = {
  rate: { key: "rate", toUi: (v) => v, fromUi: (v) => Number(v), label: (v) => Number(v).toFixed(1) + "×" },
  volume: { key: "volume", toUi: (v) => Math.round(v * 100), fromUi: (v) => Number(v) / 100, label: (v) => v + "%" },
  backlog: { key: "backlog", toUi: (v) => v, fromUi: (v) => Number(v), label: (v) => String(v) },
};

for (const [id, s] of Object.entries(SLIDERS)) {
  $(id).addEventListener("input", (e) => {
    $(id + "Value").textContent = s.label(e.target.value);
    ext.storage.sync.set({ [s.key]: s.fromUi(e.target.value) });
  });
}

// ---------- settings ----------

async function loadSettings() {
  const s = await ext.storage.sync.get(DEFAULTS);
  $("liveOnlyNew").checked = s.liveOnlyNew;
  $("autoLang").checked = s.autoLang;
  for (const [id, cfg] of Object.entries(SLIDERS)) {
    const v = cfg.toUi(s[cfg.key]);
    $(id).value = v;
    $(id + "Value").textContent = cfg.label(v);
  }

  const local = await getLocalVoices();
  local.sort((a, b) => {
    const ae = (a.lang || "").startsWith("en") ? 0 : 1;
    const be = (b.lang || "").startsWith("en") ? 0 : 1;
    return ae - be || a.name.localeCompare(b.name);
  });
  const sel = $("voice");
  sel.replaceChildren();
  if (!local.length) {
    sel.append(new Option("No local voices found", ""));
    sel.disabled = true;
    warn.noVoices = true; // show the ⚠ button with install help
    updateWarning();
    return;
  }
  for (const v of local) sel.append(new Option(`${v.name} (${v.lang || "?"})`, v.name));
  sel.value = local.some((v) => v.name === s.voiceName) ? s.voiceName : local[0].name;
}

$("voice").addEventListener("change", (e) => ext.storage.sync.set({ voiceName: e.target.value }));
$("liveOnlyNew").addEventListener("change", (e) => ext.storage.sync.set({ liveOnlyNew: e.target.checked }));
$("autoLang").addEventListener("change", (e) => ext.storage.sync.set({ autoLang: e.target.checked }));

// ---------- views: main / settings (gear) ----------

function showSettings(open) {
  $("mainView").hidden = open;
  $("settingsView").hidden = !open;
  $("gear").classList.toggle("primary", open);
}
$("gear").addEventListener("click", () => showSettings($("mainView").hidden === false));
$("back").addEventListener("click", () => showSettings(false));

// ---------- buttons ----------

let errorUntil = 0; // keep an error message visible for a moment before state updates replace it
function showError(text) {
  setStatus(text, true);
  errorUntil = Date.now() + 4000;
}

$("readAll").addEventListener("click", async () => {
  setStatus("Reading page…");
  const res = await send({ type: "readAll", tabId: await getTabId() });
  if (!res?.ok) showError(restrictedMessage(res?.error));
  refreshState();
});

$("readSection").addEventListener("click", async () => {
  const res = await send({ type: "startPick", tabId: await getTabId(), liveOnlyNew: $("liveOnlyNew").checked });
  if (!res?.ok) return showError(restrictedMessage(res?.error));
  window.close(); // let the user pick an element on the page
});

$("stop").addEventListener("click", async () => {
  await send({ type: "stop", tabId: await getTabId() });
  refreshState();
});

$("pause").addEventListener("click", async () => {
  await send({ type: state.status === "playing" ? "pause" : "resume", tabId: await getTabId() });
  refreshState();
});

$("prev").addEventListener("click", () => jump(state.index - 1));
$("next").addEventListener("click", () => jump(state.index + 1));

async function jump(index) {
  if (index < 0 || index >= state.texts.length) return;
  await send({ type: "jump", index, tabId: await getTabId() });
  refreshState();
}

// ---------- voice warnings (⚠ button; the message opens only on click) ----------
// Two cases: no local voices at all, or a detected language without an installed voice.
// The help text depends on the operating system (and, on Linux, on the browser).

const IS_CHROME = !!(ext.tts && ext.tts.getVoices);
let platform = /Android/i.test(navigator.userAgent) ? "android" : "win";
const warn = { noVoices: false, missing: null };

function voiceHelp() {
  switch (platform) {
    case "android":
      return "Add one in Android Settings → Text-to-speech (install the language in your TTS engine), then restart Firefox.";
    case "mac":
      return "Add one in System Settings → Accessibility → Spoken Content → System voice → Manage Voices, then restart the browser.";
    case "cros":
      return "Add one in ChromeOS Settings → Accessibility → Text-to-speech → Speech engine / voices.";
    case "linux":
      return [
        "Linux voices come from speech-dispatcher. Install it with a voice engine, e.g.:",
        "sudo apt install speech-dispatcher espeak-ng",
        "For more natural voices add RHVoice or Piper, then restart the browser.",
        IS_CHROME ? "Chrome on Linux: start it with --enable-speech-dispatcher, otherwise it shows no local voices." : "",
      ].filter(Boolean).join("\n");
    default:
      return "Add one in Windows Settings → Time & language → Speech → Add voices, then restart the browser.";
  }
}

function updateWarning() {
  const el = $("voiceWarning");
  const btn = $("warnBtn");
  const missing = warn.missing && Date.now() - warn.missing.at < 30 * 60 * 1000 ? warn.missing : null;

  let title = "";
  if (warn.noVoices) {
    title = "No local voices found";
  } else if (missing) {
    let name = missing.lang;
    try { name = new Intl.DisplayNames(["en"], { type: "language" }).of(missing.lang) || name; } catch (_) {}
    title = `No installed voice for ${name}`;
  }

  if (!title) {
    btn.hidden = true;
    el.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  el.textContent = `${title}.\n${voiceHelp()}`;
  btn.title = `${title} – click for details`;
  btn.hidden = false;
}

$("warnBtn").addEventListener("click", () => {
  const el = $("voiceWarning");
  el.hidden = !el.hidden;
  $("warnBtn").setAttribute("aria-expanded", String(!el.hidden));
});

(ext.runtime.getPlatformInfo?.() || Promise.resolve(null))
  .then((info) => { if (info?.os) platform = info.os; updateWarning(); })
  .catch(() => {});

ext.storage.local.get({ missingVoice: null }).then((s) => { warn.missing = s.missingVoice; updateWarning(); });
ext.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.missingVoice) { warn.missing = changes.missingVoice.newValue; updateWarning(); }
});

// ---------- player state -> UI ----------

let state = { id: -1, status: "idle", index: -1, texts: [], watching: false, live: false };
let rendered = { id: -1, length: -1, index: -2 };

function renderList() {
  const list = $("nowList");
  if (!state.texts.length) {
    const empty = document.createElement("div");
    empty.className = "now-empty";
    empty.textContent = "Nothing is being read. Click a paragraph here to jump to it.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...state.texts.map((text, i) => {
      const div = document.createElement("div");
      div.className = "now-item";
      div.setAttribute("role", "listitem");
      div.textContent = text;
      div.title = "Read from here";
      div.addEventListener("click", () => jump(i));
      return div;
    })
  );
}

function markCurrent() {
  const items = $("nowList").querySelectorAll(".now-item");
  items.forEach((el, i) => {
    el.classList.toggle("current", i === state.index);
    el.classList.toggle("played", i < state.index);
  });
  items[state.index]?.scrollIntoView({ block: "nearest" });
}

function statusText() {
  const n = state.texts.length;
  const where = state.live ? "chat" : `paragraph ${state.index + 1} of ${n}`;
  switch (state.status) {
    case "playing":
      if (!state.speakingHere && state.othersPlaying) return "Waiting for its turn (another tab is reading)…";
      return state.live ? "Reading chat…" : `Reading ${where}…`;
    case "paused": return `Paused (${where}).`;
    case "stopped": return "Stopped. Click a paragraph or Resume to continue.";
    case "done": return state.watching ? "Waiting for new chat messages…" : "Finished.";
    default: return state.watching ? "Waiting for new chat messages…" : "";
  }
}

function render() {
  const active = state.status === "playing" || state.status === "paused" || state.watching;
  // While something is going on, Stop is the main (pink) button.
  $("stop").classList.toggle("primary", active);
  $("readAll").classList.toggle("primary", !active);

  const pause = $("pause");
  pause.disabled = !state.texts.length;
  pause.textContent = state.status === "playing" ? "⏸ Pause" : "▶ Resume";
  if (!state.texts.length) pause.textContent = "⏸ Pause";

  $("prev").disabled = state.index <= 0;
  $("next").disabled = state.index < 0 || state.index >= state.texts.length - 1;
  $("position").textContent = state.texts.length ? `${state.index + 1} / ${state.texts.length}` : "";

  if (state.id !== rendered.id || state.texts.length !== rendered.length) {
    renderList();
    rendered.id = state.id;
    rendered.length = state.texts.length;
    rendered.index = -2;
  }
  if (state.index !== rendered.index) {
    markCurrent();
    rendered.index = state.index;
  }

  const text = statusText();
  if (Date.now() > errorUntil && text) setStatus(text);
}

async function refreshState() {
  try {
    const s = await send({ type: "getState", tabId: await getTabId() });
    if (s?.ok) { state = s; render(); }
  } catch (_) { /* background busy; try again next tick */ }
}

// On open: if text is selected on the page, read it right away - unless something is
// already playing or paused (the popup is then opened to control it, not to start over).
(async () => {
  loadSettings(); // don't wait for the voice list before reading the selection
  await refreshState();
  setInterval(refreshState, 500);
  if (state.status === "playing" || state.status === "paused") return;
  const res = await send({ type: "readSelection", tabId: await getTabId() });
  if (res?.ok) setStatus("Reading selected text…");
  else if (res?.empty) { if (state.status === "idle") setStatus("No text selected."); }
  else showError(restrictedMessage(res?.error));
  refreshState();
})();
