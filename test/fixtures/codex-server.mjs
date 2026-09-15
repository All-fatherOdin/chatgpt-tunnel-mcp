import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const report = { outcome: 'completed', summary: 'Protocol fixture', changes: [], checks: [], criterionResults: [{ criterionId: 'AC1', status: 'met', evidence: 'Fixture' }], limitations: [], questions: [] };
let cwd;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const p = message.params;
  let result;
  switch (message.method) {
    case 'initialize': result = { userAgent: 'fixture' }; break;
    case 'model/list': result = { data: [{ model: 'test-model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null }; break;
    case 'thread/start': cwd = p.cwd; result = { thread: { id: 'fixture-thread' }, cwd, model: p.model, reasoningEffort: 'medium' }; break;
    case 'turn/start':
      if (!p.outputSchema || p.model !== 'test-model' || !p.input[0].text.startsWith('Dispatcher run ')) throw new Error('Invalid protocol request');
      if (JSON.stringify(p.outputSchema).includes('(?!')) throw new Error('Structured Outputs cannot use lookaround');
      send({ method: 'item/completed', params: { threadId: p.threadId, turnId: 'fixture-turn', item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(report) } } });
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'fixture-turn', status: 'completed', items: [] } } });
      result = { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } }; break;
    default: send({ id: message.id, error: { code: -32601, message: 'unsupported' } }); continue;
  }
  send({ id: message.id, result });
}
