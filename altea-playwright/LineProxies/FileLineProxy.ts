import type { Locator } from "@playwright/test";
import { BaseLineProxy } from "./BaseLineProxy";

// Port of Signum.Playwright's LineProxies/FileLineProxy.cs (@altea/altea-files' FileLine) — set the file by
// handing Playwright a PATH, exactly as Signum does.
//
// It is NOT registered as an auto-line rule: the file lines live in @altea/altea-files, so the route's type
// is a FilePathEmbedded the core dispatcher knows nothing about. Reach it with `lc.file(a => a.picture)`.
export class FileLineProxy extends BaseLineProxy {

    get input(): Locator { return this.element.locator("input[type=file]").first(); }

    /** Upload one file (Signum's `SetPathAsync`). */
    async setPath(filePath: string): Promise<void> {
        await this.input.setInputFiles(filePath);
    }

    /** Upload several (a MultiFileLine). */
    async setPaths(filePaths: string[]): Promise<void> {
        await this.input.setInputFiles(filePaths);
    }

    /** The file names the line currently shows. */
    async fileNames(): Promise<string[]> {
        return (await this.element.locator("[data-file-name]").allTextContents()).map(t => t.trim());
    }

    override async getValueUntyped(): Promise<unknown> { return await this.fileNames(); }

    override async setValueUntyped(value: unknown): Promise<void> {
        await this.setPath(String(value));
    }

    override async isReadonly(): Promise<boolean> {
        return await this.input.count() === 0;
    }
}
