# Interaction and state matrix

Six connection states plus the alarm case. Nothing in this table changes sync,
invitation, conflict or roster behaviour · it records what each state draws.

| State | Status line (Status + Connect) | Connect body | Elsewhere in the pane |
| --- | --- | --- | --- |
| **synced** | filled green dot + "Connected · synced"; detail lines: last sync time, private Tailscale network, encrypted in transit | Server · Sync now · Show getting started · Disconnect and change server | no alarm, no count in the strip |
| **syncing** | spinning `hexagon` + "Connected · syncing"; detail: change count, start time | same rows; Sync now stays enabled (it is idempotent) | no alarm |
| **offline** | hollow dot + "Offline · queued"; detail: last sync, what will send | **+ Retry now** directly under Sync now, hint = queued count | no alarm · a queue is a fact, not something that needs the user |
| **reconnect required** | hollow dot + "Offline · queued"; detail names the reason | **+ Retry now**, hint = "reconnect required" | mark dot only if something is actually stranded |
| **reset required** | red `circle-check` + "Not connected"; detail: what the server said | **+ Reset connection** in the same recovery slot · never both recovery actions at once | alarm block above the strip if changes are stranded |
| **disconnected** | no status line | the existing entry chooser (I have an invitation / Host the server myself) and the existing connect form · no second form anywhere | header invite action hidden; the four tabs stay in place and in order |
| **conflicts / failed send** (orthogonal to the above) | unchanged | unchanged | alarm block between header and strip on **every** tab, count on Status, dot on the mark |

Rules that hold in every row:

- One recovery action at a time. `Retry now` and `Reset connection` occupy the
  same slot and are mutually exclusive.
- Nothing is reachable only from the overflow menu. The menu keeps its items as
  shortcuts; Connect shows all of them.
- Colour never carries meaning alone · every dot and glyph sits beside its word.
- `Disconnect and change server` is always the last row of the last block, and
  after it runs the pane lands on the disconnected state above.
