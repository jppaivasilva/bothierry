// Mapa de comandos (!ranking, !menu...), categorias do menu e o parser de comando.

import { commandRanking, commandPainel, commandResumo, commandTranscrever, commandFigurinha, commandRenomearGrupo, commandFotoGrupo, commandMegasena, commandPoliciaFederal, commandOtario, commandRegras, commandRegulamento } from './basicCommands.js';
import { commandWrapped, commandTestarNoticias, commandTestarEstreia, commandTestarNuvem } from './specialMessages.js';
import { commandAniversariantes, commandTestarAniversario } from './birthdayFlow.js';
import { commandEventos, commandAddEvento, commandVou, commandNaoVou } from './eventCommands.js';
import { commandTestarEleicao, commandTestarFotoPresidente, commandTestarResultadoEleicao } from './electionFlow.js';
import { commandTestarBomDia, commandResumoSemanal } from './dailyMessages.js';
import { commandAudios, commandSalvarAudio } from './audioCommands.js';
import { commandMemoria, commandEsquecer, commandInsultos } from './memoryCommands.js';
import { commandLembretes, commandCancelarLembrete } from './reminderFlow.js';

// Reconhece tanto "!comando" quanto "/comando" como prefixo de comando.
export function parseCommand(text) {
  const match = text.trim().match(/^[!/](\S+)/);
  return match ? match[1].toLowerCase() : null;
}

async function commandMenu({ sock, groupJid }) {
  const blocks = COMMAND_CATEGORIES.map((cat) => {
    const commandLines = cat.commands.map((c) => `!${c.name} — ${c.description}`).join('\n');
    return `${cat.emoji} *${cat.title}*\n${commandLines}`;
  });
  return sock.sendMessage(groupJid, { text: `🤖 *Olha o que eu sei fazer* (é só mandar o comando):\n\n${blocks.join('\n\n')}` });
}

// Categorias exibidas pelo !menu. Ao adicionar um comando novo, inclua ele
// numa categoria existente (ou crie uma nova) aqui.
export const COMMAND_CATEGORIES = [
  {
    emoji: '📊',
    title: 'Ranking e regras',
    commands: [
      { name: 'ranking', description: 'ranking de mensagens de hoje, com percentual e total' },
      { name: 'wrapped', description: 'seu Bothierry Wrapped do ano (use "!wrapped grupo" pro do grupo)' },
      { name: 'regras', description: 'lista as regras do grupo' },
      { name: 'regulamento', description: 'mostra o manifesto oficial do grupo' },
    ],
  },
  {
    emoji: '🎉',
    title: 'Eventos',
    commands: [
      { name: 'eventos', description: 'lista os eventos cadastrados' },
      { name: 'addevento', description: 'cadastra um novo evento (manda sozinho pra ver o formato)' },
      { name: 'vou', description: 'confirma sua presença num evento' },
      { name: 'naovou', description: 'marca ausência num evento' },
    ],
  },
  {
    emoji: '🎂',
    title: 'Aniversários',
    commands: [{ name: 'aniversariantes', description: 'lista os aniversariantes cadastrados' }],
  },
  {
    emoji: '🗞️',
    title: 'Outros',
    commands: [
      { name: 'painel', description: 'te manda no privado um link pro painel, pra marcar presença nos eventos' },
      { name: 'resumo', description: 'resume as mensagens das últimas 24h, em até 10 tópicos (via IA)' },
      { name: 'transcrever', description: 'transcreve um áudio — responda o áudio com !transcrever' },
      { name: 'figurinha', description: 'transforma uma foto em figurinha — responda a foto com !figurinha' },
      { name: 'renomear', description: 'muda o nome do grupo — !renomear novo nome' },
      { name: 'fotogrupo', description: 'responda a uma foto com !fotogrupo pra trocar a foto do grupo por ela' },
      { name: 'megasena', description: 'lista os organizadores da Mega da Virada de cada ano' },
      { name: 'policiafederal', description: 'nota pública de esclarecimento, pra qualquer eventualidade' },
      { name: 'lembretes', description: 'lista seus lembretes (pra criar: "@Bothierry me lembra sexta às 20h de...")' },
      { name: 'cancelar', description: 'cancela um lembrete — !cancelar 12' },
      { name: 'insultos', description: 'quadro de quem mais me xingou e quantas vezes foi expulso' },
      { name: 'memoria', description: 'mostra o que eu lembro de você e do grupo' },
      { name: 'esquecer', description: 'apaga uma coisa que anotei de você — !esquecer 12 ou !esquecer tudo' },
      { name: 'otario', description: 'responda a uma mensagem com !otario pra marcar quem mandou ela' },
    ],
  },
  {
    emoji: '🔊',
    title: 'Áudios',
    commands: [
      { name: 'audios', description: 'lista de áudios disponíveis' },
      { name: 'salvaraudio', description: 'salva um áudio — responda o áudio com !salvaraudio nome' },
    ],
  },
];

// Mapa comando -> handler. Pra adicionar um comando novo: escreva a funcao
// (recebe { sock, groupJid } e retorna o resultado de sock.sendMessage),
// registre aqui e adicione a descricao em COMMAND_HELP.
export const commands = {
  ranking: commandRanking,
  wrapped: commandWrapped,
  aniversariantes: commandAniversariantes,
  eventos: commandEventos,
  addevento: commandAddEvento,
  vou: commandVou,
  naovou: commandNaoVou,
  menu: commandMenu,
  painel: commandPainel,
  resumo: commandResumo,
  transcrever: commandTranscrever,
  figurinha: commandFigurinha,
  renomear: commandRenomearGrupo,
  fotogrupo: commandFotoGrupo,
  megasena: commandMegasena,
  policiafederal: commandPoliciaFederal,
  testareleicao: commandTestarEleicao,
  testarbomdia: commandTestarBomDia,
  testarnoticias: commandTestarNoticias,
  testarestreia: commandTestarEstreia,
  testarnuvem: commandTestarNuvem,
  resumosemanal: commandResumoSemanal,
  testaraniversario: commandTestarAniversario,
  testarfotopresidente: commandTestarFotoPresidente,
  testarresultadoeleicao: commandTestarResultadoEleicao,
  otario: commandOtario,
  audios: commandAudios,
  salvaraudio: commandSalvarAudio,
  regras: commandRegras,
  regulamento: commandRegulamento,
  lembretes: commandLembretes,
  cancelar: commandCancelarLembrete,
  insultos: commandInsultos,
  memoria: commandMemoria,
  esquecer: commandEsquecer,
};
