import type { ClientBuilder } from './ClientBuilder';
import { CultureInfoEntity, setCultureNameResolver, cultureDisplayNames } from '../data/cultureInfoEntity';
import { Metadata } from '../data/metadata';

// Client registration for the culture table (Signum wires this from its Basics client). Two jobs:
//
//  1. Query settings, so `CultureInfoEntity` reads well wherever it is picked — a template's culture is an
//     entity reference now, so this table shows up in a finder.
//  2. The client half of the culture-name resolver. Server-side the tag comes from CultureInfoLogic's
//     cache; here it comes from whatever the lite carries. A FAT lite has the entity, so the tag is exact.
//     A THIN one carries only the id and the ENGLISH name (CultureInfoEntity.toString), so the tag is
//     recovered by matching that name back — reliable because both tiers derive the English name from the
//     same Intl data, and it is the only signal a thin lite has. Undefined when it cannot be recovered;
//     every caller treats that as "no culture stated" and falls back to its own default.
export namespace CultureInfoClient {
    export function start(cb: ClientBuilder): void {
        cb.configure(CultureInfoEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(c => c.id),
                    token(c => c.name),
                    token(c => c.englishName),
                    token(c => c.nativeName),
                ],
            }));

        setCultureNameResolver(lite => {
            const entity = (lite as { entityOrNull?: CultureInfoEntity | null }).entityOrNull;
            if (entity != null)
                return entity.name;
            const toStr = (lite as { toStr?: string }).toStr;
            return toStr == null ? undefined : englishNameToTag().get(toStr);
        });
    }
}

// English name → tag, over the cultures the metadata blob says the application supports. Built on first
// use (the blob is applied before any template is opened) and kept: the set only changes when the culture
// table does, which needs a reload anyway.
let byEnglishName: Map<string, string> | undefined;
function englishNameToTag(): Map<string, string> {
    if (byEnglishName == null) {
        byEnglishName = new Map();
        for (const tag of Metadata.cultures())
            byEnglishName.set(cultureDisplayNames(tag).englishName, tag);
    }
    return byEnglishName;
}
