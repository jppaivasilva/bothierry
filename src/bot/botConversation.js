// Contexto da conversa quando falam com o bot (mencao ou resposta a uma mensagem dele).

import { getMessagesSince, getMemberList } from '../db.js';
import { TIMEZONE } from './shared.js';
import { formatDisplayName } from '../displayNames.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

// ---- Contexto pra quando falam com o bot (mencao ou resposta a uma mensagem dele) ----
const BOT_CONTEXT_MESSAGES = 25;

const BOT_CONTEXT_WINDOW_HOURS = 3;

const BOT_REPLY_COOLDOWN_MS = 15 * 1000;

const lastBotReplyBySender = new Map();

export function isOnBotChatCooldown(senderJid) {
  const now = Date.now();
  if (now - (lastBotReplyBySender.get(senderJid) || 0) < BOT_REPLY_COOLDOWN_MS) return true;
  lastBotReplyBySender.set(senderJid, now);
  return false;
}

// As ultimas mensagens do grupo ("HH:MM Nome: texto"), sem a propria pergunta.
export function getRecentConversation(groupJid, currentText) {
  const since = Math.floor(Date.now() / 1000) - BOT_CONTEXT_WINDOW_HOURS * 60 * 60;
  const recent = getMessagesSince(groupJid, since);
  if (recent.length > 0 && recent[recent.length - 1].text === currentText) recent.pop();
  return recent.slice(-BOT_CONTEXT_MESSAGES).map((m) => {
    const hhmm = new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(m.timestamp * 1000));
    return `${hhmm} ${formatDisplayName(m.senderName)}: ${m.text.replace(/@\d+/g, '@alguem').slice(0, 300)}`;
  });
}

// Texto e autor da mensagem a que essa mensagem responde (se for uma resposta).
export function getQuotedMessage(msg, groupJid, botIdentifiers) {
  const info = msg.message?.extendedTextMessage?.contextInfo;
  const q = info?.quotedMessage;
  const quotedText = q?.conversation || q?.extendedTextMessage?.text || q?.imageMessage?.caption || q?.videoMessage?.caption;
  if (!quotedText) return null;
  const participant = info.participant ? jidNormalizedUser(info.participant) : null;
  const member = participant ? getMemberList(groupJid).find((m) => jidNormalizedUser(m.jid) === participant) : null;
  const author = participant && botIdentifiers.includes(participant) ? 'voce (Bothierry)' : member ? formatDisplayName(member.name) : 'alguem';
  return { author, text: quotedText.replace(/@\d+/g, '@alguem').slice(0, 500) };
}
