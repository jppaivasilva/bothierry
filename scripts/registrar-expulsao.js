// Registra a mao uma expulsao que o bot JA fez antes do historico existir, pra ele (e o
// quadro !insultos / painel) saber que aconteceu.
//
// Uso (na VM, na pasta do bot):
//   node --env-file=.env scripts/registrar-expulsao.js "Nome Da Pessoa" [insultos] ["AAAA-MM-DD HH:MM"]
// - insultos: quantos insultos contar pra essa pessoa (padrao 3, os que levam a expulsao)
// - data/hora (Brasilia): quando foi (padrao: agora)
import { findSenderJidByName, getMainGroupJid } from '../src/db.js';
import { recordInsult, recordExpulsion } from '../src/insultHistory.js';
import { logBotAction } from '../src/botLog.js';
import { formatDisplayName } from '../src/displayNames.js';
import { brToTs } from '../src/reminders.js';

const [name, insultsArg, when] = process.argv.slice(2);
if (!name) {
  console.error('Uso: node --env-file=.env scripts/registrar-expulsao.js "Nome" [insultos] ["AAAA-MM-DD HH:MM"]');
  process.exit(1);
}
const groupJid = getMainGroupJid();
const jid = groupJid && findSenderJidByName(groupJid, name);
if (!jid) {
  console.error(`Nao achei ninguem com o nome "${name}" no historico do grupo.`);
  process.exit(1);
}
const [d, t] = (when || '').split(' ');
const ts = when ? brToTs(d, t) : Math.floor(Date.now() / 1000);
if (!ts) {
  console.error('Data/hora invalida. Use o formato "AAAA-MM-DD HH:MM" (horario de Brasilia).');
  process.exit(1);
}
const nome = formatDisplayName(name);
const n = Math.max(0, Number(insultsArg ?? 3));
for (let i = 1; i <= n; i++) recordInsult({ jid, nome: name, texto: '(registrado manualmente)', strike: i, ts: ts - (n - i + 1) * 60 });
recordExpulsion({ jid, nome: name, ts });
logBotAction({ tipo: 'expulsao', jid, nome, resumo: `EU expulsei o ${nome} do grupo, de forma automatica, porque ele me insultou 3 vezes (regra: 3 insultos = expulsao) — registrado manualmente depois` });
console.log(`Registrado: ${nome} (${jid}) — ${n} insulto(s) e 1 expulsao.`);
