// Dispara os lembretes vencidos (chamado por um cron de 1 minuto) e os comandos !lembretes / !cancelar.
import { getDueReminders, markReminderSent, listReminders, cancelReminder, formatWhen } from '../reminders.js';
import { sentByBot } from './shared.js';

let sending = false;

export async function sendDueReminders(sock) {
  if (sending) return;
  sending = true;
  try {
    for (const r of getDueReminders()) {
      try {
        const mention = r.para === 'eu';
        const text = mention ? `⏰ @${r.jid.split('@')[0]} lembrete: ${r.texto}` : `⏰ Lembrete: ${r.texto}`;
        const sent = await sock.sendMessage(r.groupJid, mention ? { text, mentions: [r.jid] } : { text });
        if (sent?.key?.id) sentByBot.add(sent.key.id);
        markReminderSent(r.id);
      } catch (err) {
        console.error('Erro ao enviar lembrete (tenta de novo no proximo minuto):', err);
      }
    }
  } finally {
    sending = false;
  }
}

export async function commandLembretes({ sock, groupJid, senderJid }) {
  const items = listReminders(senderJid);
  if (!items.length) return sock.sendMessage(groupJid, { text: '⏰ Você não tem lembretes pendentes. É só pedir: "@Bothierry me lembra sexta às 20h de comprar o ingresso".' });
  return sock.sendMessage(groupJid, { text: `⏰ *Seus lembretes:*\n${items.map((r) => `#${r.id} — ${formatWhen(r.dueTs)} — ${r.texto}`).join('\n')}\n\nPra cancelar: *!cancelar 12*` });
}

export async function commandCancelarLembrete({ sock, groupJid, senderJid, args }) {
  const id = Number(args.trim().replace('#', ''));
  if (!Number.isInteger(id)) return sock.sendMessage(groupJid, { text: 'Use: *!cancelar 12* (número que aparece no !lembretes)' });
  const removed = cancelReminder(id, senderJid);
  return sock.sendMessage(groupJid, { text: removed ? `🗑️ Cancelei o lembrete: "${removed.texto}"` : 'Não achei esse número entre os seus lembretes — manda *!lembretes* pra ver a lista 🤔' });
}
