#!/usr/bin/env node
// Diffs the fidorial-api subproject between two refs of the Fidorial repo.
//
//   node scripts/api-diff.mjs <from> <to> [options]
//   node scripts/api-diff.mjs dev/26.3 dev/26.4
//
// Options:
//   --repo <url|path>   repository to clone (default: $FIDORIAL_REPO or GitHub)
//   --path <dir>        subproject to diff (default: fidorial-api)
//   --out <dir>         output folder (default: api-diff/<from>..<to>)
//   --offline           reuse the cached clone without fetching
//
// Writes, in the output folder:
//   SUMMARY.md     commits, changed files grouped by status, how to read the rest
//   surface.diff   diff of the public declarations only (no bodies, comments or private members)
//   full.diff      the complete git diff of the subproject
//   files.tsv      git name-status output (A/M/D/Rxx, old path, new path)
//
// The clone is bare and blobless, cached in .cache/fidorial.git: only the blobs that are
// actually diffed get downloaded.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'https://github.com/Fidorial/Fidorial.git';

// ---------------------------------------------------------------------------------------- args

function parseArgs(argv) {
    const options = { repo: process.env.FIDORIAL_REPO ?? DEFAULT_REPO, path: 'fidorial-api', out: null, offline: false };
    const refs = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--repo': options.repo = argv[++i]; break;
            case '--path': options.path = argv[++i].replace(/\/+$/, ''); break;
            case '--out': options.out = argv[++i]; break;
            case '--offline': options.offline = true; break;
            case '-h':
            case '--help': usage(0); break;
            default:
                if (arg.startsWith('--')) {
                    console.error(`Unknown option: ${arg}`);
                    usage(1);
                }
                refs.push(arg);
        }
    }
    if (refs.length !== 2) {
        usage(1);
    }
    [options.from, options.to] = refs;
    return options;
}

function usage(code) {
    console.error('Usage: generateApiDiff <from-ref> <to-ref> [--repo <url|path>] [--path fidorial-api] [--out <dir>] [--offline]');
    console.error('Example: generateApiDiff dev/26.3 dev/26.4');
    process.exit(code);
}

// ----------------------------------------------------------------------------------------- git

function git(gitDir, args, { allowFail = false } = {}) {
    try {
        return execFileSync('git', ['--git-dir', gitDir, ...args], {
            encoding: 'utf8',
            maxBuffer: 1 << 30,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        if (allowFail) {
            return null;
        }
        throw new Error(`git ${args.join(' ')} failed:\n${error.stderr || error.message}`);
    }
}

function prepareClone(options) {
    const gitDir = join(ROOT, '.cache', 'fidorial.git');
    const existing = existsSync(gitDir) ? git(gitDir, ['config', '--get', 'remote.origin.url'], { allowFail: true })?.trim() : null;
    if (existing !== null && existing !== undefined && existing !== options.repo) {
        console.error(`Cached clone points to ${existing}, recloning from ${options.repo}`);
        rmSync(gitDir, { recursive: true, force: true });
    }
    if (!existsSync(gitDir)) {
        console.error(`Cloning ${options.repo} (bare, blobless)…`);
        mkdirSync(dirname(gitDir), { recursive: true });
        execFileSync('git', ['clone', '--quiet', '--bare', '--filter=blob:none', options.repo, gitDir], { stdio: 'inherit' });
    } else if (!options.offline) {
        console.error('Fetching…');
        git(gitDir, ['fetch', '--quiet', '--prune', '--tags', 'origin', '+refs/heads/*:refs/heads/*']);
    }
    return gitDir;
}

function resolveRef(gitDir, ref) {
    for (const candidate of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`]) {
        const sha = git(gitDir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { allowFail: true });
        if (sha) {
            return sha.trim();
        }
    }
    const branches = git(gitDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim();
    throw new Error(`Unknown ref "${ref}". Branches:\n${branches}`);
}

// ------------------------------------------------------------------------- public API surface

const TYPE_KEYWORD = /(?:^|[\s@])(class|interface|enum|record|@interface)\s+[A-Za-z_$]/;
const MODIFIER = /\b(public|protected|private)\b/;

const HIDDEN = { '{': '\uE000', '}': '\uE001', ';': '\uE002', '=': '\uE003' };
const UNHIDE = Object.fromEntries(Object.entries(HIDDEN).map(([k, v]) => [v, k]));

/** Index of the first `=` outside parentheses (so annotation arguments do not count), or -1. */
function initializerIndex(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '=' && depth === 0 && text[i + 1] !== '=') return i;
    }
    return -1;
}

/** Drops a field initializer, keeping the declaration. */
function withoutInitializer(text) {
    const index = initializerIndex(text);
    return index === -1 ? text : text.slice(0, index).trim();
}

/** Removes comments and replaces string and char literal contents, keeping everything else. */
function stripComments(source) {
    let out = '';
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (c === '/' && next === '/') {
            while (i < source.length && source[i] !== '\n') i++;
        } else if (c === '/' && next === '*') {
            i = source.indexOf('*/', i + 2);
            i = i === -1 ? source.length : i + 2;
            out += ' ';
        } else if (source.startsWith('"""', i)) {
            const end = source.indexOf('"""', i + 3);
            out += '""';
            i = end === -1 ? source.length : end + 3;
        } else if (c === '"' || c === '\'') {
            let j = i + 1;
            while (j < source.length && source[j] !== c) {
                j += source[j] === '\\' ? 2 : 1;
            }
            // Keep string constants readable (they are often keys or ids), but hide the characters
            // the declaration scanner reacts to. They are restored when a line is emitted.
            out += source.slice(i, j + 1).replace(/[{};=]/g, ch => HIDDEN[ch]);
            i = j + 1;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/**
 * Reduces a Java source file to its visible declarations: types, fields and method signatures,
 * one per line, indented by nesting. Bodies, initializers, comments and private or
 * package-private members are dropped. Members of interfaces and annotations count as public.
 */
function apiSurface(source, path) {
    const code = stripComments(source);
    if (path.endsWith('module-info.java')) {
        return code.split('\n').map(line => line.trim()).filter(Boolean).join('\n') + '\n';
    }

    const lines = [];
    // Each scope: { kind: 'class'|'interface'|'enum'|'record'|'annotation', visible, enumConstants }
    const scopes = [];
    let header = '';
    let parens = 0;

    const normalize = text => text
        .replace(/\s+/g, ' ')
        .replace(/@Override\b/g, '')
        .replace(/@Contract\s*(\([^)]*\))?/g, '')
        .replace(/\(([^()]*)\)/g, (_, params) => `(${params.replace(/\bfinal\s+/g, '')})`)
        .replace(/\s*<\s*/g, '<')
        .replace(/\s+>/g, '>')
        .replace(/\s*\(\s*/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s*\[\s*/g, '[')
        .replace(/\s+\]/g, ']')
        .replace(/\s*,\s*/g, ', ')
        .trim();
    const indent = () => '    '.repeat(scopes.length);
    const current = () => scopes[scopes.length - 1];
    const visibleHere = text => {
        const scope = current();
        if (scope === undefined) {
            return /\bpublic\b|\bprotected\b/.test(text);
        }
        if (!scope.visible) {
            return false;
        }
        if (/\bprivate\b/.test(text)) {
            return false;
        }
        if (scope.kind === 'interface' || scope.kind === 'annotation') {
            return true;
        }
        return MODIFIER.test(text);
    };

    const skipBlock = from => {
        let depth = 0;
        for (let k = from; k < code.length; k++) {
            if (code[k] === '{') depth++;
            else if (code[k] === '}' && --depth === 0) return k;
        }
        return code.length;
    };

    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === '(') parens++;
        if (c === ')') parens--;

        if (c === '{' && parens === 0) {
            const text = normalize(header);
            header = '';
            const type = TYPE_KEYWORD.exec(text);
            if (type !== null && initializerIndex(text) === -1) {
                const kind = type[1] === '@interface' ? 'annotation' : type[1];
                const visible = visibleHere(text);
                if (visible && !/^(package|import)\b/.test(text)) {
                    lines.push(`${indent()}${text} {`);
                }
                scopes.push({ kind, visible, enumConstants: kind === 'enum' });
                continue;
            }
            // A method body, initializer block, array initializer or anonymous class: skip it.
            const end = skipBlock(i);
            i = end;
            if (current()?.enumConstants) {
                header = `${text} {…}`; // enum constant with a body: keep collecting constants
                continue;
            }
            if (text !== '' && current()?.kind !== undefined && visibleHere(text) && !/^(static)?$/.test(text)) {
                lines.push(`${indent()}${withoutInitializer(text)};`);
                if (initializerIndex(text) !== -1) {
                    // Field initialised with a block: swallow the rest up to ';'.
                    while (i < code.length && code[i] !== ';') i++;
                }
            }
            continue;
        }

        if (c === '}' && parens === 0) {
            const scope = scopes.pop();
            if (scope?.enumConstants && normalize(header) !== '') {
                lines.push(`${indent()}    ${normalize(header)}`);
            }
            header = '';
            if (scope?.visible) {
                lines.push(`${indent()}}`);
            }
            continue;
        }

        if (c === ';' && parens === 0) {
            const text = normalize(header);
            header = '';
            const scope = current();
            if (text === '' || scope === undefined) {
                continue; // package and import statements
            }
            if (scope.enumConstants) {
                scope.enumConstants = false;
                if (scope.visible) {
                    lines.push(`${indent()}${text};`);
                }
                continue;
            }
            if (visibleHere(text)) {
                lines.push(`${indent()}${withoutInitializer(text)};`);
            }
            continue;
        }

        header += c;
    }

    return lines.join('\n').replace(/[\uE000-\uE003]/g, ch => UNHIDE[ch]) + (lines.length > 0 ? '\n' : '');
}

// -------------------------------------------------------------------------------------- main

function main() {
    const options = parseArgs(process.argv.slice(2));
    const gitDir = prepareClone(options);
    const fromSha = resolveRef(gitDir, options.from);
    const toSha = resolveRef(gitDir, options.to);

    const slug = `${options.from}..${options.to}`.replace(/[^A-Za-z0-9._-]+/g, '_');
    const outDir = resolve(options.out ?? join(ROOT, 'api-diff', slug));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const pathspec = ['--', options.path];
    console.error(`Diffing ${options.path}: ${options.from} (${fromSha.slice(0, 10)}) → ${options.to} (${toSha.slice(0, 10)})`);

    // 1. Raw material.
    const fullDiff = git(gitDir, ['diff', '-M', '--no-color', fromSha, toSha, ...pathspec]);
    writeFileSync(join(outDir, 'full.diff'), fullDiff);

    const nameStatus = git(gitDir, ['diff', '-M', '--name-status', fromSha, toSha, ...pathspec]).trim();
    writeFileSync(join(outDir, 'files.tsv'), nameStatus + '\n');

    const mergeBase = git(gitDir, ['merge-base', fromSha, toSha], { allowFail: true })?.trim();
    const commits = git(gitDir, ['log', '--no-merges', '--format=- %h %s (%an, %as)', `${fromSha}..${toSha}`, ...pathspec]).trim();

    // 2. Public surface of every changed Java file, at both refs.
    const entries = nameStatus === '' ? [] : nameStatus.split('\n').map(line => {
        const [status, a, b] = line.split('\t');
        const kind = status[0];
        return { status, kind, oldPath: kind === 'A' ? null : a, newPath: kind === 'D' ? null : (b ?? a) };
    });

    const surfaceRoot = join(outDir, '.surface');
    const show = (sha, path) => git(gitDir, ['show', `${sha}:${path}`]);
    const surfaceChanged = new Set();
    for (const entry of entries) {
        const path = entry.newPath ?? entry.oldPath;
        if (!path.endsWith('.java')) continue;
        const before = entry.oldPath ? apiSurface(show(fromSha, entry.oldPath), entry.oldPath) : '';
        const after = entry.newPath ? apiSurface(show(toSha, entry.newPath), entry.newPath) : '';
        if (entry.oldPath && before !== '') {
            mkdirSync(dirname(join(surfaceRoot, 'a', entry.oldPath)), { recursive: true });
            writeFileSync(join(surfaceRoot, 'a', entry.oldPath), before);
        }
        if (entry.newPath && after !== '') {
            mkdirSync(dirname(join(surfaceRoot, 'b', entry.newPath)), { recursive: true });
            writeFileSync(join(surfaceRoot, 'b', entry.newPath), after);
        }
        if (before !== after) surfaceChanged.add(path);
    }
    mkdirSync(join(surfaceRoot, 'a'), { recursive: true });
    mkdirSync(join(surfaceRoot, 'b'), { recursive: true });

    let surfaceDiff = '';
    try {
        execFileSync('git', ['diff', '--no-index', '--no-color', '--no-prefix', '-M', 'a', 'b'], {
            cwd: surfaceRoot, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        // git diff --no-index exits with 1 when there are differences.
        if (error.status !== 1) throw error;
        surfaceDiff = error.stdout;
    }
    writeFileSync(join(outDir, 'surface.diff'), surfaceDiff);
    rmSync(surfaceRoot, { recursive: true, force: true });

    // 3. Summary.
    const toClass = path => {
        const match = /src\/[^/]+\/java\/(.+)\.java$/.exec(path ?? '');
        return match ? match[1].replaceAll('/', '.') : path;
    };
    const groups = { A: [], D: [], R: [], M: [], other: [] };
    for (const entry of entries) {
        const flag = entry.newPath?.endsWith('.java') || entry.oldPath?.endsWith('.java')
            ? (surfaceChanged.has(entry.newPath ?? entry.oldPath) ? '' : ' _(no public change)_')
            : '';
        switch (entry.kind) {
            case 'A': groups.A.push(`- \`${toClass(entry.newPath)}\`${flag}`); break;
            case 'D': groups.D.push(`- \`${toClass(entry.oldPath)}\`${flag}`); break;
            case 'R': groups.R.push(`- \`${toClass(entry.oldPath)}\` → \`${toClass(entry.newPath)}\`${flag}`); break;
            case 'M': groups.M.push(`- \`${toClass(entry.newPath)}\`${flag}`); break;
            default: groups.other.push(`- ${entry.status} \`${entry.newPath ?? entry.oldPath}\``);
        }
    }
    const section = (title, items) => items.length === 0 ? '' : `### ${title} (${items.length})\n\n${items.join('\n')}\n\n`;
    const stat = git(gitDir, ['diff', '-M', '--shortstat', fromSha, toSha, ...pathspec]).trim();

    const summary = `# API diff: \`${options.from}\` → \`${options.to}\`

- Subproject: \`${options.path}\`
- From: \`${options.from}\` at \`${fromSha}\`
- To: \`${options.to}\` at \`${toSha}\`
- Merge base: ${mergeBase ? `\`${mergeBase}\`` : 'none'}
- Repository: ${options.repo}
- Generated: ${new Date().toISOString()}
- ${stat || 'No changes.'}

## Files in this folder

- \`surface.diff\`: public declarations only. Start here to see what changed for plugin authors.
- \`full.diff\`: the complete diff, with Javadoc and bodies. Use it for the details and the intent.
- \`files.tsv\`: \`git diff --name-status\` output.

To read a whole file at either ref: \`git --git-dir .cache/fidorial.git show ${options.to}:<path>\`.

## Commits touching \`${options.path}\`

${commits || '_None: the refs may have diverged. Check the merge base._'}

## Changed files

${section('Added', groups.A)}${section('Removed', groups.D)}${section('Renamed or moved', groups.R)}${section('Modified', groups.M)}${section('Other', groups.other)}`;
    writeFileSync(join(outDir, 'SUMMARY.md'), summary);

    console.error(`Wrote ${outDir}`);
    console.error(`  ${entries.length} files changed, ${surfaceChanged.size} with public API changes`);
    process.stdout.write(outDir + '\n');
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
