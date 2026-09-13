import type { Locator } from "playwright";
import type { PropertyRoute } from "@altea/altea/data/propertyRoute";
import type { Lite } from "@altea/altea/data/lite";
import { Entity } from "@altea/altea/data/entity";
import type { BaseEntity, Type } from "@altea/altea/data/entity";
import { BaseLineProxy } from "./BaseLineProxy";
import { captureOnClick, getChanges, isPresent, scope, waitChanges, waitFor, waitVisible, type Scope } from "../PlaywrightExtensions";
import { tryLiteFromKey } from "../liteKeys";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
// TYPE-only, and the classes are imported LAZILY where they are used: a modal proxy holds a LineContainer,
// which holds every line proxy, which extends this class — a cycle that JS resolves only if nothing needs
// the binding while the modules are still evaluating.
import type { FrameModalProxy } from "../Frames/FrameModalProxy";
import type { SearchModalProxy } from "../Search/SearchModalProxy";

// Port of Signum.Playwright's LineProxies/EntityBaseProxy.cs — everything the entity-valued lines share:
// the four buttons (create / view / find / remove), the autocomplete, and reading the entity behind the line.
//
// altea divergence, and it matters for `entityInfo`: altea's `data-entity` is `"CleanType;id"` (see
// EntityBase.tsx) where Signum's is `"typeName;id;isNew"` — so `isNew` is inferred from an EMPTY id instead
// of being a third field.
export abstract class EntityBaseProxy<S = unknown> extends BaseLineProxy {

    /** Where the buttons live. EntityDetail overrides this with its `<legend>`. */
    get buttonBar(): Locator { return this.element; }

    /** The route of ONE item — the line's own route, except for the collection lines. */
    get itemRoute(): PropertyRoute { return this.route; }

    get createButton(): Locator { return this.buttonBar.locator("a.sf-create").first(); }
    get viewButton(): Locator { return this.buttonBar.locator("a.sf-view").first(); }
    get findButton(): Locator { return this.buttonBar.locator("a.sf-find").first(); }
    get removeButton(): Locator { return this.buttonBar.locator("a.sf-remove").first(); }

    /** Signum's `RemoveAsync` — click Remove and wait for the line to actually re-render. */
    async remove(): Promise<void> {
        await waitChanges(this.element, () => this.removeButton.click());
    }

    /** Signum's `CreateEmbeddedAsync` — Create on a line that edits IN PLACE (a detail, a repeater row). */
    async createEmbedded(): Promise<void> {
        await waitChanges(this.element, () => this.createButton.click());
    }

    /**
     * Signum's `CreateModalAsync<T>` — Create on a line that opens a MODAL. The result is a SCOPE: the
     * closure that receives it owns the modal, and leaving the closure closes it AND waits for this line to
     * re-render (Signum wires exactly that through the modal's `Disposing`).
     *
     *     await line.createModal(OrderEntity).scoped(async order => { … });
     */
    createModal<E extends EntityOf<S> & Entity>(type: Type<E>): Scope<FrameModalProxy<E>> {
        return scope(this.openModal<E>(this.createButton, type));
    }

    /** Signum's `ViewInternalAsync<T>` — open the current value in a modal (same scope semantics). */
    viewModal<E extends EntityOf<S> & Entity>(type: Type<E>): Scope<FrameModalProxy<E>> {
        return scope(this.openModal<E>(this.viewButton, type));
    }

    /** Signum's `FindAsync` — open the search modal this line finds with (same scope semantics). */
    findModal<E extends EntityOf<S> & Entity>(queryName: Type<E> & QueryName): Scope<SearchModalProxy<E>> {
        return scope((async () => {
            const changes = await getChanges(this.element);
            const modal = await captureOnClick(this.findButton);
            const { SearchModalProxy } = await import("../Search/SearchModalProxy");
            const proxy = await SearchModalProxy.create<E>(modal, queryName);
            this.wireDisposing(proxy, changes);
            return proxy;
        })());
    }

    private async openModal<T extends Entity>(button: Locator, rootType: Type<T>): Promise<FrameModalProxy<T>> {
        const changes = await getChanges(this.element);
        const modal = await captureOnClick(button);
        const { FrameModalProxy } = await import("../Frames/FrameModalProxy");
        const proxy = await FrameModalProxy.create<T>(modal, rootType);
        proxy.disposing = async () => { await waitChangesFrom(this.element, changes); };
        return proxy;
    }

    /** Signum's `result.Disposing = async okPressed => await WaitNewChangesAsync(changes)`. */
    private wireDisposing(proxy: { disposing?: (ok: boolean) => Promise<void> }, changes: string): void {
        proxy.disposing = async () => { await waitChangesFrom(this.element, changes); };
    }

    // ---- Reading the value -------------------------------------------------------------------------

    /** Signum's `EntityInfoStringAsync` — the `data-entity` of this line (or of its nth item). */
    async entityInfoString(index?: number): Promise<string | null> {
        const locator = index == null ? this.element : this.element.locator("[data-entity]").nth(index);
        return await locator.getAttribute("data-entity")
            ?? await locator.locator("[data-entity]").first().getAttribute("data-entity").catch(() => null);
    }

    /** Signum's `EntityInfoAsync` — the parsed `data-entity`, or null when the line is empty. */
    async entityInfo(index?: number): Promise<EntityInfo | null> {
        return parseEntityInfo(await this.entityInfoString(index));
    }

    /** What the line HOLDS, as a lite of the member's own type — null while it is empty or unsaved. */
    async getLite(index?: number): Promise<Lite<EntityOf<S> & Entity> | null> {
        return tryLiteFromKey<EntityOf<S> & Entity>(await this.entityInfoString(index));
    }

    // ---- The autocomplete --------------------------------------------------------------------------

    /**
     * Signum's `AutoCompleteBasicAsync`: type, wait for the typeahead, click the match. altea renders the
     * same `.typeahead` menu with `data-entity-key` per item (EntityLine.tsx), so the flow is unchanged.
     */
    protected async autoCompleteBasic(input: Locator, container: Locator, text: string, resultContainsText = true): Promise<void> {
        await input.click();
        await input.fill("");
        await input.pressSequentially(text, { delay: 30 });

        const list = container.locator(".typeahead.dropdown-menu, .dropdown-menu.typeahead").first();
        await waitVisible(list);

        let item = list.locator("[data-entity-key]");
        if (resultContainsText)
            item = item.filter({ hasText: text });

        await item.first().click();
    }

    /** As above, but picking the item whose `data-entity-key` IS this lite (Signum's lite overload). */
    protected async autoCompleteLite(input: Locator, container: Locator, lite: Lite<Entity>): Promise<void> {
        await input.click();
        await input.fill("");
        await input.pressSequentially(lite.toString() ?? String(lite.id), { delay: 30 });

        const list = container.locator(".typeahead.dropdown-menu, .dropdown-menu.typeahead").first();
        await waitVisible(list);
        await list.locator(`[data-entity-key='${lite.key()}']`).first().click();
    }

    override async isReadonly(): Promise<boolean> {
        return await this.element.locator(".form-control[readonly]").count() > 0
            || !await isPresent(this.buttonBar.locator("a.sf-create, a.sf-find, a.sf-remove"));
    }
}

/** The entity behind a member: the entity itself, or the one a `Lite<E>` points at. */
export type EntityOf<S> = S extends Lite<infer E> ? E : S extends BaseEntity ? S : Entity;

/** Signum's `EntityInfoProxy` — what `data-entity` says about the value behind a line. */
export interface EntityInfo {
    readonly typeName: string;
    readonly id: string | null;
    readonly isNew: boolean;
}

export function parseEntityInfo(dataEntity: string | null | undefined): EntityInfo | null {
    if (dataEntity == null || dataEntity === "" || dataEntity === "null")
        return null;

    const parts = dataEntity.split(";");
    const typeName = parts[0]!;
    const id = parts[1] == null || parts[1] === "" ? null : parts[1];
    // altea has no third `isNew` part (see the header): no id ⇒ the entity is new.
    const isNew = parts[2] != null ? parts[2] === "true" : id == null;

    return { typeName, id, isNew };
}


/** Wait for a line to re-render after a modal it opened closed — tolerant, because an OK that navigated
 *  away (or a cancel that changed nothing) leaves the counter untouched. */
async function waitChangesFrom(element: Locator, previous: string): Promise<void> {
    try {
        await waitFor(async () => await element.getAttribute("data-changes") !== previous,
            "the line to re-render after its modal closed", 2000);
    } catch {
        // Nothing changed: the modal was cancelled, or the value it set was the same one.
    }
}
