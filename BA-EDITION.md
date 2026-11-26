# Claude Dashboard — BA edition

**Claude Dashboard is made by Rein Vanbelleghem**
([github.com/ReinVanbelleghem/claude-dashboard](https://github.com/ReinVanbelleghem/claude-dashboard)).
This branch adds solution-architect, Professional Services and IDM workflows for Qargo
on top of it. Rein's README, branding, app name and behaviour are unchanged.

## Off until you switch it on

A fresh install is Rein's original dashboard, page for page. The only visible
difference is a **Settings → BA edition** section. Switching the edition on there:

- shows the BA pages (Inbox, Delivery, Qai) and the customer tabs;
- hides Workspaces, Services and Reviews once (Settings → Pages turns them back on);
- adds the BA session templates once (delete any you don't want; they don't come back).

With the edition off, no BA route answers (except its switches), no background mail
reads run, and no settings are touched. The switches live in
`~/.claude-dashboard/ba-edition.json`.

## Before you switch it on

The edition reads through your **claude.ai connectors**, so connect these in claude.ai first:

- **Notion**: deals (Deals Extract) and integration tickets (Customer Tasks).
- **Front**: the mailbox. Grant **Attachments (Read)** to have attachments saved into customer folders.
- **Slack**: customer channels and Qai in #ps_troubleshooting.
- **Google Calendar**: meetings on the Calendar page, Home and Delivery (no Google Cloud project needed).

## Switches

| Switch | What it adds |
| --- | --- |
| Customers from Notion | Projects read as customers; **My deals** and the deal directory on the Customers page; **Overview**, **Integration tickets** and **Front** tabs on a customer; an **IR workspace** per integration request |
| Inbox triage | **Inbox** page: Front mail placed at customers and IRs (Front Link → tenant → learned contact/domain → Notion domain), with reply, Claude drafts and key points |
| Delivery (IDM) | **Delivery** page: meetings, 2-week scoping window, billable pipeline, go-live watch, change requests, per customer |
| Workbench | **Workbench** page: your engineering issues (Bugs and Feature development, "Me" view) as Scoping / Tasks / Change requests with Backlog / Current / Blocked stages, pins, Status written to Notion, State (Awaiting customer and an hourly Front check for replies), setup steps from the Workbench Steps database, **Start** per ticket (one Claude Code session per ticket) and the **Morning digest** |
| Qai | **Qai** page, and Qai on customers and IRs: ask Qai in #ps_troubleshooting with tenant/IR/Front context, duplicate check, replies read back |
| Calendar via Claude | Google Calendar through the claude.ai connector, read-only |
| Run BA sessions in the cloud | Session buttons start a claude.ai/code cloud session; **Cloud / This Mac** switch beside the buttons |
| Build on the Qargo MCP | Create integration / mapping / visibility mapping from an IR (test tenant by default; prod asks first) |
| Qargo diagrams | Excalidraw styleguide: integration-landscape template, shape library, style check, customer export |
| Published artifacts | claude.ai artifacts on the Artifacts page and customer pages, downloadable locally |
| Feedback mode | A Feedback button that pins notes to any element, for the next round of changes |

## How data is read

- **Connectors**: a small model makes one exact tool call written by the dashboard and the
  raw result is parsed, so nothing is retyped by a model. Results are cached and refreshed
  in the background (`server/baConnector.ts`). Every call has a hard time limit.
- **Writes** (scoping, ticket edits, IR creation, building on the Qargo MCP) start a visible
  session you can watch and steer. Replies and Qai posts show the exact text first.

## Files

New code is in new files, so Rein's updates merge with few conflicts:
`server/ba*.ts`, `server/wb.ts`, `server/wbRules/`, `shared/wb.ts`, `src/components/WorkbenchView.tsx`, `shared/baCustomers.ts`, `shared/mailClean.ts`, `shared/qargoDiagram.ts`,
`src/baFlags.ts` and `src/components/` (`Agenda`, `BaEditionSettings`, `BaFilesBar`, `BaIcons`,
`CustomerOverview`, `CustomerPanels`, `DeliveryView`, `DesktopWidgets`, `FeedbackMode`,
`InboxView`, `MailComposer`, `MyDealsPanel`, `PublishedArtifacts`, `QaiPanel`,
`QargoDiagramTools`, `RunWhere`, `StatusPill`).

Rein's files only gain hooks guarded by the switches: `server/index.ts` (route, boot),
`server/calendarSources.ts` (connector calendar), `src/App.tsx`, `src/pages.ts`,
`src/api.ts`, `ProjectPage`, `ProjectsView`, `SettingsView`, `ArtifactsView`,
`DesktopView`, `Drawing*`, `FolderPicker`, `LocationPicker`, `WorkspaceTree` and `styles.css`
(BA classes only). Two build fixes apply to everyone: `scripts/preflight.sh` (Homebrew bun)
and `scripts/build-app.sh` (rebuilds over a read-only bun; signing a checkout in iCloud Drive).

## Note

The upstream repository has no LICENSE file. Ask Rein before sharing this edition
outside Qargo.
