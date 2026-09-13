import type { Locator } from "playwright";
import { Entity, type BaseEntity, type Type } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type {
    ConstructSymbol, DeleteSymbol, ExecuteSymbol, From, FromMany,
} from "@altea/altea/data/operations";
import { captureOnClick, isPresent, scope, waitFor, waitVisible, type Scope } from "../PlaywrightExtensions";
import { tryLiteFromKey } from "../liteKeys";
import type { FrameModalProxy } from "./FrameModalProxy"; // lazily imported below (cycle)

// Port of Signum.Playwright's Frames/EntityButtonContainer.cs — the OPERATION buttons of an entity frame
// (a page or a modal) and the handshake around executing one.
//
// altea renders each button with `data-operation={key}` (EntityOperations.tsx) and the frame with
// `data-main-entity` on `.sf-main-control` — the same two attributes Signum's proxy reads.
//
// The operations are the SYMBOLS themselves, typed on this frame's entity: `frame.execute(
// OrderOperation.Save)` compiles, `frame.execute(CustomerOperation.Save)` does not. A ConstructFrom goes
// further and types what it OPENS, so the modal a `ConstructSymbol<OrderEntity, From<CustomerEntity>>`
// produces is a `FrameModalProxy<OrderEntity>` with no type argument in sight.
export abstract class EntityButtonContainer<T extends BaseEntity> {

    /** The whole frame (page body / modal). */
    abstract get element(): Locator;
    /** Where the buttons are (the button bar of the page, the footer + header of a modal). */
    get container(): Locator { return this.element; }
    /** The element carrying `data-main-entity` / `data-refresh-count`. */
    get mainControl(): Locator { return this.element.locator(".sf-main-control").first(); }

    /** Signum's `GetLiteAsync` — which entity this frame is showing, or null while it is new. */
    async lite(): Promise<Lite<T & Entity> | null> {
        return tryLiteFromKey<T & Entity>(await this.mainControl.getAttribute("data-main-entity"));
    }

    /** Whether the frame is showing an entity that has never been saved (Signum's `EntityInfo.IsNew`). */
    async isNew(): Promise<boolean> {
        return await this.lite() == null;
    }

    /** Signum's `OperationButtonAsync(symbol, groupId?)`. A grouped operation lives behind its dropdown. */
    async operationButton(operation: OperationOf<T>, groupId?: string): Promise<Locator> {
        const key = operation.key;

        if (groupId != null) {
            const groupButton = this.container.locator(`#${groupId}`);
            if (await isPresent(groupButton)) {
                await groupButton.click();
                return this.container.locator(`a[data-operation='${key}']`);
            }
        }

        return this.container.locator(`button[data-operation='${key}'], a[data-operation='${key}']`).first();
    }

    async operationEnabled(operation: OperationOf<T>, groupId?: string): Promise<boolean> {
        const button = await this.operationButton(operation, groupId);
        return await isPresent(button) && await button.isEnabled();
    }

    async operationPresent(operation: OperationOf<T>, groupId?: string): Promise<boolean> {
        return await isPresent(await this.operationButton(operation, groupId));
    }

    /**
     * Signum's `ExecuteAsync` — click an operation and wait for the frame to come back.
     *
     * The handshake is `data-refresh-count` on `.sf-main-control`: altea bumps it when the frame re-renders
     * with the operation's RESULT, so this returns only once the save/execute round-trip landed. Signum
     * waits on the same attribute.
     */
    async execute(operation: ExecuteSymbol<T & Entity> | DeleteSymbol<T & Entity>,
        options?: { groupId?: string; checkValidationErrors?: boolean }): Promise<void> {

        const before = await this.mainControl.getAttribute("data-refresh-count");
        const button = await this.operationButton(operation as OperationOf<T>, options?.groupId);
        await waitVisible(button);
        await button.click();

        await waitFor(async () => await this.mainControl.getAttribute("data-refresh-count") !== before,
            `the frame to refresh after ${operation.key}`);

        if (options?.checkValidationErrors !== false)
            await this.assertNoValidationErrors();
    }

    /**
     * Signum's `ConstructFromAsync` — an operation that CONSTRUCTS something and opens it in a modal. The
     * symbol says what it constructs, so the scope is typed on that:
     *
     *     await customer.constructFrom(OrderOperation.CreateOrderFromCustomer).scoped(async order => { … });
     */
    constructFrom<R extends Entity>(operation: ConstructSymbol<R, From<T & Entity>>, type: Type<R>,
        options?: { groupId?: string }): Scope<FrameModalProxy<R>> {

        return scope((async () => {
            const modal = await captureOnClick(await this.operationButton(operation as OperationOf<T>, options?.groupId));
            const { FrameModalProxy } = await import("./FrameModalProxy");
            return await FrameModalProxy.create<R>(modal, type);
        })());
    }

    /** Signum's `OperationClickCaptureAsync` — any operation that opens a modal, as a bare locator. */
    async executeCapturingModal(operation: OperationOf<T>, groupId?: string): Promise<Locator> {
        return await captureOnClick(await this.operationButton(operation, groupId));
    }

    // ---- Validation --------------------------------------------------------------------------------

    /**
     * Signum's ValidationSummaryContainer. NOTE the class: altea renders `validaton-summary` (missing the
     * "i"), and so does Signum's React — Signum's own proxy looks for `validation-summary` and therefore
     * never finds it. This port uses the class the DOM actually has, and accepts the correct spelling too.
     */
    get validationSummary(): Locator {
        return this.element.locator("ul.validaton-summary, ul.validation-summary").first();
    }

    async validationErrors(): Promise<string[]> {
        if (!await isPresent(this.validationSummary))
            return [];
        return (await this.validationSummary.locator("li").allTextContents()).map(t => t.trim());
    }

    async assertNoValidationErrors(): Promise<void> {
        const errors = await this.validationErrors();
        if (errors.length > 0)
            throw new Error(`The frame reported validation errors:\n${errors.map(e => " - " + e).join("\n")}`);
    }
}

/** Any operation of this frame's entity — what the buttons are addressed by. */
export type OperationOf<T extends BaseEntity> =
    | ExecuteSymbol<T & Entity>
    | DeleteSymbol<T & Entity>
    | ConstructSymbol<Entity, From<T & Entity>>
    | ConstructSymbol<Entity, FromMany<T & Entity>>;

