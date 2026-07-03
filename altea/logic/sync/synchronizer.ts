import * as fs from 'node:fs';
import { SqlPreCommand, Spacing, combineCommands } from './sqlPreCommand';
import { StringDistance, ChoiceType } from './stringDistance';
import type { ObjectName } from '../schema/objectName';

// Port of Signum's Engine/Sync/Synchronizer.cs — the generic dictionary 3-way merge that
// drives every diff in SchemaSynchronizer (createNew / removeOld / mergeBoth per key), plus
// the Replacements machinery that asks the user which removed name a new name renames.
//
// The generic operates on Map<K,V> (Signum's Dictionary<K,V>); callers convert altea's
// plain-object column/field dictionaries via `new Map(Object.entries(...))`.

export class Synchronizer {
    // Visit every key present in either dictionary, dispatching to createNew (new only),
    // removeOld (old only), or merge (both). Void form, used for side-effecting passes.
    static synchronize<K, N, O>(
        newDictionary: Map<K, N>,
        oldDictionary: Map<K, O>,
        createNew: ((key: K, n: N) => void) | undefined,
        removeOld: ((key: K, o: O) => void) | undefined,
        merge: ((key: K, n: N, o: O) => void) | undefined,
    ): void {
        const keys = new Set<K>([...oldDictionary.keys(), ...newDictionary.keys()]);

        for (const key of keys) {
            const oldExists = oldDictionary.has(key);
            const newExists = newDictionary.has(key);

            if (!oldExists)
                createNew?.(key, newDictionary.get(key)!);
            else if (!newExists)
                removeOld?.(key, oldDictionary.get(key)!);
            else
                merge?.(key, newDictionary.get(key)!, oldDictionary.get(key)!);
        }
    }

    // The workhorse: build one SqlPreCommand per key (createNew / removeOld / mergeBoth),
    // then combine them with `spacing`. A null callback (or a callback returning undefined)
    // contributes nothing. Mirrors Signum's SynchronizeScript.
    static synchronizeScript<K, N, O>(
        spacing: Spacing,
        newDictionary: Map<K, N>,
        oldDictionary: Map<K, O>,
        createNew: ((key: K, n: N) => SqlPreCommand | undefined) | undefined,
        removeOld: ((key: K, o: O) => SqlPreCommand | undefined) | undefined,
        mergeBoth: ((key: K, n: N, o: O) => SqlPreCommand | undefined) | undefined,
    ): SqlPreCommand | undefined {
        const set = new Set<K>([...newDictionary.keys(), ...oldDictionary.keys()]);

        const list = [...set].map(key => {
            const newVal = newDictionary.get(key);
            const oldVal = oldDictionary.get(key);

            if (newVal === undefined)
                return removeOld == null ? undefined : removeOld(key, oldVal!);

            if (oldVal === undefined)
                return createNew == null ? undefined : createNew(key, newVal);

            return mergeBoth == null ? undefined : mergeBoth(key, newVal, oldVal);
        });

        return combineCommands(spacing, list);
    }

    // Asks for renames on the given key first, then runs synchronizeScript with the
    // replacement-applied old dictionary. Mirrors Signum's SynchronizeScriptReplacing.
    static synchronizeScriptReplacing<N, O>(
        replacements: Replacements,
        replacementsKey: string,
        spacing: Spacing,
        newDictionary: Map<string, N>,
        oldDictionary: Map<string, O>,
        createNew: ((key: string, n: N) => SqlPreCommand | undefined) | undefined,
        removeOld: ((key: string, o: O) => SqlPreCommand | undefined) | undefined,
        mergeBoth: ((key: string, n: N, o: O) => SqlPreCommand | undefined) | undefined,
    ): SqlPreCommand | undefined {
        replacements.askForReplacements(
            new Set(oldDictionary.keys()),
            new Set(newDictionary.keys()),
            replacementsKey);

        const repOldDictionary = replacements.applyReplacementsToOld(oldDictionary, replacementsKey);

        return Synchronizer.synchronizeScript(spacing, newDictionary, repOldDictionary, createNew, removeOld, mergeBoth);
    }
}

// A removed name and the new name it was renamed to (null = genuinely removed). Mirrors
// Signum's Replacements.Selection.
export interface Selection {
    readonly oldValue: string;
    readonly newValue: string | null;
}

// Context handed to an AutoReplacement callback so tests / tooling can answer renames
// non-interactively. Mirrors Signum's Replacements.AutoReplacementContext.
export interface AutoReplacementContext {
    replacementKey: string;
    oldValue: string;
    newValues: string[] | null;
}

// Port of Signum's Replacements (a Dictionary<string, Dictionary<string,string>>): per-key
// maps of oldName -> newName, learned by asking (or by an AutoReplacement hook) which removed
// name each surviving new name renames. Backed by a Map; the C# indexer/TryGetC/GetOrCreate
// become methods of the same name.
export class Replacements {
    private readonly map = new Map<string, Map<string, string>>();

    static readonly keyTables = 'Tables';
    static readonly keyTablesInverse = 'TablesInverse';
    static keyColumnsForTable(tableName: string): string { return 'Columns:' + tableName; }
    static keyEnumsForTable(tableName: string): string { return 'Enums:' + tableName; }

    interactive = true;
    schemaOnly = false;
    replaceDatabaseName: string | null = null;

    // Non-interactive answer hooks (Signum's AutoReplacement / GlobalAutoReplacement /
    // ResponseRecorder). When an autoReplacement is set it short-circuits the console prompt,
    // which is how the test suite drives renames headlessly.
    static globalAutoReplacement: ((ctx: AutoReplacementContext) => Selection | null) | undefined;
    autoReplacement: ((ctx: AutoReplacementContext) => Selection | null) | undefined;
    static responseRecorder: ((replacementsKey: string, oldValue: string, newValue: string | null) => void) | undefined;

    // ---- Dictionary-shaped access (mirrors the C# base Dictionary API) ------

    tryGetC(replacementsKey: string): Map<string, string> | undefined {
        return this.map.get(replacementsKey);
    }

    containsKey(replacementsKey: string): boolean {
        return this.map.has(replacementsKey);
    }

    set(replacementsKey: string, value: Map<string, string>): void {
        this.map.set(replacementsKey, value);
    }

    getOrCreate(replacementsKey: string): Map<string, string> {
        let d = this.map.get(replacementsKey);
        if (d == null) {
            d = new Map<string, string>();
            this.map.set(replacementsKey, d);
        }
        return d;
    }

    // ---- Replacement application --------------------------------------------

    apply(replacementsKey: string, textToReplace: string): string {
        return this.map.get(replacementsKey)?.get(textToReplace) ?? textToReplace;
    }

    applyReplacementsToOld<O>(oldDictionary: Map<string, O>, replacementsKey: string): Map<string, O> {
        const replacements = this.map.get(replacementsKey);
        if (replacements == null)
            return oldDictionary;

        return selectDictionary(oldDictionary, a => replacements.get(a) ?? a);
    }

    applyReplacementsToNew<O>(newDictionary: Map<string, O>, replacementsKey: string): Map<string, O> {
        const replacements = this.map.get(replacementsKey);
        if (replacements == null)
            return newDictionary;

        const inverse = inverseMap(replacements);
        return selectDictionary(newDictionary, a => inverse.get(a) ?? a);
    }

    // ---- The rename dialogue -------------------------------------------------

    // For the names that are old-only vs new-only, learn the old->new renames: match already
    // recorded ones, then rank the rest by Levenshtein distance and ask (or auto-answer).
    // Faithful to Signum's AskForReplacements.
    askForReplacements(oldKeys: Set<string>, newKeys: Set<string>, replacementsKey: string): void {
        let oldOnly = [...oldKeys].filter(k => !newKeys.has(k));
        let newOnly = [...newKeys].filter(k => !oldKeys.has(k));

        if (oldOnly.length === 0 || newOnly.length === 0)
            return;

        const replacements = this.map.get(replacementsKey) ?? new Map<string, string>();

        if (replacements.size > 0) {
            const toRemove = [...replacements].filter(([k, v]) => oldOnly.includes(k) && newOnly.includes(v));
            for (const [k, v] of toRemove) {
                oldOnly = oldOnly.filter(a => a !== k);
                newOnly = newOnly.filter(a => a !== v);
            }
        }

        if (oldOnly.length === 0 || newOnly.length === 0)
            return;

        const sd = new StringDistance();

        // distances[old][new] = weighted edit distance.
        const distances = new Map<string, Map<string, number>>(
            oldOnly.map(o => [o, new Map<string, number>(newOnly.map(n => [n, distance(sd, o, n)]))]));

        const alwaysNoRename = { value: false };

        while (oldOnly.length > 0 && newOnly.length > 0) {
            // The old name whose best (minimum) candidate distance is smallest overall.
            const oldDist = minBy([...distances], kvp => Math.min(...kvp[1].values()))!;

            const alternatives = [...oldDist[1]].sort((a, b) => a[1] - b[1]).map(a => a[0]);

            const selection = this.selectInteractiveInternal(oldDist[0], alternatives, replacementsKey, this.interactive, alwaysNoRename);

            oldOnly = oldOnly.filter(a => a !== selection.oldValue);
            distances.delete(selection.oldValue);

            if (selection.newValue != null) {
                replacements.set(selection.oldValue, selection.newValue);

                newOnly = newOnly.filter(a => a !== selection.newValue);

                for (const dic of distances.values())
                    dic.delete(selection.newValue);
            }
        }

        if (replacements.size !== 0 && !this.map.has(replacementsKey))
            setRange(this.getOrCreate(replacementsKey), replacements);
    }

    // Single-value variant (Signum's public SelectInteractive) — returns the matching new
    // value for one old value, recording the choice. Used by the enum-row sync.
    selectInteractive(oldValue: string, newValues: string[], replacementsKey: string, sd: StringDistance): string | null {
        if (newValues.includes(oldValue))
            return oldValue;

        const rep = this.map.get(replacementsKey)?.get(oldValue);
        if (rep != null && newValues.includes(rep))
            return rep;

        const dic = new Map<string, number>(newValues.map(a => [a, distance(sd, oldValue, a)]));

        const temp = { value: false };
        const sel = this.selectInteractiveInternal(
            oldValue,
            [...dic].sort((a, b) => a[1] - b[1]).map(a => a[0]),
            replacementsKey,
            this.interactive,
            temp);

        if (sel.newValue != null)
            this.getOrCreate(replacementsKey).set(sel.oldValue, sel.newValue);

        return sel.newValue;
    }

    // The interactive core (Signum's SelectInteractive with `ref alwaysNoRename`). Consults
    // the auto-replacement hook first; otherwise prompts on the console (synchronous stdin).
    private selectInteractiveInternal(
        oldValue: string,
        newValues: string[],
        replacementsKey: string,
        interactive: boolean,
        alwaysNoRename: { value: boolean },
    ): Selection {
        const auto = this.autoReplacement ?? Replacements.globalAutoReplacement;
        if (auto != null) {
            const selection = auto({ replacementKey: replacementsKey, oldValue, newValues });
            if (selection != null) {
                console.log('AutoReplacement:');
                console.log(' OLD ' + selection.oldValue);
                console.log(' NEW ' + selection.newValue);
                return selection;
            }
        }

        if (!interactive)
            throw new Error(`Unable to ask for renames for '${oldValue}' (in ${replacementsKey}) without interactive console, consider providing an AutoReplacement.`);

        if (alwaysNoRename.value)
            return { oldValue, newValue: null };

        console.log();
        console.log(`   '${oldValue}' has been renamed in ${replacementsKey}?`);

        for (;;) {
            let i = 0;
            for (const v of newValues) {
                console.log(`${String(i).padStart(2)}: ${v}${i === 0 ? ' (hit [Enter])' : ''}`);
                i++;
            }
            console.log(` n: No rename, '${oldValue}' was removed`);
            console.log(` n!: Always no rename`);

            const answer = (readLineSync() ?? 'n').toLowerCase();

            let response: Selection | undefined;
            if (answer === 'n')
                response = { oldValue, newValue: null };
            else if (answer === 'n!') {
                alwaysNoRename.value = true;
                response = { oldValue, newValue: null };
            } else if (answer === '')
                response = { oldValue, newValue: newValues[0] };
            else {
                const option = Number.parseInt(answer, 10);
                if (Number.isInteger(option) && option >= 0 && option < newValues.length)
                    response = { oldValue, newValue: newValues[option] };
            }

            if (response != null) {
                Replacements.responseRecorder?.(replacementsKey, response.oldValue, response.newValue);
                return response;
            }

            console.log('Error');
        }
    }

    concretizeObjectName(objectName: ObjectName): string {
        return objectName.toString();
    }
}

// Levenshtein distance with substitutions weighted double (Signum's Replacements.Distance).
function distance(sd: StringDistance, o: string, n: string): number {
    return sd.levenshteinDistance(o, n, c => c.type === ChoiceType.Substitute ? 2 : 1);
}

// ---- Small Map helpers (the LINQ-ish extensions the C# leans on) ------------

function selectDictionary<O>(dict: Map<string, O>, keySelector: (k: string) => string): Map<string, O> {
    const result = new Map<string, O>();
    for (const [k, v] of dict)
        result.set(keySelector(k), v);
    return result;
}

function inverseMap(m: Map<string, string>): Map<string, string> {
    const result = new Map<string, string>();
    for (const [k, v] of m)
        result.set(v, k);
    return result;
}

function setRange(target: Map<string, string>, source: Map<string, string>): void {
    for (const [k, v] of source)
        target.set(k, v);
}

function minBy<T>(items: T[], selector: (t: T) => number): T | undefined {
    let best: T | undefined;
    let bestVal = Number.POSITIVE_INFINITY;
    for (const it of items) {
        const v = selector(it);
        if (v < bestVal) {
            bestVal = v;
            best = it;
        }
    }
    return best;
}

// Synchronous console line read (blocks the event loop). Keeps askForReplacements
// synchronous like the C#, instead of forcing the whole synchronizer async through
// readline. Returns null on EOF. Divergence: Signum uses Console.ReadLine directly.
function readLineSync(): string | null {
    const buffer = Buffer.alloc(1);
    let line = '';
    for (;;) {
        let bytes: number;
        try {
            bytes = fs.readSync(0, buffer, 0, 1, null);
        } catch {
            return line.length > 0 ? line : null;
        }
        if (bytes === 0)
            return line.length > 0 ? line : null;
        const ch = buffer.toString('utf8', 0, 1);
        if (ch === '\n')
            return line.replace(/\r$/, '');
        line += ch;
    }
}
