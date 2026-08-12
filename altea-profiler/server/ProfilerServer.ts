import type { Request } from "express";
import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { HeavyProfiler, HeavyProfilerEntry, parseStackTrace } from "@altea/altea/server/profiler/heavyProfiler";
import { TimeTracker } from "@altea/altea/server/profiler/timeTracker";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import type { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { ProfilerPermission } from "../data/ProfilerPermission";

// Port of Signum's ProfilerHeavyController + ProfilerTimesController (Signum.Profiler). The HTTP surface
// the ProfilerClient admin pages call: enable/disable + read the HeavyProfiler span tree (with the
// async-depth layout), stack traces, XML download/upload, and the TimeTracker per-action statistics.
// Every route asserts the matching ProfilerPermission server-side (the client has no permission primitive).

export namespace ProfilerServer {
    export function start(ws: WebBuilder): void {
        // ---- Heavy profiler ---------------------------------------------------------------------

        ws.post("/api/profilerHeavy/clear", {}, async (_req, res) => {
            await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
            HeavyProfiler.clean();
            res.status(204).end();
        });

        ws.post("/api/profilerHeavy/setEnabled/:isEnabled",
            { params: CustomType<{ isEnabled: string }>() },
            async (req, res) => {
                await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
                HeavyProfiler.setEnabled(req.params.isEnabled === "true");
                res.status(204).end();
            });

        ws.get("/api/profilerHeavy/isEnabled",
            { res: CustomType<boolean>() },
            async (_req, res) => {
                await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
                res.json(HeavyProfiler.isEnabled());
            });

        // Root entries (no children) — the Heavy list page's flame rows. Optionally hides the profiler's
        // own /api/profilerHeavy/* requests (Signum's ignoreProfilerHeavyEntries).
        ws.get("/api/profilerHeavy/entries",
            { res: CustomType<HeavyProfilerEntryTS[]>() },
            async (req, res) => {
                await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
                const ignore = (req as Request).query["ignoreProfilerHeavyEntries"] === "true";
                const now = perfNow();
                const result: HeavyProfilerEntryTS[] = [];
                for (const e of HeavyProfiler.entries) {
                    if (ignore && e.kind.startsWith("Web.API") && e.additionalData != null && e.additionalData.includes("/api/profilerHeavy/"))
                        continue;
                    result.push(toEntryTS(e, false, now));
                }
                res.json(result);
            });

        // The full sub-tree of one entry, flattened with the async-depth layout (Signum's Details + Fill).
        ws.get("/api/profilerHeavy/details/:fullIndex",
            { params: CustomType<{ fullIndex: string }>(), res: CustomType<HeavyProfilerEntryTS[]>() },
            async (req, res) => {
                await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
                const entry = HeavyProfiler.find(req.params.fullIndex);
                const result: HeavyProfilerEntryTS[] = [];
                fill(result, entry, 0, perfNow());
                res.json(result);
            });

        // The stack frames captured for one entry (Signum's StackTrace).
        ws.get("/api/profilerHeavy/stackTrace/:fullIndex",
            { params: CustomType<{ fullIndex: string }>(), res: CustomType<StackTraceTS[] | null>() },
            async (req, res) => {
                await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
                const e = HeavyProfiler.find(req.params.fullIndex);
                res.json(stackTraceOf(e));
            });

        // Download the whole log (or one sub-tree) as an XML file (Signum's Download + ExportXml).
        ws.get("/api/profilerHeavy/download",
            {},
            async (req, res) => {
                await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
                const indices = (req as Request).query["indices"] as string | undefined;
                const xml = indices == null ? HeavyProfiler.exportXml() : exportEntryXml(HeavyProfiler.find(indices));
                const fileName = `Profile-${new Date().toISOString().replace(/:/g, ".")}.xml`;
                res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
                res.type("application/xml").send(xml);
            });

        // Upload a previously-exported XML to merge & compare (Signum's Upload + ImportXml, rebaseTime).
        ws.post("/api/profilerHeavy/upload",
            { req: CustomType<{ fileName: string; content: string }>() },
            async (req, res) => {
                await assertAuthorized(ProfilerPermission.ViewHeavyProfiler);
                const file = JSON.parse((req as Request).body as unknown as string) as { fileName: string; content: string };
                // The client sends the file's base64 data-URL tail; decode to the raw XML text.
                const xml = Buffer.from(file.content, "base64").toString("utf8");
                HeavyProfiler.importXml(xml, /*rebaseTime*/ true);
                res.status(204).end();
            });

        // ---- Times (TimeTracker) ----------------------------------------------------------------

        ws.post("/api/profilerTimes/clear", {}, async (_req, res) => {
            await assertAuthorized(ProfilerPermission.ViewTimeTracker);
            TimeTracker.identifiedElapseds.clear();
            res.status(204).end();
        });

        ws.get("/api/profilerTimes/times",
            { res: CustomType<TimeTrackerEntryTS[]>() },
            async (_req, res) => {
                await assertAuthorized(ProfilerPermission.ViewTimeTracker);
                res.json([...TimeTracker.identifiedElapseds.values()].map(toTimeEntryTS));
            });
    }
}

async function assertAuthorized(permission: PermissionSymbol): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(permission)))
        throw new UnauthorizedAccessException(`Not authorized for '${permission.key}'`);
}

// perf clock shared with the profiler entries (same origin as PerfCounter.ticks).
function perfNow(): number {
    return performance.now();
}

// ---- HeavyProfilerEntry → wire DTO (Signum's HeavyProfofilerEntryTS) ---------------------------

interface HeavyProfilerEntryTS {
    beforeStart: number;
    start: number;
    end: number;
    totalMax: number;
    elapsed: string;
    kind: string;
    color: string;
    depth: number;
    asyncDepth: number;
    additionalData: string | undefined;
    fullIndex: string;
    isFinished: boolean;
}

function toEntryTS(e: HeavyProfilerEntry, fullAdditionalData: boolean, now: number): HeavyProfilerEntryTS {
    const end = e.end ?? now;
    return {
        beforeStart: e.beforeStart,
        start: e.start,
        end,
        totalMax: end,
        elapsed: e.elapsedToString(),
        isFinished: e.end != null,
        kind: e.kind,
        color: getColor(e.kind),
        depth: e.depth,
        asyncDepth: 0,
        fullIndex: e.fullIndex(),
        additionalData: fullAdditionalData ? e.additionalData : e.additionalDataPreview(),
    };
}

// Signum's HeavyProfofilerEntryTS.Fill — flattens the sub-tree while computing an "async depth": a child
// that overlaps in time with an earlier sibling is stacked below it (a lane), so concurrent spans don't
// draw on top of each other. Returns the max async depth used by this sub-tree.
function fill(result: HeavyProfilerEntryTS[], entry: HeavyProfilerEntry, asyncDepth: number, now: number): number {
    const entryTS = toEntryTS(entry, true, now);
    entryTS.asyncDepth = asyncDepth;
    result.push(entryTS);

    if (entry.entries == null)
        return asyncDepth;

    const entryInfos = new Map<HeavyProfilerEntry, { asyncDepth: number; totalMax: number }>();
    for (const e of entry.entries) {
        let maxAsyncDepth: number | undefined;
        for (const [key, info] of entryInfos) {
            if (overlapsAsync(key, info.totalMax, e, now))
                maxAsyncDepth = maxAsyncDepth == null ? info.asyncDepth : Math.max(maxAsyncDepth, info.asyncDepth);
        }

        const newAsyncDepth = fill(result, e, maxAsyncDepth != null ? maxAsyncDepth + 1 : asyncDepth + 1, now);
        const childTotalMax = result[result.length - 1].totalMax;
        entryInfos.set(e, { asyncDepth: newAsyncDepth, totalMax: childTotalMax });

        if (childTotalMax > entryTS.totalMax)
            entryTS.totalMax = childTotalMax;
    }

    return Math.max(...[...entryInfos.values()].map(a => a.asyncDepth));
}

function overlapsAsync(entry: HeavyProfilerEntry, entryTotalMax: number, other: HeavyProfilerEntry, now: number): boolean {
    const otherEnd = other.end ?? now;
    return !(entryTotalMax <= other.beforeStart || otherEnd <= entry.beforeStart);
}

// ---- Stack trace DTO (Signum's StackTraceTS) --------------------------------------------------

interface StackTraceTS {
    color: string | undefined;
    namespace: string;
    type: string | undefined;
    method: string;
    fileName: string | undefined;
    lineNumber: number;
}

function stackTraceOf(e: HeavyProfilerEntry): StackTraceTS[] | null {
    const frames = e.externalStackTrace ?? (e.stackTrace != null ? parseStackTrace(e.stackTrace) : undefined);
    if (frames == null)
        return null;
    return frames.map(f => ({
        color: f.fileName ? htmlColor(stringHash(f.fileName)) : undefined,
        namespace: f.namespace,
        type: f.type,
        method: f.method,
        fileName: f.fileName,
        lineNumber: f.lineNumber ?? 0,
    }));
}

// ---- TimeTracker → wire DTO -------------------------------------------------------------------

interface TimeTrackerTimeTS {
    duration: number;
    date: string;
    url: string | undefined;
    user: string | undefined;
}

interface TimeTrackerEntryTS {
    identifier: string;
    count: number;
    averageDuration: number;
    totalDuration: number;
    max: TimeTrackerTimeTS;
    max2: TimeTrackerTimeTS | undefined;
    max3: TimeTrackerTimeTS | undefined;
    min: TimeTrackerTimeTS;
    last: TimeTrackerTimeTS;
}

function toTimeEntryTS(e: import("@altea/altea/server/profiler/timeTracker").TimeTrackerEntry): TimeTrackerEntryTS {
    const t = (x: { duration: number; date: Date; url: string | undefined; user: unknown } | undefined): TimeTrackerTimeTS | undefined =>
        x == null ? undefined : { duration: x.duration, date: x.date.toISOString(), url: x.url, user: x.user == null ? undefined : String(x.user) };
    return {
        identifier: e.identifier,
        count: e.count,
        averageDuration: e.averageDuration,
        totalDuration: e.totalDuration,
        max: t(e.max)!,
        max2: t(e.max2),
        max3: t(e.max3),
        min: t(e.min)!,
        last: t(e.last)!,
    };
}

// ---- Colors (Signum's RoleColors + ColorExtensions.ToHtmlColor) --------------------------------

const roleColors: Record<string, string> = {
    "SQL": "gold",
    "DB": "mediumslateblue",
    "LINQ": "violet",
    "DBQuery": "cornflowerblue",
    "DBRetrieve": "mediumslateblue",
    "DBSave": "mediumpurple",
    "Execute": "seagreen",
    "MvcRequest": "limegreen",
    "MvcResult": "seagreen",
};

function getColor(role: string): string {
    return roleColors[role] ?? htmlColor(stringHash(role));
}

function stringHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
}

// Stable pastel HTML color from a hash (the analog of Signum's ColorExtensions.ToHtmlColor(hash)).
function htmlColor(hash: number): string {
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 60%, 65%)`;
}

// ---- XML for a single sub-tree (Signum's ExportXmlDocument) ------------------------------------

function exportEntryXml(entry: HeavyProfilerEntry): string {
    const sb: string[] = ["<Logs>"];
    entry.exportXml(sb, false);
    sb.push("</Logs>");
    return sb.join("");
}
