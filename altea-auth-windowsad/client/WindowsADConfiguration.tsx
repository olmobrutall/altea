import * as React from "react";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { CheckboxLine } from "@altea/altea/client/Lines/CheckboxLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityTable } from "@altea/altea/client/Lines/EntityTable";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { WindowsADConfigurationEmbedded } from "../data/WindowsAD";

// Port of Signum.Authorization.WindowsAD's WindowsADConfiguration.tsx, plus the two altea-only connection
// fields (`ldapUrl` / `baseDN`) that LDAP needs and `System.DirectoryServices` discovered for itself — see
// data/WindowsAD.ts.

export default function WindowsADConfiguration(p: { ctx: TypeContext<WindowsADConfigurationEmbedded> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();

    return (
        <div>
            <CheckboxLine ctx={ctx.subCtx(n => n.loginWithWindowsAuthenticator)} inlineCheckbox="block"
                helpText="Needs a Negotiate provider on the server (see WindowsADServer)" onChange={forceUpdate} />
            <CheckboxLine ctx={ctx.subCtx(n => n.loginWithActiveDirectoryRegistry)} inlineCheckbox="block"
                onChange={forceUpdate} />

            <AutoLine ctx={ctx.subCtx(n => n.domainName)} />
            <AutoLine ctx={ctx.subCtx(n => n.ldapUrl)} helpText="Defaults to ldap://<domain name>" />
            <AutoLine ctx={ctx.subCtx(n => n.baseDN)} helpText="Search base; defaults to the domain name as DC components" />

            <AutoLine ctx={ctx.subCtx(n => n.directoryRegistry_Username)}
                helpText="Required for directory lookups when the host process is not a domain member" />
            <AutoLine ctx={ctx.subCtx(n => n.directoryRegistry_Password)} />

            <div className="row">
                <div className="col-sm-4">
                    <CheckboxLine ctx={ctx.subCtx(n => n.allowMatchUsersBySimpleUserName)} inlineCheckbox="block" />
                </div>
                <div className="col-sm-4">
                    <CheckboxLine ctx={ctx.subCtx(n => n.autoUpdateUsers)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
                <div className="col-sm-4">
                    <CheckboxLine ctx={ctx.subCtx(n => n.autoCreateUsers)} inlineCheckbox="block" onChange={forceUpdate} />
                </div>
            </div>

            {(ctx.value.autoCreateUsers || ctx.value.autoUpdateUsers) && <div>
                <EntityTable ctx={ctx.subCtx(n => n.roleMapping)} avoidFieldSet="h3" />
                <EntityLine ctx={ctx.subCtx(n => n.defaultRole)} />
            </div>}
        </div>
    );
}
