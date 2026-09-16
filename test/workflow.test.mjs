import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindingSchema, renderInstructions, installSkill, repository, workflow } from '../scripts/workflow-lib.mjs';
import { createTaskInputSchema, claimTaskInputSchema, submitReportInputSchema, reviewReportInputSchema } from '../dist/src/exchange/schemas.js';

const example = JSON.parse(await readFile(join(repository, 'templates/project-binding.example.json'), 'utf8'));
test('binding rejects ambiguous project identities and unsafe source paths', () => {
  bindingSchema.parse(example);
  assert.equal(bindingSchema.safeParse({ ...example, secret: 'unexpected' }).success, false);
  assert.equal(bindingSchema.safeParse({ ...example, entryDocuments: ['../other/file'] }).success, false);
  assert.equal(bindingSchema.safeParse({ ...example, secondaryProjects: [{ projectId: example.projectId, entryDocuments: ['README.md'] }] }).success, false);
});
test('instructions render for unrelated products without leaking another binding', async () => {
  const first = await renderInstructions(example, 'planner');
  const second = await renderInstructions({ ...example, projectId: 'another-product', secondaryProjects: [] }, 'worker');
  assert.ok(first.includes(example.projectId));
  assert.ok(second.includes('another-product'));
  assert.ok(!second.includes(example.projectId));
  assert.ok(!second.includes('{{roleInstructions}}'));
  await assert.rejects(renderInstructions(example, 'admin'));
});
test('installation preserves local edits and leaves source skills self-contained', async () => {
  const target = await mkdtemp(join(tmpdir(), 'mcp-skills-'));
  try {
    for (const skill of workflow.skills) {
      const result = await installSkill(skill, { target });
      assert.equal(result.status, 'installed');
      assert.equal(await readFile(join(result.destination, 'SKILL.md'), 'utf8'), await readFile(join(repository, 'skills', skill, 'SKILL.md'), 'utf8'));
      await assert.rejects(installSkill(skill, { target }), /already exists/);
      assert.equal((await installSkill(skill, { target, update: true })).status, 'unchanged');
      await writeFile(join(result.destination, 'SKILL.md'), 'User modification');
      await assert.rejects(installSkill(skill, { target, update: true }), /Locally modified/);
      assert.equal(await readFile(join(result.destination, 'SKILL.md'), 'utf8'), 'User modification');
    }
    await assert.rejects(installSkill('../escape', { target }), /Unknown/);
  } finally { await rm(target, { recursive: true, force: true }); }
});
test('installer rejects directory links instead of writing through them', async () => {
  const target = await mkdtemp(join(tmpdir(), 'mcp-skill-links-'));
  const linked = `${target}-link`;
  try {
    try { await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') return; throw error; }
    await assert.rejects(installSkill(workflow.skills[0], { target: linked }), /Refusing link/);
  } finally { await rm(linked, { force: true }); await rm(target, { recursive: true, force: true }); }
});
test('managed update backs up the previous version and renderer refuses overwrite', async () => {
  const target = await mkdtemp(join(tmpdir(), 'mcp-workflow-update-'));
  try {
    const name = workflow.skills[0];
    const { destination } = await installSkill(name, { target });
    const manifestPath = join(destination, '.workflow-install.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const oldContent = 'Old managed version\n';
    await writeFile(join(destination, 'SKILL.md'), oldContent);
    manifest.hashes['SKILL.md'] = createHash('sha256').update(oldContent).digest('hex');
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal((await installSkill(name, { target, update: true })).status, 'updated');
    const backups = (await readdir(target)).filter(file => file.startsWith(`${name}.backup-`));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(target, backups[0], 'SKILL.md'), 'utf8'), oldContent);
    const bindingPath = join(target, 'binding.json'), output = join(target, 'instructions.md');
    await writeFile(bindingPath, JSON.stringify(example));
    const args = [join(repository, 'scripts/workflow.mjs'), 'render', '--binding', bindingPath, '--role', 'planner', '--output', output];
    assert.equal(spawnSync(process.execPath, args).status, 0);
    await writeFile(output, 'User instructions');
    assert.notEqual(spawnSync(process.execPath, args).status, 0);
    assert.equal(await readFile(output, 'utf8'), 'User instructions');
  } finally { await rm(target, { recursive: true, force: true }); }
});
test('workflow example requests remain valid against actual MCP schemas', async () => {
  const requests = JSON.parse(await readFile(join(repository, 'templates/exchange-requests.example.json'), 'utf8'));
  for (const [name, schema] of Object.entries({ create_task: createTaskInputSchema, claim_task: claimTaskInputSchema, submit_report: submitReportInputSchema, review_report: reviewReportInputSchema })) schema.parse(requests[name]);
  const pkg = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^1\.0\./);
});
