# ADR-026 — MCP creates and shares; it does not destroy

**Status:** Accepted
**Date:** 2026-08-10
**Accepted:** 2026-08-10
**Extends:** the surface-parity principle (CLI and MCP are the maximum feature set; only the console may lag) — this is its one exception
**Governs:** #180

## Context

CLI and MCP are held to **surface parity**: they are the maximum feature set, and only the console
is permitted to lag. The rule exists because a capability that reaches one surface and not the other
is a capability the operator has to remember the location of, and PageVault's whole argument is that
publishing and remembering happen in the same place.

`DELETE /api/portals/{slug}` was written, tested, and never called from anywhere — not the CLI, not
MCP, not the console. #180 shipped the CLI command. The question it forced was whether MCP gets the
matching tool, and parity's default answer is yes.

The default is wrong here, and this record exists so that "MCP has no `delete_portal`" reads as a
decision rather than as the omission it would otherwise look like.

## Decision

**MCP tools may create, publish, share and revoke. They may not delete a portal.**

`delete_portal` is not registered on `/mcp` and will not be. `pagevault portal-delete` is the
surface for it.

This is a **standing, documented exception** to surface parity — the only one — and it is scoped
precisely to deleting a portal, not generalised into "agents get read-only" or "agents get no
destructive tools."

## Why this operation and not the others

Parity is defensible everywhere else because the operations are recoverable, narrow, or both:

| Tool | If an agent gets it wrong | Recovery |
|---|---|---|
| `publish_document` (overwrite) | a document is replaced | the overwrite guard requires `confirm: true`, and the URL is unchanged |
| `revoke_document` | the document stops being served | the document still exists; it is a flag, not a deletion |
| `revoke_public_link` | a `/p/` URL stops working | mint another |
| `update_portal_members` | the wrong person gains or loses access | one call back |
| **`delete_portal --cascade`** | **a client's entire record is gone** | **none** |

Note the shape of the fourth row against the fifth. `revoke_document` is the closest thing MCP
already holds to a destructive tool, and it deliberately *keeps the document*. There was never a
tool on `/mcp` that destroyed anything, so this is not a new restriction — it is the existing line,
written down before something crossed it.

The asymmetry that decides it: an agent acts on an instruction it inferred from a conversation. Every
other tool's worst case is a wrong document at a right URL, or a wrong name on a list. This one's
worst case is nine months of an engagement, the `/pub/` index a client has bookmarked, and every
`/p/` link already sitting in their inbox — from one misread sentence, with no undo and nothing to
restore from.

`canView()` does not help here. It is an *authorization* function and the operator is authorized;
this is not a question about who is asking.

## What the CLI does instead

The command exists, and its confirmation is proportional rather than uniform:

- **empty portal** → `y/N`, like `rm`
- **holds documents, no `--cascade`** → refused, and the documents are named. The flag is the
  deliberate act; a prompt in its place would train the reflex this is avoiding
- **holds documents, `--cascade`** → type the slug back, after being told the count — the gesture
  `destroy` uses
- **on a `protected` deployment** → an explicit `--yes`, like every other destructive command
  (ADR-021 §6)

A human at a terminal typing a slug back is a materially different act from a model emitting a tool
call. That difference is the entire content of this decision.

## Consequences

- **An agent asked to "clean up the acme portal" will say it cannot.** That is the intended
  behaviour, and the CLI command is what it should point at. It remains able to `revoke_document`
  every document in the portal, which is the recoverable version of the same intent.
- **Surface parity now has an exception**, so the principle must be stated with it attached or the
  next person reads `delete_portal`'s absence as a gap and closes it. That is the main cost, and it
  is why this is an ADR rather than a comment.
- **The console has no delete affordance either** — for now, and for a different reason: the console
  is the surface parity already permits to lag, and a click is closer to a tool call than to a typed
  slug. If it gains one, it needs the typed-slug confirmation, not a modal.
- **`DELETE /api/portals/{slug}` remains reachable** to anyone holding the bearer, as every `/api`
  route is. This ADR governs which surfaces PageVault *ships*, not what the API permits. An operator
  who wants to script it has the CLI, which is the point.

## Alternatives considered

**Ship `delete_portal` with a confirmation argument**, like `publish_document`'s overwrite guard.
Rejected: `confirm: true` is a field the model fills in. It raises the bar for an accident and not at
all for a misunderstanding, and a misunderstanding is the failure mode that matters here.

**Ship it without cascade — portals must be emptied first.** Tempting, and it is the safer half of
the API. Rejected because the emptying is itself `revoke_document` in a loop, which MCP already has,
so the tool would add only the last step of a sequence an agent could already almost complete. It
also invites exactly the workflow this is trying to prevent, one call at a time.

**Drop the surface-parity principle.** Rejected. It is right nearly everywhere, and it is the reason
the CLI and MCP have not drifted. One documented exception costs less than no rule.
