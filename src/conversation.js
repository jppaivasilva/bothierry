// Memoria de CURTO prazo: as ultimas trocas entre uma pessoa e o bot, pra
// "e amanha?" / "explica melhor" funcionarem. Fica so em memoria (some ao
// reiniciar) e expira sozinha.
const TTL_MS = 20 * 60 * 1000;
const MAX_TURNS = 4;
const threads = new Map(); // "grupo|pessoa" -> [{ q, a, at }]

const keyOf = (groupJid, senderJid) => `${groupJid}|${senderJid}`;

/** Mensagens (user/assistant) das trocas recentes, prontas pra entrar na conversa com a IA. */
export function getThreadMessages(groupJid, senderJid, now = Date.now()) {
  const turns = (threads.get(keyOf(groupJid, senderJid)) || []).filter((t) => now - t.at < TTL_MS);
  return turns.flatMap((t) => [
    { role: 'user', content: t.q },
    { role: 'assistant', content: t.a },
  ]);
}

export function addThreadTurn(groupJid, senderJid, q, a, now = Date.now()) {
  const key = keyOf(groupJid, senderJid);
  const turns = (threads.get(key) || []).filter((t) => now - t.at < TTL_MS);
  turns.push({ q: String(q).slice(0, 500), a: String(a).slice(0, 600), at: now });
  threads.set(key, turns.slice(-MAX_TURNS));
  if (threads.size > 500) for (const [k, v] of threads) if (now - (v[v.length - 1]?.at ?? 0) > TTL_MS) threads.delete(k);
}
