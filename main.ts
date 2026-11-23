import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// mend: apply an AI-written edit (unified diff, SEARCH/REPLACE blocks, V4A
// patch, or JSON text-editor tool calls) to a tree of text files, exactly as
// SPEC.md (version 1) says. Every file is changed or nothing is.
// ---------------------------------------------------------------------------

// Small text helpers ---------------------------------------------------------

function rstripST(s: string): string {
  return s.replace(/[ \t]+$/, "");
}

function stripST(s: string): string {
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function isBlankLine(s: string): boolean {
  return s.trim() === "";
}

// A patch's lines: its text split at \n, each with one trailing \r removed,
// and without the empty piece after a final \n (SPEC section 3).
function splitPatchLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

// A path is safe when it is not empty, does not start with /, holds no
// backslash, and none of its /-separated segments is empty, . or ...
function isSafePath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

class ParseFailure extends Error {
  line: number;
  constructor(line: number) {
    super("parse " + line);
    this.line = line;
  }
}

// The file model (SPEC section 3) -------------------------------------------

interface FileState {
  lines: string[];
  brk: string; // "\r\n" or "\n"
  endsBreak: boolean;
}

function deriveState(text: string): FileState {
  if (text === "") return { lines: [], brk: "\n", endsBreak: false };
  const firstLf = text.indexOf("\n");
  const brk = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const parts = text.split(brk);
  let endsBreak = false;
  if (text.endsWith(brk)) {
    parts.pop();
    endsBreak = true;
  }
  return { lines: parts, brk, endsBreak };
}

function renderState(st: FileState): string {
  if (st.lines.length === 0) return "";
  return st.lines.join(st.brk) + (st.endsBreak ? st.brk : "");
}

// The in-memory tree: edits apply in order to the state earlier edits left,
// and nothing reaches the disk unless every edit succeeds (SPEC section 10).
class Tree {
  private cache = new Map<string, FileState | null>();
  private initial = new Map<string, string | null>();

  private load(p: string): FileState | null {
    const hit = this.cache.get(p);
    if (hit !== undefined) return hit;
    let text: string | null = null;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      text = null;
    }
    this.initial.set(p, text);
    const st = text === null ? null : deriveState(text);
    this.cache.set(p, st);
    return st;
  }

  exists(p: string): boolean {
    return this.load(p) !== null;
  }

  get(p: string): FileState | null {
    return this.load(p);
  }

  set(p: string, st: FileState): void {
    this.load(p);
    this.cache.set(p, st);
  }

  remove(p: string): void {
    this.load(p);
    this.cache.set(p, null);
  }

  initialRaw(p: string): string | null {
    const v = this.initial.get(p);
    return v === undefined ? null : v;
  }

  finalRaw(p: string): string | null {
    const st = this.cache.get(p);
    if (st === undefined || st === null) return null;
    return renderState(st);
  }

  touchedPaths(): string[] {
    return [...this.initial.keys()];
  }

  writeAll(): void {
    for (const p of this.initial.keys()) {
      const before = this.initial.get(p);
      const after = this.finalRaw(p);
      if (before === after) continue;
      if (after === null) {
        try {
          fs.rmSync(p);
        } catch {
          // already gone
        }
      } else {
        const slash = p.lastIndexOf("/");
        if (slash > 0) fs.mkdirSync(p.slice(0, slash), { recursive: true });
        fs.writeFileSync(p, after, "utf8");
      }
    }
  }
}

// Matching lines (SPEC section 5) -------------------------------------------

type Tier = 0 | 1 | 2;

function tiersToTry(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}

function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripST(a) === rstripST(b);
  return stripST(a) === stripST(b);
}

function occurrences(lines: string[], o: string[], tier: Tier): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let p = 0; p + o.length <= lines.length; p++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[p + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(p);
  }
  return out;
}

function matchFirstTier(
  lines: string[],
  o: string[],
  strict: boolean
): { tier: Tier; positions: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const positions = occurrences(lines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// Body entries of a unified hunk or a V4A chunk ------------------------------

interface BodyEntry {
  t: "ctx" | "old" | "new" | "bs";
  s: string;
  rawEmpty?: boolean;
}

function pushBody(entries: BodyEntry[], line: string): void {
  if (line === "") {
    entries.push({ t: "ctx", s: "", rawEmpty: true });
  } else if (line.startsWith(" ")) {
    entries.push({ t: "ctx", s: line.slice(1) });
  } else if (line.startsWith("-")) {
    entries.push({ t: "old", s: line.slice(1) });
  } else if (line.startsWith("+")) {
    entries.push({ t: "new", s: line.slice(1) });
  } else if (line.startsWith("\\")) {
    entries.push({ t: "bs", s: line.slice(1) });
  }
}

function oldTexts(entries: BodyEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) if (e.t === "ctx" || e.t === "old") out.push(e.s);
  return out;
}

// Build the lines that replace the matched region: context lines are written
// as the file's own matched lines; at tier 2 every other new line is
// re-indented from O's first line's indentation to the file's (SPEC 5).
function buildWritten(
  entries: BodyEntry[],
  fileLines: string[],
  pos: number,
  tier: Tier,
  o: string[]
): string[] {
  const out: string[] = [];
  let oi = 0;
  const p0 = o.length > 0 ? leadWS(o[0]) : "";
  const f0 = pos < fileLines.length ? leadWS(fileLines[pos]) : "";
  for (const e of entries) {
    if (e.t === "ctx") {
      out.push(fileLines[pos + oi]);
      oi++;
    } else if (e.t === "old") {
      oi++;
    } else if (e.t === "new") {
      let s = e.s;
      if (tier === 2 && !/^[ \t]*$/.test(s) && s.startsWith(p0)) {
        s = f0 + s.slice(p0.length);
      }
      out.push(s);
    }
  }
  return out;
}

// Whether a \ line follows the body's last context or + line (SPEC 6).
function backslashAfterLastCtxOrNew(entries: BodyEntry[]): boolean {
  let last = -1;
  entries.forEach((e, idx) => {
    if (e.t === "ctx" || e.t === "new") last = idx;
  });
  if (last < 0) return false;
  const after = entries[last + 1];
  return after !== undefined && after.t === "bs";
}

// Edits -----------------------------------------------------------------------

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

interface UnifiedEdit {
  format: "unified";
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

interface SREdit {
  format: "sr";
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface V4AAddEdit {
  format: "v4a-add";
  path: string;
  fileLines: string[];
}

interface V4ADelEdit {
  format: "v4a-del";
  path: string;
}

interface V4AUpdEdit {
  format: "v4a-upd";
  path: string;
  moveTo: string | undefined;
  chunks: Chunk[];
}

interface JSONEdit {
  format: "json";
  command: "create" | "str_replace" | "insert";
  path: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

type Edit = UnifiedEdit | SREdit | V4AAddEdit | V4ADelEdit | V4AUpdEdit | JSONEdit;

interface Failure {
  code: string;
  path: string;
}

// Unified diffs (SPEC section 6) ----------------------------------------------

interface SectionAcc {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSectionAcc(): SectionAcc {
  return {
    diffOld: undefined,
    diffNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

// The path of a --- or +++ line: the text after the four characters, up to
// the first tab, with surrounding spaces removed; /dev/null means no file;
// a leading a/ or b/ is removed.
function parsePathArg(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf("\t");
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function trimHunk(h: Hunk): void {
  while (h.entries.length > 0 && h.entries[h.entries.length - 1].rawEmpty) {
    h.entries.pop();
  }
}

function buildUnifiedEdit(sec: SectionAcc): UnifiedEdit {
  const oldPath =
    sec.pairOld !== undefined
      ? sec.pairOld
      : sec.renameOld !== undefined
        ? sec.renameOld
        : sec.diffOld !== undefined
          ? sec.diffOld
          : null;
  const newPath =
    sec.pairNew !== undefined
      ? sec.pairNew
      : sec.renameNew !== undefined
        ? sec.renameNew
        : sec.diffNew !== undefined
          ? sec.diffNew
          : null;
  return {
    format: "unified",
    oldPath,
    newPath,
    isCreate: sec.newFile || oldPath === null,
    isDelete: sec.deletedFile || newPath === null,
    hunks: sec.hunks,
  };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: SectionAcc | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;

  const finalizeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      trimHunk(hunk);
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const finalizeSection = (): void => {
    finalizeHunk();
    if (sec !== null) edits.push(buildUnifiedEdit(sec));
    sec = null;
    inHeader = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ln = i + 1;

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFailure(ln);
      finalizeSection();
      sec = newSectionAcc();
      sec.diffOld = m[1];
      sec.diffNew = m[2];
      inHeader = true;
      i++;
      continue;
    }

    if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      if (sec !== null && inHeader && sec.pairOld === undefined) {
        finalizeHunk();
        sec.pairOld = parsePathArg(line);
        sec.pairNew = parsePathArg(lines[i + 1]);
      } else {
        finalizeSection();
        sec = newSectionAcc();
        sec.pairOld = parsePathArg(line);
        sec.pairNew = parsePathArg(lines[i + 1]);
        inHeader = true;
      }
      i += 2;
      continue;
    }

    if (line.startsWith("@@")) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new ParseFailure(ln);
      if (sec === null) throw new ParseFailure(ln);
      finalizeHunk();
      inHeader = false;
      hunk = { a: parseInt(hm[1], 10), entries: [] };
      i++;
      continue;
    }

    if (
      hunk !== null &&
      (line === "" ||
        line.startsWith(" ") ||
        line.startsWith("-") ||
        line.startsWith("+") ||
        line.startsWith("\\"))
    ) {
      pushBody(hunk.entries, line);
      i++;
      continue;
    }

    if (hunk !== null) finalizeHunk();

    if (sec !== null && inHeader) {
      if (line.startsWith("--- ")) {
        // A --- line not followed by a +++ line inside a section's header:
        // the error names the line after it.
        throw new ParseFailure(ln + 1);
      }
      if (line.startsWith("+++ ")) {
        if (sec.pairNew === undefined) sec.pairNew = parsePathArg(line);
        i++;
        continue;
      }
      if (line.startsWith("rename from ")) {
        sec.renameOld = line.slice("rename from ".length);
        i++;
        continue;
      }
      if (line.startsWith("rename to ")) {
        sec.renameNew = line.slice("rename to ".length);
        i++;
        continue;
      }
      if (line.startsWith("new file mode")) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        sec.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }
  finalizeSection();
  return edits;
}

// SEARCH/REPLACE blocks (SPEC section 7) ---------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const isMarker = (l: string, m: string): boolean => l.replace(/\s+$/, "") === m;
  let prevReplace = -1;
  let prevPath: string | undefined = undefined;
  let i = 0;
  while (i < lines.length) {
    if (!isMarker(lines[i], "<<<<<<< SEARCH")) {
      i++;
      continue;
    }
    const searchLn = i + 1;
    let m = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isMarker(lines[j], "=======")) {
        m = j;
        break;
      }
    }
    if (m < 0) throw new ParseFailure(searchLn);
    let r = -1;
    for (let j = m + 1; j < lines.length; j++) {
      if (isMarker(lines[j], ">>>>>>> REPLACE")) {
        r = j;
        break;
      }
    }
    if (r < 0) throw new ParseFailure(searchLn);
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line, that is not blank and does not start
    // (trimmed) with three backticks; failing that, the previous block's.
    let foundPath: string | undefined = undefined;
    for (let j = i - 1; j > prevReplace; j--) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (t.startsWith("```")) continue;
      foundPath = t;
      break;
    }
    let usePath: string;
    if (foundPath !== undefined) usePath = foundPath;
    else if (prevPath !== undefined) usePath = prevPath;
    else throw new ParseFailure(searchLn);
    edits.push({
      format: "sr",
      path: usePath,
      oldLines: lines.slice(i + 1, m),
      newLines: lines.slice(m + 1, r),
    });
    prevPath = usePath;
    prevReplace = r;
    i = r + 1;
  }
  return edits;
}

// V4A patches (SPEC section 8) --------------------------------------------------

function parseV4A(lines: string[]): Edit[] {
  let fb = -1;
  for (let j = 0; j < lines.length; j++) {
    if (!isBlankLine(lines[j])) {
      fb = j;
      break;
    }
  }
  if (fb < 0) throw new ParseFailure(1);
  if (lines[fb].trim() !== "*** Begin Patch") throw new ParseFailure(fb + 1);
  let lb = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!isBlankLine(lines[j])) {
      lb = j;
      break;
    }
  }
  if (lines[lb].trim() !== "*** End Patch") throw new ParseFailure(lines.length + 1);

  const edits: Edit[] = [];
  const secKind = (l: string): "add" | "del" | "upd" | null => {
    if (l.startsWith("*** Add File:")) return "add";
    if (l.startsWith("*** Delete File:")) return "del";
    if (l.startsWith("*** Update File:")) return "upd";
    return null;
  };

  let i = fb + 1;
  while (i < lb) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const kind = secKind(line);
    if (kind === null) throw new ParseFailure(i + 1);
    const headerLn = i + 1;
    const prefix =
      kind === "add" ? "*** Add File:" : kind === "del" ? "*** Delete File:" : "*** Update File:";
    const secPath = line.slice(prefix.length).trim();
    const content: { line: string; ln: number }[] = [];
    let j = i + 1;
    while (j < lb && secKind(lines[j]) === null) {
      content.push({ line: lines[j], ln: j + 1 });
      j++;
    }
    // Blank lines at the end of a section are not part of it.
    while (content.length > 0 && isBlankLine(content[content.length - 1].line)) content.pop();

    if (kind === "add") {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.line.startsWith("+")) fileLines.push(c.line.slice(1));
        else if (c.line === "") fileLines.push("");
        else throw new ParseFailure(c.ln);
      }
      edits.push({ format: "v4a-add", path: secPath, fileLines });
    } else if (kind === "del") {
      if (content.length > 0) throw new ParseFailure(content[0].ln);
      edits.push({ format: "v4a-del", path: secPath });
    } else {
      let moveTo: string | undefined = undefined;
      let rest = content;
      if (rest.length > 0 && rest[0].line.startsWith("*** Move to:")) {
        moveTo = rest[0].line.slice("*** Move to:".length).trim();
        rest = rest.slice(1);
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let started = false;
      const closeCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (const c of rest) {
        const l = c.line;
        if (l.startsWith("@@")) {
          closeCur();
          const a = l.slice(2).trim();
          cur = { anchor: a === "" ? null : a, eof: false, entries: [] };
          started = true;
        } else if (l.trim() === "*** End of File") {
          if (cur !== null) {
            cur.eof = true;
            closeCur();
          } else {
            chunks.push({ anchor: null, eof: true, entries: [] });
            started = true;
          }
        } else if (l.startsWith("*** Move to:")) {
          throw new ParseFailure(c.ln);
        } else if (l === "" || l.startsWith(" ") || l.startsWith("-") || l.startsWith("+")) {
          if (cur === null) {
            if (started) throw new ParseFailure(c.ln);
            cur = { anchor: null, eof: false, entries: [] };
            started = true;
          }
          pushBody(cur.entries, l);
        } else {
          throw new ParseFailure(c.ln);
        }
      }
      closeCur();
      if (chunks.length === 0 && moveTo === undefined) throw new ParseFailure(headerLn);
      edits.push({ format: "v4a-upd", path: secPath, moveTo, chunks });
    }
    i = j;
  }
  return edits;
}

// JSON edits (SPEC section 9) -----------------------------------------------------

function validateJSONEdit(o: unknown, ln: number): JSONEdit {
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new ParseFailure(ln);
  const rec = o as Record<string, unknown>;
  const p = rec["path"];
  const cmd = rec["command"];
  if (typeof p !== "string" || typeof cmd !== "string") throw new ParseFailure(ln);
  if (cmd === "create") {
    const ft = rec["file_text"];
    if (typeof ft !== "string") throw new ParseFailure(ln);
    return { format: "json", command: "create", path: p, fileText: ft };
  }
  if (cmd === "str_replace") {
    const os = rec["old_str"];
    const ns = rec["new_str"];
    if (typeof os !== "string" || os === "") throw new ParseFailure(ln);
    if (ns !== undefined && typeof ns !== "string") throw new ParseFailure(ln);
    return {
      format: "json",
      command: "str_replace",
      path: p,
      oldStr: os,
      newStr: ns === undefined ? "" : (ns as string),
    };
  }
  if (cmd === "insert") {
    const il = rec["insert_line"];
    const ns = rec["new_str"];
    if (typeof il !== "number" || !Number.isInteger(il)) throw new ParseFailure(ln);
    if (typeof ns !== "string") throw new ParseFailure(ln);
    return { format: "json", command: "insert", path: p, insertLine: il, newStr: ns };
  }
  throw new ParseFailure(ln);
}

function parseJSON(text: string, lines: string[]): Edit[] {
  let fb = -1;
  for (let j = 0; j < lines.length; j++) {
    if (!isBlankLine(lines[j])) {
      fb = j;
      break;
    }
  }
  if (fb < 0) return [];
  if (lines[fb].trim().startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseFailure(fb + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFailure(fb + 1);
    return arr.map((o) => validateJSONEdit(o, fb + 1));
  }
  const edits: Edit[] = [];
  for (let j = 0; j < lines.length; j++) {
    if (isBlankLine(lines[j])) continue;
    let o: unknown;
    try {
      o = JSON.parse(lines[j]);
    } catch {
      throw new ParseFailure(j + 1);
    }
    edits.push(validateJSONEdit(o, j + 1));
  }
  return edits;
}

// Applying edits -------------------------------------------------------------------

interface MovePair {
  oldP: string;
  newP: string;
}

function applyUnifiedHunks(
  st: FileState,
  hunks: Hunk[],
  strict: boolean
): { state: FileState } | { failure: string } {
  const lines = [...st.lines];
  let endsBreak = st.endsBreak;
  let d = 0;
  for (const h of hunks) {
    const o = oldTexts(h.entries);
    const nCount = h.entries.filter((e) => e.t === "ctx" || e.t === "new").length;
    const bsAfter = backslashAfterLastCtxOrNew(h.entries);
    if (o.length > 0) {
      const m = matchFirstTier(lines, o, strict);
      if (m === null) return { failure: "no-match" };
      // Of the occurrences at the tier where O is found, take the one whose
      // 0-based position is nearest to A - 1 + d; of two equally near, the
      // earlier.
      const target = h.a - 1 + d;
      let pos = m.positions[0];
      let best = Math.abs(pos - target);
      for (const p of m.positions) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const written = buildWritten(h.entries, lines, pos, m.tier, o);
      const toEnd = pos + o.length === lines.length;
      lines.splice(pos, o.length, ...written);
      if (toEnd) endsBreak = !bsAfter;
      d += nCount - o.length;
    } else {
      // Empty O: N is inserted after the first A + d lines (all of them when
      // the file has fewer).
      let insertPos = h.a + d;
      if (insertPos < 0) insertPos = 0;
      if (insertPos > lines.length) insertPos = lines.length;
      const written: string[] = [];
      for (const e of h.entries) if (e.t === "new") written.push(e.s);
      const atEnd = insertPos === lines.length;
      lines.splice(insertPos, 0, ...written);
      if (atEnd) endsBreak = !bsAfter;
      d += written.length;
    }
  }
  return { state: { lines, brk: st.brk, endsBreak } };
}

function applyUnified(
  tree: Tree,
  edit: UnifiedEdit,
  strict: boolean,
  moves: MovePair[]
): Failure | null {
  // Every path an edit names is checked for safety before anything else.
  if (edit.oldPath !== null && !isSafePath(edit.oldPath)) {
    return { code: "unsafe", path: edit.oldPath };
  }
  if (edit.newPath !== null && !isSafePath(edit.newPath)) {
    return { code: "unsafe", path: edit.newPath };
  }
  if (edit.isCreate) {
    const np = edit.newPath;
    if (np === null) return null;
    if (tree.exists(np)) return { code: "exists", path: np };
    const fileLines: string[] = [];
    let lastH = -1;
    let lastIdx = -1;
    edit.hunks.forEach((h, hi) => {
      h.entries.forEach((e, ei) => {
        if (e.t === "new") {
          fileLines.push(e.s);
          lastH = hi;
          lastIdx = ei;
        }
      });
    });
    // A created file ends with a line break unless a \ line follows its
    // last + line.
    let endsBreak = false;
    if (lastH >= 0) {
      const after = edit.hunks[lastH].entries[lastIdx + 1];
      endsBreak = !(after !== undefined && after.t === "bs");
    }
    tree.set(np, { lines: fileLines, brk: "\n", endsBreak });
    return null;
  }
  if (edit.isDelete) {
    const op = edit.oldPath;
    if (op === null) return null;
    if (!tree.exists(op)) return { code: "missing", path: op };
    tree.remove(op);
    return null;
  }
  const op = edit.oldPath;
  const np = edit.newPath;
  if (op === null || np === null) return null;
  const st = tree.get(op);
  if (st === null) return { code: "missing", path: op };
  const isMove = op !== np;
  if (isMove && tree.exists(np)) return { code: "exists", path: np };
  const res = applyUnifiedHunks(st, edit.hunks, strict);
  if ("failure" in res) return { code: res.failure, path: op };
  if (isMove) {
    tree.remove(op);
    tree.set(np, res.state);
    moves.push({ oldP: op, newP: np });
  } else {
    tree.set(op, res.state);
  }
  return null;
}

function applySR(tree: Tree, edit: SREdit, strict: boolean): Failure | null {
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (edit.oldLines.length === 0) {
    if (tree.exists(edit.path)) return { code: "exists", path: edit.path };
    tree.set(edit.path, {
      lines: [...edit.newLines],
      brk: "\n",
      endsBreak: edit.newLines.length > 0,
    });
    return null;
  }
  const st = tree.get(edit.path);
  if (st === null) return { code: "missing", path: edit.path };
  // The old lines must occur at their tier exactly once: the first tier at
  // which they occur decides — once replaces, more than once is ambiguous.
  let chosen: { tier: Tier; pos: number } | null = null;
  for (const tier of tiersToTry(strict)) {
    const positions = occurrences(st.lines, edit.oldLines, tier);
    if (positions.length > 1) return { code: "ambiguous", path: edit.path };
    if (positions.length === 1) {
      chosen = { tier, pos: positions[0] };
      break;
    }
  }
  if (chosen === null) return { code: "no-match", path: edit.path };
  const entries: BodyEntry[] = [
    ...edit.oldLines.map((s) => ({ t: "old" as const, s })),
    ...edit.newLines.map((s) => ({ t: "new" as const, s })),
  ];
  const written = buildWritten(entries, st.lines, chosen.pos, chosen.tier, edit.oldLines);
  const lines = [...st.lines];
  lines.splice(chosen.pos, edit.oldLines.length, ...written);
  tree.set(edit.path, { lines, brk: st.brk, endsBreak: st.endsBreak });
  return null;
}

function applyV4AAdd(tree: Tree, edit: V4AAddEdit): Failure | null {
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (tree.exists(edit.path)) return { code: "exists", path: edit.path };
  tree.set(edit.path, {
    lines: [...edit.fileLines],
    brk: "\n",
    endsBreak: edit.fileLines.length > 0,
  });
  return null;
}

function applyV4ADel(tree: Tree, edit: V4ADelEdit): Failure | null {
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (!tree.exists(edit.path)) return { code: "missing", path: edit.path };
  tree.remove(edit.path);
  return null;
}

function applyV4AUpd(
  tree: Tree,
  edit: V4AUpdEdit,
  strict: boolean,
  moves: MovePair[]
): Failure | null {
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (edit.moveTo !== undefined && !isSafePath(edit.moveTo)) {
    return { code: "unsafe", path: edit.moveTo };
  }
  const st = tree.get(edit.path);
  if (st === null) return { code: "missing", path: edit.path };
  if (edit.moveTo !== undefined && tree.exists(edit.moveTo)) {
    return { code: "exists", path: edit.moveTo };
  }
  const lines = [...st.lines];
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.anchor !== null) {
      // The anchor is the first line at or after the cursor equal to it at
      // the first tier where one is; the cursor moves past it.
      let found = -1;
      for (const tier of tiersToTry(strict)) {
        for (let p = cursor; p < lines.length; p++) {
          if (lineEq(lines[p], chunk.anchor, tier)) {
            found = p;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) return { code: "no-match", path: edit.path };
      cursor = found + 1;
    }
    const o = oldTexts(chunk.entries);
    if (o.length > 0) {
      let chosen: { tier: Tier; pos: number } | null = null;
      for (const tier of tiersToTry(strict)) {
        const positions = occurrences(lines, o, tier).filter(
          (p) => p >= cursor && (!chunk.eof || p + o.length === lines.length)
        );
        if (positions.length > 0) {
          chosen = { tier, pos: positions[0] };
          break;
        }
      }
      if (chosen === null) return { code: "no-match", path: edit.path };
      const written = buildWritten(chunk.entries, lines, chosen.pos, chosen.tier, o);
      lines.splice(chosen.pos, o.length, ...written);
      cursor = chosen.pos + written.length;
    } else {
      const insertPos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
      const written: string[] = [];
      for (const e of chunk.entries) if (e.t === "new") written.push(e.s);
      lines.splice(insertPos, 0, ...written);
      cursor = insertPos + written.length;
    }
  }
  const state: FileState = { lines, brk: st.brk, endsBreak: st.endsBreak };
  if (edit.moveTo !== undefined) {
    tree.remove(edit.path);
    tree.set(edit.moveTo, state);
    moves.push({ oldP: edit.path, newP: edit.moveTo });
  } else {
    tree.set(edit.path, state);
  }
  return null;
}

function applyJSON(tree: Tree, edit: JSONEdit): Failure | null {
  if (!isSafePath(edit.path)) return { code: "unsafe", path: edit.path };
  if (edit.command === "create") {
    if (tree.exists(edit.path)) return { code: "exists", path: edit.path };
    // A JSON create writes its file_text byte for byte; the line model is
    // derived from those bytes so later edits see the same file.
    tree.set(edit.path, deriveState(edit.fileText as string));
    return null;
  }
  const st = tree.get(edit.path);
  if (st === null) return { code: "missing", path: edit.path };
  if (edit.command === "str_replace") {
    // Exact match on the text; in a CRLF file the text and both strings are
    // read with every \r\n as \n and the result written back with \r\n.
    let text = renderState(st);
    let oldS = edit.oldStr as string;
    let newS = edit.newStr as string;
    if (st.brk === "\r\n") {
      text = text.split("\r\n").join("\n");
      oldS = oldS.split("\r\n").join("\n");
      newS = newS.split("\r\n").join("\n");
    }
    let count = 0;
    let firstIdx = -1;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(oldS, from);
      if (idx < 0) break;
      count++;
      if (firstIdx < 0) firstIdx = idx;
      from = idx + 1; // positions may overlap
    }
    if (count === 0) return { code: "no-match", path: edit.path };
    if (count > 1) return { code: "ambiguous", path: edit.path };
    let result = text.slice(0, firstIdx) + newS + text.slice(firstIdx + oldS.length);
    if (st.brk === "\r\n") result = result.split("\n").join("\r\n");
    tree.set(edit.path, deriveState(result));
    return null;
  }
  // insert: new_str's lines go after line insert_line (0 is the top); the
  // file's final break stays as it was.
  const il = edit.insertLine as number;
  if (il < 0 || il > st.lines.length) return { code: "no-match", path: edit.path };
  const ins = splitPatchLines(edit.newStr as string);
  const lines = [...st.lines];
  lines.splice(il, 0, ...ins);
  tree.set(edit.path, { lines, brk: st.brk, endsBreak: st.endsBreak });
  return null;
}

function applyEdit(
  tree: Tree,
  edit: Edit,
  strict: boolean,
  moves: MovePair[]
): Failure | null {
  if (edit.format === "unified") return applyUnified(tree, edit, strict, moves);
  if (edit.format === "sr") return applySR(tree, edit, strict);
  if (edit.format === "v4a-add") return applyV4AAdd(tree, edit);
  if (edit.format === "v4a-del") return applyV4ADel(tree, edit);
  if (edit.format === "v4a-upd") return applyV4AUpd(tree, edit, strict, moves);
  return applyJSON(tree, edit);
}

// Detecting the format (SPEC section 4) ---------------------------------------------

function detectFormat(lines: string[]): string | null {
  let fb = -1;
  for (let j = 0; j < lines.length; j++) {
    if (!isBlankLine(lines[j])) {
      fb = j;
      break;
    }
  }
  if (fb >= 0 && lines[fb].trim() === "*** Begin Patch") return "v4a";
  if (fb >= 0) {
    const t = lines[fb].trimStart();
    if (t.startsWith("[") || t.startsWith("{")) return "json";
  }
  for (const l of lines) {
    if (l.replace(/\s+$/, "") === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].startsWith("diff --git ")) return "unified";
    if (lines[j].startsWith("--- ") && j + 1 < lines.length && lines[j + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  return null;
}

// Invocation (SPEC sections 1 and 2) ---------------------------------------------------

interface CliOptions {
  format: string;
  check: boolean;
  strict: boolean;
  patchArg: string | null;
}

// Returns null on a usage error.
function parseArgs(argv: string[]): CliOptions | null {
  const formats = ["unified", "search-replace", "v4a", "json", "auto"];
  let format = "auto";
  let formatSeen = false;
  let check = false;
  let strict = false;
  let patchArg: string | null = null;
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg === "--check") {
      if (check) return null;
      check = true;
      continue;
    }
    if (!afterDashDash && arg === "--strict") {
      if (strict) return null;
      strict = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith("--format=")) {
      if (formatSeen) return null;
      formatSeen = true;
      const v = arg.slice("--format=".length);
      if (!formats.includes(v)) return null;
      format = v;
      continue;
    }
    if (!afterDashDash && arg.startsWith("-") && arg !== "-") return null;
    if (patchArg !== null) return null;
    patchArg = arg;
  }
  return { format, check, strict, patchArg };
}

function outLine(s: string): void {
  fs.writeSync(1, s + "\n");
}

function exitWith(code: number): never {
  process.exit(code);
}

function cliMain(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    outLine("error: usage");
    exitWith(2);
  }
  let patchText: string;
  if (opts.patchArg === null || opts.patchArg === "-") {
    try {
      patchText = fs.readFileSync(0, "utf8");
    } catch {
      outLine("error: no-patch");
      exitWith(2);
    }
  } else {
    try {
      patchText = fs.readFileSync(opts.patchArg, "utf8");
    } catch {
      outLine("error: no-patch");
      exitWith(2);
    }
  }
  const patchLines = splitPatchLines(patchText);
  let fmt = opts.format;
  if (fmt === "auto") {
    const detected = detectFormat(patchLines);
    if (detected === null) {
      outLine("error: format");
      exitWith(2);
    }
    fmt = detected;
  }
  let edits: Edit[];
  try {
    if (fmt === "unified") edits = parseUnified(patchLines);
    else if (fmt === "search-replace") edits = parseSearchReplace(patchLines);
    else if (fmt === "v4a") edits = parseV4A(patchLines);
    else edits = parseJSON(patchText, patchLines);
  } catch (e) {
    if (e instanceof ParseFailure) {
      outLine("error: parse " + e.line);
      exitWith(2);
    }
    throw e;
  }
  if (edits.length === 0) {
    outLine("error: parse 1");
    exitWith(2);
  }

  const tree = new Tree();
  const moves: MovePair[] = [];
  const failures: Failure[] = [];
  for (const edit of edits) {
    const f = applyEdit(tree, edit, opts.strict, moves);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    for (const f of failures) outLine("error: " + f.code + " " + f.path);
    outLine("failed: " + failures.length + " of " + edits.length + " edits");
    exitWith(1);
  }
  if (!opts.check) tree.writeAll();

  // One report line for each path whose state changed, in byte order of the
  // paths (UTF-8); a successful move edit's R line replaces its pair's D and
  // A lines and sorts by the new path. The count counts report lines.
  const reportLines: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  const rPairs: MovePair[] = [];
  for (const mv of moves) {
    const beforeOld = tree.initialRaw(mv.oldP);
    const afterOld = tree.finalRaw(mv.oldP);
    const beforeNew = tree.initialRaw(mv.newP);
    const afterNew = tree.finalRaw(mv.newP);
    if (beforeOld !== null && afterOld === null && beforeNew === null && afterNew !== null) {
      rPairs.push(mv);
      suppressed.add("A:" + mv.newP);
      suppressed.add("D:" + mv.oldP);
    }
  }
  for (const p of tree.touchedPaths()) {
    const before = tree.initialRaw(p);
    const after = tree.finalRaw(p);
    if (before === null && after !== null) {
      if (!suppressed.has("A:" + p)) reportLines.push({ key: p, text: "A " + p });
    } else if (before !== null && after === null) {
      if (!suppressed.has("D:" + p)) reportLines.push({ key: p, text: "D " + p });
    } else if (before !== null && after !== null && before !== after) {
      reportLines.push({ key: p, text: "M " + p });
    }
  }
  for (const mv of rPairs) {
    reportLines.push({ key: mv.newP, text: "R " + mv.oldP + " -> " + mv.newP });
  }
  reportLines.sort((x, y) => Buffer.compare(Buffer.from(x.key, "utf8"), Buffer.from(y.key, "utf8")));
  for (const rl of reportLines) outLine(rl.text);
  outLine(reportLines.length === 1 ? "ok: 1 file" : "ok: " + reportLines.length + " files");
  exitWith(0);
}

// Hand-over: when the make.fun harness drives this file (MAKEFUN_ENV_URL
// set), runner.ts takes over; otherwise the mend CLI runs.
if (process.env.MAKEFUN_ENV_URL) {
  await import("./runner.ts");
} else {
  cliMain();
}
