// Porta do painel local de monitoramento (http://localhost:PORTA).

import './bot/bootstrap.js';
import { startCrons } from './bot/crons.js';
import { startDashboardServer } from './dashboard.js';
import { getPairingQr } from './pairingQr.js';
import { waState, startBot } from './bot/connection.js';
import { deleteAudioByName, listAudioFiles } from './bot/audioCommands.js';
import { announceNewEvent } from './bot/eventCommands.js';
import { COMMAND_CATEGORIES } from './bot/commands.js';
import { loadBirthdays } from './birthdays.js';
import { aiQueue } from './bot/aiJobs.js';
import { getSendStats } from './bot/reliableSend.js';

const DASHBOARD_PORT = 4321;

startCrons();
startDashboardServer(DASHBOARD_PORT, {
  getPairingQr,
  getHealth: () => ({ ...waState }),
  getQueueStats: () => ({ ...aiQueue.getStats(), send: getSendStats() }),
  deleteAudio: deleteAudioByName,
  announceEvent: announceNewEvent,
  getCommandsMenu: () => ({
    categories: COMMAND_CATEGORIES,
    audios: listAudioFiles().map((a) => a.name),
    birthdays: [...loadBirthdays()]
      .sort((a, b) => a.month - b.month || a.day - b.day)
      .map(({ name, day, month }) => ({ name, day, month })),
  }),
});
startBot();
