/* eslint-disable camelcase */

// WhatsApp as a first-class notification channel.
//
// Migration 018 gave notification_preferences a `whatsapp_to` column and a
// toggle, but nothing else: the channel assumed a phone number typed by hand
// was enough to deliver. It is not, because WhatsApp is not email.
//
// Two facts about the WhatsApp Business platform drive every column here:
//
// 1. A business may only send *freeform* text within 24 hours of the user's
//    most recent inbound message ("the customer service window"). Outside it,
//    both Twilio (error 63016) and Meta (error 131047) reject the send, and
//    only a pre-approved template goes through. FinChat's briefings are
//    scheduled, so they land outside the window most of the time — without
//    knowing when the window closes we can only fail and guess why.
//    `whatsapp_last_inbound_at` is that clock; the inbound webhook stamps it.
//
// 2. A number is not reachable just because it is well-formed. Twilio's
//    sandbox requires the user to enrol by messaging a join phrase, and Meta's
//    test numbers only reach an allow-list. `whatsapp_verified` records that
//    we have actually *heard from* this number, so the Settings page can say
//    "linked" rather than "saved and hoping".
//
// `whatsapp_provider` records which backend confirmed the link. Deployments
// can switch provider (sandbox → production sender) and a stale verification
// from the other provider should not be trusted.

exports.up = async (pgm) => {
  pgm.addColumns('notification_preferences', {
    // 'twilio' | 'meta' — set by the inbound webhook that verified the number.
    whatsapp_provider: { type: 'text' },
    // True once an inbound message from whatsapp_to has reached us.
    whatsapp_verified: { type: 'boolean', notNull: true, default: false },
    // Start of the current 24-hour freeform window. NULL = never heard from.
    whatsapp_last_inbound_at: { type: 'timestamptz' }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumns('notification_preferences', [
    'whatsapp_provider',
    'whatsapp_verified',
    'whatsapp_last_inbound_at'
  ]);
};
