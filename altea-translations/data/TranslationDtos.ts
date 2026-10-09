import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { TranslatableRouteType } from "@altea/altea/data/reflection";
import type { TranslatedSummaryState } from "./Translation";

// ---- Code translations (/api/translation/*) ----------------------------------------------------------

export interface TranslationFileStatus {
    package: string;
    culture: string;
    isDefault: boolean;
    status: TranslatedSummaryState;
}

export interface FolderSyncStats {
    folder: string;
    types: number;
    translations: number;
}

export interface AutomaticTranslation {
    translatorName: string;
    text: string;
}

export interface AutomaticTypeTranslation {
    translatorName: string;
    gender?: string;
    singular: string;
    plural?: string;
}

export interface Culture {
    name: string;
    pronoms: { gender: string; singular: string; plural: string }[];
}

export interface LocalizedDescription {
    gender?: string;
    description?: string;
    pluralDescription?: string;
    automaticTranslations?: AutomaticTypeTranslation[];
}

export interface LocalizedMember {
    name: string;
    description?: string;
    automaticTranslations?: AutomaticTranslation[];
}

export interface LocalizedTypeInfo {
    culture: string;
    typeDescription?: LocalizedDescription;
    members: Record<string, LocalizedMember>;
}

export interface LocalizableTypeInfo {
    type: string;
    folder: string;
    hasMembers: boolean;
    hasGender: boolean;
    hasDescription: boolean;
    hasPluralDescription: boolean;
    cultures: Record<string, LocalizedTypeInfo>;
}

export interface PackageResult {
    totalTypes: number;
    cultures: Record<string, Culture>;
    types: Record<string, LocalizableTypeInfo>;
}

// ---- Instance translations (/api/translatedInstance/*) -----------------------------------------------

export interface TranslatedTypeSummary {
    type: string;
    culture: string;
    isDefaultCulture: boolean;
    state: TranslatedSummaryState | null;
}

export interface TranslationRecordInfo {
    culture: string;
    propertyRoute: string;
    lite: Lite<Entity>;
    originalText: string;
    translatedText: string;
}

export interface TranslatedPairView {
    originalText: string;
    newText: string | null;
    translatedText: string;
}

export interface TranslatedInstanceViewInfo {
    lite: Lite<Entity>;
    /** route → the row's CURRENT text. */
    master: Record<string, string | null>;
    /** route → culture → what is stored for it. */
    translations: Record<string, Record<string, TranslatedPairView>>;
}

export interface TranslatedInstanceViewType {
    typeName: string;
    masterCulture: string;
    routes: Record<string, TranslatableRouteType>;
    instances: TranslatedInstanceViewInfo[];
}

export interface PropertyRouteConflict {
    oldOriginal?: string;
    oldTranslation?: string;
    original: string;
    automaticTranslations: AutomaticTranslation[];
}

export interface PropertyChange {
    translatedText?: string;
    support: Record<string, PropertyRouteConflict>;
}

export interface InstanceChangesInfo {
    instance: Lite<Entity>;
    routeConflicts: Record<string, PropertyChange>;
}

export interface TypeInstancesChanges {
    typeName: string;
    masterCulture: string;
    routes: Record<string, TranslatableRouteType>;
    totalInstances: number;
    instances: InstanceChangesInfo[];
    deletedTranslations: number;
}

export interface FileUpload {
    fileName: string;
    /** base64, as the browser's FileReader produces it. */
    content: string;
}
