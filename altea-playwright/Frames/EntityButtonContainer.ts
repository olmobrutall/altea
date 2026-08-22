import type { Locator } from "@playwright/test";
import type { Symbol as AlteaSymbol } from "@altea/altea/data/symbol";
import { captureOnClick, isPresent, waitFor, waitVisible } from "../PlaywrightExtensions";
import { parseEntityInfo, type EntityInfo } from "../LineProxies/EntityBaseProxy";

// Port of Signum.Playwright's Frames/EntityButtonContainer.cs — the OPERATION buttons of an entity frame
// (a page or a modal) and the handshake around executing one.
//
// altea renders each button with `data-operation={key}` (EntityOperations.tsx) and the frame with
// `data-main-entity` on `.sf-main-control` — the same two attributes Signum's proxy reads.
export abstract class EntityButtonContainer {

    /** The whole frame (page body / modal). */
    abstract get element(): Locator;
    /** Where the buttons are (the button bar of the page, the footer + header of a modal). */
    get container(): Locator { return this.element; }
    /** The element carrying `data-main-entity` / `data-refresh-count`. */
    get mainControl(): Locator { return this.element.locator(".sf-main-control").first(); }

    /** Signum's `GetEntityInfoAsync` — which entity this frame is showing. */
    async entityInfo(): Promise<EntityInfo | null> {
        return parseEntityInfo(await this.mainControl.getAttribute("data-main-entity"));
    }

    /** Signum's `OperationButtonAsync(symbol, groupId?)`. A grouped operation lives behind its dropdown. */
    async operationButton(operation: AlteaSymbol | string, groupId?: string): Promise<Locator> {
        const key = typeof operation === "string" ? operation : operation.key;

        if (groupId != null) {
            const groupButton = this.container.locator(`#${groupId}`);
            if (await isPresent(groupButton)) {
                await groupButton.click();
                return this.container.locator(`a[data-operation='${key}']`);
            }
        }

        return this.container.locator(`button[data-operation='${key}'], a[data-operation='${key}']`).first();
    }

    async operationEnabled(operation: AlteaSymbol | string, groupId?: string): Promise<boolean> {
        const button = await this.operationButton(operation, groupId);
        return await isPresent(button) && await button.isEnabled();
    }

    async operationPresent(operation: AlteaSymbol | string, groupId?: string): Promise<boolean> {
        return await isPresent(await this.operationButton(operation, groupId));
    }

    /**
     * Signum's `ExecuteAsync` — click an operation and wait for the frame to come back.
     *
     * The handshake is `data-refresh-count` on `.sf-main-control`: altea bumps it when the frame re-renders
     * with the operation's RESULT, so this returns only once the save/execute round-trip landed. Signum
     * waits on the same attribute.
     */
    async execute(operation: AlteaSymbol | string, options?: { groupId?: string; checkValidationErrors?: boolean }): Promise<void> {
        const before = await this.mainControl.getAttribute("data-refresh-count");
        const button = await this.operationButton(operation, options?.groupId);
        await waitVisible(button);
        await button.click();

        await waitFor(async () => await this.mainControl.getAttribute("data-refresh-count") !== before,
            `the frame to refresh after ${typeof operation === "string" ? operation : operation.key}`);

        if (options?.checkValidationErrors !== false)
            await this.assertNoValidationErrors();
    }

    /** Signum's `OperationClickCaptureAsync` — an operation that opens a MODAL (a ConstructFrom). */
    async executeCapturingModal(operation: AlteaSymbol | string, groupId?: string): Promise<Locator> {
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
