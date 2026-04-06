/** Tracks estimated token usage (today, this month, this year) in localStorage. */

const STORAGE_KEY = "athva-token-usage";

interface UsageRecord {
  date: string;   // YYYY-MM-DD
  tokens: number;
}

interface StoredUsage {
  records: UsageRecord[];
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function load(): StoredUsage {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StoredUsage;
  } catch { /* ignore */ }
  return { records: [] };
}

function save(usage: StoredUsage) {
  // Keep only last 400 days to prevent unbounded growth
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 400);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  usage.records = usage.records.filter((r) => r.date >= cutoffStr);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
}

/** Add estimated tokens for a request. Chars / 4 is a reasonable estimate. */
export function addTokens(inputChars: number, outputChars: number) {
  const estimated = Math.ceil((inputChars + outputChars) / 4);
  const today = todayStr();
  const usage = load();
  const existing = usage.records.find((r) => r.date === today);
  if (existing) {
    existing.tokens += estimated;
  } else {
    usage.records.push({ date: today, tokens: estimated });
  }
  save(usage);
}

/** Add exact token count (when available from API response). */
export function addExactTokens(tokens: number) {
  const today = todayStr();
  const usage = load();
  const existing = usage.records.find((r) => r.date === today);
  if (existing) {
    existing.tokens += tokens;
  } else {
    usage.records.push({ date: today, tokens });
  }
  save(usage);
}

export interface UsageSummary {
  today: number;
  month: number;
  year: number;
}

export function getUsage(): UsageSummary {
  const usage = load();
  const now = new Date();
  const todayKey = todayStr();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const yearPrefix = `${now.getFullYear()}`;

  let today = 0;
  let month = 0;
  let year = 0;

  for (const r of usage.records) {
    if (r.date === todayKey) today += r.tokens;
    if (r.date.startsWith(monthPrefix)) month += r.tokens;
    if (r.date.startsWith(yearPrefix)) year += r.tokens;
  }

  return { today, month, year };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Update the status bar element with current usage. */
export function updateStatusBar() {
  const el = document.getElementById("token-usage");
  if (!el) return;
  const u = getUsage();
  el.textContent = `Tokens: ${formatTokens(u.today)} today · ${formatTokens(u.month)} month · ${formatTokens(u.year)} year`;
  el.title = `Today: ${u.today.toLocaleString()} | Month: ${u.month.toLocaleString()} | Year: ${u.year.toLocaleString()}`;
}
