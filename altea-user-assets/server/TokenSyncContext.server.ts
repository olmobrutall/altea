import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import { Replacements } from "@altea/altea/server/sync/synchronizer";
import { StringDistance } from "@altea/altea/server/sync/stringDistance";
import type { Entity } from "@altea/altea/data/entity";
import {
    TokenMigrationFile, type RenameBucket, type UserAssetEntityActionType,
} from "./TokenMigrationFile.server";
import type { IUserAssetEntity } from "../data/UserAssets";

// Port of Signum.UserAssets' TokenMigrations/TokenSyncContext.cs — the context handed to every
// `TokenSynchronizing` subscriber. It carries the ordered history of migration files to resolve against
// and, in Record mode, the in-progress file new decisions are appended to.
//
// altea divergences, documented inline:
//  - `AskRename` is ASYNC, because every SafeConsole prompt is (node's readline).
//  - the interactive picker DELEGATES to `Replacements.selectInteractive`, which is the same prompt the
//    schema synchronizer already shows for a table or column rename — same numbered list ordered by
//    Levenshtein distance, same "n: None", same paging. Signum re-implements it here by hand, complete
//    with its own `Console.LargestWindowHeight - 11` paging arithmetic; there is no reason for a developer
//    to meet two different rename prompts in one session, and reusing the one they already know means the
//    global auto-replacement hook works here for free.
//  - an asset's id is a STRING (altea's user assets are uuid-keyed) where Signum casts it to `Guid`.

export type TokenSyncMode =
    /**
     * Subscribers walk their entities consulting {@link TokenSyncContext.history} to resolve, and append
     * any NEW decisions into {@link TokenSyncContext.recording}. Entities are NOT saved; at the end of the
     * run the recording is written to a `.tokens.json`.
     */
    | "Record"
    /**
     * Decisions already recorded in {@link TokenSyncContext.history} are replayed against the entities.
     * Nothing prompts, and each entity is saved in its own transaction.
     */
    | "Apply";

/** Signum's `TokenSyncEntityReport`. */
export class TokenSyncEntityReport {
    constructor(
        public readonly entity: Entity,
        public readonly changes: string[],
        public readonly action: UserAssetEntityActionType | null,
        public readonly error: unknown,
    ) { }
}

export class TokenSyncContext {
    constructor(
        public readonly mode: TokenSyncMode,
        /**
         * Ordered, read-only history. In Record mode every committed file; in Apply mode the PENDING
         * ones. The chained walk goes through them in order, so `V1: Name→Nombre` followed by
         * `V2: Nombre→FullName` resolves to FullName even when both land in one batch.
         */
        public readonly history: TokenMigrationFile[],
        /**
         * The in-progress file. Non-null in Record mode (decisions are appended here); null in Apply
         * mode, which is also what makes "no prompting" checkable — see {@link canPrompt}.
         */
        public readonly recording: TokenMigrationFile | null,
    ) { }

    get historyAndRecordingsCount(): number {
        return this.history.length + (this.recording == null ? 0 : 1);
    }

    getHistoryAndRecording(index: number): TokenMigrationFile {
        if (index < this.history.length)
            return this.history[index]!;
        if (this.recording != null && index === this.history.length)
            return this.recording;
        throw new Error(`Index ${index} is out of range for history and recording`);
    }

    /** Record mode can ask a human; Apply mode must resolve from what was recorded or fail. */
    get canPrompt(): boolean {
        return this.recording != null;
    }

    /**
     * Signum's `IsKnownAction` — a Skip/Delete/Regenerate decision recorded for this asset in an earlier
     * session, to honour in Apply mode. Returns null when there is none.
     */
    knownAction(entity: IUserAssetEntity): UserAssetEntityActionType | null {
        const typeName = entity.constructor.name;
        const id = String((entity as unknown as Entity).id);
        for (const file of this.history) {
            const match = file.userAssetActions?.find(a => a.entityType === typeName && a.guid === id);
            if (match != null)
                return match.action;
        }
        return null;
    }

    /** Signum's `AddUserAssetAction` — record a per-asset decision. Record mode only. */
    addUserAssetAction(entity: IUserAssetEntity, action: UserAssetEntityActionType): void {
        if (this.recording == null)
            throw new Error("addUserAssetAction is only valid in Record mode.");

        (this.recording.userAssetActions ??= []).push({
            entityType: entity.constructor.name,
            guid: String((entity as unknown as Entity).id),
            action,
        });
    }

    /**
     * Signum's `AskRename` — resolve `oldValue` to one of `newValues`, using (in order) the recorded
     * history, this session's own decisions, the global auto-replacement hook, and finally a prompt.
     *
     * The history walk is CHAINED file by file rather than pre-flattened: `V1: A→B` then `V2: B→C` lands
     * at C in one pass. When a `subKey` is given, each file is looked up under the name that subKey had
     * at THAT file's era (see {@link computeEraSubKeys}) — which is what lets a rename recorded in V1
     * against `Foo.OldType` still match after a later V2 renamed the type to `Foo.NewType`.
     *
     * Apply mode throws on a miss rather than prompting: a replay that quietly guessed would be worse
     * than one that stops.
     */
    async askRename(
        bucket: RenameBucket,
        subKey: string | null,
        oldValue: string,
        newValues: readonly string[],
        sd: StringDistance,
    ): Promise<string | null> {
        if (newValues.includes(oldValue))
            return oldValue;

        const eraSubKeys = subKey == null ? null : this.computeEraSubKeys(subKey);

        let current = oldValue;
        for (let fi = 0; fi < this.historyAndRecordingsCount; fi++) {
            const file = this.getHistoryAndRecording(fi);
            const effectiveSubKey = eraSubKeys?.[fi] ?? subKey ?? undefined;
            const d = file.tryGetDictionary(bucket, effectiveSubKey);
            const v = d?.[current];
            if (v != null)
                current = v;
        }

        if (current !== oldValue && newValues.includes(current))
            return current;

        // This session's own earlier decisions (Signum's in-session memo).
        if (this.recording != null) {
            const rd = this.recording.tryGetDictionary(bucket, subKey ?? undefined);
            const rv = rd?.[oldValue];
            if (rv != null && newValues.includes(rv))
                return rv;
        }

        const replacementsKey = bucket + (subKey == null ? "" : ":" + subKey);

        // The same hook the schema synchronizer consults, so one auto-replacement function covers both.
        const auto = Replacements.globalAutoReplacement;
        if (auto != null) {
            const sel = auto({ replacementKey: replacementsKey, oldValue, newValues: [...newValues] });
            if (sel?.newValue != null) {
                if (this.recording != null)
                    this.recording.getOrCreateDictionary(bucket, subKey ?? undefined)[oldValue] = sel.newValue;
                return sel.newValue;
            }
        }

        if (this.recording == null)
            throw new Error(`'${oldValue}' in '${replacementsKey}' has no recorded rename and Apply mode cannot prompt.`);

        // Signum hand-rolls the numbered picker here; this is the synchronizer's own, which the developer
        // has already met for table and column renames in the same session. See the header.
        const picked = await new Replacements().selectInteractive(oldValue, [...newValues], replacementsKey, sd);
        if (picked != null)
            this.recording.getOrCreateDictionary(bucket, subKey ?? undefined)[oldValue] = picked;
        return picked;
    }

    /**
     * Signum's `ComputeEraSubKeys` — for each history file, what `liveSubKey` was CALLED at that file's
     * era. Walks newest → oldest, unwinding through each file's `types` renames, so an older file can be
     * looked up under the name it actually used.
     */
    computeEraSubKeys(liveSubKey: string): string[] {
        const eras = new Array<string>(this.historyAndRecordingsCount);
        let running = liveSubKey;
        for (let fi = this.historyAndRecordingsCount - 1; fi >= 0; fi--) {
            eras[fi] = running;
            // If this file maps X → running, then everything before it used X.
            for (const [oldT, newT] of Object.entries(this.getHistoryAndRecording(fi).types ?? {})) {
                if (newT === running) {
                    running = oldT;
                    break;
                }
            }
        }
        return eras;
    }

    /** Signum's `LogError` — name the entity and the problem, and carry on with the next one. */
    logError(entity: Entity, error: unknown): void {
        SafeConsole.writeLineColor(Color.red, `${entity.constructor.name} ${entity.toString()}:`);
        SafeConsole.writeLineColor(Color.darkRed, "  " + (error instanceof Error ? error.message : String(error)));
    }
}
