import type { ChangeLogDic } from "./Basics/ChangeLogClient";

// The FRAMEWORK's own change log — Signum's `Signum/Changelog.ts`, registered under "Altea" by
// `ChangeLogClient.start`.
//
// One entry per date, newest last is not required (the viewer sorts). An application pulls these into its
// own deployment timeline by writing `Update Altea` — or `Update Altea to <date>` — in ITS changelog; see
// `ChangeLogClient.getChangeLogs`.
//
// Keep it to what a reader of the APPLICATION would notice. Refactors and internal ports do not belong
// here; a behaviour change, a new line type, a fixed bug does.
const changeLog: ChangeLogDic = {
    "2026-09-04": [
        "A user-asset's collection rows keep their identity across an XML export/import",
        "A generated uuid key is time-ordered (uuidv7)",
        "Add the change log viewer",
    ],
};

export default changeLog;
