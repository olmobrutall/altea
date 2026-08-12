import { AsyncLocalStorage } from 'node:async_hooks';

// Port of Signum's HeavyProfiler (Signum.Utilities/Profiler/HeavyProfiler.cs).
//
// An intensive, tree-structured profiler: strategically instrumented spans ("SQL", "LINQ",
// "Execute", "Web.API GET", …) with accurate times, parent/child nesting, optional stack traces
// and lazily-computed additional data (e.g. the generated SQL). Enabled at runtime; auto-disables
// after `maxEnabledTime` so it can't eat all memory. The recorded tree is read back by the
// altea-profiler extension's admin UI.
//
// Divergences from Signum (all deliberate — see CLAUDE.md "copy-and-fix"):
//  - PerfCounter uses `performance.now()` (monotonic, fractional ms) instead of Stopwatch ticks,
//    with FrequencyMilliseconds = 1, so BeforeStart/Start/End are ms and the Elapsed math is unchanged.
//  - The `current` span pointer (Signum's `Statics.ThreadVariable`) is a MUTABLE BOX held in a node
//    AsyncLocalStorage, with a process-global fallback and a per-request scope (`runScope`, opened by
//    webApi). altea's Statics abstraction only supports scoped `withValue`, and the profiler's model is
//    imperative (enter-on-log / restore-on-dispose) — so, like connector.ts and executionMode.ts, this
//    server-only file uses AsyncLocalStorage directly. A mutable box (not `enterWith`) is used so that a
//    span's `dispose` restores the pointer SYNCHRONOUSLY before the next sibling runs: `enterWith` leaks
//    the pointer back to the caller after an `await`, which mis-parents sequential siblings. The box makes
//    sequential nesting correct and isolates concurrent requests; overlapping concurrent spans WITHIN one
//    request can still mis-parent (JS has no copy-on-write async context) — that async layout is
//    reconstructed from timestamps at display time, exactly as Signum does.
//  - No OpenTelemetry Activity / ILoggerFactory branch (altea has no OTel wiring yet) — re-addable.
//  - Stack traces are captured as V8 `Error().stack` strings and parsed lazily in the API layer.
//  - Plain arrays / no locks (single-threaded JS).

// High-resolution monotonic clock (Signum's PerfCounter). `performance.now()` already returns
// fractional milliseconds, so the frequency is 1 and ToMilliseconds is a plain subtraction.
export class PerfCounter {
    static readonly frequencyMilliseconds = 1;

    static get ticks(): number {
        return performance.now();
    }

    static toMilliseconds(start: number, end: number): number {
        return end - start;
    }
}

// A mutable holder for the innermost open span on the current logical call path. Held in an
// AsyncLocalStorage so each request (see runScope) gets its own; a process-global box is the fallback
// for non-request flows (tests, startup seeding, the terminal). Read/written through currentBox().
interface CurrentBox { entry: HeavyProfilerEntry | undefined; }
const currentStore = new AsyncLocalStorage<CurrentBox>();
const globalBox: CurrentBox = { entry: undefined };
function currentBox(): CurrentBox {
    return currentStore.getStore() ?? globalBox;
}

// Lazy additional-data thunk: only invoked when the profiler is enabled, so producing an expensive
// string (the full SQL, an expression dump) costs nothing on the disabled hot path.
export type AdditionalData = () => string | undefined;

export namespace HeavyProfiler {
    // When enabled, the profiler auto-disables after this long (Signum default: 5 minutes).
    export let maxEnabledTime = 5 * 60 * 1000;

    export let timeLimit: number | undefined;

    let enabledValue = false;

    export function isEnabled(): boolean {
        return enabledValue;
    }

    export function setEnabled(value: boolean): void {
        enabledValue = value;
        if (value)
            timeLimit = PerfCounter.ticks + PerfCounter.frequencyMilliseconds * maxEnabledTime;
        else
            timeLimit = undefined;
    }

    export const entries: HeavyProfilerEntry[] = [];

    export function clean(): void {
        entries.length = 0;
    }

    // Open a span that captures a stack trace (Signum's Log). Returns undefined when disabled — a
    // `using` over undefined is a no-op, so call sites stay `using _ = HeavyProfiler.log(...)`.
    export function log(kind: string, additionalData?: AdditionalData): Tracer | undefined {
        if (!enabledValue)
            return undefined;
        return createNewTracer(kind, additionalData, /*stackTrace*/ true);
    }

    // Open a span without a stack trace (Signum's LogNoStackTrace) — cheaper, for fine-grained
    // spans where the context is already obvious (the LINQ optimizer phases, JSON read/write).
    export function logNoStackTrace(kind: string, additionalData?: AdditionalData): Tracer | undefined {
        if (!enabledValue)
            return undefined;
        return createNewTracer(kind, additionalData, /*stackTrace*/ false);
    }

    function autoStop(beforeStart: number): void {
        if (enabledValue && timeLimit != null && timeLimit < beforeStart) {
            enabledValue = false;
            timeLimit = undefined;
            clean();
        }
    }

    function createNewTracer(kind: string, additionalData: AdditionalData | undefined, stackTrace: boolean): Tracer {
        const beforeStart = PerfCounter.ticks;
        autoStop(beforeStart);
        const entry = createEntry(kind, additionalData?.(), stackTrace, beforeStart);
        return new Tracer(entry);
    }

    // Run `fn` under a fresh per-flow `current` box (Signum's implicit per-thread ThreadVariable). Opened
    // per request by webApi so concurrent requests build isolated span trees. Cheap; always applied.
    export function runScope<R>(fn: () => R): R {
        return currentStore.run({ entry: undefined }, fn);
    }

    // Internal: called by createNewTracer and Tracer.switch.
    export function createEntry(kind: string, additionalData: string | undefined, stackTrace: boolean, beforeStart: number): HeavyProfilerEntry {
        const box = currentBox();
        const parent = box.entry;

        const newCurrent = new HeavyProfilerEntry();
        newCurrent.beforeStart = beforeStart;
        newCurrent.kind = kind;
        newCurrent.additionalData = additionalData;
        newCurrent.stackTrace = stackTrace ? captureStackTrace() : undefined;
        newCurrent.parent = parent;
        newCurrent.depth = parent == null ? 0 : parent.depth + 1;
        newCurrent.start = PerfCounter.ticks;

        if (parent == null) {
            newCurrent.index = entries.length;
            entries.push(newCurrent);
        } else {
            parent.entries ??= [];
            newCurrent.index = parent.entries.length;
            parent.entries.push(newCurrent);
        }

        box.entry = newCurrent;
        return newCurrent;
    }

    // Internal: called by Tracer.dispose / Tracer.switch to close a span.
    export function closeEntry(entry: HeavyProfilerEntry): void {
        entry.end = PerfCounter.ticks;
        // Relaxed vs Signum's strict `current == entry` assertion: across concurrent async flows the
        // ambient current may differ; always restore to this span's parent.
        currentBox().entry = entry.parent;
    }

    // All entries flattened depth-first (Signum's AllEntries) — roots then their recursive children.
    export function allEntries(): HeavyProfilerEntry[] {
        const result: HeavyProfilerEntry[] = [];
        for (const item of entries) {
            result.push(item);
            item.fillDescendants(result);
        }
        return result;
    }

    // SQL statistics grouped by the query text (Signum's SqlStatistics). The "SQL" role is
    // load-bearing: its additionalData is the query, so entries group by it.
    export function sqlStatistics(): SqlProfileResume[] {
        const groups = new Map<string, HeavyProfilerEntry[]>();
        for (const a of allEntries()) {
            if (a.kind !== "SQL" || a.additionalData == null)
                continue;
            const list = groups.get(a.additionalData);
            if (list) list.push(a);
            else groups.set(a.additionalData, [a]);
        }

        const result: SqlProfileResume[] = [];
        for (const [query, gr] of groups) {
            const durations = gr.map(a => a.elapsedMilliseconds);
            const sum = durations.reduce((s, d) => s + d, 0);
            result.push({
                query,
                count: gr.length,
                sum,
                avg: sum / gr.length,
                min: Math.min(...durations),
                max: Math.max(...durations),
                references: gr.map(a => ({ fullKey: a.fullIndex(), elapsedToString: a.elapsedToString() })),
            });
        }
        return result.sort((a, b) => b.sum - a.sum);
    }

    // Find an entry by its dot(-dash)-separated FullIndex path (Signum's Find).
    export function find(fullIndex: string): HeavyProfilerEntry {
        const array = fullIndex.split('-').map(a => parseInt(a, 10));
        let entry: HeavyProfilerEntry | undefined;
        let currentList: HeavyProfilerEntry[] | undefined = entries;
        for (const index of array) {
            if (currentList == null || currentList.length <= index)
                throw new Error("The ProfileEntry is not available");
            entry = currentList[index];
            currentList = entry.entries;
        }
        return entry!;
    }

    // Merge entries recorded elsewhere (Signum's ImportEntries) — re-index to stay unique, and
    // optionally rebase their clock to this process's (using the earliest entry on each side).
    export function importEntries(list: HeavyProfilerEntry[], rebaseTime: boolean): void {
        if (list.length === 0)
            return;

        const indexDelta = entries.length - Math.min(...list.map(e => e.index));
        for (const e of list)
            e.index += indexDelta;

        if (rebaseTime && entries.length > 0) {
            const timeDelta = Math.min(...entries.map(a => a.beforeStart)) - Math.min(...list.map(a => a.beforeStart));
            for (const e of list)
                e.reBaseTime(timeDelta);
        }

        entries.push(...list);
    }

    // ---- XML export / import (Signum's ExportXml / ImportXml) --------------------------------
    // Hand-rolled (no System.Xml.Linq); keeps Signum's attribute names so files are interchangeable.

    export function exportXml(includeStackTrace = false): string {
        const sb: string[] = ['<Logs>'];
        for (const e of entries)
            e.exportXml(sb, includeStackTrace);
        sb.push('</Logs>');
        return sb.join('');
    }

    export function importXml(xml: string, rebaseTime: boolean): void {
        const doc = new XmlReader(xml);
        const list: HeavyProfilerEntry[] = [];
        for (const el of doc.rootChildren("Logs", "Log"))
            list.push(HeavyProfilerEntry.importXml(el, undefined));
        importEntries(list, rebaseTime);
    }
}

// A single open (or closed) span. Disposable so call sites use `using tr = HeavyProfiler.log(...)`.
export class Tracer implements Disposable {
    entry: HeavyProfilerEntry | undefined;

    constructor(entry: HeavyProfilerEntry | undefined) {
        this.entry = entry;
    }

    [Symbol.dispose](): void {
        if (this.entry != null)
            HeavyProfiler.closeEntry(this.entry);
    }

    // Close this span and open a sibling under the same parent (Signum's Switch extension) — for
    // timing sequential phases under one `using` (the LINQ optimizer chain). No-op if disabled.
    switch(kind: string, additionalData?: AdditionalData): void {
        if (this.entry == null)
            return;
        const hasStackTrace = this.entry.stackTrace != null;
        HeavyProfiler.closeEntry(this.entry);
        this.entry = HeavyProfiler.createEntry(kind, additionalData?.(), hasStackTrace, PerfCounter.ticks);
    }
}

// One captured span (Signum's HeavyProfilerEntry).
export class HeavyProfilerEntry {
    entries: HeavyProfilerEntry[] | undefined;
    parent: HeavyProfilerEntry | undefined;
    kind!: string;
    index = 0;
    depth = 0;

    additionalData: string | undefined;
    // Raw V8 stack string (Log) — parsed lazily in the API layer. Cleared before serialization.
    stackTrace: string | undefined;
    // Frames rehydrated from an imported XML export (Signum's ExternalStackTrace).
    externalStackTrace: ExternalStackFrame[] | undefined;

    beforeStart = 0;
    start = 0;
    end: number | undefined;

    get endOrNow(): number {
        return this.end ?? PerfCounter.ticks;
    }

    // Dash-separated sequence of indexes from the root that identifies this node (Signum's FullIndex).
    fullIndex(): string {
        const chain: number[] = [];
        for (let e: HeavyProfilerEntry | undefined = this; e != null; e = e.parent)
            chain.push(e.index);
        return chain.reverse().join('-');
    }

    additionalDataPreview(): string {
        if (this.additionalData == null || this.additionalData === "")
            return "";
        const m = /^[^\n]{0,100}/.exec(this.additionalData);
        return m ? m[0] : "";
    }

    // (End - Start) minus each descendant's own (BeforeStart - Start) overhead (Signum's ElapsedMilliseconds).
    get elapsedMilliseconds(): number {
        let overhead = 0;
        for (const d of this.descendants())
            overhead += d.beforeStart - d.start;
        return (this.endOrNow - this.start - overhead) / PerfCounter.frequencyMilliseconds;
    }

    elapsedToString(): string {
        const ms = this.elapsedMilliseconds;
        if (ms < 10)
            return ms.toFixed(4) + "ms";
        return niceTimeSpan(ms);
    }

    descendants(): HeavyProfilerEntry[] {
        const result: HeavyProfilerEntry[] = [];
        this.fillDescendants(result);
        return result;
    }

    descendantsAndSelf(): HeavyProfilerEntry[] {
        const result: HeavyProfilerEntry[] = [this];
        this.fillDescendants(result);
        return result;
    }

    fillDescendants(list: HeavyProfilerEntry[]): void {
        if (this.entries != null) {
            for (const item of this.entries) {
                list.push(item);
                item.fillDescendants(list);
            }
        }
    }

    toString(): string {
        return `${niceTimeSpan(this.elapsedMilliseconds)} ${this.kind}`;
    }

    exportXml(sb: string[], includeStackTrace: boolean): void {
        sb.push('<Log');
        sb.push(` Index="${this.index}"`);
        sb.push(` Role="${xmlAttr(this.kind)}"`);
        sb.push(` BeforeStart="${this.beforeStart}"`);
        sb.push(` Start="${this.start}"`);
        sb.push(` End="${this.end ?? PerfCounter.ticks}"`);
        if (this.additionalData != null)
            sb.push(` AdditionalData="${xmlAttr(this.additionalData)}"`);
        sb.push('>');
        if (includeStackTrace && this.stackTrace != null) {
            sb.push('<StackTrace>');
            for (const f of parseStackTrace(this.stackTrace))
                sb.push(`<StackFrame Method="${xmlAttr(f.namespace + '.' + f.type + '.' + f.method)}" Line="${xmlAttr((f.fileName ?? '') + ':' + (f.lineNumber ?? ''))}"/>`);
            sb.push('</StackTrace>');
        }
        if (this.entries != null)
            for (const e of this.entries)
                e.exportXml(sb, includeStackTrace);
        sb.push('</Log>');
    }

    cleanStackTrace(): void {
        this.stackTrace = undefined;
        if (this.entries != null)
            for (const item of this.entries)
                item.cleanStackTrace();
    }

    static importXml(xLog: XmlElement, parent: HeavyProfilerEntry | undefined): HeavyProfilerEntry {
        const result = new HeavyProfilerEntry();
        result.parent = parent;
        result.index = parseInt(xLog.attr("Index")!, 10);
        result.kind = xLog.attr("Role")!;
        result.beforeStart = parseFloat(xLog.attr("BeforeStart")!);
        result.start = parseFloat(xLog.attr("Start")!);
        result.end = parseFloat(xLog.attr("End")!);
        result.additionalData = xLog.attr("AdditionalData");
        result.depth = parent == null ? 0 : parent.depth + 1;

        const st = xLog.child("StackTrace");
        if (st != null)
            result.externalStackTrace = st.children("StackFrame").map(a => {
                const parts = (a.attr("Method") ?? "").split('.');
                const line = a.attr("Line") ?? "";
                return {
                    method: parts[parts.length - 1] ?? "",
                    type: parts[parts.length - 2] ?? "",
                    namespace: parts.slice(0, parts.length - 2).join('.'),
                    fileName: line.substring(0, line.lastIndexOf(':')),
                    lineNumber: parseInt(line.substring(line.lastIndexOf(':') + 1), 10) || undefined,
                } satisfies ExternalStackFrame;
            });

        const childLogs = xLog.children("Log");
        if (childLogs.length > 0)
            result.entries = childLogs.map(x => HeavyProfilerEntry.importXml(x, result));

        return result;
    }

    reBaseTime(timeDelta: number): void {
        this.beforeStart += timeDelta;
        this.start += timeDelta;
        if (this.end != null)
            this.end += timeDelta;
        if (this.entries != null)
            for (const e of this.entries)
                e.reBaseTime(timeDelta);
    }

    overlaps(e: HeavyProfilerEntry): boolean {
        return !(this.endOrNow <= e.beforeStart || e.endOrNow <= this.beforeStart);
    }
}

export interface ExternalStackFrame {
    namespace: string;
    type: string;
    method: string;
    fileName: string;
    lineNumber: number | undefined;
}

export interface SqlProfileResume {
    query: string;
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    references: SqlProfileReference[];
}

export interface SqlProfileReference {
    fullKey: string;
    elapsedToString: string;
}

// ---- Helpers -------------------------------------------------------------------------------

// Capture the current call stack minus the profiler frames (createEntry/createNewTracer/log).
function captureStackTrace(): string {
    const err = { stack: "" };
    Error.captureStackTrace(err as Error, HeavyProfiler.createEntry);
    return err.stack;
}

// Parse a V8 stack string into frames. Best-effort: matches "at Type.method (file:line:col)" and
// "at file:line:col". Used for the export/StackTrace endpoint (the analog of Signum's StackFrame walk).
export function parseStackTrace(stack: string): ExternalStackFrame[] {
    const frames: ExternalStackFrame[] = [];
    for (const raw of stack.split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('at '))
            continue;
        const m = /^at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/.exec(line);
        if (m == null)
            continue;
        const qualified = m[1] ?? "";
        const dot = qualified.lastIndexOf('.');
        frames.push({
            namespace: "",
            type: dot >= 0 ? qualified.substring(0, dot) : "",
            method: dot >= 0 ? qualified.substring(dot + 1) : qualified,
            fileName: m[2],
            lineNumber: parseInt(m[3], 10) || undefined,
        });
    }
    return frames;
}

// Compact human duration (the analog of Signum's TimeSpan.NiceToString) for spans >= 10ms.
function niceTimeSpan(ms: number): string {
    if (ms < 1000)
        return Math.round(ms) + "ms";
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60)
        return totalSeconds.toFixed(2) + "s";
    const m = Math.floor(totalSeconds / 60);
    const s = Math.round(totalSeconds % 60);
    return `${m}m ${s}s`;
}

function xmlAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---- Minimal XML reader (import path only) -------------------------------------------------
// Just enough to parse our own <Logs><Log …><StackTrace><StackFrame …/></StackTrace></Log></Logs>.

interface XmlElement {
    name: string;
    attr(name: string): string | undefined;
    child(name: string): XmlElement | undefined;
    children(name: string): XmlElement[];
}

class XmlReader {
    private readonly root: ParsedNode;

    constructor(xml: string) {
        this.root = parseXml(xml);
    }

    rootChildren(rootName: string, childName: string): XmlElement[] {
        const root = this.root.name === rootName ? this.root : this.root.children.find(c => c.name === rootName);
        return (root?.children ?? []).filter(c => c.name === childName).map(wrap);
    }
}

interface ParsedNode {
    name: string;
    attrs: Record<string, string>;
    children: ParsedNode[];
}

function wrap(node: ParsedNode): XmlElement {
    return {
        name: node.name,
        attr: (n: string) => node.attrs[n],
        child: (n: string) => { const c = node.children.find(x => x.name === n); return c ? wrap(c) : undefined; },
        children: (n: string) => node.children.filter(x => x.name === n).map(wrap),
    };
}

function xmlUnescape(v: string): string {
    return v
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// Tiny recursive-descent XML parser for the profiler's own well-formed export (no namespaces,
// comments, CDATA or text nodes). Throws on anything unexpected.
function parseXml(xml: string): ParsedNode {
    let i = 0;
    const len = xml.length;

    function skipDeclAndSpace(): void {
        while (i < len) {
            while (i < len && /\s/.test(xml[i])) i++;
            if (xml.startsWith('<?', i)) { i = xml.indexOf('?>', i) + 2; continue; }
            break;
        }
    }

    function parseElement(): ParsedNode {
        if (xml[i] !== '<') throw new Error("Invalid XML at " + i);
        i++;
        const nameMatch = /[^\s/>]+/y;
        nameMatch.lastIndex = i;
        const nm = nameMatch.exec(xml);
        if (nm == null) throw new Error("Invalid element name at " + i);
        const name = nm[0];
        i = nameMatch.lastIndex;

        const attrs: Record<string, string> = {};
        while (i < len) {
            while (i < len && /\s/.test(xml[i])) i++;
            if (xml[i] === '/' || xml[i] === '>') break;
            const attrRe = /([^\s=]+)\s*=\s*"([^"]*)"/y;
            attrRe.lastIndex = i;
            const am = attrRe.exec(xml);
            if (am == null) throw new Error("Invalid attribute at " + i);
            attrs[am[1]] = xmlUnescape(am[2]);
            i = attrRe.lastIndex;
        }

        const children: ParsedNode[] = [];
        if (xml[i] === '/') { i += 2; return { name, attrs, children }; } // self-closing
        i++; // consume '>'

        while (i < len) {
            while (i < len && /\s/.test(xml[i])) i++;
            if (xml.startsWith('</', i)) { i = xml.indexOf('>', i) + 1; break; }
            children.push(parseElement());
        }
        return { name, attrs, children };
    }

    skipDeclAndSpace();
    return parseElement();
}
