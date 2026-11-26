import { describe, expect, test } from "bun:test";
import { rewriter } from "./sessionTransfer.ts";

// A sender on /Users/jan with a work profile, sending to /Users/piet on the default one.
const id = "11111111-2222-3333-4444-555555555555";
const next = "99999999-8888-7777-6666-555555555555";
const rewrite = rewriter([
  [`/Users/jan/.claude-work/projects/-x/${id}`, `/Users/piet/.claude/projects/-y/${next}`, "name"],
  ["/Users/jan/Documents/Claude", "/Users/piet/imported/s"],
  ["/Users/jan/.claude-work", "/Users/piet/.claude"],
  ["/Users/jan", "/Users/piet"],
  [id, next, "name"],
]);

describe("rewriter", () => {
  const cases: [string, string, string][] = [
    ["home", `"/Users/jan/notes.md"`, `"/Users/piet/notes.md"`],
    ["home at the end", "cd /Users/jan", "cd /Users/piet"],
    ["home before a full stop", "it is in /Users/jan.", "it is in /Users/piet."],
    ["home before JSON's escaped newline", String.raw`/Users/jan\n`, String.raw`/Users/piet\n`],
    // Another user's folder is left alone.
    ["a longer user name", "/Users/janet/x", "/Users/janet/x"],
    ["a user name with a dot", "/Users/jan.doe/x", "/Users/jan.doe/x"],
    ["a user name with a dash", "/Users/jan-old/x", "/Users/jan-old/x"],
    ["profile", "/Users/jan/.claude-work/skills/a", "/Users/piet/.claude/skills/a"],
    // Only the home part moves: the profile's name is not the start of these.
    ["a file beside the profile", "/Users/jan/.claude-work.json", "/Users/piet/.claude-work.json"],
    ["a folder beside the profile", "/Users/jan/.claude-work-old/a", "/Users/piet/.claude-work-old/a"],
    ["cwd", "/Users/jan/Documents/Claude/a.txt", "/Users/piet/imported/s/a.txt"],
    ["a folder whose name continues with a space", "/Users/jan/Documents/Claude dashboard/a", "/Users/piet/Documents/Claude dashboard/a"],
    ["cwd followed by a word", "ran in /Users/jan/Documents/Claude and stopped", "ran in /Users/piet/imported/s and stopped"],
    ["the transcript file", `/Users/jan/.claude-work/projects/-x/${id}.jsonl`, `/Users/piet/.claude/projects/-y/${next}.jsonl`],
    ["a saved tool result", `/Users/jan/.claude-work/projects/-x/${id}/tool-results/a.txt`, `/Users/piet/.claude/projects/-y/${next}/tool-results/a.txt`],
    ["the session id", `"sessionId":"${id}"`, `"sessionId":"${next}"`],
    ["a longer id", `${id}0`, `${id}0`],
    ["no double rewrite", "/Users/jan/.claude-work/x /Users/jan/y", "/Users/piet/.claude/x /Users/piet/y"],
  ];
  for (const [name, input, want] of cases) test(name, () => expect(rewrite(input)).toBe(want));
});
