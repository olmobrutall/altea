import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { markdownToText } from "../server/MarkdownToPlainText";

// The markdown→text walk is the one piece of @altea/altea-markdown that replaces a .NET library with a
// different one (Markdig → mdast), so each case pins what one node kind flattens to. Several of them pin
// SIGNUM's behaviour rather than the obviously nicest output — see the file header; where that is the point,
// the case says so.
describe("markdownToText", () => {

    test("null in, null out", () => {
        assert.equal(markdownToText(null), null);
        assert.equal(markdownToText(undefined), null);
    });

    test("a paragraph loses its emphasis markers", () => {
        assert.equal(markdownToText("Hello **world** and *you*."), "Hello world and you.");
    });

    test("inline code keeps its content and loses the backticks", () => {
        assert.equal(markdownToText("run `npm test` now"), "run npm test now");
    });

    test("a heading is its text, on its own line", () => {
        assert.equal(markdownToText("# Title\n\nBody"), "Title\nBody");
    });

    test("a link is its text; the url is dropped", () => {
        assert.equal(markdownToText("see [the docs](http://example.com)"), "see the docs");
    });

    test("an image is its ALT text — mdast keeps that on the node, Markdig in its children", () => {
        assert.equal(markdownToText("![a chart](chart.png)"), "a chart");
    });

    test("an unordered list is prefixed '- ', one item per line", () => {
        assert.equal(markdownToText("- one\n- two"), "- one\n- two");
    });

    test("an ordered list is numbered from 1, ignoring the list's own start", () => {
        // Signum's counter starts at 1 whatever the source says; mirrored deliberately.
        assert.equal(markdownToText("3. three\n4. four"), "1. three\n2. four");
    });

    test("a nested list flattens, the inner items keeping their own prefixes", () => {
        assert.equal(markdownToText("- outer\n  - inner"), "- outer- inner");
    });

    test("a blockquote is transparent", () => {
        assert.equal(markdownToText("> quoted\n\nafter"), "quoted\nafter");
    });

    test("a soft line break inside a paragraph survives", () => {
        assert.equal(markdownToText("first\nsecond"), "first\nsecond");
    });

    test("a hard line break (two trailing spaces) survives", () => {
        assert.equal(markdownToText("first  \nsecond"), "first\nsecond");
    });

    test("a code block contributes NOTHING — Markdig's CodeBlock is a leaf Signum's switch never reaches", () => {
        // Mirrored, not fixed, so the two implementations stay comparable.
        assert.equal(markdownToText("before\n\n```\nlet x = 1;\n```\n\nafter"), "before\nafter");
    });

    test("a thematic break and an html block contribute nothing either", () => {
        // Note the single newline: each paragraph appends exactly one, so a dropped block leaves no gap.
        assert.equal(markdownToText("a\n\n---\n\n<div>x</div>\n\nb"), "a\nb");
    });

    test("a GFM table is not parsed by either parser, so it comes through as literal text", () => {
        // Markdig's default pipeline enables no extensions, and neither does a bare `fromMarkdown`.
        assert.equal(markdownToText("| a | b |\n|---|---|\n| 1 | 2 |"), "| a | b |\n|---|---|\n| 1 | 2 |");
    });

    test("the result is trimmed", () => {
        assert.equal(markdownToText("\n\n  Hello\n\n\n"), "Hello");
    });

    test("a realistic mixed document", () => {
        const md = "# Release notes\n\nWe **shipped** it.\n\n- faster `import`\n- fewer bugs\n\nSee [the log](/log).\n";
        assert.equal(markdownToText(md), "Release notes\nWe shipped it.\n- faster import\n- fewer bugs\nSee the log.");
    });
});
