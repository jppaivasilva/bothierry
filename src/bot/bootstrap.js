// Roda antes de tudo: leva console.error pro painel e carrega o .env.

import { recordError } from '../metrics.js';

// Intercepta todo console.error do processo pra tambem alimentar o painel de
// monitoramento (secao "Erros recentes"), sem precisar chamar recordError()
// manualmente em cada catch espalhado pelo codigo.
const originalConsoleError = console.error.bind(console);

console.error = (...args) => {
  originalConsoleError(...args);
  try {
    recordError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  } catch {
    // nunca deixa o registro de metricas quebrar o log de erro em si
  }
};

// Carrega OPENAI_API_KEY (e outras variaveis) de um arquivo .env na raiz do
// projeto, se ele existir. Nao falha se o arquivo nao existir ainda.
try {
  process.loadEnvFile();
} catch {
  // sem .env por enquanto — comandos que dependem dele (!resumo) avisam na hora
}

// Rede de seguranca: no Node 22 uma promessa rejeitada sem tratamento DERRUBA o processo (o PM2
// reinicia, o bot some uns segundos e respostas em andamento se perdem). Aqui so registramos o erro
// (aparece em "Erros recentes" no painel) e seguimos. Se estourar muitos erros graves em pouco
// tempo, deixa o PM2 reiniciar de verdade (estado provavelmente corrompido).
const fatalTimes = [];
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : String(reason));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err instanceof Error ? err.stack || err.message : String(err));
  const now = Date.now();
  fatalTimes.push(now);
  while (fatalTimes.length && now - fatalTimes[0] > 60_000) fatalTimes.shift();
  if (fatalTimes.length >= 5) {
    console.error('[uncaughtException] 5 erros graves em 1 minuto: reiniciando pelo PM2.');
    process.exit(1);
  }
});
