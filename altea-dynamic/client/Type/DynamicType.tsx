import * as React from "react";
import { Tab, Tabs } from "react-bootstrap";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EnumLine } from "@altea/altea/client/Lines/EnumLine";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { EvalMonaco } from "@altea/altea-eval/client/EvalMonaco";
import {
    DynamicBaseType, DynamicTypeEntity, DynamicTypeMessage, DynamicTypeImportsProfile, typeNameWithSuffix,
} from "../../data/DynamicType";
import { DynamicIsolationMixin } from "../../data/DynamicIsolation";
import { dataTemplate, serverTemplate, renameType, exportedNames } from "./DynamicTypeTemplates";
import { DynamicTypeRecipes } from "./DynamicTypeRecipes";
import type { MonacoEditor } from "@altea/altea-monaco/client/MonacoComponent";
import type { Monaco } from "@altea/altea-monaco/client/monaco";

// The type designer: the base type, the name, and the type's SOURCE in two full editors — the data module
// and the server module. Imports are written for the author (EvalMonaco, over the "DynamicType" profile),
// and the server module sees the data module as the LIVE model it is: its exports resolve to the data
// editor's path, so a field added there is known here without saving.
//
// A new type starts from a template once it has a name, and the source follows the name when it changes.
// Beside the data module, RECIPES edit whatever the cursor is on (./DynamicTypeRecipes).

let nextDesigner = 1;

export default function DynamicTypeComponent(p: { ctx: TypeContext<DynamicTypeEntity> }): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const ctx = p.ctx;
    const dt = ctx.value;

    // Stable per designer: the server editor imports the data editor BY this path.
    const dataModule = React.useMemo(() => `__dynamic_data_${nextDesigner++}__`, []);
    const previousName = React.useRef(dt.typeName ?? "");
    const [dataEditor, setDataEditor] = React.useState<{ editor: MonacoEditor; monaco: Monaco } | null>(null);
    const [serverEditor, setServerEditor] = React.useState<MonacoEditor | null>(null);

    function handleNameChange(): void {
        const name = dt.typeName ?? "";
        const old = previousName.current;
        previousName.current = name;

        if (isBlank(dt.dataCode) && isBlank(dt.serverCode)) {
            if (name !== "") {
                dt.dataCode = dataTemplate(name, dt.baseType);
                dt.serverCode = serverTemplate(name, dt.baseType);
            }
        } else {
            dt.dataCode = renameType(dt.dataCode ?? "", old, name);
            dt.serverCode = dt.serverCode == null ? null : renameType(dt.serverCode, old, name);
        }
        forceUpdate();
    }

    function handleBaseTypeChange(previous: DynamicBaseType): void {
        // Only an untouched template is replaced; edited source is the author's.
        const name = dt.typeName ?? "";
        if (name !== "" && dt.dataCode === dataTemplate(name, previous) && dt.serverCode === serverTemplate(name, previous)) {
            dt.dataCode = dataTemplate(name, dt.baseType);
            dt.serverCode = serverTemplate(name, dt.baseType);
        }
        forceUpdate();
    }

    const baseTypeAtRender = dt.baseType;
    const extraNames = React.useMemo(
        () => new Map(exportedNames(dt.dataCode ?? "").map(n => [n, "./" + dataModule] as const)),
        [dt.dataCode, dataModule]);

    const dataCtx = ctx.subCtx(e => e.dataCode);
    const serverCtx = ctx.subCtx(e => e.serverCode);
    const hasServer = dt.baseType === DynamicBaseType.Entity || !isBlank(dt.serverCode);

    return (
        <div>
            <div className="row">
                <div className="col-sm-8">
                    <EnumLine ctx={ctx.subCtx(e => e.baseType)} labelColumns={3} readOnly={!dt.isNew}
                        onChange={() => handleBaseTypeChange(baseTypeAtRender)} />
                    <AutoLine ctx={ctx.subCtx(e => e.typeName)} labelColumns={3} onChange={handleNameChange}
                        unit={dt.typeName ? typeNameWithSuffix(dt.typeName, dt.baseType) : undefined} />

                    {/* Shown only when the APP declared the mixin, which decides whether its column exists. */}
                    {MixinDeclarations.isDeclared(DynamicTypeEntity, DynamicIsolationMixin) &&
                        <AutoLine labelColumns={3}
                            ctx={ctx.subCtx(e => e.mixin(DynamicIsolationMixin)).subCtx(m => m.isolationStrategy)} />}
                </div>
            </div>

            <Tabs defaultActiveKey="data" id="DynamicTypeSource" className="mt-2">
                <Tab eventKey="data" title={DynamicTypeMessage.Data.niceToString()}>
                    <div className="row">
                        <div className="col-lg-8">
                            <SourceEditor error={dataCtx.error}>
                                <EvalMonaco code={dt.dataCode ?? ""} header={[]} footer={[]} subject={dt}
                                    profile={DynamicTypeImportsProfile} path={`file:///eval/${dataModule}.ts`}
                                    isReadOnly={ctx.readOnly}
                                    onMount={(editor, monaco) => setDataEditor({ editor, monaco })}
                                    onChange={code => { dt.dataCode = code; forceUpdate(); }} />
                            </SourceEditor>
                        </div>
                        {!ctx.readOnly &&
                            <div className="col-lg-4 mt-2">
                                <DynamicTypeRecipes side="data" typeName={dt.typeName ?? ""} monaco={dataEditor?.monaco ?? null}
                                    dataEditor={dataEditor?.editor ?? null} serverEditor={serverEditor} />
                            </div>}
                    </div>
                </Tab>
                {hasServer &&
                    <Tab eventKey="server" title={DynamicTypeMessage.Server.niceToString()}>
                        <div className="row">
                            <div className="col-lg-8">
                                <SourceEditor error={serverCtx.error}>
                                    <EvalMonaco code={dt.serverCode ?? ""} header={[]} footer={[]} subject={dt}
                                        profile={DynamicTypeImportsProfile} extraNames={extraNames}
                                        isReadOnly={ctx.readOnly}
                                        onMount={editor => setServerEditor(editor)}
                                        onChange={code => { dt.serverCode = code === "" ? null : code; forceUpdate(); }} />
                                </SourceEditor>
                            </div>
                            {!ctx.readOnly &&
                                <div className="col-lg-4 mt-2">
                                    <DynamicTypeRecipes side="server" typeName={dt.typeName ?? ""} monaco={dataEditor?.monaco ?? null}
                                        dataEditor={dataEditor?.editor ?? null} serverEditor={serverEditor} />
                                </div>}
                        </div>
                    </Tab>}
            </Tabs>
        </div>
    );
}

function SourceEditor(p: { error: string | undefined; children: React.ReactNode }): React.JSX.Element {
    return (
        <div className="mt-2">
            {p.children}
            {p.error != null && <div className="text-danger small mt-1" style={{ whiteSpace: "pre-wrap" }}>{p.error}</div>}
        </div>
    );
}

function isBlank(s: string | null | undefined): boolean {
    return s == null || s.trim() === "";
}
