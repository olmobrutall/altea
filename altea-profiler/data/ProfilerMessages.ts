import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum's profiler message enums (Signum.Profiler/ProfilerPermissions.cs HeavyProfilerMessage +
// ProfilerMessage.cs ProfilerMessage/TimeMessage). altea message containers are `{ Member: msg("Default") }`
// objects; a bare `msg()` infers the English default from the PascalCase member name, and `.niceToString(...)`
// formats {0}/{1} and prefers a loaded translation. C# `[Description("…")]` becomes the msg() argument.

export const HeavyProfilerMessage = {
    HeavyProfilerLoading: msg("Heavy Profiler (loading...)"),
    HeavyProfiler: msg(),
    Upload: msg(),
    Record: msg(),
    Update: msg(),
    Clear: msg(),
    Download: msg(),
    IgnoreHeavyProfilerEntries: msg(),
    UploadPreviousRunsToComparePerformance: msg("Upload previous runs to compare performance."),
    EnableTheProfilerWithTheDebuggerWith0AndSaveTheResultsWith1: msg("Enable the profiler with the debugger with {0} and save the results with {1}"),
    Entries: msg(),
};

export const ProfilerMessage = {
    HeavyProfiler: msg(),
    Entry0Loading: msg("Entry {0} (loading...)"),
    Entry0_: msg("Entry {0}"),
    Role: msg(),
    Time: msg(),
    Download: msg(),
    Update: msg(),
    AdditionalData: msg(),
    StackTrace: msg("StackTrace"),
    NoStackTrace: msg("No StackTrace"),
    StackTraceOverview: msg("StackTrace Overview"),
    AsyncStack: msg(),
    Namespace: msg(),
    Type: msg(),
    Method: msg(),
    FileLine: msg(),
};

export const TimeMessage = {
    TimesLoading: msg("Times (loading...)"),
    Times: msg(),
    Reload: msg(),
    Clear: msg(),
    Bars: msg(),
    Table: msg(),
    Average: msg(),
    Executed: msg(),
    Total: msg(),
    NoDuration: msg(),
    TimesOverview: msg(),
    Name: msg(),
    Entity: msg(),
    Count: msg(),
    Min: msg(),
    Max: msg(),
    Last: msg(),
    TimeStatistics: msg(),
};
