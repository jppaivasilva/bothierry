// Regras com IA: insulto ao bot (aviso e expulsao) e tom depreciativo sobre iPhone.

import { sentByBot, getOpenAIClient, OPENAI_MODEL, ROOT, findImageAsset } from './shared.js';
import path from 'path';
import fs from 'fs';

// Numero da regra sobre iPhone (regras/93.txt) — usado quando a IA detecta tom
// depreciativo numa mensagem que cita "iPhone" mas nao bateu nenhuma frase fixa.
export const IPHONE_RULE_NUMBER = '93';

// Manda o aviso padrao de regra quebrada (mesmo texto usado pro match por frase fixa).
export async function announceRuleBreak(sock, groupJid, rule) {
  const sent = await sock.sendMessage(groupJid, {
    text: `👮 ✋ Pare amigo, essa é a regra ${rule.number} - ${rule.description} ⚖️`,
  });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
}

// Pede pra IA classificar se uma mensagem que cita "iPhone" fala mal dele
// (tom depreciativo). Sem chave da OpenAI configurada, nao arrisca — retorna false.
export async function isIphoneDepreciative(text) {
  const client = getOpenAIClient();
  if (!client) return false;

  try {
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Voce classifica se uma mensagem fala mal do iPhone de verdade (tom depreciativo, zoeira negativa, xingamento) ou nao. ' +
            'Preste atencao especial em ironia e dupla negacao — frases como "pessimo exemplo de celular ruim" sao elogios disfarcados ' +
            '(ruim + ruim = bom), e NAO contam como depreciativo. ' +
            'Primeiro, explique em uma linha curta o sentido real da frase (ela elogia ou critica o iPhone de verdade?). ' +
            'Depois, na ultima linha, responda EXATAMENTE no formato "RESPOSTA: SIM" ou "RESPOSTA: NAO".',
        },
        { role: 'user', content: text },
      ],
      max_tokens: 100,
    });
    const raw = completion.choices[0]?.message?.content || '';
    const match = raw.match(/RESPOSTA:\s*(SIM|NAO)/i);
    return match ? match[1].toUpperCase() === 'SIM' : false;
  } catch (err) {
    console.error('Erro ao classificar mensagem sobre iPhone via IA:', err);
    return false;
  }
}

// Numero de insultos ao bot (pela mesma pessoa) que disparam a expulsao do grupo.
const INSULT_LIMIT = 3;

const INSULT_STATE_FILE = path.join(ROOT, 'insultos_state.json');

function loadInsultCounts() {
  if (!fs.existsSync(INSULT_STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(INSULT_STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveInsultCounts(counts) {
  fs.writeFileSync(INSULT_STATE_FILE, JSON.stringify(counts));
}

// Pede pra IA classificar se uma mensagem insulta/ofende o bot de verdade
// (xingamento, deboche agressivo, etc) — nao conta zoeira leve ou perguntas
// normais. Sem chave da OpenAI configurada, nao arrisca — retorna false.
export async function isInsultToBot(text, quotedText = null) {
  const client = getOpenAIClient();
  if (!client) return false;

  try {
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Voce classifica se uma mensagem dirigida a um bot de WhatsApp e um INSULTO/OFENSA de verdade (xingamento, deboche ' +
            'agressivo, chamar o bot de burro/inutil/lixo, mandar calar a boca com hostilidade, etc) — e NAO zoeira leve, uma ' +
            'reclamacao educada, uma pergunta normal, ou brincadeira amigavel. Na duvida, classifique como NAO insulto (falso ' +
            'positivo expulsa gente do grupo por engano, entao seja conservador). ' +
            'Primeiro, explique em uma linha curta o tom real da mensagem. ' +
            'Depois, na ultima linha, responda EXATAMENTE no formato "RESPOSTA: SIM" ou "RESPOSTA: NAO".',
        },
        { role: 'user', content: quotedText ? `Mensagem anterior do bot, a que a pessoa esta respondendo: "${quotedText}"\n\nMensagem da pessoa: ${text}` : text },
      ],
      max_tokens: 100,
    });
    const raw = completion.choices[0]?.message?.content || '';
    const match = raw.match(/RESPOSTA:\s*(SIM|NAO)/i);
    return match ? match[1].toUpperCase() === 'SIM' : false;
  } catch (err) {
    console.error('Erro ao classificar possivel insulto ao bot via IA:', err);
    return false;
  }
}

// Imagem de cada aviso de insulto: 1o usa policia, 2o policia-2, 3o policia-3.
function findInsultLogoPath(count) {
  const baseName = count <= 1 ? 'policia' : `policia-${count}`;
  return findImageAsset(baseName);
}

/**
 * Registra um insulto ao bot vindo de senderJid — nos dois primeiros avisa e
 * ameaca expulsao (imagem muda a cada aviso: policia, policia-2, policia-3),
 * no terceiro remove a pessoa do grupo de verdade (bot precisa ser admin).
 */
export async function handleBotInsult({ sock, groupJid, senderJid, senderName }) {
  const counts = loadInsultCounts();
  const count = (counts[senderJid] || 0) + 1;
  counts[senderJid] = count;
  saveInsultCounts(counts);

  const logoPath = findInsultLogoPath(count);
  const mentionText = `@${senderJid.split('@')[0]}`;

  if (count < INSULT_LIMIT) {
    const text = `${mentionText} me respeite, se você me insultar novamente será expulso ⚠️ (${count}/${INSULT_LIMIT})`;
    const content = logoPath ? { image: { url: logoPath }, caption: text, mentions: [senderJid] } : { text, mentions: [senderJid] };
    return sock.sendMessage(groupJid, content);
  }

  const text = `${mentionText} foi expulso do grupo por desrespeito reincidente. 🚨`;
  const content = logoPath ? { image: { url: logoPath }, caption: text, mentions: [senderJid] } : { text, mentions: [senderJid] };
  await sock.sendMessage(groupJid, content);

  try {
    await sock.groupParticipantsUpdate(groupJid, [senderJid], 'remove');
    delete counts[senderJid];
    saveInsultCounts(counts);
  } catch (err) {
    console.error(`Erro ao remover ${senderName} do grupo apos 3 insultos:`, err);
  }
}
