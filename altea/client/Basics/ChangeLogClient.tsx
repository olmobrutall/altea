import { ajaxGet, ajaxPost } from "../Services";
import { mergeChangeLogs } from "./changeLogMerge";
import type { ChangeLogDic, ChangeItem } from "./changeLogMerge";

// Port of Signum's React/Basics/ChangeLogClient.tsx — the change-log REGISTRY and the API.
//
// The entries are SOURCE: each module ships a `Changelog.ts` whose default export maps a date to what
// changed on it, and registers it with one line from its client's `start`. Nothing is stored, so publishing
// an entry needs no migration and no database row — see data/changeLog for why that is the whole point.
//
// altea divergences:
//  - the MERGE lives in `./changeLogMerge` (see its header): it is a pure function over the loaded
//    dictionaries, and keeping it out of this module — which imports the ajax layer, and so `document` —
//    is what lets it be unit-tested headless.
//  - `start` takes no `routes`. Signum's signature has one and never uses it; the log opens in a modal and
//    Signum registers no route for it either.
//  - luxon is not needed at all. Every date use is a comparison or a group key, and ISO dates compare
//    correctly as strings (Signum imports luxon here and then also compares `implDate < date` as strings).

export type { ChangeLogDic, ChangeLogLine, ChangeItem } from "./changeLogMerge";

export namespace ChangeLogClient {

    export function start(options: {
        applicationName: string;
        mainChangeLog: () => Promise<{ default: ChangeLogDic }>;
    }): void {
        Options.applicationName = options.applicationName;
        Options.mainChangeLog = options.mainChangeLog;
        registerChangeLogModule("Altea", () => import("../Changelog"));
    }

    export const Options = {
        applicationName: undefined! as string,
        mainChangeLog: undefined! as () => Promise<{ default: ChangeLogDic }>,
        changeLogs: {} as { [module: string]: () => Promise<{ default: ChangeLogDic }> },
    };

    /**
     * Whether `start` has run — i.e. whether there is an application change log to load at all.
     *
     * A UI has to ask rather than infer it from "a user is logged in": `start` is called by the LOGGED-IN
     * bundle, and nothing guarantees that bundle has run by the time a component that gates on the current
     * user first renders. `getChangeLogs` calls `mainChangeLog` unconditionally, so getting that wrong is
     * a TypeError out of an unawaited promise rather than an empty log.
     *
     * (Seen in dev: rebuilding altea's dist under a running vite server invalidates this module, which
     * hands the importers that reload it a fresh `Options` while `start` — already run, in the previous
     * instance — is not called again. The guard is for the invariant, not for that.)
     */
    export function isStarted(): boolean {
        return Options.mainChangeLog != null;
    }

    /** Signum's same call: a module publishes its own changelog. */
    export function registerChangeLogModule(name: string, loader: () => Promise<{ default: ChangeLogDic }>): void {
        Options.changeLogs[name] = loader;
    }

    /** Load every registered dictionary and merge them into one deployment timeline. */
    export async function getChangeLogs(): Promise<ChangeItem[]> {
        const [mainLog, modules] = await Promise.all([
            Options.mainChangeLog().then(a => a.default),
            Promise.all(Object.entries(Options.changeLogs)
                .map(async ([module, load]) => ({ module, dic: (await load()).default }))),
        ]);

        return mergeChangeLogs(mainLog, modules, Options.applicationName);
    }

    export namespace API {
        export function getLastDate(): Promise<string | null> {
            return ajaxGet({ url: "/api/changelog/getLastDate" });
        }

        export function updateLastDate(): Promise<null> {
            return ajaxPost({ url: "/api/changelog/updateLastDate" }, null);
        }
    }
}
