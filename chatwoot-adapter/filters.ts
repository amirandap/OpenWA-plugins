import type { IncomingMessage } from '../types/openwa';

// Chat ids that are not a conversation with a person or a group: `@newsletter` is a WhatsApp Channel
// this account merely FOLLOWS, and `@broadcast` covers broadcast lists and `status@broadcast`.
//
// `isGroup` is a boolean over a five-way discriminator, so it cannot see these: a channel post arrives
// with isGroup false and was relayed as if a customer had written in, creating a Chatwoot contact and
// an open conversation per followed channel that an agent then has to triage and close by hand, and
// any reply is addressed to a chat this account cannot post to. Nothing filters them upstream: the
// host diverts only status broadcasts (message-projector, handleInboundMessage), and only when the
// adapter set isStatusBroadcast.
//
// Matched on the JID rather than `msg.kind`, which the host only stamps from 0.10.8 while this plugin
// declares 0.8.7. A denylist, so an id shape WhatsApp adds later keeps relaying rather than silently
// disappearing from the inbox.
const BROADCAST_JID_DOMAINS = new Set(['newsletter', 'broadcast']);

export function isBroadcastChat(chatId: string): boolean {
  const at = chatId.lastIndexOf('@');
  return at !== -1 && BROADCAST_JID_DOMAINS.has(chatId.slice(at + 1).toLowerCase());
}

// Relay only genuine engine-delivered inbound messages we didn't send ourselves. Groups are gated by
// relayGroups. Pure — no ctx.
export function shouldRelayInbound(msg: IncomingMessage, source: string, relayGroups: boolean): boolean {
  return (
    source === 'Engine' &&
    !msg.fromMe &&
    !!msg.chatId &&
    !isBroadcastChat(msg.chatId) &&
    (!msg.isGroup || relayGroups)
  );
}

// Relay the account's OWN outbound sends (composed on a linked phone or via the OpenWA API) so the
// Chatwoot thread mirrors WhatsApp (#615). The mirror of shouldRelayInbound with fromMe===true. The
// adapter's own Chatwoot-agent replies are ALSO fromMe and reach message:sent, but they're excluded
// out-of-band by the 'wa' send-id echo marker, not here. Pure — no ctx.
export function shouldRelayOwn(msg: IncomingMessage, source: string, relayGroups: boolean): boolean {
  return (
    source === 'Engine' &&
    msg.fromMe &&
    !!msg.chatId &&
    // Same exclusion as the inbound mirror: posting to a channel this account OWNS would otherwise
    // open a Chatwoot conversation for it, and an agent reply there goes nowhere useful.
    !isBroadcastChat(msg.chatId) &&
    (!msg.isGroup || relayGroups)
  );
}

// The contact Chatwoot's `Conversations::EventDataPresenter#push_meta` embeds as `meta.sender` on
// every conversation payload (webhook_data merges push_data, which already carries it) — the full
// `Contact#push_event_data`, not just the message's own `sender`. Read-only subset this adapter uses
// to resolve a conversation that has no chat-mapping yet.
export interface ChatwootContactMeta {
  id?: number;
  identifier?: string;
  phone_number?: string;
}

// The subset of a Chatwoot account-level webhook payload the adapter reads (message_created +
// conversation_updated). Everything is optional — Chatwoot omits fields per event/version.
export interface ChatwootWebhookMessage {
  event?: string;
  message_type?: string;
  private?: boolean;
  content?: string;
  id?: number;
  conversation?: {
    id?: number;
    status?: string;
    meta?: { assignee?: { id?: number } | null; sender?: ChatwootContactMeta };
    // `ContactInbox#as_json` default columns — present whenever the conversation's channel is an API
    // inbox. `source_id` is exactly what `client.createContact`/`findOpenConversation` would have
    // produced had this adapter created the conversation itself.
    contact_inbox?: { source_id?: string };
  };
  inbox?: { id?: number };
  sender?: { type?: string };
  attachments?: Array<{ id?: number; file_type?: string; data_url?: string }>;
  // Set when the agent used "Reply to": `in_reply_to_external_id` is the quoted message's source_id,
  // which is the WhatsApp message id for everything this adapter posts — so it can ride out as a quote.
  content_attributes?: { in_reply_to?: number; in_reply_to_external_id?: string };
  changed_attributes?: Array<Record<string, { current_value?: unknown; previous_value?: unknown }>>;
}

// WA chat id shape this adapter and the engine both use: digits, then a domain WhatsApp assigns.
// `@lid` is included even though a fresh operator-initiated contact will never carry one (no inbound
// message has happened yet to mint it) — matching the domains the adapter already accepts elsewhere
// keeps this one regex the single definition, rather than a second list that can drift from it.
const WA_ID_RE = /^\d+@(?:c\.us|lid|g\.us)$/;

// Best-effort WA phone digits for a Chatwoot contact whose chat isn't mapped yet — an operator-started
// conversation, which this adapter never created. Prefers the JID-shaped `identifier` this adapter
// itself writes on every contact it creates (so a contact IT made, re-attached to a fresh conversation
// by an operator, round-trips through the exact id it was keyed on); falls back to the contact's E.164
// `phone_number` for a contact created some other way (Chatwoot's own "new conversation" UI, a CSV
// import, another integration). Pure and synchronous: it only PROPOSES a candidate. `engine
// .checkNumberExists` is the source of truth for whether the number is real and what its canonical
// chat id actually is, so a caller must still confirm before trusting this value.
export function candidatePhoneDigits(sender: ChatwootContactMeta | undefined): string | undefined {
  if (!sender) return undefined;
  if (sender.identifier && WA_ID_RE.test(sender.identifier)) {
    return sender.identifier.slice(0, sender.identifier.indexOf('@'));
  }
  if (sender.phone_number) {
    const digits = sender.phone_number.replace(/\D/g, '');
    // Same E.164 shape relay.ts's resolvePhone enforces before ever handing a phone to Chatwoot: 7-15
    // digits, no leading 0. A too-short/garbled value is worse than no candidate — checkNumberExists
    // would spend a real WhatsApp lookup on it for nothing.
    if (/^[1-9]\d{6,14}$/.test(digits)) return digits;
  }
  return undefined;
}

// Relay only agent-visible outgoing replies in OUR inbox. Strict `private === false` (fail closed: an
// absent/non-false value is a private note or unknown shape and must never reach WhatsApp). This also
// drops the adapter's own `incoming` posts, so there is no echo loop.
export function shouldRelayOutbound(evt: ChatwootWebhookMessage, inboxId: number): boolean {
  return evt.inbox?.id === inboxId && evt.message_type === 'outgoing' && evt.private === false;
}
