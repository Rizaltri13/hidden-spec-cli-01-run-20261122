// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, JSON tool calls), finds the lines each edit names at
// the first of three matching tiers, and changes every file or none.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A fatal patch problem: exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: exit 1, reported as `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own break, its lines, whether it ends with a break. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseText(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function serialize(fm: FileModel): string {
  if (fm.lines.length === 0) return '';
  return fm.lines.join(fm.br) + (fm.final ? fm.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of an old/new pair: `ctx` lines are written as the file's own matched line, `oi` its index in O. */
interface ONLine {
  text: string;
  ctx: boolean;
  oi: number;
}

/** First tier (0, 1, 2) at which O occurs in the file lines, and every position there. */
function findTier(o: string[], file: string[], strict: boolean): { tier: number; positions: number[] } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    const eq = (a: string, b: string): boolean =>
      tier === 0 ? a === b : tier === 1 ? trailTrim(a) === trailTrim(b) : bothTrim(a) === bothTrim(b);
    for (let i = 0; i + o.length <= file.length; i += 1) {
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (!eq(o[k]!, file[i + k]!)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return { tier: 0, positions: [] };
}

/** The lines that replace a matched run: context lines from the file, other new lines re-indented at tier 2. */
function buildReplacement(o: ONLine[], n: ONLine[], file: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = leadWs(file[pos]!);
  const p = leadWs(o[0]!.text);
  for (const line of n) {
    if (line.ctx) {
      out.push(file[pos + line.oi]!);
    } else if (tier === 2 && line.text !== '' && line.text.trim() !== '' && line.text.startsWith(p)) {
      out.push(f + line.text.slice(p.length));
    } else {
      out.push(line.text);
    }
  }
  return out;
}

/** Apply one matched replacement to a file model; `final` is the caller's to keep unless told otherwise. */
function spliceReplacement(fm: FileModel, o: ONLine[], n: ONLine[], pos: number, tier: number): FileModel {
  const repl = buildReplacement(o, n, fm.lines, pos, tier);
  const oLines = o.map((l) => l.text);
  return { br: fm.br, final: fm.final, lines: [...fm.lines.slice(0, pos), ...repl, ...fm.lines.slice(pos + oLines.length)] };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fm = parseText(before);
      if (line < 0 || line > fm.lines.length) throw new Fail('no-match', p);
      fm.lines.splice(line, 0, ...add);
      tree.now.set(p, serialize(fm));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  diffOld?: string;
  diffNew?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path of a `--- ` / `+++ ` line: after four characters, up to the first tab, spaces removed, `a/`/`b/` removed. */
function headerPath(l: string): string {
  return stripAB(l.slice(4).split('\t')[0]!.trim());
}

/** A hunk body split into old lines O and new lines N, and whether a `\` line follows its last context or `+` line. */
function hunkParts(body: string[]): { o: ONLine[]; n: ONLine[]; noEol: boolean } {
  const o: ONLine[] = [];
  const n: ONLine[] = [];
  let lastCtxPlus = -1;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (l === '') {
      o.push({ text: '', ctx: true, oi: o.length });
      n.push({ text: '', ctx: true, oi: o.length - 1 });
      lastCtxPlus = i;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push({ text: t, ctx: true, oi: o.length });
      n.push({ text: t, ctx: true, oi: o.length - 1 });
      lastCtxPlus = i;
    } else if (l[0] === '-') {
      o.push({ text: l.slice(1), ctx: false, oi: -1 });
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oi: -1 });
      lastCtxPlus = i;
    }
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]![0] === '\\';
  return { o, n, noEol };
}

/** Apply one hunk to a file model; `d` is the line drift of this section's earlier hunks. */
function applyHunk(fm: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): { fm: FileModel; delta: number } {
  const { o, n, noEol } = hunkParts(hunk.body);
  const oLines = o.map((l) => l.text);
  if (oLines.length === 0) {
    const at = Math.min(Math.max(hunk.a + d, 0), fm.lines.length);
    const lines = [...fm.lines.slice(0, at), ...n.map((l) => l.text), ...fm.lines.slice(at)];
    const final = at === fm.lines.length && n.length > 0 ? !noEol : fm.final;
    return { fm: { br: fm.br, lines, final }, delta: n.length };
  }
  const { tier, positions } = findTier(oLines, fm.lines, strict);
  if (positions.length === 0) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = positions[0]!;
  for (const pos of positions) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const out = spliceReplacement(fm, o, n, best, tier);
  if (best + oLines.length === fm.lines.length) out.final = !noEol;
  return { fm: out, delta: n.length - o.length };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld ?? '';
  const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew ?? '';
  const creation = oldP === '/dev/null' || sec.newFile;
  const deletion = newP === '/dev/null' || sec.deletedFile;
  if (creation) {
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const outLines: string[] = [];
      let lastPlus: { h: number; i: number } | null = null;
      sec.hunks.forEach((h, hi) => {
        h.body.forEach((l, li) => {
          if (l[0] === '+') {
            outLines.push(l.slice(1));
            lastPlus = { h: hi, i: li };
          }
        });
      });
      let noEol = false;
      if (lastPlus !== null) {
        const body = sec.hunks[lastPlus.h]!.body;
        noEol = body[lastPlus.i + 1] !== undefined && body[lastPlus.i + 1]![0] === '\\';
      }
      tree.now.set(newP, serialize({ br: '\n', lines: outLines, final: outLines.length > 0 && !noEol }));
    };
  }
  if (deletion) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let fm = parseText(text);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyHunk(fm, h, d, strict, oldP);
        fm = r.fm;
        d += r.delta;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, serialize(fm));
      tree.moves.push([oldP, newP]);
    };
  }
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    let fm = parseText(text);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(fm, h, d, strict, oldP);
      fm = r.fm;
      d += r.delta;
    }
    tree.now.set(oldP, serialize(fm));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'out' | 'header' | 'between' = 'out';
  const startSection = (s: Section): void => {
    if (cur !== null) sections.push(cur);
    cur = s;
    state = 'header';
  };
  const newDiffSection = (m: RegExpExecArray): void =>
    startSection({ newFile: false, deletedFile: false, hunks: [], diffOld: m[1], diffNew: m[2] });
  const newPairSection = (oldLine: string, newLine: string): void => {
    const s: Section = { newFile: false, deletedFile: false, hunks: [] };
    s.pairOld = headerPath(oldLine);
    s.pairNew = headerPath(newLine);
    startSection(s);
  };
  const collectBody = (i: number): { body: string[]; next: number } => {
    const body: string[] = [];
    let j = i;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push(l);
        j += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return { body, next: j };
  };
  const readHunk = (i: number): { a: number; body: string[]; next: number } => {
    const m = HUNK_HEAD.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const { body, next } = collectBody(i + 1);
    return { a: Number(m[1]), body, next };
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (state === 'out') {
      if (l.startsWith('diff --git ')) {
        const m = DIFF_GIT.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        newDiffSection(m);
        i += 1;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newPairSection(l, lines[i + 1]!);
        i += 2;
      } else if (l.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i += 1;
      }
    } else if (state === 'header') {
      if (l.startsWith('diff --git ')) {
        const m = DIFF_GIT.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        newDiffSection(m);
        i += 1;
      } else if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur!.pairOld = headerPath(l);
        cur!.pairNew = headerPath(lines[i + 1]!);
        i += 2;
      } else if (l.startsWith('+++ ')) {
        cur!.pairNew = headerPath(l);
        i += 1;
      } else if (l.startsWith('@@')) {
        const h = readHunk(i);
        cur!.hunks.push({ a: h.a, body: h.body });
        state = 'between';
        i = h.next;
      } else if (l.startsWith('rename from ')) {
        cur!.renameFrom = l.slice(12).trim();
        i += 1;
      } else if (l.startsWith('rename to ')) {
        cur!.renameTo = l.slice(10).trim();
        i += 1;
      } else if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur!.newFile = true;
        i += 1;
      } else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur!.deletedFile = true;
        i += 1;
      } else {
        i += 1;
      }
    } else {
      if (l.startsWith('diff --git ')) {
        const m = DIFF_GIT.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        newDiffSection(m);
        i += 1;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newPairSection(l, lines[i + 1]!);
        i += 2;
      } else if (l.startsWith('@@')) {
        const h = readHunk(i);
        cur!.hunks.push({ a: h.a, body: h.body });
        i = h.next;
      } else {
        i += 1;
      }
    }
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j -= 1) {
        const t = lines[j]!.trim();
        if (t !== '' && !t.startsWith('```')) {
          path = t;
          break;
        }
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${s + 1}`);
      const eq = lines.findIndex((l, k) => k > s && l.trimEnd() === '=======');
      if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
      const rep = lines.findIndex((l, k) => k > eq && l.trimEnd() === '>>>>>>> REPLACE');
      if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
      const oldLines = lines.slice(s + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (oldLines.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, serialize({ br: '\n', lines: newLines, final: newLines.length > 0 }));
          return;
        }
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        const fm = parseText(text);
        const o: ONLine[] = oldLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
        const n: ONLine[] = newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
        const { tier, positions } = findTier(oldLines, fm.lines, strict);
        if (positions.length === 0) throw new Fail('no-match', p);
        if (positions.length > 1) throw new Fail('ambiguous', p);
        tree.now.set(p, serialize(spliceReplacement(fm, o, n, positions[0]!, tier)));
      });
      prevPath = p;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4AChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aChunkON(body: string[]): { o: ONLine[]; n: ONLine[] } {
  const o: ONLine[] = [];
  const n: ONLine[] = [];
  for (const l of body) {
    if (l === '') {
      o.push({ text: '', ctx: true, oi: o.length });
      n.push({ text: '', ctx: true, oi: o.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push({ text: t, ctx: true, oi: o.length });
      n.push({ text: t, ctx: true, oi: o.length - 1 });
    } else if (l[0] === '-') {
      o.push({ text: l.slice(1), ctx: false, oi: -1 });
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oi: -1 });
    }
  }
  return { o, n };
}

function v4aSectionEdit(kind: string, path: string, raw: string[], startLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const outLines: string[] = [];
    raw.forEach((l, k) => {
      if (l.startsWith('+')) outLines.push(l.slice(1));
      else if (l === '') outLines.push('');
      else throw new Exit2(`error: parse ${startLine + 2 + k}`);
    });
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serialize({ br: '\n', lines: outLines, final: outLines.length > 0 }));
    };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${startLine + 2}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let j = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice(13).trim();
    j = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  for (; j < raw.length; j += 1) {
    const l = raw[j]!;
    const lineNo = startLine + 2 + j;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, body: [], eof: false };
      }
      cur.body.push(l);
    } else {
      throw new Exit2(`error: parse ${lineNo}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
  const dest = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
    let fm = parseText(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const eq = (a: string, b: string): boolean =>
            tier === 0 ? a === b : tier === 1 ? trailTrim(a) === trailTrim(b) : bothTrim(a) === bothTrim(b);
          for (let k = cursor; k < fm.lines.length; k += 1) {
            if (eq(fm.lines[k]!, ch.anchor)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, n } = v4aChunkON(ch.body);
      const oLines = o.map((l) => l.text);
      if (oLines.length === 0) {
        const at = ch.eof ? fm.lines.length : cursor;
        const lines = [...fm.lines.slice(0, at), ...n.map((l) => l.text), ...fm.lines.slice(at)];
        fm = { br: fm.br, lines, final: fm.final };
        cursor = at + n.length;
        continue;
      }
      const { tier, positions } = findTier(oLines, fm.lines, strict);
      const after = positions.filter((pos) => pos >= cursor);
      if (after.length === 0) throw new Fail('no-match', path);
      let pos: number;
      if (ch.eof) {
        const ending = after.filter((p) => p + oLines.length === fm.lines.length);
        if (ending.length === 0) throw new Fail('no-match', path);
        pos = ending[0]!;
      } else {
        pos = after[0]!;
      }
      fm = spliceReplacement(fm, o, n, pos, tier);
      cursor = pos + n.length;
    }
    if (dest !== null) {
      tree.now.set(path, null);
      tree.now.set(dest, serialize(fm));
      tree.moves.push([path, dest]);
    } else {
      tree.now.set(path, serialize(fm));
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = isSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(': ') + 2).trim();
    const startLine = i;
    i += 1;
    const raw: string[] = [];
    while (i < last) {
      const m = lines[i]!;
      if (isSectionStart(m) !== null) break;
      raw.push(m);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, startLine, strict));
  }
  return edits;
}

/* ---- Invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
