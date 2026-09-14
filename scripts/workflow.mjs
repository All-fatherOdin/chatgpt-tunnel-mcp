import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { bindingSchema, renderInstructions, installSkill } from './workflow-lib.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    binding: { type: 'string' }, role: { type: 'string' }, output: { type: 'string' },
    skill: { type: 'string' }, target: { type: 'string' }, update: { type: 'boolean', default: false }
  } });
  if (positionals.length !== 1) throw Error('Expected one command: validate, render or install');
  const command = positionals[0];
  if (command === 'install') {
    console.log(JSON.stringify(await installSkill(values.skill, { target: values.target, update: values.update })));
  } else if (command === 'validate' || command === 'render') {
    if (!values.binding) throw Error('--binding is required');
    const binding = bindingSchema.parse(JSON.parse((await readFile(values.binding, 'utf8')).replace(/^\uFEFF/, '')));
    if (command === 'validate') console.log('Binding valid. MCP configuration and access were not changed.');
    else {
      if (!values.output || !values.role) throw Error('--output and --role are required');
      await writeFile(values.output, await renderInstructions(binding, values.role), { flag: 'wx' });
      console.log(`Instructions written: ${values.output}`);
    }
  } else throw Error('Unknown command. Use validate, render or install.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
