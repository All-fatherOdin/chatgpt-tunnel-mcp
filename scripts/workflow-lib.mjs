import { readFile, writeFile, mkdir, lstat, copyFile } from 'node:fs/promises';
import { resolve, join, dirname, parse, isAbsolute, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const workflow = JSON.parse(await readFile(join(repository, 'workflow.json'), 'utf8'));
const relative = z.string().min(1).refine(value => !/^[\\/]|[:\0]/.test(value) && !value.split(/[\\/]/).includes('..'), 'Expected safe relative document path');
const projectId = z.string().min(1).max(100);
export const bindingSchema = z.object({
  schemaVersion: z.literal(1), projectId,
  workingDirectory: z.string().min(1).refine(value => isAbsolute(value) || win32.isAbsolute(value), 'Expected absolute working directory'),
  plannerConnection: z.string().min(1), workerConnection: z.string().min(1),
  entryDocuments: z.array(relative).min(1),
  secondaryProjects: z.array(z.object({ projectId, entryDocuments: z.array(relative).min(1) }).strict()),
  productRules: z.string().min(1)
}).strict().superRefine((binding, ctx) => {
  const ids = [binding.projectId, ...binding.secondaryProjects.map(item => item.projectId)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Project IDs must be distinct' });
});

export async function renderInstructions(input, role) {
  const binding = bindingSchema.parse(input);
  if (!['planner', 'worker'].includes(role)) throw Error('Role must be planner or worker');
  const roleInstructions = await readFile(join(repository, 'instructions', role === 'planner' ? 'chatgpt-planner.md' : 'codex-worker.md'), 'utf8');
  const template = await readFile(join(repository, 'templates/chatgpt-project-instructions.md'), 'utf8');
  const values = {
    projectId: binding.projectId, roleInstructions,
    binding: '```json\n' + JSON.stringify(binding, null, 2) + '\n```',
    workflowVersion: workflow.version, serverCompatibility: workflow.serverCompatibility
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw Error(`Unknown template token: ${key}`);
    return values[key];
  });
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function rejectLinks(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = await exists(current);
    if (info?.isSymbolicLink()) throw Error(`Refusing link in installation path: ${current}`);
  }
}
const digest = data => createHash('sha256').update(data).digest('hex');
const files = ['SKILL.md', 'agents/openai.yaml'];
export async function installSkill(name, { target = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills'), update = false } = {}) {
  if (!workflow.skills.includes(name)) throw Error('Unknown workflow skill');
  const destination = resolve(target, name);
  await rejectLinks(destination);
  const content = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(repository, 'skills', name, file))])));
  const hashes = Object.fromEntries(files.map(file => [file, digest(content[file])]));
  const existing = await exists(destination);
  if (existing) {
    if (!update) throw Error('Skill already exists; use --update after reviewing the source changes');
    if (!existing.isDirectory()) throw Error('Installation target is not a directory');
    const manifestPath = join(destination, '.workflow-install.json');
    await rejectLinks(manifestPath);
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (previous.package !== 'chatgpt-tunnel-mcp-workflow' || previous.skill !== name || Object.keys(previous.hashes || {}).sort().join('|') !== [...files].sort().join('|')) throw Error('Unrecognized installation; refusing to overwrite');
    for (const file of files) {
      await rejectLinks(join(destination, file));
      if (digest(await readFile(join(destination, file))) !== previous.hashes[file]) throw Error(`Locally modified skill file: ${file}`);
    }
    if (files.every(file => hashes[file] === previous.hashes[file])) return { destination, status: 'unchanged' };
    const backup = `${destination}.backup-${Date.now()}`;
    await mkdir(join(backup, 'agents'), { recursive: true });
    for (const file of [...files, '.workflow-install.json']) await copyFile(join(destination, file), join(backup, file));
  }
  await mkdir(join(destination, 'agents'), { recursive: true });
  await rejectLinks(join(destination, 'agents'));
  for (const file of files) await writeFile(join(destination, file), content[file]);
  await writeFile(join(destination, '.workflow-install.json'), JSON.stringify({ package: 'chatgpt-tunnel-mcp-workflow', skill: name, version: workflow.version, hashes }, null, 2) + '\n');
  return { destination, status: existing ? 'updated' : 'installed' };
}
