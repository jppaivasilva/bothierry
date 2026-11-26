// Conexao com o WhatsApp: socket, reconexao, sessao deslogada e estado pro /health.

import fs from 'fs';
import { useMultiFileAuthState, makeWASocket, DisconnectReason, jidNormalizedUser } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { setPairingQr, clearPairingQr } from '../pairingQr.js';
import { recordConnectionEvent } from '../metrics.js';
import { botState, normalizeJid, BIRTHDAY_CHECK_HOUR, groupNameCache } from './shared.js';
import { setBotJids } from '../extraMembers.js';
import { checkAndSendBirthdays, syncGroupNameForBirthdays } from './birthdayFlow.js';
import { checkAndUpdateThemeAvatar } from './avatarTheme.js';
import { checkAndSendPremiere } from './specialMessages.js';
import { getMainGroupJid, getRecentSenderJids } from '../db.js';
import { syncAvatars } from '../avatars.js';
import { sendScheduledMessages } from './dailyMessages.js';
import { registerMessageHandler } from './messageHandler.js';
import { installReliableSend, setLiveSocketProbe } from './reliableSend.js';
import { aiQueue } from './aiJobs.js';
import { recordParticipantsUpdate } from './groupEvents.js';

// Estado da conexao com o WhatsApp, lido pela rota publica /health (monitor externo de queda).
export const waState = { connected: false, since: Date.now(), loggedOut: false };

function setWaState(connected, loggedOut = false) {
  if (waState.connected !== connected || waState.loggedOut !== loggedOut) waState.since = Date.now();
  waState.connected = connected;
  waState.loggedOut = loggedOut;
}

// Atraso entre tentativas de reconexao, com backoff exponencial (dobra a cada
// falha seguida, ate um teto) — sem isso, uma conexao que fecha na hora (ex:
// problema no lado do WhatsApp) faz o bot tentar de novo instantaneamente,
// numa vez ja gerou mais de 4 milhoes de tentativas em 13h seguidas, o que
// alem de nao resolver nada arrisca o numero ser sinalizado/bloqueado pelo
// WhatsApp por comportamento abusivo.
const RECONNECT_INITIAL_DELAY_MS = 2000;

const RECONNECT_MAX_DELAY_MS = 60000;

let reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;

// Move auth_info pra auth_info.deslogada-<data> (mantem so as 2 ultimas) pra
// o proximo startBot() comecar do zero e gerar um QR novo. Pra voltar atras:
// pare o bot, apague auth_info e renomeie a pasta guardada de volta.
function archiveLoggedOutSession() {
  try {
    if (fs.existsSync('auth_info')) fs.renameSync('auth_info', `auth_info.deslogada-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const old = fs.readdirSync('.').filter((f) => f.startsWith('auth_info.deslogada-')).sort();
    for (const f of old.slice(0, -2)) fs.rmSync(f, { recursive: true, force: true });
  } catch (err) {
    console.error('Erro ao guardar a sessao deslogada:', err);
  }
}

// Todo envio do bot usa o socket que estiver CONECTADO na hora (e espera reconectar se nao houver nenhum).
setLiveSocketProbe(() => (waState.connected ? botState.sock : null));

export async function startBot() {
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

  installReliableSend(sock); // fila + reenvio automatico em todo sock.sendMessage

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nEscaneie o QR code abaixo no WhatsApp (Aparelhos conectados > Conectar aparelho):\n');
      qrcode.generate(qr, { small: true });
      setPairingQr(qr); // o painel (admin) mostra esse mesmo QR
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      setWaState(false, !shouldReconnect);
      if (shouldReconnect) {
        const delay = reconnectDelayMs;
        console.log(`Conexao fechada. Reconectando em ${Math.round(delay / 1000)}s...`);
        recordConnectionEvent('disconnected', { statusCode, willReconnect: true, nextDelayMs: delay });
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
        setTimeout(startBot, delay);
      } else {
        // O WhatsApp deslogou o aparelho do bot: a sessao nao serve mais. Guarda a
        // pasta antiga (nao apaga) e abre uma conexao nova, que gera o QR — ele
        // aparece no painel (aba Sistema, so admin) e no log, e e so ler no celular.
        console.log('Conexao fechada. Sessao deslogada — guardando a sessao antiga e gerando um QR novo (painel > Sistema, ou aqui no log).');
        recordConnectionEvent('disconnected', { statusCode, willReconnect: false });
        archiveLoggedOutSession();
        setTimeout(startBot, 2000);
      }
    } else if (connection === 'open') {
      reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
      clearPairingQr();
      setWaState(true);
      console.log('✅ Conectado ao WhatsApp! Ouvindo mensagens dos grupos...');
      recordConnectionEvent('connected');
      botState.sock = sock;
      aiQueue.start(); // retoma as perguntas que ficaram pendentes (queda/reinicio)
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
      checkAndSendPremiere(sock).catch((err) => console.error('Erro ao checar o cartao da estreia:', err));
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

  // Quem entra/sai/e removido do grupo vira registro no diario do bot (o agente consulta depois).
  sock.ev.on('group-participants.update', (update) => {
    try {
      recordParticipantsUpdate(update);
    } catch (err) {
      console.error('Erro ao registrar entrada/saida do grupo:', err);
    }
  });

  sock.ev.on('groups.update', (updates) => {
    for (const update of updates) {
      if (update.id && update.subject) groupNameCache.set(update.id, update.subject);
    }
  });

    registerMessageHandler(sock);
}
