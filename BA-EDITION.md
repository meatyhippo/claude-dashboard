# Claude Dashboard — BA edition

**Claude Dashboard is made by Rein Vanbelleghem**
([github.com/ReinVanbelleghem/claude-dashboard](https://github.com/ReinVanbelleghem/claude-dashboard)).
This branch adds solution-architect, Professional Services and IDM workflows for Qargo
on top of it. Rein's README, branding, app name and behaviour are unchanged.

## Install

On a Mac (Apple silicon, macOS 13 or later), paste into Terminal; run it again to update:

```bash
curl -fsSL https://raw.githubusercontent.com/MathijsRochus/claude-dashboard/qargo-ba-edition/get.sh | bash
```

It needs nothing installed first. GitHub builds the app on every push to this branch
(`.github/workflows/ba-app.yml`) and publishes it on the rolling `ba-app` release, which
`get.sh` downloads. When GitHub has no macOS runner free, `./scripts/publish-ba-app.sh` does
the same from any Apple silicon Mac. Details in the README's Quick start.

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
| Qai | **Qai** page, and Qai on customers and IRs: ask Qai in #ps_troubleshooting with tenant/IR/Front context, duplicate check, replies read back |
| Calendar via Claude | Google Calendar through the claude.ai connector, read-only |
| Run BA sessions in the cloud | Session buttons start a claude.ai/code cloud session; **Cloud / This Mac** switch beside the buttons |
| Build on the Qargo MCP | Create integration / mapping / visibility mapping from an IR (test tenant by default; prod asks first) |
| Qargo diagrams | Excalidraw styleguide: integration-landscape template, shape library, style check, customer export |
| Published artifacts | claude.ai artifacts on the Artifacts page and customer pages, downloadable locally |
| Session handoff | **⋮ → Send to a colleague…** sends a session in a Slack DM; **History → Import session** takes one in and resumes it |
| Feedback mode | A Feedback button that pins notes to any element, for the next round of changes |

## Session handoff

**⋮ → Send to a colleague…** packs a session into one `.claudesession` file and shares it in
a Slack DM. A preview first shows the message count, the MCP connectors it used and any
credentials it spotted in any text file of the session, which must be acknowledged before
anything leaves (the daemon checks this too, not only the page). Save and Send use the exact
file the preview made, so a session that carries on meanwhile can't add an unchecked secret.
Symbolic links in the session folder are left out. Everything Claude read is in the file, customer data included. The recipient is picked
from a Slack search (name, email when shown, title), never guessed.

Sending is four connector calls through the Slack connector (`server/slackSend.ts`): search,
open the DM, get a signed upload URL, share. The daemon uploads the bytes itself, so the file
never passes through a model. **Save file** writes it to `~/Downloads` and opens Slack for
sending by hand.

Not every account's Slack connector offers the upload tools. The dialog checks first by asking
Claude Code for the connector's state and tools, which takes about 5 seconds and no model call.
A connector with everything is trusted for an hour, one without the upload tools for ten
minutes, and one that isn't connected is checked every time the dialog opens (or with **Check
again**). Without the tools, Save file is the way to send, and the dialog says why. Files up to
512 MB can be handed over.

**History → Import session** writes it into this machine's Claude Code profile under a new id,
in its own folder under `~/.claude-dashboard/imported`, and resumes it. The colleague carries on
signed in to Notion, Front and the rest as themselves.

What travels: the conversation, subagent transcripts and saved tool output (large MCP results
and screenshots, which the transcript points at by path). Raw API request copies, account ids
and cost records stay behind. Every path naming the sender's machine is rewritten in one pass.
The file is gzipped JSON: `gunzip -c file.claudesession` shows what is in it
(`server/sessionTransfer.ts`).

## How data is read

- **Connectors**: a small model makes one exact tool call written by the dashboard and the
  raw result is parsed, so nothing is retyped by a model. Results are cached and refreshed
  in the background (`server/baConnector.ts`). Every call has a hard time limit.
- **Writes** (scoping, ticket edits, IR creation, building on the Qargo MCP) start a visible
  session you can watch and steer. Replies and Qai posts show the exact text first.

## Files

New code is in new files, so Rein's updates merge with few conflicts:
`server/ba*.ts`, `shared/baCustomers.ts`, `shared/mailClean.ts`, `shared/qargoDiagram.ts`,
`src/baFlags.ts` and `src/components/` (`Agenda`, `BaEditionSettings`, `BaFilesBar`, `BaIcons`,
`CustomerOverview`, `CustomerPanels`, `DeliveryView`, `DesktopWidgets`, `FeedbackMode`,
`InboxView`, `MailComposer`, `MyDealsPanel`, `PublishedArtifacts`, `QaiPanel`,
`QargoDiagramTools`, `RunWhere`, `StatusPill`), plus `get.sh` and `.github/workflows/ba-app.yml` for
the one-line install.

Rein's files only gain hooks guarded by the switches: `server/index.ts` (route, boot),
`server/calendarSources.ts` (connector calendar), `src/App.tsx`, `src/pages.ts`,
`src/api.ts`, `ProjectPage`, `ProjectsView`, `SettingsView`, `ArtifactsView`,
`DesktopView`, `Drawing*`, `FolderPicker`, `HistoryView`, `LocationPicker`, `SessionMenu`, `WorkspaceTree` and `styles.css`
(BA classes only). Two build fixes apply to everyone: `scripts/preflight.sh` (Homebrew bun)
and `scripts/build-app.sh` (rebuilds over a read-only bun; signing a checkout in iCloud Drive).

Session handoff is in `server/sessionTransfer.ts`, `server/slackSend.ts` and
`src/components/SessionTransfer.tsx`.

## Note

The upstream repository has no LICENSE file. Ask Rein before sharing this edition
outside Qargo.
