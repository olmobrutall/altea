import { MixinEntity, type BaseEntity, type Type } from "./entity";
import { reflect } from "./reflection";
import { MixinDeclarations } from "./mixinDeclarations";
import { Statics, type IContextVariable } from "./utils/context";

// Signum's CorruptMixin (Entities/Patterns/CorruptMixin.cs): an entity that is allowed to be saved INCOMPLETE
// — imported or legacy data that does not yet pass every rule. While `corrupt` is set its integrity check runs
// with `Corruption.strict` false, so a rule written `if (Corruption.strict) …` stands down; each save re-checks
// it strictly, and the flag clears once the entity is valid (see Corruption.preSaving).
@reflect
export class CorruptMixin extends MixinEntity {
    corrupt: boolean = false; // C# bool default — new rows are not corrupt
}

// Created on first use: the context storage is installed by the host's first import, after this module loads.
let allowedVar: IContextVariable<boolean> | undefined;
function allowed(): IContextVariable<boolean> {
    return allowedVar ??= Statics.newContextVariable<boolean>();
}

/** The strict / tolerant switch the validation rules of a corrupt entity read (Signum's Corruption). */
export namespace Corruption {

    /** False inside `allowScope` — a rule that must not bind an entity still being imported checks this. */
    export function strict(): boolean {
        return allowed().getValue() !== true;
    }

    /** Run `fn` with corruption allowed (Signum's `using (Corruption.AllowScope())`). */
    export function allowScope<R>(fn: () => R): R {
        return allowed().getValue() === true ? fn() : allowed().withValue(true, fn);
    }

    /** Run `fn` strictly again inside an allowed scope (Signum's DenyScope). */
    export function denyScope<R>(fn: () => R): R {
        return allowed().getValue() === true ? allowed().withValue(false, fn) : fn();
    }

    /** A corrupt entity was saved still failing its strict check (Signum's SaveCorrupted) — to log it, say. */
    export const onSaveCorrupted: ((entity: BaseEntity, errors: Record<string, string>) => void)[] = [];

    /** A saved entity passed its strict check and stopped being corrupt (Signum's CorruptionRemoved). */
    export const onCorruptionRemoved: ((entity: BaseEntity) => void)[] = [];

    /** Whether the entity's type declares the mixin and its flag is set — its integrity check is tolerant. */
    export function isCorrupt(entity: BaseEntity): boolean {
        return MixinDeclarations.getMixins(entity.constructor as Type<BaseEntity>).includes(CorruptMixin)
            && (entity as unknown as CorruptMixin).corrupt === true;
    }

    /**
     * Signum's CorruptMixin.PreSaving, run by the saver before the save's integrity check: a corrupt entity is
     * checked STRICTLY — clean, it stops being corrupt (and an existing one reports it); still failing, the save
     * goes ahead tolerantly and reports that instead. `strictErrors` is the entity's own strict integrity check.
     */
    export async function preSaving(entity: BaseEntity & { isNew?: boolean },
        strictErrors: () => Promise<Record<string, string> | undefined>): Promise<void> {
        if (!isCorrupt(entity))
            return;

        const errors = await denyScope(strictErrors);
        if (errors == null) {
            (entity as unknown as CorruptMixin).corrupt = false;
            if (!entity.isNew)
                for (const handler of onCorruptionRemoved)
                    handler(entity);
        } else {
            for (const handler of onSaveCorrupted)
                handler(entity, errors);
        }
    }
}
