// "Obrigado @Nicholas" em sequencia: quando 3 mensagens seguidas agradecem ao
// Nicholas, o bot manda uma enxurrada de obrigados marcando ele.

export const THANKS_TARGET_NAME = 'Nicholas';
const THANKS_WORD = /(?<![\p{L}])obrigad(?:o|a|ão|inho|inha)s?(?![\p{L}])/iu;

const digits = (jid) => String(jid ?? '').split('@')[0].split(':')[0];

/**
 * A mensagem agradece ao alvo? Precisa ter "obrigado/obrigada" E citar o alvo:
 * marcando ele (mentionedJids bate com um dos targetJids, pelo numero) ou
 * escrevendo o nome dele no texto.
 */
export function isThanksToTarget({ text, mentionedJids = [], targetJids = [], targetName = THANKS_TARGET_NAME }) {
  if (!text || !THANKS_WORD.test(text)) return false;
  const targets = new Set(targetJids.filter(Boolean).map(digits));
  const mentioned = mentionedJids.some((jid) => targets.has(digits(jid)));
  const named = new RegExp(`\\b${targetName}\\b`, 'i').test(text);
  return mentioned || named;
}

/** Texto da enxurrada: de 8 a 12 linhas "Obrigado @alvo". */
export function buildThanksText(targetJid, count = 8 + Math.floor(Math.random() * 5)) {
  const line = `Obrigado @${digits(targetJid)} 🙏`;
  return Array.from({ length: count }, () => line).join('\n');
}

/**
 * Conta agradecimentos seguidos por grupo. Qualquer mensagem que nao seja um
 * agradecimento zera a contagem, e agradecimentos separados por mais de
 * windowMs tambem. Depois de disparar, espera cooldownMs antes de disparar de novo.
 */
export class ThanksStreak {
  constructor({ needed = 3, windowMs = 10 * 60 * 1000, cooldownMs = 10 * 60 * 1000 } = {}) {
    this.needed = needed;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
    this.state = new Map(); // groupJid -> { count, last, cooldownUntil }
  }

  /** Registra uma mensagem do grupo. Retorna true quando e hora de mandar a enxurrada. */
  register(groupJid, isThanks, now = Date.now()) {
    const s = this.state.get(groupJid) || { count: 0, last: 0, cooldownUntil: 0 };
    if (!isThanks) {
      s.count = 0;
    } else {
      s.count = now - s.last > this.windowMs ? 1 : s.count + 1;
      s.last = now;
    }
    let fire = false;
    if (s.count >= this.needed && now >= s.cooldownUntil) {
      fire = true;
      s.count = 0;
      s.cooldownUntil = now + this.cooldownMs;
    }
    this.state.set(groupJid, s);
    return fire;
  }
}
