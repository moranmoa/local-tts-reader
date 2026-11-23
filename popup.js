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
    return;
  }
  for (const v of local) sel.append(new Option(`${v.name} (${v.lang || "?"})`, v.name));
  sel.value = local.some((v) => v.name === s.voiceName) ? s.voiceName : local[0].name;
}

$("voice").addEventListener("change", (e) => ext.storage.sync.set({ voiceName: e.target.value }));
$("liveOnlyNew").addEventListener("change", (e) => ext.storage.sync.set({ liveOnlyNew: e.target.checked }));
$("autoLang").addEventListener("change", (e) => ext.storage.sync.set({ autoLang: e.target.checked }));

// ---------- buttons ----------

$("readAll").addEventListener("click", async () => {
  setStatus("Reading page…");
  const res = await send({ type: "readAll", tabId: await getTabId() });
  if (!res?.ok) setStatus(restrictedMessage(res?.error), true);
});

$("readSection").addEventListener("click", async () => {
  const res = await send({ type: "startPick", tabId: await getTabId(), liveOnlyNew: $("liveOnlyNew").checked });
  if (!res?.ok) return setStatus(restrictedMessage(res?.error), true);
  window.close(); // let the user pick an element on the page
});

$("stop").addEventListener("click", async () => {
  await send({ type: "stop", tabId: await getTabId() });
  setStatus("Stopped.");
});

// ---------- missing voice hint ----------

const IS_ANDROID = /Android/i.test(navigator.userAgent);

function showVoiceWarning(missing) {
  const el = $("voiceWarning");
  if (!missing || Date.now() - missing.at > 30 * 60 * 1000) { el.hidden = true; return; }
  let name = missing.lang;
  try { name = new Intl.DisplayNames(["en"], { type: "language" }).of(missing.lang) || name; } catch (_) {}
  el.textContent = IS_ANDROID
    ? `No installed voice for ${name}. Add one in Android Settings → Text-to-speech, then restart Firefox.`
    : `No installed voice for ${name}. Add one in Windows Settings → Time & language → Speech → Add voices, then restart the browser.`;
  el.hidden = false;
}

ext.storage.local.get({ missingVoice: null }).then((s) => showVoiceWarning(s.missingVoice));
ext.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.missingVoice) showVoiceWarning(changes.missingVoice.newValue);
});

// On open: if text is selected on the page, read it right away.
(async () => {
  loadSettings(); // don't wait for the voice list before reading the selection
  const res = await send({ type: "readSelection", tabId: await getTabId() });
  if (res?.ok) setStatus("Reading selected text…");
  else if (res?.empty) setStatus("No text selected.");
  else setStatus(restrictedMessage(res?.error), true);
})();
