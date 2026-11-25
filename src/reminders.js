// Lembretes: "me lembra sexta as 20h de comprar o ingresso". Guardados em
// reminders.json (so na VM, entram no backup), disparados por um cron de 1
// minuto (src/bot/reminderFlow.js). O lembrete aparece no GRUPO marcando a
// pessoa. Horario sempre em Brasilia (sem horario de verao desde 2019, offset
// fixo -03:00).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatDisplayName } from './displayNames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.REMINDERS_FILE || path.join(__dirname, '..', 'reminders.json');

export const REMINDER_LIMITS = { maxPerPerson: 10, maxDaysAhead: 90, minLeadSec: 30, graceSec: 24 * 3600, maxTextChars: 200 };

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return { nextId: d.nextId || 1, items: Array.isArray(d.items) ? d.items : [] };
  } catch {
    return { nextId: 1, items: [] };
  }
}
function save(d) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, FILE);
}

/** "2026-12-04" + "20:30" (Brasilia) -> timestamp unix, ou null se invalido. */
export function brToTs(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, da, h + 3, mi, 0);
  const back = new Date(ms - 3 * 3600000); // confere se o dia existe (ex: 31/02 viraria marco)
  if (back.getUTCDate() !== da || back.getUTCMonth() !== mo - 1) return null;
  return Math.floor(ms / 1000);
}

export const formatWhen = (ts) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));

/**
 * Cria um lembrete. Quando: `em_minutos` (relativo) OU `data` (AAAA-MM-DD) + `hora` (HH:MM).
 * Devolve { ok, reminder } ou { ok:false, motivo }.
 */
export function addReminder({ jid, nome, groupJid, texto, em_minutos, data, hora, para = 'eu' }, nowSec = Math.floor(Date.now() / 1000)) {
  const text = String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, REMINDER_LIMITS.maxTextChars);
  if (text.length < 2) return { ok: false, motivo: 'faltou dizer do que lembrar' };
  if (!jid || !groupJid) return { ok: false, motivo: 'nao sei quem pediu' };
  let dueTs;
  if (em_minutos != null && em_minutos !== '') {
    const m = Number(em_minutos);
    if (!Number.isFinite(m) || m <= 0) return { ok: false, motivo: 'tempo invalido' };
    dueTs = nowSec + Math.round(m * 60);
  } else {
    dueTs = brToTs(data, hora);
    if (dueTs == null) return { ok: false, motivo: 'data ou hora invalida (preciso de data AAAA-MM-DD e hora HH:MM)' };
  }
  if (dueTs < nowSec + REMINDER_LIMITS.minLeadSec) return { ok: false, motivo: 'esse horario ja passou (ou e agora)' };
  if (dueTs > nowSec + REMINDER_LIMITS.maxDaysAhead * 86400) return { ok: false, motivo: `so agendo lembretes de ate ${REMINDER_LIMITS.maxDaysAhead} dias` };

  const d = load();
  if (d.items.filter((r) => r.jid === jid).length >= REMINDER_LIMITS.maxPerPerson) return { ok: false, motivo: `voce ja tem ${REMINDER_LIMITS.maxPerPerson} lembretes pendentes (cancele algum com !cancelar)` };
  const reminder = { id: d.nextId++, jid, nome: formatDisplayName(nome || ''), groupJid, texto: text, dueTs, para: para === 'grupo' ? 'grupo' : 'eu', createdTs: nowSec };
  d.items.push(reminder);
  save(d);
  return { ok: true, reminder };
}

export const listReminders = (jid) => load().items.filter((r) => r.jid === jid).sort((a, b) => a.dueTs - b.dueTs);

export function cancelReminder(id, jid) {
  const d = load();
  const i = d.items.findIndex((r) => r.id === Number(id) && r.jid === jid);
  if (i < 0) return null;
  const [removed] = d.items.splice(i, 1);
  save(d);
  return removed;
}

/** Lembretes vencidos pra enviar agora; os atrasados demais (bot ficou fora do ar) sao descartados. */
export function getDueReminders(nowSec = Math.floor(Date.now() / 1000)) {
  const d = load();
  const stale = d.items.filter((r) => r.dueTs < nowSec - REMINDER_LIMITS.graceSec);
  if (stale.length) {
    d.items = d.items.filter((r) => !stale.includes(r));
    save(d);
  }
  return d.items.filter((r) => r.dueTs <= nowSec);
}

export function markReminderSent(id) {
  const d = load();
  const before = d.items.length;
  d.items = d.items.filter((r) => r.id !== id);
  if (d.items.length !== before) save(d);
}

// ---------------- funcoes que a IA pode chamar ----------------
export const REMINDER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'criar_lembrete',
      description:
        'Agenda um lembrete que o bot manda no grupo marcando a pessoa. Quando: use em_minutos pra tempo relativo ("daqui 2 horas" = 120) OU data (AAAA-MM-DD, tirada da tabela de dias de referencia) + hora (HH:MM, horario de Brasilia) pra dia/hora certos. Se a pessoa nao disse o horario, PERGUNTE antes de chamar.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Do que lembrar, curto (ex: "comprar o ingresso").' },
          em_minutos: { type: 'integer', description: 'Daqui a quantos minutos (alternativa a data+hora).' },
          data: { type: 'string', description: 'AAAA-MM-DD, da tabela de referencia.' },
          hora: { type: 'string', description: 'HH:MM, 24h, Brasilia.' },
          para: { type: 'string', enum: ['eu', 'grupo'], description: '"eu" marca a pessoa; "grupo" manda sem marcar ninguem (aviso pro grupo todo).' },
        },
        required: ['texto'],
      },
    },
  },
  { type: 'function', function: { name: 'listar_lembretes', description: 'Lista os lembretes pendentes de quem esta falando.', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'cancelar_lembrete',
      description: 'Cancela um lembrete pendente de quem esta falando, pelo numero (use listar_lembretes se nao souber).',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
];

export const REMINDER_IMPLS = {
  criar_lembrete: (args, ctx) => {
    const r = addReminder({ jid: ctx.askerJid, nome: ctx.askerName, groupJid: ctx.groupJid, ...args });
    return r.ok ? { criado: true, id: r.reminder.id, texto: r.reminder.texto, quando: formatWhen(r.reminder.dueTs), para: r.reminder.para } : { criado: false, motivo: r.motivo };
  },
  listar_lembretes: (_args, ctx) => ({ lembretes: listReminders(ctx.askerJid).map((r) => ({ id: r.id, texto: r.texto, quando: formatWhen(r.dueTs) })) }),
  cancelar_lembrete: ({ id }, ctx) => {
    const r = cancelReminder(id, ctx.askerJid);
    return r ? { cancelado: true, texto: r.texto } : { cancelado: false, motivo: 'nao achei esse lembrete seu' };
  },
};
