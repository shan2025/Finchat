# WhatsApp notifications

FinChat can deliver alerts, mission reports and morning briefings over
WhatsApp. The code is complete and tested; what remains is credentials, which
only you can create.

Pick **one** provider. Both are free to start.

| | Twilio sandbox | Meta Cloud API |
|---|---|---|
| Setup time | ~5 min | ~15 min |
| Account needed | Twilio (phone verification) | Meta developer + business |
| Cost | Free trial credit | Free tier, permanent |
| Who can receive | Anyone who sends the join phrase | Up to 5 numbers you allow-list (test number) |
| Re-enrolment | Every 72 hours | Never |

Twilio is faster to get working. Meta is better if you want it to keep working
without re-joining every three days.

---

## The one thing that will confuse you

WhatsApp does not let a business send whatever it likes whenever it likes.

**You may send freeform text only within 24 hours of the user's last inbound
message.** Outside that window WhatsApp accepts *only* a pre-approved
template. Twilio rejects freeform sends with error `63016`; Meta with `131047`.

This matters because FinChat's briefings are scheduled. A briefing at 07:00
lands outside the window unless you messaged the bot the evening before.

FinChat handles this rather than hiding it:

- The inbound webhook stamps `whatsapp_last_inbound_at` on every message you
  send, and the Settings page shows how much of the window is left.
- When the window is closed, the channel sends your configured template
  instead. With no template configured it records the delivery as `skipped`
  with an explanation, rather than a bare provider error.
- If our clock disagrees with the provider, the provider wins — a freeform
  send rejected as out-of-window is retried as a template automatically.

So: **for scheduled briefings to arrive reliably, configure a template.**
Without one you'll only receive things that happen while you're already
chatting with the bot.

---

## Option A — Twilio sandbox

1. Sign up at [twilio.com](https://www.twilio.com/try-twilio).
2. Console → **Messaging → Try it out → Send a WhatsApp message**. You'll see
   the sandbox number (usually `+1 415 523 8886`) and a join phrase like
   `join fresh-owl`.
3. Console home → copy **Account SID** and **Auth Token**.
4. In `legacy_prototype/backend/.env`:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=+14155238886
TWILIO_WHATSAPP_JOIN_CODE=join fresh-owl
WHATSAPP_PROVIDER=twilio
```

5. Set the inbound webhook (see below), then restart the backend.

Sandbox caveats: every recipient must send the join phrase, enrolment expires
after 72 hours of inactivity, and messages carry a Twilio prefix.

## Option B — Meta Cloud API

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My
   Apps → Create App → Business**.
2. Add the **WhatsApp** product. Under **API Setup** you get a test phone
   number, its **Phone number ID**, and a temporary access token.
3. On that page, add your own number under **To** and verify it — the test
   number only reaches allow-listed numbers (max 5).
4. Swap the 24-hour token for a permanent one: **Business Settings → System
   Users →** add a user, assign the app, generate a token with
   `whatsapp_business_messaging` and `whatsapp_business_management`.
5. In `.env`:

```
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_SENDER_NUMBER=+15550001234
WHATSAPP_PROVIDER=meta
```

`WHATSAPP_SENDER_NUMBER` is only used to build the `wa.me` link the Settings
page shows you — it doesn't affect delivery.

---

## The inbound webhook

Linking and the 24-hour clock both depend on FinChat *receiving* your
messages. WhatsApp has no polling API (unlike Telegram), so the provider must
be able to reach `POST /api/whatsapp/webhook` over the public internet.

**Deployed (Render).** Your instance is already public:

```
https://finchat-6.onrender.com/api/whatsapp/webhook
```

**Locally.** Run a tunnel to port 3000 and use the URL it prints:

```bash
npx ngrok http 3000
```

Then register it:

- **Twilio** — Messaging → sandbox settings → *When a message comes in* → paste
  the URL, method `POST`. Also set `WHATSAPP_WEBHOOK_URL` in `.env` to the
  exact same string; Twilio signs the URL it called, and a mismatch fails the
  signature check.
- **Meta** — App → WhatsApp → Configuration → **Edit** callback URL. Paste the
  URL and any string as the verify token, put the same string in
  `WHATSAPP_VERIFY_TOKEN`, then subscribe to the **messages** field. Copy App
  Settings → Basic → **App Secret** into `WHATSAPP_APP_SECRET`.

Check it from anywhere with:

```bash
curl https://finchat-6.onrender.com/api/whatsapp/health
```

The endpoint is signature-authenticated because it writes to user records — an
unsigned POST could otherwise point someone's WhatsApp channel at an
attacker's number. Requests without a valid `X-Twilio-Signature` or
`X-Hub-Signature-256` get a 403.

`WHATSAPP_WEBHOOK_INSECURE=true` disables that check. It exists for tunnels
that rewrite the host header. Do not set it on a deployed instance.

### Without a webhook

Everything still works except linking and window tracking. Type your number
into Settings, save, and FinChat will attempt freeform sends. They'll succeed
while your window happens to be open and fail with a clear message otherwise.

---

## Templates (for scheduled briefings)

**Twilio** — Console → Content Template Builder → create a template with one
variable, submit for WhatsApp approval, then set the Content SID:

```
TWILIO_CONTENT_SID=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Meta** — WhatsApp Manager → Message Templates → create one with a single
`{{1}}` body parameter, category *Utility*, and wait for approval:

```
WHATSAPP_TEMPLATE_NAME=finchat_alert
WHATSAPP_TEMPLATE_LANG=en_US
```

FinChat passes the notification summary as that single parameter, flattened to
one line (WhatsApp rejects newlines and tabs in template parameters).

---

## Linking your number

Settings → Notification channels → toggle **WhatsApp** → **Link WhatsApp
automatically**.

FinChat mints a short code (`FCxxxxxx`) and opens WhatsApp with the message
prefilled. Send it; the webhook matches the code, records your number as
verified, and opens your window. On Twilio there's an extra first step to send
the join phrase — the page shows both links in order.

Codes last 15 minutes and are single-use. Changing your number in Settings
clears the verification, because a saved number is not a reachable one.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "server not configured" badge | No provider credentials in `.env`, or `WHATSAPP_PROVIDER` names one you haven't filled in. `/api/whatsapp/health` says which. |
| Linking times out | The webhook isn't reachable. Check `/api/whatsapp/health`, and that the tunnel is still up. |
| `[63016]` / `[131047]` | Outside the 24-hour window. Message the bot, or configure a template. |
| `[63032]` | You haven't sent the Twilio sandbox join phrase, or the 72-hour enrolment lapsed. |
| `[131030]` | Number isn't on the Meta test number's allow-list. |
| `[190]` | Meta access token expired — you're still on the 24-hour one from API Setup. |
| `[21211]` | Number rejected. Include the country code with a leading `+`. |
| Delivery log says `skipped` | Window closed and no template configured. |
| Nothing arrives on Render, works locally | Free-tier instances sleep. Briefings fire from the external cron hitting `/api/cron/tick`. |

Every attempt is recorded in `notification_deliveries` and shown under **Recent
deliveries** on the Settings page, with the provider's reason.

---

## Files

| Path | Role |
|---|---|
| `backend/services/whatsapp.js` | Provider abstraction, E.164, splitting, window logic, error mapping |
| `backend/routes/whatsappWebhook.js` | Inbound messages, signature checks, linking |
| `backend/services/notificationChannels.js` | Fan-out to every enabled channel |
| `backend/routes/settings.js` | Prefs, link flow, per-channel test |
| `backend/test/whatsapp.test.js` | 39 tests, incl. a stub provider for the send paths |
| `backend/migrations/1720000000027_whatsapp-channel.js` | Link + window columns |
