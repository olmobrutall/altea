import * as fs from "node:fs";
import * as path from "node:path";
import { parseAssets, type BinaryStore, type ParsedAsset } from "./UserAssetsImportExport";

// The asset root on disk: one directory per sync folder, one `<name>.<Type>.xml` per asset, and the
// asset's binaries in a `<name>.<Type>/` sidecar directory beside it. See port/UserAssetCodeSync.md.

const ATTR = "@_";

export interface AssetFile extends ParsedAsset {
    folder: string;
    /** `<name>.<Type>`, relative to the folder — the XML is `<baseName>.xml`, the sidecars `<baseName>/`. */
    baseName: string;
}

/** What one asset's export produces: the XML text plus the sidecars it references by relative path. */
export interface AssetExport {
    xml: string;
    sidecars: Map<string, Uint8Array>;
}

export class AssetSyncFiles {
    // guid → where its file is. Built on first use, kept current by write / remove.
    #index: Map<string, { folder: string; baseName: string }> | undefined;

    constructor(readonly root: string) { }

    folders(): string[] {
        if (!fs.existsSync(this.root))
            return [];
        return fs.readdirSync(this.root, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith("."))
            .map(d => d.name)
            .sort();
    }

    scan(): AssetFile[] {
        const result: AssetFile[] = [];
        const index = new Map<string, { folder: string; baseName: string }>();
        for (const folder of this.folders()) {
            const dir = path.join(this.root, folder);
            for (const name of fs.readdirSync(dir).filter(n => n.endsWith(".xml")).sort()) {
                const baseName = name.slice(0, -".xml".length);
                const assets = parseAssets(fs.readFileSync(path.join(dir, name), "utf8"));
                if (assets.length !== 1)
                    throw new Error(`${path.join(folder, name)}: a sync folder file holds exactly one asset, found ${assets.length}`);
                const asset = assets[0]!;
                const other = index.get(asset.guid);
                if (other != undefined)
                    throw new Error(`${asset.guid} is in two files: ${path.join(other.folder, other.baseName)}.xml and ${path.join(folder, name)}`);
                index.set(asset.guid, { folder, baseName });
                result.push({ ...asset, folder, baseName });
            }
        }
        this.#index = index;
        return result;
    }

    locate(guid: string): { folder: string; baseName: string } | undefined {
        if (this.#index == undefined)
            this.scan();
        return this.#index!.get(guid);
    }

    /** Reads a `Path` relative to the asset's folder; an inline `#text` still reads as base64. */
    reader(folder: string): BinaryStore {
        const dir = path.join(this.root, folder);
        return {
            write: () => { throw new Error("A reader does not write"); },
            read: element => {
                const rel = element[ATTR + "Path"];
                if (rel == null) {
                    const t = element["#text"];
                    return new Uint8Array(Buffer.from(String((Array.isArray(t) ? t[0] : t) ?? ""), "base64"));
                }
                return new Uint8Array(fs.readFileSync(this.inside(dir, String(rel))));
            },
        };
    }

    readSidecar(folder: string, rel: string): Uint8Array | undefined {
        const file = this.inside(path.join(this.root, folder), rel);
        return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined;
    }

    /** Collects the sidecars of an asset about to be written as `baseName`. */
    static writer(baseName: string, sidecars: Map<string, Uint8Array>): BinaryStore {
        return {
            write: (fileName, bytes) => {
                const safe = safeFileName(fileName) || "file";
                let rel = `${baseName}/${safe}`;
                for (let i = 2; sidecars.has(rel); i++)
                    rel = `${baseName}/${withSuffix(safe, i)}`;
                sidecars.set(rel, bytes);
                return { [ATTR + "Path"]: rel };
            },
            read: () => { throw new Error("A writer does not read"); },
        };
    }

    /** `<name>.<Type>`, unless another asset already holds that name in the folder. */
    baseNameFor(folder: string, guid: string, displayName: string, elementName: string): string {
        const plain = `${safeFileName(displayName) || guid}.${elementName}`;
        const current = this.locate(guid);
        if (current != undefined && current.folder === folder && current.baseName === plain)
            return plain;
        const taken = fs.existsSync(path.join(this.root, folder, plain + ".xml"));
        return taken ? `${safeFileName(displayName) || "asset"}.${guid.slice(0, 8)}.${elementName}` : plain;
    }

    ensureFolder(folder: string): void {
        fs.mkdirSync(this.inside(this.root, folder), { recursive: true });
    }

    write(guid: string, folder: string, baseName: string, exported: AssetExport): void {
        this.remove(guid);
        const dir = path.join(this.root, folder);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, baseName + ".xml"), exported.xml.endsWith("\n") ? exported.xml : exported.xml + "\n");
        for (const [rel, bytes] of exported.sidecars) {
            const file = this.inside(dir, rel);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes);
        }
        this.#index?.set(guid, { folder, baseName });
    }

    remove(guid: string): void {
        const at = this.locate(guid);
        if (at == undefined)
            return;
        const dir = path.join(this.root, at.folder);
        fs.rmSync(path.join(dir, at.baseName + ".xml"), { force: true });
        fs.rmSync(path.join(dir, at.baseName), { recursive: true, force: true });
        this.#index!.delete(guid);
    }

    private inside(dir: string, rel: string): string {
        const file = path.resolve(dir, rel);
        if (!file.startsWith(path.resolve(dir) + path.sep))
            throw new Error(`The sidecar path '${rel}' leaves its folder`);
        return file;
    }
}

export function safeFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "").slice(0, 100);
}

function withSuffix(fileName: string, i: number): string {
    const dot = fileName.lastIndexOf(".");
    return dot <= 0 ? `${fileName} (${i})` : `${fileName.slice(0, dot)} (${i})${fileName.slice(dot)}`;
}
