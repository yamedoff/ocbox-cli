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
export const LIMITS = { summary: 300, story: 300, label: 80, name: 60, snippetLines: 30, buildings: 80, code: 400, journeys: 40, steps: 40 };
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const OP = /^openapi:[A-Za-z0-9_.-]+$/;
const TOP = new Set(["$schema", "version", "repo", "visibility", "openapi", "buildings", "connections", "code", "journeys"]);
const FIELDS = {
    building: new Set(["id", "name", "kind", "zone", "status", "path", "summary", "serves"]),
    connection: new Set(["id", "from", "to", "kind", "label", "status"]),
    code: new Set(["id", "building", "name", "kind", "path", "lines", "symbol", "summary", "calls", "snippet"]),
    journey: new Set(["id", "name", "summary", "status", "trigger", "steps"]),
    step: new Set(["story", "building", "connection", "code"]),
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
const isRelPath = (p) => !!p && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes("..") && !/^~/.test(p);
/** Find the line range of a symbol's definition. Returns "start-end" or null. */
export function anchor(text, symbol) {
    const lines = text.split("\n");
    const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const def = new RegExp(`(function\\*?|class|def|func|const|let|var|type|interface|enum|struct|fn)\\s+${esc}\\b|\\b${esc}\\s*[:=]\\s*(async\\s*)?(\\(|function)|^\\s*(async\\s+)?${esc}\\s*\\(.*\\)\\s*\\{`);
    let s = lines.findIndex((l) => def.test(l));
    if (s < 0)
        s = lines.findIndex((l) => new RegExp(`\\b${esc}\\b`).test(l));
    if (s < 0)
        return null;
    // brace matching for C-like languages, indentation for Python-like
    let depth = 0, seen = false, e = s;
    for (let i = s; i < lines.length && i < s + 120; i++) {
        for (const ch of lines[i]) {
            if (ch === "{") {
                depth++;
                seen = true;
            }
            else if (ch === "}")
                depth--;
        }
        e = i;
        if (seen && depth <= 0)
            break;
        if (!seen && i > s + 2) {
            const ind = (x) => x.length - x.trimStart().length;
            const base = ind(lines[s]);
            let j = s + 1;
            while (j < lines.length && j < s + 120 && (lines[j].trim() === "" || ind(lines[j]) > base))
                j++;
            e = Math.max(s, j - 1);
            while (e > s && lines[e].trim() === "")
                e--;
            break;
        }
    }
    return `${s + 1}-${e + 1}`;
}
/** Validate a parsed map.json. Never throws. */
export function check(map, opt = {}) {
    const out = [];
    const err = (path, message, fix) => out.push({ level: "error", path, message, fix });
    const warn = (path, message) => out.push({ level: "warning", path, message });
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
        err("repo", "repo must be a short slug like \"opencloudbox\"");
    if (m.visibility !== undefined && m.visibility !== "public" && m.visibility !== "private")
        err("visibility", "visibility must be public or private");
    if (m.openapi !== undefined && (typeof m.openapi !== "string" || !isRelPath(m.openapi)))
        err("openapi", "openapi must be a repo-relative path");
    const arr = (k) => (m[k] === undefined ? [] : Array.isArray(m[k]) ? m[k] : (err(k, `${k} must be an array`), []));
    const B = arr("buildings"), C = arr("connections"), K = arr("code"), J = arr("journeys");
    if (!B.length)
        err("buildings", "add at least one building");
    if (B.length > LIMITS.buildings)
        warn("buildings", `${B.length} buildings is a lot; group small parts into one building`);
    if (K.length > LIMITS.code)
        warn("code", `${K.length} code entries; keep only the ones a newcomer needs`);
    const strs = (o, path, type) => {
        for (const k of Object.keys(o))
            if (!FIELDS[type].has(k))
                err(`${path}.${k}`, `unknown field "${k}" on ${type}`);
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
            const id = idOf(o);
            if (!SLUG.test(id))
                err(`${label}[${i}].id`, `id "${id}" must be a lowercase slug (a-z, 0-9, -)`);
            if (seen.has(id))
                err(`${label}[${i}].id`, `duplicate id "${id}"`);
            seen.add(id);
        });
        return seen;
    };
    const bIds = ids(B, "buildings", (o) => String(o.id ?? ""));
    const opsServed = new Set();
    B.forEach((b, i) => {
        const p = `buildings[${i}]`;
        strs(b, p, "building");
        text(b, "name", p, LIMITS.name, true);
        text(b, "summary", p, LIMITS.summary, true);
        oneOf(b, "kind", p, KINDS, true);
        oneOf(b, "zone", p, ZONES);
        oneOf(b, "status", p, STATUSES);
        if (b.path !== undefined) {
            if (typeof b.path !== "string" || !isRelPath(b.path))
                err(`${p}.path`, "path must be inside the repo (relative, no ..)");
            else if (opt.readFile && opt.readFile(b.path) === null && opt.readFile(b.path.replace(/\/$/, "") + "/") === null)
                warn(`${p}.path`, `folder ${b.path} not found`);
        }
        if (b.kind === "outside" && b.path)
            warn(`${p}.path`, "outside services usually have no path");
        if (b.serves !== undefined) {
            if (!Array.isArray(b.serves))
                err(`${p}.serves`, "serves must be a list like [\"openapi:createBox\"]");
            else
                b.serves.forEach((s, j) => {
                    if (typeof s !== "string" || !OP.test(s))
                        err(`${p}.serves[${j}]`, "use openapi:<operationId>");
                    else {
                        opsServed.add(s);
                        if (opt.openapiOps && !opt.openapiOps.has(s.slice(8)))
                            err(`${p}.serves[${j}]`, `operation ${s.slice(8)} is not in the OpenAPI file`);
                    }
                });
        }
    });
    const cIds = ids(C, "connections", (o) => connId(o));
    C.forEach((c, i) => {
        const p = `connections[${i}]`;
        strs(c, p, "connection");
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
    });
    const kIds = ids(K, "code", (o) => String(o.id ?? ""));
    K.forEach((k, i) => {
        const p = `code[${i}]`;
        strs(k, p, "code");
        text(k, "name", p, LIMITS.name, true);
        text(k, "summary", p, LIMITS.summary, true);
        oneOf(k, "kind", p, CODE_KINDS);
        if (!bIds.has(k.building))
            err(`${p}.building`, `building "${k.building}" is not in this map`);
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
            k.calls.forEach((c, j) => { if (!kIds.has(c) && !K.some((x) => x.id === c))
                err(`${p}.calls[${j}]`, `calls "${c}" is not a code id in this map`); });
        else if (k.calls !== undefined)
            err(`${p}.calls`, "calls must be a list of code ids");
        if (opt.readFile) {
            const src = opt.readFile(path);
            if (src === null) {
                err(`${p}.path`, `file ${path} not found`);
                return;
            }
            const sym = k.symbol;
            const r = parseLines(k.lines);
            const total = src.split("\n").length;
            if (r && r[1] > total) {
                const a = sym ? anchor(src, sym) : null;
                err(`${p}.lines`, `lines ${k.lines} go past the end of ${path} (${total} lines)`, a ? { lines: a } : undefined);
            }
            else if (sym) {
                const inRange = r ? src.split("\n").slice(r[0] - 1, r[1]).join("\n").includes(sym) : false;
                if (!inRange) {
                    const a = anchor(src, sym);
                    if (!a)
                        err(`${p}.symbol`, `"${sym}" not found in ${path}`);
                    else
                        err(`${p}.lines`, r ? `"${sym}" moved: now at ${a}` : `lines missing: "${sym}" is at ${a}`, { lines: a });
                }
            }
        }
    });
    J.forEach((j, i) => {
        const p = `journeys[${i}]`;
        strs(j, p, "journey");
        text(j, "name", p, LIMITS.name, true);
        text(j, "summary", p, LIMITS.summary);
        oneOf(j, "status", p, STATUSES);
        if (j.trigger !== undefined && (typeof j.trigger !== "string" || !OP.test(j.trigger)))
            err(`${p}.trigger`, "trigger must be openapi:<operationId>");
        const steps = Array.isArray(j.steps) ? j.steps : (err(`${p}.steps`, "steps must be a list"), []);
        if (!steps.length)
            err(`${p}.steps`, "a journey needs at least one step");
        if (steps.length > LIMITS.steps)
            warn(`${p}.steps`, `${steps.length} steps; split the journey`);
        steps.forEach((s, n) => {
            const q = `${p}.steps[${n}]`;
            strs(s, q, "step");
            text(s, "story", q, LIMITS.story, true);
            if (!s.building && !s.connection && !s.code)
                err(q, "a step needs building, connection or code");
            if (s.building !== undefined && !bIds.has(s.building))
                err(`${q}.building`, `building "${s.building}" is not in this map`);
            if (s.connection !== undefined && !cIds.has(s.connection))
                err(`${q}.connection`, `connection "${s.connection}" is not in this map`);
            if (s.code !== undefined && !kIds.has(s.code))
                err(`${q}.code`, `code "${s.code}" is not in this map`);
        });
    });
    ids(J, "journeys", (o) => String(o.id ?? ""));
    return out;
}
const s = (v) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));
const DIFF_FIELDS = {
    building: ["name", "kind", "zone", "status", "path", "summary", "serves"],
    connection: ["from", "to", "kind", "label", "status"],
    code: ["building", "name", "kind", "path", "symbol", "summary", "calls"],
    journey: ["name", "summary", "status", "trigger"],
    step: ["story", "building", "connection", "code"],
};
/** Flatten a (valid) map into keyed items. Refs are resolved to keys; openapi refs stay as-is. */
export function flatten(map) {
    const r = map.repo, K = (t, id) => keyOf(r, t, id), out = [];
    for (const b of map.buildings || [])
        out.push({ type: "building", key: K("building", b.id), id: b.id, name: b.name,
            fields: { name: b.name, kind: b.kind, zone: b.zone || defaultZone(b.kind), status: b.status || "live", path: s(b.path), summary: b.summary, serves: s(b.serves) }, refs: {} });
    for (const c of map.connections || []) {
        const id = connId(c), to = c.to.startsWith("openapi:") ? c.to : K("building", c.to);
        out.push({ type: "connection", key: K("connection", id), id, name: c.label ? `${c.from} → ${c.to.replace(/^openapi:/, "")}: ${c.label}` : `${c.from} → ${c.to.replace(/^openapi:/, "")}`,
            fields: { from: c.from, to: c.to, kind: c.kind, label: s(c.label), status: c.status || "live" }, refs: { from: K("building", c.from), to } });
    }
    for (const k of map.code || [])
        out.push({ type: "code", key: K("code", k.id), id: k.id, name: k.name,
            fields: { building: k.building, name: k.name, kind: k.kind || "function", path: k.path, lines: s(k.lines), symbol: s(k.symbol), summary: k.summary, calls: s(k.calls), snippet: s(k.snippet) },
            refs: { building: K("building", k.building), ...(k.calls?.length ? { calls: k.calls.map((c) => K("code", c)).join(",") } : {}) } });
    for (const j of map.journeys || []) {
        out.push({ type: "journey", key: K("journey", j.id), id: j.id, name: j.name, fields: { name: j.name, summary: s(j.summary), status: j.status || "live", trigger: s(j.trigger) }, refs: {} });
        j.steps.forEach((st, i) => {
            const refs = { journey: K("journey", j.id) };
            if (st.building)
                refs.building = K("building", st.building);
            if (st.connection)
                refs.connection = K("connection", st.connection);
            if (st.code)
                refs.code = K("code", st.code);
            out.push({ type: "step", key: `${K("journey", j.id)}#${i + 1}`, id: `${j.id}#${i + 1}`, name: `${j.name} · ${i + 1}`,
                fields: { order: String(i + 1), story: st.story, building: s(st.building), connection: s(st.connection), code: s(st.code) }, refs });
        });
    }
    return out;
}
/** What changed between two maps of the same repo. Line-number moves are ignored. */
export function diff(base, head) {
    const a = new Map((base ? flatten(base) : []).map((i) => [i.key, i]));
    const b = new Map((head ? flatten(head) : []).map((i) => [i.key, i]));
    const out = [];
    const pick = (i, f) => Object.fromEntries(f.filter((k) => i.fields[k]).map((k) => [k, i.fields[k]]));
    for (const [k, i] of b) {
        const o = a.get(k), f = DIFF_FIELDS[i.type];
        if (!o)
            out.push({ type: i.type, key: k, id: i.id, name: i.name, change: "added", fields: [], before: {}, after: pick(i, f) });
        else {
            const ch = f.filter((x) => (o.fields[x] || "") !== (i.fields[x] || ""));
            if (ch.length)
                out.push({ type: i.type, key: k, id: i.id, name: i.name, change: "changed", fields: ch, before: pick(o, ch), after: pick(i, ch) });
        }
    }
    for (const [k, o] of a)
        if (!b.has(k))
            out.push({ type: o.type, key: k, id: o.id, name: o.name, change: "removed", fields: [], before: pick(o, DIFF_FIELDS[o.type]), after: {} });
    const order = ["building", "connection", "journey", "code", "step"];
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
        const touched = hit.has(`journey:${j.id}`) || changes.some((c) => c.type === "step" && c.id.startsWith(j.id + "#")) ||
            j.steps.some((st) => {
                const b = new Set();
                if (st.building)
                    b.add(st.building);
                const c = st.connection ? conns.get(st.connection) : undefined;
                if (c) {
                    b.add(c.from);
                    b.add(c.to);
                }
                const k = st.code ? code.get(st.code) : undefined;
                if (k)
                    b.add(k.building);
                return (st.connection && hit.has(`connection:${st.connection}`)) || (st.code && hit.has(`code:${st.code}`)) || [...b].some((x) => hit.has(`building:${x}`));
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
    const plural = (t, k) => `${k} ${t}${k === 1 ? "" : "s"}`;
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
