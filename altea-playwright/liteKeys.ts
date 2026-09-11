import { Entity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";

// `data-entity` is how the DOM names an entity: `"Order;3"` — the clean type name and the id (see
// EntityBase.tsx and the result table's rows). Signum's proxies hand that string back and a test picks it
// apart; here it comes back as a real `Lite<T>`, which is what everything else already takes: the browser's
// `framePage(lite)`, a search modal's `selectLite(lite)`, and a server-side `Database.retrieve`.

/** The entity a `data-entity` attribute names, as a lite. Throws if the attribute is not a lite key. */
export function liteFromKey<T extends Entity>(dataEntity: string): Lite<T> {
    const lite = tryLiteFromKey<T>(dataEntity);
    if (lite == null)
        throw new Error(`'${dataEntity}' is not an entity key ("CleanName;id"), or it names a NEW entity with no id.`);
    return lite;
}

/** As {@link liteFromKey}, but null for an empty attribute or an unsaved (id-less) entity. */
export function tryLiteFromKey<T extends Entity>(dataEntity: string | null | undefined): Lite<T> | null {
    if (dataEntity == null || dataEntity === "" || dataEntity === "null")
        return null;

    const [cleanName, id] = dataEntity.split(";");
    if (cleanName == null || cleanName === "" || id == null || id === "")
        return null;

    // `resolveType` looks the constructor up in the registry every entity module fills by being imported —
    // which a spec does anyway, since that is where the property lambdas come from. `parseId` is what knows
    // whether this type's key is an int or a uuid.
    const type = Entity.resolveType(cleanName) as unknown as Type<T>;
    return (type as unknown as typeof Entity).newLite.call(type, (type as unknown as typeof Entity).parseId.call(type, id)) as Lite<T>;
}
