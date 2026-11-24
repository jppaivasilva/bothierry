// Todas as tarefas agendadas (node-cron) do bot.

import { TIMEZONE, ARCHIVE_HOUR, BIRTHDAY_CHECK_HOUR, botState, MORNING_HOUR, getBrasiliaNow, EVENING_HOUR, findMainGroupJid } from './shared.js';
import cron from 'node-cron';
import { recordCronRun, pruneOldMetrics, recordSystemStats } from '../metrics.js';
import { archiveOldMessages, loadSeenMessageIds, getMainGroupJid, getRecentSenderJids } from '../db.js';
import { seenMessageIds } from './messageHandler.js';
import { checkAndSendBirthdays, syncGroupNameForBirthdays } from './birthdayFlow.js';
import { checkAndUpdateThemeAvatar } from './avatarTheme.js';
import { shouldSendMorning } from '../morning.js';
import { sendMorningMessage, sendEndOfDayMessage, sendWeeklyRanking, sendWeeklySummary, sendScheduledMessages } from './dailyMessages.js';
import { updateGroupPhotoWithNews, sendElectionUpdate } from './electionFlow.js';
import { checkAndSendPremiere, sendGameNews, sendWrappedGroup } from './specialMessages.js';
import { runBackup } from '../backup.js';
import { syncAvatars } from '../avatars.js';

// Opcoes compartilhadas por todos os crons. O node-cron v4 so tolera 1s de
// atraso por padrao — se o timer disparar mais tarde que isso (ex: PC/processo
// com CPU ocupada ou throttling do Windows, ja vimos atrasos de ~8s), ele
// considera a execucao "perdida" e PULA a tarefa em vez de rodar atrasada
// (foi assim que o bom dia das 08h ja sumiu). 2 minutos de tolerancia garante
// que atrasos pequenos ainda executem normalmente.
const CRON_OPTIONS = { timezone: TIMEZONE, missedExecutionTolerance: 120000 };

// Grupo (pelo nome, ja que Baileys nao indexa por nome) e expressao cron de
// quando a foto tematica com a noticia mais importante nacionalmente e trocada.
// Hoje: segunda e quarta as 08h (horario de Brasilia) — 2x por semana, pra
// economizar no custo da geracao de imagem (o item mais caro do bot de longe).
const GROUP_PHOTO_CRON = '0 8 * * 1,3';

// Registra todas as tarefas agendadas (chamado uma vez na partida).
export function startCrons() {
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
    if (botState.sock) checkAndSendBirthdays(botState.sock).catch((err) => console.error('Erro ao checar aniversarios (cron):', err));
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
    if (botState.sock) syncGroupNameForBirthdays(botState.sock).catch((err) => console.error('Erro ao sincronizar nome do grupo (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  `30 ${ARCHIVE_HOUR} * * *`,
  () => {
    recordCronRun('foto_bot_tema');
    if (botState.sock) checkAndUpdateThemeAvatar(botState.sock).catch((err) => console.error('Erro ao checar tema da foto do bot (cron):', err));
  },
  CRON_OPTIONS
);

// Roda todo dia as 8h, mas so manda nos dias de semana (e nas datas extras de
// fim de semana, veja morning.js).
cron.schedule(
  `0 ${MORNING_HOUR} * * *`,
  () => {
    if (!shouldSendMorning(getBrasiliaNow().date)) return;
    recordCronRun('bom_dia');
    if (botState.sock) sendMorningMessage(botState.sock).catch((err) => console.error('Erro ao enviar mensagem de bom dia (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  `0 ${EVENING_HOUR} * * 1-5`,
  () => {
    recordCronRun('fim_expediente');
    if (botState.sock) sendEndOfDayMessage(botState.sock).catch((err) => console.error('Erro ao enviar mensagem de fim de expediente (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  GROUP_PHOTO_CRON,
  () => {
    recordCronRun('foto_grupo_noticia');
    if (botState.sock) updateGroupPhotoWithNews(botState.sock).catch((err) => console.error('Erro ao atualizar foto do grupo (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '5 18 * * 5',
  () => {
    recordCronRun('ranking_semanal');
    if (botState.sock) sendWeeklyRanking(botState.sock).catch((err) => console.error('Erro ao enviar ranking semanal (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '0 0 19 11 *',
  () => {
    recordCronRun('estreia_gtavi');
    if (botState.sock) checkAndSendPremiere(botState.sock).catch((err) => console.error('Erro ao enviar o cartao da estreia (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '0 12,19 * * *',
  () => {
    recordCronRun('noticias_games');
    if (botState.sock) sendGameNews(botState.sock).catch((err) => console.error('Erro ao mandar noticia de games (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '40 3 * * *',
  async () => {
    recordCronRun('backup');
    try {
      const r = await runBackup();
      console.log(`💾 Backup: ${r.file ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB, ${r.paths} itens` : r.note}${r.remote ? ' (copiado pro rclone)' : ''}`);
      if (r.remoteError) console.error(`Erro ao copiar o backup pro rclone (a copia local foi feita): ${r.remoteError}`);
    } catch (err) {
      console.error('Erro ao fazer o backup noturno:', err);
    }
  },
  CRON_OPTIONS
);

cron.schedule(
  '30 18 31 12 *',
  () => {
    recordCronRun('wrapped_grupo');
    if (botState.sock) {
      findMainGroupJid(botState.sock)
        .then((groupJid) => groupJid && sendWrappedGroup(botState.sock, groupJid))
        .catch((err) => console.error('Erro ao mandar o Wrapped do grupo (cron):', err));
    }
  },
  CRON_OPTIONS
);

cron.schedule(
  '0 21 * * 0',
  () => {
    recordCronRun('resumo_semanal');
    if (botState.sock) sendWeeklySummary(botState.sock).catch((err) => console.error('Erro ao enviar resumo semanal (cron):', err));
  },
  CRON_OPTIONS
);

cron.schedule(
  '* * * * *',
  () => {
    if (botState.sock) sendScheduledMessages(botState.sock).catch((err) => console.error('Erro ao enviar mensagens agendadas (cron):', err));
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
    if (!botState.sock) return;
    try {
      const groupJid = getMainGroupJid();
      if (!groupJid) return;
      const jids = getRecentSenderJids(groupJid);
      const { updated, total } = await syncAvatars(botState.sock, jids);
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
    if (botState.sock) sendElectionUpdate(botState.sock).catch((err) => console.error('Erro ao enviar apuracao eleitoral (cron):', err));
  },
  CRON_OPTIONS
);
}
