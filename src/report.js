import { getDailyCountsAnyDate as getDailyCounts, getGroupsWithMessagesAnyDate as getGroupsWithMessages } from './db.js';

// Converte uma data ISO (YYYY-MM-DD, usada internamente para gravar/consultar) para
// o formato de exibicao DD-MM-YYYY.
function formatDateBR(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}-${month}-${year}`;
}

// Uso: npm run report            -> relatorio de hoje
//      npm run report 2026-09-01 -> relatorio de uma data especifica
const date = process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const dateDisplay = formatDateBR(date);

const groups = getGroupsWithMessages(date);

if (groups.length === 0) {
  console.log(`Nenhuma mensagem registrada em ${dateDisplay}.`);
  process.exit(0);
}

for (const g of groups) {
  console.log(`\n📊 Grupo: ${g.group_name}  —  ${dateDisplay}`);
  const counts = getDailyCounts(g.group_jid, date);
  counts.forEach((c, i) => console.log(`   ${i + 1}. ${c.sender_name}: ${c.total}`));
}
console.log('');
