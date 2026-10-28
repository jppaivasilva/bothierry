import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(__dirname, '..', 'regras');

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Le as regras da pasta regras/. Cada arquivo .txt e uma regra:
 * - nome do arquivo (sem .txt) = numero da regra (ex: 93.txt -> Regra 93)
 * - primeira linha = descricao da regra (o que aparece pro grupo)
 * - linhas seguintes = frases-gatilho — qualquer uma que aparecer na mensagem
 *   (sem diferenciar maiuscula/acento) ativa a regra
 * - uma linha comecando com "!" e uma EXCECAO — se ela tambem aparecer na
 *   mensagem, a regra NAO dispara (ex: "pudim" dispara, mas "!dimaroca" faz
 *   nao disparar se "dimaroca" tambem estiver na mensagem)
 */
export function loadRules() {
  if (!fs.existsSync(RULES_DIR)) return [];
  return fs
    .readdirSync(RULES_DIR)
    .filter((filename) => filename.toLowerCase().endsWith('.txt'))
    .map((filename) => {
      const number = path.basename(filename, path.extname(filename));
      const content = fs.readFileSync(path.join(RULES_DIR, filename), 'utf-8');
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const [description, ...rest] = lines;

      const triggers = [];
      const exceptions = [];
      for (const line of rest) {
        if (line.startsWith('!')) exceptions.push(line.slice(1).trim());
        else triggers.push(line);
      }

      return { number, description, triggers, exceptions };
    })
    .filter((rule) => rule.description)
    .sort((a, b) => Number(a.number) - Number(b.number));
}

/**
 * Acha a primeira regra cujo gatilho aparece no texto da mensagem, e nenhuma
 * das excecoes dela tambem aparece.
 */
export function findMatchingRule(text) {
  const normalizedText = stripAccents(text);
  return loadRules().find((rule) => {
    const hasTrigger = rule.triggers.some((trigger) => normalizedText.includes(stripAccents(trigger)));
    if (!hasTrigger) return false;
    return !rule.exceptions.some((exception) => normalizedText.includes(stripAccents(exception)));
  });
}
