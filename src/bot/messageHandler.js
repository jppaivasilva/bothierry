// Tratamento de cada mensagem recebida: link repetido, thumb, regras, marcos, comandos, perguntas ao bot.

import { ThanksStreak, THANKS_TARGET_NAME, isThanksToTarget } from '../thanks.js';
import { loadSeenMessageIds, extractUrls, wasUrlSentSince, logMessage, findSenderJidByName, getDailyCounts } from '../db.js';
import { debugLog, sentByBot, normalizeJid, getGroupName, LINK_REPEAT_AUDIO, getBrasiliaNow, DASHBOARD_URL, getOpenAIClient } from './shared.js';
import fs from 'fs';
import { findMatchingRule, loadRules } from '../rules.js';
import { announceRuleBreak, isIphoneDepreciative, IPHONE_RULE_NUMBER, isInsultToBot, handleBotInsult } from './insults.js';
import { recordMessage, recordCommandUsage } from '../metrics.js';
import { sendThanksFlood } from './specialMessages.js';
import { parseCommand, commands } from './commands.js';
import { sendAudioByName } from './audioCommands.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { isOnBotChatCooldown, getQuotedMessage, getRecentConversation } from './botConversation.js';
import { answerDataQuestion } from '../dataQuestions.js';

// Janela de tempo em que um link repetido e avisado pelo bot.
const LINK_REPEAT_WINDOW_HOURS = 24;

// Numeros de mensagens no dia que disparam o aviso de marco, marcando a pessoa.
const MESSAGE_MILESTONES = [50, 100, 150, 200, 250, 300];

const thanksStreak = new ThanksStreak();

// IDs de mensagem ja processados (carregado do log em disco, sobrevive a reinicios).
// O Baileys pode reentregar mensagens recentes ao reconectar/reiniciar o bot.
export const seenMessageIds = loadSeenMessageIds();

// Liga o tratamento de mensagens recebidas ao socket.
export function registerMessageHandler(sock) {
sock.ev.on('messages.upsert', async ({ messages, type }) => {
    debugLog(`[debug] messages.upsert recebido — type=${type}, quantidade=${messages.length}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      // Reacoes (emoji em cima de uma mensagem), votos de enquete e mensagens
      // de protocolo (ex: "deletar mensagem") nao sao mensagens de verdade —
      // vem com msg.message preenchido mas sem conversation/extendedTextMessage,
      // e contavam erroneamente ponto no ranking pra quem so reagiu.
      if (msg.message.reactionMessage || msg.message.pollUpdateMessage || msg.message.protocolMessage) continue;
      if (msg.key.fromMe && sentByBot.has(msg.key.id)) continue; // ignora só as respostas automaticas do bot

      const msgId = msg.key.id;
      if (msgId && seenMessageIds.has(msgId)) {
        debugLog(`[debug] mensagem duplicada ignorada (id=${msgId})`);
        continue;
      }
      if (msgId) seenMessageIds.add(msgId);

      const groupJid = msg.key.remoteJid;
      if (!groupJid || !groupJid.endsWith('@g.us')) {
        debugLog(`[debug] ignorado — nao e mensagem de grupo (remoteJid=${groupJid})`);
        continue;
      }

      const senderJid = msg.key.fromMe
        ? normalizeJid(sock.user?.id) || groupJid
        : msg.key.participant || groupJid;
      const senderName = msg.key.fromMe
        ? sock.user?.name || 'Você'
        : msg.pushName || senderJid.split('@')[0];
      const timestamp = Number(msg.messageTimestamp);
      const groupName = await getGroupName(sock, groupJid);

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      debugLog(`[debug] mensagem de grupo recebida — grupo="${groupName}" remetente="${senderName}" fromMe=${msg.key.fromMe} texto="${text}"`);

      // Checa link repetido ANTES de gravar a mensagem atual no log, senao ela
      // acabaria "repetindo" ela mesma.
      const urls = extractUrls(text);
      if (urls.length > 0) {
        debugLog(
          `[debug] link detectado: ${JSON.stringify(urls)} | tem extendedTextMessage: ${!!msg.message.extendedTextMessage} | temThumbnail: ${!!msg.message.extendedTextMessage?.jpegThumbnail} | thumbnailDirectPath: ${!!msg.message.extendedTextMessage?.thumbnailDirectPath} | titulo: ${!!msg.message.extendedTextMessage?.title}`
        );
        const since = Math.floor(Date.now() / 1000) - LINK_REPEAT_WINDOW_HOURS * 60 * 60;
        const isRepeated = urls.some((url) => wasUrlSentSince(groupJid, url, since));
        if (isRepeated) {
          try {
            const sent = await sock.sendMessage(groupJid, {
              text: '😤 TAVA FORA DO BRASIL, IRMÃO?? 😤\nTava fora do Brasil?! 🙄\nDe novo esse link?? 😡\nJá foi mandado, tá REPETIDA!! 🔁',
            });
            if (sent?.key?.id) sentByBot.add(sent.key.id);

            if (fs.existsSync(LINK_REPEAT_AUDIO)) {
              const audioSent = await sock.sendMessage(groupJid, {
                audio: fs.readFileSync(LINK_REPEAT_AUDIO),
                mimetype: 'audio/mpeg',
              });
              if (audioSent?.key?.id) sentByBot.add(audioSent.key.id);
            } else {
              console.error(`Audio de link repetido nao encontrado em: ${LINK_REPEAT_AUDIO}`);
            }
          } catch (err) {
            console.error('Erro ao avisar link repetido:', err);
          }
        }

        // Link sem preview — o WhatsApp so preenche jpegThumbnail quando
        // consegue gerar a previa. Isso cobre DOIS casos, ambos "sem thumb" do
        // ponto de vista de quem esta no grupo (ninguem ve nenhuma previa):
        // 1) extendedTextMessage existe mas jpegThumbnail veio vazio (o
        //    WhatsApp do remetente tentou gerar a previa e falhou);
        // 2) extendedTextMessage NEM EXISTE — o WhatsApp do remetente decidiu
        //    nao tratar aquele texto como link de jeito nenhum (mandou como
        //    "conversation" comum). Isso depende do aparelho/app de quem
        //    manda, fora do nosso controle — mas o resultado pro grupo e o
        //    mesmo (sem nenhuma previa visivel), entao conta igual.
        // So NAO dispara se for uma resposta citada — responder a uma mensagem
        // tambem gera extendedTextMessage (sem thumbnail nenhum, obviamente),
        // entao precisamos excluir esse caso pra nao disparar em qualquer reply.
        const extendedText = msg.message.extendedTextMessage;
        // Clientes novos do WhatsApp mandam a imagem da previa como arquivo
        // (thumbnailDirectPath/thumbnailSha256) em vez do jpegThumbnail inline —
        // olhar so o jpegThumbnail dava falso "sem thumb" em link COM previa.
        const temThumbnail = !!(extendedText?.jpegThumbnail || extendedText?.thumbnailDirectPath || extendedText?.thumbnailSha256);
        const isQuotedReply = !!extendedText?.contextInfo?.quotedMessage;
        if (!temThumbnail && !isQuotedReply) {
          try {
            const sent = await sock.sendMessage(groupJid, { text: 'sem thumb amigo? 👀' }, { quoted: msg });
            if (sent?.key?.id) sentByBot.add(sent.key.id);
          } catch (err) {
            console.error('Erro ao avisar link sem thumbnail:', err);
          }
        }
      }

      // Checa se a mensagem bate com o gatilho de alguma regra (regras/*.txt).
      const brokenRule = findMatchingRule(text);
      if (brokenRule) {
        try {
          await announceRuleBreak(sock, groupJid, brokenRule);
        } catch (err) {
          console.error(`Erro ao avisar regra ${brokenRule.number}:`, err);
        }
      } else if (/iphone/i.test(text)) {
        // "iPhone" foi citado mas nao bateu nenhuma frase fixa — deixa a IA
        // analisar o tom antes de decidir se e a Regra 93 (zoeira com iPhone).
        try {
          if (await isIphoneDepreciative(text)) {
            const rule93 = loadRules().find((r) => r.number === IPHONE_RULE_NUMBER);
            if (rule93) await announceRuleBreak(sock, groupJid, rule93);
          }
        } catch (err) {
          console.error('Erro ao analisar mensagem sobre iPhone via IA:', err);
        }
      }

      try {
        logMessage({ msgId, groupJid, groupName, senderJid, senderName, timestamp, text });
        recordMessage();
      } catch (err) {
        console.error('Erro ao gravar mensagem no log:', err);
      }

      // 3 "Obrigado @Nicholas" seguidos: o bot responde com uma enxurrada de obrigados.
      try {
        const targetJid = findSenderJidByName(groupJid, THANKS_TARGET_NAME);
        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isThanks = isThanksToTarget({ text, mentionedJids, targetJids: [targetJid] });
        if (thanksStreak.register(groupJid, isThanks) && targetJid) {
          // Em segundo plano: sao ~10 mensagens com 2 s entre elas, sem travar o resto do bot.
          sendThanksFlood(sock, groupJid, targetJid).catch((err) => console.error('Erro na enxurrada de obrigados:', err));
        }
      } catch (err) {
        console.error('Erro na enxurrada de obrigados:', err);
      }

      // Avisa (marcando a pessoa) quando ela bate exatamente algum dos marcos de mensagens do dia.
      try {
        const todayCounts = getDailyCounts(groupJid, getBrasiliaNow().date);
        const senderCount = todayCounts.find((c) => c.sender_jid === senderJid);
        if (senderCount && MESSAGE_MILESTONES.includes(senderCount.total)) {
          const sent = await sock.sendMessage(groupJid, {
            text: `🚨 @${senderJid.split('@')[0]} já bateu ${senderCount.total} mensagens hoje! Cuidado 🕵️ 🚨\n\nPara mais informações acesse: ${DASHBOARD_URL}`,
            mentions: [senderJid],
          });
          if (sent?.key?.id) sentByBot.add(sent.key.id);
        }
      } catch (err) {
        console.error('Erro ao avisar marco de mensagens:', err);
      }

      const commandName = parseCommand(text);
      if (commandName && commands[commandName]) {
        debugLog(`[debug] comando ${commandName} detectado, respondendo...`);
        const args = text.trim().replace(/^[!/]\S+/, '').trim();
        recordCommandUsage(commandName);
        try {
          const sent = await commands[commandName]({ sock, groupJid, senderJid, senderName, args, msg });
          if (sent?.key?.id) sentByBot.add(sent.key.id);
        } catch (err) {
          console.error(`Erro ao responder comando ${commandName}:`, err);
        }
      } else if (commandName) {
        // Nao e um comando fixo — confere se bate com o nome de um audio em audios/.
        debugLog(`[debug] comando ${commandName} nao reconhecido, checando se e um audio...`);
        await sendAudioByName({ sock, groupJid }, commandName);
      } else if (text) {
        // Nao e comando nenhum — confere se a mensagem menciona o proprio bot
        // diretamente (@bot). O WhatsApp identifica o bot de duas formas
        // dependendo do contexto: pelo numero de telefone (@s.whatsapp.net) ou
        // pelo "lid", um identificador de privacidade mais novo (@lid) — a
        // mencao pode vir em qualquer um dos dois, entao comparamos contra ambos.
        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const botIdentifiers = [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser);
        const isBotMentioned = mentionedJids.some((jid) => botIdentifiers.includes(jidNormalizedUser(jid)));
        // Resposta a uma mensagem do bot (sem marcar ele) tambem conta como falar com ele. Risada
        // ("kkk", "haha") e mensagens de 1-2 letras ficam de fora; xingamento e checado a partir de 3
        // letras, mas so responde de verdade (IA) com 8+ letras — pra nao responder todo "bom dia" a um cartao.
        const quotedInfo = msg.message?.extendedTextMessage?.contextInfo;
        const replyLetterText = text.replace(/[^\p{L}]/gu, '');
        const replyLetters = replyLetterText.length;
        const isReplyToBot =
          !!quotedInfo?.quotedMessage && !!quotedInfo.participant && botIdentifiers.includes(jidNormalizedUser(quotedInfo.participant)) &&
          replyLetters >= 3 && !/^(?:k+|(?:ha)+h?|(?:rs)+|(?:he)+h?)$/i.test(replyLetterText);
        const addressedToBot = isBotMentioned || (isReplyToBot && !isOnBotChatCooldown(senderJid));
        if (mentionedJids.length > 0) {
          debugLog(`[debug] mencoes na mensagem: ${JSON.stringify(mentionedJids)} | identidades do bot: ${JSON.stringify(botIdentifiers)} | bot mencionado: ${isBotMentioned}`);
        }

        if (addressedToBot) {
          const quotedMessage = getQuotedMessage(msg, groupJid, botIdentifiers);
          const insulted = await isInsultToBot(text, isReplyToBot ? quotedMessage?.text : null);
          if (insulted) {
            debugLog(`[debug] insulto ao bot detectado de ${senderName}`);
            try {
              if (isBotMentioned) {
                await handleBotInsult({ sock, groupJid, senderJid, senderName });
              } else {
                // Xingou respondendo a uma mensagem do bot (sem marcar): so devolve a ofensa, sem contar pra expulsao.
                const sent = await sock.sendMessage(groupJid, { text: 'teu cu' }, { quoted: msg });
                if (sent?.key?.id) sentByBot.add(sent.key.id);
              }
            } catch (err) {
              console.error('Erro ao processar insulto ao bot:', err);
            }
          } else {
            const client = getOpenAIClient();
            if (!client) {
              debugLog('[debug] bot mencionado mas OPENAI_API_KEY nao configurada, ignorando pergunta.');
            } else {
              const question = text.replace(/@\d+/g, '').trim();
              if (question && (isBotMentioned || replyLetters >= 8)) {
                debugLog(`[debug] pergunta de dados detectada: "${question}"`);
                try {
                  const answer = await answerDataQuestion(client, groupJid, question, {
                    context: getRecentConversation(groupJid, text),
                    quoted: quotedMessage,
                  });
                  const sent = await sock.sendMessage(groupJid, { text: answer });
                  if (sent?.key?.id) sentByBot.add(sent.key.id);
                } catch (err) {
                  console.error('Erro ao responder pergunta de dados:', err);
                }
              }
            }
          }
        }
      }
    }
  });
}
