import "@altea/altea/server";
import { table } from "@altea/altea/server/table";
import { OperationLogic } from "@altea/altea/server/operationLogic";
import type { IGraphStateOperation } from "@altea/altea/server/operation";
import { ExecutionMode } from "@altea/altea/server/executionMode";
import { Entity, type Type } from "@altea/altea/data/entity";
import { OperationLogEntity } from "@altea/altea/data/operationLog";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { Enum } from "@altea/altea/data/enum";
import type { OperationSymbol } from "@altea/altea/data/operations";
import type { Quoted } from "quote-transformer/quoted";
import { DefaultStateEnum, type MapOperation, type MapState, type OperationMapInfo } from "../data/Map";

// Port of Signum.Map's OperationMap.cs — one entity type's STATE MACHINE: a node per state, a node per
// operation, and an edge per (fromState → operation → toState) transition, each carrying how many rows /
// log entries it has.
//
// The whole thing rests on the operation's state SELECTOR, which Signum reads off `Graph<T,S>.GetState` as
// an `Expression<Func<T,S>>` and uses three ways: to enumerate the states (through S's reflection), to
// COUNT the rows in each (a `GroupBy` in SQL), and to build the query token the state node's Ctrl+Click
// filters by. altea's counterpart is `IGraphStateOperation.getState`, a `Quoted` lambda — that is the one
// core change this module needed (see server/graph.ts).
//
// altea divergences:
//  - **The state ENUM is discovered through the selector's PROPERTY ROUTE, not through a generic
//    parameter.** S is erased at runtime, so `typeof(S)`/`Enum.GetValues(S)` have no counterpart. But the
//    quoted selector navigates to a reflected FIELD, and that field's `TypeReference.getEnum()` IS the
//    enum object — which then yields every member, `Enum.isNotMapped` (Signum's `[Ignore]`) and
//    `Enum.niceName` for free. It also handles an operation created directly via
//    `new Graph.Execute(…)`, which never saw a `graph(T, StateEnum, …)` call at all.
//  - **`token` is ROOTLESS and camelCase** — `"state"`, `"scriptExecution.state"` — where Signum sends
//    `"Entity." + memberList`. That is altea's query-token grammar (see altea-agent on the same point).
//  - **No `fromToStates`.** Signum lets one operation declare a sparse from→to transition table; altea's
//    Graph.* classes have no such option, so the transitions are the cartesian product of the two lists —
//    which is what Signum's own client falls back to when `fromToStates` is null.
//  - **`ColorFor` is a plain hook, wired to nothing by default.** Signum leaves the same `Func<Entity,
//    string>?` unassigned with a "consider connecting ColorPaletteLogic.ColorFor here" comment; altea
//    keeps it a settable slot for exactly that, but does not create the altea-chart dependency.
export namespace OperationMap {

    /**
     * Signum's `OperationMap.ColorFor` — a per-state colour override, keyed by the state's enum member
     * name. Left unset by default; an app may point it at altea-chart's ColorPaletteLogic.
     */
    export let colorFor: ((stateKey: string) => string | null) | undefined = undefined;

    export async function getOperationMapInfo(type: Type<Entity>): Promise<OperationMapInfo> {
        const symbols = OperationLogic.operationsForType(type);
        const operations = symbols
            .map(s => ({ symbol: s, operation: OperationLogic.findOperation(s) as IGraphStateOperation }));

        // The state selector the MAP is drawn for: the most common one among this type's operations
        // (`graph(T, StateEnum, …)` stamps the same GetState onto every operation it builds, so that is
        // the type's own machine).
        //
        // ALTEA DIVERGENCE — one state type per map. Signum supports SEVERAL per type (one per Graph<T,S>
        // the operations came from) and counts each separately. That matters here because
        // `operationsForType` walks the prototype chain, so an operation registered on an ABSTRACT BASE
        // arrives with states of a FOREIGN enum — altea-alert registers `CreateAlertFromEntity` on
        // `Entity` with `toStates: [AlertState.New]`, which would otherwise be drawn as this type's
        // state 0. So an operation whose selector is not this map's is treated as state-UNAWARE and
        // drawn against the Start / End pseudo-states, which is what it is from this machine's point of
        // view.
        const getState = mostCommonSelector(operations.map(o => o.operation.getState));

        const route = getState == null ? undefined : tryRoute(type, getState);
        const stateEnum = route?.type.getEnum();

        const counts = getState == null || stateEnum == null
            ? new Map<string, number>()
            : await countByState(type, getState, stateEnum);

        const operationCounts = await countByOperation(symbols);

        // Every declared member of the state enum, plus the three pseudo-states — Signum's
        // `stateTypes.PreAnd(typeof(DefaultState))`.
        const states: MapState[] = [
            ...Enum.values(DefaultStateEnum).map(key => ({
                key,
                niceName: Enum.niceName(DefaultStateEnum, key),
                // Signum counts DefaultState.All as "every row of the type"; the other two are markers.
                count: 0,
                ignored: false,
                isSpecial: true,
                color: null,
                token: null,
            } satisfies MapState)),
            ...(stateEnum == null ? [] : Enum.values(stateEnum as Record<string, string | number>).map(key => ({
                key,
                niceName: Enum.niceName(stateEnum as Record<string, string | number>, key),
                count: counts.get(key) ?? 0,
                ignored: Enum.isNotMapped(stateEnum as Record<string, string | number>, key),
                isSpecial: false,
                color: colorFor?.(key) ?? null,
                token: route!.propertyString(),
            } satisfies MapState))),
        ];

        const totalRows = await ExecutionMode.global(() => table(type).count());
        states.find(s => s.isSpecial && s.key === "All")!.count = totalRows;

        return {
            states,
            operations: operations.map(({ symbol, operation }) => {
                // Only an operation on THIS machine contributes states (see the divergence above).
                const ownStates = operation.getState === getState;

                return {
                    key: symbol.key,
                    niceName: symbol.niceToString(),
                    count: operationCounts.get(symbol.key) ?? 0,
                    // A MISSING list means "not state-aware in this direction" — a constructor comes from
                    // nowhere, a delete goes nowhere — and Signum draws the Start / End pseudo-state for it.
                    // An EMPTY list means "any state", which is the All pseudo-state.
                    fromStates: withDefault(ownStates ? operation.fromStates : undefined, "Start", stateEnum),
                    toStates: withDefault(ownStates ? operation.toStates : undefined, "End", stateEnum),
                } satisfies MapOperation;
            }),
        };
    }

    /**
     * The selector most of this type's operations share — its OWN state machine. A tie (or none at all)
     * falls back to the first non-null, which is what a single-machine type always yields anyway.
     */
    function mostCommonSelector(
        selectors: (((entity: any) => unknown) | undefined)[],
    ): Quoted<(entity: Entity) => unknown> | undefined {
        const counts = new Map<(entity: any) => unknown, number>();
        for (const s of selectors)
            if (s != null)
                counts.set(s, (counts.get(s) ?? 0) + 1);

        let best: ((entity: any) => unknown) | undefined;
        let bestCount = 0;
        for (const [selector, count] of counts)
            if (count > bestCount) { best = selector; bestCount = count; }

        return best as Quoted<(entity: Entity) => unknown> | undefined;
    }

    /**
     * Signum's `WithDefaultStateArray`, plus the ORDINAL→NAME normalisation altea needs.
     *
     * altea's `graph(T, StateEnum, …)` types S as `StateEnum[keyof StateEnum]`, i.e. the enum's NUMERIC
     * member values — so a registration written the natural way (`toStates: [OrderState.Shipped]`) stores
     * `[2]`, while `MapState.key` is the member NAME. Signum has no such gap: its S IS the enum type, and
     * `a.ToString()` yields the name. `Enum.toName` bridges it, and it accepts a name unchanged — so a
     * registration written with bare string literals (the other convention in the repo) works too.
     */
    function withDefault(
        states: readonly unknown[] | undefined,
        forMissing: string,
        stateEnum: object | undefined,
    ): string[] {
        if (states == null)
            return [forMissing];
        if (states.length === 0)
            return ["All"];

        return states.map(s => {
            if (stateEnum != null && (typeof s === "number" || typeof s === "string")) {
                const name = Enum.toName(stateEnum as Record<string, string | number>, s as never);
                if (name != null)
                    return name;
            }
            return String(s);
        });
    }

    /**
     * The property route the state selector navigates to. `PropertyRoute.addLambda` reads the tree the
     * quote-transformer stamped, so a selector that is not a plain member navigation (a ternary, a
     * computed value) simply has no route — and the map then draws the operations with no state counts and
     * no Ctrl+Click filter, rather than failing.
     */
    function tryRoute(type: Type<Entity>, getState: Quoted<(entity: Entity) => unknown>): PropertyRoute | undefined {
        try {
            return PropertyRoute.root(type).addLambda(getState);
        } catch {
            return undefined;
        }
    }

    /**
     * `SELECT state, COUNT(*) FROM t GROUP BY state` — Signum's `CountGroupBy`. This is the whole reason
     * `getState` had to become a `Quoted` (see server/graph.ts): the selector is handed straight to
     * `groupBy`, so the count happens in SQL rather than by reading every row.
     *
     * The key is normalised through `Enum.toName`: what a materialised enum column yields is the
     * ordinal / member value, and `MapState.key` is the member NAME (the same boundary `withDefault`
     * crosses).
     */
    async function countByState(
        type: Type<Entity>,
        getState: Quoted<(entity: Entity) => unknown>,
        stateEnum: object,
    ): Promise<Map<string, number>> {
        const rows = await ExecutionMode.global(() => table(type)
            .groupBy(getState)
            .map(g => ({ state: g.key, count: g.elements.length }))
            .toArray());

        const result = new Map<string, number>();
        for (const r of rows) {
            if (r.state == null)
                continue;
            const key = (typeof r.state === "number" || typeof r.state === "string")
                ? Enum.toName(stateEnum as Record<string, string | number>, r.state as never) ?? String(r.state)
                : String(r.state);
            result.set(key, (result.get(key) ?? 0) + r.count);
        }
        return result;
    }

    /** How many times each of these operations has been logged (Signum's `operationCounts`). */
    async function countByOperation(symbols: OperationSymbol[]): Promise<Map<string, number>> {
        if (symbols.length === 0)
            return new Map();

        const keys = symbols.map(s => s.key);

        const rows = await ExecutionMode.global(() => table(OperationLogEntity)
            .filter(log => keys.includes(log.operation.key))
            .groupBy(log => log.operation.key)
            .map(g => ({ key: g.key, count: g.elements.length }))
            .toArray());

        return new Map(rows.map(r => [r.key, r.count]));
    }
}
