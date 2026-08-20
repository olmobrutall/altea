
import { AsyncLocalStorage } from 'node:async_hooks';
import { Statics } from '../data/utils/context';
import { CultureInfo } from '../data/utils/cultureInfo';

Statics.newContextVariable = <T>() => {
    const storage = new AsyncLocalStorage<T>();
    return {
        withValue<R>(value: T, fn: () => R): R {
            return storage.run(value, fn);
        },
        getValue(): T | undefined {
            return storage.getStore();
        },
        setValue(_value: T | undefined): void {
            throw new Error(
                'setValue is not supported on the server — use withValue to scope context to a request'
            );
        },
    };
};

// Give the culture context its async-local backing now that Statics has one. The server serves concurrent
// requests in different languages, so `CultureInfo.withUICulture` (the per-request scope webApi opens) has
// to be real here — without this it throws, and every label would resolve in the process default culture.
// Done HERE rather than in each host's startup so importing the server context is the single step.
CultureInfo.initLocalizationContext(Statics);
