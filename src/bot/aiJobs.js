// Liga a fila de perguntas (aiQueue.js) ao bot de verdade: IA, envio confiavel, presenca "digitando".
import { createAiQueue } from './aiQueue.js';
import { botState, sentByBot, getOpenAIClient } from './shared.js';
import { answerDataQuestion } from '../dataQuestions.js';
import { getRecentConversation } from './botConversation.js';
import { getImageForBot } from './vision.js';

/** Versao minima da mensagem original, que sobrevive a reinicio e ainda permite responder em "reply". */
export function minimalQuote(msg) {
  const m = msg.message || {};
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || '';
  return { key: msg.key, message: { conversation: String(text).replace(/@\d+/g, '@').slice(0, 200) } };
}

export const aiQueue = createAiQueue({
  deps: {
    answer: async (job, extras) => {
      const client = getOpenAIClient();
      if (!client) throw Object.assign(new Error('OPENAI_API_KEY nao configurada'), { status: 0 });
      const image = extras.msg ? await getImageForBot(extras.msg) : null;
      return answerDataQuestion(client, job.groupJid, job.question, {
        image,
        context: getRecentConversation(job.groupJid, job.text),
        quoted: job.quotedCtx || null,
        asker: job.senderName,
        askerJid: job.senderJid,
      });
    },
    // sock.sendMessage ja e o envio confiavel (fila, espera reconectar, tenta de novo)
    send: async (job, text, extras) => {
      const sock = botState.sock;
      if (!sock) throw Object.assign(new Error('bot ainda nao conectado'), { retryable: true });
      const sent = await sock.sendMessage(job.groupJid, { text }, { quoted: extras.msg || job.quote });
      if (sent?.key?.id) sentByBot.add(sent.key.id);
      return sent;
    },
    presence: (job, state) => {
      botState.sock?.sendPresenceUpdate?.(state, job.groupJid)?.catch?.(() => {});
    },
  },
});
