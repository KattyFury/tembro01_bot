# tembro_bot: automatic Tempo airdrop bot (free on GitHub Actions)

The bot calls **paid services on Tempo (MPP)** to create regular on-chain activity and keep a wallet "alive" for the airdrop. The brain is **OpenAI** (called directly, NOT through Tempo, so it doesn't use the USDC budget). It runs **free on GitHub Actions**, reports to **Telegram**, and writes logs back to the repo.

Each round: the brain picks 1 service + writes a request → call → log → Telegram. **Three-layer repeat protection:** (1) the last 2 services are temporarily locked, so 3 rounds in a row are always 3 different services; (2) a request from the **last 15 rounds** can't repeat. If the brain still proposes a duplicate after one retry, the bot **skips the round at no cost**; (3) each round adds a **random topic** to the prompt.

> ⚠️ **Lesson (fixed):** the first version compared against the **entire** history. With few services and a less creative brain, the space of "safe" questions ran out, every proposal became a duplicate, and the bot **stalled for a week** while "online". The 15-question window plus random topics broke the deadlock.

A service failing 3 times is struck off. A daily spending cap means it **never exceeds budget** (default ~$5/month), and Telegram warns when the wallet runs low.

**Rounds per day are random and can be 0:** 0–10 per day. **Each bot must pick one half-day window (Vietnam time): `0-12` or `12-24`**, so parallel bots look natural and don't all wake together.

---

## 0. Source docs

| Content | Link |
|---|---|
| Install Tempo CLI | `curl -fsSL https://tempo.xyz/install \| bash` |
| Full docs index (LLM-readable) | https://tempo.xyz/developers/llms.txt |
| Tempo Wallet CLI | https://tempo.xyz/docs/cli/wallet |
| Machine Payments (agent) | https://tempo.xyz/docs/guide/machine-payments/agent |
| Wallet setup skill | https://tempo.xyz/SKILL.md |
| MPP service directory (web) | https://mpp.dev/services |
| Service directory (JSON) | https://mpp.dev/api/services |
| Get an OpenAI API key | https://platform.openai.com/api-keys |
| **USDC.e** token on Tempo | `0x20c000000000000000000000b9537d11c60e8b50` |

> 💡 Add `.md` to any docs URL for raw markdown.

---

## 1. Prepare (once, on your machine)

> 🖥️ The workflow always runs on **`ubuntu-latest`** (the sqlite3 step uses `apt-get`, so don't change it). Locally, `MODE=mock` works on any OS. The Tempo CLI install and `MODE=live` are bash; on Windows use **Git Bash** or **WSL**.

Needs **Node.js** and **Git**. Install the Tempo CLI:

```bash
curl -fsSL https://tempo.xyz/install | bash
export PATH="$HOME/.tempo/bin:$PATH"
tempo --version
```

### 1a. Have ~$5 USDC.e on Tempo

```bash
tempo wallet login          # sign in with email/passkey
tempo wallet fund           # USDC top-up flow (fiat/on-ramp)
tempo wallet whoami         # check balance (need ~$5 USDC.e)
```

*(Or bridge USDC from another chain via Circle CCTP, see Tempo docs.)*

### 1b. Create a **dedicated bot key** (the key step ⚠️)

**Do NOT use a login credential on GitHub Actions**: it lives in the local keyring and expires. Use a **raw private key**, which never expires:

```bash
# create a key pair with viem (needs: npm i viem, or run in a project with viem)
node -e 'import("viem/accounts").then(({generatePrivateKey,privateKeyToAccount})=>{const pk=generatePrivateKey();console.log("PRIVATE_KEY=",pk);console.log("ADDRESS=",privateKeyToAccount(pk).address)})'
```

Save `PRIVATE_KEY` (secret!) and `ADDRESS` (public, used in 1c and as `WALLET_ADDRESS` in section 2).

### 1c. Fund the bot key

```bash
# tempo wallet transfer <amount> <USDC.e token> <bot key ADDRESS>
tempo wallet transfer 5 0x20c000000000000000000000b9537d11c60e8b50 <ADDRESS>
```

> ⚠️ This is a **hot wallet**: only a few dollars you can afford to lose. Never commit `PRIVATE_KEY`.

### 1d. Get an OpenAI API key

Create a key at https://platform.openai.com/api-keys and add a few dollars of credit (`gpt-4o-mini` is cheap, see section 5).

---

## 2. Set up on GitHub

1. **Fork** this repo (keep it **public** for unlimited free Actions minutes).
2. **Settings → Secrets and variables → Actions → New repository secret:**

   | Secret | Value |
   |---|---|
   | `TEMPO_PRIVATE_KEY` | bot private key (1b) |
   | `OPENAI_API` | OpenAI API key (1d), **required**; without it the bot fails on the first round |
   | `TELEGRAM_TOKEN` | your Telegram bot token (from @BotFather) |
   | `TELEGRAM_CHAT_ID` | chat id for notifications |

3. **Variables** tab:

   | Variable | Value |
   |---|---|
   | `ACTIVE_WINDOW` | `0-12` or `12-24` (Vietnam time), **required**. Multiple bots use different windows |
   | `WALLET_ADDRESS` | bot wallet address (1b), so it checks its balance and warns on Telegram |
   | `DAILY_CAP` | `0.16` (~$5/month). Lower to spend less *(optional)* |

4. **Actions** tab → enable the workflow.
5. **Run workflow** to test now (a manual run skips the window *and* the random plan), or wait for cron during your `ACTIVE_WINDOW`.

Each round then messages Telegram and updates `state/log.txt`.

### ⚠️ Running more than 1 bot

Change the **minutes** in the `cron` line of `.github/workflows/run.yml` for **each bot**. Don't use identical `*/15` or `*/30`: GitHub's cron gets congested and drops runs on shared minutes. Suggestions (one line per person):

```
"3,18,33,48 0-15 * * *"
"8,23,38,53 0-15 * * *"
"13,28,43,58 0-15 * * *"
"1,16,31,46 0-15 * * *"
"6,21,36,51 0-15 * * *"
```

Also **change `ACTIVE_WINDOW`** per bot.

---

## 3. Free test before spending

```bash
# simulate 15 rounds, NO network, NO money:
MODE=mock FORCE_ACTIVE=1 MOCK_ITERS=15 node engine.mjs
```

Check the log format `Thời gian – Dịch vụ – Yêu cầu – Thành/Bại` (time – service – request – pass/fail) and that strikes and the budget stop work. Over enough rounds you'll see `[dedup]` and `[diversity]`, the repeat protection at work.

To see how the engine picks random times (without forcing a run):

```bash
MODE=mock MOCK_ITERS=1 node engine.mjs
```

See the `[plan] Ngày mới -> chọn N lượt ngẫu nhiên: ...` line for that day's times (0 is normal).

---

## 4. Customize

| Goal | Where |
|---|---|
| Add/remove services | `services.json` (url, method, priceHint, bodyHint) |
| Daily budget | Variable `DAILY_CAP` (default $0.16) |
| Brain model | env `OPENAI_MODEL` (default `gpt-4o-mini`) |
| Failures before a strike-off | env `STRIKE_LIMIT` (default **3**) |
| Rounds per day (random, may be 0) | env `MIN_DAILY_RUNS` / `MAX_DAILY_RUNS` (default **0**-10) |
| Active window | Variable `ACTIVE_WINDOW` = `"0-12"` or `"12-24"` (required) |
| Low-balance warning | env `LOW_BALANCE_USD` (default $1, needs `WALLET_ADDRESS`) |
| Cron frequency | `cron` in `.github/workflows/run.yml` (UTC = Vietnam − 7). Denser polling catches more random times |

Find more cheap services: `tempo wallet services --search <keyword>` or https://mpp.dev/services

> ⚠️ **Before adding a service to `services.json`, ALWAYS test one live call first.** When the list was expanded (2026-07-08), several new services (IPinfo, Holidays, Timezone, Exchange Rates, Codex) returned 500/502 from their own infrastructure (e.g. Codex `ECONNREFUSED 127.0.0.1:4001`). There are signs the wallet is charged even when a call fails, since MPP payment may happen before the upstream is known to work. Safe test:
> ```bash
> # call one endpoint directly, not via the brain, to confirm the body and that the service is alive:
> tempo-request -X POST --json '<sample body>' --private-key <test wallet key> <service url>
> ```
> Add it only after a real successful response.

---

## 5. Cost

**MPP services** (Exa, Firecrawl, fal, Codex...): measured **~$0.001–0.01/round**. With 0–10 rounds/day, at most **~$0.16/day (~$5/month)**. `DAILY_CAP` enforces the ceiling.

**OpenAI brain** (`gpt-4o-mini`): billed **separately to your OpenAI account**, not the USDC wallet or `DAILY_CAP`. A few hundred tokens per round, under $0.001.

---

## 6. Common errors

| Error | Cause / fix |
|---|---|
| `Thiếu OPENAI_API trong .env` | Secret `OPENAI_API` not set (section 2) |
| `ACTIVE_WINDOW phải là "0-12" hoặc "12-24"` | Variable `ACTIVE_WINDOW` missing or wrong |
| `[dedup] ... [skip] Vẫn trùng sau khi thử lại` | **Normal.** The brain proposed a duplicate twice, so the bot skipped the round at no cost |
| `spawn sqlite3 ENOENT` | sqlite3 missing. The workflow installs it; locally: `apt install sqlite3` |
| `HTTP 403 Request not allowed` | Payment-channel flakiness under bursts. The engine has `--retries` |
| `verification-failed` / asks to log in | You're using a **login credential** instead of `--private-key`. Use the raw key (1b) |
| Run stays `queued` | Actions disabled → Settings → Actions → allow |
| No rounds all day | May be normal (random 0–10). Compare `state/plan.json` with `state/log.txt` |

---

## 7. How it works

```
GitHub Actions (cron polls every ~15 minutes, offset per bot)
  → install Tempo CLI + sqlite3
  → engine.mjs:
      state/plan.json: does today have a plan of 0-10 random times
      within ACTIVE_WINDOW (0-12 or 12-24 Vietnam)?
        No -> pick N (0-10) random times and save.
      Reached an unused time in the plan?
        No -> skip, no cost, no log.
        Yes -> mark used and continue:
          Read state/history.json (past services + questions)
            -> remove services just used from the choices
          OpenAI (direct, not via Tempo) picks 1 service + writes a request
            (prompt includes 1 random topic per round)
            -> if it duplicates one of the last 15 rounds, ask once more;
               still a duplicate: skip, no call, no cost
          → call the service (tempo request --private-key)
          → write state/log.txt + state/history.json, count spend (DAILY_CAP),
            strike off services failing 3 times
          → check on-chain balance (USDC.e, balanceOf via RPC), Telegram
            warning if below LOW_BALANCE_USD
          → send Telegram
  → commit state/ back to the repo
```

State (`state/log.txt`, `spend.json`, `strikes.json`, `plan.json`, `history.json`) is committed each round because Actions keeps nothing between runs.

---

## 8. Safety

- Private key + OpenAI key live in **GitHub Secrets**, never in code. `.gitignore` blocks `.env`.
- The bot key is a **hot wallet** with a few dollars.
- The repo is **public** for free Actions, but **no secret is in the code**.
- **Never** embed a GitHub token (PAT) in a remote URL or `git config --global url.insteadOf`; a leak exposes *every* repo. For auto-push, use a fine-grained token scoped to 1–2 repos with an expiry, set only on that repo's remote.

---

## 9. Fork your own bot

1. Follow section 1 in order: Tempo wallet → dedicated key → funding → OpenAI key → fork → Secrets/Variables → enable Actions.
2. If you're the 2nd, 3rd... person in a group, **change the cron minutes AND `ACTIVE_WINDOW`** (section 2).
3. Don't raise `DAILY_CAP` or disable `STRIKE_LIMIT` on your own: a failing service can burn money unnoticed.
