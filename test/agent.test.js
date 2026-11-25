import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Traces vao pra um arquivo temporario (nunca o real); precisa valer antes do import.
const TRACES = path.join(os.tmpdir(), `bothierry-agent-test-${process.pid}.jsonl`);
process.env.AGENT_TRACES_FILE = TRACES;
const { runAgent, getAgentOverview } = await import('../src/agent.js');

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (message, usage = { prompt_tokens: 1000, completion_tokens: 100 }) => ({ model: 'gpt-4o-mini-2024-07-18', usage, choices: [{ message }] });

// IA de mentira: devolve as respostas do roteiro, na ordem, e guarda o que recebeu.
function scripted(script) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        create: async (req) => {
          requests.push({ ...req, messages: [...req.messages] });
          const next = script[requests.length - 1];
          if (!next) throw new Error('roteiro acabou');
          return typeof next === 'function' ? next(req) : next;
        },
      },
    },
  };
}
const base = (client, over = {}) => ({ client, model: 'gpt-4o-mini', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'oi' }], tools: [{ type: 'function', function: { name: 'x' } }], callTool: async () => ({ ok: 1 }), meta: { asker: 'Teste', question: 'oi' }, ...over });

test('responde direto quando nao precisa de funcao (1 passo)', async () => {
  const client = scripted([reply({ role: 'assistant', content: 'e ai!' })]);
  const out = await runAgent(base(client));
  assert.equal(out.answer, 'e ai!');
  assert.equal(out.outcome, 'ok');
  assert.equal(out.steps, 1);
});

test('encadeia varias funcoes: o resultado de uma volta pra IA antes da proxima', async () => {
  const seen = [];
  const client = scripted([
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('a', 'cotacao', { ativo: 'dolar' })] }),
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('b', 'noticias', { assunto: 'geral' })] }),
    reply({ role: 'assistant', content: 'pronto' }),
  ]);
  const out = await runAgent(base(client, { callTool: async (name) => (seen.push(name), { de: name }) }));
  assert.deepEqual(seen, ['cotacao', 'noticias']);
  assert.equal(out.answer, 'pronto');
  assert.equal(out.steps, 3);
  const last = client.requests[2].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.deepEqual(last, ['{"de":"cotacao"}', '{"de":"noticias"}']);
});

test('varias funcoes no mesmo passo rodam em paralelo e cada uma responde ao seu id', async () => {
  const client = scripted([
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('a', 'cotacao', { ativo: 'dolar' }), toolCall('b', 'cotacao', { ativo: 'euro' })] }),
    reply({ role: 'assistant', content: 'ok' }),
  ]);
  await runAgent(base(client, { callTool: async (n, args) => ({ ativo: args.ativo }) }));
  const tools = client.requests[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((t) => t.tool_call_id), ['a', 'b']);
  assert.match(tools[1].content, /euro/);
});

test('limite de passos: depois dele a IA e obrigada a responder (sem funcoes)', async () => {
  const loop = () => reply({ role: 'assistant', content: null, tool_calls: [toolCall(String(Math.random()), 'cotacao', { ativo: String(Math.random()) })] });
  const client = scripted([loop, loop, loop, () => reply({ role: 'assistant', content: 'fechei com o que tinha' })]);
  const out = await runAgent(base(client, { limits: { maxSteps: 3 } }));
  assert.equal(out.outcome, 'max_steps');
  assert.equal(out.answer, 'fechei com o que tinha');
  assert.equal(client.requests[3].tools, undefined, 'ultimo passo nao oferece funcoes');
  assert.ok(client.requests[3].messages.some((m) => m.role === 'system' && /AGORA/.test(m.content)));
});

test('teto de custo por pergunta forca a resposta', async () => {
  const expensive = { prompt_tokens: 2_000_000, completion_tokens: 0 }; // ~US$ 0,30
  const client = scripted([
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('a', 'cotacao', { ativo: 'x' })] }, expensive),
    reply({ role: 'assistant', content: 'ja gastei, toma' }),
  ]);
  const out = await runAgent(base(client));
  assert.equal(out.outcome, 'cost_cap');
  assert.equal(client.requests[1].tools, undefined);
});

test('consulta repetida (mesma funcao e argumentos) reaproveita o resultado', async () => {
  let runs = 0;
  const client = scripted([
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('a', 'cotacao', { ativo: 'dolar' })] }),
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('b', 'cotacao', { ativo: 'dolar' })] }),
    reply({ role: 'assistant', content: 'fim' }),
  ]);
  await runAgent(base(client, { callTool: async () => (runs++, { v: 1 }) }));
  assert.equal(runs, 1);
});

test('funcao que quebra ou demora vira { erro } pra IA, sem derrubar o agente', async () => {
  const client = scripted([
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('a', 'cotacao', { ativo: 'x' }), toolCall('b', 'lenta', {})] }),
    reply({ role: 'assistant', content: 'nao consegui buscar' }),
  ]);
  const out = await runAgent(
    base(client, {
      limits: { toolTimeoutMs: 30 },
      callTool: async (name) => {
        if (name === 'lenta') await new Promise((r) => setTimeout(r, 300));
        throw new Error('fonte fora do ar');
      },
    }),
  );
  assert.equal(out.answer, 'nao consegui buscar');
  const msgs = client.requests[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(msgs[0], /fonte fora do ar/);
  assert.match(msgs[1], /demorou demais/);
});

test('resultado gigante de funcao e cortado', async () => {
  const client = scripted([reply({ role: 'assistant', content: null, tool_calls: [toolCall('a', 'x', {})] }), reply({ role: 'assistant', content: 'ok' })]);
  await runAgent(base(client, { callTool: async () => ({ lixo: 'a'.repeat(50_000) }) }));
  assert.ok(client.requests[1].messages.find((m) => m.role === 'tool').content.length < 12_100);
});

test('erro da IA (ex.: limite mensal) sobe pro chamador e o traco registra o motivo', async () => {
  const client = { chat: { completions: { create: async () => Object.assign(new Error('limite mensal'), { code: 'AI_BUDGET_EXCEEDED' }) } } };
  client.chat.completions.create = async () => {
    throw Object.assign(new Error('limite mensal'), { code: 'AI_BUDGET_EXCEEDED' });
  };
  await assert.rejects(runAgent(base(client)), /limite mensal/);
  const last = getAgentOverview().recent[0];
  assert.equal(last.outcome, 'budget');
});

test('painel: resumo agrega perguntas, passos, funcoes e desfechos', async () => {
  fs.rmSync(TRACES, { force: true });
  const client = scripted([
    reply({ role: 'assistant', content: null, tool_calls: [toolCall('a', 'cotacao', { ativo: 'dolar' })] }),
    reply({ role: 'assistant', content: 'a' }),
    reply({ role: 'assistant', content: 'b' }),
  ]);
  await runAgent(base(client));
  await runAgent(base(client));
  const o = getAgentOverview();
  assert.equal(o.questions, 2);
  assert.equal(o.avgSteps, 1.5);
  assert.deepEqual(o.tools, [{ name: 'cotacao', calls: 1, errors: 0 }]);
  assert.equal(o.outcomes.ok, 2);
  assert.equal(o.recent[0].asker, 'Teste');
  fs.rmSync(TRACES, { force: true });
});
