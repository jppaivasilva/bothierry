import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import cron from 'node-cron';
import OpenAI, { toFile } from 'openai';

// `sharp` (processamento de imagem) carrega uma biblioteca nativa pesada
// (libvips) na memoria assim que e importada — mas so e usada em comandos
// raros (!figurinha, !fotogrupo, !fotobot, troca de tema da foto do bot).
// Carregar sob demanda, so na primeira vez que algum desses rodar, evita
// pagar esse custo de memoria o tempo todo numa VM com RAM apertada.
let sharpModule;
async function getSharp() {
  if (!sharpModule) sharpModule = (await import('sharp')).default;
  return sharpModule;
}
import { logMessage, getDailyCounts, getCountsSince, getCountsBetween, getMessagesSince, extractUrls, wasUrlSentSince, loadSeenMessageIds, archiveOldMessages, getRecentSenderJids, getMainGroupJid, getMemberList } from './db.js';
import { syncAvatars, getAvatarPath } from './avatars.js';
import {
  loadBirthdays,
  getBirthdaysToday,
  getLastBirthdayCheckDate,
  setLastBirthdayCheckDate,
  getPendingGroupRenames,
  setPendingGroupRenames,
  getLastGroupNameSyncDate,
  setLastGroupNameSyncDate,
} from './birthdays.js';
import { getNextUnseenNews, getRecentHeadlines } from './news.js';
import { pickMostImpactfulHeadline, editBotPhoto } from './groupPhoto.js';
import { loadEvents, addEvent, eventTitleExists, findUpcomingEvents, addAttendee, addAbsentee } from './events.js';
import { loadScheduledMessages, getDueMessages, markScheduledMessageSent } from './scheduled.js';
import { loadRules, findMatchingRule } from './rules.js';
import { answerDataQuestion } from './dataQuestions.js';
import { recordConnectionEvent, recordMessage, recordCommandUsage, recordCronRun, recordError, pruneOldMetrics, recordSystemStats } from './metrics.js';
import { startDashboardServer, createLoginToken } from './dashboard.js';
import { getWeatherData, formatWeatherBlock } from './weather.js';
import { renderWeatherCard } from './weatherCard.js';
import { renderBirthdayCard, photoToDataUri } from './birthdayCard.js';
import { formatDisplayName } from './displayNames.js';
import { resolveBirthdayMember, birthdayDisplayName, normalizeName } from './birthdayLinks.js';
import { readBirthdayPhoto, readMemberPhoto } from './birthdayPhotos.js';
import { getMembersWithExtras, setBotJids } from './extraMembers.js';
import { getPresidentSummary, getUrnasApuradasPorRegiao } from './elections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Intercepta todo console.error do processo pra tambem alimentar o painel de
// monitoramento (secao "Erros recentes"), sem precisar chamar recordError()
// manualmente em cada catch espalhado pelo codigo.
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  originalConsoleError(...args);
  try {
    recordError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  } catch {
    // nunca deixa o registro de metricas quebrar o log de erro em si
  }
};

// Carrega OPENAI_API_KEY (e outras variaveis) de um arquivo .env na raiz do
// projeto, se ele existir. Nao falha se o arquivo nao existir ainda.
try {
  process.loadEnvFile();
} catch {
  // sem .env por enquanto — comandos que dependem dele (!resumo) avisam na hora
}

// Fuso usado por todos os agendamentos do bot (aniversario, bom-dia, fim de expediente).
const TIMEZONE = 'America/Sao_Paulo';

// Porta do painel local de monitoramento (http://localhost:PORTA).
const DASHBOARD_PORT = 4321;
// URL publica do painel (VM na Oracle Cloud) — usada nos avisos automaticos
// que convidam o pessoal a ver mais detalhes no painel.
const DASHBOARD_URL = 'https://painel.bothierry.com.br';

// Opcoes compartilhadas por todos os crons. O node-cron v4 so tolera 1s de
// atraso por padrao — se o timer disparar mais tarde que isso (ex: PC/processo
// com CPU ocupada ou throttling do Windows, ja vimos atrasos de ~8s), ele
// considera a execucao "perdida" e PULA a tarefa em vez de rodar atrasada
// (foi assim que o bom dia das 08h ja sumiu). 2 minutos de tolerancia garante
// que atrasos pequenos ainda executem normalmente.
const CRON_OPTIONS = { timezone: TIMEZONE, missedExecutionTolerance: 120000 };

// Horario em que o aviso de aniversario e checado todo dia.
const BIRTHDAY_CHECK_HOUR = 9;

// Horario em que mensagens com mais de 7 dias (HOT_WINDOW_DAYS, em db.js) sao
// movidas do messages.jsonl pra archive/ — de madrugada, baixo movimento.
const ARCHIVE_HOUR = 3;

// Horarios das mensagens automaticas de bom-dia e fim de expediente.
const MORNING_HOUR = 8;
const EVENING_HOUR = 18;
// Propaganda (#ad) diaria no fim da noite. Dias no formato do cron (* = todo dia, 1-5 = seg a sex).
const AD_HOUR = 22;
const AD_MINUTE = 30;
const AD_DAYS = '*';

// Grupo (pelo nome, ja que Baileys nao indexa por nome) e expressao cron de
// quando a foto tematica com a noticia mais importante nacionalmente e trocada.
// Hoje: segunda e quarta as 08h (horario de Brasilia) — 2x por semana, pra
// economizar no custo do gpt-image-1 (o item mais caro do bot de longe).
const GROUP_PHOTO_CRON = '0 8 * * 1,3';

// Janela de tempo em que um link repetido e avisado pelo bot.
const LINK_REPEAT_WINDOW_HOURS = 24;

// Numeros de mensagens no dia que disparam o aviso de marco, marcando a pessoa.
const MESSAGE_MILESTONES = [50, 100, 150, 200, 250, 300];

// Pasta de audios: usada pelo detector de link repetido, pelas mensagens
// agendadas e pelos comandos !audios / !<nome-do-audio>.
const AUDIOS_DIR = path.join(__dirname, '..', 'audios');
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg'];
const LINK_REPEAT_AUDIO = path.join(AUDIOS_DIR, 'repetido.mp3');

// Texto fixo mostrado pelo !regulamento.
const REGULAMENTO_FILE = path.join(__dirname, '..', 'regulamento.txt');

// Texto fixo mostrado pelo !megasena.
const MEGASENA_FILE = path.join(__dirname, '..', 'megasena.txt');

// Modelo da OpenAI usado pelo !resumo, e limite de tamanho do transcript
// enviado (protecao simples contra prompts gigantes/caros em grupos muito ativos).
const OPENAI_MODEL = 'gpt-4o-mini';
const MAX_TRANSCRIPT_CHARS = 12000;

// Logs verbosos (uma linha por mensagem recebida, incluindo o texto) sao uteis
// para depurar mas expoem conteudo do grupo no terminal — desligados por padrao.
// Ative com DEBUG=1 npm start
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

const groupNameCache = new Map();
const sentByBot = new Set(); // IDs das mensagens automáticas enviadas pelo próprio bot (não contar)

// IDs de mensagem ja processados (carregado do log em disco, sobrevive a reinicios).
// O Baileys pode reentregar mensagens recentes ao reconectar/reiniciar o bot.
const seenMessageIds = loadSeenMessageIds();

async function getGroupName(sock, groupJid) {
  if (groupNameCache.has(groupJid)) return groupNameCache.get(groupJid);
  try {
    const meta = await sock.groupMetadata(groupJid);
    groupNameCache.set(groupJid, meta.subject);
    return meta.subject;
  } catch {
    return groupJid;
  }
}

// Remove o sufixo de dispositivo (:12) que o WhatsApp as vezes adiciona ao proprio JID
function normalizeJid(jid) {
  return jid ? jid.replace(/:\d+@/, '@') : jid;
}

// Converte uma data ISO (YYYY-MM-DD, usada internamente para gravar/consultar) para
// o formato de exibicao DD-MM-YYYY.
function formatDateBR(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}-${month}-${year}`;
}

// Converte "DD/MM/AA", "DD/MM/AAAA" ou com "-" no lugar de "/" pra ISO (YYYY-MM-DD).
// Retorna null se nao reconhecer o formato.
function parseDateBR(str) {
  const match = str.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!match) return null;
  let [, day, month, year] = match;
  if (year.length === 2) year = `20${year}`;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Reconhece tanto "!comando" quanto "/comando" como prefixo de comando.
function parseCommand(text) {
  const match = text.trim().match(/^[!/](\S+)/);
  return match ? match[1].toLowerCase() : null;
}

async function commandRanking({ sock, groupJid }) {
  const today = getBrasiliaNow().date;
  const counts = getDailyCounts(groupJid, today);

  if (counts.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Ainda nao ha mensagens registradas hoje.' });
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

async function commandMenu({ sock, groupJid }) {
  const blocks = COMMAND_CATEGORIES.map((cat) => {
    const commandLines = cat.commands.map((c) => `!${c.name} — ${c.description}`).join('\n');
    return `${cat.emoji} *${cat.title}*\n${commandLines}`;
  });
  return sock.sendMessage(groupJid, { text: `🤖 *Menu de Comandos disponíveis*\n\n${blocks.join('\n\n')}` });
}

async function commandNews({ sock, groupJid }) {
  try {
    const news = await getNextUnseenNews();
    if (!news) {
      return sock.sendMessage(groupJid, { text: 'Sem notícia nova no feed do G1 no momento (as recentes já foram enviadas aqui), tenta de novo mais tarde.' });
    }

    const text = news.subtitle
      ? `📰 *${news.title}*\n\n${news.subtitle}\n\n🔗 ${news.link}`
      : `📰 *${news.title}*\n\n🔗 ${news.link}`;

    return sock.sendMessage(groupJid, { text });
  } catch (err) {
    console.error('Erro ao buscar noticia do G1:', err);
    return sock.sendMessage(groupJid, { text: 'Não consegui buscar a notícia agora, tenta de novo daqui a pouco.' });
  }
}

// API publica do Imgflip (sem chave/login) — so os ~100 templates populares,
// sem legenda (colocar legenda de verdade exigiria usuario/senha de uma conta
// Imgflip real, que este bot nao lida).
const IMGFLIP_MEMES_URL = 'https://api.imgflip.com/get_memes';

async function commandMeme({ sock, groupJid, args }) {
  const query = args.trim();
  if (!query) {
    return sock.sendMessage(groupJid, { text: 'Use: !meme nome-do-template (ex: !meme drake). Lista limitada aos ~100 templates mais populares do Imgflip.' });
  }

  try {
    const res = await fetch(IMGFLIP_MEMES_URL);
    if (!res.ok) throw new Error(`status HTTP ${res.status}`);
    const data = await res.json();

    const normalizedQuery = stripAccents(query);
    const meme = data.data.memes.find((m) => stripAccents(m.name).includes(normalizedQuery));

    if (!meme) {
      return sock.sendMessage(groupJid, { text: `Não achei nenhum template com "${query}" entre os populares do Imgflip. Tenta outro nome (ex: drake, distracted boyfriend, doge).` });
    }

    return sock.sendMessage(groupJid, { image: { url: meme.url }, caption: meme.name });
  } catch (err) {
    console.error(`Erro ao buscar meme "${query}":`, err);
    return sock.sendMessage(groupJid, { text: 'Não consegui buscar o meme agora, tenta de novo daqui a pouco.' });
  }
}

// Cliente OpenAI criado sob demanda (so quando o !resumo e chamado), pra nao
// falhar na inicializacao do bot se OPENAI_API_KEY ainda nao estiver configurada.
let openaiClient = null;
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

// Numero da regra sobre iPhone (regras/93.txt) — usado quando a IA detecta tom
// depreciativo numa mensagem que cita "iPhone" mas nao bateu nenhuma frase fixa.
const IPHONE_RULE_NUMBER = '93';

// Manda o aviso padrao de regra quebrada (mesmo texto usado pro match por frase fixa).
async function announceRuleBreak(sock, groupJid, rule) {
  const sent = await sock.sendMessage(groupJid, {
    text: `👮 ✋ Pare amigo, essa é a regra ${rule.number} - ${rule.description} ⚖️`,
  });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
}

// Pede pra IA classificar se uma mensagem que cita "iPhone" fala mal dele
// (tom depreciativo). Sem chave da OpenAI configurada, nao arrisca — retorna false.
async function isIphoneDepreciative(text) {
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
const INSULT_STATE_FILE = path.join(__dirname, '..', 'insultos_state.json');

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
async function isInsultToBot(text) {
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
        { role: 'user', content: text },
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
async function handleBotInsult({ sock, groupJid, senderJid, senderName }) {
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

async function commandResumo({ sock, groupJid }) {
  const client = getOpenAIClient();
  if (!client) {
    return sock.sendMessage(groupJid, {
      text: 'O !resumo precisa de uma chave da OpenAI configurada. Crie um arquivo .env na raiz do projeto com OPENAI_API_KEY=sua-chave e reinicie o bot.',
    });
  }

  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const recentMessages = getMessagesSince(groupJid, since);

  if (recentMessages.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Ainda não há mensagens de texto suficientes nas últimas 24h pra resumir.' });
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
            'Voce resume conversas de um grupo de WhatsApp em portugues do Brasil. Responda em no maximo 10 bullet points, bem curtos e objetivos, so os pontos principais. Nao invente informacao que nao esteja na conversa.',
        },
        { role: 'user', content: `Resuma esta conversa das ultimas 24 horas:\n\n${transcript}` },
      ],
      max_tokens: 350,
    });

    const summary = completion.choices[0]?.message?.content?.trim() || 'Não consegui gerar um resumo.';
    return sock.sendMessage(groupJid, { text: `🧠 Resumo das últimas 24h:\n\n${summary}` });
  } catch (err) {
    console.error('Erro ao gerar resumo com OpenAI:', err);
    return sock.sendMessage(groupJid, { text: 'Não consegui gerar o resumo agora, tenta de novo daqui a pouco.' });
  }
}

// Acha a midia citada (quoted) numa resposta, do tipo pedido (ex: "audioMessage",
// "imageMessage"). Retorna o objeto pronto pra passar pro downloadMediaMessage,
// ou null se a resposta nao citou esse tipo de midia.
function getQuotedMedia(msg, mediaKey) {
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

async function commandTranscrever({ sock, groupJid, msg }) {
  const client = getOpenAIClient();
  if (!client) {
    return sock.sendMessage(groupJid, {
      text: 'O !transcrever precisa de uma chave da OpenAI configurada. Crie um arquivo .env na raiz do projeto com OPENAI_API_KEY=sua-chave e reinicie o bot.',
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
    return sock.sendMessage(groupJid, { text: 'Não consegui transcrever esse áudio, tenta de novo daqui a pouco.' });
  }
}

async function commandFigurinha({ sock, groupJid, msg }) {
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

async function commandRenomearGrupo({ sock, groupJid, args }) {
  const newName = args.trim();
  if (!newName) {
    return sock.sendMessage(groupJid, { text: 'Use: !renomear Novo Nome Do Grupo' });
  }

  try {
    await sock.groupUpdateSubject(groupJid, newName);
    return sock.sendMessage(groupJid, { text: `✅ Nome do grupo atualizado para: *${newName}*` });
  } catch (err) {
    console.error('Erro ao renomear grupo:', err);
    return sock.sendMessage(groupJid, {
      text: 'Não consegui renomear o grupo — confere se o número do bot é admin do grupo (isso é uma exigência do WhatsApp).',
    });
  }
}

async function commandFotoGrupo({ sock, groupJid, msg }) {
  const quotedImage = getQuotedMedia(msg, 'imageMessage');
  if (!quotedImage) {
    return sock.sendMessage(groupJid, { text: 'Responda a uma foto do grupo com !fotogrupo pra eu trocar a foto do grupo por ela.' });
  }

  try {
    const buffer = await downloadMediaMessage(quotedImage, 'buffer', {});
    const sharp = await getSharp();
    const jpegBuffer = await sharp(buffer).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();

    await sock.updateProfilePicture(groupJid, jpegBuffer);
    return sock.sendMessage(groupJid, { text: '✅ Foto do grupo atualizada!' });
  } catch (err) {
    console.error('Erro ao trocar foto do grupo:', err);
    return sock.sendMessage(groupJid, {
      text: 'Não consegui trocar a foto do grupo — confere se o número do bot é admin do grupo (isso é uma exigência do WhatsApp).',
    });
  }
}

async function commandFotoBot({ sock, groupJid, msg }) {
  const quotedImage = getQuotedMedia(msg, 'imageMessage');
  if (!quotedImage) {
    return sock.sendMessage(groupJid, { text: 'Responda a uma foto com !fotobot pra eu trocar a minha própria foto de perfil por ela.' });
  }

  try {
    const buffer = await downloadMediaMessage(quotedImage, 'buffer', {});
    const sharp = await getSharp();
    const jpegBuffer = await sharp(buffer).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();

    await sock.updateProfilePicture(sock.user.id, jpegBuffer);
    return sock.sendMessage(groupJid, { text: '✅ Foto do bot atualizada!' });
  } catch (err) {
    console.error('Erro ao trocar foto do bot:', err);
    return sock.sendMessage(groupJid, { text: 'Não consegui trocar a foto do bot, tenta de novo daqui a pouco.' });
  }
}

const PF_TEXT =
  'NOTA PÚBLICA DE ESCLARECIMENTO: Venho, por meio desta, declarar formalmente que não possuo qualquer ligação com as ' +
  'atividades duvidosas deste recinto virtual. Fui inserido neste grupo contra a minha vontade. Em caso de operação da ' +
  'Polícia Federal, afirmo que sou um mero espectador, aceito delação premiada e já tenho o nome de todos os ' +
  'administradores anotado.';
const IMAGE_ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

// Acha assets/<baseName>.<ext>, testando as extensoes aceitas — assim nao
// importa em que formato a imagem foi salva.
function findImageAsset(baseName) {
  for (const ext of IMAGE_ASSET_EXTENSIONS) {
    const candidate = path.join(__dirname, '..', 'assets', `${baseName}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findPfLogoPath() {
  return findImageAsset('policia-federal');
}

// Comando temporario so pra testar a apuracao eleitoral sem esperar o cron de
// 10 em 10 minutos. Remover depois que a eleicao acabar (junto do resto do
// bloco de eleicoes, ja marcado mais abaixo).
async function commandTestarEleicao({ sock }) {
  await sendElectionUpdate(sock, { force: true });
}

// Comando temporario so pra testar a troca de foto do presidente eleito sem
// esperar a apuracao fechar em 100%. Remover junto do resto do bloco de
// eleicoes, depois que a eleicao acabar.
async function commandTestarFotoPresidente({ sock, groupJid, args }) {
  const nome = args.trim();
  if (!nome) {
    return sock.sendMessage(groupJid, { text: 'Use: !testarfotopresidente lula  OU  !testarfotopresidente flavio' });
  }
  await updateGroupPhotoWithElectionWinner(sock, groupJid, nome);
  return sock.sendMessage(groupJid, { text: `Testei a troca de foto pro vencedor "${nome}" — confere se mudou.` });
}

// Comando temporario so pra testar o anuncio do resultado final + renomeacao
// do grupo ("DEU LULA"/"DEU FLAVIO") sem esperar a apuracao fechar em 100%.
// ATENCAO: isso renomeia o grupo de verdade. Remover junto do resto do bloco
// de eleicoes, depois que a eleicao acabar.
async function commandTestarResultadoEleicao({ sock, groupJid, args }) {
  const nome = args.trim();
  if (!nome) {
    return sock.sendMessage(groupJid, { text: 'Use: !testarresultadoeleicao lula  OU  !testarresultadoeleicao flavio (isso RENOMEIA o grupo de verdade)' });
  }
  await announceElectionWinner(sock, groupJid, nome);
}

async function commandPoliciaFederal({ sock, groupJid }) {
  const logoPath = findPfLogoPath();
  if (!logoPath) {
    return sock.sendMessage(groupJid, { text: PF_TEXT });
  }
  return sock.sendMessage(groupJid, { image: { url: logoPath }, caption: PF_TEXT });
}

async function commandOtario({ sock, groupJid, msg }) {
  const repliedJid = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (!repliedJid) {
    return sock.sendMessage(groupJid, { text: 'Responda a uma mensagem da pessoa com !otario pra marcar ela.' });
  }

  return sock.sendMessage(groupJid, {
    text: `podem sair de casa pessoal, o malandro encontrou @${repliedJid.split('@')[0]}`,
    mentions: [repliedJid],
  });
}

async function commandEventos({ sock, groupJid }) {
  const events = loadEvents();
  if (events.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum evento cadastrado ainda (edite o arquivo events.json).' });
  }

  const today = getBrasiliaNow().date;
  const upcoming = events.filter((e) => e.date >= today);
  if (upcoming.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum evento futuro cadastrado no momento.' });
  }

  const sorted = [...upcoming].sort((a, b) => a.date.localeCompare(b.date));
  const blocks = sorted.map((e, i) => {
    const lines = [`📅 *${e.title}*`, `Data: ${formatDateBR(e.date)}`, `Local: ${e.location}`, `Horário: ${e.time}`];
    for (const [label, value] of Object.entries(e.extra || {})) {
      lines.push(`${label}: ${value}`);
    }
    if (e.attendees?.length) {
      lines.push(`Confirmados (${e.attendees.length}):`);
      e.attendees.forEach((a, idx) => lines.push(`${idx + 1}. ${formatDisplayName(a.name)}`));
    }
    if (e.absentees?.length) {
      if (e.attendees?.length) lines.push('----');
      lines.push(`Ausentes (${e.absentees.length}):`);
      e.absentees.forEach((a, idx) => lines.push(`${idx + 1}. ${formatDisplayName(a.name)}`));
    }
    const block = lines.join('\n');
    return sorted.length > 1 ? `*EVENTO ${i + 1}*\n\n${block}` : block;
  });

  return sock.sendMessage(groupJid, { text: blocks.join('\n\n-----------------\n\n') });
}

async function commandRegras({ sock, groupJid }) {
  const rules = loadRules();
  if (rules.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhuma regra cadastrada ainda (crie um arquivo .txt na pasta regras/).' });
  }

  const lines = rules.map((r) => `Regra ${r.number} - ${r.description}`);
  return sock.sendMessage(groupJid, { text: `📜 *Regras do grupo*\n\n${lines.join('\n')}` });
}

async function commandRegulamento({ sock, groupJid }) {
  if (!fs.existsSync(REGULAMENTO_FILE)) {
    return sock.sendMessage(groupJid, { text: 'Regulamento ainda não cadastrado (crie o arquivo regulamento.txt na raiz do projeto).' });
  }
  const text = fs.readFileSync(REGULAMENTO_FILE, 'utf-8').trim();
  return sock.sendMessage(groupJid, { text });
}

async function commandMegasena({ sock, groupJid }) {
  if (!fs.existsSync(MEGASENA_FILE)) {
    return sock.sendMessage(groupJid, { text: 'Lista de organizadores ainda não cadastrada (crie o arquivo megasena.txt na raiz do projeto).' });
  }
  const text = fs.readFileSync(MEGASENA_FILE, 'utf-8').trim();
  return sock.sendMessage(groupJid, { text });
}

async function commandSchedule({ sock, groupJid }) {
  const pending = loadScheduledMessages().filter((m) => !m.sent);
  if (pending.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhuma mensagem agendada no momento (edite o arquivo scheduled_messages.json).' });
  }

  const sorted = [...pending].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const blocks = sorted.map((m, i) => {
    const lines = [`Data: ${formatDateBR(m.date)} às ${m.time}`];
    if (m.text) lines.push(`Texto: ${m.text}`);
    if (m.audio) lines.push(`Áudio: ${m.audio}`);
    const block = lines.join('\n');
    return sorted.length > 1 ? `*Schedule ${i + 1}*\n${block}` : block;
  });

  return sock.sendMessage(groupJid, { text: `📅 *Mensagens agendadas*\n\n${blocks.join('\n\n-----------------\n\n')}` });
}

async function commandAddEvento({ sock, groupJid, args }) {
  const usage =
    'Formato: !addevento, nome do evento numa linha e depois os campos, um por linha. Exemplo:\n\n' +
    '!addevento\nChurrasco de fim de ano\nData: 20/12/26\nHorário: 13h\nLocal: Casa do Thierry';

  const lines = args.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return sock.sendMessage(groupJid, { text: usage });
  }

  const [title, ...detailLines] = lines;
  let date = null;
  let location = null;
  let time = null;
  const extra = {};

  for (const line of detailLines) {
    // linha solta tipo "13:00" ou "13h" (sem rotulo "Horário:") — trata como horario
    // direto, senao ia virar um campo extra sem sentido tipo { "13": "00" }.
    if (!time && /^\d{1,2}([:h]\d{0,2})?h?$/i.test(line)) {
      time = line;
      continue;
    }

    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) continue;
    const label = line.slice(0, sepIndex).trim();
    const value = line.slice(sepIndex + 1).trim();
    const normalizedLabel = stripAccents(label);

    if (normalizedLabel === 'data') date = parseDateBR(value);
    else if (normalizedLabel === 'local') location = value;
    else if (normalizedLabel === 'horario') time = value;
    else extra[label] = value;
  }

  if (!date) {
    return sock.sendMessage(groupJid, {
      text: 'Não consegui entender a data do evento. Use "Data: DD/MM/AA" (ex: Data: 03/10/26).\n\n' + usage,
    });
  }

  if (eventTitleExists(title)) {
    return sock.sendMessage(groupJid, { text: `Já existe um evento chamado *${title}*. Use outro nome (o nome identifica o evento).` });
  }

  const event = {
    title,
    date,
    location: location || '(local não informado)',
    time: time || '(horário não informado)',
    extra,
  };
  addEvent(event);

  const confirmLines = [`✅ Evento cadastrado:`, ``, `📅 *${event.title}*`, `Data: ${formatDateBR(event.date)}`, `Local: ${event.location}`, `Horário: ${event.time}`];
  for (const [label, value] of Object.entries(extra)) confirmLines.push(`${label}: ${value}`);

  return sock.sendMessage(groupJid, { text: confirmLines.join('\n') });
}

// Logica compartilhada por !vou e !naovou: acha o evento (por !vou sozinho
// quando so ha um futuro, por "evento1"/"evento2" ou por nome/trecho) e
// aplica storeFn (addAttendee ou addAbsentee) nele.
async function handleAttendanceCommand({ sock, groupJid, senderJid, senderName, args }, { commandName, storeFn, successText }) {
  const query = args.trim();
  // mesma ordem/numeracao usada pelo !eventos (EVENTO 1, EVENTO 2...)
  const upcoming = findUpcomingEvents('').sort((a, b) => a.date.localeCompare(b.date));

  if (upcoming.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Não há eventos futuros cadastrados. Use !addevento pra criar um.' });
  }

  const indexMatch = query.match(/^evento\s*(\d+)$/i);

  let matches;
  if (indexMatch) {
    const event = upcoming[Number(indexMatch[1]) - 1];
    matches = event ? [event] : [];
  } else if (!query) {
    if (upcoming.length === 1) {
      matches = upcoming;
    } else {
      const options = upcoming.map((e, i) => `!${commandName} evento${i + 1}`).join('\n');
      return sock.sendMessage(groupJid, { text: `Tem mais de um evento futuro. Qual deles?\n\n${options}` });
    }
  } else {
    matches = findUpcomingEvents(query);
  }

  if (matches.length === 0) {
    return sock.sendMessage(groupJid, { text: `Não encontrei nenhum evento futuro com "${query}". Digite !eventos pra ver os cadastrados e o número de cada um.` });
  }
  if (matches.length > 1) {
    const options = matches.map((e) => `!${commandName} ${e.title}`).join('\n');
    return sock.sendMessage(groupJid, { text: `Achei mais de um evento com esse nome. Qual deles?\n\n${options}` });
  }

  const event = matches[0];
  storeFn(event.title, { jid: senderJid, name: senderName });
  return sock.sendMessage(groupJid, { text: successText(event, senderName) });
}

async function commandVou(ctx) {
  return handleAttendanceCommand(ctx, {
    commandName: 'vou',
    storeFn: addAttendee,
    successText: (event, senderName) => `✅ ${formatDisplayName(senderName)} confirmado(a) em *${event.title}*!`,
  });
}

async function commandNaoVou(ctx) {
  return handleAttendanceCommand(ctx, {
    commandName: 'naovou',
    storeFn: addAbsentee,
    successText: (event, senderName) => `❌ ${formatDisplayName(senderName)} marcado(a) como ausente em *${event.title}*.`,
  });
}

// !painel — manda no PRIVADO de quem pediu um link de uso unico (vale 5 min)
// que entra no painel ja identificado pelo WhatsApp, pra marcar presenca nos
// eventos sem senha nem cadastro de telefone.
async function commandPainel({ sock, groupJid, senderJid, senderName }) {
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

// Membros do grupo principal (pra achar o nome de exibicao de cada aniversariante).
function getBirthdayMembers() {
  return getMembersWithExtras();
}

async function commandAniversariantes({ sock, groupJid }) {
  const all = loadBirthdays();
  if (all.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum aniversariante cadastrado ainda (edite o arquivo birthdays.json).' });
  }
  const sorted = [...all].sort((a, b) => a.month - b.month || a.day - b.day);
  const members = getBirthdayMembers();
  const lines = sorted.map((b) => `${String(b.day).padStart(2, '0')}/${String(b.month).padStart(2, '0')} — ${birthdayDisplayName(b, members)}`);
  return sock.sendMessage(groupJid, { text: `🎂 Aniversariantes cadastrados:\n\n${lines.join('\n')}` });
}

// Categorias exibidas pelo !menu. Ao adicionar um comando novo, inclua ele
// numa categoria existente (ou crie uma nova) aqui.
const COMMAND_CATEGORIES = [
  {
    emoji: '📊',
    title: 'Ranking e regras',
    commands: [
      { name: 'ranking', description: 'ranking de mensagens de hoje, com percentual e total' },
      { name: 'regras', description: 'lista as regras do grupo' },
      { name: 'regulamento', description: 'mostra o manifesto oficial do grupo' },
    ],
  },
  {
    emoji: '🎉',
    title: 'Eventos',
    commands: [
      { name: 'eventos', description: 'lista os eventos cadastrados' },
      { name: 'addevento', description: 'cadastra um novo evento (manda sozinho pra ver o formato)' },
      { name: 'vou', description: 'confirma sua presença num evento' },
      { name: 'naovou', description: 'marca ausência num evento' },
    ],
  },
  {
    emoji: '🎂',
    title: 'Aniversários',
    commands: [{ name: 'aniversariantes', description: 'lista os aniversariantes cadastrados' }],
  },
  {
    emoji: '🗞️',
    title: 'Outros',
    commands: [
      { name: 'painel', description: 'te manda no privado um link pro painel, pra marcar presença nos eventos' },
      { name: 'news', description: 'manchete mais recente do G1' },
      { name: 'resumo', description: 'resume as mensagens das últimas 24h, em até 10 tópicos (via IA)' },
      { name: 'transcrever', description: 'transcreve um áudio — responda o áudio com !transcrever' },
      { name: 'figurinha', description: 'transforma uma foto em figurinha — responda a foto com !figurinha' },
      { name: 'renomear', description: 'muda o nome do grupo — !renomear novo nome' },
      { name: 'fotogrupo', description: 'responda a uma foto com !fotogrupo pra trocar a foto do grupo por ela' },
      { name: 'fotobot', description: 'responda a uma foto com !fotobot pra trocar a foto de perfil do próprio bot por ela' },
      { name: 'schedule', description: 'lista as mensagens agendadas pendentes' },
      { name: 'meme', description: 'manda um template de meme popular — !meme nome (ex: drake)' },
      { name: 'megasena', description: 'lista os organizadores da Mega da Virada de cada ano' },
      { name: 'policiafederal', description: 'nota pública de esclarecimento, pra qualquer eventualidade' },
      { name: 'otario', description: 'responda a uma mensagem com !otario pra marcar quem mandou ela' },
    ],
  },
  {
    emoji: '🔊',
    title: 'Áudios',
    commands: [
      { name: 'audios', description: 'lista de áudios disponíveis' },
      { name: 'salvaraudio', description: 'salva um áudio — responda o áudio com !salvaraudio nome' },
    ],
  },
];

// Mapa comando -> handler. Pra adicionar um comando novo: escreva a funcao
// (recebe { sock, groupJid } e retorna o resultado de sock.sendMessage),
// registre aqui e adicione a descricao em COMMAND_HELP.
const commands = {
  ranking: commandRanking,
  aniversariantes: commandAniversariantes,
  eventos: commandEventos,
  addevento: commandAddEvento,
  vou: commandVou,
  naovou: commandNaoVou,
  menu: commandMenu,
  painel: commandPainel,
  news: commandNews,
  resumo: commandResumo,
  transcrever: commandTranscrever,
  figurinha: commandFigurinha,
  renomear: commandRenomearGrupo,
  fotogrupo: commandFotoGrupo,
  fotobot: commandFotoBot,
  schedule: commandSchedule,
  meme: commandMeme,
  megasena: commandMegasena,
  policiafederal: commandPoliciaFederal,
  testareleicao: commandTestarEleicao,
  testarpropaganda: commandTestarPropaganda,
  testarbomdia: commandTestarBomDia,
  testaraniversario: commandTestarAniversario,
  testarfotopresidente: commandTestarFotoPresidente,
  testarresultadoeleicao: commandTestarResultadoEleicao,
  otario: commandOtario,
  audios: commandAudios,
  salvaraudio: commandSalvarAudio,
  regras: commandRegras,
  regulamento: commandRegulamento,
};

// Reverte pro nome original os grupos que foram renomeados pra "Parabens" de
// um aniversario anterior (chamado sempre antes de processar o nome de hoje,
// pra nao acumular renomeacoes de dias passados).
async function revertPendingGroupRenames(sock) {
  const pending = getPendingGroupRenames();
  const groupJids = Object.keys(pending);
  if (groupJids.length === 0) return;

  for (const groupJid of groupJids) {
    try {
      await sock.groupUpdateSubject(groupJid, pending[groupJid]);
    } catch (err) {
      console.error(`Erro ao reverter nome do grupo ${groupJid}:`, err);
    }
  }
  setPendingGroupRenames({});
}

// Junta uma lista de nomes em texto natural: "A" / "A e B" / "A, B e C".
function joinNamesWithE(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} e ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

/**
 * Sincroniza o NOME do grupo com o(s) aniversariante(s) de hoje — reverte
 * qualquer renomeacao de um dia anterior e, se hoje for aniversario de
 * alguem, renomeia de novo. Se houver mais de um aniversariante no mesmo dia
 * (ex: Lucas e Vini, 30/03), o nome junta os dois (ex: "Parabens, Lucas e
 * Vini!"), em vez de so o primeiro da lista. Roda logo depois da meia-noite
 * (cron) e tambem ao conectar, pra garantir que o nome ja esteja certo o
 * quanto antes, mesmo quando ha aniversarios em dias seguidos (ex: dia 07 e
 * 08) — nesse caso cada troca de dia ja reverte pro nome anterior (capturado
 * no dia de antes) e renomeia pro(s) aniversariante(s) novo(s), em sequencia,
 * sem nunca ficar "preso" num nome antigo. So uma vez por dia (controlado por
 * birthday_state.json).
 */
async function syncGroupNameForBirthdays(sock) {
  const todayKey = getBrasiliaNow().date;
  if (getLastGroupNameSyncDate() === todayKey) return;

  await revertPendingGroupRenames(sock);

  const todaysBirthdays = getBirthdaysToday();
  let allGroupJids = null; // cache: so busca se precisar (aniversariante sem groupJid definido)
  const namesByGroup = new Map(); // groupJid -> nomes dos aniversariantes de hoje nesse grupo

  for (const person of todaysBirthdays) {
    let targetJids = person.groupJid ? [person.groupJid] : null;
    if (!targetJids) {
      if (!allGroupJids) {
        const participating = await sock.groupFetchAllParticipating();
        allGroupJids = Object.keys(participating);
      }
      targetJids = allGroupJids;
    }

    for (const groupJid of targetJids) {
      if (!namesByGroup.has(groupJid)) namesByGroup.set(groupJid, []);
      namesByGroup.get(groupJid).push(birthdayDisplayName(person, getBirthdayMembers()));
    }
  }

  const newPendingRenames = {};
  for (const [groupJid, names] of namesByGroup) {
    try {
      const metadata = await sock.groupMetadata(groupJid);
      newPendingRenames[groupJid] = metadata.subject;
      await sock.groupUpdateSubject(groupJid, `🎉 Parabéns, ${joinNamesWithE(names)}! 🎂`);
    } catch (err) {
      console.error(`Erro ao renomear grupo ${groupJid} pro(s) aniversario(s) de ${names.join(', ')}:`, err);
      delete newPendingRenames[groupJid];
    }
  }

  if (Object.keys(newPendingRenames).length > 0) setPendingGroupRenames(newPendingRenames);
  setLastGroupNameSyncDate(todayKey);
}

// Manda o aviso de texto de aniversario no grupo, no maximo uma vez por dia
// (controlado por birthday_state.json). O nome do grupo e tratado a parte,
// por syncGroupNameForBirthdays — essa funcao so cuida da mensagem.
// Foto do aniversariante: tenta a de resolucao cheia direto do WhatsApp (o
// cache do painel e pequeno, 128px, e borra num cartao grande); se a privacidade
// bloquear ou falhar, usa a do cache; sem nenhuma, o cartao usa a inicial.
async function getBirthdayPhotoBuffer(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch {
    // sem foto / privacidade — cai no cache
  }
  try {
    const cached = fs.readFileSync(getAvatarPath(jid));
    if (cached.length > 0) return cached;
  } catch {
    // sem cache
  }
  return null;
}

// Monta o cartao de aniversario pra uma lista de pessoas { name, day, month }
// do mesmo dia. Lanca erro se nao der pra desenhar (quem chama cai no texto).
async function buildBirthdayCard(sock, people, members = getBirthdayMembers()) {
  const cardPeople = [];
  for (const person of people) {
    // Foto enviada na mao pelo painel vence a do WhatsApp.
    const match = resolveBirthdayMember(person, members);
    let photoUri = null;
    try {
      const uploaded = (match && readMemberPhoto(match.jid)) || readBirthdayPhoto(person.name);
      const buffer = uploaded || (match ? await getBirthdayPhotoBuffer(sock, match.jid) : null);
      if (buffer) photoUri = await photoToDataUri(buffer);
    } catch (err) {
      console.error(`Erro ao preparar a foto de ${person.name} pro cartao de aniversario:`, err);
    }
    cardPeople.push({ name: person.display || person.name, photoUri });
  }
  return renderBirthdayCard(cardPeople, people[0].day, people[0].month);
}

function birthdayCaption(people) {
  const names = people.map((p) => `*${p.display || p.name}*`);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}` : names[0];
  return `🎉🎂 Hoje é aniversário de ${joined}! Parabéns! 🎉🎂`;
}

// Manda o aviso de aniversario num grupo: cartao em imagem com a legenda; se o
// cartao nao puder ser gerado, manda so o texto (como era antes).
async function sendBirthdayToGroup(sock, groupJid, rawPeople) {
  // "name" continua sendo o da lista (pra achar foto/ligacao); "display" e o nome padronizado que sai no texto.
  const members = getBirthdayMembers();
  const people = rawPeople.map((p) => ({ ...p, display: birthdayDisplayName(p, members) }));
  const caption = birthdayCaption(people);
  let image = null;
  try {
    image = await buildBirthdayCard(sock, people, members);
  } catch (err) {
    console.error('Erro ao montar o cartao de aniversario (mandando em texto):', err);
  }
  const sent = await sock.sendMessage(groupJid, image ? { image, caption } : { text: caption });
  if (sent?.key?.id) sentByBot.add(sent.key.id);
}

async function checkAndSendBirthdays(sock) {
  const todayKey = getBrasiliaNow().date;
  if (getLastBirthdayCheckDate() === todayKey) return;

  const todaysBirthdays = getBirthdaysToday();
  let allGroupJids = null; // cache: so busca se precisar (aniversariante sem groupJid definido)

  // Um cartao por grupo, juntando quem faz aniversario no mesmo dia.
  const peopleByGroup = new Map();
  for (const person of todaysBirthdays) {
    let targetJids = person.groupJid ? [person.groupJid] : null;
    if (!targetJids) {
      if (!allGroupJids) {
        const participating = await sock.groupFetchAllParticipating();
        allGroupJids = Object.keys(participating);
      }
      targetJids = allGroupJids;
    }
    for (const groupJid of targetJids) {
      if (!peopleByGroup.has(groupJid)) peopleByGroup.set(groupJid, []);
      peopleByGroup.get(groupJid).push(person);
    }
  }

  for (const [groupJid, people] of peopleByGroup) {
    try {
      await sendBirthdayToGroup(sock, groupJid, people);
    } catch (err) {
      console.error(`Erro ao enviar aviso de aniversario (${people.map((p) => p.name).join(', ')}) para ${groupJid}:`, err);
    }
  }

  setLastBirthdayCheckDate(todayKey);
}

// !testaraniversario [nome] — manda o cartao so no grupo onde foi digitado, pra
// ver como fica: usa o aniversariante com esse nome, ou o proximo da lista.
async function commandTestarAniversario({ sock, groupJid, args }) {
  const all = loadBirthdays();
  if (all.length === 0) return sock.sendMessage(groupJid, { text: 'Nenhum aniversariante cadastrado.' });

  const query = normalizeName(args);
  let person = query ? all.find((b) => normalizeName(b.name).includes(query)) : null;
  if (query && !person) return sock.sendMessage(groupJid, { text: `Não achei "${args}" na lista de aniversariantes.` });
  if (!person) {
    const today = getBrasiliaNow().date; // YYYY-MM-DD
    const todayKey = Number(today.slice(5, 7)) * 100 + Number(today.slice(8, 10));
    const keyOf = (b) => b.month * 100 + b.day;
    person = [...all].sort((a, b) => keyOf(a) - keyOf(b)).find((b) => keyOf(b) >= todayKey) || [...all].sort((a, b) => keyOf(a) - keyOf(b))[0];
  }
  const sameDay = all.filter((b) => b.day === person.day && b.month === person.month);
  return sendBirthdayToGroup(sock, groupJid, query ? [person] : sameDay);
}

// Mensagem automatica das 8h, mandada em todos os grupos que o bot participa.
// So em dia util (o cron ja restringe a segunda-sexta) e fora de feriado nacional.
// Propaganda da UniTV: foto (assets/propaganda-unitv.jpg) com a legenda na
// mesma mensagem. Se a foto sumir, manda so o texto. A marcacao #ad precisa
// ficar sempre visivel (publicidade paga).
const AD_CAPTION = '*#ad* 📺 Cansou de pagar 6 streamings? UniTV: planos a partir de *R$ 25,00*. Cupom *GEFF10%OFF* 🎟️';

async function sendAdToGroup(sock, groupJid) {
  const imagePath = findImageAsset('propaganda-unitv');
  const content = imagePath ? { image: fs.readFileSync(imagePath), caption: AD_CAPTION } : { text: AD_CAPTION };
  const sent = await sock.sendMessage(groupJid, content);
  if (sent?.key?.id) sentByBot.add(sent.key.id);
  return sent;
}

async function sendAdMessage(sock) {
  const participating = await sock.groupFetchAllParticipating();
  for (const groupJid of Object.keys(participating)) {
    try {
      await sendAdToGroup(sock, groupJid);
    } catch (err) {
      console.error(`Erro ao enviar propaganda para ${groupJid}:`, err);
    }
  }
}

// !testarpropaganda — manda a propaganda so no grupo onde foi digitado (pra ver como fica).
async function commandTestarPropaganda({ sock, groupJid }) {
  return sendAdToGroup(sock, groupJid);
}

// Bom dia: cartao de previsao em imagem (src/weatherCard.js) com o texto como
// legenda. Se a previsao ou a imagem falharem, cai no texto com o bloco de
// clima (ou so o bom dia, se nem a previsao veio). onlyGroupJid manda so num
// grupo (usado pelo !testarbomdia).
async function sendMorningMessage(sock, onlyGroupJid = null) {
  const { date: today } = getBrasiliaNow();
  const holidayName = await getHolidayName(today);

  const diaSemana = new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, weekday: 'long' }).format(new Date());
  let text = holidayName
    ? `☀️ Bom dia, grupo! Hoje é *${diaSemana}*, feriado nacional: *${holidayName}* 🎉 Aproveitem o dia de folga!`
    : `☀️ Bom dia, grupo! Hoje é *${diaSemana}*. Bom trabalho a todos! 💪`;

  // Previsao do tempo e so um complemento — se a API estiver fora do ar, o
  // bom dia sai do mesmo jeito, so sem o clima.
  let weather = [];
  try {
    weather = await getWeatherData();
  } catch (err) {
    console.error('Erro ao buscar previsao do tempo pra mensagem de bom dia:', err);
  }

  let image = null;
  if (weather.length > 0) {
    try {
      image = await renderWeatherCard(weather);
    } catch (err) {
      console.error('Erro ao montar o cartao de previsao (mandando em texto):', err);
      text += `\n\n${formatWeatherBlock(weather)}`;
    }
  }

  const groupJids = onlyGroupJid ? [onlyGroupJid] : Object.keys(await sock.groupFetchAllParticipating());
  for (const groupJid of groupJids) {
    try {
      const sent = await sock.sendMessage(groupJid, image ? { image, caption: text } : { text });
      if (sent?.key?.id) sentByBot.add(sent.key.id);
    } catch (err) {
      console.error(`Erro ao enviar mensagem de bom dia para ${groupJid}:`, err);
    }
  }
}

// !testarbomdia — manda o bom dia so no grupo onde foi digitado (pra ver como fica).
async function commandTestarBomDia({ sock, groupJid }) {
  await sendMorningMessage(sock, groupJid);
}

// Mensagem automatica das 18h: soma o tempo "perdido" e o ranking completo do
// expediente (ultimas 10h corridas — 8h as 18h), pra cada grupo que o bot participa.
async function sendEndOfDayMessage(sock) {
  const { date: today } = getBrasiliaNow();
  if (await isBrazilianHoliday(today)) {
    debugLog(`[debug] ${today} e feriado nacional — mensagem de fim de expediente nao enviada.`);
    return;
  }

  const since = Math.floor(Date.now() / 1000) - (EVENING_HOUR - MORNING_HOUR) * 60 * 60;
  const participating = await sock.groupFetchAllParticipating();

  for (const groupJid of Object.keys(participating)) {
    const counts = getCountsSince(groupJid, since);
    const totalMessages = counts.reduce((sum, c) => sum + c.total, 0);

    const lines = [
      `🔔 Expediente encerrado! Esses são os dados das ${String(MORNING_HOUR).padStart(2, '0')} às ${String(EVENING_HOUR).padStart(2, '0')}. Parabéns Inimigos da Produtividade.`,
    ];
    if (counts.length > 0) {
      lines.push('', '📊 Ranking do dia:', '');
      counts.forEach((c, i) => {
        const percent = Math.round((c.total / totalMessages) * 100);
        lines.push(`${i + 1}. ${formatDisplayName(c.sender_name)}: ${c.total} msgs (${percent}%)`);
      });
      lines.push('', `total de ${totalMessages} Mensagens! 😅`);
    }
    lines.push('', `Para mais informações acesse: ${DASHBOARD_URL}`);

    try {
      await sock.sendMessage(groupJid, { text: lines.join('\n') });
    } catch (err) {
      console.error(`Erro ao enviar mensagem de fim de expediente para ${groupJid}:`, err);
    }
  }
}

// Acha o JID de um grupo pelo nome (subject) — Baileys so indexa grupos por
// JID, entao e preciso listar todos os grupos que o bot participa e comparar.
// Acha o grupo "principal" do bot SEM depender do nome (que muda com frequencia):
// se o bot esta em um grupo so, e ele; se em varios, o mais ativo nos ultimos 7 dias.
async function findMainGroupJid(sock) {
  const participating = await sock.groupFetchAllParticipating();
  const jids = Object.keys(participating);
  if (jids.length === 1) return jids[0];
  const active = getMainGroupJid();
  return active && jids.includes(active) ? active : null;
}

// Data da eleicao (1o turno 2026) em que a apuracao ao vivo deve rodar —
// feature de uso unico pra hoje, 04/10/2026. Depois da eleicao, da pra
// remover esse bloco inteiro (constantes, funcao, state file e o cron la
// embaixo) sem afetar mais nada do bot.
const ELECTION_DATE = '2026-10-25';
// Urnas fecham as 17h (horario de Brasilia) — o TSE so comeca a publicar
// resultado a partir desse horario, entao nao faz sentido mandar atualizacao
// (sempre 0%) antes disso.
const ELECTION_RESULTS_START_HOUR = 17;
const ELECTION_STATE_FILE = path.join(__dirname, '..', 'eleicoes_state.json');

function isElectionFinalized() {
  if (!fs.existsSync(ELECTION_STATE_FILE)) return false;
  try {
    return JSON.parse(fs.readFileSync(ELECTION_STATE_FILE, 'utf-8')).finalized === true;
  } catch {
    return false;
  }
}

function setElectionFinalized(value) {
  fs.writeFileSync(ELECTION_STATE_FILE, JSON.stringify({ finalized: value }));
}

function formatRaceBlock(titulo, resumo) {
  const lines = [`${titulo} — urnas apuradas: ${resumo.urnasPercentual}%`];
  resumo.candidatos.slice(0, 5).forEach((c, i) => {
    lines.push(`${i + 1}. ${c.nome} (${c.numero}) — ${c.percentual}% (${c.votos.toLocaleString('pt-BR')} votos)`);
  });
  return lines.join('\n');
}

/**
 * Manda a apuracao parcial do 2o turno (so Presidente — Governador de SP ja
 * foi decidido no 1o turno, Tarcisio com 62,65%) no grupo, de 10 em 10
 * minutos no dia da eleicao — para sozinho de mandar quando as urnas
 * chegarem a 100% apuradas.
 */
async function sendElectionUpdate(sock, { force = false } = {}) {
  const { date: today, time } = getBrasiliaNow();
  const hourNow = Number(time.split(':')[0]);
  if (!force && (today !== ELECTION_DATE || hourNow < ELECTION_RESULTS_START_HOUR || isElectionFinalized())) return;

  const groupJid = await findMainGroupJid(sock);
  if (!groupJid) {
    console.error('[eleicoes] Grupo principal nao encontrado entre os grupos que o bot participa.');
    return;
  }

  let presidente;
  try {
    presidente = await getPresidentSummary();
  } catch (err) {
    console.error('[eleicoes] Erro ao buscar apuracao do TSE:', err);
    return;
  }

  let regioes = null;
  try {
    regioes = await getUrnasApuradasPorRegiao();
  } catch (err) {
    console.error('[eleicoes] Erro ao buscar urnas apuradas por regiao:', err);
  }
  const regioesBlock = regioes
    ? '\n\n🗺️ *Urnas apuradas por região*\n' + regioes.map((r) => `${r.nome}: ${r.percentual}%`).join('\n')
    : '';

  const text =
    `🗳️ *Apuração Eleições 2026 — 2º Turno* — atualizado às ${presidente.atualizadoEm}\n\n` +
    `${formatRaceBlock('🏛️ *Presidente (Brasil)*', presidente)}` +
    regioesBlock;

  try {
    await sock.sendMessage(groupJid, { text });
  } catch (err) {
    console.error('[eleicoes] Erro ao enviar atualizacao da apuracao:', err);
    return;
  }

  if (presidente.urnasPercentualNum >= 100) {
    setElectionFinalized(true);
    console.log('[eleicoes] Apuração chegou a 100% das urnas — parando os envios.');

    const winnerName = presidente.candidatos[0]?.nome;
    await announceElectionWinner(sock, groupJid, winnerName);

    try {
      await updateGroupPhotoWithElectionWinner(sock, groupJid, winnerName);
    } catch (err) {
      console.error('[eleicoes] Erro ao atualizar foto do grupo com o presidente eleito:', err);
    }
  }
}

// Persona visual pra cada candidato do 2o turno — cores dos partidos/espectro
// politico (Flavio Bolsonaro = direita, azul; Lula = esquerda, vermelho),
// usada pra fantasiar a foto do bot quando a apuracao fecha em 100%.
const ELECTION_WINNER_PERSONAS = [
  {
    match: /BOLSONARO/i,
    displayName: 'Flávio Bolsonaro',
    groupName: 'DEU FLAVIO',
    persona:
      'presidente do Brasil recem-eleito, terno azul marinho, gravata azul, faixa presidencial verde-amarela no peito, ' +
      'bandeira do Brasil ao fundo, iluminacao em tom azul patriotico, expressao confiante',
  },
  {
    match: /LULA/i,
    displayName: 'Lula',
    groupName: 'DEU LULA',
    persona:
      'presidente do Brasil recem-eleito, camisa social vermelha, faixa presidencial verde-amarela no peito, ' +
      'bandeira do Brasil ao fundo, iluminacao em tom vermelho vibrante, expressao confiante e sorridente',
  },
];

function findElectionWinnerPersona(winnerName) {
  if (!winnerName) return null;
  return ELECTION_WINNER_PERSONAS.find((p) => p.match.test(winnerName)) || null;
}

/**
 * Manda a mensagem de resultado final ("fulano foi eleito presidente") e
 * renomeia o grupo pra "DEU FLAVIO"/"DEU LULA", assim que a apuracao fecha em
 * 100%. Registra o nome original como "pending rename" (mesmo mecanismo do
 * tema de aniversario) pra voltar sozinho pro nome que o grupo tinha antes na
 * proxima meia-noite, via revertPendingGroupRenames (cron '1 0 * * *').
 */
async function announceElectionWinner(sock, groupJid, winnerName) {
  const match = findElectionWinnerPersona(winnerName);
  if (!match) {
    console.error(`[eleicoes] Nenhuma persona cadastrada pro candidato vencedor "${winnerName}", pulando anuncio/renomeacao.`);
    return;
  }

  try {
    await sock.sendMessage(groupJid, {
      text: `🚨 *RESULTADO FINAL* 🚨\n\n${match.displayName} foi eleito(a) Presidente do Brasil! 🇧🇷`,
    });
  } catch (err) {
    console.error('[eleicoes] Erro ao mandar anuncio do resultado final:', err);
  }

  try {
    // Guarda o nome ATUAL do grupo (ele muda com frequencia) pra voltar pra ele
    // na meia-noite; se ja existe uma reversao pendente (ex: tema de aniversario),
    // mantem o nome original que ja estava guardado.
    const pending = getPendingGroupRenames();
    const originalName = pending[groupJid] || (await sock.groupMetadata(groupJid)).subject;
    await sock.groupUpdateSubject(groupJid, match.groupName);
    console.log(`[eleicoes] Grupo renomeado para "${match.groupName}".`);

    pending[groupJid] = originalName;
    setPendingGroupRenames(pending);
    console.log(`[eleicoes] Reversao pra "${originalName}" agendada pra meia-noite.`);
  } catch (err) {
    console.error('[eleicoes] Erro ao renomear o grupo com o resultado final:', err);
  }
}

/**
 * Troca a foto do grupo com o tema do presidente eleito assim que a apuracao
 * do 2o turno fecha em 100% — mesmo mecanismo de edicao de foto usado pras
 * manchetes do dia (editBotPhoto), so que com persona fixa por candidato em
 * vez de escolhida pela IA.
 */
async function updateGroupPhotoWithElectionWinner(sock, groupJid, winnerName) {
  if (!winnerName) {
    console.error('[eleicoes] Nome do candidato vencedor nao disponivel, pulando troca de foto.');
    return;
  }
  const match = findElectionWinnerPersona(winnerName);
  if (!match) {
    console.error(`[eleicoes] Nenhuma persona cadastrada pro candidato vencedor "${winnerName}", pulando troca de foto.`);
    return;
  }

  const client = getOpenAIClient();
  if (!client) {
    console.error('[eleicoes] OPENAI_API_KEY nao configurada, pulando troca de foto.');
    return;
  }

  const editedPhoto = await editBotPhoto(client, match.persona);
  await sock.updateProfilePicture(groupJid, editedPhoto);
  console.log(`[eleicoes] Foto do grupo atualizada com o tema do presidente eleito: "${winnerName}"`);
}

/**
 * Escolhe, entre as manchetes recentes do G1, a noticia mais importante nacionalmente do
 * dia (via IA) e troca a foto do grupo principal por uma edicao
 * tematica da foto-base do bot (assets/bot-photo.png), incorporando o tema
 * visual da noticia. So mexe nesse grupo especifico — nenhum outro grupo tem
 * a foto alterada por essa rotina.
 */
async function updateGroupPhotoWithNews(sock) {
  const client = getOpenAIClient();
  if (!client) {
    console.error('[foto do grupo] OPENAI_API_KEY nao configurada, pulando.');
    return;
  }

  const groupJid = await findMainGroupJid(sock);
  if (!groupJid) {
    console.error('[foto do grupo] Grupo principal nao encontrado entre os grupos que o bot participa.');
    return;
  }

  // O feed do G1 e cronologico (ultimas publicacoes), nao por relevancia —
  // pegar so as 10 mais recentes deixa de fora manchetes de capa importantes
  // que nao acabaram de ser publicadas (ex: cobertura continua de um
  // julgamento). Busca uma janela maior e filtra videos de telejornais
  // regionais e noticias de editoria estadual (URL com UF, ex: g1.globo.com/go/...)
  // — essas nunca vao pra capa nacional do G1, entao nao interessam aqui mesmo
  // que sejam tragicas/chocantes.
  const REGIONAL_URL_PATTERN =
    /^https?:\/\/g1\.globo\.com\/(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)\//i;
  let headlines;
  try {
    const recent = await getRecentHeadlines(100);
    headlines = recent.filter((h) => !/^v[íi]deos?:/i.test(h.title) && !REGIONAL_URL_PATTERN.test(h.link));
  } catch (err) {
    console.error('[foto do grupo] Erro ao buscar manchetes do G1:', err);
    return;
  }
  if (headlines.length === 0) {
    console.error('[foto do grupo] Nenhuma manchete de relevancia nacional (nao-regional) encontrada no feed agora — pulando essa rodada.');
    return;
  }

  let picked;
  try {
    picked = await pickMostImpactfulHeadline(client, headlines);
  } catch (err) {
    console.error('[foto do grupo] Erro ao escolher a noticia mais importante:', err);
    return;
  }
  if (!picked) {
    console.error('[foto do grupo] Nao foi possivel escolher uma noticia.');
    return;
  }

  let editedPhoto;
  try {
    editedPhoto = await editBotPhoto(client, picked.persona);
  } catch (err) {
    console.error('[foto do grupo] Erro ao editar a foto via OpenAI:', err);
    return;
  }

  try {
    await sock.updateProfilePicture(groupJid, editedPhoto);
    console.log(`[foto do grupo] Foto atualizada com o tema: "${picked.title}"`);
  } catch (err) {
    console.error('[foto do grupo] Erro ao atualizar a foto do grupo (o bot e admin?):', err);
  }
}

// Converte uma data (YYYY-MM-DD, no fuso de Brasilia) + hora local num timestamp
// unix. Brasil nao tem horario de verao desde 2019, entao o offset fixo -03:00 e seguro.
function getTimestampBR(dateStr, hour) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour + 3, 0, 0) / 1000);
}

// Soma um numero de dias a uma data (YYYY-MM-DD), sem depender de fuso (usa meio-dia UTC).
function addDaysBR(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Ranking semanal: soma o expediente (08h-18h) de segunda a sexta desta semana,
// pulando feriados nacionais, e manda sexta-feira as 18:05.
async function sendWeeklyRanking(sock) {
  const { date: friday } = getBrasiliaNow(); // so roda as sextas, entao "hoje" e a sexta da semana
  const monday = addDaysBR(friday, -4);

  const weekdays = [];
  for (let i = 0; i < 5; i++) weekdays.push(addDaysBR(monday, i));

  const workingDays = [];
  for (const day of weekdays) {
    if (!(await isBrazilianHoliday(day))) workingDays.push(day);
  }

  const participating = await sock.groupFetchAllParticipating();

  for (const groupJid of Object.keys(participating)) {
    const merged = new Map();
    for (const day of workingDays) {
      const since = getTimestampBR(day, MORNING_HOUR);
      const until = getTimestampBR(day, EVENING_HOUR);
      for (const c of getCountsBetween(groupJid, since, until)) {
        if (!merged.has(c.sender_jid)) merged.set(c.sender_jid, { sender_name: c.sender_name, total: 0 });
        merged.get(c.sender_jid).total += c.total;
      }
    }

    const counts = [...merged.values()].sort((a, b) => b.total - a.total);
    const totalMessages = counts.reduce((sum, c) => sum + c.total, 0);

    const lines = [
      `📅 *Ranking da semana* (${formatDateBR(monday)} a ${formatDateBR(friday)})`,
      `_Considerando apenas o expediente (${String(MORNING_HOUR).padStart(2, '0')}h às ${String(EVENING_HOUR).padStart(2, '0')}h) de cada dia útil._`,
    ];
    if (counts.length > 0) {
      lines.push('', '📊 Ranking:', '');
      counts.forEach((c, i) => {
        const percent = totalMessages > 0 ? Math.round((c.total / totalMessages) * 100) : 0;
        lines.push(`${i + 1}. ${formatDisplayName(c.sender_name)}: ${c.total} msgs (${percent}%)`);
      });
      lines.push('', `total de ${totalMessages} Mensagens na semana! 📈`);
    }

    try {
      await sock.sendMessage(groupJid, { text: lines.join('\n') });
    } catch (err) {
      console.error(`Erro ao enviar ranking semanal para ${groupJid}:`, err);
    }
  }
}

function getAudioMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg; codecs=opus';
  return 'audio/mpeg';
}

// Lista os audios da pasta audios/, ordenados por nome. "name" (sem extensao,
// minusculo) e o que vira comando: !<name>. "filename" e o nome real do
// arquivo em disco, usado pra ler/enviar.
function listAudioFiles() {
  if (!fs.existsSync(AUDIOS_DIR)) return [];
  return fs
    .readdirSync(AUDIOS_DIR)
    .filter((filename) => AUDIO_EXTENSIONS.includes(path.extname(filename).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({ name: path.basename(filename, path.extname(filename)).toLowerCase(), filename }));
}

async function commandAudios({ sock, groupJid }) {
  const audios = listAudioFiles();
  if (audios.length === 0) {
    return sock.sendMessage(groupJid, { text: 'Nenhum áudio disponível na pasta audios/ ainda.' });
  }
  const lines = audios.map((a, i) => `${i + 1}. !${a.name}`);
  return sock.sendMessage(groupJid, { text: `🔊 *Áudios disponíveis*\n\n${lines.join('\n')}` });
}

// Normaliza o nome escolhido pra um audio salvo: minusculo, sem acento, so
// letras/numeros/_/-, ate 30 caracteres. Retorna '' se sobrar nada.
function sanitizeAudioName(raw) {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 30);
}

// !salvaraudio <nome> — responda um audio do grupo pra salvar ele em audios/;
// depois qualquer um chama com !<nome>.
async function commandSalvarAudio({ sock, groupJid, args, msg }) {
  const quotedAudio = getQuotedMedia(msg, 'audioMessage');
  if (!quotedAudio) {
    return sock.sendMessage(groupJid, { text: 'Responda a um áudio do grupo com !salvaraudio nome pra eu salvar ele.' });
  }

  const name = sanitizeAudioName(args.split(/\s+/)[0] || '');
  if (!name) {
    return sock.sendMessage(groupJid, { text: 'Faltou o nome! Responda o áudio com !salvaraudio nome (só letras, números, _ e -).' });
  }
  if (commands[name] || listAudioFiles().some((a) => a.name === name)) {
    return sock.sendMessage(groupJid, { text: `Já existe um comando ou áudio chamado !${name}, escolhe outro nome.` });
  }

  try {
    const mimetype = quotedAudio.message.audioMessage?.mimetype || '';
    const ext = mimetype.includes('mp4') ? 'm4a' : mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('wav') ? 'wav' : 'ogg';

    const buffer = await downloadMediaMessage(quotedAudio, 'buffer', {});
    fs.mkdirSync(AUDIOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUDIOS_DIR, `${name}.${ext}`), buffer);

    return sock.sendMessage(groupJid, { text: `✅ Áudio salvo! Agora é só mandar !${name}` });
  } catch (err) {
    console.error('Erro ao salvar áudio:', err);
    return sock.sendMessage(groupJid, { text: 'Não consegui salvar esse áudio, tenta de novo daqui a pouco.' });
  }
}

// Apaga um audio salvo (usado pelo painel). Valida o nome pra nunca sair da
// pasta audios/, e protege o repetido.mp3 (tocado no aviso de link repetido).
function deleteAudioByName(rawName) {
  const name = String(rawName).toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) return { ok: false, error: 'nome inválido' };
  if (name === 'repetido') return { ok: false, error: 'esse áudio é do aviso de link repetido e não pode ser apagado' };
  const audio = listAudioFiles().find((a) => a.name === name);
  if (!audio) return { ok: false, error: 'áudio não encontrado' };
  try {
    fs.unlinkSync(path.join(AUDIOS_DIR, audio.filename));
    return { ok: true };
  } catch (err) {
    console.error(`Erro ao apagar audio ${name}:`, err);
    return { ok: false, error: 'não consegui apagar o arquivo' };
  }
}

// Envia um audio pelo nome (sem extensao, minusculo) — usado como fallback
// quando um comando digitado nao bate com nenhum dos fixos, mas bate com um
// arquivo em audios/.
async function sendAudioByName({ sock, groupJid }, name) {
  const audio = listAudioFiles().find((a) => a.name === name);
  if (!audio) return false;

  try {
    const sent = await sock.sendMessage(groupJid, {
      audio: fs.readFileSync(path.join(AUDIOS_DIR, audio.filename)),
      mimetype: getAudioMimeType(audio.filename),
      // .ogg vem de mensagem de voz do WhatsApp (opus) — precisa do ptt pra tocar.
      ptt: path.extname(audio.filename).toLowerCase() === '.ogg',
    });
    if (sent?.key?.id) sentByBot.add(sent.key.id);
  } catch (err) {
    console.error(`Erro ao enviar audio ${name}:`, err);
  }
  return true;
}

// Data/hora atuais no fuso de Brasilia, no formato usado por scheduled_messages.json.
function getBrasiliaNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// Pasta com as fotos tematicas do bot (avatarbot/BoThierry_<Tema>.png) e
// arquivo que guarda qual tema esta valendo atualmente, pra so trocar a foto
// quando o tema mudar (evita reenviar a mesma foto toda vez que o cron roda).
const AVATAR_DIR = path.join(__dirname, '..', 'avatarbot');
const AVATAR_STATE_FILE = path.join(__dirname, '..', 'avatar_state.json');
const AVATAR_DEFAULT_FILE = 'BoThierry_Default.jpeg';

// Algoritmo anonimo gregoriano pra calcular a data (UTC) do Domingo de Pascoa
// de um ano — usado pra derivar tambem o Carnaval, ja que ambos sao datas
// moveis (nao da pra so cravar dia/mes fixo como Natal ou Halloween).
function getEasterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function daysBetween(dateStr, referenceDate) {
  const target = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((target - referenceDate) / 86400000);
}

// Ordem importa: a primeira que bater vence (evita, por ex., Pascoa e
// Carnaval se sobrepondo num ano estranho).
const AVATAR_THEMES = [
  {
    name: 'AnoNovo',
    file: 'BoThierry_AnoNovo.png',
    matches: (month, day) => (month === 12 && day >= 30) || (month === 1 && day <= 2),
  },
  { name: 'Natal', file: 'BoThierry_Natal.png', matches: (month, day) => month === 12 && day >= 23 && day <= 26 },
  { name: 'Halloween', file: 'BoThierry_Halloween.png', matches: (month, day) => month === 10 && day >= 29 && day <= 31 },
  { name: 'FestaJunina', file: 'BoThierry_FestaJunina.png', matches: (month, day) => month === 6 && day >= 20 && day <= 29 },
  {
    name: 'Carnaval',
    file: 'BoThierry_Carnaval.png',
    // Sabado de carnaval ate terca-feira (47 dias antes da Pascoa).
    matches: (month, day, dateStr) => {
      const carnavalTuesday = new Date(getEasterDate(Number(dateStr.slice(0, 4))).getTime() - 47 * 86400000);
      const diff = daysBetween(dateStr, carnavalTuesday);
      return diff >= -3 && diff <= 0;
    },
  },
  {
    name: 'Pascoa',
    file: 'BoThierry_Pascoa.png',
    // Sexta-feira Santa ate Domingo de Pascoa.
    matches: (month, day, dateStr) => {
      const diff = daysBetween(dateStr, getEasterDate(Number(dateStr.slice(0, 4))));
      return diff >= -2 && diff <= 0;
    },
  },
];

function getThemeForDate(dateStr) {
  const [, monthStr, dayStr] = dateStr.split('-');
  const month = Number(monthStr);
  const day = Number(dayStr);
  return AVATAR_THEMES.find((theme) => theme.matches(month, day, dateStr)) || null;
}

function getLastAvatarTheme() {
  if (!fs.existsSync(AVATAR_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(AVATAR_STATE_FILE, 'utf-8')).theme || null;
  } catch {
    return null;
  }
}

function setLastAvatarTheme(themeName) {
  fs.writeFileSync(AVATAR_STATE_FILE, JSON.stringify({ theme: themeName }));
}

/**
 * Confere se hoje cai numa data tematica (Natal, Halloween, Carnaval, etc) e
 * troca a foto de perfil do PRÓPRIO BOT pra imagem correspondente em
 * avatarbot/ — volta pra BoThierry_Default.jpeg fora dessas datas. So troca
 * de fato quando o tema muda (idempotente entre chamadas do mesmo dia).
 */
async function checkAndUpdateThemeAvatar(sock) {
  if (!fs.existsSync(AVATAR_DIR)) return;

  const { date: today } = getBrasiliaNow();
  const theme = getThemeForDate(today);
  const themeName = theme?.name || 'Default';

  if (getLastAvatarTheme() === themeName) return;

  const filePath = path.join(AVATAR_DIR, theme?.file || AVATAR_DEFAULT_FILE);
  if (!fs.existsSync(filePath)) return;

  try {
    const sharp = await getSharp();
    const buffer = await sharp(filePath).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();
    await sock.updateProfilePicture(sock.user.id, buffer);
    setLastAvatarTheme(themeName);
    console.log(`🖼️  Foto do bot trocada pro tema: ${themeName}`);
  } catch (err) {
    console.error(`Erro ao trocar foto do bot pro tema ${themeName}:`, err);
  }
}

// Feriados nacionais brasileiros via BrasilAPI (gratis, sem chave). Cacheado
// por ano pra nao bater na API toda vez.
const holidaysCache = new Map(); // ano -> Map de "YYYY-MM-DD" -> nome do feriado

async function getHolidaysForYear(year) {
  if (holidaysCache.has(year)) return holidaysCache.get(year);
  try {
    const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`);
    if (!res.ok) throw new Error(`status HTTP ${res.status}`);
    const data = await res.json();
    const holidays = new Map(data.map((h) => [h.date, h.name]));
    holidaysCache.set(year, holidays);
    return holidays;
  } catch (err) {
    console.error(`Erro ao buscar feriados de ${year}:`, err);
    return new Map(); // falha segura: nao bloqueia o envio se a API estiver fora
  }
}

// Retorna o nome do feriado nacional numa data, ou null se nao for feriado.
async function getHolidayName(dateStr) {
  const holidays = await getHolidaysForYear(dateStr.slice(0, 4));
  return holidays.get(dateStr) || null;
}

async function isBrazilianHoliday(dateStr) {
  return (await getHolidayName(dateStr)) !== null;
}

// Confere se ha mensagens agendadas (scheduled_messages.json) prontas pra
// enviar, e manda pra todos os grupos que o bot participa. Roda a cada minuto
// via cron, e tambem uma vez ao conectar (catch-up se o bot estava desligado
// no horario exato).
async function sendScheduledMessages(sock) {
  const { date, time } = getBrasiliaNow();
  const due = getDueMessages(date, time);
  if (due.length === 0) return;

  const participating = await sock.groupFetchAllParticipating();
  const groupJids = Object.keys(participating);

  for (const message of due) {
    for (const groupJid of groupJids) {
      try {
        if (message.text) {
          await sock.sendMessage(groupJid, { text: message.text });
        }
        if (message.audio) {
          const audioPath = path.join(AUDIOS_DIR, message.audio);
          if (fs.existsSync(audioPath)) {
            await sock.sendMessage(groupJid, { audio: fs.readFileSync(audioPath), mimetype: getAudioMimeType(message.audio) });
          } else {
            console.error(`Audio agendado nao encontrado (mensagem ${message.id}): ${audioPath}`);
          }
        }
      } catch (err) {
        console.error(`Erro ao enviar mensagem agendada ${message.id} para ${groupJid}:`, err);
      }
    }
    markScheduledMessageSent(message.id);
  }
}

// Referencia ao socket ativo, usada pelos crons abaixo (que rodam fora do
// escopo de startBot e sobrevivem a reconexoes).
let currentSock = null;

cron.schedule(
  `0 ${ARCHIVE_HOUR} * * *`,
  () => {
    recordCronRun('archive');
    try {
      const { archived } = archiveOldMessages();
      if (archived > 0) console.log(`🗄️  ${archived} mensagem(ns) movida(s) para archive/.`);
    } catch (err) {
      console.error('Erro ao arquivar mensagens antigas (cron):', err);
    }
    try {
      // seenMessageIds (dedupe de mensagem reentregue ao reconectar) cresce
      // pra sempre se nao for podado — depois de arquivar, reconstroi so com
      // os IDs ainda "quentes" (ultimos HOT_WINDOW_DAYS dias).
      seenMessageIds.clear();
      for (const id of loadSeenMessageIds()) seenMessageIds.add(id);
    } catch (err) {
      console.error('Erro ao podar seenMessageIds (cron):', err);
    }
    try {
      pruneOldMetrics();
    } catch (err) {
      console.error('Erro ao podar metricas antigas (cron):', err);
    }
  },
  CRON_OPTIONS
);

cron.schedule(
  `0 ${BIRTHDAY_CHECK_HOUR} * * *`,
  () => {
    recordCronRun('aniversario');
    if (currentSock) checkAndSendBirthdays(currentSock).catch((err) => console.error('Erro ao checar aniversarios (cron):', err));
  },
  CRON_OPTIONS
);

// Logo apos a meia-noite (horario de Brasilia) — garante que o nome do grupo
// ja reflita o aniversariante de hoje assim que o dia vira, mesmo com
// aniversarios em dias seguidos (ex: 07 e 08), sem esperar o aviso das 9h.
cron.schedule(
  '1 0 * * *',
  () => {
    recordCronRun('nome_grupo_aniversario');
    if (currentSock) syncGroupNameForBirthdays(currentSock).catch((err) => console.error('Erro ao sincronizar nome do grupo (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  `30 ${ARCHIVE_HOUR} * * *`,
  () => {
    recordCronRun('foto_bot_tema');
    if (currentSock) checkAndUpdateThemeAvatar(currentSock).catch((err) => console.error('Erro ao checar tema da foto do bot (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  `${AD_MINUTE} ${AD_HOUR} * * ${AD_DAYS}`,
  () => {
    recordCronRun('propaganda');
    if (currentSock) sendAdMessage(currentSock).catch((err) => console.error('Erro ao enviar propaganda (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  `0 ${MORNING_HOUR} * * 1-5`,
  () => {
    recordCronRun('bom_dia');
    if (currentSock) sendMorningMessage(currentSock).catch((err) => console.error('Erro ao enviar mensagem de bom dia (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  `0 ${EVENING_HOUR} * * 1-5`,
  () => {
    recordCronRun('fim_expediente');
    if (currentSock) sendEndOfDayMessage(currentSock).catch((err) => console.error('Erro ao enviar mensagem de fim de expediente (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  GROUP_PHOTO_CRON,
  () => {
    recordCronRun('foto_grupo_noticia');
    if (currentSock) updateGroupPhotoWithNews(currentSock).catch((err) => console.error('Erro ao atualizar foto do grupo (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '5 18 * * 5',
  () => {
    recordCronRun('ranking_semanal');
    if (currentSock) sendWeeklyRanking(currentSock).catch((err) => console.error('Erro ao enviar ranking semanal (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '* * * * *',
  () => {
    if (currentSock) sendScheduledMessages(currentSock).catch((err) => console.error('Erro ao enviar mensagens agendadas (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '*/5 * * * *',
  () => {
    try {
      recordSystemStats();
    } catch (err) {
      console.error('Erro ao registrar uso de recursos da VM (cron):', err);
    }
  },
  CRON_OPTIONS
);

// Sincroniza as fotos de perfil de quem mandou mensagem recentemente, pro
// painel mostrar foto ao lado do nome na aba Atividade. Uma vez por dia
// basta (foto de perfil nao muda toda hora, e cada busca consulta a API do
// WhatsApp, entao nao vale a pena fazer isso com mais frequencia).
cron.schedule(
  '30 3 * * *',
  async () => {
    if (!currentSock) return;
    try {
      const groupJid = getMainGroupJid();
      if (!groupJid) return;
      const jids = getRecentSenderJids(groupJid);
      const { updated, total } = await syncAvatars(currentSock, jids);
      console.log(`[avatares] Sincronizadas ${updated}/${total} fotos de perfil.`);
    } catch (err) {
      console.error('Erro ao sincronizar fotos de perfil (cron):', err);
    }
  },
  CRON_OPTIONS
);

cron.schedule(
  '*/10 * * * *',
  () => {
    recordCronRun('eleicoes');
    if (currentSock) sendElectionUpdate(currentSock).catch((err) => console.error('Erro ao enviar apuracao eleitoral (cron):', err));
  },
  CRON_OPTIONS
);

// Atraso entre tentativas de reconexao, com backoff exponencial (dobra a cada
// falha seguida, ate um teto) — sem isso, uma conexao que fecha na hora (ex:
// problema no lado do WhatsApp) faz o bot tentar de novo instantaneamente,
// numa vez ja gerou mais de 4 milhoes de tentativas em 13h seguidas, o que
// alem de nao resolver nada arrisca o numero ser sinalizado/bloqueado pelo
// WhatsApp por comportamento abusivo.
const RECONNECT_INITIAL_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60000;
let reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    connectTimeoutMs: 20000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 250,
    // O Baileys, por padrao, baixa e processa o historico COMPLETO de
    // mensagens de todos os grupos/conversas a cada reconexao
    // (syncFullHistory: true por padrao) — e muito pesado numa VM pequena, e
    // o bot nunca usa esse historico (a gente mantem nosso proprio log em
    // messages.jsonl). Desligar isso tira boa parte do pico de CPU/memoria
    // logo apos reconectar.
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nEscaneie o QR code abaixo no WhatsApp (Aparelhos conectados > Conectar aparelho):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        const delay = reconnectDelayMs;
        console.log(`Conexao fechada. Reconectando em ${Math.round(delay / 1000)}s...`);
        recordConnectionEvent('disconnected', { statusCode, willReconnect: true, nextDelayMs: delay });
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
        setTimeout(startBot, delay);
      } else {
        console.log('Conexao fechada. Sessao deslogada — apague a pasta auth_info e escaneie o QR novamente.');
        recordConnectionEvent('disconnected', { statusCode, willReconnect: false });
      }
    } else if (connection === 'open') {
      reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
      console.log('✅ Conectado ao WhatsApp! Ouvindo mensagens dos grupos...');
      recordConnectionEvent('connected');
      currentSock = sock;
      setBotJids([normalizeJid(sock.user?.id), normalizeJid(sock.user?.lid), ...[sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser)]);
      // Se o bot esteve desligado no horario do aviso diario, verifica agora
      // (so nesse "catch-up" pra nao mandar aniversario de madrugada).
      if (new Date().getHours() >= BIRTHDAY_CHECK_HOUR) {
        checkAndSendBirthdays(sock).catch((err) => console.error('Erro ao checar aniversarios:', err));
      }
      // O nome do grupo e sincronizado sempre que conectar, independente da
      // hora (diferente do aviso em texto, que so sai a partir das 9h) — assim
      // o nome nunca fica "preso" num aniversariante de dia anterior se o bot
      // ficou desligado durante a virada da meia-noite.
      syncGroupNameForBirthdays(sock).catch((err) => console.error('Erro ao sincronizar nome do grupo:', err));
      // Confere logo ao conectar se a foto do bot precisa mudar de tema (ex:
      // bot ficou desligado e passou pra data de um evento sem ninguem notar).
      checkAndUpdateThemeAvatar(sock).catch((err) => console.error('Erro ao checar tema da foto do bot:', err));
      // Sincroniza fotos de perfil ao conectar tambem (alem do cron diario),
      // assim o painel ja mostra foto de todo mundo sem esperar ate 03h30.
      (async () => {
        const groupJid = getMainGroupJid();
        if (groupJid) await syncAvatars(sock, getRecentSenderJids(groupJid));
      })().catch((err) => console.error('Erro ao sincronizar fotos de perfil ao conectar:', err));
      // Catch-up de mensagens agendadas: se o bot esteve desligado exatamente
      // na hora marcada, manda assim que reconectar.
      sendScheduledMessages(sock).catch((err) => console.error('Erro ao verificar mensagens agendadas:', err));
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('groups.update', (updates) => {
    for (const update of updates) {
      if (update.id && update.subject) groupNameCache.set(update.id, update.subject);
    }
  });

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
          `[debug] link detectado: ${JSON.stringify(urls)} | tem extendedTextMessage: ${!!msg.message.extendedTextMessage} | temThumbnail: ${!!msg.message.extendedTextMessage?.jpegThumbnail}`
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
        const temThumbnail = !!extendedText?.jpegThumbnail;
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
        if (mentionedJids.length > 0) {
          debugLog(`[debug] mencoes na mensagem: ${JSON.stringify(mentionedJids)} | identidades do bot: ${JSON.stringify(botIdentifiers)} | bot mencionado: ${isBotMentioned}`);
        }

        if (isBotMentioned) {
          const insulted = await isInsultToBot(text);
          if (insulted) {
            debugLog(`[debug] insulto ao bot detectado de ${senderName}`);
            try {
              await handleBotInsult({ sock, groupJid, senderJid, senderName });
            } catch (err) {
              console.error('Erro ao processar insulto ao bot:', err);
            }
          } else {
            const client = getOpenAIClient();
            if (!client) {
              debugLog('[debug] bot mencionado mas OPENAI_API_KEY nao configurada, ignorando pergunta.');
            } else {
              const question = text.replace(/@\d+/g, '').trim();
              if (question) {
                debugLog(`[debug] pergunta de dados detectada: "${question}"`);
                try {
                  const answer = await answerDataQuestion(client, groupJid, question);
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

startDashboardServer(DASHBOARD_PORT, {
  deleteAudio: deleteAudioByName,
  getCommandsMenu: () => ({
    categories: COMMAND_CATEGORIES,
    audios: listAudioFiles().map((a) => a.name),
    birthdays: [...loadBirthdays()]
      .sort((a, b) => a.month - b.month || a.day - b.day)
      .map(({ name, day, month }) => ({ name, day, month })),
  }),
});
startBot();
