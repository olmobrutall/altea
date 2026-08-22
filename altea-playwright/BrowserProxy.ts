import type { Locator, Page } from "@playwright/test";
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { isPresent, waitFor, waitNotPresent, waitVisible } from "./PlaywrightExtensions";
import { SearchPageProxy } from "./Search/SearchPageProxy";
import { FramePageProxy } from "./Frames/FramePageProxy";

// Port of Signum.Playwright's BrowserProxy.cs — the entry point: log in, and navigate to the two kinds of
// page a test starts from (a search page, an entity page).
//
// An application subclasses it to name its base URL, exactly as Signum's docs say:
//
//     class EastwindBrowser extends BrowserProxy {
//         url(relative: string): string { return "http://localhost:5173/" + relative; }
//     }
//
// altea divergences:
//  - the LOGIN ROUTE is `auth/login` (altea's router), not Signum's `Auth/Login`, and the form's ids are
//    altea's (`#userName` / `#password` / the submit button) — see `login`.
//  - Signum's CDP "debug mode" (launch a real Chrome with a user-data-dir and connect over the debugging
//    port) is NOT ported: `@playwright/test` already has `--headed`, `--debug` and the UI mode, which is
//    what that machinery re-created for xUnit.
//  - navigation routes are altea's `find/<QueryKey>` / `view/<CleanName>/<id>` / `create/<CleanName>` —
//    the same shapes Signum uses, so only the base URL differs.
export class BrowserProxy {

    constructor(readonly page: Page) { }

    /** Override with the app's base URL. */
    url(relativeUrl: string): string {
        throw new Error(`BrowserProxy.url: override it, e.g. "http://localhost:5173/" + relativeUrl`
            + ` (asked for '${relativeUrl}')`);
    }

    // ---- Navigation --------------------------------------------------------------------------------

    /** Signum's `FindRoute(queryName)`. */
    findRoute(queryKey: string): string { return "find/" + queryKey; }

    /** Signum's `NavigateRoute(type, id)`. */
    navigateRoute(cleanName: string, id?: string | number | null): string {
        return id == null ? `create/${cleanName}` : `view/${cleanName}/${id}`;
    }

    /** Signum's `SearchPageAsync(queryName)`. */
    async searchPage(queryKey: string, waitInitialSearch = true): Promise<SearchPageProxy> {
        await this.page.goto(this.url(this.findRoute(queryKey)));
        return await SearchPageProxy.create(this.page, queryKey, waitInitialSearch);
    }

    /** Signum's `FramePageAsync<T>(lite | id)` — open an entity's page. */
    async framePage<T extends Entity>(rootType: Function, cleanName: string, id?: string | number | null): Promise<FramePageProxy<T>> {
        await this.page.goto(this.url(this.navigateRoute(cleanName, id)));
        return await FramePageProxy.create<T>(this.page, rootType);
    }

    /** As above, from a lite. */
    async framePageOf<T extends Entity>(rootType: Function, lite: Lite<T>): Promise<FramePageProxy<T>> {
        return await this.framePage<T>(rootType, lite.entityType.name.replace(/Entity$/, ""), String(lite.id));
    }

    // ---- Authentication ----------------------------------------------------------------------------

    get loginDropdown(): Locator { return this.page.locator(".sf-login-dropdown").first(); }

    /** Signum's `GetCurrentUserAsync` — the name in the navbar, or null when nobody is logged in. */
    async currentUser(): Promise<string | null> {
        if (!await isPresent(this.loginDropdown))
            return null;
        return (await this.loginDropdown.innerText()).trim() || null;
    }

    /**
     * Signum's `LoginAsync`. altea's login page is `/auth/login` with `#userName` / `#password`; a dev
     * database can be configured with VITE_PASSWORD_IS_USERNAME, in which case the password field is not
     * rendered at all — so it is filled only when present (see eastwind's CLAUDE.md).
     */
    async login(userName: string, password: string): Promise<void> {
        if (await this.currentUser() === userName)
            return;

        await this.page.goto(this.url("auth/login"));

        const userInput = this.page.locator("#userName");
        await waitVisible(userInput);
        await userInput.fill(userName);

        const passwordInput = this.page.locator("#password");
        if (await isPresent(passwordInput))
            await passwordInput.fill(password);

        await this.page.locator("button[type=submit]").first().click();

        await waitFor(async () => await this.currentUser() != null, `'${userName}' to be logged in`);
    }

    /** Signum's `LogoutAsync`. */
    async logout(): Promise<void> {
        await this.loginDropdown.click();
        await this.page.locator("#sf-auth-logout, a:has-text('Logout')").first().click();
        await waitFor(async () => await this.currentUser() == null, "the user to be logged out");
    }

    /** Wait until every modal is gone — handy between test steps. */
    async waitNoModals(): Promise<void> {
        await waitNotPresent(this.page.locator(".modal.fade.show"));
    }
}
