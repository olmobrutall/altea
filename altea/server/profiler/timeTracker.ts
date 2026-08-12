// Port of Signum's TimeTracker (Signum.Utilities/Profiler/TimeTracker.cs) — the ProfilerTimes backend.
//
// A lightweight global aggregator of elapsed times keyed by an identifier (e.g. an API action). Each
// identifier accumulates Count / TotalDuration / Min / Max (+ the 2nd and 3rd largest) / Last, so the
// admin "Times" page can show per-action statistics. In Signum this is used ONLY to time API requests.
//
// Divergence: JS is single-threaded, so the ConcurrentDictionary + `lock (this)` become a plain Map and
// direct field updates (no locking needed).

export namespace TimeTracker {
    export const identifiedElapseds = new Map<string, TimeTrackerEntry>();

    // Start timing; the returned Disposable records the elapsed ms under `identifier` on dispose.
    // Designed for `using _ = TimeTracker.start(id, url, () => user)`.
    export function start(identifier: string, url?: string, getUser?: () => unknown): Disposable {
        const started = performance.now();
        return {
            [Symbol.dispose]() {
                const ms = Math.round(performance.now() - started);
                insertEntry(identifier, ms, url, getUser?.());
            },
        };
    }

    function insertEntry(identifier: string, milliseconds: number, url: string | undefined, user: unknown): void {
        const time = new TimeTrackerTime(milliseconds, new Date(), url, user);
        const entry = identifiedElapseds.get(identifier);
        if (entry != null)
            entry.include(time);
        else
            identifiedElapseds.set(identifier, new TimeTrackerEntry(identifier, time));
    }
}

export class TimeTrackerTime {
    constructor(
        public readonly duration: number,
        public readonly date: Date,
        public readonly url: string | undefined,
        public readonly user: unknown,
    ) {}
}

export class TimeTrackerEntry {
    identifier: string;

    last: TimeTrackerTime;
    min: TimeTrackerTime;

    max: TimeTrackerTime;
    max2: TimeTrackerTime | undefined;
    max3: TimeTrackerTime | undefined;

    totalDuration = 0;
    count = 0;

    constructor(identifier: string, time: TimeTrackerTime) {
        this.identifier = identifier;
        this.last = this.min = this.max = time;
        this.totalDuration = time.duration;
        this.count = 1;
    }

    include(time: TimeTrackerTime): void {
        this.last = time;
        this.totalDuration += time.duration;
        this.count++;
        if (time.duration < this.min.duration || (this.max3 ?? this.max2 ?? this.max).duration < time.duration) {
            if (time.duration < this.min.duration)
                this.min = time;

            if (this.max.duration < time.duration) {
                this.max3 = this.max2;
                this.max2 = this.max;
                this.max = time;
            } else if (this.max2 == null || this.max2.duration < time.duration) {
                this.max3 = this.max2;
                this.max2 = time;
            } else if (this.max3 == null || this.max3.duration < time.duration) {
                this.max3 = time;
            }
        }
    }

    get averageDuration(): number {
        return this.totalDuration / this.count;
    }

    toString(): string {
        return `Last: ${this.last.duration}ms, Min: ${this.min.duration}ms, Avg: ${this.averageDuration}ms, Max: ${this.max.duration}ms, Count: ${this.count}`;
    }
}
