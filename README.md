# opencode-cua-tutor

An OpenCode V2 plugin that adds a **`CUA Tutor → Tutor`** (`cua-tutor/tutor`) model for learning
**macOS apps**. Everything in the plugin is **100% isolated to the `Tutor` model**: when any other
model is selected, zero tutor tools, zero guidance, and zero MCP servers are active or visible.

Inside **`Tutor`**:
- **System-1 fast path (0 System-2 tokens):** A ~90 ms 4-`Noul` TypeSafe Jev Intent Gate routes
  visible UI requests directly to **Cua Driver** + **TypeSafe Jev** (Companion `Noul`s + clean
  `Choice`, with **Coarse-to-Fine Tile → Zoom `Box`** fallback for unlabeled icons and canvas
  items), gliding the Cua Driver agent cursor directly to the control. **It never clicks. You click.**
- **Full native System-2 agent loop:** On app setup/switching, conceptual questions, web research,
  or System-1 misses, `cua-tutor/tutor` routes seamlessly via `experimental.model.resolve` to a
  hidden `cua-tutor/system2` model (cloned from the model you set as `system2Model`) with full
  OpenCode tool calling (`tutor_set_app`,
  `tutor_highlight`, `websearch`, `webfetch`, `read`, `question`, etc.).
- **Explicit app selection + auto-launch:** No `ignoreApps` list and no guessing from open windows.
  `tutor_highlight` is hard-gated on `tutor_set_app` — tell `Tutor` once which app you’re working
  in and it validates the installed macOS `.app` bundle, **automatically launches it** if closed,
  and remembers it for the rest of the session.

Nothing to launch: it works in your normal OpenCode, including the background service. Watched
configuration/plugin changes reload automatically; external local dependencies may not be watched.
The tool result includes its executing revision so a live reload can be checked.

## Prerequisite (once): Cua Driver

```sh
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver permissions grant
```

In System Settings ▸ Privacy & Security, switch **CuaDriver** on under **Accessibility** and
**Screen & System Audio Recording**, then accept the relaunch. Check it with
`cua-driver permissions status`. The installer puts the binary in `~/.local/bin/cua-driver`,
and the plugin looks there, so PATH doesn't matter.

## Install

1. Install the plugin's dependencies once: `cd /path/to/opencode-cua-tutor && bun install`
2. Add the plugin to your global OpenCode config, `~/.config/opencode/opencode.jsonc`, with a
   `system2Model`. Keep the keys you already have:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "/path/to/opencode-cua-tutor",
         "options": {
           "system2Model": "opencode-go/glm-5.3-flash#high"
         }
       }
     ]
   }
   ```

   `system2Model` is required and has no default. It is the model `Tutor` hands a turn to when
   it can't just point at a control: setting up the app, conceptual questions, web research, and
   System-1 misses. Use any `provider/model` or `provider/model#variant` you can already use in
   OpenCode, including providers defined in your own `opencode.json(c)`; the System 2 model uses that
   provider's credentials. The `CUA_TUTOR_SYSTEM2_MODEL` environment variable also works. Without
   it, the plugin fails to load with an error naming the option. `"none"` runs `Tutor` without
   System 2 (it then only points, and can't call `tutor_set_app`, so pin `app` too).

3. Give the OpenCode server your Jev key as `TYPESAFE_API_KEY`
   (<https://console.typesafe.ai/keys>; $0.042 per 1M input tokens, output free). The OpenCode
   server process has to see the variable. Without a key the tool reports unavailable.
   `provider: "mock"` explicitly enables a development-only word matcher; results identify it.

## Direct Tutor Mode (`CUA Tutor → Tutor` — System 1 first, native System-2 agent loop)

The plugin registers the **`CUA Tutor`** provider (`cua-tutor`) with one visible model in OpenCode's
picker (**`Tutor`**, `cua-tutor/tutor`) and one hidden System 2 model (`cua-tutor/system2`, cloned
from your required **`system2Model`**):

1. Select **`CUA Tutor → Tutor`** in the model picker (works in Desktop, TUI, Web, and Mobile).
2. Mention the app once at the start (e.g. *"I'm trying to learn FilmCraft today"*). System 2 calls
   **`tutor_set_app({ app })`**, which resolves the verified installed macOS `.app` bundle,
   **automatically launches it** if closed (`autoLaunch: true` by default), and remembers it for
   the rest of the session.
3. **Jev Intent Gate (~90 ms, 4 parallel atomic `Noul`s, 0 screenshots):**
   - `explicit_do_for_me` → instant point-only notice (`0` LLM tokens, `0` screenshots).
   - `is_conceptual_or_chat` (or no app set yet) → routes natively to `cua-tutor/system2` for a
     full OpenCode tool-calling loop (`tutor_set_app`, `websearch`, `webfetch`, `read`, `question`, etc.).
   - `wants_ui_pointer` (once an app is set) → runs `CuaDriver + TypeSafe Jev` directly with
     **zero System-2 tokens** and points immediately.
4. **Automatic System-2 escalation on UI miss:** If System 1 returns `reobserve`, `abstain`,
   `unsure`, or `partial` (e.g. a setting hidden behind an unopened tab/menu), it routes that turn
   to `cua-tutor/system2` with the System-1 miss diagnostics injected into context so System 2 can
   coach you, search docs, or call `tutor_highlight` on the visible prerequisite control.

## Tutor Tools (visible ONLY when `Tutor` is selected)

```ts
tutor_set_app({ app: string })
tutor_highlight({ step: string, visualCue?: string })
```

- `tutor_set_app`: sets the session's active macOS app (`"FilmCraft"`, `"Keynote"`, `"TextEdit"`).
  Validates strictly against installed macOS `.app` bundles (`/Applications`, `~/Applications`,
  `/System/Applications`) and launches it automatically when closed (`autoLaunch: true`). Must be
  called before `tutor_highlight` can run.
- `tutor_highlight`: points the on-screen agent cursor at one currently-visible control or canvas
  item in the session's active app (never clicks). Refuses to run until `tutor_set_app` has set an
  app — never guesses from open windows.
- Both tools (and all Tutor guidance) are stripped via `session.hook("context")` whenever any model
  other than `cua-tutor/tutor` is active.

## What the plugin adds (OpenCode V2 API)

| Mechanism | What |
| --- | --- |
| `ctx.provider.transform` | Registers `CUA Tutor` (`cua-tutor`) with visible `cua-tutor/tutor` and hidden `cua-tutor/system2`, cloned from the fully resolved `system2Model` (`ctx.model.list()`), borrowing its provider's credentials |
| `ctx.session.hook("experimental.model.resolve")` | Routes `cua-tutor/tutor` turns between System 1 (zero LLM tokens) and native `cua-tutor/system2` (full OpenCode tool loop) |
| `ctx.session.hook("title")` + resolve `kind: "title"` | Session titles are generated by `cua-tutor/system2`, like any OpenCode session; with `system2Model: "none"` the plugin titles from the first message without an LLM |
| `ctx.tool.transform` + `ctx.session.hook("context")` | Exposes `tutor_set_app` and `tutor_highlight` + dynamic Tutor guidance **only** to `Tutor` sessions; strips both on every other model |
| `ctx.mcp.transform` | Optional `cua-driver` MCP declaration (`declareMcp: false` by default so zero tools leak outside `Tutor`) |

## How Jev picks targets (Text-AX first, Coarse-to-Fine `Box` fallback)

1. **Text-only AX pass (0 screenshots):** `get_window_state` reads named controls (up to 200 in one
   request). Controls are placed once in `state.controls`, and Jev answers **4 parallel atomic
   questions** in a single HTTP request:
   - `candidate` (`Choice` over **only** real named controls — no `abstain`/`reobserve`/`inspect`
     competing inside the Choice),
   - `exact_in_named` (`Noul`: does a listed named control directly perform the step?),
   - `is_hidden_subcontrol` (`Noul`: does the step ask for a deeper dialog/menu/effect setting?),
   - `likely_visual_target` (`Noul`: could the target be an unlabeled icon, tab, or canvas item?).
   Plain code routes on those probabilities: direct match → point immediately; hidden subcontrol →
   abstain/reobserve without screenshots; missing/unlabeled/canvas target → trigger visual `Box`.
2. **Coarse-to-Fine Tile → Zoom `Box` fallback (`jev-1.14.0`):** Captures the window at native
   resolution (`max_image_dimension: 0`) and runs:
   - **Pass 1 (Tile Screen):** splits large windows into up to 6 overlapping bilinear-scaled tiles
     and runs parallel per-tile presence `Noul`s (fast abstain if absent from every tile).
   - **Pass 2 (Hi-Res Tile `Box`):** runs `Box` + presence `Noul` on the winning tile (up to 1200 px).
   - **Pass 3 (3× Zoom Refinement):** if the located box is small (`< 60 px`), crops a tight context
     region around it, bilinear-upscales ~3×, and runs a second `Box` + presence `Noul`.
   - **Pass 4 (Red-Box Self-Verification, default on):** draws a red outline around the located box
     and runs 3 atomic `Noul`s (`clickable`, `matches`, `exact`) so drifts onto neighbors abstain.
   - **Snap or Pixel:** snaps exact-containment-first to any small AX rect (giving 0 px center error
     on unnamed AX controls), or points directly at the `Box` pixel center for canvas-drawn content
     (such as timeline clips) with pixel-patch freshness verification before moving the cursor.

Tree-only Cua responses can omit `window_bounds`; the plugin then uses the same snapshot's
single finite AXWindow root frame, after verifying the exact PID/window. Reads explicitly request
full walk metadata, 1,500 nodes, depth 25, and a 3-second walk budget. Actual truncation,
pending nodes, degraded reads, or missing geometry get one same-window reread with up to
2,000 nodes, depth 50, and 4 seconds, within the whole-step deadline.

`elements_complete:false` alone means **unknown coverage**, not an empty or necessarily unusable
tree. It stays false in diagnostics. Jev can select a unique, explicitly enabled named control;
fresh validation must confirm the target and the same named alternatives. Unknown coverage
cannot support an absence claim. It never causes a screenshot by itself. A read that remains
truncated/degraded is refused before inference.

Candidate descriptions preserve native subroles: tab buttons are described as view-switching
tabs and AX toggles as toggle buttons, rather than reducing them to radio/checkbox roles.
Current selected/enabled state, available help text and named ancestors supply context.
The semantic question asks for a direct functional match; it contains no app-specific target map.
Uncertain results expose the model's leading alternatives (including abstain/inspect), their
probabilities and margin. The debug CLI's JSON retains the full final-round distribution.
The recipe's vendored `parseWindowState` and role table (`src/vendor/cua/`, unchanged, MIT) are the
starting point, but `src/candidates.ts` is more permissive than the recipe's `eligibleControls`,
because the tutor only points:

- **Unknown roles are not dropped.** Anything exposing an actionable AX action (`AXPress`,
   `AXPick`, `AXShowMenu`, `AXIncrement`, ...) can be a candidate. Some custom toolkits expose
  unnamed `AXUnknown` controls; current app builds may instead provide useful accessible names.
- **Names** fall back from `label` to `title`, `description`, `help`, `placeholder`.
- **Unnamed controls are judged by picture.** Each gets a 280×280 crop of the screenshot around it
  (element outlined in red, neighbours and row labels in view), sent to Jev with the choice
  options, without repeating the whole window in every request. This uses TypeSafe's experimental image
  input (`TypeSafe-Danger-Zone-Images: true`, sent only on requests that carry images). Turn it off
  with `"visual": false` / `CUA_TUTOR_VISUAL=0` (then only named controls are candidates).
- Dropped: macOS traffic-light buttons, disabled and off-window elements, non-actionable
  elements, and unnamed containers that wrap two or more other candidates.
- Visual tables run in chunks of up to 24, with bounded concurrency, followed by a final round.
  Text-only tables use a 200-control cap. These are plugin choices, not API limits.
- The optional locator alone receives a whole-window image, resized/padded to 280–1568 px on
  both sides. Its boxes map back to the original screenshot; padding cannot become a target.
- Crops still contain nearby content. Labels, values, the step, and image crops are sent to
  TypeSafe. `visual:false` prevents image uploads; it does not prevent textual model requests.

Coordinates (verified live, Cua Driver 0.49.11): element `frame` and `window_bounds` are global
screen points; `screenshot_frame` is the same rect in screenshot pixels (a 1600 pt window came back
as a 1366 px screenshot, 0.854 px/pt). The cursor target is the visible frame centre, clipped to
window and known scroll-area bounds, sent to
`move_cursor` without a `target` (= overlay only, screen points); `get_agent_cursor_state` reads
back the same point.

## Options (plugin object form)

```jsonc
"plugins": [
  {
    "package": "/path/to/opencode-cua-tutor",
    "options": {
      "system2Model": "opencode-go/glm-5.3-flash#high",
      "deadlineMs": 15000
    }
  }
]
```

| Option | Env | Default |
| --- | --- | --- |
| `app` | `CUA_TUTOR_APP` | unset (must be specified by the user/session) |
| `provider` (`live`/`mock`) | `CUA_TUTOR_PROVIDER` | `live`; mock must be explicit; typos are errors |
| `jevModel` | `CUA_TUTOR_JEV_MODEL` | SDK default |
| `directModel` | `CUA_TUTOR_DIRECT_MODEL` | `true` (register the `CUA Tutor → Tutor` router model) |
| `system2Model` | `CUA_TUTOR_SYSTEM2_MODEL` | **Required, no default** while `directModel` is on. Any `provider/model#variant`, including providers defined in `opencode.json(c)`; cloned as hidden `cua-tutor/system2`; `"none"` / `false` explicitly disables System 2 |
| `autoLaunch` | `CUA_TUTOR_AUTO_LAUNCH` | `true` (automatically launch verified installed macOS `.app` bundles when selected & closed) |
| `visual` | `CUA_TUTOR_VISUAL` | `true` (enable Coarse-to-Fine `Box` visual fallback) |
| `boxModel` | `CUA_TUTOR_BOX_MODEL` | `jev-1.14.0` (model for visual `Box` + tile/verify `Noul` calls) |
| `verifyBox` | `CUA_TUTOR_VERIFY_BOX` | `true` (3-`Noul` red-box self-verification after `Box` localization) |
| `minExactInNamed` | `CUA_TUTOR_MIN_EXACT` | `0.65` (Companion `Noul` threshold for direct named AX selection) |
| `minProbability` / `minMargin` | `CUA_TUTOR_MIN_PROBABILITY` / `CUA_TUTOR_MIN_MARGIN` | `0.7` / `0.1` (below either, no pointer) |
| `deadlineMs` | `CUA_TUTOR_DEADLINE_MS` | `20000` for the whole step; bounded cleanup may follow |
| `maxRequests` / `concurrency` | `CUA_TUTOR_MAX_REQUESTS` / `CUA_TUTOR_CONCURRENCY` | `12` / `3`; SDK automatic retries disabled |
| `driverBinary` | `CUA_DRIVER_BIN` | `~/.local/bin/cua-driver`, `/usr/local/bin/cua-driver`, else `cua-driver` on PATH |
| `driverSession` | `CUA_TUTOR_DRIVER_SESSION` | `cua-tutor` prefix; each session gets an isolated random suffix |
| `injectGuidance`, `declareMcp` | | `injectGuidance: true` (Tutor-only), `declareMcp: false` |

## Safety

- `src/driver.ts` only allows `list_apps`, `list_windows`, `get_window_state`, `start_session`,
  `set_agent_cursor_*`, `get_agent_cursor_state` and `move_cursor`; every call is recorded in
  `driver.history`. It refuses `move_cursor` with a `target`, `scope` or
  `delivery_mode`, so Cua moves only the agent-cursor overlay, never your real pointer.
- Jev can only answer with an ID from the table. The margin includes abstain/reobserve.
  Thresholds apply to top-option probability, not an end-to-end accuracy guarantee. The defaults
  reject the known .45 ambiguous suggestion; evaluate them on representative app tasks.
- Each OpenCode session owns its cursor. A new request clears its previous cue; cancellation,
  errors and unloading also clear it. Newer requests cancel older ones and wait for their cleanup.
  The tool never clears another session's cursor.
- After a move, the plugin reads the cursor state through its owning MCP connection and checks
  enabled state and target coordinates. A mismatch clears the cue and reports failure.
  This verifies the driver's registered target, not a screenshot of the rendered animation.
  A separate MCP transport cannot inspect that private session by reusing its public label;
  do not create another session with the label to try to verify it.
- Cancellation flows into inference and driver requests. In-flight driver connections are shared
  and closed on unload; unrelated provider credentials are not passed to the driver child.
- Tool diagnostics distinguish model calls from actual HTTP attempts and report usage only for
  responses that supplied it. Failed requests can still be billable; these are not invoice totals.

## Development

```sh
bun test                                                  # unit tests + end-to-end against a fake cua-driver MCP server
bun run typecheck                                         # tsc --noEmit
bun bin/tutor.ts --app FilmCraft "switch to the razor tool"
bun bin/tutor.ts --verify --app TextEdit "create a new document"   # + agent-cursor readback and driver calls
EVAL_OUT=/tmp/eval.png bun scripts/eval-snapshot.ts --app FilmCraft "lock track V1" "play the timeline"
                                                          # one snapshot, many steps, per-round Jev picks, marks drawn on the screenshot
```

SDK 0.7.0 has a delivery-dependent response-body issue under Bun 1.2.22 and 1.4.4:
some already-buffered responses fail with "Body already used" after the SDK acquires/releases a
reader. Delayed streamed responses and tested live calls can succeed. `bufferedFetch` avoids
acquiring the original reader; its buffering remains covered by timeout/cancellation. This is
an in-process adapter, not a Node subprocess. The SDK documents Node >=22; .7.0 remains pinned.

## Known gaps

- Visual `Box` localization is experimental (`TypeSafe-Danger-Zone-Images: true`). Abstract custom
  vector icons without accessible names can still be ambiguous without a `visualCue`; accessible
  names remain faster (~130 ms, 0 screenshots) and preferable when available.
- A tournament (only above 200 named controls) can discard the right candidate before the final
  choice. Excessively large tables fail the request budget.
- Freshness checks narrow the race with user interaction, but cannot make an OS overlay move
  atomic with an accessibility/screenshot read. Multi-monitor/occlusion behavior needs live validation.
- Menu items that only exist once a menu is open aren't visible; the tool points at the menu
  (e.g. TextEdit "create a new document" → File) and the agent highlights the next step after you open it.
