import type { Locator } from "@playwright/test";
import { isPresent, waitNotPresent, waitVisible } from "../PlaywrightExtensions";

// Port of Signum.Playwright's ModalProxies/*.cs — the three modals a test bumps into that are NOT an entity
// frame: the message box, the type selector and the error dialog.
//
// Signum's `using`-scoped closing IS preserved — see PlaywrightExtensions' AsyncScoped / `scoped()`, which
// is the direct translation of its `Task.Then(...)` idiom, plus `await using`. `ModalProxy` keeps Signum's
// shape as the shared base, including `Disposing`.
export class ModalProxy {

    constructor(readonly modal: Locator) { }

    /** Signum's `ModalProxy.Disposing` — what the OPENER wants to await once the modal is gone (typically
     *  the re-render of the line that opened it). Wired by the proxy that opened it. */
    disposing: ((okPressed: boolean) => Promise<void>) | undefined;

    get header(): Locator { return this.modal.locator(".modal-header"); }
    get title(): Locator { return this.modal.locator(".modal-title"); }
    get body(): Locator { return this.modal.locator(".modal-body"); }
    get closeButton(): Locator { return this.modal.locator(".modal-header button.btn-close").first(); }

    titleText(): Promise<string> { return this.title.innerText(); }
    bodyText(): Promise<string> { return this.body.innerText(); }

    async waitVisible(): Promise<void> { await waitVisible(this.modal); }

    async close(): Promise<void> {
        await this.closeButton.click();
        await waitNotPresent(this.modal);
    }
}

/** Signum's MessageModalProxy — the OK / Yes-No dialog (`MessageModal.tsx`). */
export class MessageModalProxy extends ModalProxy {

    /** A button by its `name` (altea's MessageModal renders `button[name]`, as Signum's does). */
    button(name: string): Locator { return this.modal.locator(`button[name='${name}']`); }

    async click(name: string): Promise<void> {
        await this.button(name).click();
        await waitNotPresent(this.modal);
    }

    /** Is THIS locator a message modal? (Signum's `IsMessageModalAsync`.) */
    static async is(modal: Locator): Promise<boolean> {
        return await isPresent(modal.locator(".message-modal"));
    }
}

/** Signum's SelectorModalProxy — "which type do you want to create?" (`SelectorModal.tsx`). */
export class SelectorModalProxy extends ModalProxy {

    /** Pick by the option's visible text — a type's nice name, or its clean name. */
    async select(text: string): Promise<void> {
        await this.modal.locator(`button:has-text('${text}'), a:has-text('${text}')`).first().click();
        await waitNotPresent(this.modal);
    }

    /** Signum's `IsSelectorAsync` — used before choosing a type, since the modal only appears when the
     *  line is polymorphic. */
    static async is(modal: Locator): Promise<boolean> {
        return await isPresent(modal.locator(".sf-selector-modal"))
            || await isPresent(modal.filter({ has: modal.page().locator(".sf-selector-modal") }));
    }
}

/** Signum's ErrorModalProxy — the exception dialog. */
export class ErrorModalProxy extends ModalProxy {

    get errorText(): Locator { return this.modal.locator(".error-modal, .modal-body").first(); }

    static async is(modal: Locator): Promise<boolean> {
        return await isPresent(modal.locator(".error-modal"));
    }
}
