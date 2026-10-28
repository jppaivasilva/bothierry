// Normaliza o nome de exibicao das pessoas do grupo — o nome bruto vem do
// WhatsApp (pushName) exatamente como a pessoa configurou no proprio
// aparelho, entao chega inconsistente (TUDO MAIUSCULO, tudo minusculo, sem
// acento, espacos duplos). Isso so formata pra exibicao no painel — nunca
// mexe no dado bruto gravado em messages.jsonl.
//
// Entradas conhecidas (acento certo, ou desambiguado de homonimo) ficam no
// mapa abaixo; qualquer nome novo que aparecer cai no fallback de Title Case
// automatico.
const DISPLAY_NAME_MAP = {
  'joao paulo': 'João Paulo',
  'daniel guimaraes': 'Daniel Guimarães',
  'wesley cesario': 'Wesley Cesário',
  'laercio mendes': 'Laércio Mendes',
  'kauê s de campos': 'Kauê S de Campos', // nome bruto tem espaco duplo, normalizado pra 1 antes da busca
  '🤖 bothierry': 'Bothierry',
  // Ha dois "Gabriel" no grupo (GABRIEL e Gabriel Guerra) — esse aqui nao
  // tem sobrenome registrado, entao desambigua pelo apelido (apelidos.txt).
  gabriel: 'Gabriel (Gabs)',
};

function titleCase(name) {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

export function formatDisplayName(rawName) {
  if (!rawName) return rawName;
  const key = rawName.trim().toLowerCase().replace(/\s+/g, ' ');
  return DISPLAY_NAME_MAP[key] || titleCase(rawName);
}
