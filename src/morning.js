// Regras do bom dia: em quais dias sai e qual o texto de abertura.
//
// Normalmente so de segunda a sexta. EXTRA_MORNING_DATES lista datas de fim de
// semana em que ele sai mesmo assim (ex.: viagem do grupo, pra ter a previsao).
// Datas passadas nao fazem mal nenhum, pode deixar ou limpar depois.
const EXTRA_MORNING_DATES = ['2026-10-31', '2026-11-01'];

// Dia da semana (0 = domingo ... 6 = sabado) de uma data YYYY-MM-DD.
export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

export function isWeekend(dateStr) {
  const d = weekdayOf(dateStr);
  return d === 0 || d === 6;
}

/** O bom dia sai nessa data (YYYY-MM-DD, horario de Brasilia)? */
export function shouldSendMorning(dateStr) {
  return !isWeekend(dateStr) || EXTRA_MORNING_DATES.includes(dateStr);
}

/** Texto de abertura do bom dia (sem a previsao do tempo). */
export function morningGreeting({ diaSemana, holidayName, weekend }) {
  if (holidayName) {
    return `☀️ Bom dia, grupo! Hoje é *${diaSemana}*, feriado nacional: *${holidayName}* 🎉 Aproveitem o dia de folga!`;
  }
  if (weekend) return `☀️ Bom dia, grupo! Hoje é *${diaSemana}*. Bom fim de semana a todos! 🌴`;
  return `☀️ Bom dia, grupo! Hoje é *${diaSemana}*. Bom trabalho a todos! 💪`;
}
