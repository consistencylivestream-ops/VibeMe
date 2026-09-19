// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentConversationId = null;   // the chat on screen (its messages live on the server)
let currentProjectFiles = {};   // {path: content} — collected from ```lang name=path blocks
let mermaidCount = 0;

const el = (id) => document.getElementById(id);
const messagesEl = el("messages");
const chatScroll = el("chatScroll");
const welcome = el("welcome");
const form = el("chatForm");
const input = el("promptInput");
const sendBtn = el("sendBtn");
const appRoot = document.querySelector(".app");

// ---------------------------------------------------------------------------
// Keep the layout pinned to the REAL visible viewport (fixes the composer
// jumping around between the empty-chat screen and an active chat — that
// happened because the browser's address bar and the on-screen keyboard
// both resize the viewport, but plain 100vh doesn't track either one).
// ---------------------------------------------------------------------------
function setAppHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-vh", h + "px");
}
setAppHeight();
window.addEventListener("resize", setAppHeight);
window.visualViewport?.addEventListener("resize", setAppHeight);
window.visualViewport?.addEventListener("scroll", setAppHeight);

// ---------------------------------------------------------------------------
// Auth (Google Sign-In only)
// ---------------------------------------------------------------------------
window.handleGoogleCredential = async function (response) {
  try {
    const resp = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert(data.error || "Sign-in failed.");
      return;
    }
    window.location.reload();
  } catch (err) {
    alert("Sign-in failed: " + err.message);
  }
};

function renderAccount() {
  const user = window.VIBEME_USER;
  if (!user) return;
  const avatar = el("accountAvatar");
  const name = el("accountName");
  if (user.picture) {
    avatar.src = user.picture;
    avatar.style.display = "block";
  } else {
    avatar.style.display = "none";
  }
  name.textContent = user.name || user.email || "";
}
renderAccount();

el("logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.reload();
});

mermaid.initialize({ startOnLoad: false, theme: "neutral" });

// ---------------------------------------------------------------------------
// Mobile sidebar (hamburger menu)
// ---------------------------------------------------------------------------
const sidebar = el("sidebar");
const sidebarScrim = el("sidebarScrim");

function openSidebar() {
  sidebar.classList.add("open");
  sidebarScrim.classList.add("open");
}
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarScrim.classList.remove("open");
}
el("hamburgerBtn")?.addEventListener("click", openSidebar);
el("sidebarCloseBtn")?.addEventListener("click", closeSidebar);
sidebarScrim?.addEventListener("click", closeSidebar);
el("mobileNewChatBtn")?.addEventListener("click", startNewChat);

// ---------------------------------------------------------------------------
// Settings (persisted in this browser only — never sent to a server DB;
// chats themselves are stored on the server, see the history section)
// ---------------------------------------------------------------------------
const SETTINGS_KEY = "vibeme_settings";
const HISTORY_KEY = "vibeme_conversations";      // legacy: chats older versions kept in this browser
const LAST_CONV_KEY = "vibeme_last_conversation"; // which chat to reopen when you come back

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Model unlock: secret key -> 5-minute access code. The key is checked only by
// the server (/api/model-access); this file never contains it.
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = el("modelSelect").dataset.default;
let lockTimer = null;

function codeIsLive(s) {
  // accessExpiresAt == null means "pasted code, expiry unknown" — the server decides.
  return !!s.accessCode && (s.accessExpiresAt == null || s.accessExpiresAt > Date.now());
}

function hasOwnKey(s) {
  // While Settings is open judge by what is typed in the box, otherwise by what is saved.
  return settingsOverlay.classList.contains("open") ? !!el("apiKeyInput").value.trim() : !!s.apiKey;
}

// resetSelection=false is used while typing the API key so it doesn't clobber the dropdown choice.
function refreshModelLock(resetSelection = true) {
  clearInterval(lockTimer);
  let s = loadSettings();
  const own = hasOwnKey(s);
  const select = el("modelSelect");
  const status = el("codeStatus");

  if (s.accessCode && !codeIsLive(s)) {   // the code expired: forget it
    s = { ...s, accessCode: "", accessExpiresAt: null, ...(own ? {} : { model: DEFAULT_MODEL }) };
    saveSettings(s);
    if (!own) showToast("Access code expired — back to " + DEFAULT_MODEL + ".");
  }
  const codeLive = codeIsLive(s);
  const open = own || codeLive;

  [...select.options].forEach((o) => { o.disabled = !open && o.value !== DEFAULT_MODEL; });
  if (resetSelection) {
    select.value = open && s.model ? s.model : DEFAULT_MODEL;
    el("accessCodeInput").value = codeLive ? s.accessCode : "";
  } else if (select.selectedOptions[0]?.disabled) {
    select.value = DEFAULT_MODEL;
  }

  if (own) {
    status.textContent = "Using your own OpenAI key — every model is available.";
    return;
  }
  if (!codeLive) {
    status.textContent = "Locked to " + DEFAULT_MODEL + ". Enter the secret key and tap Get code, or add your own OpenAI key above.";
    return;
  }
  if (s.accessExpiresAt == null) {
    status.textContent = "Code in use — the server checks whether it is still valid.";
    return;
  }
  const tick = () => {
    const cur = loadSettings();
    if (!codeIsLive(cur)) { refreshModelLock(); return; }
    const left = Math.max(0, Math.round((cur.accessExpiresAt - Date.now()) / 1000));
    status.textContent = `Unlocked — code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}. Pick a model and Save.`;
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

el("apiKeyInput").addEventListener("input", () => refreshModelLock(false));

el("getCodeBtn").addEventListener("click", async () => {
  const key = el("secretKeyInput").value.trim();
  if (!key) { showToast("Enter the secret key first."); return; }
  const btn = el("getCodeBtn");
  btn.disabled = true;
  try {
    const resp = await fetch("/api/model-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "Couldn't get a code.");
    saveSettings({ ...loadSettings(), accessCode: data.code, accessExpiresAt: Date.now() + data.expires_in * 1000 });
    el("secretKeyInput").value = "";
    refreshModelLock();
    showToast("Unlocked for 5 minutes. Pick a model, then Save.");
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

el("copyCodeBtn").addEventListener("click", async () => {
  const box = el("accessCodeInput");
  if (!box.value.trim()) { showToast("No code yet."); return; }
  try {
    await navigator.clipboard.writeText(box.value.trim());
    showToast("Code copied.");
  } catch {
    box.select();   // clipboard API unavailable (e.g. non-HTTPS) — select it so it can be copied by hand
    showToast("Code selected — copy it manually.");
  }
});

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
const settingsOverlay = el("settingsOverlay");

el("settingsBtn").addEventListener("click", () => {
  const s = loadSettings();
  el("apiKeyInput").value = s.apiKey || "";
  el("secretKeyInput").value = "";
  refreshModelLock();
  el("tempSlider").value = s.temperature ?? 0.4;
  el("tempValue").textContent = s.temperature ?? 0.4;
  setActiveThemeButton(s.theme || "system");
  setActiveSwatch(s.accent || "#C96442");
  setActiveVoiceButton(s.voice || "off");
  if (el("voiceSelect")) {
    populateVoiceSelect();
    if (s.voiceURI) el("voiceSelect").value = s.voiceURI;
  }
  settingsOverlay.classList.add("open");
  closeSidebar();
});
el("closeSettingsBtn").addEventListener("click", () => settingsOverlay.classList.remove("open"));
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove("open");
});
el("tempSlider").addEventListener("input", (e) => {
  el("tempValue").textContent = e.target.value;
});

document.querySelectorAll("#themeOptions .option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    setActiveThemeButton(btn.dataset.theme);
    applyTheme(btn.dataset.theme);
  });
});
document.querySelectorAll("#accentOptions .swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    setActiveSwatch(btn.dataset.accent);
    applyAccent(btn.dataset.accent);
  });
});
document.querySelectorAll("#voiceOptions .option-btn").forEach((btn) => {
  btn.addEventListener("click", () => setActiveVoiceButton(btn.dataset.voice));
});
function setActiveVoiceButton(mode) {
  document.querySelectorAll("#voiceOptions .option-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.voice === mode);
  });
}

function setActiveThemeButton(theme) {
  document.querySelectorAll("#themeOptions .option-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === theme);
  });
}
function setActiveSwatch(color) {
  document.querySelectorAll("#accentOptions .swatch").forEach((b) => {
    b.classList.toggle("active", b.dataset.accent.toLowerCase() === (color || "").toLowerCase());
  });
}

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
  }
}
function applyAccent(color) {
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--accent-hover", shadeColor(color, -12));
}
function shadeColor(hex, percent) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + Math.round(2.55 * percent)));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + Math.round(2.55 * percent)));
  const b = Math.max(0, Math.min(255, (n & 0xff) + Math.round(2.55 * percent)));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

el("saveSettingsBtn").addEventListener("click", () => {
  const activeThemeBtn = document.querySelector("#themeOptions .option-btn.active");
  const activeSwatchBtn = document.querySelector("#accentOptions .swatch.active");
  const activeVoiceBtn = document.querySelector("#voiceOptions .option-btn.active");
  const prev = loadSettings();
  const codeVal = el("accessCodeInput").value.trim().toUpperCase();
  const apiKeyVal = el("apiKeyInput").value.trim();
  saveSettings({
    apiKey: apiKeyVal,
    accessCode: codeVal,
    // keep the known expiry if the code is unchanged; a pasted code's expiry is unknown (server decides)
    accessExpiresAt: codeVal && codeVal === prev.accessCode ? (prev.accessExpiresAt ?? null) : null,
    model: apiKeyVal || codeVal ? el("modelSelect").value : DEFAULT_MODEL,
    temperature: parseFloat(el("tempSlider").value),
    theme: activeThemeBtn ? activeThemeBtn.dataset.theme : "system",
    accent: activeSwatchBtn ? activeSwatchBtn.dataset.accent : "#C96442",
    voice: activeVoiceBtn ? activeVoiceBtn.dataset.voice : "off",
    voiceURI: el("voiceSelect")?.value || "",
  });
  settingsOverlay.classList.remove("open");
});
el("clearAllBtn").addEventListener("click", async () => {
  if (!confirm("Delete all saved chats? This can't be undone.")) return;
  try {
    await fetch("/api/conversations", { method: "DELETE" });
  } catch {
    showToast("Couldn't delete chats. Check your connection.");
    return;
  }
  historyCache = [];
  startNewChat();
  settingsOverlay.classList.remove("open");
});

// Apply saved theme/accent immediately on page load
(function initTheme() {
  const s = loadSettings();
  applyTheme(s.theme || "system");
  applyAccent(s.accent || "#C96442");
})();

// ---------------------------------------------------------------------------
// Markdown rendering with custom code-block handling
// ---------------------------------------------------------------------------
const renderer = new marked.Renderer();

// Pulls every ```lang name=path fenced block out of a COMPLETE, final message.
// This must never run on a partial/streaming buffer — while a filename is still
// mid-stream (e.g. "requirements.t" before the full "requirements.txt" has
// arrived), a naive per-token regex would capture that half-typed name as its
// own file, which is exactly the "require / requirements / requirements.txt"
// duplicate-tabs bug. So this only ever runs once, after the reply is done.
const FILE_BLOCK_RE = /```[^\n`]*\bname=(\S+)[^\n`]*\r?\n([\s\S]*?)```/g;
function extractProjectFiles(text) {
  const files = {};
  let match;
  FILE_BLOCK_RE.lastIndex = 0;
  while ((match = FILE_BLOCK_RE.exec(text)) !== null) {
    files[match[1]] = match[2].replace(/\n$/, "");
  }
  return files;
}

renderer.code = (code, infostring) => {
  const info = (infostring || "").trim();
  const langMatch = info.match(/^([^\s]+)/);
  const nameMatch = info.match(/name=([^\s]+)/);
  const lang = langMatch ? langMatch[1] : "";

  if (lang === "mermaid") {
    mermaidCount += 1;
    const id = `mermaid-${Date.now()}-${mermaidCount}`;
    return `<div class="mermaid" id="${id}">${escapeHtml(code)}</div>`;
  }

  // A named file that's part of a multi-file project: show a compact chip,
  // not the raw code again — the code lives in the artifact panel (and the
  // zip) instead, so it isn't printed twice.
  if (nameMatch) {
    const path = nameMatch[1];
    const lineCount = code.split("\n").length;
    return `<div class="file-chip" data-path="${escapeHtml(path)}">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="file-chip-name">${escapeHtml(path)}</span>
      <span class="file-chip-lines">${lineCount} line${lineCount === 1 ? "" : "s"}</span>
    </div>`;
  }

  const validLang = hljs.getLanguage(lang) ? lang : "plaintext";
  const highlighted = hljs.highlight(code, { language: validLang }).value;
  return `<pre><code class="hljs language-${validLang}">${highlighted}</code><button class="copy-btn" type="button">Copy</button></pre>`;
};

marked.setOptions({ renderer, breaks: false });

// Clicking a file chip in the chat jumps to that file in the artifact panel.
el("messages").addEventListener("click", (e) => {
  const chip = e.target.closest(".file-chip");
  if (!chip) return;
  const path = chip.dataset.path;
  if (!currentProjectFiles[path]) return;
  openArtifactPanel(currentProjectFiles);
  activeTab = path;
  renderArtifactTabs(currentProjectFiles);
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Copy-to-clipboard for every code block, via delegation since bubbles
// are inserted dynamically while streaming.
messagesEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;

  let codeEl = null;
  const pre = btn.closest("pre");
  if (pre) {
    codeEl = pre.querySelector("code");
  } else {
    const row = btn.closest(".code-filename-row");
    if (row && row.nextElementSibling) {
      codeEl = row.nextElementSibling.querySelector("code");
    }
  }
  if (!codeEl) return;
  copyToClipboard(codeEl.textContent, btn);
});

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1500);
  }).catch(() => {
    btn.textContent = "Failed";
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  });
}

// ---------------------------------------------------------------------------
// Voice: speech-to-text (mic button) and text-to-speech (read aloud)
// ---------------------------------------------------------------------------
const micBtn = el("micBtn");
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;

if (SpeechRecognitionAPI && micBtn) {
  recognizer = new SpeechRecognitionAPI();
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.lang = "en-US";

  let baseText = "";

  recognizer.addEventListener("start", () => {
    listening = true;
    baseText = input.value ? input.value.trim() + " " : "";
    micBtn.classList.add("listening");
    el("composerHint").textContent = "Listening… tap the mic again to stop";
  });

  recognizer.addEventListener("result", (e) => {
    let transcript = "";
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    input.value = baseText + transcript;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  });

  const stopListeningUI = () => {
    listening = false;
    micBtn.classList.remove("listening");
    el("composerHint").textContent = "Enter to send · Shift+Enter for a new line";
  };
  recognizer.addEventListener("end", stopListeningUI);
  recognizer.addEventListener("error", stopListeningUI);

  micBtn.addEventListener("click", () => {
    if (listening) {
      recognizer.stop();
    } else {
      try { recognizer.start(); } catch { /* already running */ }
    }
  });
} else if (micBtn) {
  micBtn.style.display = "none"; // browser has no speech recognition support
}

const synth = window.speechSynthesis;
let currentUtterance = null;
let availableVoices = [];

function populateVoiceSelect() {
  if (!synth) return;
  availableVoices = synth.getVoices();
  const select = el("voiceSelect");
  if (!select || !availableVoices.length) return;

  const previouslySelected = select.value || loadSettings().voiceURI || "";
  select.innerHTML = "";
  availableVoices.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    select.appendChild(opt);
  });
  if (previouslySelected && availableVoices.some((v) => v.voiceURI === previouslySelected)) {
    select.value = previouslySelected;
  }
}
if (synth) {
  populateVoiceSelect();
  synth.addEventListener("voiceschanged", populateVoiceSelect);
}

function getSelectedVoice() {
  const uri = el("voiceSelect")?.value || loadSettings().voiceURI;
  return availableVoices.find((v) => v.voiceURI === uri) || null;
}

el("previewVoiceBtn")?.addEventListener("click", () => {
  if (!synth) return;
  if (synth.speaking) synth.cancel();
  const utter = new SpeechSynthesisUtterance("Hi, this is what I sound like.");
  const voice = getSelectedVoice();
  if (voice) utter.voice = voice;
  synth.speak(utter);
});

function speakText(rawText, btn) {
  if (!synth) return;
  const plain = rawText
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#*_>~-]/g, "")
    .trim();
  if (!plain) return;

  if (currentUtterance && synth.speaking) {
    synth.cancel();
    document.querySelectorAll(".speak-btn.speaking").forEach((b) => b.classList.remove("speaking"));
    if (btn && btn.dataset.wasSpeaking === "1") { btn.dataset.wasSpeaking = ""; return; }
  }

  const utter = new SpeechSynthesisUtterance(plain);
  utter.rate = 1;
  const voice = getSelectedVoice();
  if (voice) utter.voice = voice;
  currentUtterance = utter;
  if (btn) btn.classList.add("speaking");
  utter.onend = () => { if (btn) btn.classList.remove("speaking"); };
  utter.onerror = () => { if (btn) btn.classList.remove("speaking"); };
  synth.speak(utter);
}

el("messages").addEventListener("click", (e) => {
  const btn = e.target.closest(".speak-btn");
  if (!btn) return;
  const wasSpeaking = btn.classList.contains("speaking");
  btn.dataset.wasSpeaking = wasSpeaking ? "1" : "";
  const bubble = btn.closest(".msg").querySelector(".bubble");
  speakText(bubble.textContent, btn);
});

// ---------------------------------------------------------------------------
// Unsend (like Claude's edit): removes your message and everything after it,
// stops a reply that is still being written, and puts the text (and files) back
// in the composer so you can change it and send again.
// ---------------------------------------------------------------------------
async function unsendMessage(wrap) {
  const id = wrap.dataset.id;
  if (!id) return;
  const idx = [...messagesEl.children].indexOf(wrap);
  const later = messagesEl.children.length - idx - 2;   // beyond its own reply
  if (later > 0 && !confirm(`Unsend this message? It also removes ${later} later message${later > 1 ? "s" : ""}.`)) return;

  let data;
  try {
    const resp = await fetch(`/api/messages/${id}`, { method: "DELETE" });
    if (resp.status === 401) { window.location.reload(); return; }
    data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "Couldn't unsend that message.");
  } catch (err) {
    showToast(err.message);
    return;
  }

  loadToken++;
  stopActiveStream();
  if (data.conversation_deleted) {
    startNewChat();
  } else {
    await loadConversation(currentConversationId);
  }
  refreshHistory();

  // Put it back in the composer.
  input.value = data.text + (input.value.trim() ? "\n" + input.value : "");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
  (data.attachments || []).forEach((a) => {
    if (pendingAttachments.length < MAX_ATTACH) pendingAttachments.push({ ...a, uploading: false });
  });
  renderAttachTray();
  sendBtn.disabled = false;
  input.focus();
}

el("messages").addEventListener("click", (e) => {
  const btn = e.target.closest(".unsend-btn");
  if (btn) unsendMessage(btn.closest(".msg"));
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg) {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4500);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server counts characters as Unicode code points; JS .length counts
// UTF-16 units, so emoji would throw the offset off. Count code points.
function countChars(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const FILE_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

function isNearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
}

// ---------------------------------------------------------------------------
// Remembering where you were. The open conversation's id is kept in
// localStorage AND the URL hash (#c=...), so closing the tab, swiping the app
// away, or the phone reclaiming the page all bring you back to the same chat.
// The conversation itself lives on the server, not in this browser.
// ---------------------------------------------------------------------------
function rememberConversation(id) {
  try {
    if (id) localStorage.setItem(LAST_CONV_KEY, id);
    else localStorage.removeItem(LAST_CONV_KEY);
  } catch { /* storage blocked — the URL hash still works */ }
  try {
    history.replaceState(null, "", id ? `#c=${id}` : location.pathname + location.search);
  } catch { /* ignore */ }
}

function rememberedConversationId() {
  const m = location.hash.match(/^#c=([\w-]+)/);
  if (m) return m[1];
  try { return localStorage.getItem(LAST_CONV_KEY); } catch { return null; }
}

// Chats saved by older versions lived in this browser's localStorage. Move
// them to the server once, then forget the local copy.
async function migrateLocalHistory() {
  const old = loadHistory();
  if (!old.length) return;
  try {
    const resp = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversations: old }),
    });
    if (resp.ok) localStorage.removeItem(HISTORY_KEY);
  } catch { /* try again next time */ }
}

// ---------------------------------------------------------------------------
// Attaching files (button, paste, drag & drop)
// ---------------------------------------------------------------------------
const attachTray = el("attachTray");
const fileInput = el("fileInput");
const MAX_ATTACH = 8;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
let pendingAttachments = [];   // uploaded (or uploading) but not sent yet
let uploadsInFlight = 0;

function renderAttachTray() {
  attachTray.innerHTML = "";
  pendingAttachments.forEach((a) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip" + (a.uploading ? " uploading" : "");

    let lead;
    if (a.kind === "image" && a.id) {
      lead = `<img class="attach-thumb" src="/api/attachments/${a.id}" alt="">`;
    } else {
      lead = `<span class="attach-icon">${a.uploading ? '<span class="spinner"></span>' : FILE_ICON}</span>`;
    }
    chip.innerHTML =
      `${lead}<span class="attach-name">${escapeHtml(a.name)}</span>` +
      `<span class="attach-size">${a.uploading ? "Uploading…" : formatBytes(a.size)}</span>`;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "attach-remove";
    rm.setAttribute("aria-label", "Remove " + a.name);
    rm.textContent = "✕";
    rm.disabled = !!a.uploading;
    rm.addEventListener("click", () => {
      pendingAttachments = pendingAttachments.filter((x) => x !== a);
      if (a.id) fetch(`/api/attachments/${a.id}`, { method: "DELETE" }).catch(() => {});
      renderAttachTray();
    });
    chip.appendChild(rm);
    attachTray.appendChild(chip);
  });
}

async function uploadOne(entry, file) {
  uploadsInFlight++;
  try {
    const fd = new FormData();
    fd.append("files", file, entry.name);
    const resp = await fetch("/api/upload", { method: "POST", body: fd });
    if (resp.status === 401) { window.location.reload(); return; }
    const data = await resp.json().catch(() => ({}));
    if (data.attachments && data.attachments.length) {
      Object.assign(entry, data.attachments[0], { uploading: false });
    } else {
      throw new Error((data.errors && data.errors[0] && data.errors[0].error) || data.error || "Upload failed.");
    }
  } catch (err) {
    pendingAttachments = pendingAttachments.filter((x) => x !== entry);
    showToast(`${entry.name}: ${err.message}`);
  } finally {
    uploadsInFlight--;
    renderAttachTray();
  }
}

function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  const jobs = [];
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACH) {
      showToast(`You can attach up to ${MAX_ATTACH} files per message.`);
      break;
    }
    const name = file.name || "pasted-file";
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${name} is too large (max 20 MB).`);
      continue;
    }
    const entry = { name, size: file.size, kind: "file", uploading: true };
    pendingAttachments.push(entry);
    jobs.push(uploadOne(entry, file));
  }
  renderAttachTray();
  return Promise.all(jobs);
}

el("attachBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const picked = Array.from(fileInput.files);
  fileInput.value = "";
  uploadFiles(picked);
});

input.addEventListener("paste", (e) => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (files.length) {
    e.preventDefault();
    uploadFiles(files);
  }
});

const chatColumn = document.querySelector(".chat-column");
let dragDepth = 0;
const dragHasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");
chatColumn.addEventListener("dragenter", (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth++;
  chatColumn.classList.add("drop-active");
});
chatColumn.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) chatColumn.classList.remove("drop-active");
});
chatColumn.addEventListener("dragover", (e) => { if (dragHasFiles(e)) e.preventDefault(); });
chatColumn.addEventListener("drop", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  chatColumn.classList.remove("drop-active");
  uploadFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// Sending a message
// ---------------------------------------------------------------------------
let historyCache = [];          // [{id, title, updated_at, generating}] from the server
let activeStream = null;        // the reply this page is currently tailing
let loadToken = 0;              // guards against out-of-order conversation loads
let currentSignature = null;    // cheap fingerprint of what's on screen

form.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});

el("newChatBtn").addEventListener("click", startNewChat);

function startNewChat() {
  loadToken++;
  stopActiveStream();      // the reply keeps generating on the server
  currentConversationId = null;
  currentSignature = null;
  rememberConversation(null);
  messagesEl.innerHTML = "";
  welcome.style.display = "block";
  currentProjectFiles = {};
  closeArtifactPanel();
  sendBtn.disabled = false;
  renderHistoryList();
  closeSidebar();
}

async function sendMessage() {
  const text = input.value.trim();
  if (sendBtn.disabled) return;
  if (!text && pendingAttachments.length === 0) return;
  if (uploadsInFlight > 0) {
    showToast("Hang on — your files are still uploading.");
    return;
  }

  const settings = loadSettings();
  const codeLive = codeIsLive(settings);
  const unlocked = codeLive || !!settings.apiKey;   // own OpenAI key needs no code
  const attachments = pendingAttachments.slice();

  sendBtn.disabled = true;
  loadToken++;

  let data;
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: currentConversationId,
        text,
        attachment_ids: attachments.map((a) => a.id),
        api_key: settings.apiKey || undefined,
        model: unlocked ? settings.model || undefined : undefined,
        access_code: codeLive ? settings.accessCode : undefined,
        temperature: settings.temperature ?? undefined,
      }),
    });
    if (resp.status === 401) {
      window.location.reload();
      return;
    }
    data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "Could not send your message.");
    if (data.notice) {   // server refused the model switch (bad/expired code) and used the default
      showToast(data.notice);
      saveSettings({ ...loadSettings(), accessCode: "", accessExpiresAt: null, model: DEFAULT_MODEL });
      refreshModelLock();
    }
  } catch (err) {
    // Nothing was sent — leave the composer exactly as it was.
    sendBtn.disabled = false;
    showToast(err.message);
    return;
  }

  // Sent. Clear the composer and show the message.
  input.value = "";
  input.style.height = "auto";
  pendingAttachments = [];
  renderAttachTray();

  currentConversationId = data.conversation_id;
  rememberConversation(currentConversationId);
  welcome.style.display = "none";
  currentProjectFiles = {}; // reset file collection for this turn

  appendMessage("user", text, data.user_message.attachments || [], data.user_message.id);
  const assistantBubble = appendMessage("assistant", "");
  refreshHistory();

  streamReply(data.assistant_message_id, assistantBubble, "", {
    userText: text,
    model: data.model_used || "",
    fromSend: true,
  });
}

// Tails a reply from the server. The reply is generated by a background job
// on the server, so this can be dropped (tab closed, app backgrounded, network
// blip) and picked up again at the exact character it stopped at.
async function streamReply(msgId, bubble, startText, opts = {}) {
  stopActiveStream();
  const stream = { msgId, controller: null, timer: null, reconnectNow: false };
  activeStream = stream;

  let fullText = startText || "";
  let finished = false;
  let failures = 0;

  sendBtn.disabled = true;
  bubble.classList.add("cursor-blink");

  if (!fullText) {
    // Claude-style status pill: cycles through a short sequence of phases
    // while we wait for the first token, then gets replaced by the reply.
    const phases = pickStatusPhases(opts.userText || "", opts.model || "");
    let phaseIndex = 0;
    bubble.innerHTML = statusPillHtml(phases[0]);
    stream.timer = setInterval(() => {
      phaseIndex = (phaseIndex + 1) % phases.length;
      const statusText = bubble.querySelector("#statusText");
      if (statusText) statusText.textContent = phases[phaseIndex];
    }, 900);
  } else {
    bubble.innerHTML = marked.parse(fullText);
  }

  while (activeStream === stream && !finished) {
    stream.reconnectNow = false;
    stream.controller = new AbortController();
    try {
      const resp = await fetch(
        `/api/messages/${msgId}/stream?offset=${countChars(fullText)}`,
        { signal: stream.controller.signal }
      );
      if (resp.status === 401) { window.location.reload(); return; }
      if (resp.status === 404) { finished = true; break; }
      if (!resp.ok || !resp.body) throw new Error("stream failed");
      failures = 0;

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop();

        for (const part of parts) {
          if (!part.startsWith("data: ")) continue; // ": ping" keep-alives
          const json = JSON.parse(part.slice(6));
          if (json.token) {
            if (!fullText && stream.timer) { clearInterval(stream.timer); stream.timer = null; }
            const stick = isNearBottom();
            fullText += json.token;
            bubble.innerHTML = marked.parse(fullText);
            if (stick) chatScroll.scrollTop = chatScroll.scrollHeight;
          }
          if (json.error) fullText += `\n\n**Error:** ${json.error}`;
          if (json.done) finished = true;
        }
      }
      if (!finished) await sleep(300); // connection closed early — reconnect
    } catch (err) {
      if (activeStream !== stream) return; // user moved to another chat; server keeps writing
      if (stream.reconnectNow) { failures = 0; continue; }
      failures++;
      if (failures > 60) break;
      await sleep(Math.min(1000 * failures, 5000));
    }
  }

  if (stream.timer) { clearInterval(stream.timer); stream.timer = null; }
  if (activeStream !== stream) return;
  activeStream = null;

  if (!finished) {
    fullText += "\n\n**Error:** Lost connection to the server. Reopen this chat in a moment to see the reply.";
  }

  bubble.classList.remove("cursor-blink");
  bubble.innerHTML = marked.parse(fullText);

  // Auto read-aloud if enabled in Settings
  if (opts.fromSend && loadSettings().voice === "on" && fullText) {
    const speakBtn = bubble.closest(".msg")?.querySelector(".speak-btn");
    speakText(fullText, speakBtn);
  }

  // Render any mermaid diagrams that were emitted
  mermaid.run({ querySelector: ".mermaid" });

  // Extract named files exactly once, now that the reply is fully done —
  // never from the partial buffer while it was still streaming in.
  currentProjectFiles = extractProjectFiles(fullText);
  if (Object.keys(currentProjectFiles).length > 0) {
    openArtifactPanel(currentProjectFiles);
  }

  currentSignature = null; // the server copy is now newer than what we fingerprinted
  sendBtn.disabled = false;
  if (opts.fromSend) input.focus();
  refreshHistory();
}

function stopActiveStream() {
  if (!activeStream) return;
  const s = activeStream;
  activeStream = null;
  if (s.timer) clearInterval(s.timer);
  try { s.controller && s.controller.abort(); } catch { /* ignore */ }
}

function statusPillHtml(text) {
  return `<div class="status-pill"><span class="dot"></span><span id="statusText">${escapeHtml(text)}</span></div>`;
}

function pickStatusPhases(userText, model) {
  const phases = [];
  if (model.includes("search")) phases.push("Searching the web");
  phases.push("Thinking it through");
  if (/\b(build|create|app|project|website|script|api|program)\b/i.test(userText)) {
    phases.push("Building your code");
  }
  if (/\b(diagram|architecture|flow|explain how|how does)\b/i.test(userText)) {
    phases.push("Sketching a diagram");
  }
  if (phases.length === 1) phases.push("Putting it together");
  return phases;
}

function renderAttachmentsInto(container, atts) {
  atts.forEach((a) => {
    const link = document.createElement("a");
    link.href = `/api/attachments/${a.id}`;
    link.target = "_blank";
    link.rel = "noopener";
    if (a.kind === "image") {
      link.className = "att-thumb";
      const img = document.createElement("img");
      img.src = link.href;
      img.alt = a.name;
      img.loading = "lazy";
      link.appendChild(img);
    } else {
      link.className = "att-chip";
      if (a.kind !== "pdf") link.download = a.name;
      link.innerHTML =
        `${FILE_ICON}<span class="att-chip-name">${escapeHtml(a.name)}</span>` +
        `<span class="att-chip-size">${formatBytes(a.size)}</span>`;
    }
    container.appendChild(link);
  });
}

function appendMessage(role, text, attachments = [], msgId = null) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  if (msgId) wrap.dataset.id = msgId;

  const col = document.createElement("div");
  col.className = "msg-col";

  if (attachments.length) {
    const attRow = document.createElement("div");
    attRow.className = "msg-attachments";
    renderAttachmentsInto(attRow, attachments);
    col.appendChild(attRow);
  }

  let bubble = null;
  if (text || role === "assistant") {
    bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = text ? marked.parse(text) : "";
    col.appendChild(bubble);
  }

  if (role === "user" && msgId) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.innerHTML = `<button type="button" class="unsend-btn" title="Unsend and edit this message">↶ Unsend</button>`;
    col.appendChild(actions);
  }

  if (role === "assistant" && synth) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.innerHTML = `<button type="button" class="speak-btn" title="Read aloud" aria-label="Read aloud">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>
    </button>`;
    col.appendChild(actions);
  }

  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  return bubble;
}

// ---------------------------------------------------------------------------
// Sidebar chat history (list, load, delete) — all stored on the server
// ---------------------------------------------------------------------------
let historyPollTimer = null;

function renderHistoryList() {
  const listEl = el("historyList");
  listEl.innerHTML = "";

  historyCache.forEach((c) => {
    const item = document.createElement("div");
    item.className = "history-item" + (c.id === currentConversationId ? " active" : "");

    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = c.title || "Untitled chat";
    item.appendChild(title);

    if (c.generating) {
      const dot = document.createElement("span");
      dot.className = "gen-dot";
      dot.title = "Still writing a reply…";
      item.appendChild(dot);
    }

    const del = document.createElement("button");
    del.className = "history-item-delete";
    del.textContent = "Delete";
    del.title = "Delete chat";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(c.id);
    });
    item.appendChild(del);

    item.addEventListener("click", () => { loadConversation(c.id); closeSidebar(); });
    listEl.appendChild(item);
  });
}

async function refreshHistory() {
  try {
    const resp = await fetch("/api/conversations");
    if (!resp.ok) return;
    historyCache = (await resp.json()).conversations || [];
    renderHistoryList();
  } catch { return; }

  // While any chat is still being written in the background, keep the
  // sidebar's "writing…" dots fresh.
  clearTimeout(historyPollTimer);
  if (historyCache.some((c) => c.generating) && document.visibilityState === "visible") {
    historyPollTimer = setTimeout(refreshHistory, 4000);
  }
}

function convoSignature(convo) {
  const last = convo.messages[convo.messages.length - 1];
  return `${convo.id}:${convo.messages.length}:${last ? last.status + ":" + last.content.length : ""}`;
}

// Returns "ok", "missing" (deleted / not yours) or "error" (couldn't reach the server).
async function loadConversation(id, opts = {}) {
  const token = ++loadToken;
  let convo;
  try {
    const resp = await fetch(`/api/conversations/${id}`);
    if (resp.status === 401) { window.location.reload(); return "error"; }
    if (resp.status === 404) return "missing";
    if (!resp.ok) return "error";
    convo = await resp.json();
  } catch {
    return "error";
  }
  if (token !== loadToken) return "ok"; // a newer load or "New chat" took over

  const sig = convoSignature(convo);
  if (opts.onlyIfChanged && id === currentConversationId && sig === currentSignature) return "ok";

  stopActiveStream();
  currentConversationId = convo.id;
  currentSignature = sig;
  rememberConversation(convo.id);
  renderConversation(convo, opts);
  renderHistoryList();
  return "ok";
}

function renderConversation(convo, opts = {}) {
  messagesEl.innerHTML = "";
  currentProjectFiles = {};
  welcome.style.display = convo.messages.length ? "none" : "block";

  let pending = null;
  convo.messages.forEach((m) => {
    const bubble = appendMessage(m.role, m.content, m.attachments || [], m.id);
    if (m.role !== "assistant") return;
    if (m.status === "generating") {
      pending = { id: m.id, content: m.content, bubble };
    } else {
      Object.assign(currentProjectFiles, extractProjectFiles(m.content));
    }
  });
  mermaid.run({ querySelector: ".mermaid" });

  // Coming back to the app shouldn't slam a full-screen code panel over the
  // chat on a phone; the file chips in the chat still open it on tap.
  const onMobile = window.matchMedia("(max-width: 900px)").matches;
  if (Object.keys(currentProjectFiles).length > 0 && !(opts.restore && onMobile)) {
    openArtifactPanel(currentProjectFiles);
  } else {
    closeArtifactPanel();
  }

  chatScroll.scrollTop = chatScroll.scrollHeight;

  if (pending) {
    // The reply was still being written while you were away — re-attach.
    const lastUser = [...convo.messages].reverse().find((m) => m.role === "user");
    streamReply(pending.id, pending.bubble, pending.content, {
      userText: lastUser ? lastUser.content : "",
      model: loadSettings().model || "",
    });
  } else {
    sendBtn.disabled = false;
  }
}

async function deleteConversation(id) {
  if (!confirm("Delete this chat?")) return;
  try {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  } catch {
    showToast("Couldn't delete the chat. Check your connection.");
    return;
  }
  historyCache = historyCache.filter((c) => c.id !== id);
  if (id === currentConversationId) {
    startNewChat();
  } else {
    renderHistoryList();
  }
}

// Coming back to the page (switching apps, unlocking the phone, restoring a
// frozen tab): reconnect a live reply straight away, or pick up anything that
// finished — or was sent from another device — while we were away.
async function resyncCurrent() {
  if (!window.VIBEME_USER) return;
  if (activeStream) {
    activeStream.reconnectNow = true;
    try { activeStream.controller && activeStream.controller.abort(); } catch { /* ignore */ }
    return;
  }
  if (sendBtn.disabled) return; // a message is being sent right now
  if (currentConversationId) {
    await loadConversation(currentConversationId, { onlyIfChanged: true, restore: true });
  }
  refreshHistory();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resyncCurrent();
});
window.addEventListener("pageshow", (e) => { if (e.persisted) resyncCurrent(); });

// ---------------------------------------------------------------------------
// Artifact panel (grouped project files + zip download)
// ---------------------------------------------------------------------------
let activeTab = null;

function openArtifactPanel(files) {
  appRoot.classList.add("with-artifact");
  const tabsEl = el("artifactTabs");
  tabsEl.innerHTML = "";

  const paths = Object.keys(files);
  activeTab = paths[0];

  paths.forEach((path) => {
    const tab = document.createElement("div");
    tab.className = "artifact-tab" + (path === activeTab ? " active" : "");
    tab.textContent = path;
    tab.addEventListener("click", () => {
      activeTab = path;
      renderArtifactTabs(files);
    });
    tabsEl.appendChild(tab);
  });

  renderArtifactTabs(files);
  el("artifactTitle").textContent = `Project files (${paths.length})`;
}

function renderArtifactTabs(files) {
  document.querySelectorAll(".artifact-tab").forEach((t) => {
    t.classList.toggle("active", t.textContent === activeTab);
  });
  const codeEl = el("artifactCode");
  const lang = guessLang(activeTab);
  const validLang = hljs.getLanguage(lang) ? lang : "plaintext";
  codeEl.className = `language-${validLang}`;
  codeEl.innerHTML = hljs.highlight(files[activeTab], { language: validLang }).value;
}

function guessLang(path) {
  const ext = path.split(".").pop();
  const map = { py: "python", js: "javascript", html: "html", css: "css", json: "json", md: "markdown", sh: "bash" };
  return map[ext] || "plaintext";
}

el("closeArtifactBtn").addEventListener("click", closeArtifactPanel);

el("artifactCopyBtn").addEventListener("click", () => {
  if (!activeTab) return;
  copyToClipboard(currentProjectFiles[activeTab], el("artifactCopyBtn"));
});

function closeArtifactPanel() {
  appRoot.classList.remove("with-artifact");
}

el("downloadZipBtn").addEventListener("click", async () => {
  const files = Object.entries(currentProjectFiles).map(([path, content]) => ({ path, content }));
  if (files.length === 0) return;

  const resp = await fetch("/api/zip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_name: "vibeme-project", files }),
  });

  if (!resp.ok) {
    alert("Could not build the zip file.");
    return;
  }

  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vibeme-project.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  refreshModelLock();   // drop an expired access code and start the countdown if one is live
  const wanted = rememberedConversationId();
  if (wanted) welcome.style.display = "none"; // avoid a flash of the empty-chat screen
  await migrateLocalHistory();
  refreshHistory();
  if (!wanted) return;

  const result = await loadConversation(wanted, { restore: true });
  if (result === "missing") {
    // That chat was deleted (or belongs to another account) — start fresh.
    rememberConversation(null);
    welcome.style.display = "block";
  } else if (result === "error") {
    // Couldn't reach the server. Keep the pointer so the next visit / resync retries.
    currentConversationId = wanted;
    welcome.style.display = messagesEl.children.length ? "none" : "block";
    showToast("Couldn't reload your chat — check your connection.");
  }
}
if (window.VIBEME_USER) init();
