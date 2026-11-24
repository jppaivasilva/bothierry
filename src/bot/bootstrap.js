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
