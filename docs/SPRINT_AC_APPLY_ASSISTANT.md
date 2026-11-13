# Sprint AC — Apply Assistant (browser extension autofill)

**Status:** Plan — nothing built yet
**Written:** 2026-10-10

---

## 0. Decision: FinChat fills, the human signs in and submits

FinChat finds jobs, checks your chances, tailors your resume and writes your cover
letter. A **Chrome (MV3) extension** then fills in the application form in
**your own browser**, where you are already signed in to LinkedIn, Naukri,
Workday and the other sites.

Who does what:

| Step | Who |
|---|---|
| Find jobs that suit you | FinChat (daily hunt + on demand) |
| Estimate your chances | FinChat (fit report) |
| Tailor the resume and write the cover letter for that job | FinChat |
| Sign in, passwords, 2FA, CAPTCHA | **You** |
| Fill in the form fields, attach the tailored resume PDF | Extension |
| Review the highlighted fields, click **Submit** | **You** |
| Mark it applied in the ledger | Extension asks, you confirm |

Why the extension never presses Submit: a submitted application can't be taken
back, and it goes to a real recruiter under your name. That matches the rule FinChat
already follows (`job_applications.status` can only become `applied` with
`userConfirmed`; `ApplyDraftTool` is draft-only).

Why an extension and not a server-side bot: your logins never leave your
browser, FinChat stores no third-party passwords, and it works on any site
without a headless Chrome per user on the backend.

The extension works in Chrome, Edge and Brave (all Chromium).

---

## 1. What already exists (reuse, don't rebuild)

| Need | Already in the codebase |
|---|---|
| Find jobs | `jobs` tool (`tools/JobsTool.js`), `matchSearch` in `services/jobMatcher.js` (search → score → draft), `gmail {"action":"match"}` → `matchInbox` (job-alert emails) |
| Score fit | `ResumeTool.scoreResume` (keyword taxonomy, 8 roles), LLM `SCORE_PROMPT` / `MATCH_PROMPT` in `jobMatcher.js` |
| Tailor resume | `resume {"action":"tailor"}` — no invented experience, lists changes and gaps |
| Cover letter | `apply_draft` (`tools/ApplyDraftTool.js`) |
| Ledger | `job_applications` (url-deduped, `match_score`, `draft`, status rules) |
| Stored resume | `user_resumes` |
| PDF / DOCX | `pdfkit` (write), `pdf-parse` + `mammoth` (read) already in `package.json` |

## 2. Gaps to close

1. **No applicant profile.** A form needs your phone, city, LinkedIn/GitHub
   URLs, work authorization, notice period, current/expected CTC, years of
   experience, education and graduation year. FinChat only stores the resume
   text.
2. **No answers bank.** Questions like "Why this company?", "Are you willing to
   relocate?" or "Years of Python?" come up again and again. Once you approve an
   answer it should be reused.
3. **No REST API for this.** Resume and applications live only in agent tools.
   The extension needs `/api/apply/*`.
4. **The tailored resume isn't saved and isn't a file.** `tailor` returns
   markdown and throws it away. The form needs a PDF to upload.
5. **The fit score is shallow.** `matchSearch` scores from a 400-char snippet,
   and `scoreResume` only knows 8 roles. Answering "do I have a chance?" needs the
   full job description and a structured answer.
6. **Extension auth.** `requireAuth` (`middleware/auth.js`) accepts **any** JWT
   with a `userId` signed with `JWT_SECRET`, so handing the extension a normal
   session token would give it full account access. It needs its own scoped,
   revocable token.

---

## 3. Backend design

### 3.1 Migration `1720000000065_apply-assistant` (064 is taken by knowledge-owner)

```
applicant_profiles   user_id PK → users
                     full_name, email, phone, city, country,
                     linkedin_url, github_url, portfolio_url,
                     work_authorization, needs_sponsorship bool,
                     notice_period_days, years_experience,
                     current_ctc, expected_ctc, currency,
                     education jsonb, preferences jsonb   -- roles, locations, remote, min salary
                     updated_at
application_answers  answer_id PK, user_id, question_norm, question_raw,
                     answer, times_used, updated_at
                     UNIQUE (user_id, question_norm)
extension_tokens     token_id PK, user_id, token_hash, label, scopes text[],
                     created_at, last_used_at, revoked_at
job_applications     + tailored_resume text, + fit_report jsonb, + job_description text
```

RLS on all three new tables, following `1720000000038_rls-on-chat-task-tables.js`.

> The local backend talks to the production Supabase. The migration is applied
> only after review; UI and route tests use mocks.

### 3.2 Routes — `routes/apply.js` mounted at `/api/apply`

| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/profile` | Applicant profile (also editable on Settings) |
| GET/PUT/DELETE | `/answers` | Answers bank |
| POST | `/analyze` | `{url, title?, company?, description?}` → fetches the full JD if missing, returns the fit report and creates/updates the ledger row |
| POST | `/:applicationId/prepare` | Tailors the resume and writes the cover letter for that row (stored on the row) |
| GET | `/:applicationId/resume.pdf` | Tailored resume rendered with pdfkit |
| POST | `/fill-plan` | `{applicationId, fields:[…]}` → a value per field (see 4.3) |
| POST | `/:applicationId/submitted` | You confirmed you submitted → `status='applied'`, `applied_at` |
| POST | `/extension/pair` · DELETE `/extension/:tokenId` | Pairing and revoking |

Every route except `pair` uses a new `requireExtensionOrUser` middleware that
accepts either a normal session JWT or an extension token. Extension tokens
can **only** reach `/api/apply/*`.

### 3.3 Extension pairing

1. Settings → "Connect browser extension" shows a 6-digit code (valid for 5 min, stored hashed).
2. You type the code into the extension popup → `POST /api/apply/extension/pair`.
3. The server returns an opaque random token (stores only a SHA-256 hash in
   `extension_tokens`, scope `apply`). It's revocable from Settings.
4. The `chrome-extension://<id>` origin is added to `ALLOWED_ORIGINS` in `server.js`.

### 3.4 Fit report ("do I have a chance?")

There's no honest way to give an exact probability of being hired. The report
gives a **band** with the reasons behind it:

```json
{
  "band": "strong | reasonable | long_shot",
  "score": 74,
  "mustHaves":   [{"req": "SQL", "met": true,  "evidence": "Analyst intern — built SQL dashboards"}],
  "missing":     [{"req": "2+ yrs product experience", "closable": false}],
  "seniority":   "match | stretch | overqualified",
  "logistics":   {"location": "ok", "workAuth": "ok", "noticePeriod": "ok"},
  "competition": {"postedDaysAgo": 2, "applicants": "100+", "note": "early — apply soon"},
  "advice":      ["Lead with the dashboard project", "Mention the CFA L1 attempt"]
}
```

- The **full JD** comes from the `fetch` tool (Jina fallback), or from the
  extension when you're already on the page (most reliable, especially for LinkedIn).
- Deterministic checks run before the LLM: years asked vs years on the resume,
  location vs preferences, sponsorship vs `needs_sponsorship`. A hard mismatch caps
  the band, so the LLM can't talk it up.
- **Competition signals** (posting age, applicant count) are read from the page
  by the extension when shown.
- **Calibration loop (Phase 5):** once the ledger has outcomes
  (`interviewing` / `rejected` / `offer`), compare them with the predicted band
  and adjust the thresholds per user.

### 3.5 Better job finding

- `applicant_profiles.preferences` feeds the `interests` / `region` that
  `matchSearch` and `matchInbox` take today, so the daily hunt stops guessing.
- Run the daily hunt over the full JD (fetched) only for the top ~5 snippet
  matches, to keep inference cost bounded.
- Output: a **"Ready to apply" queue** (strong band, resume and letter prepared). Each
  item opens the posting with the extension ready to fill.

---

## 4. Extension design — `legacy_prototype/extension/`

```
manifest.json        MV3; permissions: storage, sidePanel, activeTab, scripting
                     optional_host_permissions per job site (asked on first use)
background.js        token, API calls, PDF download → Blob for upload
sidepanel.html/.js   fit report · tailored resume diff · cover letter · Fill · field review
content/detect.js    finds the form, extracts the JD + field descriptors
content/fill.js      sets values the way the frameworks expect
adapters/            greenhouse.js lever.js ashby.js workday.js linkedin.js naukri.js indeed.js generic.js
```

### 4.1 Flow on a job page

1. You open a posting → the side panel shows **Analyze**. It sends the JD text and URL to `/analyze` and shows the fit report.
2. **Prepare** → tailored resume (with a "what changed" diff) and cover letter. You can edit both.
3. On the application form → **Fill**. The adapter collects field descriptors and calls `/fill-plan`, then fills in the values.
4. Fields are colour-coded: green = filled from your profile, amber = check this
   (AI-written or low confidence), red = left blank on purpose (needs you).
5. Multi-page forms (Workday, LinkedIn Easy Apply): a `MutationObserver` notices
   the next step and offers Fill again. **You click Next and Submit.**
6. When it detects a confirmation page or URL, it asks "Did you submit?". Yes →
   `/submitted`, and anything you edited is saved to the answers bank.

### 4.2 Field descriptors (what leaves the page)

```json
{ "id": "f12", "label": "Expected CTC (LPA)", "type": "text|select|radio|checkbox|file|textarea",
  "options": ["…"], "required": true, "autocomplete": "tel", "section": "Screening questions" }
```

The label comes from `label[for]`, `aria-label`, `aria-labelledby`, `placeholder`, or
the nearest heading/text. Nothing else is read from the page: no cookies, no other inputs' values.

### 4.3 Fill plan (server)

In order of trust:

1. **Deterministic profile mapping**: `autocomplete` attributes and label regexes
   (name, email, phone, LinkedIn, city, years of experience).
2. **Answers bank**: normalized question match.
3. **LLM** for free-text questions only. Its inputs are the profile, the resume,
   the JD and the question. Its output is strict JSON keyed by the field ids it
   was given. Same rule as `tailor`: never invent facts.
4. **Always left blank for you**: salary when not in your profile, EEO / gender /
   disability / veteran / criminal-record questions, legal declarations, "I certify…" checkboxes.

Each value comes back as `{id, value, source: profile|bank|ai, confidence}`.

### 4.4 Filling that actually sticks

- React and Vue inputs: call the native `HTMLInputElement.prototype.value` setter,
  then dispatch `input` + `change` + `blur`. Assigning `.value` directly gets
  wiped on the next render.
- File upload: `DataTransfer` + `input.files = dt.files` with the PDF Blob, then `change`.
- Custom dropdowns (Workday, react-select, LinkedIn): per-adapter click → type → pick option.
- Never touched: `input[type=password]`, CAPTCHA iframes (reCAPTCHA, hCaptcha,
  Turnstile), and anything labelled submit, apply or send.

### 4.5 Site order

| Order | Sites | Why |
|---|---|---|
| 1 | Greenhouse, Lever, Ashby | Plain one-page forms, usually no login. Many startups use them |
| 2 | LinkedIn Easy Apply, Naukri | Most of your alert volume (`sourceOf` in `jobMatcher.js`) |
| 3 | Workday, Indeed | Multi-page or custom widgets — the most adapter work |
| — | Generic | Best-effort label matching on any other site |

---

## 5. Safety

- **Prompt injection.** JD text is untrusted. It reaches the LLM only as data,
  and the LLM's only power is to propose values for the given field ids, which
  you then see highlighted. The extension never navigates, clicks or submits
  based on model output.
- **Least privilege.** Site access is an optional host permission granted per site,
  not `<all_urls>`. The extension token can reach only `/api/apply/*` and can be revoked.
- **Sensitive data.** Salary and work-auth go to a page only when a visible field
  asks for them, and they're always marked amber for review.
- **Pacing.** One job at a time, driven by you. No bulk "apply to 50 jobs".
  LinkedIn's terms forbid automated activity. A human-paced fill that you
  submit yourself is how tools like Simplify work, but bulk automation is what
  gets accounts restricted.
- **Web Store listing** needs a privacy policy. That's already an open item in
  `SPRINT_AB_MOBILE.md` (Phase 5). Until then the extension loads unpacked.

---

## 6. Phases

| Phase | Outcome | Work | Effort |
|---|---|---|---|
| **1 — Foundations** | Profile, answers bank, scoped extension tokens, tailored resume saved and downloadable as PDF | Migration 065, `routes/apply.js`, `requireExtensionOrUser`, pdfkit renderer, Settings → Profile + Connect extension, tests | 2–3 days |
| **2 — Fit report** | "Do I have a chance?" answered with a band, reasons and advice, in chat and the ledger | Full-JD fetch, deterministic caps, structured report, `resume`/`apply_draft` reuse, Applications view | 2 days |
| **3 — Extension MVP** | Fill and upload on Greenhouse, Lever, Ashby and generic forms; you submit | MV3 scaffold, pairing, side panel, detect/fill, 3 adapters, submitted → ledger | 3–4 days |
| **4 — Big boards** | LinkedIn Easy Apply, Naukri, Workday, Indeed | Multi-step observer, custom-widget adapters | 4–6 days |
| **5 — Closing the loop** | Daily "Ready to apply" queue; fit bands calibrated against real outcomes | Mission output → queue, outcome stats, threshold tuning | 2 days |
| **6 — Store (optional)** | Chrome Web Store listing | Privacy policy, listing assets, review | ~1 week incl. review |

## 7. Open decisions

1. **Auto-click Submit?** Recommended **no** (see §0). You review and click.
2. **Where salary and work-auth live.** Recommended: server-side in
   `applicant_profiles` (RLS, same as resumes), so the daily hunt can use them
   for filtering. The alternative, extension-only `chrome.storage`, is more
   private but the agent can't see it.
3. **First adapters.** Recommended: Greenhouse / Lever / Ashby to prove the
   engine, then LinkedIn Easy Apply + Naukri.
