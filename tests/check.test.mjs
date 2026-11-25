import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BATCH_LIMIT,
  STICKY_MARKER,
  chunkArray,
  collectTargets,
  evaluateThresholds,
  formatMarkdownReport,
  parseDockerfile,
  parseGoMod,
  parsePackageJson,
  parsePyprojectToml,
  parseWorkflowYaml,
  queryAgenticPressBatch,
  run,
  scanModelIdentifiers,
  upsertStickyPrComment,
} from '../scripts/check.mjs';

test('parseDockerfile extracts runtime and OS versions accurately', () => {
  const dockerfile = [
    '# Build stage',
    'FROM --platform=linux/amd64 node:18-alpine AS builder',
    'FROM golang:1.21.4-bookworm AS gobuild',
    'FROM python:3.11-slim',
    'FROM ubuntu:20.04',
    'FROM scratch',
    'FROM myrepo/app:latest',
  ].join('\n');

  const hits = parseDockerfile(dockerfile).map((h) => h.target);
  assert.deepEqual(hits, ['node:18', 'go:1.21', 'python:3.11', 'ubuntu:20.04']);
});

test('parsePackageJson, parsePyprojectToml, and parseGoMod extract constraints', () => {
  assert.deepEqual(
    parsePackageJson(JSON.stringify({ engines: { node: '>=18.17.0 <21' } })).map((h) => h.target),
    ['node:18'],
  );
  assert.deepEqual(
    parsePyprojectToml('[project]\nrequires-python = ">=3.9"\n').map((h) => h.target),
    ['python:3.9'],
  );
  assert.deepEqual(
    parseGoMod('module example.com/app\n\ngo 1.21.5\n').map((h) => h.target),
    ['go:1.21'],
  );
});

test('parseWorkflowYaml extracts runners and tool setup versions, skipping expressions', () => {
  const yml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-20.04',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: [18, 20]',
    '      - uses: actions/setup-python@v5',
    '        with:',
    '          python-version: "3.10"',
    '      - uses: actions/setup-go@v5',
    '        with:',
    '          go-version: ${{ matrix.go }}',
  ].join('\n');

  const hits = parseWorkflowYaml(yml).map((h) => h.target);
  assert.deepEqual(hits, ['ubuntu:20.04', 'node:18', 'node:20', 'python:3.10']);
});

test('scanModelIdentifiers detects current and next-gen OpenAI, Anthropic, and Gemini model IDs', () => {
  const code = `
    const a = "gpt-4o";
    const b = "gpt-6-luna";
    const c = "gpt-6.1-sol";
    const d = 'claude-3-5-sonnet-20241022';
    const e = 'claude-sonnet-5-5';
    const f = 'claude-opus-4-8';
    const g = "gemini-2.0-flash";
    const h = "gemini-3.6-flash";
  `;
  const hits = scanModelIdentifiers(code).map((hit) => hit.target);
  assert.deepEqual(hits, [
    'gpt-4o',
    'gpt-6-luna',
    'gpt-6.1-sol',
    'claude-3-5-sonnet-20241022',
    'claude-sonnet-5-5',
    'claude-opus-4-8',
    'gemini-2.0-flash',
    'gemini-3.6-flash',
  ]);
});

test('collectTargets respects .gitignore and skips docs, lockfiles, issue templates, and tests', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-check-ignore-'));
  try {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored-dir/\n*.secret.ts\n');
    fs.mkdirSync(path.join(tmp, 'node_modules/pkg'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'ignored-dir'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.github/ISSUE_TEMPLATE'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });

    fs.writeFileSync(path.join(tmp, 'node_modules/pkg/index.js'), 'const m = "gpt-3.5-turbo";\n');
    fs.writeFileSync(path.join(tmp, 'ignored-dir/skip.ts'), 'const m = "claude-3-opus-20240229";\n');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'Example: gpt-3.5-turbo and claude-3-5-sonnet-20241022\n');
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'Old model: gemini-1.5-pro\n');
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"model":"gpt-3.5-turbo"}\n');
    fs.writeFileSync(path.join(tmp, '.github/ISSUE_TEMPLATE/stale.yml'), 'placeholder: "gpt-3.5-turbo"\n');
    fs.writeFileSync(path.join(tmp, 'tests/fixture.mjs'), 'const m = "claude-3-opus-20240229";\n');
    fs.writeFileSync(path.join(tmp, 'src/example.test.ts'), 'const m = "gemini-2.0-flash";\n');
    fs.writeFileSync(path.join(tmp, 'src/model.secret.ts'), 'const m = "gemini-1.5-pro";\n');
    fs.writeFileSync(path.join(tmp, 'src/app.ts'), 'const m = "gpt-4o";\n');

    const map = collectTargets(tmp, { scanModels: true });
    assert.deepEqual([...map.keys()], ['gpt-4o']);
    assert.deepEqual([...map.get('gpt-4o')], ['src/app.ts:1']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('queryAgenticPressBatch chunks requests at max 15 targets', async () => {
  const targets = Array.from({ length: 32 }, (_, i) => `model-${i + 1}`);
  const requestedChunks = [];
  const mockFetch = async (url) => {
    const parsed = new URL(url);
    const chunk = parsed.searchParams.get('targets').split(',');
    requestedChunks.push(chunk);
    return new Response(
      JSON.stringify({
        checked: chunk.length,
        results: chunk.map((target) => ({
          target,
          verdict: 'UNKNOWN',
          action: 'UNTRACKED',
          cutoff_date: null,
          days_remaining: null,
          replacement: null,
          entity_slug: null,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  assert.equal(BATCH_LIMIT, 15);
  assert.deepEqual(
    chunkArray(targets).map((c) => c.length),
    [15, 15, 2],
  );
  const results = await queryAgenticPressBatch(targets, { fetchImpl: mockFetch });
  assert.equal(requestedChunks.length, 3);
  assert.deepEqual(
    requestedChunks.map((c) => c.length),
    [15, 15, 2],
  );
  assert.equal(results.length, 32);
});

test('evaluateThresholds enforces sunset, deprecated, and none exit modes', () => {
  const onlyDeprecated = [
    { target: 'gpt-4o', verdict: 'DEPRECATED', action: 'MIGRATE_SOON' },
    { target: 'node:22', verdict: 'ACTIVE', action: 'SAFE_TO_USE' },
  ];
  const withSunset = [
    ...onlyDeprecated,
    { target: 'node:18', verdict: 'SUNSET', action: 'DO_NOT_USE' },
  ];

  assert.equal(evaluateThresholds(onlyDeprecated, 'sunset').shouldFail, false);
  assert.equal(evaluateThresholds(onlyDeprecated, 'deprecated').shouldFail, true);
  assert.equal(evaluateThresholds(withSunset, 'sunset').shouldFail, true);
  assert.equal(evaluateThresholds(withSunset, 'none').shouldFail, false);
  assert.throws(() => evaluateThresholds(withSunset, 'bogus'), /Invalid fail-on/);
});

test('upsertStickyPrComment creates new comment when absent and updates existing sticky comment', async () => {
  const calls = [];
  const body = formatMarkdownReport([], new Map(), evaluateThresholds([], 'none'));

  // 1. Create when none exist
  const createResult = await upsertStickyPrComment({
    repo: 'acme/demo',
    prNumber: 42,
    token: 'tok',
    body,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      if ((init.method || 'GET') === 'GET') {
        return new Response(JSON.stringify([{ id: 1, body: 'unrelated comment' }]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 99 }), { status: 201 });
    },
  });
  assert.deepEqual(createResult, { action: 'created', id: 99 });
  assert.equal(calls[1].method, 'POST');

  // 2. Update when sticky marker exists
  calls.length = 0;
  const updateResult = await upsertStickyPrComment({
    repo: 'acme/demo',
    prNumber: 42,
    token: 'tok',
    body,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      if ((init.method || 'GET') === 'GET') {
        return new Response(JSON.stringify([{ id: 77, body: `${STICKY_MARKER}\nold report` }]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    },
  });
  assert.deepEqual(updateResult, { action: 'updated', id: 77 });
  assert.equal(calls[1].method, 'PATCH');
  assert.match(calls[1].url, /\/issues\/comments\/77$/);

  // 3. Skip cleanly on HTTP 403 (e.g., fork PR read-only token)
  const forbiddenResult = await upsertStickyPrComment({
    repo: 'acme/demo',
    prNumber: 42,
    token: 'tok',
    body,
    fetchImpl: async () => new Response('Forbidden', { status: 403 }),
  });
  assert.deepEqual(forbiddenResult, { action: 'skipped', reason: 'forbidden' });
});

test('action.yml passes inputs only through env and never interpolates inputs inside run', () => {
  const actionYml = fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const runMatch = actionYml.match(/^\s*run:\s*(.+)$/m);
  assert.ok(runMatch, 'Expected run: line in action.yml');
  assert.doesNotMatch(runMatch[1], /\$\{\{\s*inputs\./);
  assert.match(runMatch[1], /\$\{\{\s*github\.action_path\s*\}\}\/scripts\/check\.mjs/);
});

test('formatMarkdownReport links entity slugs to singular /entity/ path', () => {
  const results = [
    {
      target: 'gpt-4o',
      verdict: 'DEPRECATED',
      action: 'MIGRATE_SOON',
      cutoff_date: '2027-01-14',
      days_remaining: 50,
      replacement: 'gpt-6-luna',
      entity_slug: 'openai-api-deprecations',
    },
  ];
  const md = formatMarkdownReport(
    results,
    new Map([['gpt-4o', new Set(['src/ai.ts:1'])]]),
    evaluateThresholds(results, 'sunset'),
  );
  assert.match(md, /https:\/\/agenticpress\.org\/entity\/openai-api-deprecations/);
  assert.equal(md.includes('/' + 'entities/'), false);
});

test('scanModelIdentifiers ignores compiler flags and bare o1/o3/o4 variables while catching real o-series models', () => {
  const sample = [
    'CFLAGS=-O3 -Wall',
    'const o1 = {}; const o3 = {}; const o4 = {};',
    '# Big O1 and O3 complexity; do not match "O3"',
    'const valid = ["o3", \'o1\', "o3-mini", "o4-mini", "o1-2024-12-17"];',
  ].join('\n');
  const hits = scanModelIdentifiers(sample).map((h) => h.target);
  assert.deepEqual(hits, ['o3-mini', 'o4-mini', 'o1-2024-12-17', 'o3', 'o1']);
});

test('run fails fast when working-directory does not exist', async () => {
  await assert.rejects(
    run({
      GITHUB_WORKSPACE: process.cwd(),
      INPUT_WORKING_DIRECTORY: 'nonexistent-dir-xyz',
    }),
    /Working directory does not exist/,
  );
});
