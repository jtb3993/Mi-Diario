import {
  toDayId,
  nowTs,
  createPage,
  getPage,
  updatePage,
  listPagesByDay,
  listMistakesByPage,
  upsertMistakesForPage,
  addAudioNote,
  listAudioNotesByPage,
  softDeleteAudio,
  inkPage,
  softDeletePage,
  touchTags,
  listTags,
  getAllNonDeletedPages,
  getAllNonDeletedMistakes,
  getAllNonDeletedAudio,
} from "./db.js";

import { analyseAttemptVsCorrect } from "./analysis.js";

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Strict emoji only validation (best effort, Chrome supports \p{Extended_Pictographic})
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)+$/u;
function isEmojiOnly(s) {
  const v = (s || "").trim();
  if (!v) return false;
  return EMOJI_ONLY_RE.test(v);
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => {
    const m = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return m[c] || c;
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function wordCount(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

function minutesFromSeconds(sec) {
  if (!Number.isFinite(sec)) return 0;
  return sec / 60;
}

function iconMask(name) {
  // Minimal inline icon set using SVG mask.
  // No external network or icon CDNs.
  const icons = {
    home: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="M12 3l9 8h-3v9h-5v-6H11v6H6v-9H3z"/></svg>`,
    plus: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="M11 5h2v14h-2z"/><path fill="black" d="M5 11h14v2H5z"/></svg>`,
    chart: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="M4 19h16v2H2V3h2z"/><path fill="black" d="M7 17V10h3v7zM12 17V6h3v11zM17 17v-4h3v4z"/></svg>`,
    alert: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="M12 2l10 18H2z"/><path fill="white" d="M11 9h2v5h-2z"/><path fill="white" d="M11 16h2v2h-2z"/></svg>`,
    gear: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.4 7.4 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.22-1.12.52-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.22 1.12-.52 1.63-.94l2.39.96c.24.1.51.01.64-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5"/></svg>`,
    today: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="M7 2h2v2h6V2h2v2h3v18H4V4h3z"/><path fill="white" d="M6 8h12v12H6z"/><path fill="black" d="M8 10h8v2H8zm0 4h6v2H8z"/></svg>`,
    close: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="black" d="M18.3 5.7l-1.4-1.4L12 9.2 7.1 4.3 5.7 5.7 10.6 10.6 5.7 15.5l1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/></svg>`,
  };
  const svg = icons[name];
  if (!svg) return "";
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return `url("${url}")`;
}

function applyIconMasks(root = document) {
  root.querySelectorAll(".icon[data-icon]").forEach((el) => {
    const name = el.getAttribute("data-icon");
    const mask = iconMask(name);
    if (!mask) return;
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
  });
}

export class UI {
  constructor({ db, appVersion, onBanner }) {
    this.db = db;
    this.appVersion = appVersion;
    this.onBanner = onBanner || (() => {});
    this.root = null;

    this.state = {
      tab: "home",
      selectedDayId: null,
      selectedPageId: null,
    };

    this._autosave = debounce(() => this.autosaveActiveDraft(), 450);
  }

  async mount(rootEl) {
    this.root = rootEl;
    this.wireTabBar();
    applyIconMasks(document);
    await this.render();
  }

  wireTabBar() {
    const setTab = async (tab) => {
      this.state.tab = tab;
      this.state.selectedPageId = null;
      this.state.selectedDayId = null;
      await this.render();
      this.highlightTab();
    };

    document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tab = btn.getAttribute("data-tab");
        if (tab === "new") {
          await this.createNewPageForToday();
          return;
        }
        await setTab(tab);
      });
    });

    this.highlightTab();
  }

  highlightTab() {
    document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
      const tab = btn.getAttribute("data-tab");
      btn.classList.toggle("active", tab === this.state.tab);
    });
  }

  async goToToday() {
    this.state.tab = "home";
    this.state.selectedDayId = toDayId();
    this.state.selectedPageId = null;
    await this.render();
    this.highlightTab();
  }

  async createNewPageForToday() {
    try {
      const dayId = toDayId();
      const page = await createPage(this.db, { dayId, titleEmoji: "", attemptText: "", correctText: "", tags: [] });
      this.state.tab = "home";
      this.state.selectedDayId = dayId;
      this.state.selectedPageId = page.pageId;
      await this.render();
      this.highlightTab();
      this.onBanner("info", "New page created");
    } catch (e) {
      console.error(e);
      this.onBanner("error", "Could not create a new page");
    }
  }

  async render() {
    if (!this.root) return;
    this.root.innerHTML = "";

    if (this.state.tab === "home") {
      if (this.state.selectedPageId) {
        await this.renderPageDetail(this.state.selectedPageId);
        return;
      }
      if (this.state.selectedDayId) {
        await this.renderDayView(this.state.selectedDayId);
        return;
      }
      await this.renderHome();
      return;
    }

    if (this.state.tab === "stats") {
      this.root.appendChild(this.cardNotice("Stats will be added in Part 2 (Chart.js charts, filters, insights)."));
      return;
    }

    if (this.state.tab === "mistakes") {
      this.root.appendChild(this.cardNotice("Global Mistakes view will be added in Part 2 (recurring patterns, filters, search, jump to page)."));
      return;
    }

    if (this.state.tab === "settings") {
      await this.renderSettings();
      return;
    }

    await this.renderHome();
  }

  cardNotice(text) {
    const card = document.createElement("section");
    card.className = "card card-pad";
    card.innerHTML = `
      <div class="h1">Coming soon</div>
      <div class="small" style="margin-top:8px">${escapeHtml(text)}</div>
    `;
    return card;
  }

  async renderHome() {
    const wrap = document.createElement("div");
    wrap.className = "stack";

    const summaryCard = document.createElement("section");
    summaryCard.className = "card card-pad";

    const { dayCount, currentStreak, bestStreak, pagesTotal, mistakesTotal, audioMinutesTotal } = await this.computeHeadlineStats();

    summaryCard.innerHTML = `
      <div class="row">
        <div>
          <div class="h1">Home</div>
          <div class="small">Your journal days and daily totals</div>
        </div>
        <button class="btn btn-primary" id="btnNewTop" type="button">New page</button>
      </div>
      <div class="hr"></div>
      <div class="grid-2">
        <div class="kpi">
          <div class="kpi-num">${dayCount}</div>
          <div class="kpi-lbl">Days with entries</div>
        </div>
        <div class="kpi">
          <div class="kpi-num">${pagesTotal}</div>
          <div class="kpi-lbl">Total pages</div>
        </div>
        <div class="kpi">
          <div class="kpi-num">${mistakesTotal}</div>
          <div class="kpi-lbl">Total mistakes</div>
        </div>
        <div class="kpi">
          <div class="kpi-num">${audioMinutesTotal.toFixed(1)}</div>
          <div class="kpi-lbl">Audio minutes</div>
        </div>
      </div>
      <div class="hr"></div>
      <div class="row">
        <span class="pill">Current streak: <b>${currentStreak}</b></span>
        <span class="pill">Best streak: <b>${bestStreak}</b></span>
      </div>
    `;

    wrap.appendChild(summaryCard);

    const listCard = document.createElement("section");
    listCard.className = "card card-pad";
    listCard.innerHTML = `
      <div class="row">
        <div>
          <div class="h2">Days</div>
          <div class="small">Tap a day to see pages</div>
        </div>
      </div>
      <div class="hr"></div>
      <div id="daysList" class="stack"></div>
    `;
    wrap.appendChild(listCard);

    this.root.appendChild(wrap);

    const btnNewTop = this.root.querySelector("#btnNewTop");
    btnNewTop?.addEventListener("click", async () => this.createNewPageForToday());

    const daysList = this.root.querySelector("#daysList");
    const dayRows = await this.buildDayRows();
    if (!dayRows.length) {
      const empty = document.createElement("div");
      empty.className = "small";
      empty.textContent = "No entries yet. Tap New to create your first page.";
      daysList.appendChild(empty);
    } else {
      dayRows.forEach((row) => daysList.appendChild(row));
    }

    applyIconMasks(this.root);
  }

  async buildDayRows() {
    const pages = await getAllNonDeletedPages(this.db);
    const mistakes = await getAllNonDeletedMistakes(this.db);
    const audios = await getAllNonDeletedAudio(this.db);

    const byDay = new Map();

    for (const p of pages) {
      if (!byDay.has(p.dayId)) {
        byDay.set(p.dayId, { dayId: p.dayId, pages: 0, words: 0, mistakes: 0, audioMin: 0 });
      }
      const s = byDay.get(p.dayId);
      s.pages += 1;
      s.words += wordCount(p.attemptText) + wordCount(p.correctText);
    }

    for (const m of mistakes) {
      const s = byDay.get(m.dayId);
      if (s) s.mistakes += 1;
    }

    for (const a of audios) {
      const s = byDay.get(a.dayId);
      if (s) s.audioMin += minutesFromSeconds(a.durationSec || 0);
    }

    const days = [...byDay.values()].sort((a, b) => (a.dayId < b.dayId ? 1 : -1));

    return days.map((d) => {
      const row = document.createElement("div");
      row.className = "card card-pad";
      row.style.boxShadow = "none";
      row.style.background = "rgba(255,255,255,0.9)";
      row.innerHTML = `
        <div class="row">
          <div>
            <div class="h2">${escapeHtml(d.dayId)}</div>
            <div class="small">
              ${d.pages} pages, ${d.words} words, ${d.mistakes} mistakes, ${d.audioMin.toFixed(1)} audio min
            </div>
          </div>
          <button class="btn" type="button">Open</button>
        </div>
      `;
      row.querySelector("button")?.addEventListener("click", async () => {
        this.state.selectedDayId = d.dayId;
        await this.render();
      });
      return row;
    });
  }

  async computeHeadlineStats() {
    const pages = await getAllNonDeletedPages(this.db);
    const mistakes = await getAllNonDeletedMistakes(this.db);
    const audios = await getAllNonDeletedAudio(this.db);

    const daysSet = new Set(pages.map((p) => p.dayId));
    const dayCount = daysSet.size;
    const pagesTotal = pages.length;
    const mistakesTotal = mistakes.length;
    const audioMinutesTotal = audios.reduce((acc, a) => acc + minutesFromSeconds(a.durationSec || 0), 0);

    const { currentStreak, bestStreak } = this.computeStreak([...daysSet]);

    return { dayCount, pagesTotal, mistakesTotal, audioMinutesTotal, currentStreak, bestStreak };
  }

  computeStreak(dayIds) {
    const set = new Set(dayIds);
    const sorted = [...set].sort(); // ascending YYYY-MM-DD
    if (!sorted.length) return { currentStreak: 0, bestStreak: 0 };

    const toDate = (id) => new Date(id + "T00:00:00");
    const has = (id) => set.has(id);

    const today = toDayId();
    let cur = 0;
    let d = today;

    // Current streak from today backwards (if today has entries).
    while (has(d)) {
      cur++;
      const dt = toDate(d);
      dt.setDate(dt.getDate() - 1);
      d = toDayId(dt);
    }

    // Best streak by scanning sorted days
    let best = 1;
    let run = 1;

    for (let i = 1; i < sorted.length; i++) {
      const prev = toDate(sorted[i - 1]);
      const next = toDate(sorted[i]);
      const diffDays = Math.round((next - prev) / (24 * 60 * 60 * 1000));
      if (diffDays === 1) {
        run++;
        best = Math.max(best, run);
      } else {
        run = 1;
      }
    }

    return { currentStreak: cur, bestStreak: best || 0 };
  }

  async renderDayView(dayId) {
    const wrap = document.createElement("div");
    wrap.className = "stack";

    const header = document.createElement("section");
    header.className = "card card-pad";
    header.innerHTML = `
      <div class="row">
        <div>
          <div class="h1">${escapeHtml(dayId)}</div>
          <div class="small">Pages for this day</div>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn" id="btnBackHome" type="button">Back</button>
          <button class="btn btn-primary" id="btnNewDay" type="button">New</button>
        </div>
      </div>
    `;
    wrap.appendChild(header);

    const list = document.createElement("section");
    list.className = "card card-pad";
    list.innerHTML = `
      <div class="h2">Pages</div>
      <div class="hr"></div>
      <div id="pageList" class="stack"></div>
    `;
    wrap.appendChild(list);

    this.root.appendChild(wrap);

    this.root.querySelector("#btnBackHome")?.addEventListener("click", async () => {
      this.state.selectedDayId = null;
      await this.render();
    });
    this.root.querySelector("#btnNewDay")?.addEventListener("click", async () => {
      const page = await createPage(this.db, { dayId, titleEmoji: "", attemptText: "", correctText: "", tags: [] });
      this.state.selectedPageId = page.pageId;
      await this.render();
    });

    const pages = await listPagesByDay(this.db, dayId);
    const host = this.root.querySelector("#pageList");

    if (!pages.length) {
      const empty = document.createElement("div");
      empty.className = "small";
      empty.textContent = "No pages yet for this day. Tap New.";
      host.appendChild(empty);
      return;
    }

    for (const p of pages) {
      const mistakesCount = (p.analysis && p.analysis.totalMistakes) ? p.analysis.totalMistakes : 0;

      const card = document.createElement("div");
      card.className = "card card-pad";
      card.style.boxShadow = "none";
      card.style.background = "rgba(255,255,255,0.9)";
      card.innerHTML = `
        <div class="row">
          <div style="min-width:0">
            <div class="row" style="justify-content:flex-start; gap:10px">
              <div style="font-size:20px">${escapeHtml(p.titleEmoji || "⬜")}</div>
              <div style="min-width:0">
                <div class="h2">${fmtTime(p.createdAt)} <span class="muted" style="font-weight:650">(${mistakesCount} mistakes)</span></div>
                <div class="small">${escapeHtml((p.tags || []).join(", "))}</div>
              </div>
            </div>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-end">
            ${p.inked ? `<span class="pill pill-inked">Inked</span>` : ``}
            <button class="btn" type="button">Open</button>
          </div>
        </div>
      `;
      card.querySelector("button")?.addEventListener("click", async () => {
        this.state.selectedPageId = p.pageId;
        await this.render();
      });
      host.appendChild(card);
    }

    applyIconMasks(this.root);
  }

  async renderPageDetail(pageId) {
    const page = await getPage(this.db, pageId);
    if (!page) {
      this.onBanner("error", "Page not found");
      this.state.selectedPageId = null;
      await this.render();
      return;
    }

    const mistakes = await listMistakesByPage(this.db, pageId);
    const audioNotes = await listAudioNotesByPage(this.db, pageId);
    const tags = await listTags(this.db);

    const wrap = document.createElement("div");
    wrap.className = "stack";

    const top = document.createElement("section");
    top.className = "card card-pad";

    const emojiError = (!page.inked && page.titleEmoji && !isEmojiOnly(page.titleEmoji));

    top.innerHTML = `
      <div class="row">
        <div>
          <div class="h1">Page</div>
          <div class="small">${escapeHtml(page.dayId)} at ${fmtTime(page.createdAt)}</div>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn" id="btnBackDay" type="button">Back</button>
        </div>
      </div>

      <div class="hr"></div>

      <div class="field">
        <div class="label">Title (emoji only, required)</div>
        <input class="input" id="titleEmoji" inputmode="text" autocomplete="off" placeholder="🙂" value="${escapeHtml(page.titleEmoji || "")}" ${page.inked ? "disabled" : ""} />
        <div id="emojiError" ${emojiError ? "" : "hidden"} class="inline-error">
          Title must be emoji only (no letters, numbers, or spaces)
        </div>
        <div class="tagrow" id="emojiQuick">
          ${["🙂","📌","📚","🧠","✍️","🧩","🗣️","🏝️","💬","✅","⏳","🎧"].map((e) => `<button class="btn" type="button" data-emoji="${escapeHtml(e)}" ${page.inked ? "disabled" : ""}>${escapeHtml(e)}</button>`).join("")}
        </div>
      </div>

      <div class="field">
        <div class="label">Tags</div>
        <input class="input" id="tagsInput" placeholder="e.g. trabajo, familia" value="${escapeHtml((page.tags || []).join(", "))}" ${page.inked ? "disabled" : ""} />
        <div class="small">Comma separated. Suggestions: ${escapeHtml(tags.slice(0, 8).map((t) => t.tag).join(", "))}</div>
      </div>

      <div class="field">
        <div class="label">Spanish attempt</div>
        <textarea id="attemptText" ${page.inked ? "disabled" : ""}>${escapeHtml(page.attemptText || "")}</textarea>
      </div>

      <div class="field">
        <div class="row">
          <div class="label">Correct Spanish</div>
          <button class="btn" id="btnPaste" type="button" ${page.inked ? "disabled" : ""}>Paste</button>
        </div>
        <textarea id="correctText" ${page.inked ? "disabled" : ""}>${escapeHtml(page.correctText || "")}</textarea>
      </div>

      <div class="row" style="flex-wrap:wrap; gap:10px">
        <button class="btn btn-primary" id="btnAnalyse" type="button" ${page.inked ? "disabled" : ""}>Analyse</button>
        <button class="btn" id="btnRecord" type="button" ${page.inked ? "disabled" : ""}>Record audio</button>
        <button class="btn" id="btnStop" type="button" hidden>Stop</button>
        <button class="btn btn-danger" id="btnInk" type="button" ${page.inked ? "disabled" : ""}>Ink page</button>
        <button class="btn btn-danger" id="btnDelete" type="button">Delete</button>
      </div>

      <div class="small" id="autosaveHint" style="margin-top:10px"></div>
    `;

    wrap.appendChild(top);

    // Audio section
    const audioCard = document.createElement("section");
    audioCard.className = "card card-pad";
    audioCard.innerHTML = `
      <div class="row">
        <div>
          <div class="h2">Audio notes</div>
          <div class="small">${page.inked ? "Read only (inked)" : "Record as many as you want"}</div>
        </div>
      </div>
      <div class="hr"></div>
      <div id="audioList" class="stack"></div>
    `;
    wrap.appendChild(audioCard);

    // Mistakes section
    const mCard = document.createElement("section");
    mCard.className = "card card-pad";

    const byType = (page.analysis && page.analysis.byType) ? page.analysis.byType : {};
    const typeLine = Object.keys(byType).length
      ? Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ")
      : "No analysis yet";

    mCard.innerHTML = `
      <div class="row">
        <div>
          <div class="h2">Mistakes for this page</div>
          <div class="small">Total: <b>${mistakes.length}</b>. ${escapeHtml(typeLine)}</div>
        </div>
      </div>
      <div class="hr"></div>
      <div id="mistakeList" class="stack"></div>
    `;
    wrap.appendChild(mCard);

    this.root.innerHTML = "";
    this.root.appendChild(wrap);

    // Render audio list
    this.renderAudioList(audioNotes, page);

    // Render mistake list
    const mHost = this.root.querySelector("#mistakeList");
    if (!mistakes.length) {
      const empty = document.createElement("div");
      empty.className = "small";
      empty.textContent = "No mistakes to show yet. Add text then tap Analyse.";
      mHost.appendChild(empty);
    } else {
      for (const m of mistakes) {
        const item = document.createElement("div");
        item.className = "card card-pad";
        item.style.boxShadow = "none";
        item.style.background = "rgba(255,255,255,0.9)";
        item.innerHTML = `
          <div class="row" style="align-items:flex-start">
            <div style="min-width:0">
              <div class="h2">${escapeHtml(m.wrong || "∅")} → ${escapeHtml(m.correct || "∅")}</div>
              <div class="small">${escapeHtml(m.type)} · ${escapeHtml(m.severity)}</div>
              <div class="small" style="margin-top:6px">
                <b>Context</b>: ${escapeHtml(m.contextBefore)} [ ${escapeHtml(m.wrong || "")} ] ${escapeHtml(m.contextAfter)}
              </div>
            </div>
            <button class="btn" type="button">More</button>
          </div>
        `;
        item.querySelector("button")?.addEventListener("click", () => {
          this.modal({
            title: "Mistake details",
            body: `
              <div class="small"><b>Type</b>: ${escapeHtml(m.type)}</div>
              <div class="small"><b>Severity</b>: ${escapeHtml(m.severity)}</div>
              <div class="small" style="margin-top:8px"><b>Raw diff</b>: ${escapeHtml(m.rawDiff || "")}</div>
            `,
            actions: [{ label: "Close", kind: "ghost" }],
          });
        });
        mHost.appendChild(item);
      }
    }

    // Wire controls
    this.root.querySelector("#btnBackDay")?.addEventListener("click", async () => {
      this.state.selectedPageId = null;
      this.state.selectedDayId = page.dayId;
      await this.render();
    });

    // Emoji quick pick
    this.root.querySelectorAll("#emojiQuick button[data-emoji]").forEach((b) => {
      b.addEventListener("click", () => {
        const v = b.getAttribute("data-emoji");
        const input = this.root.querySelector("#titleEmoji");
        if (input && !input.disabled) {
          input.value = v;
          input.dispatchEvent(new Event("input"));
        }
      });
    });

    // Paste correct text
    this.root.querySelector("#btnPaste")?.addEventListener("click", async () => {
      try {
        if (!navigator.clipboard?.readText) {
          this.onBanner("warn", "Clipboard paste not supported on this device");
          return;
        }
        const t = await navigator.clipboard.readText();
        const ta = this.root.querySelector("#correctText");
        if (ta && !ta.disabled) {
          ta.value = t || "";
          ta.dispatchEvent(new Event("input"));
        }
      } catch {
        this.onBanner("warn", "Could not read clipboard");
      }
    });

    // Inputs autosave
    const titleInput = this.root.querySelector("#titleEmoji");
    const tagsInput = this.root.querySelector("#tagsInput");
    const attemptTa = this.root.querySelector("#attemptText");
    const correctTa = this.root.querySelector("#correctText");

    const onInput = () => this._autosave();

    titleInput?.addEventListener("input", () => {
      const val = titleInput.value;
      const bad = val && !isEmojiOnly(val);
      const err = this.root.querySelector("#emojiError");
      if (err) err.hidden = !bad;
      this._autosave();
    });
    tagsInput?.addEventListener("input", onInput);
    attemptTa?.addEventListener("input", onInput);
    correctTa?.addEventListener("input", onInput);

    // Analyse
    this.root.querySelector("#btnAnalyse")?.addEventListener("click", async () => {
      const latest = await getPage(this.db, pageId);
      if (!latest) return;

      if (!isEmojiOnly((latest.titleEmoji || "").trim())) {
        this.onBanner("warn", "Add an emoji only title before analysing");
        return;
      }

      if (!latest.attemptText.trim() || !latest.correctText.trim()) {
        this.onBanner("warn", "Add both attempt and correct Spanish before analysing");
        return;
      }

      try {
        const result = analyseAttemptVsCorrect({
          dayId: latest.dayId,
          pageId: latest.pageId,
          attemptText: latest.attemptText,
          correctText: latest.correctText,
        });

        // Attach rawDiff summary as the page.analysis
        await upsertMistakesForPage(
          this.db,
          latest.dayId,
          latest.pageId,
          result.mistakes,
          result.summary
        );

        this.onBanner("info", `Analysed. Found ${result.mistakes.length} mistakes.`);
        await this.renderPageDetail(pageId);
      } catch (e) {
        console.error(e);
        this.onBanner("error", "Analysis failed");
      }
    });

    // Audio recording
    this.wireAudioRecording(page);

    // Ink
    this.root.querySelector("#btnInk")?.addEventListener("click", async () => {
      const latest = await getPage(this.db, pageId);
      if (!latest) return;

      if (!isEmojiOnly((latest.titleEmoji || "").trim())) {
        this.onBanner("warn", "Title must be emoji only before inking");
        return;
      }

      this.modal({
        title: "Ink this page?",
        body: "Inking is irreversible. The page becomes read only, including audio notes.",
        actions: [
          { label: "Cancel", kind: "ghost" },
          {
            label: "Ink now",
            kind: "danger",
            onClick: async () => {
              try {
                await inkPage(this.db, pageId);
                this.onBanner("info", "Page inked");
                await this.renderPageDetail(pageId);
              } catch (e) {
                console.error(e);
                this.onBanner("error", "Could not ink page");
              }
            },
          },
        ],
      });
    });

    // Delete
    this.root.querySelector("#btnDelete")?.addEventListener("click", async () => {
      this.modal({
        title: "Delete this page?",
        body: "This moves the page (and its audio) to the bin. Items are permanently deleted after 14 days.",
        actions: [
          { label: "Cancel", kind: "ghost" },
          {
            label: "Delete",
            kind: "danger",
            onClick: async () => {
              try {
                await softDeletePage(this.db, pageId);
                this.onBanner("info", "Page moved to bin");
                this.state.selectedPageId = null;
                this.state.selectedDayId = page.dayId;
                await this.render();
              } catch (e) {
                console.error(e);
                this.onBanner("error", "Could not delete page");
              }
            },
          },
        ],
      });
    });

    applyIconMasks(this.root);
  }

  async autosaveActiveDraft() {
    const pageId = this.state.selectedPageId;
    if (!pageId) return;

    const page = await getPage(this.db, pageId);
    if (!page || page.inked) return;

    const titleEmoji = (this.root.querySelector("#titleEmoji")?.value || "").trim();
    const tagsRaw = (this.root.querySelector("#tagsInput")?.value || "").trim();
    const attemptText = this.root.querySelector("#attemptText")?.value || "";
    const correctText = this.root.querySelector("#correctText")?.value || "";

    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Enforce: title is required, emoji only. If invalid, do not block saving text, but show hint and disable actions.
    const hint = this.root.querySelector("#autosaveHint");
    const isValidEmoji = titleEmoji ? isEmojiOnly(titleEmoji) : false;

    try {
      await updatePage(this.db, {
        pageId,
        titleEmoji,
        tags,
        attemptText,
        correctText,
      });

      // Touch tag usage counts (best effort)
      if (tags.length) await touchTags(this.db, tags);

      if (hint) {
        hint.textContent = `Saved ${new Date(nowTs()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${isValidEmoji ? "" : " (title needs emoji only)"}`;
        hint.className = isValidEmoji ? "small" : "small";
      }
    } catch (e) {
      console.error(e);
      this.onBanner("error", "Autosave failed");
    }
  }

  renderAudioList(audioNotes, page) {
    const host = this.root.querySelector("#audioList");
    if (!
