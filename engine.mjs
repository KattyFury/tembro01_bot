// tempo-runner: engine calling MPP services, OpenAI brain (no longer paid via Tempo, saving USDC).
// 1 run = 1 "round". On a VPS, daemon.mjs calls this file repeatedly (a few minutes of jitter).
//
// MODE=mock  -> no network, simulate everything (free, tests logic).
// MODE=live  -> real calls via the tempo-request binary (costs USDC) + OpenAI API (separate OpenAI credit).
//
// State (log, strikes, spend, history of services/requests called) lives in ./state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
const MODE = (process.env.MODE || "mock").toLowerCase();
const BOT_NAME = process.env.BOT_NAME || "tempo-runner";
const TEMPO_BIN = process.env.TEMPO_BIN || "tempo-request";
const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY || "";        // empty = use the already logged-in wallet (VPS)
const DAILY_CAP = Number(process.env.DAILY_CAP || "0.16");     // USDC cap per day (~$5/month ÷ 30)
const STRIKE_LIMIT = Number(process.env.STRIKE_LIMIT || "3");  // failures before striking a service off the list
const MOCK_ITERS = Number(process.env.MOCK_ITERS || "1");      // consecutive rounds for mock
const MOCK_FAIL = (process.env.MOCK_FAIL || "").split(",").filter(Boolean); // force-fail a service id

// OpenAI brain (replacing the old Haiku-via-Tempo), billed separately to the OpenAI account, doesn't touch the USDC wallet.
const OPENAI_API = process.env.OPENAI_API || process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Check on-chain wallet balance (USDC.e is a TIP-20 token, still read with standard ERC-20 balanceOf via RPC).
const RPC_URL = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
const TOKEN_ADDRESS = process.env.USDC_TOKEN_ADDRESS || "0x20c000000000000000000000b9537d11c60e8b50";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "";
const LOW_BALANCE_USD = Number(process.env.LOW_BALANCE_USD || "1");

const STATE_DIR = path.join(__dir, "state");
const LOG_FILE = path.join(STATE_DIR, "log.txt");
const STRIKES_FILE = path.join(STATE_DIR, "strikes.json");
const SPEND_FILE = path.join(STATE_DIR, "spend.json");
const PLAN_FILE = path.join(STATE_DIR, "plan.json");
const HISTORY_FILE = path.join(STATE_DIR, "history.json");
const BALANCE_ALERT_FILE = path.join(STATE_DIR, "balance_alert.json");

// Active window: each bot MUST pick exactly 1 of 2 half-days (Vietnam time), no shared
// window anymore: set ACTIVE_WINDOW="0-12" or "12-24" in each bot's .env.
const ACTIVE_WINDOW = process.env.ACTIVE_WINDOW || "";
let ACTIVE_START_HOUR, ACTIVE_END_HOUR;
if (ACTIVE_WINDOW === "0-12") { ACTIVE_START_HOUR = 0; ACTIVE_END_HOUR = 12; }
else if (ACTIVE_WINDOW === "12-24") { ACTIVE_START_HOUR = 12; ACTIVE_END_HOUR = 24; }
else if (MODE === "mock") { ACTIVE_START_HOUR = 7; ACTIVE_END_HOUR = 22; } // local test, not enforced
else { throw new Error('ACTIVE_WINDOW phải là "0-12" hoặc "12-24" (đặt trong .env của bot này)'); }
const ACTIVE_START_MIN = ACTIVE_START_HOUR * 60;
const ACTIVE_END_MIN = ACTIVE_END_HOUR * 60;

const MIN_GAP_MIN = 45;            // at least 45 minutes between rounds
const MIN_DAILY_RUNS = Number(process.env.MIN_DAILY_RUNS || "0");   // a day can have 0 rounds
const MAX_DAILY_RUNS = Number(process.env.MAX_DAILY_RUNS || "10");
const HISTORY_KEEP = 300;          // keep at most 300 history lines
const RECENT_CONTEXT = 20;         // recent lines included in the prompt so the brain avoids repeats
const DEDUP_WINDOW = 15;           // only block repeats within the LAST N requests (doesn't ban a topic forever:
                                   // against the whole history, with few services and a less creative brain,
                                   // the space of "safe" questions runs out -> every proposal
                                   // duplicates -> endless skips, the bot stalls. The sliding window breaks that deadlock.)

const services = JSON.parse(fs.readFileSync(path.join(__dir, "services.json"), "utf8"));

// ---------- Utilities ----------
function ensureState() { fs.mkdirSync(STATE_DIR, { recursive: true }); }

function readJSON(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; }
}
function writeJSON(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }

// Time + date in Vietnam timezone (UTC+7)
function vnNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
function vnDateStr() { return vnNow().toISOString().slice(0, 10); }
function vnStamp() {
  const d = vnNow();
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function vnHour() { return vnNow().getUTCHours(); }
function vnMinuteOfDay() { const d = vnNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function withinActiveHours() {
  if (process.env.FORCE_ACTIVE === "1") return true; // bypass for testing
  const h = vnHour();
  return h >= ACTIVE_START_HOUR && h < ACTIVE_END_HOUR;
}

function logLine(service, request, ok) {
  const line = `${vnStamp()} – ${service} – ${request} – ${ok ? "Thành công" : "Thất bại"}`;
  fs.appendFileSync(LOG_FILE, line + "\n");
  console.log("LOG> " + line);
}

// Send a one-line summary to Telegram (if TELEGRAM_TOKEN + CHAT_ID are set). Best-effort, via curl (synchronous).
function sendTelegram(text) {
  const tok = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return;
  try {
    execFileSync("curl", ["-s", "-m", "15", "-X", "POST",
      `https://api.telegram.org/bot${tok}/sendMessage`,
      "--data-urlencode", `chat_id=${chat}`,
      "--data-urlencode", `text=${text}`], { stdio: "ignore" });
  } catch {}
}

// ---------- State: strikes & spend ----------
function loadStrikes() { return readJSON(STRIKES_FILE, {}); }
function saveStrikes(s) { writeJSON(STRIKES_FILE, s); }

function loadSpend() {
  const s = readJSON(SPEND_FILE, { date: vnDateStr(), spent: 0 });
  if (s.date !== vnDateStr()) return { date: vnDateStr(), spent: 0 }; // new day -> reset
  return s;
}
function saveSpend(s) { writeJSON(SPEND_FILE, s); }

// ---------- State: memory of services/requests called ----------
// Ensures: (1) no verbatim repeat of a past request, (2) no service
// used within the last COOLDOWN_CALLS rounds, forcing 3 consecutive rounds to be 3 completely
// different services (not only blocking one service twice in a row, because
// "Exa Search <-> Exa Answer" ping-pong slips through that rule).
const COOLDOWN_CALLS = 2;
function loadHistory() { return readJSON(HISTORY_FILE, []); }
function saveHistory(h) { writeJSON(HISTORY_FILE, h.slice(-HISTORY_KEEP)); }
function normReq(s) { return (s || "").toString().trim().toLowerCase(); }
function isDuplicateRequest(history, requestText) {
  const norm = normReq(requestText);
  return history.slice(-DEDUP_WINDOW).some((h) => normReq(h.request) === norm);
}
function cooldownServiceIds(history) {
  return new Set(history.slice(-COOLDOWN_CALLS).map((h) => h.serviceId));
}
function recentSummary(history) {
  return history.slice(-RECENT_CONTEXT).map((h) => `- ${h.service}: ${h.request}`).join("\n") || "(chưa có)";
}

// Add a random topic to the prompt each round so the brain converges less on a few repeated "safe" questions
// (old bug: geocoding the Eiffel Tower all week). Only a soft hint; the brain adapts it to the service.
const SEED_TOPICS = [
  "renewable energy", "ancient history", "marine biology", "space exploration",
  "culinary traditions", "modern architecture", "machine learning", "classical music",
  "volcanoes", "urban planning", "wildlife conservation", "cryptography",
  "coffee culture", "mountaineering", "linguistics", "electric vehicles",
  "coral reefs", "photography", "sustainable farming", "quantum physics",
  "medieval castles", "jazz history", "robotics", "desert ecosystems",
  "typography", "public health", "aviation", "geology",
  "street food", "renaissance art", "cybersecurity", "national parks",
  "astronomy", "textile crafts", "hydropower", "paleontology",
  "board games", "tea ceremonies", "famous bridges", "world folklore",
];
function pickSeedTopic() { return SEED_TOPICS[Math.floor(Math.random() * SEED_TOPICS.length)]; }

// ---------- State: random run plan for the day ----------
// Each day pick N rounds (MIN_DAILY_RUNS..MAX_DAILY_RUNS, may be 0) + N random times
// (at least MIN_GAP_MIN apart) within ACTIVE_START_MIN..ACTIVE_END_MIN.
// However often the daemon calls the engine, it only "fires" when reaching a time in the plan.
function genTargets() {
  const n = MIN_DAILY_RUNS + Math.floor(Math.random() * (MAX_DAILY_RUNS - MIN_DAILY_RUNS + 1));
  if (n === 0) return [];
  const span = ACTIVE_END_MIN - ACTIVE_START_MIN;
  for (let attempt = 0; attempt < 30; attempt++) {
    const pts = Array.from({ length: n }, () => ACTIVE_START_MIN + Math.floor(Math.random() * span)).sort((a, b) => a - b);
    let okGap = true;
    for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] < MIN_GAP_MIN) { okGap = false; break; }
    if (okGap) return pts;
  }
  return Array.from({ length: n }, (_, i) => ACTIVE_START_MIN + Math.floor((i + 0.5) * span / n)); // fallback: spread evenly
}

function loadPlan() {
  const today = vnDateStr();
  const p = readJSON(PLAN_FILE, null);
  if (p && p.date === today) return p;
  const fresh = { date: today, targets: genTargets(), done: [] };
  fresh.done = fresh.targets.map(() => false);
  writeJSON(PLAN_FILE, fresh);
  console.log(`[plan] Ngày mới -> chọn ${fresh.targets.length} lượt ngẫu nhiên: ${fresh.targets.map(fmtMin).join(", ") || "(0 lượt hôm nay)"} (giờ VN)`);
  return fresh;
}
function savePlan(p) { writeJSON(PLAN_FILE, p); }
function fmtMin(m) { return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }

// Has any planned time arrived and not run? If so, mark it used and return true.
function claimDueSlot(plan) {
  const now = vnMinuteOfDay();
  for (let i = 0; i < plan.targets.length; i++) {
    if (!plan.done[i] && plan.targets[i] <= now) {
      plan.done[i] = true;
      savePlan(plan);
      return true;
    }
  }
  return false;
}

// Services still alive (not struck off)
function activeServices(strikes) {
  return services.filter((sv) => (strikes[sv.id]?.fails || 0) < STRIKE_LIMIT);
}

// ---------- Call tempo-request (live) ----------
function tempoRequest({ url, method = "POST", body, headers = {}, maxSpend }) {
  // Retry against flaky payment-channel 403/5xx errors
  const args = ["-X", method, "--json", JSON.stringify(body),
    "-m", "120", "--retries", "3", "--retry-http", "403,408,429,500,502,503",
    "--retry-backoff", "1200", "--retry-jitter", "40", "--retry-after"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (maxSpend) args.push("--max-spend", String(maxSpend));
  if (PRIVATE_KEY) args.push("--private-key", PRIVATE_KEY);
  args.push(url);

  let stdout = "", ok = true, err = "";
  // TEMPO_BIN may be "tempo-request" or the launcher form "tempo request"
  const [bin, ...preArgs] = TEMPO_BIN.trim().split(/\s+/);
  try {
    stdout = execFileSync(bin, [...preArgs, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    ok = false;
    err = (e.stderr || e.message || "").toString();
    stdout = (e.stdout || "").toString();
  }

  // Treat a 4xx/5xx problem in the body as failure
  if (ok && /"status"\s*:\s*(4|5)\d\d/.test(stdout) && /payment-required|error|problem/i.test(stdout)) ok = false;

  return { ok, stdout, err };
}

// ---------- Brain (OpenAI, NOT via Tempo) ----------
// menu = services allowed for selection (strikes and 2-in-a-row cooldown filtered).
// avoidHint = extra hint when re-asking because the last proposal was a duplicate.
async function askBrain(menu, history, avoidHint) {
  const menuText = menu.map((s) => `- id="${s.id}" | ${s.name} | ${s.bodyHint}`).join("\n");
  const sys = `You are an autonomous agent that keeps a set of paid web APIs warm by exercising them with realistic, varied requests.
Rules:
- Choose exactly ONE service from the "Available services" list below.
- Never repeat a request that appears in "Recently used requests" — pick a genuinely different topic, query, or target every time.
- Return ONLY a compact JSON object, no prose, of the form:
{"serviceId":"<id>","body":{...},"note":"<short human summary of what you asked, <=8 words>"}`;
  const seed = pickSeedTopic();
  const user = `Available services:\n${menuText}\n\nRecently used requests (do NOT repeat any of these):\n${recentSummary(history)}\n\nFor variety this turn, lean your request loosely toward this theme (adapt it sensibly to whichever service you pick): "${seed}".${avoidHint ? "\n\n" + avoidHint : ""}\n\nPick one and produce the JSON now.`;

  if (MODE === "mock") {
    const s = menu[Math.floor(Math.random() * menu.length)];
    return { serviceId: s.id, body: s.mockBody, note: `mock: ${s.name}` };
  }

  if (!OPENAI_API) throw new Error("Thiếu OPENAI_API trong .env");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 300,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error("Gọi não OpenAI thất bại: " + JSON.stringify(json).slice(0, 300));

  const text = json?.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Não không trả JSON hợp lệ: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

// ---------- Call one service ----------
function callService(svc, body) {
  if (MODE === "mock") {
    const forcedFail = MOCK_FAIL.includes(svc.id);
    const ok = forcedFail ? false : Math.random() > 0.2; // 80% success
    return { ok, cost: ok ? svc.priceHint : 0 };
  }
  const res = tempoRequest({
    url: svc.url, method: svc.method, body,
    headers: { "content-type": "application/json" },
    maxSpend: svc.maxSpend,
  });
  return { ok: res.ok, cost: res.ok ? svc.priceHint : 0, detail: res.ok ? "" : (res.err || res.stdout).slice(0, 200) };
}

// ---------- Check wallet balance, warn on Telegram when low ----------
async function fetchBalanceUSD(address) {
  const data = "0x70a08231000000000000000000000000" + address.replace(/^0x/, "").toLowerCase();
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TOKEN_ADDRESS, data }, "latest"] }),
  });
  const json = await res.json();
  if (!json.result) throw new Error("eth_call lỗi: " + JSON.stringify(json).slice(0, 200));
  return Number(BigInt(json.result)) / 1e6; // TIP-20 decimals are always 6
}

async function checkBalance() {
  if (MODE !== "live" || !WALLET_ADDRESS) return;
  try {
    const bal = await fetchBalanceUSD(WALLET_ADDRESS);
    const alert = readJSON(BALANCE_ALERT_FILE, { alerted: false });
    console.log(`[balance] Ví còn ~$${bal.toFixed(3)} USDC.e`);
    if (bal <= LOW_BALANCE_USD && !alert.alerted) {
      sendTelegram(`⚠️ ${BOT_NAME}\nSố dư ví chỉ còn ~$${bal.toFixed(3)} USDC.e (dưới ngưỡng $${LOW_BALANCE_USD}). Cần nạp thêm.`);
      writeJSON(BALANCE_ALERT_FILE, { alerted: true });
    } else if (bal > LOW_BALANCE_USD && alert.alerted) {
      writeJSON(BALANCE_ALERT_FILE, { alerted: false });
    }
  } catch (e) {
    console.log("[balance] check thất bại: " + e.message);
  }
}

// ---------- One round ----------
async function runOnce() {
  if (!withinActiveHours()) {
    console.log(`[skip] Ngoài khung giờ hoạt động ${ACTIVE_START_HOUR}h-${ACTIVE_END_HOUR}h VN (đang ${vnHour()}h VN).`);
    return false;
  }
  const spend = loadSpend();
  if (spend.spent >= DAILY_CAP) {
    console.log(`[skip] Đã chạm trần ngày $${spend.spent.toFixed(4)}/$${DAILY_CAP}. Nghỉ tới mai.`);
    return false;
  }
  const plan = loadPlan();
  if (process.env.FORCE_ACTIVE !== "1" && !claimDueSlot(plan)) {
    const left = plan.targets.filter((_, i) => !plan.done[i]);
    console.log(`[skip] Chưa tới mốc ngẫu nhiên nào trong plan hôm nay. Còn chờ: ${left.map(fmtMin).join(", ") || "(hết mốc)"}`);
    return false;
  }
  const strikes = loadStrikes();
  const active = activeServices(strikes);
  if (active.length === 0) { console.log("[stop] Mọi dịch vụ đều đã bị gạch."); return false; }

  const history = loadHistory();
  const cooldownIds = cooldownServiceIds(history);
  let menu = active.filter((s) => !cooldownIds.has(s.id));
  if (menu.length === 0) {
    menu = active;
    console.log(`[diversity] Không còn dịch vụ nào ngoài ${COOLDOWN_CALLS} lượt gần nhất, bỏ qua rule cooldown.`);
  }

  let decision;
  try { decision = await askBrain(menu, history); }
  catch (e) { console.log("[error] " + e.message); return false; }

  let svc = menu.find((s) => s.id === decision.serviceId) || menu[Math.floor(Math.random() * menu.length)];
  let requestText = (decision.note || "").toString().slice(0, 80) || JSON.stringify(decision.body).slice(0, 60);

  if (isDuplicateRequest(history, requestText)) {
    console.log(`[dedup] Yêu cầu trùng lịch sử, thử hỏi lại 1 lần: "${requestText}"`);
    try {
      decision = await askBrain(menu, history, `Your previous suggestion "${requestText}" was already used before — pick something genuinely different.`);
      svc = menu.find((s) => s.id === decision.serviceId) || menu[Math.floor(Math.random() * menu.length)];
      requestText = (decision.note || "").toString().slice(0, 80) || JSON.stringify(decision.body).slice(0, 60);
    } catch (e) { console.log("[error] retry: " + e.message); return false; }
    if (isDuplicateRequest(history, requestText)) {
      console.log(`[skip] Vẫn trùng sau khi thử lại -> bỏ lượt này để không tốn tiền.`);
      return false;
    }
  }

  const r = callService(svc, decision.body);
  logLine(svc.name, requestText, r.ok);

  // Update strikes
  if (r.ok) {
    if (strikes[svc.id]) strikes[svc.id].fails = 0; // success -> clear strike
  } else {
    const s = strikes[svc.id] || { fails: 0 };
    s.fails += 1; s.lastError = r.detail || "";
    strikes[svc.id] = s;
    if (s.fails >= STRIKE_LIMIT) console.log(`[strike] "${svc.name}" fail ${s.fails} lần -> GẠCH khỏi danh sách.`);
  }
  saveStrikes(strikes);

  // Remember the service + request called (anti-duplicate next time)
  history.push({ ts: vnStamp(), serviceId: svc.id, service: svc.name, request: requestText });
  saveHistory(history);

  // Update spend (service cost only; OpenAI brain is billed separately and doesn't touch the USDC wallet)
  const cost = r.cost || 0;
  spend.spent = Math.round((spend.spent + cost) * 1e6) / 1e6;
  saveSpend(spend);
  console.log(`[spend] Lượt này ~$${cost.toFixed(5)} | Hôm nay $${spend.spent.toFixed(5)}/$${DAILY_CAP}`);
  sendTelegram(`🤖 ${BOT_NAME}\n${svc.name} — ${requestText}\n${r.ok ? "✅ Thành công" : "❌ Thất bại"} · ~$${cost.toFixed(4)} · hôm nay $${spend.spent.toFixed(3)}/$${DAILY_CAP}`);

  await checkBalance();
  return true;
}

// ---------- Main ----------
async function main() {
  ensureState();
  console.log(`=== tempo-runner | MODE=${MODE} | khung ${ACTIVE_START_HOUR}h-${ACTIVE_END_HOUR}h VN | ${vnStamp()} VN ===`);
  const iters = MODE === "mock" ? MOCK_ITERS : 1;
  for (let i = 0; i < iters; i++) {
    if (iters > 1) console.log(`\n--- lượt ${i + 1}/${iters} ---`);
    const cont = await runOnce();
    if (!cont && MODE === "mock") break;
  }
}

main();
