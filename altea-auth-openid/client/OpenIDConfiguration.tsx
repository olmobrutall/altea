import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { TextBoxLine } from "@altea/altea/client/Lines/TextBoxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import * as AppContext from "@altea/altea/client/AppContext";
import { OpenIDConfigurationEmbedded } from "../data/OpenID";

// Port of Signum.Authorization.OpenID's OpenIDConfiguration.tsx — the configuration editor.
//
// altea divergences: the Lines come from their own modules (altea has no `@framework/Lines` barrel), and
// `formGroupHtmlAttributes={{ style: { display: "block" } }}` is written as `inlineCheckbox="block"`, the
// same thing through altea's CheckboxLine prop.

const roleClaimPathSuggestions = [
    "roles",
    "groups",
    "realm_access.roles",
    "resource_access.{clientId}.roles",
];

export default function OpenIDConfiguration(p: { ctx: TypeContext<OpenIDConfigurationEmbedded> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();
    const datalistId = React.useId();

    return (
        <div>
            <div className="row">
                <div className="col-sm-10 offset-sm-2">
                    <CheckboxLine ctx={ctx.subCtx(n => n.enabled)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
            </div>

            <AutoLine ctx={ctx.subCtx(n => n.authority)}
                helpText="Base URL of the OpenID provider (e.g. https://keycloak.example.com/realms/myrealm)" />
            <AutoLine ctx={ctx.subCtx(n => n.clientId)}
                helpText={"Redirect url: " + window.location.origin + AppContext.toAbsoluteUrl("/openid-callback")} />
            <AutoLine ctx={ctx.subCtx(n => n.clientSecret)} />
            <AutoLine ctx={ctx.subCtx(n => n.scopes)} helpText='Space-separated scopes (default: "openid profile email")' />
            <CheckboxLine ctx={ctx.subCtx(n => n.avoidSSLVerify)} inlineCheckbox="block" />

            <datalist id={datalistId}>
                {roleClaimPathSuggestions.map(s => <option key={s} value={s} />)}
            </datalist>
            <TextBoxLine ctx={ctx.subCtx(n => n.roleClaimPath)}
                helpText="Claim path for parsing the roles (e.g. roles, groups, realm_access.roles)"
                valueHtmlAttributes={{ list: datalistId }} />

            <div className="row my-2">
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx.subCtx(n => n.allowMatchUsersBySimpleUserName)} inlineCheckbox="block" />
                </div>
            </div>

            <div className="row my-2">
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx.subCtx(n => n.autoUpdateUsers)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
                <div className="col-sm-6">
                    <CheckboxLine ctx={ctx.subCtx(n => n.autoCreateUsers)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
            </div>

            {(ctx.value.autoCreateUsers || ctx.value.autoUpdateUsers) && <div>
                <div className="row">
                    <div className="col-sm-10 offset-sm-2">
                        <EntityTable ctx={ctx.subCtx(n => n.roleMapping)} avoidFieldSet="h3" />
                    </div>
                </div>
                <EntityLine ctx={ctx.subCtx(n => n.defaultRole)} />
            </div>}
        </div>
    );
}
