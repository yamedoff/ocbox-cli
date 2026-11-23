// mapcore — shared rules for map.json. One source of truth used by:
//  - the repo CLI (compiled to kit/tools/map/mapcore.mjs)
//  - the architecture-map Worker (GitHub sync)
//  - the custom block (kind/zone rules)
// Keep this file dependency-free.
export const KINDS = ["app", "cdn", "gateway", "service", "worker", "queue", "cache", "database", "storage", "outside"];
export const ZONES = ["public", "private", "outside"];
export const STATUSES = ["live", "planned", "deprecated"];
export const CONN_KINDS = ["request", "queue", "database", "event", "email"];
export const CODE_KINDS = ["file", "function", "class", "route", "job", "config"];
export const LIMITS = { summary: 300, story: 300, label: 80, name: 60, title: 100, snippetLines: 30, buildings: 80, code: 400, journeys: 40, steps: 40,
    areas: 16, failureSteps: 10, stepCode: 5, guides: 80, bigUnit: 300, bigFile: 200, thinStory: 80, docSlack: 15 };
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const OP = /^openapi:[A-Za-z0-9_.-]+$/;
const TOP = new Set(["$schema", "version", "repo", "visibility", "openapi", "buildings", "connections", "code", "journeys", "guides"]);
const FIELDS = {
    building: new Set(["id", "name", "kind", "zone", "status", "path", "summary", "serves", "via", "areas", "was"]),
    area: new Set(["id", "name", "summary", "path"]),
    connection: new Set(["id", "from", "to", "kind", "label", "status", "via"]),
    code: new Set(["id", "building", "area", "name", "kind", "path", "lines", "symbol", "summary", "calls", "snippet", "was"]),
    journey: new Set(["id", "name", "summary", "status", "trigger", "steps", "was"]),
    step: new Set(["story", "building", "connection", "code", "repeat", "on_failure"]),
    guide: new Set(["id", "title", "path", "about", "journeys"]),
};
/** Default zone for a kind: outside services sit across the water, edge pieces in front of the wall. */
export function defaultZone(kind) {
    if (kind === "outside")
        return "outside";
    if (kind === "app" || kind === "cdn")
        return "public";
    return "private";
}
export function connId(c) {
    return c.id || `${c.from}--${c.to.replace(/^openapi:/, "op-")}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48);
}
export function keyOf(repo, type, id) {
    return `${repo}:${type === "building" ? "" : type + "/"}${id}`;
}
/** A step's code entries, whether written as one id or a list. */
export const stepCodes = (st) => (Array.isArray(st.code) ? st.code : st.code ? [st.code] : []);
/** Parse "12-48" or "12". */
export function parseLines(l) {
    if (!l)
        return null;
    const m = /^(\d+)(?:-(\d+))?$/.exec(String(l).trim());
    if (!m)
        return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    return a >= 1 && b >= a ? [a, b] : null;
}
export function parseOpenapiOps(text) {
    const out = new Set();
    for (const m of text.matchAll(/operationId["']?\s*:\s*["']?([A-Za-z0-9_.-]+)/g))
        out.add(m[1]);
    return out;
}
// ---------- callers: other repos that call this repo's API ----------
const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);
/** operationId -> "METHOD /path". A line scanner for block-style YAML (or JSON), not a full parser. */
export function openapiRoutes(text) {
    const out = new Map();
    if (/^\s*\{/.test(text)) {
        try {
            const doc = JSON.parse(text);
            for (const [path, item] of Object.entries(doc.paths || {}))
                for (const [m, op] of Object.entries(item || {}))
                    if (METHODS.has(m) && op && typeof op.operationId === "string")
                        out.set(op.operationId, `${m.toUpperCase()} ${path}`);
        }
        catch { /* not JSON: fall through to the YAML scanner */ }
        if (out.size)
            return out;
    }
    let inPaths = false, pathIndent = -1, path = "", methodIndent = -1, method = "";
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line))
            continue;
        const indent = line.length - line.trimStart().length;
        if (indent === 0) {
            inPaths = /^paths\s*:\s*$/.test(line);
            path = "";
            method = "";
            pathIndent = -1;
            continue;
        }
        if (!inPaths)
            continue;
        const key = /^\s*(['"]?)([^'":]+)\1\s*:/.exec(line)?.[2];
        if (key?.startsWith("/") && (pathIndent < 0 || indent === pathIndent)) {
            pathIndent = indent;
            path = key;
            method = "";
            methodIndent = -1;
            continue;
        }
        if (path && key && METHODS.has(key) && indent > pathIndent && (methodIndent < 0 || indent === methodIndent)) {
            methodIndent = indent;
            method = key;
            continue;
        }
        if (method && indent <= methodIndent)
            method = "";
        const id = /^\s*operationId\s*:\s*['"]?([A-Za-z0-9_.-]+)/.exec(line)?.[1];
        if (id && path && method)
            out.set(id, `${method.toUpperCase()} ${path}`);
    }
    return out;
}
/** Where a map uses each openapi:<operationId> (connections, journey triggers, served operations). */
export function operationsUsed(map) {
    const out = new Map(), add = (ref, where) => {
        if (typeof ref !== "string" || !OP.test(ref))
            return;
        const id = ref.slice(8);
        out.set(id, [...(out.get(id) || []), where]);
    };
    for (const c of map.connections || [])
        add(c.to, `connection ${connId(c)}`);
    for (const j of map.journeys || [])
        add(j.trigger, `journey ${j.id}`);
    return out;
}
/**
 * Cross-repo contract check, run in the repo that serves the API. A caller (another repo's map.json) must only
 * use operations that still exist here, at the same method and path as the caller's own copy of the OpenAPI file.
 * Errors: an operation the caller uses is gone, or moved. Warning: the caller's copy differs from this repo's file.
 */
export function checkCallers(caller, callerMap, providerSpec, callerSpec) {
    const out = [];
    const here = openapiRoutes(providerSpec), theirs = callerSpec === null ? null : openapiRoutes(callerSpec);
    const used = operationsUsed(callerMap);
    for (const [id, where] of [...used].sort((a, b) => a[0].localeCompare(b[0]))) {
        const at = where.slice(0, 3).join(", ") + (where.length > 3 ? ", …" : "");
        if (!here.has(id))
            out.push({ level: "error", rule: "X-1", path: caller, message: `X-1: ${caller} calls ${id} (${at}) but this repo's OpenAPI file no longer has it` });
        else if (theirs?.has(id) && theirs.get(id) !== here.get(id))
            out.push({ level: "error", rule: "X-1", path: caller, message: `X-1: ${id} is ${here.get(id)} here but ${caller}'s copy says ${theirs.get(id)} (${at})` });
    }
    if (callerSpec === null)
        out.push({ level: "warning", rule: "X-2", path: caller, message: `X-2: ${caller} has no OpenAPI copy set in its map.json ("openapi"), so methods and paths were not compared` });
    else if (callerSpec.replace(/\r\n/g, "\n").trimEnd() !== providerSpec.replace(/\r\n/g, "\n").trimEnd()) {
        const a = callerSpec.split(/\r?\n/), b = providerSpec.split(/\r?\n/), A = new Set(a), B = new Set(b);
        const changed = a.filter((l) => !B.has(l)).length + b.filter((l) => !A.has(l)).length;
        const added = [...here.keys()].filter((id) => !theirs.has(id)).sort();
        out.push({ level: "warning", rule: "X-2", path: caller, message: `X-2: ${caller}'s copy of the OpenAPI file is out of date (about ${changed} line${changed === 1 ? "" : "s"} differ${added.length ? `; new here: ${added.slice(0, 6).join(", ")}${added.length > 6 ? ", …" : ""}` : ""}). Update its copy` });
    }
    return out;
}
const isRelPath = (p) => !!p && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes("..") && !/^~/.test(p);
const INDENT_LANG = /\.(py|pyi|rb|ya?ml|coffee)$/i;
const KW_BLOCK = "function\\*?|class|def|func|fn|struct|enum|interface|trait|impl|module|object|record|namespace|protocol|extension";
const KW_VALUE = "const|let|var|val|type";
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function candidates(lines, name, from, to) {
    const n = reEsc(name), L = "(?<![\\w$#])", R = "(?![\\w$])";
    const mods = "(?:(?:export|default|public|private|protected|internal|static|async|override|readonly|abstract|final|get|set|pub(?:\\([^)]*\\))?|unsafe|declare)\\s+)*";
    const pats = [
        [new RegExp(`\\b(?:${KW_BLOCK})\\s+(?:\\([^)]*\\)\\s*)?${L}${n}${R}`), "block"],
        [new RegExp(`\\b(?:${KW_VALUE})\\s+${L}${n}${R}`), "value"],
        [new RegExp(`${L}${n}${R}\\s*(?::[^=;(]*)?=\\s*(?:async\\s+)?(?:function\\b|\\(|<|[\\w$]+\\s*=>)`), "value"],
        [new RegExp(`${L}${n}${R}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\(|<|[\\w$]+\\s*=>)`), "value"],
        [new RegExp(`^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*${mods}\\*?\\s*${L}${n}${R}\\s*(?:<[^>]*>)?\\s*\\(`), "method"],
        [new RegExp(`^\\s*["']?${L}${n}${R}["']?\\s*[:=]`), "key"],
    ];
    const out = [];
    for (let i = from; i < to && i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*(?:\/\/|\/\*|\*|#(?![\w$!\[]))/.test(l))
            continue;
        for (const [re, kind] of pats) {
            const m = re.exec(l);
            if (m) {
                out.push({ line: i, col: kind === "method" || kind === "key" ? l.length - l.trimStart().length : m.index, kind });
                break;
            }
        }
    }
    return out;
}
function lineStarts(t) { const o = [0]; for (let i = 0; i < t.length; i++)
    if (t[i] === "\n")
        o.push(i + 1); return o; }
function lineAt(starts, idx) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= idx)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo;
}
/** Does the statement continue on the next line? */
function continues(t, nl, last) {
    if (/[=,(\[{+\-*/%&|?:.<>!~^]/.test(last))
        return true;
    let j = nl + 1;
    while (j < t.length && /\s/.test(t[j]))
        j++;
    return /^(?:\.(?!\.\.)|\?|:|\|\||&&|\||&|\+|-(?!-)|\*|\/(?![/*])|=>|=(?!=)|,|as\b|satisfies\b|extends\b|implements\b)/.test(t.slice(j, j + 12));
}
/** Scan from i0 to the end of the unit. block = a declaration with a body (function, class, method). */
function scan(t, i0, block) {
    let p = 0, k = 0, b = 0, a = 0, body = false, bodyAt = -1, last = "", started = false, sigDone = false, i = i0;
    const tpl = [], N = t.length;
    const tplRest = (j) => {
        while (j < N) {
            const c = t[j];
            if (c === "\\") {
                j += 2;
                continue;
            }
            if (c === "`")
                return j + 1;
            if (c === "$" && t[j + 1] === "{") {
                tpl.push(b);
                b++;
                return j + 2;
            }
            j++;
        }
        return N;
    };
    const regexOk = () => !last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw)\s*$/.test(t.slice(Math.max(0, i - 12), i));
    while (i < N) {
        const c = t[i], d = t[i + 1];
        if (c === "/" && d === "/") {
            const e = t.indexOf("\n", i);
            i = e < 0 ? N : e;
            continue;
        }
        if (c === "/" && d === "*") {
            const e = t.indexOf("*/", i + 2);
            i = e < 0 ? N : e + 2;
            continue;
        }
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < N && t[j] !== c && t[j] !== "\n")
                j += t[j] === "\\" ? 2 : 1;
            i = j + 1;
            last = c;
            started = true;
            continue;
        }
        if (c === "`") {
            i = tplRest(i + 1);
            last = "`";
            started = true;
            continue;
        }
        if (c === "/" && regexOk()) {
            let j = i + 1, cls = false;
            while (j < N && t[j] !== "\n") {
                const x = t[j];
                if (x === "\\") {
                    j += 2;
                    continue;
                }
                if (x === "[")
                    cls = true;
                else if (x === "]")
                    cls = false;
                else if (x === "/" && !cls)
                    break;
                j++;
            }
            i = j + 1;
            while (i < N && /[a-z]/i.test(t[i]))
                i++;
            last = "/";
            started = true;
            continue;
        }
        if (c === "\n") {
            if (!block && started && p <= 0 && k <= 0 && b <= 0 && !continues(t, i, last))
                return { end: i - 1, body };
            // a signature that ends at the line break and isn't followed by its body is a call or an overload, not a definition
            if (block && !body && sigDone && p === 0 && k === 0 && a === 0 && !/^\s*(?:\{|:|->|=>|throws\b|where\b|extends\b|implements\b|\||&|\.|,)/.test(t.slice(i + 1, i + 40)))
                return { end: i - 1, body: false };
            i++;
            continue;
        }
        if (c === " " || c === "\t" || c === "\r") {
            i++;
            continue;
        }
        if ((c === "=" || c === "-") && d === ">") {
            i += 2;
            last = ">";
            started = true;
            continue;
        }
        if (c === "(")
            p++;
        else if (c === ")") {
            p--;
            if (p < 0)
                return { end: i - 1, body };
            if (p === 0 && block && !body)
                sigDone = true;
        }
        else if (c === "[")
            k++;
        else if (c === "]") {
            k--;
            if (k < 0)
                return { end: i - 1, body };
        }
        else if (c === "<" && block && !body && /[\w$>]/.test(last))
            a++;
        else if (c === ">" && block && !body && a > 0)
            a--;
        else if (c === "{") {
            if (block && !body && p === 0 && k === 0 && a === 0 && !/[:|&,=?]/.test(last)) {
                body = true;
                bodyAt = b;
            }
            b++;
        }
        else if (c === "}") {
            b--;
            if (tpl.length && b === tpl[tpl.length - 1]) {
                tpl.pop();
                i = tplRest(i + 1);
                last = "`";
                continue;
            }
            if (block && body && b === bodyAt)
                return { end: i, body };
            if (b < 0)
                return { end: i - 1, body };
        }
        else if (c === ";" && p === 0 && k === 0 && b === 0 && (!block || !body))
            return { end: i, body };
        else if (c === "," && !block && p === 0 && k === 0 && b === 0)
            return { end: i - 1, body };
        last = c;
        started = true;
        i++;
    }
    return { end: N - 1, body };
}
function indentEnd(lines, s) {
    const ind = (x) => x.length - x.trimStart().length, base = ind(lines[s]);
    let depth = 0, i = s;
    for (; i < lines.length; i++) {
        for (const ch of lines[i].replace(/\s#.*$/, "")) {
            if ("([{".includes(ch))
                depth++;
            else if (")]}".includes(ch))
                depth--;
        }
        if (depth <= 0)
            break;
    }
    let e = Math.min(i, lines.length - 1);
    for (let j = e + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim())
            continue;
        if (ind(l) > base)
            e = j;
        else
            break;
    }
    return e;
}
function unitAt(text, lines, starts, c, indent) {
    if (indent) {
        const e = indentEnd(lines, c.line);
        return { start: c.line + 1, end: e + 1, body: e > c.line };
    }
    const at = starts[c.line] + c.col, r = scan(text, at, c.kind === "block" || c.kind === "method");
    if (c.kind === "method" && !r.body)
        return null;
    const endLine = lineAt(starts, Math.max(at, r.end));
    return { start: c.line + 1, end: endLine + 1, body: c.kind === "value" || c.kind === "key" ? endLine > c.line : r.body };
}
/** Where a symbol's definition lives. near = a 1-based line to prefer when the name is defined more than once. */
export function anchorUnit(text, symbol, opt = {}) {
    const lines = text.split("\n"), starts = lineStarts(text), indent = !!opt.path && INDENT_LANG.test(opt.path);
    const parts = symbol.trim().split(/\.(?=[\w$#])|::/).filter(Boolean);
    if (!parts.length)
        return null;
    let from = 0, to = lines.length, unit = null;
    for (let pi = 0; pi < parts.length; pi++) {
        const pyLike = (l) => !opt.path && /^\s*(async\s+def|def|class)\s[^{]*:\s*(#.*)?$/.test(l);
        const units = candidates(lines, parts[pi], from, to).map((c) => unitAt(text, lines, starts, c, indent || pyLike(lines[c.line]))).filter((u) => !!u);
        if (!units.length)
            return null;
        const withBody = units.filter((u) => u.body), pool = withBody.length ? withBody : units;
        const near = pi === parts.length - 1 ? opt.near : undefined;
        unit = near ? pool.reduce((x, y) => (Math.abs(y.start - near) < Math.abs(x.start - near) ? y : x)) : pool[0];
        from = unit.start;
        to = unit.end;
    }
    return unit;
}
/** "start-end" for a symbol's definition, or null when it can't be found. */
export function anchor(text, symbol, opt = {}) {
    const u = anchorUnit(text, symbol, opt);
    return u ? `${u.start}-${u.end}` : null;
}
// ---------- check ----------
/** Validate a parsed map.json. Never throws. Coverage rules (C-1..C-9) run when the CLI gives file access. */
export function check(map, opt = {}) {
    const out = [];
    const err = (path, message, fix, rule) => out.push({ level: "error", path, message, fix, rule });
    const warn = (path, message, rule) => out.push({ level: "warning", path, message, rule });
    if (!map || typeof map !== "object" || Array.isArray(map)) {
        err("", "map.json must be a JSON object");
        return out;
    }
    const m = map;
    const pub = opt.public ?? m.visibility === "public";
    for (const k of Object.keys(m))
        if (!TOP.has(k))
            err(k, `unknown top-level field "${k}"`);
    if (m.version !== 1)
        err("version", "version must be 1");
    if (typeof m.repo !== "string" || !SLUG.test(m.repo))
        err("repo", "repo must be the repo's short name, like \"opencloudbox\" (not owner/name)");
    if (m.visibility !== undefined && m.visibility !== "public" && m.visibility !== "private")
        err("visibility", "visibility must be public or private");
    if (m.openapi !== undefined && (typeof m.openapi !== "string" || !isRelPath(m.openapi)))
        err("openapi", "openapi must be a repo-relative path");
    const arr = (k, o = m, p = k) => (o[k] === undefined ? [] : Array.isArray(o[k]) ? o[k] : (err(p, `${k} must be a list`), []));
    const B = arr("buildings"), C = arr("connections"), K = arr("code"), J = arr("journeys"), G = arr("guides");
    if (!B.length)
        err("buildings", "add at least one building");
    if (B.length > LIMITS.buildings)
        warn("buildings", `${B.length} buildings is a lot; group small parts into one building and use areas inside it`);
    if (K.length > LIMITS.code)
        warn("code", `${K.length} code entries; keep only the ones a newcomer needs`);
    const fields = (o, path, type) => {
        if (!o || typeof o !== "object" || Array.isArray(o)) {
            err(path, `${type} must be an object`);
            return false;
        }
        for (const k of Object.keys(o))
            if (!FIELDS[type].has(k))
                err(`${path}.${k}`, `unknown field "${k}" on ${type}`);
        return true;
    };
    const text = (o, k, path, max, req = false) => {
        const v = o[k];
        if (v === undefined || v === "") {
            if (req)
                err(`${path}.${k}`, `${k} is required`);
            return;
        }
        if (typeof v !== "string") {
            err(`${path}.${k}`, `${k} must be a string`);
            return;
        }
        if (v.length > max)
            err(`${path}.${k}`, `${k} is ${v.length} chars; keep it under ${max}`);
        if (pub && /https?:\/\//i.test(v))
            warn(`${path}.${k}`, "public repo: avoid URLs in the map");
    };
    const oneOf = (o, k, path, list, req = false) => {
        const v = o[k];
        if (v === undefined) {
            if (req)
                err(`${path}.${k}`, `${k} is required (${list.join(", ")})`);
            return;
        }
        if (!list.includes(v))
            err(`${path}.${k}`, `${k} must be one of ${list.join(", ")}`);
    };
    const ids = (list, label, idOf) => {
        const seen = new Set();
        list.forEach((o, i) => {
            if (!o || typeof o !== "object")
                return;
            const id = idOf(o);
            if (!SLUG.test(id))
                err(`${label}[${i}].id`, `id "${id}" must be a lowercase slug (a-z, 0-9, -)`);
            if (seen.has(id))
                err(`${label}[${i}].id`, `duplicate id "${id}"`);
            seen.add(id);
        });
        return seen;
    };
    const was = (o, p, own) => {
        if (o.was === undefined)
            return;
        if (typeof o.was !== "string" || !SLUG.test(o.was))
            err(`${p}.was`, "was must be the old id (a slug)");
        else if (own.has(o.was))
            err(`${p}.was`, `was "${o.was}" is still an id in this map`);
    };
    const bIds = ids(B, "buildings", (o) => String(o.id ?? ""));
    const byId = new Map(B.filter((b) => b && typeof b === "object").map((b) => [String(b.id), b]));
    const areaIds = new Map();
    B.forEach((b, i) => {
        const p = `buildings[${i}]`;
        if (!fields(b, p, "building"))
            return;
        text(b, "name", p, LIMITS.name, true);
        text(b, "summary", p, LIMITS.summary, true);
        oneOf(b, "kind", p, KINDS, true);
        oneOf(b, "zone", p, ZONES);
        oneOf(b, "status", p, STATUSES);
        was(b, p, bIds);
        if (b.path !== undefined) {
            if (typeof b.path !== "string" || !isRelPath(b.path))
                err(`${p}.path`, "path must be inside the repo (relative, no ..)");
            else if (opt.readFile && opt.readFile(b.path) === null && opt.readFile(b.path.replace(/\/$/, "") + "/") === null)
                warn(`${p}.path`, `folder ${b.path} not found`);
        }
        if (b.kind === "outside" && b.path)
            warn(`${p}.path`, "outside services usually have no path");
        if (b.via !== undefined && (b.via === b.id || !bIds.has(b.via)))
            err(`${p}.via`, `via "${b.via}" must be another building in this map (the gateway callers pass through)`);
        if (b.serves !== undefined) {
            if (!Array.isArray(b.serves))
                err(`${p}.serves`, "serves must be a list like [\"openapi:createBox\"]");
            else {
                b.serves.forEach((s, j) => {
                    if (typeof s !== "string" || !OP.test(s))
                        err(`${p}.serves[${j}]`, "use openapi:<operationId>");
                    else if (opt.openapiOps && !opt.openapiOps.has(s.slice(8)))
                        err(`${p}.serves[${j}]`, `operation ${s.slice(8)} is not in the OpenAPI file`);
                });
                if (b.kind === "gateway" && b.serves.length)
                    warn(`${p}.serves`, "put serves on the service that answers, and set \"via\" on it to this gateway", "D-5");
            }
        }
        const A = arr("areas", b, `${p}.areas`), seen = ids(A, `${p}.areas`, (o) => String(o.id ?? ""));
        areaIds.set(String(b.id), seen);
        if (A.length > LIMITS.areas)
            warn(`${p}.areas`, `${A.length} areas; ${LIMITS.areas} is plenty for one building`);
        A.forEach((a, j) => {
            const q = `${p}.areas[${j}]`;
            if (!fields(a, q, "area"))
                return;
            text(a, "name", q, LIMITS.name, true);
            text(a, "summary", q, LIMITS.summary, true);
            if (a.path !== undefined && (typeof a.path !== "string" || !isRelPath(a.path)))
                err(`${q}.path`, "path must be inside the repo");
        });
    });
    const cIds = ids(C, "connections", (o) => connId(o));
    C.forEach((c, i) => {
        const p = `connections[${i}]`;
        if (!fields(c, p, "connection"))
            return;
        oneOf(c, "kind", p, CONN_KINDS, true);
        oneOf(c, "status", p, STATUSES);
        text(c, "label", p, LIMITS.label);
        if (!bIds.has(c.from))
            err(`${p}.from`, `from "${c.from}" is not a building in this map`);
        const to = c.to;
        if (typeof to !== "string" || !to)
            err(`${p}.to`, "to is required");
        else if (to.startsWith("openapi:")) {
            if (!OP.test(to))
                err(`${p}.to`, "use openapi:<operationId>");
            else if (opt.openapiOps) {
                if (!opt.openapiOps.has(to.slice(8)))
                    err(`${p}.to`, `operation ${to.slice(8)} is not in the OpenAPI file`);
            }
            else if (pub)
                err(`${p}.to`, "public repo: set \"openapi\" in map.json so outside calls can be checked");
        }
        else if (!bIds.has(to))
            err(`${p}.to`, pub ? `to "${to}" must be a building in this map or openapi:<operationId>` : `to "${to}" is not a building in this map (use openapi:<operationId> for another repo)`);
        if (c.via !== undefined && (!bIds.has(c.via) || c.via === c.from || c.via === c.to))
            err(`${p}.via`, `via "${c.via}" must be a third building in this map (the gateway the call passes through)`);
    });
    const kIds = ids(K, "code", (o) => String(o.id ?? ""));
    K.forEach((k, i) => {
        const p = `code[${i}]`;
        if (!fields(k, p, "code"))
            return;
        text(k, "name", p, LIMITS.name, true);
        text(k, "summary", p, LIMITS.summary, true);
        oneOf(k, "kind", p, CODE_KINDS);
        was(k, p, kIds);
        if (!bIds.has(k.building))
            err(`${p}.building`, `building "${k.building}" is not in this map`);
        else if (k.area !== undefined && !areaIds.get(k.building)?.has(k.area))
            err(`${p}.area`, `area "${k.area}" is not an area of ${k.building}`);
        const path = k.path;
        if (typeof path !== "string" || !isRelPath(path)) {
            err(`${p}.path`, "path must be a file inside the repo");
            return;
        }
        if (k.lines !== undefined && !parseLines(k.lines))
            err(`${p}.lines`, "lines must look like \"12-48\"");
        if (k.snippet !== undefined && String(k.snippet).split("\n").length > LIMITS.snippetLines)
            err(`${p}.snippet`, `snippet over ${LIMITS.snippetLines} lines`);
        if (Array.isArray(k.calls))
            k.calls.forEach((c, j) => { if (!kIds.has(c))
                err(`${p}.calls[${j}]`, `calls "${c}" is not a code id in this map`); });
        else if (k.calls !== undefined)
            err(`${p}.calls`, "calls must be a list of code ids");
        const r = parseLines(k.lines);
        if (r && (k.kind === undefined || k.kind === "function" || k.kind === "class") && r[1] - r[0] + 1 > LIMITS.bigUnit)
            warn(`${p}.lines`, `${k.name} spans ${r[1] - r[0] + 1} lines; point at the method that does the work ("symbol": "Class.method") or say why in the summary`, "C-4");
        if (!opt.readFile)
            return;
        const src = opt.readFile(path);
        if (src === null) {
            err(`${p}.path`, `file ${path} not found`);
            return;
        }
        const sym = k.symbol, total = src.split("\n").length;
        if (!sym) {
            if (k.kind !== "file" && k.kind !== "config")
                warn(`${p}.symbol`, "add a symbol so the line range can be checked and kept up to date");
            if (r && r[1] > total)
                err(`${p}.lines`, `lines ${k.lines} go past the end of ${path} (${total} lines)`);
            return;
        }
        const u = anchorUnit(src, sym, { path, near: r?.[0] });
        if (!u) {
            const byName = typeof k.name === "string" && k.name !== sym ? anchorUnit(src, k.name, { path, near: r?.[0] }) : null;
            const hint = byName ? `; "${k.name}" is defined at ${byName.start}-${byName.end}, did you mean "symbol": "${k.name}"?` : "; symbol is the name of the function, class or method this entry is (Class.method for methods)";
            if (!src.includes(sym.split(/\.|::/).pop()))
                err(`${p}.symbol`, `"${sym}" not found in ${path}${byName ? hint : ""}`);
            else
                warn(`${p}.symbol`, `"${sym}" is used in ${path} but not defined there${hint}`);
            return;
        }
        const fix = { lines: `${u.start}-${u.end}` };
        if (!r)
            err(`${p}.lines`, `lines missing: "${sym}" is at ${fix.lines}`, fix);
        else if (r[1] > total)
            err(`${p}.lines`, `lines ${k.lines} go past the end of ${path} (${total} lines); "${sym}" is at ${fix.lines}`, fix);
        else if (r[0] > u.start || r[0] < u.start - LIMITS.docSlack)
            err(`${p}.lines`, `"${sym}" starts at line ${u.start}, not ${r[0]} (now at ${fix.lines})`, fix);
        else if (r[1] < u.end)
            err(`${p}.lines`, `range ends at ${r[1]} but "${sym}" runs to ${u.end}`, fix, "C-5");
        else if (r[1] > u.end + LIMITS.docSlack)
            warn(`${p}.lines`, `range runs to ${r[1]} but "${sym}" ends at ${u.end}`);
    });
    const jIds = ids(J, "journeys", (o) => String(o.id ?? ""));
    const step = (s, q, branch) => {
        if (!fields(s, q, "step"))
            return;
        text(s, "story", q, LIMITS.story, true);
        const codes = s.code === undefined ? [] : Array.isArray(s.code) ? s.code : [s.code];
        if (!s.building && !s.connection && !codes.length)
            err(q, "a step needs building, connection or code");
        if (s.building !== undefined && !bIds.has(s.building))
            err(`${q}.building`, `building "${s.building}" is not in this map`);
        if (s.connection !== undefined && !cIds.has(s.connection))
            err(`${q}.connection`, `connection "${s.connection}" is not in this map`);
        if (codes.length > LIMITS.stepCode)
            err(`${q}.code`, `${codes.length} code entries on one step; split the step`);
        codes.forEach((c) => { if (typeof c !== "string" || !kIds.has(c))
            err(`${q}.code`, `code "${c}" is not in this map`); });
        if (s.repeat !== undefined && typeof s.repeat !== "boolean")
            err(`${q}.repeat`, "repeat must be true or false");
        if (s.on_failure !== undefined) {
            if (branch) {
                err(`${q}.on_failure`, "a failure branch can't have its own on_failure");
                return;
            }
            const F = arr("on_failure", s, `${q}.on_failure`);
            if (!F.length)
                err(`${q}.on_failure`, "on_failure needs at least one step");
            if (F.length > LIMITS.failureSteps)
                warn(`${q}.on_failure`, `${F.length} failure steps; keep the branch short`);
            F.forEach((f, x) => step(f, `${q}.on_failure[${x}]`, true));
        }
    };
    J.forEach((j, i) => {
        const p = `journeys[${i}]`;
        if (!fields(j, p, "journey"))
            return;
        text(j, "name", p, LIMITS.name, true);
        text(j, "summary", p, LIMITS.summary);
        oneOf(j, "status", p, STATUSES);
        was(j, p, jIds);
        if (j.trigger !== undefined && (typeof j.trigger !== "string" || !OP.test(j.trigger)))
            err(`${p}.trigger`, "trigger must be openapi:<operationId>");
        const steps = arr("steps", j, `${p}.steps`);
        if (!steps.length)
            err(`${p}.steps`, "a journey needs at least one step");
        if (steps.length > LIMITS.steps)
            warn(`${p}.steps`, `${steps.length} steps; split the journey`);
        steps.forEach((s, n) => step(s, `${p}.steps[${n}]`, false));
    });
    ids(G, "guides", (o) => String(o.id ?? ""));
    if (G.length > LIMITS.guides)
        warn("guides", `${G.length} guides; merge small ones`);
    G.forEach((g, i) => {
        const p = `guides[${i}]`;
        if (!fields(g, p, "guide"))
            return;
        text(g, "title", p, LIMITS.title, true);
        const path = g.path;
        if (typeof path !== "string" || !isRelPath(path) || !/\.md$/i.test(path))
            err(`${p}.path`, "path must be a markdown file inside the repo, like docs/architecture/api.md");
        else if (opt.readFile) {
            const t = opt.readFile(path);
            if (t === null)
                err(`${p}.path`, `file ${path} not found`);
            else if (!/verified against/i.test(t))
                warn(`${p}.path`, `${path} should end with "Verified against <repo> @ <commit>"`, "D-6");
        }
        const about = Array.isArray(g.about) ? g.about : (err(`${p}.about`, "about must be a list of building ids"), []);
        if (!about.length)
            err(`${p}.about`, "about needs at least one building");
        about.forEach((b, j) => { if (!bIds.has(b))
            err(`${p}.about[${j}]`, `building "${b}" is not in this map`); });
        if (g.journeys !== undefined)
            (Array.isArray(g.journeys) ? g.journeys : (err(`${p}.journeys`, "journeys must be a list"), [])).forEach((x, j) => { if (!jIds.has(x))
                err(`${p}.journeys[${j}]`, `journey "${x}" is not in this map`); });
    });
    if (opt.base && !out.some((i) => i.level === "error"))
        out.push(...renames(opt.base, map));
    if (opt.coverage ?? !!opt.readFile)
        if (!out.some((i) => i.level === "error"))
            out.push(...coverage(map, opt, byId));
    return out;
}
// ---------- coverage: is the map deep enough? ----------
const SRC = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|vue|svelte)$/i;
const NOT_SRC = /(^|\/)(test|tests|__tests__|spec|specs|__mocks__|fixtures?|node_modules|dist|build|out|vendor|generated|gen|coverage|examples?)\/|\.(test|spec|stories|d)\.[a-z]+$|\.min\.js$/i;
const under = (f, dir) => !!dir && (dir === "." || f === dir || f.startsWith(dir.replace(/\/?$/, "/")));
/** Mask comments while preserving quoted module specifiers and source line breaks. */
function withoutComments(text) {
    const out = text.split("");
    let quote = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\")
                i++;
            else if (ch === quote)
                quote = "";
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch !== "/" || !["/", "*"].includes(text[i + 1]))
            continue;
        const block = text[i + 1] === "*", start = i;
        i += 2;
        while (i < text.length && (block ? !(text[i] === "*" && text[i + 1] === "/") : text[i] !== "\n"))
            i++;
        const end = block ? Math.min(i + 2, text.length) : i;
        for (let j = start; j < end; j++)
            if (out[j] !== "\n" && out[j] !== "\r")
                out[j] = " ";
        i = end - 1;
    }
    return out.join("");
}
/** Normalize package subpaths without guessing which packages call a service. */
export function importsOf(text, path = "") {
    text = withoutComments(text);
    const out = new Set();
    for (const m of text.matchAll(/(?:from\s+|import\s+|require\(\s*|import\(\s*)["']([^"'./][^"']*)["']/g))
        out.add(m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0]);
    // Python's syntax must not interpret JavaScript `import type` or prose as packages.
    if (/\.py$/i.test(path))
        for (const m of text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w]*)/gm))
            out.add(m[1]);
    return [...out];
}
/** Read and validate the optional sidecar. Unclassified imports still warn when it is absent. */
function dependencyDeclarations(opt, connections, issues) {
    const path = "map.dependencies.json", text = opt.readFile?.(path);
    if (text == null)
        return {};
    const error = (message) => issues.push({ level: "error", rule: "C-8", path, message: `C-8: ${message}` });
    let policy;
    try {
        policy = JSON.parse(text);
    }
    catch {
        error("dependency declarations are not valid JSON");
        return {};
    }
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.version !== 1 || !policy.packages || typeof policy.packages !== "object" || Array.isArray(policy.packages)) {
        error("expected version: 1 and a packages object");
        return {};
    }
    if (Object.keys(policy).some((k) => !["version", "packages"].includes(k)))
        error("unknown dependency-policy field");
    const declarations = Object.create(null);
    for (const [name, entry] of Object.entries(policy.packages)) {
        const d = entry;
        if (!name || name.startsWith(".") || name.startsWith("/") || !d || typeof d !== "object" || Array.isArray(d) ||
            !["library", "workspace", "service"].includes(d.kind) || typeof d.reason !== "string" || !d.reason.trim() ||
            Object.keys(d).some((k) => !["kind", "reason", "connections"].includes(k))) {
            error(`invalid classification for package ${name}`);
            continue;
        }
        if (d.kind === "service") {
            if (!Array.isArray(d.connections) || !d.connections.length || d.connections.some((id) => typeof id !== "string" || !connections.some((c) => connId(c) === id))) {
                error(`service package ${name} must reference existing connection ids`);
                continue;
            }
        }
        else if (d.connections !== undefined) {
            error(`non-service package ${name} cannot declare service connections`);
            continue;
        }
        declarations[name] = d;
    }
    return declarations;
}
/** Depth rules from the spec. All warnings: fix them, or say why in the PR. */
export function coverage(map, opt = {}, byId) {
    const out = [], warn = (path, rule, message) => out.push({ level: "warning", path, message: `${rule}: ${message}`, rule });
    const B = map.buildings || [], C = map.connections || [], K = map.code || [], J = map.journeys || [], G = map.guides || [];
    const dependencies = dependencyDeclarations(opt, C, out);
    const bOf = byId || new Map(B.map((b) => [b.id, b]));
    const isOutside = (id) => !!id && bOf.get(id)?.kind === "outside";
    const files = opt.listFiles ? opt.listFiles() : [];
    const lines = (f) => { const t = opt.readFile?.(f); return t ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0; };
    const allSteps = J.flatMap((j) => j.steps.flatMap((s, i) => [{ j, s, n: `${i + 1}` }, ...(s.on_failure || []).map((f, x) => ({ j, s: f, n: `${i + 1}✕${x + 1}` }))]));
    const usedConn = new Set(allSteps.map((x) => x.s.connection).filter(Boolean));
    const opsUsed = new Set([...J.map((j) => j.trigger || ""), ...C.map((c) => c.to)].filter((x) => x.startsWith("openapi:")));
    B.forEach((b, i) => {
        const p = `buildings[${i}]`;
        if (b.kind === "outside" || !b.path)
            return;
        const mine = K.filter((k) => k.building === b.id);
        if (mine.length < 3)
            warn(p, "C-1", `${b.name} has ${mine.length} code entr${mine.length === 1 ? "y" : "ies"}; add one for each responsibility (D-2)`);
        if (files.length && opt.readFile) {
            const covered = new Set(mine.map((k) => k.path));
            const big = files.filter((f) => under(f, b.path) && SRC.test(f) && !NOT_SRC.test(f) && !covered.has(f)).map((f) => [f, lines(f)]).filter(([, n]) => n > LIMITS.bigFile).sort((x, y) => y[1] - x[1]);
            if (big.length)
                warn(p, "C-1", `${big.length} file${big.length === 1 ? "" : "s"} over ${LIMITS.bigFile} lines with no code entry: ${big.slice(0, 5).map(([f, n]) => `${f} (${n})`).join(", ")}${big.length > 5 ? ", …" : ""}`);
            const unclassified = new Map();
            let http = "";
            for (const f of files) {
                if ((!under(f, b.path) && !mine.some((k) => k.path === f)) || !SRC.test(f) || NOT_SRC.test(f))
                    continue;
                const t = opt.readFile(f) || "";
                for (const spec of importsOf(t, f)) {
                    if (spec.startsWith("node:"))
                        continue;
                    const declaration = dependencies[spec];
                    if (!declaration && !unclassified.has(spec))
                        unclassified.set(spec, f);
                    if (declaration?.kind === "service" && !C.some((c) => c.from === b.id && declaration.connections.includes(connId(c))))
                        warn(p, "C-8", `service package ${spec} in ${f} has no declared connection from ${b.id}`);
                }
                if (!http && /\bfetch\s*\(/.test(t))
                    http = f;
            }
            for (const [spec, where] of unclassified)
                warn(p, "C-8", `imports ${spec} in ${where} without a classification in map.dependencies.json`);
            if (http && !C.some((c) => c.from === b.id))
                warn(p, "C-8", `${http} makes HTTP calls but ${b.name} has no outgoing connection`);
        }
        if (!G.some((g) => g.about.includes(b.id)))
            warn(p, "C-9", `no guide explains how ${b.name} works; add one under guides (D-8)`);
        const unused = (b.serves || []).filter((s) => !opsUsed.has(s));
        if (unused.length)
            warn(`${p}.serves`, "C-2", `${unused.length} served operation${unused.length === 1 ? "" : "s"} start no journey and no connection here: ${unused.slice(0, 6).map((s) => s.slice(8)).join(", ")}${unused.length > 6 ? ", …" : ""}`);
    });
    const idle = C.filter((c) => c.status !== "deprecated" && !usedConn.has(connId(c)));
    if (idle.length)
        warn("connections", "C-2", `${idle.length} connection${idle.length === 1 ? " is" : "s are"} used by no journey step: ${idle.slice(0, 6).map(connId).join(", ")}${idle.length > 6 ? ", …" : ""}`);
    const conn = new Map(C.map((c) => [connId(c), c]));
    J.forEach((j, i) => {
        const p = `journeys[${i}]`;
        const noCode = [], thin = [];
        for (const x of allSteps.filter((x) => x.j === j)) {
            const c = x.s.connection ? conn.get(x.s.connection) : undefined;
            const where = x.s.building || c?.to;
            if (!stepCodes(x.s).length && !isOutside(where) && !(where || "").startsWith("openapi:"))
                noCode.push(x.n);
            const st = x.s.story || "";
            if (st.length < LIMITS.thinStory || !/\d|`|\b(fail|error|retr|timeout|time out|status|state|created|running|stopped|pending|queued|reject|denied|expire|limit|cap|deadline|409|404|429|500)\w*/i.test(st))
                thin.push(x.n);
        }
        if (noCode.length)
            warn(`${p}.steps`, "C-3", `step${noCode.length === 1 ? "" : "s"} ${noCode.join(", ")} point at no code`);
        if (thin.length)
            warn(`${p}.steps`, "C-7", `step${thin.length === 1 ? "" : "s"} ${thin.join(", ")} read thin: name the limit, state, retry or failure that makes the step work (D-5)`);
    });
    const realB = B.filter((b) => b.kind !== "outside" && b.path).length;
    if (realB && J.length < realB)
        warn("journeys", "D-1", `${J.length} journeys for ${realB} buildings with code; every flow a user or client can trigger should be a journey`);
    return out;
}
/** Ids that disappeared while a look-alike appeared (C-6). Renaming an id loses its Notion row; keep the id or add "was". */
export function renames(base, head) {
    const out = [];
    const pairs = [
        ["buildings", head.buildings || [], base.buildings || [], ((a, b) => (!!a.path && a.path === b.path) || a.name === b.name), "same path or name"],
        ["code", head.code || [], base.code || [], ((a, b) => a.path === b.path && (a.symbol ? a.symbol === b.symbol : a.name === b.name)), "same path and symbol"],
        ["journeys", head.journeys || [], base.journeys || [], ((a, b) => a.name === b.name), "same name"],
    ];
    for (const [label, now, then, same, why] of pairs) {
        const nowIds = new Set(now.map((x) => x.id)), thenIds = new Set(then.map((x) => x.id)), claimed = new Set(now.map((x) => x.was).filter(Boolean));
        now.forEach((x, i) => {
            if (thenIds.has(x.id) || x.was)
                return;
            const old = then.find((o) => !nowIds.has(o.id) && !claimed.has(o.id) && same(x, o));
            if (old)
                out.push({ level: "error", rule: "C-6", path: `${label}[${i}].id`, message: `C-6: "${x.id}" looks like a rename of "${old.id}" (${why}). Keep the old id, or add "was": "${old.id}" so its Notion row and notes carry over` });
        });
    }
    return out;
}
const s = (v) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));
const DIFF_FIELDS = {
    building: ["name", "kind", "zone", "status", "path", "summary", "serves", "via", "areas"],
    connection: ["from", "to", "kind", "label", "status", "via"],
    code: ["building", "area", "name", "kind", "path", "symbol", "summary", "calls"],
    journey: ["name", "summary", "status", "trigger"],
    step: ["story", "building", "connection", "code", "repeat", "branch"],
    guide: ["title", "path", "about", "journeys"],
};
const areasText = (a) => (a?.length ? JSON.stringify(a.map((x) => ({ id: x.id, name: x.name, summary: x.summary, ...(x.path ? { path: x.path } : {}) }))) : "");
/** Flatten a (valid) map into keyed items. Refs are resolved to keys; openapi refs stay as-is. */
export function flatten(map) {
    const r = map.repo, K = (t, id) => keyOf(r, t, id), out = [];
    for (const b of map.buildings || [])
        out.push({ type: "building", key: K("building", b.id), id: b.id, name: b.name, was: b.was ? K("building", b.was) : undefined,
            fields: { name: b.name, kind: b.kind, zone: b.zone || defaultZone(b.kind), status: b.status || "live", path: s(b.path), summary: b.summary, serves: s(b.serves), via: s(b.via), areas: areasText(b.areas) },
            refs: b.via ? { via: K("building", b.via) } : {} });
    for (const c of map.connections || []) {
        const id = connId(c), to = c.to.startsWith("openapi:") ? c.to : K("building", c.to);
        out.push({ type: "connection", key: K("connection", id), id, name: c.label ? `${c.from} → ${c.to.replace(/^openapi:/, "")}: ${c.label}` : `${c.from} → ${c.to.replace(/^openapi:/, "")}`,
            fields: { from: c.from, to: c.to, kind: c.kind, label: s(c.label), status: c.status || "live", via: s(c.via) }, refs: { from: K("building", c.from), to, ...(c.via ? { via: K("building", c.via) } : {}) } });
    }
    for (const k of map.code || [])
        out.push({ type: "code", key: K("code", k.id), id: k.id, name: k.name, was: k.was ? K("code", k.was) : undefined,
            fields: { building: k.building, area: s(k.area), name: k.name, kind: k.kind || "function", path: k.path, lines: s(k.lines), symbol: s(k.symbol), summary: k.summary, calls: s(k.calls), snippet: s(k.snippet) },
            refs: { building: K("building", k.building), ...(k.calls?.length ? { calls: k.calls.map((c) => K("code", c)).join(",") } : {}) } });
    for (const j of map.journeys || []) {
        const jk = K("journey", j.id), old = j.was ? K("journey", j.was) : undefined;
        out.push({ type: "journey", key: jk, id: j.id, name: j.name, was: old, fields: { name: j.name, summary: s(j.summary), status: j.status || "live", trigger: s(j.trigger) }, refs: {} });
        const push = (st, suffix, name, order, branch) => {
            const refs = { journey: jk }, codes = stepCodes(st);
            if (st.building)
                refs.building = K("building", st.building);
            if (st.connection)
                refs.connection = K("connection", st.connection);
            if (codes.length)
                refs.code = codes.map((c) => K("code", c)).join(",");
            out.push({ type: "step", key: `${jk}#${suffix}`, id: `${j.id}#${suffix}`, name, was: old ? `${old}#${suffix}` : undefined,
                fields: { order: String(order), story: st.story, building: s(st.building), connection: s(st.connection), code: codes.join(", "), repeat: st.repeat ? "yes" : "", branch }, refs });
        };
        j.steps.forEach((st, i) => {
            push(st, `${i + 1}`, `${j.name} · ${i + 1}`, i + 1, "");
            (st.on_failure || []).forEach((f, x) => push(f, `${i + 1}!${x + 1}`, `${j.name} · ${i + 1} if it fails · ${x + 1}`, x + 1, String(i + 1)));
        });
    }
    for (const g of map.guides || [])
        out.push({ type: "guide", key: K("guide", g.id), id: g.id, name: g.title,
            fields: { title: g.title, path: g.path, about: s(g.about), journeys: s(g.journeys) },
            refs: { about: g.about.map((b) => K("building", b)).join(","), ...(g.journeys?.length ? { journeys: g.journeys.map((x) => K("journey", x)).join(",") } : {}) } });
    return out;
}
/** What changed between two maps of the same repo. Line-number moves are ignored. "was" renames show as changes. */
export function diff(base, head) {
    const a = new Map((base ? flatten(base) : []).map((i) => [i.key, i]));
    const b = new Map((head ? flatten(head) : []).map((i) => [i.key, i]));
    const out = [], renamed = new Set();
    const pick = (i, f) => Object.fromEntries(f.filter((k) => i.fields[k]).map((k) => [k, i.fields[k]]));
    for (const [k, i] of b) {
        const f = DIFF_FIELDS[i.type];
        let o = a.get(k);
        const viaWas = !o && i.was && a.has(i.was) && !b.has(i.was) ? a.get(i.was) : undefined;
        if (viaWas) {
            o = viaWas;
            renamed.add(viaWas.key);
        }
        if (!o)
            out.push({ type: i.type, key: k, id: i.id, name: i.name, change: "added", fields: [], before: {}, after: pick(i, f) });
        else {
            const ch = f.filter((x) => (o.fields[x] || "") !== (i.fields[x] || ""));
            if (viaWas)
                out.push({ type: i.type, key: k, id: i.id, name: i.name, change: "changed", fields: ["id", ...ch], before: { id: o.id, ...pick(o, ch) }, after: { id: i.id, ...pick(i, ch) } });
            else if (ch.length)
                out.push({ type: i.type, key: k, id: i.id, name: i.name, change: "changed", fields: ch, before: pick(o, ch), after: pick(i, ch) });
        }
    }
    for (const [k, o] of a)
        if (!b.has(k) && !renamed.has(k))
            out.push({ type: o.type, key: k, id: o.id, name: o.name, change: "removed", fields: [], before: pick(o, DIFF_FIELDS[o.type]), after: {} });
    const order = ["building", "connection", "journey", "code", "step", "guide"];
    return out.sort((x, y) => order.indexOf(x.type) - order.indexOf(y.type) || x.key.localeCompare(y.key));
}
/** Journeys whose steps, or anything a step passes through, changed. */
export function journeysTouched(head, changes) {
    if (!head)
        return [];
    const hit = new Set(changes.map((c) => `${c.type}:${c.id}`));
    const conns = new Map((head.connections || []).map((c) => [connId(c), c]));
    const code = new Map((head.code || []).map((k) => [k.id, k]));
    const names = [];
    for (const j of head.journeys || []) {
        const steps = j.steps.flatMap((st) => [st, ...(st.on_failure || [])]);
        const touched = hit.has(`journey:${j.id}`) || changes.some((c) => c.type === "step" && c.id.startsWith(j.id + "#")) ||
            steps.some((st) => {
                const b = new Set();
                if (st.building)
                    b.add(st.building);
                const c = st.connection ? conns.get(st.connection) : undefined;
                if (c) {
                    b.add(c.from);
                    b.add(c.to);
                }
                for (const id of stepCodes(st)) {
                    const k = code.get(id);
                    if (k)
                        b.add(k.building);
                }
                return (st.connection && hit.has(`connection:${st.connection}`)) || stepCodes(st).some((id) => hit.has(`code:${id}`)) || [...b].some((x) => hit.has(`building:${x}`));
            });
        if (touched)
            names.push(j.name);
    }
    return names;
}
export function summarize(changes, journeys = []) {
    if (!changes.length)
        return "No map change";
    const n = (ch) => changes.filter((c) => c.change === ch && c.type !== "step");
    const WORD = { code: ["code entry", "code entries"] };
    const plural = (t, k) => `${k} ${(WORD[t] || [t, t + "s"])[k === 1 ? 0 : 1]}`;
    const group = (list) => {
        const by = {};
        for (const c of list)
            by[c.type] = (by[c.type] || 0) + 1;
        return Object.entries(by).map(([t, k]) => plural(t, k)).join(", ");
    };
    const parts = [];
    if (n("added").length)
        parts.push(`+ ${group(n("added"))}`);
    if (n("changed").length)
        parts.push(`~ ${group(n("changed"))}`);
    if (n("removed").length)
        parts.push(`− ${group(n("removed"))}`);
    if (!parts.length)
        parts.push("story steps edited");
    if (journeys.length)
        parts.push(`journeys: ${journeys.join(", ")}`);
    return parts.join(" · ");
}
/** Cut a snippet out of a file for the code panel. */
export function snippetOf(text, lines, max = LIMITS.snippetLines) {
    const all = text.split("\n"), r = parseLines(lines) || [1, Math.min(all.length, max)];
    const part = all.slice(r[0] - 1, r[1]);
    const ind = Math.min(...part.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const out = part.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
    return out.length > max ? out.slice(0, max).join("\n") + "\n…" : out.join("\n");
}
