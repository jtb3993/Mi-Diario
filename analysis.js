// Offline heuristic mistake analysis.
// Practical diff, not perfect linguistics.

import { uuid, nowTs } from "./db.js";

const ARTICLES = new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "lo", "al", "del"]);
const PREPS = new Set(["a", "ante", "bajo", "con", "contra", "de", "desde", "durante", "en", "entre", "hacia", "hasta", "para", "por", "segun", "sin", "sobre", "tras"]);
const PRONOUNS = new Set(["me", "te", "se", "nos", "os", "lo", "la", "los", "las", "le", "les", "mi", "tu", "su", "mis", "tus", "sus", "este", "esta", "estos", "estas", "eso", "esa", "esos", "esas", "ello", "ella", "ellos", "ellas", "yo", "tu", "usted", "nosotros", "vosotros", "ustedes"]);
const COMMON_VERB_ENDINGS = ["ar", "er", "ir", "ado", "ido", "ando", "iendo", "é", "í", "ó", "aba", "ía", "aré", "eré", "iré"];

function normaliseToken(t) {
  return (t || "").trim();
}

function stripAccents(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function isPunct(tok) {
  return /^[.,;:!?()"“”'¿¡\[\]{}]+$/.test(tok);
}

export function tokenise(text) {
  const src = (text || "").trim();
  if (!src) return [];

  // Split into words and punctuation tokens.
  // Keeps Spanish punctuation.
  const tokens = src.match(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu) || [];
  return tokens.map(normaliseToken).filter(Boolean);
}

function levenshtein(a, b) {
  const s = a || "";
  const t = b || "";
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;

  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = tmp;
    }
  }
  return dp[m];
}

function alignTokens(aTokens, bTokens) {
  // Edit distance alignment (Wagner-Fischer) on token arrays.
  // Returns ops: equal, insert, delete, replace.
  const a = aTokens;
  const b = bTokens;
  const n = a.length;
  const m = b.length;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const bt = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));

  for (let i = 0; i <= n; i++) {
    dp[i][0] = i;
    bt[i][0] = "D";
  }
  for (let j = 0; j <= m; j++) {
    dp[0][j] = j;
    bt[0][j] = "I";
  }
  bt[0][0] = "S";

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      const sub = dp[i - 1][j - 1] + cost;

      const best = Math.min(del, ins, sub);
      dp[i][j] = best;

      if (best === sub) bt[i][j] = cost === 0 ? "E" : "R";
      else if (best === del) bt[i][j] = "D";
      else bt[i][j] = "I";
    }
  }

  // Backtrack
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = bt[i][j];
    if (step === "E") {
      ops.push({ op: "equal", a: a[i - 1], b: b[j - 1], ai: i - 1, bi: j - 1 });
      i--; j--;
    } else if (step === "R") {
      ops.push({ op: "replace", a: a[i - 1], b: b[j - 1], ai: i - 1, bi: j - 1 });
      i--; j--;
    } else if (step === "D") {
      ops.push({ op: "delete", a: a[i - 1], b: null, ai: i - 1, bi: j });
      i--;
    } else if (step === "I") {
      ops.push({ op: "insert", a: null, b: b[j - 1], ai: i, bi: j - 1 });
      j--;
    } else {
      break;
    }
  }

  ops.reverse();
  return ops;
}

function classifyChange(wrong, correct) {
  const w = (wrong || "").toLowerCase();
  const c = (correct || "").toLowerCase();

  if (!w && c) return { type: "missing_word", severity: "medium" };
  if (w && !c) return { type: "extra_word", severity: "medium" };

  if (stripAccents(w) === stripAccents(c) && w !== c) {
    return { type: "accent", severity: "low" };
  }

  if (ARTICLES.has(w) && ARTICLES.has(c)) return { type: "article", severity: "medium" };
  if (PREPS.has(w) && PREPS.has(c)) return { type: "preposition", severity: "medium" };
  if (PRONOUNS.has(w) && PRONOUNS.has(c)) return { type: "pronoun", severity: "medium" };

  // Spelling: small edit distance and same base letters
  const dist = levenshtein(stripAccents(w), stripAccents(c));
  if (dist <= 2 && w.length >= 3 && c.length >= 3) {
    return { type: "spelling", severity: "low" };
  }

  // Verb form best effort: look for common verb endings
  const looksVerb = (s) => COMMON_VERB_ENDINGS.some((end) => s.endsWith(end));
  if (looksVerb(w) && looksVerb(c)) return { type: "verb_form_possible", severity: "high" };

  // Agreement best effort: gender/number-ish endings
  const ends = (s, suf) => s.endsWith(suf);
  const agreeSwap =
    (ends(w, "o") && ends(c, "a")) ||
    (ends(w, "a") && ends(c, "o")) ||
    (ends(w, "os") && ends(c, "as")) ||
    (ends(w, "as") && ends(c, "os")) ||
    (ends(w, "o") && ends(c, "os")) ||
    (ends(w, "a") && ends(c, "as"));

  if (agreeSwap) return { type: "agreement_possible", severity: "high" };

  return { type: "spelling", severity: "medium" };
}

function makeContextWindow(tokens, idx, windowSize = 3) {
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(tokens.length, idx + windowSize + 1);
  const before = tokens.slice(start, idx).join(" ");
  const after = tokens.slice(idx + 1, end).join(" ");
  return { before, after };
}

function rawDiffString(ops) {
  // Compact fallback: marks deletions and insertions
  const parts = [];
  for (const o of ops) {
    if (o.op === "equal") parts.push(o.a);
    if (o.op === "delete") parts.push(`[-${o.a}-]`);
    if (o.op === "insert") parts.push(`{+${o.b}+}`);
    if (o.op === "replace") parts.push(`[-${o.a}-]{+${o.b}+}`);
  }
  return parts.join(isPunct(parts[0]) ? "" : " ");
}

export function analyseAttemptVsCorrect({ dayId, pageId, attemptText, correctText }) {
  const aTokens = tokenise(attemptText);
  const bTokens = tokenise(correctText);

  const ops = alignTokens(aTokens, bTokens);

  const mistakes = [];
  for (const op of ops) {
    if (op.op === "equal") continue;

    // Ignore pure punctuation differences where both are punctuation
    if (op.op === "replace" && isPunct(op.a) && isPunct(op.b)) continue;

    const wrong = op.op === "insert" ? "" : (op.a || "");
    const correct = op.op === "delete" ? "" : (op.b || "");

    const cls = classifyChange(wrong, correct);

    // Context uses attempt tokens for wrong index, correct tokens for correct index (best effort)
    const aIdx = Math.min(Math.max(op.ai ?? 0, 0), Math.max(aTokens.length - 1, 0));
    const bIdx = Math.min(Math.max(op.bi ?? 0, 0), Math.max(bTokens.length - 1, 0));

    const aCtx = makeContextWindow(aTokens, aIdx);
    const bCtx = makeContextWindow(bTokens, bIdx);

    const mistake = {
      mistakeId: uuid(),
      dayId,
      pageId,
      createdAt: nowTs(),
      type: cls.type,
      wrong: wrong,
      correct: correct,
      contextBefore: (aCtx.before || bCtx.before || "").slice(0, 120),
      contextAfter: (aCtx.after || bCtx.after || "").slice(0, 120),
      severity: cls.severity,
      meta: {
        op: op.op,
        ai: op.ai ?? null,
        bi: op.bi ?? null,
      },
      rawDiff: "",
    };

    mistakes.push(mistake);
  }

  const byType = {};
  for (const m of mistakes) byType[m.type] = (byType[m.type] || 0) + 1;

  const summary = {
    analysedAt: nowTs(),
    attemptTokens: aTokens.length,
    correctTokens: bTokens.length,
    totalMistakes: mistakes.length,
    byType,
    rawDiff: rawDiffString(ops),
  };

  // Set rawDiff on each mistake as fallback context
  for (const m of mistakes) m.rawDiff = summary.rawDiff;

  return { mistakes, summary };
}
