// Quem entrou, saiu ou foi removido do grupo -> diario do bot (src/botLog.js).
// Assim, se perguntarem "por que o Fulano saiu?" ou "o Fulano voltou?", o bot sabe responder.
import { logBotAction } from '../botLog.js';
import { getMainGroupJid, getMemberList } from '../db.js';
import { formatDisplayName } from '../displayNames.js';
import { botState } from './shared.js';

const digits = (jid) => String(jid ?? '').split('@')[0].split(':')[0];
const asJid = (p) => (typeof p === 'string' ? p : p?.id || p?.jid || p?.phoneNumber || '');

/** Nome de exibicao a partir do jid (pelo historico de mensagens do grupo); cai no numero se nao conhece. */
function nameOf(groupJid, jid) {
  const d = digits(jid);
  const member = getMemberList(groupJid).find((m) => digits(m.jid) === d);
  return member ? formatDisplayName(member.name) : `+${d}`;
}

/** Trata o evento group-participants.update do Baileys. So registra add/remove do grupo principal. */
export function recordParticipantsUpdate({ id, participants = [], action, author }) {
  if (id !== getMainGroupJid() || (action !== 'add' && action !== 'remove')) return;
  const me = [botState.sock?.user?.id, botState.sock?.user?.lid].filter(Boolean).map(digits);
  const authorD = digits(asJid(author));
  for (const p of participants) {
    const jid = asJid(p);
    if (!jid) continue;
    const nome = nameOf(id, jid);
    if (action === 'add') {
      const byWhom = authorD && authorD !== digits(jid) ? ` (adicionado por ${me.includes(authorD) ? 'mim' : nameOf(id, asJid(author))})` : '';
      logBotAction({ tipo: 'entrou', jid, nome, resumo: `${nome} entrou (ou voltou) pro grupo${byWhom}` });
    } else if (authorD && authorD !== digits(jid)) {
      const byMe = me.includes(authorD);
      logBotAction({ tipo: 'removido', jid, nome, resumo: `${nome} foi removido do grupo por ${byMe ? 'mim (o bot)' : nameOf(id, asJid(author))}` });
    } else {
      logBotAction({ tipo: 'saiu', jid, nome, resumo: `${nome} saiu do grupo por conta propria` });
    }
  }
}
