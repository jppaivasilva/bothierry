// Fluxo da eleicao (apuracao ao vivo, foto do eleito) e troca da foto do grupo com a noticia do dia.

import path from 'path';
import { ROOT, getBrasiliaNow, findMainGroupJid, getOpenAIClient } from './shared.js';
import fs from 'fs';
import { getPresidentSummary, getUrnasApuradasPorRegiao } from '../elections.js';
import { getPendingGroupRenames, setPendingGroupRenames } from '../birthdays.js';
import { editBotPhoto, pickMostImpactfulHeadline } from '../groupPhoto.js';
import { getRecentHeadlines } from '../news.js';

// Comando temporario so pra testar a apuracao eleitoral sem esperar o cron de
// 10 em 10 minutos. Remover depois que a eleicao acabar (junto do resto do
// bloco de eleicoes, ja marcado mais abaixo).
export async function commandTestarEleicao({ sock }) {
  await sendElectionUpdate(sock, { force: true });
}

// Comando temporario so pra testar a troca de foto do presidente eleito sem
// esperar a apuracao fechar em 100%. Remover junto do resto do bloco de
// eleicoes, depois que a eleicao acabar.
export async function commandTestarFotoPresidente({ sock, groupJid, args }) {
  const nome = args.trim();
  if (!nome) {
    return sock.sendMessage(groupJid, { text: 'Use: !testarfotopresidente lula  OU  !testarfotopresidente flavio' });
  }
  await updateGroupPhotoWithElectionWinner(sock, groupJid, nome);
  return sock.sendMessage(groupJid, { text: `Testei a troca de foto pro vencedor "${nome}" — confere se mudou.` });
}

// Comando temporario so pra testar o anuncio do resultado final + renomeacao
// do grupo ("DEU LULA"/"DEU FLAVIO") sem esperar a apuracao fechar em 100%.
// ATENCAO: isso renomeia o grupo de verdade. Remover junto do resto do bloco
// de eleicoes, depois que a eleicao acabar.
export async function commandTestarResultadoEleicao({ sock, groupJid, args }) {
  const nome = args.trim();
  if (!nome) {
    return sock.sendMessage(groupJid, { text: 'Use: !testarresultadoeleicao lula  OU  !testarresultadoeleicao flavio (isso RENOMEIA o grupo de verdade)' });
  }
  await announceElectionWinner(sock, groupJid, nome);
}

// Data da eleicao (1o turno 2026) em que a apuracao ao vivo deve rodar —
// feature de uso unico pra hoje, 04/10/2026. Depois da eleicao, da pra
// remover esse bloco inteiro (constantes, funcao, state file e o cron la
// embaixo) sem afetar mais nada do bot.
const ELECTION_DATE = '2026-10-25';

// Urnas fecham as 17h (horario de Brasilia) — o TSE so comeca a publicar
// resultado a partir desse horario, entao nao faz sentido mandar atualizacao
// (sempre 0%) antes disso.
const ELECTION_RESULTS_START_HOUR = 17;

const ELECTION_STATE_FILE = path.join(ROOT, 'eleicoes_state.json');

function isElectionFinalized() {
  if (!fs.existsSync(ELECTION_STATE_FILE)) return false;
  try {
    return JSON.parse(fs.readFileSync(ELECTION_STATE_FILE, 'utf-8')).finalized === true;
  } catch {
    return false;
  }
}

function setElectionFinalized(value) {
  fs.writeFileSync(ELECTION_STATE_FILE, JSON.stringify({ finalized: value }));
}

function formatRaceBlock(titulo, resumo) {
  const lines = [`${titulo} — urnas apuradas: ${resumo.urnasPercentual}%`];
  resumo.candidatos.slice(0, 5).forEach((c, i) => {
    lines.push(`${i + 1}. ${c.nome} (${c.numero}) — ${c.percentual}% (${c.votos.toLocaleString('pt-BR')} votos)`);
  });
  return lines.join('\n');
}

/**
 * Manda a apuracao parcial do 2o turno (so Presidente — Governador de SP ja
 * foi decidido no 1o turno, Tarcisio com 62,65%) no grupo, de 10 em 10
 * minutos no dia da eleicao — para sozinho de mandar quando as urnas
 * chegarem a 100% apuradas.
 */
export async function sendElectionUpdate(sock, { force = false } = {}) {
  const { date: today, time } = getBrasiliaNow();
  const hourNow = Number(time.split(':')[0]);
  if (!force && (today !== ELECTION_DATE || hourNow < ELECTION_RESULTS_START_HOUR || isElectionFinalized())) return;

  const groupJid = await findMainGroupJid(sock);
  if (!groupJid) {
    console.error('[eleicoes] Grupo principal nao encontrado entre os grupos que o bot participa.');
    return;
  }

  let presidente;
  try {
    presidente = await getPresidentSummary();
  } catch (err) {
    console.error('[eleicoes] Erro ao buscar apuracao do TSE:', err);
    return;
  }

  let regioes = null;
  try {
    regioes = await getUrnasApuradasPorRegiao();
  } catch (err) {
    console.error('[eleicoes] Erro ao buscar urnas apuradas por regiao:', err);
  }
  const regioesBlock = regioes
    ? '\n\n🗺️ *Urnas apuradas por região*\n' + regioes.map((r) => `${r.nome}: ${r.percentual}%`).join('\n')
    : '';

  const text =
    `🗳️ *Apuração Eleições 2026 — 2º Turno* — atualizado às ${presidente.atualizadoEm}\n\n` +
    `${formatRaceBlock('🏛️ *Presidente (Brasil)*', presidente)}` +
    regioesBlock;

  try {
    await sock.sendMessage(groupJid, { text });
  } catch (err) {
    console.error('[eleicoes] Erro ao enviar atualizacao da apuracao:', err);
    return;
  }

  if (presidente.urnasPercentualNum >= 100) {
    setElectionFinalized(true);
    console.log('[eleicoes] Apuração chegou a 100% das urnas — parando os envios.');

    const winnerName = presidente.candidatos[0]?.nome;
    await announceElectionWinner(sock, groupJid, winnerName);

    try {
      await updateGroupPhotoWithElectionWinner(sock, groupJid, winnerName);
    } catch (err) {
      console.error('[eleicoes] Erro ao atualizar foto do grupo com o presidente eleito:', err);
    }
  }
}

// Persona visual pra cada candidato do 2o turno — cores dos partidos/espectro
// politico (Flavio Bolsonaro = direita, azul; Lula = esquerda, vermelho),
// usada pra fantasiar a foto do bot quando a apuracao fecha em 100%.
const ELECTION_WINNER_PERSONAS = [
  {
    match: /BOLSONARO/i,
    displayName: 'Flávio Bolsonaro',
    groupName: 'DEU FLAVIO',
    persona:
      'presidente do Brasil recem-eleito, terno azul marinho, gravata azul, faixa presidencial verde-amarela no peito, ' +
      'bandeira do Brasil ao fundo, iluminacao em tom azul patriotico, expressao confiante',
  },
  {
    match: /LULA/i,
    displayName: 'Lula',
    groupName: 'DEU LULA',
    persona:
      'presidente do Brasil recem-eleito, camisa social vermelha, faixa presidencial verde-amarela no peito, ' +
      'bandeira do Brasil ao fundo, iluminacao em tom vermelho vibrante, expressao confiante e sorridente',
  },
];

function findElectionWinnerPersona(winnerName) {
  if (!winnerName) return null;
  return ELECTION_WINNER_PERSONAS.find((p) => p.match.test(winnerName)) || null;
}

/**
 * Manda a mensagem de resultado final ("fulano foi eleito presidente") e
 * renomeia o grupo pra "DEU FLAVIO"/"DEU LULA", assim que a apuracao fecha em
 * 100%. Registra o nome original como "pending rename" (mesmo mecanismo do
 * tema de aniversario) pra voltar sozinho pro nome que o grupo tinha antes na
 * proxima meia-noite, via revertPendingGroupRenames (cron '1 0 * * *').
 */
async function announceElectionWinner(sock, groupJid, winnerName) {
  const match = findElectionWinnerPersona(winnerName);
  if (!match) {
    console.error(`[eleicoes] Nenhuma persona cadastrada pro candidato vencedor "${winnerName}", pulando anuncio/renomeacao.`);
    return;
  }

  try {
    await sock.sendMessage(groupJid, {
      text: `🚨 *RESULTADO FINAL* 🚨\n\n${match.displayName} foi eleito(a) Presidente do Brasil! 🇧🇷`,
    });
  } catch (err) {
    console.error('[eleicoes] Erro ao mandar anuncio do resultado final:', err);
  }

  try {
    // Guarda o nome ATUAL do grupo (ele muda com frequencia) pra voltar pra ele
    // na meia-noite; se ja existe uma reversao pendente (ex: tema de aniversario),
    // mantem o nome original que ja estava guardado.
    const pending = getPendingGroupRenames();
    const originalName = pending[groupJid] || (await sock.groupMetadata(groupJid)).subject;
    await sock.groupUpdateSubject(groupJid, match.groupName);
    console.log(`[eleicoes] Grupo renomeado para "${match.groupName}".`);

    pending[groupJid] = originalName;
    setPendingGroupRenames(pending);
    console.log(`[eleicoes] Reversao pra "${originalName}" agendada pra meia-noite.`);
  } catch (err) {
    console.error('[eleicoes] Erro ao renomear o grupo com o resultado final:', err);
  }
}

/**
 * Troca a foto do grupo com o tema do presidente eleito assim que a apuracao
 * do 2o turno fecha em 100% — mesmo mecanismo de edicao de foto usado pras
 * manchetes do dia (editBotPhoto), so que com persona fixa por candidato em
 * vez de escolhida pela IA.
 */
async function updateGroupPhotoWithElectionWinner(sock, groupJid, winnerName) {
  if (!winnerName) {
    console.error('[eleicoes] Nome do candidato vencedor nao disponivel, pulando troca de foto.');
    return;
  }
  const match = findElectionWinnerPersona(winnerName);
  if (!match) {
    console.error(`[eleicoes] Nenhuma persona cadastrada pro candidato vencedor "${winnerName}", pulando troca de foto.`);
    return;
  }

  const client = getOpenAIClient();
  if (!client) {
    console.error('[eleicoes] OPENAI_API_KEY nao configurada, pulando troca de foto.');
    return;
  }

  const editedPhoto = await editBotPhoto(client, match.persona);
  await sock.updateProfilePicture(groupJid, editedPhoto);
  console.log(`[eleicoes] Foto do grupo atualizada com o tema do presidente eleito: "${winnerName}"`);
}

/**
 * Escolhe, entre as manchetes recentes do G1, a noticia mais importante nacionalmente do
 * dia (via IA) e troca a foto do grupo principal por uma edicao
 * tematica da foto-base do bot (assets/bot-photo.png), incorporando o tema
 * visual da noticia. So mexe nesse grupo especifico — nenhum outro grupo tem
 * a foto alterada por essa rotina.
 */
export async function updateGroupPhotoWithNews(sock) {
  const client = getOpenAIClient();
  if (!client) {
    console.error('[foto do grupo] OPENAI_API_KEY nao configurada, pulando.');
    return;
  }

  const groupJid = await findMainGroupJid(sock);
  if (!groupJid) {
    console.error('[foto do grupo] Grupo principal nao encontrado entre os grupos que o bot participa.');
    return;
  }

  // O feed do G1 e cronologico (ultimas publicacoes), nao por relevancia —
  // pegar so as 10 mais recentes deixa de fora manchetes de capa importantes
  // que nao acabaram de ser publicadas (ex: cobertura continua de um
  // julgamento). Busca uma janela maior e filtra videos de telejornais
  // regionais e noticias de editoria estadual (URL com UF, ex: g1.globo.com/go/...)
  // — essas nunca vao pra capa nacional do G1, entao nao interessam aqui mesmo
  // que sejam tragicas/chocantes.
  const REGIONAL_URL_PATTERN =
    /^https?:\/\/g1\.globo\.com\/(ac|al|am|ap|ba|ce|df|es|go|ma|mg|ms|mt|pa|pb|pe|pi|pr|rj|rn|ro|rr|rs|sc|se|sp|to)\//i;
  let headlines;
  try {
    const recent = await getRecentHeadlines(100);
    headlines = recent.filter((h) => !/^v[íi]deos?:/i.test(h.title) && !REGIONAL_URL_PATTERN.test(h.link));
  } catch (err) {
    console.error('[foto do grupo] Erro ao buscar manchetes do G1:', err);
    return;
  }
  if (headlines.length === 0) {
    console.error('[foto do grupo] Nenhuma manchete de relevancia nacional (nao-regional) encontrada no feed agora — pulando essa rodada.');
    return;
  }

  let picked;
  try {
    picked = await pickMostImpactfulHeadline(client, headlines);
  } catch (err) {
    console.error('[foto do grupo] Erro ao escolher a noticia mais importante:', err);
    return;
  }
  if (!picked) {
    console.error('[foto do grupo] Nao foi possivel escolher uma noticia.');
    return;
  }

  let editedPhoto;
  try {
    editedPhoto = await editBotPhoto(client, picked.persona);
  } catch (err) {
    console.error('[foto do grupo] Erro ao editar a foto via OpenAI:', err);
    return;
  }

  try {
    await sock.updateProfilePicture(groupJid, editedPhoto);
    console.log(`[foto do grupo] Foto atualizada com o tema: "${picked.title}"`);
  } catch (err) {
    console.error('[foto do grupo] Erro ao atualizar a foto do grupo (o bot e admin?):', err);
  }
}
