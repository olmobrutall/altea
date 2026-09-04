// The change log MERGE — the body of Signum's `ChangeLogClient.getChangeLogs`, extracted.
//
// It is a pure function over the loaded dictionaries, and it is the only non-trivial part of the change
// log, so it lives apart from `ChangeLogClient`: that module imports the ajax layer, which touches `document`
// at load time, and this way the algorithm can be unit-tested headless (see test/client/changeLog.test.ts).
// Signum keeps the two together and does not test the merge.
//
// What it does: a MODULE dates its entries by when they were IMPLEMENTED, which is not when the
// application carrying them was deployed. So the app's changelog carries `Update <Module>` lines, and each
// is REPLACED by that module's entries implemented before the named date (or before that deployment).
//
// Which date those entries then carry is worth being precise about, because the two forms differ — this is
// Signum's behaviour, kept: a bare `Update <Module>` gives them the APP's deploy date, while
// `Update <Module> to <date>` gives them the date NAMED in the line. So the named form says "we took the
// module as of then", not "a user saw it then". Whatever no line claimed belongs to the newest deployment,
// so an entry is never silently dropped.

/** A module's changelog: date → what changed on it. One line or several. */
export interface ChangeLogDic {
    [date: string]: ChangeLogLine | ChangeLogLine[];
}

/**
 * A single entry. The two literal forms are the ones the merge READS rather than just displays; the
 * `string & {}` keeps every other string assignable while still offering those two as completions.
 */
export type ChangeLogLine = "Update Altea" | "Update Altea to yyyy-MM-dd" | (string & {});

/** One line of the merged timeline: what changed, in which module, implemented and deployed when. */
export interface ChangeItem {
    module: string;
    /** When the module made the change (its own dictionary key). */
    implDate: string;
    /** When the application carrying it was deployed — filled by the merge. */
    deployDate: string;
    changeLog: ChangeLogLine[];
}

/** `Update <Module>` / `Update <Module> to <yyyy-MM-dd>` — Signum's same regex. */
const updateRegex = /Update (?<mod>\w+)( to (?<date>\d{4}.\d{2}.\d{2}))?/;

export function mergeChangeLogs(
    mainLog: ChangeLogDic,
    modules: { module: string; dic: ChangeLogDic }[],
    applicationName: string,
): ChangeItem[] {
    const modLogs = modules.flatMap(m => toItems(m.dic, m.module, /* ownDeployDate */ false));
    const mainLogs = toItems(mainLog, applicationName, /* ownDeployDate */ true);

    const result: ChangeItem[] = [];

    mainLogs.orderBy(log => log.deployDate).forEach((log, i) => {
        result.push(log);

        // Each `Update <Module>` line is CONSUMED and replaced by that module's entries.
        log.changeLog.extract(line => {
            const m = updateRegex.exec(line);
            if (m == null)
                return false;

            const mod = m.groups!["mod"]!;
            const date = m.groups!["date"] ?? log.deployDate;

            // A module name matches itself and its sub-modules ("Altea" covers "Altea.Chart"), so one line
            // can pull in a whole family — which is how a framework bump is written in practice.
            const included = modLogs.extract(l =>
                (l.module === mod || l.module.startsWith(mod + ".")) && l.implDate < date);

            included.forEach(a => a.deployDate = date);
            result.push(...included);
            return true;
        });

        // Whatever no line claimed belongs to the newest deployment.
        if (i === mainLogs.length - 1) {
            modLogs.forEach(a => a.deployDate = log.deployDate);
            result.push(...modLogs);
            modLogs.clear();
        }
    });

    return result;
}

/** date → items. The APP's entries deploy on their own date; a module's is unknown until the merge. */
function toItems(dic: ChangeLogDic, module: string, ownDeployDate: boolean): ChangeItem[] {
    return Object.entries(dic).map(([date, changeLog]) => ({
        module,
        implDate: date,
        deployDate: (ownDeployDate ? date : undefined) as string,
        changeLog: Array.isArray(changeLog) ? [...changeLog] : [changeLog],
    }));
}
