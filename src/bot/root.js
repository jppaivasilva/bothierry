// "Root" do bot no WhatsApp: quem pode usar os comandos experimentais/perigosos.
// E a propria conta do bot (mensagem fromMe) ou os numeros listados em ROOT_NUMBERS no .env
// (separados por virgula; o numero e o que o WhatsApp mostra pro bot, veja o aviso do !statusgrupo).
const digits = (jid) => String(jid ?? '').split('@')[0].split(':')[0];

export const rootNumbers = () => String(process.env.ROOT_NUMBERS || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);

export function isRoot({ senderJid, msg }) {
  if (msg?.key?.fromMe) return true;
  const list = rootNumbers();
  return list.length > 0 && list.includes(digits(senderJid));
}
