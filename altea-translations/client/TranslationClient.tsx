import * as React from "react";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ajaxGet, ajaxPost, ajaxGetRaw } from "@altea/altea/client/Services";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { registerSpecialAction } from "@altea/altea-omnibox/client/OmniboxSpecialAction";
import { TranslationPermission, TranslationReplacementEntity, type TranslatedSummaryState } from "../data/Translation";

// Port of Signum.Translation's TranslationClient.tsx — the CODE half's client registration: the four
// pages and the calls behind them.
//
// altea divergences:
//  - **"assembly" is "package" throughout** (see server/LocalizedPackage), and the sync's second level is
//    the declaring FOLDER, not a C# namespace.
//  - `isPermissionAuthorized` lives in altea-auth (see CLAUDE.md), and is read inside the callback so it
//    follows `onCurrentUserChanged`.
//  - `ChangeLogClient.registerChangeLogModule` has no counterpart (altea has no change-log module).
export namespace TranslationClient {

    export function start(cb: ClientBuilder): void {

        registerSpecialAction({
            key: "TranslateCode",
            allowed: () => AuthClient.isPermissionAuthorized(TranslationPermission.TranslateCode),
            onClick: () => Promise.resolve("/translation/status"),
        });

        // The replacement table itself is an ordinary entity — its editor is the default view.
        cb.configure(TranslationReplacementEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.cultureInfo),
                    token(a => a.wrongTranslation),
                    token(a => a.rightTranslation),
                ],
            }));

        cb.routes.push(
            { path: "/translation/status", element: <ImportComponent onImport={() => import("./Code/TranslationCodeStatus")} /> },
            { path: "/translation/view/:package/:culture?", element: <ImportComponent onImport={() => import("./Code/TranslationCodeView")} /> },
            { path: "/translation/syncFolders/:package/:culture", element: <ImportComponent onImport={() => import("./Code/TranslationCodeSyncFolders")} /> },
            { path: "/translation/sync/:package/:culture/:folder?", element: <ImportComponent onImport={() => import("./Code/TranslationCodeSync")} /> },
        );
    }

    export namespace API {
        export function status(): Promise<TranslationFileStatus[]> {
            return ajaxGet({ url: "/api/translation/state" });
        }

        export function retrieve(packageName: string, culture: string, filter: string): Promise<PackageResult> {
            return ajaxGet({ url: `/api/translation/retrieve?${q({ package: packageName, culture, filter })}` });
        }

        export function download(packageName: string, culture: string): Promise<Response> {
            return ajaxGetRaw({ url: `/api/translation/download?${q({ package: packageName, culture })}` });
        }

        export function folderStatus(packageName: string, culture: string): Promise<FolderSyncStats[]> {
            return ajaxGet({ url: `/api/translation/syncStats?${q({ package: packageName, culture })}` });
        }

        export function sync(packageName: string, culture: string, folder?: string): Promise<PackageResult> {
            return ajaxPost({ url: `/api/translation/sync?${q({ package: packageName, culture, folder })}` }, undefined);
        }

        export function save(packageName: string, culture: string, result: PackageResult): Promise<void> {
            return ajaxPost({ url: `/api/translation/save?${q({ package: packageName, culture })}` }, result);
        }

        export function autoTranslate(packageName: string, culture: string): Promise<void> {
            return ajaxGet({ url: `/api/translation/autoTranslate?${q({ package: packageName, culture })}` });
        }

        export function autoTranslateAll(culture: string): Promise<void> {
            return ajaxGet({ url: `/api/translation/autoTranslateAll?${q({ culture })}` });
        }

        export function pluralize(culture: string, singular: string): Promise<string> {
            return ajaxPost({ url: `/api/translation/pluralize?${q({ culture })}` }, singular);
        }

        export function gender(culture: string, singular: string): Promise<string | null> {
            return ajaxPost({ url: `/api/translation/gender?${q({ culture })}` }, singular);
        }
    }

    function q(params: Record<string, string | undefined>): string {
        return Object.entries(params)
            .filter(([, v]) => v != undefined)
            .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
            .join("&");
    }

    // ---- The DTOs (mirroring server/TranslationServer) ------------------------------------------------

    export interface FolderSyncStats {
        folder: string;
        types: number;
        translations: number;
    }

    export interface TranslationFileStatus {
        package: string;
        culture: string;
        isDefault: boolean;
        status: TranslatedSummaryState;
    }

    export interface PackageResult {
        totalTypes: number;
        cultures: Record<string, { name: string; pronoms: { gender: string; singular: string; plural: string }[] }>;
        types: Record<string, LocalizableType>;
    }

    export interface LocalizableType {
        type: string;
        folder: string;
        hasMembers: boolean;
        hasGender: boolean;
        hasDescription: boolean;
        hasPluralDescription: boolean;
        cultures: Record<string, LocalizedType>;
    }

    export interface LocalizedType {
        culture: string;
        typeDescription?: LocalizedDescription;
        members: Record<string, LocalizedMember>;
    }

    export interface LocalizedDescription {
        gender?: string;
        description?: string;
        pluralDescription?: string;
        automaticTranslations?: AutomaticTypeTranslation[];
    }

    export interface AutomaticTypeTranslation {
        translatorName: string;
        gender?: string;
        singular: string;
        plural?: string;
    }

    export interface LocalizedMember {
        name: string;
        description?: string;
        automaticTranslations?: AutomaticTranslation[];
    }

    export interface AutomaticTranslation {
        translatorName: string;
        text: string;
    }
}

// A package name contains "/" and "@", neither of which survives a path segment; the pages therefore
// carry it URL-ENCODED. (Signum's assembly names contain dots, which it swaps for dashes — the same
// problem, one level worse here.)
export function encodePackage(value: string): string {
    return encodeURIComponent(value);
}

export function decodePackage(value: string): string {
    return decodeURIComponent(value);
}
