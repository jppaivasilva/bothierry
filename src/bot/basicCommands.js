// Comandos simples do grupo: ranking, resumo, transcrever, figurinha, renomear, foto do grupo, otario, regras, painel...

import { PERSONA } from '../persona.js';
import { getBrasiliaNow, formatDateBR, DASHBOARD_URL, getOpenAIClient, MAX_TRANSCRIPT_CHARS, OPENAI_MODEL, getSharp, findImageAsset, REGULAMENTO_FILE, MEGASENA_FILE, sentByBot } from './shared.js';
import { getDailyCounts, getMessagesSince } from '../db.js';
import { formatDisplayName } from '../displayNames.js';
import { downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { toFile } from 'openai';
import { loadRules } from '../rules.js';
import fs from 'fs';
import { createLoginToken } from '../dashboard.js';

export async function commandRanking({ sock, groupJid }) {
  const today = getBrasiliaNow().date;
  const counts = getDailyCounts(groupJid, today);

  if (counts.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Hoje ainda tá todo mundo quieto, não tenho nenhuma mensagem registrada 😴' });
  }

  const totalMessages = counts.reduce((sum, c) => sum + c.total, 0);

  const lines = counts.map((c, i) => {
    const percent = Math.round((c.total / totalMessages) * 100);
    return `${i + 1}. ${formatDisplayName(c.sender_name)}: ${c.total} msgs (${percent}%)`;
  });

  return sock.sendMessage(groupJid, {
    text:
      `📊 Ranking de mensagens de hoje (${formatDateBR(today)}):\n\n${lines.join('\n')}` +
      `\n\n📈 Total de mensagens: ${totalMessages}` +
      `\n\nPara mais informações acesse: ${DASHBOARD_URL}`,
  });
}

export async function commandResumo({ sock, groupJid }) {
  const client = getOpenAIClient();
  if (!client) {
    return sock.sendMessage(groupJid, {
      text: 'Pra fazer o !resumo eu preciso da chave da OpenAI configurada. Crie um arquivo .env na raiz do projeto com OPENAI_API_KEY=sua-chave e reinicie o bot.',
    });
  }

  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const recentMessages = getMessagesSince(groupJid, since);

  if (recentMessages.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Não rolou conversa suficiente nas últimas 24h pra eu resumir 🤷' });
  }

  const transcript = recentMessages
    .map((m) => `${formatDisplayName(m.senderName)}: ${m.text}`)
    .join('\n')
    .slice(-MAX_TRANSCRIPT_CHARS); // fica com o final (mensagens mais recentes) se passar do limite

  try {
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            PERSONA + ' Agora voce vai contar pro grupo o que rolou nas ultimas 24 horas. Comece com UMA frase curta e descontraida em primeira pessoa (ex.: "Olha o que eu vi por aqui:"), depois no maximo 10 bullet points curtos e objetivos, so os pontos principais, no mesmo tom. Nao invente informacao que nao esteja na conversa.',
        },
        { role: 'user', content: `Resuma esta conversa das ultimas 24 horas:\n\n${transcript}` },
      ],
      max_tokens: 350,
    });

    const summary = completion.choices[0]?.message?.content?.trim() || 'Não consegui gerar um resumo.';
    return sock.sendMessage(groupJid, { text: `🧠 Resumo das últimas 24h:\n\n${summary}` });
  } catch (err) {
    console.error('Erro ao gerar resumo com OpenAI:', err);
    return sock.sendMessage(groupJid, { text: 'Deu ruim aqui na hora de resumir 😅 tenta de novo daqui a pouco.' });
  }
}

// Acha a midia citada (quoted) numa resposta, do tipo pedido (ex: "audioMessage",
// "imageMessage"). Retorna o objeto pronto pra passar pro downloadMediaMessage,
// ou null se a resposta nao citou esse tipo de midia.
export function getQuotedMedia(msg, mediaKey) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = contextInfo?.quotedMessage;
  if (!quoted?.[mediaKey]) return null;

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: contextInfo.stanzaId,
      participant: contextInfo.participant,
    },
    message: quoted,
  };
}

export async function commandTranscrever({ sock, groupJid, msg }) {
  const client = getOpenAIClient();
  if (!client) {
    return sock.sendMessage(groupJid, {
      text: 'Pra fazer o !transcrever eu preciso da chave da OpenAI configurada. Crie um arquivo .env na raiz do projeto com OPENAI_API_KEY=sua-chave e reinicie o bot.',
    });
  }

  const quotedAudio = getQuotedMedia(msg, 'audioMessage');
  if (!quotedAudio) {
    return sock.sendMessage(groupJid, { text: 'Responda a um áudio do grupo com !transcrever pra eu transcrever ele.' });
  }

  try {
    const mimetype = quotedAudio.message.audioMessage?.mimetype || '';
    const ext = mimetype.includes('mp4') ? 'm4a' : mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('wav') ? 'wav' : 'ogg';

    const buffer = await downloadMediaMessage(quotedAudio, 'buffer', {});
    console.log(`[debug transcrever] mimetype="${mimetype}" ext=${ext} bufferBytes=${buffer?.length}`);

    const file = await toFile(buffer, `audio.${ext}`);
    const transcription = await client.audio.transcriptions.create({ file, model: 'whisper-1' });
    const text = transcription.text?.trim();

    return sock.sendMessage(groupJid, {
      text: text ? `📝 Transcrição: "${text}"` : 'Não consegui identificar nenhuma fala nesse áudio.',
    });
  } catch (err) {
    console.error('Erro ao transcrever áudio:', err);
    return sock.sendMessage(groupJid, { text: 'Não consegui transcrever esse áudio 😅 tenta de novo daqui a pouco.' });
  }
}

export async function commandFigurinha({ sock, groupJid, msg }) {
  const quotedImage = getQuotedMedia(msg, 'imageMessage');
  if (!quotedImage) {
    return sock.sendMessage(groupJid, { text: 'Responda a uma foto do grupo com !figurinha pra eu transformar ela em figurinha.' });
  }

  try {
    const buffer = await downloadMediaMessage(quotedImage, 'buffer', {});
    const sharp = await getSharp();
    const webpBuffer = await sharp(buffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp()
      .toBuffer();

    return sock.sendMessage(groupJid, { sticker: webpBuffer });
  } catch (err) {
    console.error('Erro ao criar figurinha:', err);
    return sock.sendMessage(groupJid, { text: 'Não consegui transformar essa foto em figurinha, tenta de novo daqui a pouco.' });
  }
}

export async function commandRenomearGrupo({ sock, groupJid, args }) {
  const newName = args.trim();
  if (!newName) {
    return sock.sendMessage(groupJid, { text: 'Use: !renomear Novo Nome Do Grupo' });
  }

  try {
    await sock.groupUpdateSubject(groupJid, newName);
    return sock.sendMessage(groupJid, { text: `✅ Pronto, renomeei o grupo para: *${newName}*` });
  } catch (err) {
    console.error('Erro ao renomear grupo:', err);
    return sock.sendMessage(groupJid, {
      text: 'Não consegui renomear o grupo — confere se eu sou admin (o WhatsApp exige isso pra eu mexer no nome).',
    });
  }
}

export async function commandFotoGrupo({ sock, groupJid, msg }) {
  const quotedImage = getQuotedMedia(msg, 'imageMessage');
  if (!quotedImage) {
    return sock.sendMessage(groupJid, { text: 'Responda a uma foto do grupo com !fotogrupo pra eu trocar a foto do grupo por ela.' });
  }

  try {
    const buffer = await downloadMediaMessage(quotedImage, 'buffer', {});
    const sharp = await getSharp();
    const jpegBuffer = await sharp(buffer).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();

    await sock.updateProfilePicture(groupJid, jpegBuffer);
    return sock.sendMessage(groupJid, { text: '✅ Pronto, troquei a foto do grupo!' });
  } catch (err) {
    console.error('Erro ao trocar foto do grupo:', err);
    return sock.sendMessage(groupJid, {
      text: 'Não consegui trocar a foto do grupo — confere se eu sou admin (o WhatsApp exige isso pra eu mexer na foto).',
    });
  }
}

const PF_TEXT =
  'NOTA PÚBLICA DE ESCLARECIMENTO: Venho, por meio desta, declarar formalmente que não possuo qualquer ligação com as ' +
  'atividades duvidosas deste recinto virtual. Fui inserido neste grupo contra a minha vontade. Em caso de operação da ' +
  'Polícia Federal, afirmo que sou um mero espectador, aceito delação premiada e já tenho o nome de todos os ' +
  'administradores anotado.';

function findPfLogoPath() {
  return findImageAsset('policia-federal');
}

export async function commandPoliciaFederal({ sock, groupJid }) {
  const logoPath = findPfLogoPath();
  if (!logoPath) {
    return sock.sendMessage(groupJid, { text: PF_TEXT });
  }
  return sock.sendMessage(groupJid, { image: { url: logoPath }, caption: PF_TEXT });
}

export async function commandOtario({ sock, groupJid, msg }) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const repliedJid = contextInfo?.participant;

  // Tentaram chamar o proprio bot de otario (respondendo a uma mensagem dele ou
  // marcando ele): em vez de marcar, ele devolve a zoeira.
  const botIdentifiers = [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser);
  const targets = [repliedJid, ...(contextInfo?.mentionedJid || [])].filter(Boolean).map(jidNormalizedUser);
  if (targets.some((jid) => botIdentifiers.includes(jid))) {
    return sock.sendMessage(groupJid, { text: 'bela tentativa amigo' }, { quoted: msg });
  }

  if (!repliedJid) {
    return sock.sendMessage(groupJid, { text: 'Responda a uma mensagem da pessoa com !otario pra marcar ela.' });
  }

  return sock.sendMessage(groupJid, {
    text: `podem sair de casa pessoal, o malandro encontrou @${repliedJid.split('@')[0]}`,
    mentions: [repliedJid],
  });
}

export async function commandRegras({ sock, groupJid }) {
  const rules = loadRules();
  if (rules.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhuma regra cadastrada ainda (crie um arquivo .txt na pasta regras/).' });
  }

  const lines = rules.map((r) => `Regra ${r.number} - ${r.description}`);
  return sock.sendMessage(groupJid, { text: `📜 *Regras do grupo*\n\n${lines.join('\n')}` });
}

export async function commandRegulamento({ sock, groupJid }) {
  if (!fs.existsSync(REGULAMENTO_FILE)) {
    return sock.sendMessage(groupJid, { text: 'Regulamento ainda não cadastrado (crie o arquivo regulamento.txt na raiz do projeto).' });
  }
  const text = fs.readFileSync(REGULAMENTO_FILE, 'utf-8').trim();
  return sock.sendMessage(groupJid, { text });
}

export async function commandMegasena({ sock, groupJid }) {
  if (!fs.existsSync(MEGASENA_FILE)) {
    return sock.sendMessage(groupJid, { text: 'Lista de organizadores ainda não cadastrada (crie o arquivo megasena.txt na raiz do projeto).' });
  }
  const text = fs.readFileSync(MEGASENA_FILE, 'utf-8').trim();
  return sock.sendMessage(groupJid, { text });
}

// !painel — manda no PRIVADO de quem pediu um link de uso unico (vale 5 min)
// que entra no painel ja identificado pelo WhatsApp, pra marcar presenca nos
// eventos sem senha nem cadastro de telefone.
export async function commandPainel({ sock, groupJid, senderJid, senderName }) {
  const result = createLoginToken({ jid: senderJid, name: senderName });
  if (result.wait) {
    return sock.sendMessage(groupJid, { text: `Calma, já te mandei um link. Tenta de novo em ${result.wait}s.` });
  }
  try {
    const sent = await sock.sendMessage(senderJid, {
      text: `🔑 Seu link pro painel (vale 5 minutos e só funciona uma vez):\n${DASHBOARD_URL}/entrar?t=${result.token}\n\nLá na aba *Eventos* você marca se vai ou não nos eventos.`,
    });
    if (sent?.key?.id) sentByBot.add(sent.key.id);
    return sock.sendMessage(groupJid, {
      text: `@${senderJid.split('@')[0]} te mandei o link no privado 📩`,
      mentions: [senderJid],
    });
  } catch (err) {
    console.error('Erro ao mandar link do painel no privado:', err);
    return sock.sendMessage(groupJid, {
      text: 'Não consegui te chamar no privado. Manda um "oi" pra mim no privado e tenta o !painel de novo.',
    });
  }
}
