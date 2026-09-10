import type { SchemaBuilder } from "@altea/altea/server/schema";
import { SymbolLogic } from "@altea/altea/server/symbolLogic";
import { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import { SimpleTaskSymbol } from "../data/Scheduler";
import { SchedulerLogic } from "./SchedulerLogic";
import type { ScheduledTaskContext } from "./ScheduleTaskRunner";

// The simplest kind of task: a NAMED FUNCTION. The app declares a SimpleTaskSymbol and registers the
// function behind it; a ScheduledTask then points at the symbol, so scheduling arbitrary code needs no
// entity of its own.
//
// **The registry is keyed by the symbol's KEY, not by the symbol OBJECT.** A symbol read back from the
// database is a fresh instance, not the declared singleton, so an identity-keyed Map misses on every
// scheduled run — it only ever hits for a task executed straight from the declared symbol.
//
// See docs/port/Scheduler.md.

export namespace SimpleTaskLogic {

    const tasks = new Map<string, (ctx: ScheduledTaskContext) => Promise<Lite<Entity> | null>>();
    const declared: SimpleTaskSymbol[] = [];

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        SymbolLogic.start(sb, SimpleTaskSymbol, () => declared);

        SchedulerLogic.registerExecuteTask(SimpleTaskSymbol, async (task, ctx) => {
            const action = tasks.get((task as SimpleTaskSymbol).key);
            if (action == null)
                throw new Error(`SimpleTask '${(task as SimpleTaskSymbol).key}' has no registered function`);
            return await action(ctx);
        });

        sb.include(SimpleTaskSymbol).withQuery();
    }

    /** Bind a function to a declared SimpleTaskSymbol. Call it BEFORE
     *  SchedulerLogic.start, since the symbol table is seeded from these keys. */
    export function register(
        simpleTaskSymbol: SimpleTaskSymbol,
        action: (ctx: ScheduledTaskContext) => Promise<Lite<Entity> | null>,
    ): void {
        if (simpleTaskSymbol == null)
            throw new Error("SimpleTaskLogic.register: the symbol is null — is it declared with init() inside a namespace?");
        if (tasks.has(simpleTaskSymbol.key))
            throw new Error(`SimpleTaskLogic.register: '${simpleTaskSymbol.key}' is already registered`);

        tasks.set(simpleTaskSymbol.key, action);
        declared.push(simpleTaskSymbol);
    }
}
