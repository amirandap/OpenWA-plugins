import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRelayInbound, shouldRelayOutbound, shouldRelayOwn, candidatePhoneDigits } from './filters.ts';

const base = {
  id: 'm1',
  from: 'x',
  to: 'y',
  chatId: 'c',
  body: 'hi',
  type: 'chat',
  timestamp: 0,
  fromMe: false,
  isGroup: false,
} as const;

test('inbound: Engine + not fromMe + has chatId; drops API, fromMe, and groups when relayGroups=false', () => {
  assert.equal(shouldRelayInbound(base, 'Engine', true), true);
  assert.equal(shouldRelayInbound({ ...base, fromMe: true }, 'Engine', true), false);
  assert.equal(shouldRelayInbound(base, 'API', true), false);
  assert.equal(shouldRelayInbound({ ...base, isGroup: true }, 'Engine', false), false);
  assert.equal(shouldRelayInbound({ ...base, isGroup: true }, 'Engine', true), true);
});

test('own-outbound: Engine + fromMe + has chatId; drops inbound, API source, empty chatId, and groups when relayGroups=false', () => {
  const own = { ...base, fromMe: true } as const;
  assert.equal(shouldRelayOwn(own, 'Engine', true), true);
  assert.equal(shouldRelayOwn({ ...own, fromMe: false }, 'Engine', true), false); // inbound is not an own send
  assert.equal(shouldRelayOwn(own, 'API', true), false); // only engine-delivered creates
  assert.equal(shouldRelayOwn({ ...own, chatId: '' }, 'Engine', true), false); // no target chat
  assert.equal(shouldRelayOwn({ ...own, isGroup: true }, 'Engine', false), false);
  assert.equal(shouldRelayOwn({ ...own, isGroup: true }, 'Engine', true), true);
});

test('outbound: strict private — relay only outgoing + private===false in the configured inbox', () => {
  const ok = { message_type: 'outgoing', private: false, inbox: { id: 7 }, conversation: { id: 1 }, content: 'r' };
  assert.equal(shouldRelayOutbound(ok, 7), true);
  assert.equal(shouldRelayOutbound({ ...ok, message_type: 'incoming' }, 7), false); // echo
  assert.equal(shouldRelayOutbound({ ...ok, private: true }, 7), false); // private note
  assert.equal(shouldRelayOutbound({ ...ok, private: undefined }, 7), false); // absent → drop (fail-closed)
  assert.equal(shouldRelayOutbound({ ...ok, inbox: { id: 9 } }, 7), false); // foreign inbox
});

test('channel and broadcast chats are never relayed, in either direction', () => {
  // `isGroup` is a boolean over a five-way discriminator, so a WhatsApp Channel post arrives with
  // isGroup false and read exactly like a customer writing in: one Chatwoot contact and one open
  // conversation per followed channel, for an agent to triage and close by hand, and any reply
  // addressed to a chat this account cannot post to. The host filters only status broadcasts.
  for (const chatId of [
    '120363000000000000@newsletter',
    '120363000000000000@NEWSLETTER',
    '628123456789-1234567890@broadcast',
    'status@broadcast',
  ]) {
    assert.equal(shouldRelayInbound({ ...base, chatId }, 'Engine', true), false, `inbound ${chatId}`);
    assert.equal(shouldRelayOwn({ ...base, chatId, fromMe: true }, 'Engine', true), false, `own ${chatId}`);
  }
  // Ordinary 1:1, group and @lid chats are untouched.
  for (const chatId of ['628123456789@c.us', '628123456789@s.whatsapp.net', '1234-5678@g.us', '99887766@lid']) {
    assert.equal(shouldRelayInbound({ ...base, chatId }, 'Engine', true), true, `inbound ${chatId}`);
    assert.equal(shouldRelayOwn({ ...base, chatId, fromMe: true }, 'Engine', true), true, `own ${chatId}`);
  }
});

test('candidatePhoneDigits: prefers a JID-shaped identifier over phone_number', () => {
  assert.equal(
    candidatePhoneDigits({ identifier: '18492076733@c.us', phone_number: '+15550001111' }),
    '18492076733',
  );
  assert.equal(candidatePhoneDigits({ identifier: '99887766@lid' }), '99887766');
});

test('candidatePhoneDigits: falls back to phone_number when identifier is absent or not WA-shaped', () => {
  // A contact created outside this adapter (Chatwoot's own UI, a CSV import) has no identifier at all.
  assert.equal(candidatePhoneDigits({ phone_number: '+1 (849) 207-6733' }), '18492076733');
  // An identifier that happens to be set but isn't this adapter's JID shape (e.g. an email-derived id
  // from a different channel type) must not be treated as a phone number.
  assert.equal(candidatePhoneDigits({ identifier: 'not-a-jid', phone_number: '+18492076733' }), '18492076733');
});

test('candidatePhoneDigits: undefined when nothing usable is present', () => {
  assert.equal(candidatePhoneDigits(undefined), undefined);
  assert.equal(candidatePhoneDigits({}), undefined);
  assert.equal(candidatePhoneDigits({ identifier: 'not-a-jid' }), undefined);
  assert.equal(candidatePhoneDigits({ phone_number: '123' }), undefined); // too short to be E.164
  assert.equal(candidatePhoneDigits({ phone_number: '+0123456789' }), undefined); // leading 0 — invalid E.164
});

test('candidatePhoneDigits: a group identifier is out of scope, never treated as a phone number', () => {
  // A group contact's "digits" aren't an MSISDN — engine.checkNumberExists (a phone-account lookup)
  // cannot verify them, so this must not hand one out as a candidate. resolvePhone (relay.ts) never
  // gives a group contact a phone_number either, so there is no fallback to fall back to.
  assert.equal(candidatePhoneDigits({ identifier: '120363403926419672@g.us' }), undefined);
  assert.equal(
    candidatePhoneDigits({ identifier: '120363403926419672@g.us', phone_number: '+18492076733' }),
    // Falls through to phone_number when the identifier isn't a 1:1 shape — same as any other
    // non-matching identifier. A group contact realistically never carries a phone_number, but if one
    // were present (e.g. hand-edited in Chatwoot) it is a real E.164 value and still usable.
    '18492076733',
  );
});
