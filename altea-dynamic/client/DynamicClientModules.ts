import { ajaxGet } from "@altea/altea/client/Services";
import { beforeLoadMetadataHooks } from "@altea/altea/client/ReflectionClient";
import { getLocation, getRegisteredEnums, getRegisteredTypes } from "@altea/altea/data/registration";
import * as basics from "@altea/altea/data/basics";
import * as clock from "@altea/altea/data/utils/clock";
import * as decorators from "@altea/altea/data/decorators";
import * as entity from "@altea/altea/data/entity";
import * as enums from "@altea/altea/data/enum";
import * as lite from "@altea/altea/data/lite";
import * as localization from "@altea/altea/data/utils/localization";
import * as operations from "@altea/altea/data/operations";
import * as reflection from "@altea/altea/data/reflection";
import * as registration from "@altea/altea/data/registration";
import * as validators from "@altea/altea/data/validators";
import type { DynamicClientModule } from "../data/DynamicPanel";

// The dynamic types in the BROWSER. altea's client takes an entity's shape from its class (the decorators
// stamp the TypeInfo), not from the server's JSON as Signum does, so a type compiled at run time must run
// here too. No bundler: the server sends each DATA module as the JS it loaded itself, re-emitted as
// CommonJS (DynamicCodeCompiler.toClientModules), and every `require` is answered from what the bundle
// already holds — so a dynamic type extends the very `Entity` and registries the rest of the app uses.
//
// A specifier resolves, in order, to:
//  - another dynamic module (`./Pizza`), evaluated on first use;
//  - a framework module registered here (`registerModule`): the data-tier modules the "DynamicType"
//    import profile offers;
//  - otherwise a FACADE of the registered types and enums declared in that file — the client half of the
//    eval profile's `fromSchema`, from the same location stamps, so no app needs to list its modules.
//
// Loaded once, before the first reflection blob (which is applied by type name). New or changed types need
// a page reload, as they need a server restart.

const frameworkModules = new Map<string, unknown>([
    ["@altea/altea/data/basics", basics],
    ["@altea/altea/data/utils/clock", clock],
    ["@altea/altea/data/decorators", decorators],
    ["@altea/altea/data/entity", entity],
    ["@altea/altea/data/enum", enums],
    ["@altea/altea/data/lite", lite],
    ["@altea/altea/data/utils/localization", localization],
    ["@altea/altea/data/operations", operations],
    ["@altea/altea/data/reflection", reflection],
    ["@altea/altea/data/registration", registration],
    ["@altea/altea/data/validators", validators],
]);

export namespace DynamicClientModules {

    let loading: Promise<void> | undefined;

    /** Another module a dynamic DATA module may import on the client (a framework module not listed above). */
    export function registerModule(specifier: string, module: unknown): void {
        frameworkModules.set(specifier, module);
    }

    export function start(): void {
        beforeLoadMetadataHooks.push(() => loading ??= load());
    }

    async function load(): Promise<void> {
        let modules: DynamicClientModule[];
        try {
            modules = await ajaxGet<DynamicClientModule[]>({ url: "/api/dynamic/clientModules", avoidDeserialize: true });
        } catch (e) {
            // The app still boots, without its dynamic types — like a server whose dynamic code failed.
            console.error("[altea-dynamic] could not load the dynamic types on the client", e);
            return;
        }
        const byFile = new Map(modules.map(m => [stem(m.fileName), m]));
        const evaluated = new Map<string, Record<string, unknown>>();

        function evaluate(m: DynamicClientModule): Record<string, unknown> {
            const key = stem(m.fileName);
            const done = evaluated.get(key);
            if (done != null)
                return done;

            const exports: Record<string, unknown> = {};
            evaluated.set(key, exports); // before running: a cycle sees the partial exports, as in CommonJS
            const module = { exports };
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            new Function("require", "exports", "module", m.code + `\n//# sourceURL=altea-dynamic:///${m.fileName}`)(
                (specifier: string) => resolve(specifier, m.fileName), exports, module);
            if (module.exports !== exports)
                evaluated.set(key, module.exports);
            return module.exports;
        }

        function resolve(specifier: string, from: string): unknown {
            if (specifier.startsWith(".")) {
                const dynamic = byFile.get(join(from, specifier));
                if (dynamic != null)
                    return evaluate(dynamic);
            }

            const framework = frameworkModules.get(specifier);
            if (framework != null)
                return framework;

            const facade = facadeFor(specifier);
            if (facade != null)
                return facade;

            throw new Error(`The dynamic module '${from}' imports '${specifier}', which is not available on the client. `
                + `A data module that the browser needs is registered with DynamicClientModules.registerModule.`);
        }

        for (const m of modules) {
            try {
                evaluate(m);
            } catch (e) {
                // One broken module must not take the whole client down: its types are missing, the rest work.
                console.error(`[altea-dynamic] could not load ${m.fileName} on the client`, e);
            }
        }
    }

    /** The registered types and enums declared in the file a specifier names (`<package>/<stem>` or `./<stem>`). */
    function facadeFor(specifier: string): Record<string, unknown> | undefined {
        const matches = (name: string): boolean => {
            const location = getLocation(name);
            if (location == null)
                return false;
            const file = stem(location.fileName);
            return specifier.startsWith("./")
                ? file === specifier.slice(2)
                : `${location.packageName}/${file}` === specifier;
        };

        const facade: Record<string, unknown> = {};
        for (const ctor of getRegisteredTypes())
            if (matches(ctor.name))
                facade[ctor.name] = ctor;
        for (const [name, value] of getRegisteredEnums())
            if (matches(name))
                facade[name] = value;

        return Object.keys(facade).length > 0 ? facade : undefined;
    }

    function stem(fileName: string): string {
        return fileName.replace(/\.(tsx?|js)$/, "");
    }

    /** `from`'s directory joined with a relative specifier, normalized — both relative to the code-gen root. */
    function join(from: string, specifier: string): string {
        const parts = from.split("/").slice(0, -1);
        for (const segment of stem(specifier).split("/")) {
            if (segment === "..")
                parts.pop();
            else if (segment !== ".")
                parts.push(segment);
        }
        return parts.join("/");
    }
}
