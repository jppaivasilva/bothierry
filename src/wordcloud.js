// Contagem de palavras do dia pra nuvem de palavras do painel. Ignora links,
// mencoes, mensagens de comando (!ranking...), palavras muito comuns
// ("de", "que", "pra"...), risadas ("kkkk", "rsrs") e palavras de 1-2 letras.
import { extractUrls } from './db.js';

// Comparadas sem acento e em minusculas.
const STOPWORDS = new Set(`
a o as os um uma uns umas de da do das dos em na no nas nos por pra para pro pras pros com sem sob sobre entre ate desde
e ou mas nem que se porque pq porem pois como quando onde qual quais quem quanto quantos
eu tu ele ela nos vos eles elas me te lhe lhes meu minha meus minhas teu tua teus tuas seu sua seus suas nosso nossa nossos nossas
este esta estes estas esse essa esses essas aquele aquela aqueles aquelas isto isso aquilo aqui ai ali la ca
ser sou es eh somos sao era eram foi foram fui sera seria seja sejam sendo sido
estar estou esta estamos estao estava estavam estive esteve estar estao
ter tenho tem temos tinha tinham tive teve tera teria tendo tido
haver ha havia houve
ir vou vai vamos vao ia iam fui foi fomos foram
fazer faz fazendo fez fiz feito
poder posso pode podem podia pode podemos
ver vejo viu vi
dar da dou deu dei
ficar fica ficou ficam
nao sim ja so tb tbm tambem ainda mais menos muito muita muitos muitas pouco pouca bem mal tao tanto tanta
entao assim depois antes agora hoje ontem amanha sempre nunca talvez la ca
todo toda todos todas tudo nada algo alguem ninguem outro outra outros outras mesmo mesma cada qualquer
vc vcs voce voces cara mano velho tipo ne neh pq pqp oi ola opa eai blz beleza tmj vlw valeu
coisa coisas gente vez vezes dia dias so
kkk kkkk rsrs haha hahaha
`.split(/\s+/).filter(Boolean));

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Risada ("kkkk", "rsrsrs", "hahaha", "ahahah") ou letra repetida ("aaaa", "sssss").
const LAUGH = /^(k{2,}|(?:rs){2,}r?s?|(?:ha){2,}h?|(?:he){2,}h?|(?:hu){2,}|(?:ah)+h?|(?:eh)+h?)$/;
const REPEATED = /^(.)\1{2,}$/;

/** Conta as palavras de uma lista de textos. Retorna { totalMessages, distinctWords, words: [{ word, count }] }. */
export function buildWordCloud(texts, limit = 70) {
  const counts = new Map();
  let totalMessages = 0;
  for (const raw of texts) {
    const trimmed = raw.trim();
    if (!trimmed || /^[!/]/.test(trimmed)) continue; // comando do bot
    totalMessages += 1;
    let text = trimmed;
    for (const url of extractUrls(text)) text = text.replace(url, ' ');
    text = text.replace(/@\d+/g, ' ');
    for (const match of text.toLowerCase().matchAll(/\p{L}+(?:-\p{L}+)*/gu)) {
      const word = match[0];
      const key = strip(word);
      if (key.length < 3 || STOPWORDS.has(key) || LAUGH.test(key) || REPEATED.test(key)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const words = [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'pt-BR'));
  return { totalMessages, distinctWords: words.length, words: words.slice(0, limit) };
}
