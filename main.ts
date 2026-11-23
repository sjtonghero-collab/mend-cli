// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
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

/** A file as lines: its own line break, and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// Section 5: matching lines at three tiers.

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => trimEndST(s.replace(/^[ \t]+/, ''));
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Every position at or after `from` where O's lines match the file's lines at `tier`; occurrences may overlap. */
function occAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at or after `from`; `eof` keeps only occurrences ending at the last line. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0, eof = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let ps = occAt(lines, O, t, from);
    if (eof) ps = ps.filter((p) => p + O.length === lines.length);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

type ItemKind = 'ctx' | 'del' | 'add' | 'bs';
interface Item {
  kind: ItemKind;
  text: string;
  rawEmpty?: boolean;
}

/**
 * The lines a match writes: a context line is the file's own matched line; an added line is written as it is,
 * except at tier 2, where a non-blank added line that starts with O's first line's indentation P has P
 * replaced by the file's first matched line's indentation F.
 */
function replacementFor(fileLines: string[], pos: number, O: string[], items: Item[], tier: number): string[] {
  const out: string[] = [];
  const F = tier === 2 ? leadWS(fileLines[pos]!) : '';
  const P = tier === 2 ? leadWS(O[0]!) : '';
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else if (it.kind === 'add') {
      let t = it.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
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

// Section 6: unified diffs.

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null | undefined;
  plusPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` line names: up to the first tab, spaces removed, `/dev/null` as null, a/ b/ stripped. */
function headerPath(l: string): string | null {
  let rest = l.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.replace(/^ +| +$/g, '');
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s|$)/;
const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function isDiffLine(l: string): boolean {
  return l.startsWith('diff --git ') || l === 'diff --git';
}

function isPairStart(lines: string[], i: number): boolean {
  return lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
}

/** Parses a section's header and hunks starting at index i; returns the index just past the section. */
function parseSectionBody(lines: string[], i: number, sec: Section, pair: boolean): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (isDiffLine(l)) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (pair) break;
        sec.minusPath = headerPath(l);
        sec.plusPath = headerPath(lines[i + 1]!);
        pair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) sec.renameFrom = l.slice(12);
    else if (l.startsWith('rename to ')) sec.renameTo = l.slice(10);
    else if (l.startsWith('new file mode')) sec.newFile = true;
    else if (l.startsWith('deleted file mode')) sec.delFile = true;
    i += 1;
  }
  while (i < n && lines[i]!.startsWith('@@')) {
    const m = HUNK_RE.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const a = parseInt(m[1]!, 10);
    i += 1;
    const items: Item[] = [];
    while (i < n) {
      const bl = lines[i]!;
      if (isDiffLine(bl)) break;
      if (isPairStart(lines, i)) break;
      const c = bl[0];
      if (bl === '') items.push({ kind: 'ctx', text: '', rawEmpty: true });
      else if (c === ' ') items.push({ kind: 'ctx', text: bl.slice(1) });
      else if (c === '-') items.push({ kind: 'del', text: bl.slice(1) });
      else if (c === '+') items.push({ kind: 'add', text: bl.slice(1) });
      else if (c === '\\') items.push({ kind: 'bs', text: bl.slice(1) });
      else break;
      i += 1;
    }
    while (items.length > 0 && items[items.length - 1]!.rawEmpty === true) items.pop();
    sec.hunks.push({ a, items });
  }
  return i;
}

function newSection(): Section {
  return { gitOld: null, gitNew: null, minusPath: undefined, plusPath: undefined, renameFrom: undefined, renameTo: undefined, newFile: false, delFile: false, hunks: [] };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function bsAfterLastCtxOrAdd(items: Item[]): boolean {
  let last = -1;
  items.forEach((it, idx) => {
    if (it.kind === 'ctx' || it.kind === 'add') last = idx;
  });
  return last >= 0 && items[last + 1]?.kind === 'bs';
}

/** Applies a section's hunks in order to a file's text; a hunk that finds nothing fails the section. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  const lines = f.lines;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    let nLen = 0;
    for (const it of h.items) {
      if (it.kind === 'ctx' || it.kind === 'del') O.push(it.text);
      if (it.kind === 'ctx' || it.kind === 'add') nLen += 1;
    }
    if (O.length === 0) {
      const adds = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...adds);
      if (atEnd && h.items.length > 0) f.final = !bsAfterLastCtxOrAdd(h.items);
      d += adds.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const repl = replacementFor(lines, best, O, h.items, found.tier);
      const toEnd = best + O.length === lines.length;
      lines.splice(best, O.length, ...repl);
      if (toEnd) f.final = !bsAfterLastCtxOrAdd(h.items);
      d += nLen - O.length;
    }
  }
  return joinFile(f);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.minusPath !== undefined ? sec.minusPath : (sec.renameFrom ?? sec.gitOld);
  const newPath = sec.plusPath !== undefined ? sec.plusPath : (sec.renameTo ?? sec.gitNew);
  const creation = sec.minusPath === null || sec.newFile;
  const deletion = sec.plusPath === null || sec.delFile;
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (p !== null && p !== undefined && !safe(p)) throw new Fail('unsafe', p);
    }
    if (creation) {
      const p = newPath ?? '';
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      const flat: Item[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) {
          flat.push(it);
          if (it.kind === 'add') out.push(it.text);
        }
      }
      let lastAdd = -1;
      flat.forEach((it, idx) => {
        if (it.kind === 'add') lastAdd = idx;
      });
      const finalBreak = !(lastAdd >= 0 && flat[lastAdd + 1]?.kind === 'bs');
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (deletion) {
      const p = oldPath ?? '';
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = oldPath ?? '';
    const dst = newPath ?? '';
    const text = tree.get(src);
    if (text === null) throw new Fail('missing', src);
    if (dst !== src && tree.get(dst) !== null) throw new Fail('exists', dst);
    const result = applyHunks(text, sec.hunks, strict, src);
    if (dst !== src) {
      tree.now.set(src, null);
      tree.now.set(dst, result);
      tree.moves.push([src, dst]);
    } else {
      tree.now.set(src, result);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (isDiffLine(l)) {
      const m = GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      i = parseSectionBody(lines, i + 1, sec, false);
      sections.push(sec);
      continue;
    }
    if (isPairStart(lines, i)) {
      const sec = newSection();
      sec.minusPath = headerPath(l);
      sec.plusPath = headerPath(lines[i + 1]!);
      i = parseSectionBody(lines, i + 2, sec, true);
      sections.push(sec);
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const items: Item[] = newLines.map((t) => ({ kind: 'add' as const, text: t }));
    const repl = replacementFor(f.lines, pos, oldLines, items, found.tier);
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let start = 0;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= start; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    for (let k = i + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rp = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < n; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rp = k;
          break;
        }
      }
    }
    if (eq < 0 || rp < 0) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rp), strict));
    prevPath = path;
    start = rp + 1;
    i = rp + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// Section 8: V4A patches.

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

function v4aEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    const lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineEq(lines[k]!, ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const O: string[] = [];
      for (const it of ch.items) {
        if (it.kind === 'ctx' || it.kind === 'del') O.push(it.text);
      }
      if (O.length === 0) {
        const adds = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
      } else {
        const found = findTier(lines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const repl = replacementFor(lines, pos, O, ch.items, found.tier);
        lines.splice(pos, O.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const result = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, result);
    }
  };
}

/** Parses one V4A section (its lines, trailing blanks already removed); base is its header's 0-based patch index. */
function v4aSection(secLines: string[], base: number, strict: boolean): Edit {
  const head = secLines[0]!;
  if (head.startsWith('*** Add File: ')) {
    const path = head.slice(14).trim();
    const body: string[] = [];
    secLines.forEach((l, k) => {
      if (k === 0) return;
      if (l.startsWith('+')) body.push(l.slice(1));
      else if (l === '') body.push('');
      else throw new Exit2(`error: parse ${base + k + 1}`);
    });
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, body.length === 0 ? '' : `${body.join('\n')}\n`);
    };
  }
  if (head.startsWith('*** Delete File: ')) {
    const path = head.slice(17).trim();
    secLines.forEach((l, k) => {
      if (k > 0 && !blank(l)) throw new Exit2(`error: parse ${base + k + 1}`);
    });
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = head.slice(16).trim();
  let idx = 1;
  let moveTo: string | null = null;
  if ((secLines[1] ?? '').startsWith('*** Move to: ')) {
    moveTo = secLines[1]!.slice(13).trim();
    idx = 2;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let k = idx; k < secLines.length; k += 1) {
    const l = secLines[k]!;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() || null, items: [], eof: false };
      chunks.push(cur);
    } else if (!l.startsWith(' ') && l.trim() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, items: [], eof: false };
        chunks.push(cur);
      }
      cur.eof = true;
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${base + k + 1}`);
        cur = { anchor: null, items: [], eof: false };
        chunks.push(cur);
      }
      if (l === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.items.push({ kind: 'del', text: l.slice(1) });
      else cur.items.push({ kind: 'add', text: l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${base + k + 1}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${base + 1}`);
  return v4aEdit(path, moveTo, chunks, strict);
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let f = -1;
  for (let i = 0; i < n; i += 1) {
    if (!blank(lines[i]!)) {
      f = i;
      break;
    }
  }
  if (f < 0) throw new Exit2('error: parse 1');
  if (lines[f]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${f + 1}`);
  let l = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      l = i;
      break;
    }
  }
  if (lines[l]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const secStart = (s: string): boolean => s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = f + 1;
  while (i < l) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    if (!secStart(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < l && !secStart(lines[j]!)) j += 1;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    edits.push(v4aSection(lines.slice(i, end), i, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// Section 9: JSON edits.

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
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
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

// Sections 1, 2 and 10: the command line, the run, the all-or-nothing write.

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((fl) => `error: ${fl.code} ${fl.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  if (!check) {
    for (const p of changed) {
      const v = tree.now.get(p)!;
      if (v === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  const rPairs = new Map<string, string>();
  const usedOld = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (rPairs.has(nw) || usedOld.has(o)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(nw) === null && tree.now.get(nw) !== null && tree.now.get(nw) !== undefined) {
      rPairs.set(nw, o);
      usedOld.add(o);
    }
  }
  const rows: Array<{ k: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [nw, o] of rPairs) {
    rows.push({ k: nw, line: `R ${o} -> ${nw}` });
    covered.add(nw);
    covered.add(o);
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const v = tree.now.get(p)!;
    rows.push({ k: p, line: `${was === null ? 'A' : v === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.k), Buffer.from(y.k)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
