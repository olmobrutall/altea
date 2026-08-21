import * as React from "react";
import { ajaxGet } from "@altea/altea/client/Services";
import { Operations, EntityOperationSettings } from "@altea/altea/client/Operations";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import type { SkillCodeInfo, SkillPropertyMeta } from "../data/ChatbotProtocol";
import {
    AgentSymbol, SkillCodeEntity, SkillCustomizationEntity, SkillCustomizationEntity_Property,
    SkillCustomizationEntity_SubSkill, SkillCustomizationOperation,
} from "../data/SkillCustomization";
import { LanguageModelClient } from "./LanguageModelClient";

// Port of Signum.Agent's AgentClient.tsx — the SKILL-CUSTOMIZATION editors plus the property-editor registry
// a host extends to give a skill property a richer control than a text box.
//
// altea divergences:
//  - the DTOs (`SkillCodeInfo` and friends) are imported from data/ChatbotProtocol rather than re-declared
//    here: in Signum they are hand-copied from the server's `DefaultSkillCodeInfo`, which is exactly the
//    duplication altea's isomorphic data layer exists to remove.
//  - `AppContext.clearSettingsActions.push(() => registry.clear())` is dropped — altea has no global
//    clearSettingsActions (see QuickLinkClient's note on the same divergence); `clearPropertyValueControls`
//    stays exported for a caller that wants it.
export namespace AgentClient {

    export function start(cb: ClientBuilder): void {

        cb.configure(SkillCodeEntity)
            .withView(() => import("./Templates/SkillCode"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.className),
                ],
            }));

        cb.configure(SkillCustomizationEntity)
            .withView(() => import("./Templates/SkillCustomization"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.skillCode),
                    token(a => a.shortDescription),
                ],
            }));

        cb.configure(SkillCustomizationEntity_Property).withQuerySettings();
        cb.configure(SkillCustomizationEntity_SubSkill).withQuerySettings();

        cb.configure(AgentSymbol)
            .withView(() => import("./Templates/Agent"))
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(a => a.id),
                    token(a => a.key),
                    token(a => a.skillCustomization),
                ],
            }));

        // The construct-from is driven by the Agent view's own "create the overlay" button, not by a
        // toolbar entry (Signum hides it the same way).
        Operations.addSettings(new EntityOperationSettings(SkillCustomizationOperation.CreateFromAgent, {
            isVisible: () => false,
        }));

        LanguageModelClient.start(cb);
    }

    export type PropertyValueFactory = (
        ctx: TypeContext<string | null>,
        meta: SkillPropertyMeta,
    ) => React.ReactElement;

    const propertyValueRegistry = new Map<string, PropertyValueFactory>();

    /** Keyed by `SkillPropertyMeta.attributeName` (Signum keys by the C# attribute class name). */
    export function registerPropertyValueControl(attributeName: string, factory: PropertyValueFactory): void {
        propertyValueRegistry.set(attributeName, factory);
    }

    export function getPropertyValueControl(attributeName: string): PropertyValueFactory | undefined {
        return propertyValueRegistry.get(attributeName);
    }

    export function clearPropertyValueControls(): void {
        propertyValueRegistry.clear();
    }

    export namespace API {
        export function getSkillCodeInfo(skillCode: string): Promise<SkillCodeInfo> {
            return ajaxGet({ url: `/api/agentSkill/skillCodeInfo/${encodeURIComponent(skillCode)}` });
        }

        export function getDefaultAgentSkillCodeInfo(agentName: string): Promise<SkillCodeInfo> {
            return ajaxGet({ url: `/api/agentSkill/defaultAgentSkillCodeInfo/${encodeURIComponent(agentName)}` });
        }
    }
}
