// Local TTS Reader - content script (injected on demand into all frames).
// Handles the "Read section" element picker and live watching of the picked element.

(() => {
  if (window.__localTtsReaderLoaded) return;
  window.__localTtsReaderLoaded = true;

  const ext = globalThis.browser || globalThis.chrome;
  const ACCENT = "#e91e63";
  let picker = null;
  let watcher = null;

  const send = (msg) => ext.runtime.sendMessage(msg).catch(() => {});
  const textOf = (node) =>
    (node.nodeType === Node.TEXT_NODE ? node.textContent : node.innerText || node.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

  // ---------------- picker ----------------
  // Desktop: hover highlights, click reads, ↑/↓ parent/child, Esc cancels.
  // Touch (Firefox for Android): tap highlights, then use the toolbar buttons.
  // With several frames (e.g. YouTube chat iframe) only the frame in use shows its UI.

  const frameToken = Math.random().toString(36).slice(2);

  function startPick(liveOnlyNew) {
    cancelPick();

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", zIndex: "2147483647", pointerEvents: "none",
      border: `2px solid ${ACCENT}`, background: "rgba(233,30,99,0.12)",
      borderRadius: "3px", display: "none", boxSizing: "border-box",
    });
    const label = document.createElement("div");
    Object.assign(label.style, {
      position: "fixed", zIndex: "2147483647", pointerEvents: "none",
      background: ACCENT, color: "#fff", font: "12px/1.4 system-ui, sans-serif",
      padding: "3px 6px", borderRadius: "3px", maxWidth: "90vw",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "none",
    });

    // Toolbar lives in a shadow root so page CSS can't restyle it.
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "fixed", zIndex: "2147483647", left: "0", right: "0", bottom: "16px",
      display: "none", pointerEvents: "none", // only the bar inside takes clicks
    });
    const shadow = bar.attachShadow({ mode: "closed" });
    // Built with DOM APIs, no HTML strings.
    const style = document.createElement("style");
    style.textContent = `
      :host { display: flex; justify-content: center; }
      .bar { pointer-events: auto; display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; padding: 8px;
             background: #202124; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.35);
             font: 14px/1.2 system-ui, sans-serif; max-width: 92vw; }
      button { all: unset; cursor: pointer; padding: 10px 12px; border-radius: 6px;
               background: #3c3d41; color: #fff; white-space: nowrap; }
      button.read { background: ${ACCENT}; }
      button:disabled { opacity: .4; cursor: default; }`;
    const barInner = document.createElement("div");
    barInner.className = "bar";
    for (const [act, text] of [["parent", "▲ Parent"], ["child", "▼ Child"], ["read", "✓ Read this"], ["cancel", "✕ Cancel"]]) {
      const b = document.createElement("button");
      b.dataset.act = act;
      b.textContent = text;
      if (act === "read") b.className = "read";
      barInner.append(b);
    }
    shadow.append(style, barInner);
    document.documentElement.append(box, label, bar);

    const state = { box, label, bar, current: null, history: [], liveOnlyNew, touch: false };
    const childBtn = shadow.querySelector('[data-act="child"]');

    const describe = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += "#" + el.id;
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      if (cls) s += "." + cls;
      return s;
    };

    const hideUi = () => {
      state.current = null;
      box.style.display = label.style.display = bar.style.display = "none";
    };

    const highlight = (el) => {
      if (!el) return hideUi();
      if (!state.current) send({ type: "pickFrame", token: frameToken }); // this frame is now in use
      state.current = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      label.textContent = state.touch
        ? `${describe(el)}  —  use the buttons below`
        : `${describe(el)}  —  ↑ bigger area · ↓ smaller · click: read · Esc: cancel`;
      label.style.display = "block";
      label.style.left = Math.max(0, r.left) + "px";
      label.style.top = (r.top > 24 ? r.top - 22 : Math.min(r.bottom + 2, innerHeight - 22)) + "px";
      // Toolbar only for touch: with a mouse, moving to the toolbar would re-highlight the page.
      bar.style.display = state.touch ? "flex" : "none";
      childBtn.disabled = !state.history.length;
    };

    const toParent = () => {
      const p = state.current?.parentElement;
      if (p && state.current !== document.body && p !== document.documentElement) {
        state.history.push(state.current);
        highlight(p);
      }
    };
    const toChild = () => { if (state.history.length) highlight(state.history.pop()); };

    shadow.addEventListener("click", (e) => {
      const act = e.target.closest?.("button")?.dataset.act;
      if (act === "parent") toParent();
      else if (act === "child") toChild();
      else if (act === "read" && state.current) choose(state.current);
      else if (act === "cancel") cancelPick();
    });

    const ours = (e) => e.target === bar || e.target === box || e.target === label;
    const block = (e) => {
      if (ours(e)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    };

    const onMove = (e) => {
      if (state.touch || ours(e) || !(e.target instanceof Element)) return;
      if (e.target !== state.current) { state.history = []; highlight(e.target); }
    };
    const onPointerDown = (e) => {
      if (ours(e)) return;
      block(e);
      state.touch = e.pointerType === "touch" || e.pointerType === "pen";
      if (state.touch && e.target instanceof Element) { state.history = []; highlight(e.target); }
    };
    const onClick = (e) => {
      if (ours(e)) return;
      block(e);
      if (!state.touch && state.current) choose(state.current); // touch: tap only highlights
    };
    const onTouchStart = (e) => { if (!ours(e)) e.stopPropagation(); }; // keep page scrolling
    const onKey = (e) => {
      if (e.key === "Escape") { block(e); cancelPick(); }
      else if (e.key === "ArrowUp" && state.current) { block(e); toParent(); }
      else if (e.key === "ArrowDown" && state.history.length) { block(e); toChild(); }
      else if (e.key === "Enter" && state.current) { block(e); choose(state.current); }
    };
    const onScroll = () => state.current && highlight(state.current);

    state.listeners = [
      ["mousemove", onMove], ["pointerdown", onPointerDown], ["click", onClick], ["keydown", onKey],
      ["mousedown", block], ["mouseup", block], ["pointerup", block],
      ["touchstart", onTouchStart], ["touchend", block],
      ["scroll", onScroll],
    ];
    for (const [t, fn] of state.listeners) window.addEventListener(t, fn, { capture: true, passive: false });
    state.hideUi = hideUi;
    picker = state;
  }

  function cancelPick() {
    if (!picker) return;
    for (const [t, fn] of picker.listeners) window.removeEventListener(t, fn, { capture: true });
    picker.box.remove();
    picker.label.remove();
    picker.bar.remove();
    picker = null;
  }

  // Another frame started being used: hide this frame's highlight and toolbar.
  function onPickFrame(token) {
    if (picker && token !== frameToken) picker.hideUi();
  }

  function choose(el) {
    const liveOnlyNew = picker.liveOnlyNew;
    cancelPick();
    send({ type: "picked" });
    startWatch(el, liveOnlyNew);
  }

  // ---------------- watcher ----------------

  function startWatch(el, liveOnlyNew) {
    stopWatch();

    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = `2px dashed ${ACCENT}`;
    el.style.outlineOffset = "-2px";

    if (!liveOnlyNew) send({ type: "speak", texts: [textOf(el)], mode: "replace" });

    const seen = new WeakSet();
    let queue = [];
    let timer = null;

    // Frameworks (YouTube, Twitch) often insert an empty element and fill it a moment later,
    // so collect added nodes and read them after a short delay.
    const flush = () => {
      timer = null;
      const nodes = queue.filter((n) => n.isConnected && el.contains(n));
      queue = [];
      // keep only top-most nodes of this batch
      const roots = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
      const texts = [];
      for (const n of roots) {
        // skip if this node, or an ancestor inside the section, was already read
        let p = n, done = false;
        while (p && p !== el) { if (seen.has(p)) { done = true; break; } p = p.parentNode; }
        if (done) continue;
        seen.add(n);
        const t = textOf(n);
        if (t) texts.push(t); // DOM order = chat order (newest last)
      }
      // The backlog setting decides how many of the newest waiting messages are kept.
      if (texts.length) send({ type: "speak", texts, mode: "live" });
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim())) {
            queue.push(n);
          }
        }
      }
      if (queue.length && !timer) timer = setTimeout(flush, 250);
    });
    observer.observe(el, { childList: true, subtree: true });

    watcher = {
      stop() {
        observer.disconnect();
        clearTimeout(timer);
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
      },
    };
  }

  function stopWatch() {
    if (watcher) { watcher.stop(); watcher = null; }
  }

  // ---------------- speech engine (Firefox) ----------------
  // Chrome speaks from the background with chrome.tts. Firefox has no chrome.tts,
  // so the top frame speaks with the OS voices through window.speechSynthesis.

  // Mirrors the Chrome engine in background.js: language-matched voice per chunk,
  // and a live backlog that keeps only the newest `settings.backlog` chat messages.
  const speech = { pending: 0, generation: 0, liveQueue: [] };

  const baseLang = (l) => {
    const b = (l || "").toLowerCase().split(/[-_]/)[0];
    return b === "iw" ? "he" : b;
  };

  function pickPageVoice(preferredName, lang, autoLang) {
    const voices = speechSynthesis.getVoices().filter((v) => v.localService);
    if (!voices.length) return null;
    const preferred = voices.find((v) => v.name === preferredName);
    if (autoLang && lang) {
      if (preferred && baseLang(preferred.lang) === lang) return preferred;
      const match = voices.find((v) => baseLang(v.lang) === lang);
      if (match) return match;
      send({ type: "missingVoice", lang }); // no installed voice for this language
    }
    return preferred || voices.find((v) => baseLang(v.lang) === "en") || voices[0];
  }

  function ttsStop() {
    speech.generation++;
    speech.liveQueue = [];
    speech.pending = 0;
    speechSynthesis.cancel();
  }

  function ttsSpeakItems(items, settings) {
    const gen = speech.generation;
    for (const { text, lang } of items) {
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickPageVoice(settings.voiceName, lang, settings.autoLang);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = settings.rate;
      u.volume = settings.volume;
      u.onend = u.onerror = () => {
        if (gen !== speech.generation) return;
        speech.pending = Math.max(0, speech.pending - 1);
        if (speech.pending === 0) playNextLive();
      };
      speech.pending++;
      speechSynthesis.speak(u);
    }
  }

  function playNextLive() {
    const next = speech.liveQueue.shift();
    if (next) ttsSpeakItems(next.items, next.settings);
  }

  function ttsSpeak({ messages, mode, settings }) {
    if (mode === "replace") ttsStop();
    if (mode === "live") {
      for (const items of messages) speech.liveQueue.push({ items, settings });
      speech.liveQueue = speech.liveQueue.slice(-settings.backlog);
      if (speech.pending === 0) playNextLive();
    } else {
      ttsSpeakItems(messages.flat(), settings);
    }
  }

  // ---------------- messages ----------------

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "startPick") { stopWatch(); startPick(msg.liveOnlyNew !== false); }
    else if (msg.type === "cancelPick") cancelPick();
    else if (msg.type === "pickFrame") onPickFrame(msg.token);
    else if (msg.type === "stopWatch") stopWatch();
    else if (msg.type === "ttsSpeak" && window === window.top) ttsSpeak(msg);
    else if (msg.type === "ttsStop" && window === window.top) ttsStop();
    else if (msg.type === "ttsState" && window === window.top) sendResponse(speech.pending > 0 || speechSynthesis.speaking);
  });
})();
