import "@altea/altea/server";
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { OmniboxParser } from "@altea/altea-omnibox/server/OmniboxParser";
import type { IFileTypeAlgorithm } from "@altea/altea-files/server/FileTypeAlgorithm.server";
import { HelpLogic } from "./HelpLogic.server";
import { HelpServer } from "./HelpServer.server";
import { HelpOmniboxResultGenerator } from "./HelpOmniboxResultGenerator.server";

// The module's one entry point (Signum's `HelpLogic.Start(sb, helpImagesAlgorithm)`, whose registration
// half this file is — the caches and the includes live in HelpLogic).
//
// It is named `HelpModuleLogic` rather than `HelpLogic` because the two would otherwise be one 700-line
// file: the includes need the caches, the caches need the generator, and the routes need both. Signum
// keeps the same split between HelpLogic.cs (state) and HelpServer/HelpController (surface); the only
// addition is that `start` also wires the omnibox, which Signum does from inside HelpLogic.Start.
export namespace HelpModuleLogic {

    export function start(sb: SchemaBuilder, helpImagesAlgorithm: IFileTypeAlgorithm): void {
        HelpLogic.start(sb, helpImagesAlgorithm);

        if (sb.webBuilder != null) {
            HelpServer.start(sb.webBuilder);
            OmniboxParser.generators.push(new HelpOmniboxResultGenerator());
        }
    }
}
