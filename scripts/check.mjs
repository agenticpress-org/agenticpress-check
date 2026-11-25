#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_API_BASE = 'https://agenticpress.org';
export const BATCH_LIMIT = 15;
export const STICKY_MARKER = '<!-- agenticpress-check-sticky -->';

const ALWAYS_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'coverage',
  '.turbo',
  '.cache',
]);

const MODEL_SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.yml',
  '.yaml',
  '.json',
  '.toml',
]);

const IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

const MODEL_ID_REGEX =
  /\b(?:gpt-(?:3\.5|[4-9](?:o|\.\d+)?)(?:-[a-z0-9.]+)*|o[134]-(?:mini|pro|preview|\d{4}-\d{2}-\d{2})(?:-[a-z0-9.]+)*|text-embedding-(?:ada-002|3-small|3-large)|claude-(?:3(?:\.\d+)?|[4-9](?:\.\d+)?|(?:sonnet|opus|haiku)-[4-9](?:[.-]\d+)*)(?:-[a-z0-9.]+)*|gemini-(?:1\.0|1\.5|[2-9](?:\.\d+)?)(?:-[a-z0-9.]+)*)\b/gi;

const QUOTED_BARE_O_MODEL_REGEX = /(?<=["'`])o[134](?=["'`])/g;

/**
 * Compile simple `.gitignore` rules into match predicates.
 */
export function parseGitignore(gitignoreText) {
  if (!gitignoreText) return [];
  const rules = [];
  for (const rawLine of gitignoreText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    const clean = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) continue;
    const regexStr = clean
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    const regex = clean.includes('/')
      ? new RegExp(`^${regexStr}(?:/.*)?$`)
      : new RegExp(`(?:^|/)${regexStr}(?:/.*)?$`);
    rules.push({ dirOnly, regex });
  }
  return rules;
}

export function isIgnored(relPath, isDir, rules) {
  const normalized = relPath.split(path.sep).join('/');
  const base = path.posix.basename(normalized);
  if (isDir && ALWAYS_IGNORED_DIRS.has(base)) return true;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir && !normalized.includes('/')) continue;
    if (rule.regex.test(normalized)) return true;
  }
  return false;
}

/**
 * Walk a directory respecting built-in ignores and root `.gitignore`.
 */
export function walkRepoFiles(rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const rules = fs.existsSync(gitignorePath)
    ? parseGitignore(fs.readFileSync(gitignorePath, 'utf8'))
    : [];

  const files = [];
  function visit(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        if (!isIgnored(relPath, true, rules)) visit(fullPath);
      } else if (entry.isFile()) {
        if (!isIgnored(relPath, false, rules)) files.push({ fullPath, relPath });
      }
    }
  }
  visit(rootDir);
  return files;
}

function normalizeImageTarget(rawImage) {
  const cleaned = rawImage.trim().replace(/['"]/g, '');
  if (!cleaned || cleaned.startsWith('$') || cleaned === 'scratch') return null;
  const withoutDigest = cleaned.split('@')[0];
  const lastColon = withoutDigest.lastIndexOf(':');
  if (lastColon === -1) return null;

  const repoPart = withoutDigest.slice(0, lastColon).split('/').pop().toLowerCase();
  const tagPart = withoutDigest.slice(lastColon + 1).toLowerCase();
  if (!tagPart || tagPart === 'latest') return null;

  const versionMatch = tagPart.match(/^(\d+(?:\.\d+)?)/);
  if (!versionMatch) return null;
  const ver = versionMatch[1];

  if (repoPart === 'node') return `node:${ver.split('.')[0]}`;
  if (repoPart === 'python') return `python:${ver}`;
  if (repoPart === 'golang' || repoPart === 'go') return `go:${ver}`;
  if (repoPart === 'alpine') return `alpine:${ver}`;
  if (repoPart === 'ubuntu') return `ubuntu:${ver}`;
  if (repoPart === 'postgres' || repoPart === 'postgresql') return `postgresql:${ver.split('.')[0]}`;
  return null;
}

function normalizeSemverConstraint(runtime, raw) {
  if (!raw || typeof raw !== 'string') return [];
  const matches = [...raw.matchAll(/(\^|~|>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+)?)(?:\.\d+)?/g)];
  const targets = new Set();
  for (const m of matches) {
    const op = m[1] || '';
    if (op === '<' || op === '<=') continue;
    const ver = m[2];
    if (runtime === 'node') targets.add(`node:${ver.split('.')[0]}`);
    else targets.add(`${runtime}:${ver}`);
  }
  return [...targets];
}

export function parseDockerfile(content) {
  const targets = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const stripped = line.replace(/#.*$/, '').trim();
    const match = stripped.match(/^FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?$/i);
    if (!match) return;
    const normalized = normalizeImageTarget(match[1]);
    if (normalized) targets.push({ target: normalized, line: idx + 1 });
  });
  return targets;
}

export function parsePackageJson(content) {
  const targets = [];
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch {
    return targets;
  }
  const nodeEngine = pkg?.engines?.node;
  if (typeof nodeEngine === 'string') {
    for (const target of normalizeSemverConstraint('node', nodeEngine)) {
      targets.push({ target, line: 1 });
    }
  }
  return targets;
}

export function parsePyprojectToml(content) {
  const targets = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const match = line.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/i);
    if (!match) return;
    for (const target of normalizeSemverConstraint('python', match[1])) {
      targets.push({ target, line: idx + 1 });
    }
  });
  return targets;
}

export function parseGoMod(content) {
  const targets = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const match = line.match(/^\s*go\s+(\d+\.\d+)(?:\.\d+)?\b/);
    if (match) {
      targets.push({ target: `go:${match[1]}`, line: idx + 1 });
    }
  });
  return targets;
}

export function parseWorkflowYaml(content) {
  const targets = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const ubuntuMatch = line.match(/\bruns-on:\s*["']?(ubuntu-\d+\.\d+)["']?/i);
    if (ubuntuMatch) {
      targets.push({ target: ubuntuMatch[1].replace('ubuntu-', 'ubuntu:').toLowerCase(), line: lineNum });
    }

    const runtimeChecks = [
      ['node', /\bnode-version:\s*(.+)$/i],
      ['python', /\bpython-version:\s*(.+)$/i],
      ['go', /\bgo-version:\s*(.+)$/i],
    ];
    for (const [runtime, regex] of runtimeChecks) {
      const m = line.match(regex);
      if (!m) continue;
      const value = m[1].replace(/#.*$/, '').trim();
      if (value.includes('${{')) continue;
      for (const target of normalizeSemverConstraint(runtime, value)) {
        targets.push({ target, line: lineNum });
      }
    }
  });
  return targets;
}

export function scanModelIdentifiers(content) {
  const targets = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const regex of [MODEL_ID_REGEX, QUOTED_BARE_O_MODEL_REGEX]) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(line)) !== null) {
        targets.push({ target: m[0].toLowerCase(), line: idx + 1 });
      }
    }
  });
  return targets;
}

export function shouldSkipModelScan(posixRel) {
  if (posixRel.startsWith('.github/ISSUE_TEMPLATE/')) return true;
  if (/(?:^|\/)(?:__tests__|tests?|spec|fixtures)(?:\/|$)/i.test(posixRel)) return true;
  if (/\.(?:test|spec)\.[^/]+$/i.test(posixRel)) return true;
  return false;
}

/**
 * Collect deduplicated targets and their file:line locations from a directory.
 */
export function collectTargets(rootDir, { scanModels = true } = {}) {
  const files = walkRepoFiles(rootDir);
  const targetLocations = new Map();

  function record(target, relPath, line) {
    if (!target || target.length < 2 || target.length > 120) return;
    if (!targetLocations.has(target)) targetLocations.set(target, new Set());
    targetLocations.get(target).add(`${relPath}:${line}`);
  }

  for (const { fullPath, relPath } of files) {
    const posixRel = relPath.split(path.sep).join('/');
    const base = path.posix.basename(posixRel);
    if (IGNORED_FILES.has(base)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.size > 512 * 1024) continue; // skip large generated/minified blobs
    const content = fs.readFileSync(fullPath, 'utf8');
    const ext = path.posix.extname(base).toLowerCase();

    if (base === 'Dockerfile' || base.startsWith('Dockerfile.') || base.endsWith('.dockerfile')) {
      for (const hit of parseDockerfile(content)) record(hit.target, posixRel, hit.line);
    } else if (base === 'package.json') {
      for (const hit of parsePackageJson(content)) record(hit.target, posixRel, hit.line);
    } else if (base === 'pyproject.toml') {
      for (const hit of parsePyprojectToml(content)) record(hit.target, posixRel, hit.line);
    } else if (base === 'go.mod') {
      for (const hit of parseGoMod(content)) record(hit.target, posixRel, hit.line);
    } else if (/^\.github\/workflows\/.+\.ya?ml$/i.test(posixRel)) {
      for (const hit of parseWorkflowYaml(content)) record(hit.target, posixRel, hit.line);
    }

    if (scanModels && MODEL_SCAN_EXTENSIONS.has(ext) && !shouldSkipModelScan(posixRel)) {
      for (const hit of scanModelIdentifiers(content)) record(hit.target, posixRel, hit.line);
    }
  }

  return targetLocations;
}

export function chunkArray(items, chunkSize = BATCH_LIMIT) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function queryAgenticPressBatch(targets, { apiBase = DEFAULT_API_BASE, fetchImpl = fetch } = {}) {
  if (!targets.length) return [];
  const allResults = [];
  for (const chunk of chunkArray(targets, BATCH_LIMIT)) {
    const url = `${apiBase.replace(/\/+$/, '')}/api/check?targets=${encodeURIComponent(chunk.join(','))}`;
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'agenticpress-check/1.0 (+https://github.com/agenticpress-org/agenticpress-check)',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`AgenticPress API returned HTTP ${res.status} for ${url}`);
    }
    const data = await res.json();
    if (Array.isArray(data?.results)) {
      allResults.push(...data.results);
    }
  }
  return allResults;
}

export function evaluateThresholds(results, failOn = 'sunset') {
  let sunsetCount = 0;
  let migrateSoonCount = 0;
  let safeCount = 0;
  let untrackedCount = 0;

  for (const r of results) {
    if (r.action === 'DO_NOT_USE' || r.verdict === 'SUNSET') {
      sunsetCount++;
    } else if (r.action === 'MIGRATE_SOON' || r.verdict === 'DEPRECATED') {
      migrateSoonCount++;
    } else if (r.action === 'UNTRACKED' || r.verdict === 'UNKNOWN') {
      untrackedCount++;
    } else {
      safeCount++;
    }
  }

  const findingsCount = sunsetCount + migrateSoonCount;
  let shouldFail = false;
  if (failOn === 'sunset') {
    shouldFail = sunsetCount > 0;
  } else if (failOn === 'deprecated') {
    shouldFail = findingsCount > 0;
  } else if (failOn === 'none') {
    shouldFail = false;
  } else {
    throw new Error(`Invalid fail-on value "${failOn}". Expected "sunset", "deprecated", or "none".`);
  }

  return {
    checkedCount: results.length,
    sunsetCount,
    migrateSoonCount,
    safeCount,
    untrackedCount,
    findingsCount,
    shouldFail,
  };
}

function escapeCell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

export function formatMarkdownReport(results, targetLocations, stats) {
  const lines = [
    STICKY_MARKER,
    '## AgenticPress Breakage Check',
    '',
    `Checked **${stats.checkedCount}** unique target(s): **${stats.sunsetCount}** sunset/do-not-use, **${stats.migrateSoonCount}** deprecated/migrate-soon, **${stats.safeCount}** safe/tracked, **${stats.untrackedCount}** untracked.`,
    '',
  ];

  if (results.length === 0) {
    lines.push('No runtime, workflow, or AI model targets were found in the scanned directory.');
    return lines.join('\n');
  }

  lines.push('| Target | Action | Verdict | Cutoff | Replacement | Locations |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const r of results) {
    const locs = [...(targetLocations.get(r.target) ?? [])].slice(0, 3).map((l) => `\`${l}\``).join(', ');
    const cutoff = r.cutoff_date
      ? `${r.cutoff_date}${typeof r.days_remaining === 'number' ? ` (${r.days_remaining}d)` : ''}`
      : '—';
    const replacement = r.replacement ? `\`${escapeCell(r.replacement)}\`` : '—';
    const targetCell = r.entity_slug
      ? `[\`${escapeCell(r.target)}\`](https://agenticpress.org/entity/${encodeURIComponent(r.entity_slug)})`
      : `\`${escapeCell(r.target)}\``;
    lines.push(
      `| ${targetCell} | \`${escapeCell(r.action)}\` | ${escapeCell(r.verdict)} | ${escapeCell(cutoff)} | ${replacement} | ${locs || '—'} |`,
    );
  }

  lines.push('');
  lines.push('Powered by [AgenticPress](https://agenticpress.org) (`org.agenticpress/mcp`).');
  return lines.join('\n');
}

export async function upsertStickyPrComment({
  repo,
  prNumber,
  token,
  body,
  fetchImpl = fetch,
}) {
  if (!repo || !prNumber || !token) return { action: 'skipped' };
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agenticpress-check/1.0',
  };
  const warnForbidden = () =>
    console.warn(
      '::warning::Skipping PR comment (HTTP 403 — ensure workflow grants permissions: pull-requests: write).',
    );
  const baseUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const listRes = await fetchImpl(`${baseUrl}?per_page=100`, { headers });
  if (listRes.status === 403) {
    warnForbidden();
    return { action: 'skipped', reason: 'forbidden' };
  }
  if (!listRes.ok) {
    throw new Error(`Failed to list PR comments: HTTP ${listRes.status}`);
  }
  const comments = await listRes.json();
  const existing = Array.isArray(comments)
    ? comments.find((c) => typeof c.body === 'string' && c.body.includes(STICKY_MARKER))
    : null;

  if (existing) {
    const patchRes = await fetchImpl(`https://api.github.com/repos/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (patchRes.status === 403) {
      warnForbidden();
      return { action: 'skipped', reason: 'forbidden' };
    }
    if (!patchRes.ok) {
      throw new Error(`Failed to update PR comment ${existing.id}: HTTP ${patchRes.status}`);
    }
    return { action: 'updated', id: existing.id };
  }

  const createRes = await fetchImpl(baseUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (createRes.status === 403) {
    warnForbidden();
    return { action: 'skipped', reason: 'forbidden' };
  }
  if (!createRes.ok) {
    throw new Error(`Failed to create PR comment: HTTP ${createRes.status}`);
  }
  const created = await createRes.json();
  return { action: 'created', id: created.id };
}

function getPrNumberFromEvent(eventPath) {
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    const evt = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    return evt?.pull_request?.number ?? evt?.issue?.number ?? null;
  } catch {
    return null;
  }
}

export async function run(env = process.env, { fetchImpl = fetch } = {}) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const workingDir = env.INPUT_WORKING_DIRECTORY || '.';
  const scanRoot = path.resolve(workspace, workingDir);
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    throw new Error(`Working directory does not exist: ${workingDir}`);
  }
  const failOn = (env.INPUT_FAIL_ON || 'sunset').trim().toLowerCase();
  const scanModels = (env.INPUT_SCAN_MODELS || 'true').trim().toLowerCase() !== 'false';
  const commentOnPr = (env.INPUT_COMMENT_ON_PR || 'false').trim().toLowerCase() === 'true';
  const apiBase = env.AGENTICPRESS_API_BASE || DEFAULT_API_BASE;

  const targetLocations = collectTargets(scanRoot, { scanModels });
  const uniqueTargets = [...targetLocations.keys()].sort();
  const results = await queryAgenticPressBatch(uniqueTargets, { apiBase, fetchImpl });
  const stats = evaluateThresholds(results, failOn);
  const markdown = formatMarkdownReport(results, targetLocations, stats);

  console.log(markdown);

  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  if (env.GITHUB_OUTPUT) {
    const outputLines = [
      `checked_count=${stats.checkedCount}`,
      `sunset_count=${stats.sunsetCount}`,
      `migrate_soon_count=${stats.migrateSoonCount}`,
      `findings_count=${stats.findingsCount}`,
    ].join('\n');
    fs.appendFileSync(env.GITHUB_OUTPUT, `${outputLines}\n`);
  }

  if (commentOnPr && env.GITHUB_TOKEN && env.GITHUB_REPOSITORY) {
    const prNumber = getPrNumberFromEvent(env.GITHUB_EVENT_PATH);
    if (prNumber) {
      await upsertStickyPrComment({
        repo: env.GITHUB_REPOSITORY,
        prNumber,
        token: env.GITHUB_TOKEN,
        body: markdown,
        fetchImpl,
      });
    }
  }

  return { stats, markdown, results };
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (isDirectExecution) {
  run()
    .then(({ stats }) => {
      if (stats.shouldFail) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(`agenticpress-check failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
