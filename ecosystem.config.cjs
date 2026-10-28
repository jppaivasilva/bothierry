module.exports = {
  apps: [
    {
      name: 'Bothierry',
      script: './src/index.js',
      // Carrega as variaveis do .env nativamente (suporte embutido do Node
      // desde a v20.6) — sem isso nada em .env chega em process.env, ja que
      // o projeto nao usa o pacote dotenv.
      // (--max-old-space-size foi testado aqui e removido: a memoria desse
      // processo e majoritariamente nativa — buffers de criptografia/imagem
      // do Baileys — nao heap do V8, entao limitar o heap nao reduzia o RSS
      // real, so gastava CPU a mais em GC sem beneficio.)
      node_args: '--env-file=.env',
      // Reinicia sozinho se a memoria RSS passar desse teto — rede de
      // seguranca contra vazamento de memoria de verdade (nao contra o pico
      // normal logo apos conectar, que sincroniza avatares/nome do grupo e
      // passa dos 600MB por uns segundos — por isso o teto fica bem acima
      // disso, senao vira um loop de reinicio bem na hora mais sensivel).
      max_memory_restart: '750M',
      // Prefixa cada linha de log (out e error) com data/hora — sem isso, os
      // logs do PM2 nao tem timestamp nenhum, dificultando descobrir quando
      // algo aconteceu (ex: um crash bem na hora de uma mensagem agendada).
      time: true,
      // Fuso usado no timestamp dos logs, pra bater com o fuso que o bot usa
      // internamente (America/Sao_Paulo).
      env: {
        TZ: 'America/Sao_Paulo',
      },
    },
  ],
};
