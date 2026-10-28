import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { toFile } from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BOT_PHOTO_PATH = path.join(__dirname, '..', 'assets', 'bot-photo.png');

const CHAT_MODEL = 'gpt-4o-mini';
const IMAGE_MODEL = 'gpt-image-1';

// Palavras-chave de altissima relevancia nacional — manchetes que batem aqui
// sao colocadas no topo da lista antes de mandar pra IA, como um "boost" de
// prioridade. So o julgamento livre da IA (mesmo com prompt reforcado) nao
// era suficiente pra garantir que essas noticias vencessem consistentemente
// contra noticias de crime/policia, que tem apelo visual mais forte.
const HIGH_PRIORITY_KEYWORDS = /\b(STF|Supremo Tribunal Federal|Congresso Nacional|Planalto|governo federal|presidente da rep[uú]blica|Senado Federal|C[aâ]mara dos Deputados|Banco Central|PIB|infla[cç][aã]o)\b/i;

/**
 * Reordena as manchetes colocando primeiro as que batem em HIGH_PRIORITY_KEYWORDS
 * (mantendo a ordem relativa dentro de cada grupo) — usado pra dar um empurrao
 * de prioridade antes da IA decidir, ja que o julgamento livre dela nem sempre
 * pesa decisoes institucionais acima de noticias de crime com apelo visual forte.
 */
function sortByNationalPriority(headlines) {
  const priority = [];
  const rest = [];
  for (const h of headlines) {
    const text = `${h.title} ${h.subtitle || ''}`;
    (HIGH_PRIORITY_KEYWORDS.test(text) ? priority : rest).push(h);
  }
  return [...priority, ...rest];
}

/**
 * Usa a OpenAI pra ler uma lista de manchetes do dia e escolher a mais
 * impactante, devolvendo tambem uma descricao curta de tema visual (usada
 * como instrucao pra edicao da foto). Responde em JSON pra evitar parsing
 * fragil de texto livre.
 */
export async function pickMostImpactfulHeadline(client, headlines) {
  if (headlines.length === 0) return null;

  const sorted = sortByNationalPriority(headlines);
  const priorityCount = sorted.filter((h) => HIGH_PRIORITY_KEYWORDS.test(`${h.title} ${h.subtitle || ''}`)).length;

  const list = sorted
    .map((h, i) => `${i + 1}. ${h.title}${h.subtitle ? ` — ${h.subtitle}` : ''}`)
    .join('\n');

  const priorityNote =
    priorityCount > 0
      ? `As manchetes 1 a ${priorityCount} foram pre-selecionadas por mencionarem STF, governo federal, Congresso ou economia nacional — ` +
        'temas de altissima relevancia institucional. Prefira fortemente escolher entre elas, a menos que exista mais abaixo na lista uma ' +
        'tragedia de escala claramente muito maior (ex: centenas de mortos, desastre nacional). '
      : '';

  const completion = await client.chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'Voce escolhe, entre manchetes de noticias em portugues do Brasil, qual e a MAIS IMPORTANTE PRA O PAIS COMO UM TODO hoje. ' +
          'O criterio e IMPORTANCIA NACIONAL, NAO o quao chocante/tragica/dramatica a noticia e — um crime ou tragedia envolvendo uma ' +
          'unica familia ou pessoa NAO conta como importante nacionalmente so por ser triste ou violento, mesmo que tenha detalhes ' +
          'graficos. So escolha uma tragedia/crime se ela realmente afetar o pais (varios estados, uma cidade inteira, milhares de ' +
          'pessoas, ou tiver repercussao politica/institucional de fato). ' +
          'De prioridade alta pra: julgamentos e decisoes do STF, decisoes importantes do governo federal, crises economicas nacionais, ' +
          'eventos de repercussao nacional/internacional de verdade — mesmo que a manchete pareca "processual" (ex: "sessao suspensa", ' +
          '"ministros voltam as X horas"), se o assunto de fundo for um julgamento de repercussao nacional, ele continua sendo a ' +
          'noticia mais importante do dia. De prioridade baixa/nula pra: crimes e tragedias familiares/individuais (por mais ' +
          'chocantes que sejam), noticias regionais/locais de um unico estado ou cidade, sabatinas e entrevistas de candidatos a ' +
          'governos estaduais, fofoca, esporte comum e curiosidades. ' +
          priorityNote +
          'Depois de escolher a manchete, invente uma PERSONIFICACAO: um personagem/papel/fantasia que representa essa noticia, que uma ' +
          'pessoa poderia literalmente vestir numa foto (ex: pra uma noticia do STF, "juiz do STF, toga preta, colar de gravata branco, ' +
          'martelo de juiz na mao, plenario do tribunal ao fundo"; pra uma enchente, "bombeiro de resgate, colete salva-vidas laranja, ' +
          'capacete, agua ate a cintura"; pra uma eleicao, "mesario de urna eletronica, cracha oficial, cabine de votacao ao fundo"). Seja ' +
          'especifico sobre roupa/uniforme, acessorios e cenario — isso vai ser usado pra fantasiar literalmente a pessoa da foto. ' +
          'Primeiro, em um campo "reasoning", liste em 1-2 frases as 2-3 manchetes mais fortes candidatas e por que uma delas vence. ' +
          'Depois responda no formato JSON {"reasoning": "<seu raciocinio curto>", "index": <numero da manchete escolhida, comecando em 1>, ' +
          '"persona": "<descricao especifica de roupa/uniforme, acessorios e cenario pra fantasiar a pessoa — ex: \'juiz do STF, toga preta, ' +
          'martelo, plenario ao fundo\'>"}.',
      },
      { role: 'user', content: `Manchetes de hoje:\n\n${list}` },
    ],
    max_tokens: 350,
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  const chosen = sorted[parsed.index - 1];
  if (!chosen) return null;

  return { ...chosen, persona: parsed.persona };
}

/**
 * Edita a foto base do bot (assets/bot-photo.png) fantasiando literalmente a
 * pessoa da foto de acordo com a personificacao informada (roupa/uniforme,
 * acessorios, cenario), usando a API de edicao de imagem da OpenAI. Retorna
 * um Buffer com a imagem editada (PNG).
 */
export async function editBotPhoto(client, persona) {
  const imageFile = await toFile(fs.createReadStream(BOT_PHOTO_PATH), 'bot-photo.png', { type: 'image/png' });

  const response = await client.images.edit({
    model: IMAGE_MODEL,
    image: imageFile,
    prompt:
      `Edite esta foto fantasiando a pessoa como: ${persona}. Troque a roupa dela pelo figurino descrito, adicione os acessorios ` +
      `mencionados e ajuste o cenario ao redor pra combinar, mantendo o rosto da pessoa claramente reconhecivel e sem cobri-lo. ` +
      `Preserve o formato circular da foto.`,
    size: '1024x1024',
    input_fidelity: 'high',
  });

  const b64 = response.data[0]?.b64_json;
  if (!b64) throw new Error('OpenAI nao retornou imagem editada (b64_json ausente)');

  return Buffer.from(b64, 'base64');
}
