// !memoria (o que o bot lembra) e !esquecer (apagar). Cada um so apaga o que e seu.
import { listFacts, deleteFact, deleteAllFor } from '../memory.js';
import { formatDisplayName } from '../displayNames.js';

export async function commandMemoria({ sock, groupJid, senderJid, senderName }) {
  const { mine, group } = listFacts({ jid: senderJid });
  const name = formatDisplayName(senderName || '').split(' ')[0] || 'você';
  const parts = [];
  parts.push(mine.length ? `🧠 *O que eu lembro de ${name}:*\n${mine.map((f) => `#${f.id} — ${f.texto}`).join('\n')}` : `🧠 Ainda não anotei nada sobre ${name}. É só pedir: "@Bothierry lembra que meu time é o Santos".`);
  if (group.length) parts.push(`👥 *Sobre o grupo:*\n${group.map((f) => `#${f.id} — ${f.texto}${f.jid === senderJid ? ' (seu)' : ''}`).join('\n')}`);
  if (mine.length || group.some((f) => f.jid === senderJid)) parts.push('Pra apagar: *!esquecer 12* (o número) ou *!esquecer tudo*.');
  return sock.sendMessage(groupJid, { text: parts.join('\n\n') });
}

export async function commandEsquecer({ sock, groupJid, senderJid, args }) {
  const arg = args.trim().toLowerCase();
  if (!arg) return sock.sendMessage(groupJid, { text: 'Use: *!esquecer 12* (número que aparece no !memoria) ou *!esquecer tudo* 🧹' });
  if (arg === 'tudo') {
    const n = deleteAllFor(senderJid);
    return sock.sendMessage(groupJid, { text: n ? `🧹 Pronto, esqueci tudo que eu tinha anotado de você (${n} ${n === 1 ? 'coisa' : 'coisas'}).` : 'Eu não tinha nada anotado de você mesmo 🙂' });
  }
  const id = Number(arg.replace('#', ''));
  const removed = Number.isInteger(id) ? deleteFact(id, senderJid) : null;
  return sock.sendMessage(groupJid, { text: removed ? `🧹 Esqueci: "${removed.texto}"` : 'Não achei esse número entre as suas anotações — manda *!memoria* pra ver a lista 🤔' });
}
