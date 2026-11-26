# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Vite + React UI served by a local Bun daemon (browser tab on localhost) and wrapped in an Electron shell for the Mac app. The Electron app shows the same web page; it is not a native design language.

## Users

Primary: Qargo's business architects, solution architects, Professional Services consultants and IDMs (implementation/delivery managers). They work across many customers at once. Their mail, deals, integration requests (IRs), meetings and Slack threads are spread over Front, Notion, Slack and Google Calendar, and they use Claude Code for scoping, drafting and building integrations.

Secondary: developers running Rein Vanbelleghem's upstream Claude Dashboard with the BA edition switched off. For them the product is a local control room for Claude Code sessions. Their experience must stay intact.

## Product Purpose

A local dashboard for Claude Code. The BA edition turns it into a daily workspace organised around Qargo customers. It shows what needs the BA and what is running, and lets Claude do the work in sessions the BA can watch.

Success for a BA:
- **Nothing slips.** Front mail, IRs, scoping windows, go-lives, change requests and meetings are seen in time, in one place, placed at the right customer.
- **Less context switching.** Notion, Front, Slack and Calendar are read without opening each tool.
- **Claude does the legwork.** Drafts, scoping, IR creation, Qai questions and Qargo MCP builds run as Claude sessions that can be watched and steered.

## Positioning

The dashboard drives the user's own Claude Code install, with their settings, skills, MCP servers and claude.ai connectors. It joins Qargo's customer data (Deals Extract, Customer Tasks, Front, Slack, Calendar) to sessions that act on that data. Generic CRM or inbox tools can't take action, and a plain Claude Code terminal has no idea which customer a piece of work belongs to.

## Operating Context

- Runs entirely on the user's Mac (Apple silicon, macOS 13+). The daemon binds 127.0.0.1 only. State lives in `~/.claude-dashboard`.
- Installed with `get.sh` from a private GitHub release (`ba-app`), or from source with `install.sh`. Runs as an app or as a browser tab.
- Data comes in through claude.ai connectors (Notion, Front, Slack, Google Calendar). For each read, a small model makes one tool call written by the dashboard. The raw result is parsed and cached.
- The BA edition is off until switched on in Settings → BA edition. Its pages: Inbox, Delivery, Qai, and the customer tabs (Overview, Integration tickets, Front, IR workspace).
- Base pages: Home, Projects/Customers, Tasks, Calendar, History, Artifacts, Notes, Drawings, Workspaces, Services, Templates, Reviews, Usage, Settings.
- Vocabulary: customer, deal, IR (integration request), IDM, scoping window, go-live, change request, Qai (#ps_troubleshooting), tenant (test/prod), Qargo MCP, mapping.

## Capabilities and Constraints

- Writes (scoping, ticket edits, IR creation, MCP builds) start a visible session. Replies and Qai posts show the exact text before anything is sent. Building on the Qargo MCP uses the test tenant by default; prod asks first.
- Session handoff sends a `.claudesession` file to a colleague over Slack. Detected credentials must be acknowledged before the file leaves.
- New BA code lives in new files (`server/ba*.ts`, `src/baFlags.ts`, BA components). Upstream files only get hooks guarded by the switches, so Rein's updates merge with few conflicts. Future work must keep it this way.
- With the edition off, no BA route answers, no background mail reads run and no settings change.
- Open: the upstream repository has no LICENSE. Ask Rein before sharing outside Qargo.

## Brand Commitments

- **Qargo style throughout (user decision, 2026-11-26):** the whole app is to be branded in Qargo style, following the Qargo brand skill and app look.
- **Attribution stays:** BA-EDITION.md credits Rein Vanbelleghem as the maker. Keep that credit.
- **Open tension:** BA-EDITION.md currently promises that Rein's branding and app name stay unchanged, and that upstream files stay merge-friendly. Restyling the whole app conflicts with both. Decide how far the restyle goes and how it is kept out of upstream files (for example a separate theme layer) before redesign work starts. Owner: TBD.

## Evidence on Hand

- README.md and BA-EDITION.md: feature and behaviour documentation.
- `public/` icons (favicon, apple-touch-icon); `src/components/BrandMark.tsx`.
- Existing appearance system: `src/appearance.ts` (palettes, accents) and the Theme Studio, with contrast promises checked by `scripts/check-contrast.ts`.
- No user research, metrics, testimonials or adoption figures. Do not invent any.

## Product Principles

1. **The customer is the unit of work.** Mail, tickets, meetings and sessions are placed under the customer and IR they belong to.
2. **Show what needs the user first.** Each surface starts with what is due, waiting or at risk.
3. **Claude acts in the open.** Every write is a session the user can watch, steer or stop. Nothing is sent without showing the exact text.
4. **Local and private by default.** Customer data stays on the machine, and everything outward-facing is an explicit action.
5. **Additive to upstream.** BA features switch on and off cleanly and never break the base dashboard.

## Accessibility & Inclusion

Existing promise, enforced by `scripts/check-contrast.ts`: primary and secondary text reach 4.5:1 and muted text 3:1 on every surface step, and every accent reaches 4.5:1, in every palette. Keep this promise through any rebrand.
