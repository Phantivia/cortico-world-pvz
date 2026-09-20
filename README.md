# `src/definition.ts`: cortico-world-pvz

`cortico-world-pvz` exposes the original PopCap Plants vs. Zombies as a semantic, event-driven World. The model can operate menus, choose seeds, play ordinary and special levels, and confirm progression without deriving state from pixels.

## Relationship with Cortico

This is an extension package for [Cortico](https://github.com/Pal-AI-Lab/Cortico), declared through the extension contract:

```jsonc
"cortico": { "kind": "world", "api": 4, "consoleClient": "dist/console.js" }
```

At runtime it imports the framework as `cortico/<path under src>` (`cortico/world.ts`, `cortico/core/types.ts`, `cortico/paths.ts`); the module hook registered by the framework's `src/extensions/runtime.ts` resolves those specifiers to the framework's own sources, so the extension and the framework share one instance. The package must therefore be `"type": "module"`. The browser side (`src/console/**`) only `import type`s from `cortico/*`.

## Installation

Build the console panel first; `dist/` is not tracked and the console shows an empty PvZ page without it:

```bash
corepack pnpm install
corepack pnpm build
```

Then either install it from the console's extensions page with this directory's absolute path, or run `corepack pnpm add --ignore-workspace <absolute path>` inside `<Cortico>/extensions/`. Restart the whole Cortico process afterwards; World definitions are read at startup.

Windows only. The definition's `preflight` rejects activation on any other platform.

## The game

The game is not part of this package. The operator installs their own copy and points `worlds.pvz.executable` at `PlantsVsZombies.exe`; `main.pak` must sit next to it. Both files are hashed before every launch (`src/fingerprint.ts`) and only the build listed under "Supported build" passes. Adapting the bridge to another build is documented in [`src/native/ADAPTING.md`](src/native/ADAPTING.md).

## Native bridge

The injector and the implant are C++ sources under `src/native/`; nothing prebuilt is downloaded. The World compiles them on the operator's machine with Visual Studio Build Tools (x86 MSVC toolchain) the first time it starts, into `<deployment root>/runtimes/pvz/<source hash>/`, or into `worlds.pvz.nativeBuildDir` when that is set. A rebuild happens when any file under `src/native/` changes. The build directory holds `pvz-injector.exe`, `pvz-implant.dll` and an `artifacts.json` with both hashes; recovery attach refuses artifacts whose hashes no longer match. Details in [`src/native/README.md`](src/native/README.md).

Windows Smart App Control in enforcing mode may block an unsigned locally built injector; the framework's `docs/runtimes.md` describes how to check.

The managed pointer and its pixel companion live in [`cursor-companion/`](cursor-companion/README.md): JSON sources, a generator, and the generated header the implant includes.

## Configuration

`worlds.pvz` in the deployment's `config.json`; every key is also on the console's configuration page.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Mount the World |
| `executable` | `""` | Path to `PlantsVsZombies.exe`; surrounding double quotes are stripped |
| `nativeBuildDir` | `""` | Build output root; empty means `<deployment root>/runtimes/pvz/` |
| `closeOnStop` | `true` | Close a game the World launched when the World stops |
| `pollHz` | `15` | Snapshot rate, 10–20 |
| `cursorDurationMs` | `[80, 280]` | Bounds of one internal cursor leg |
| `actionTimeoutMs` | `5000` | Causal verification deadline after a terminal native result |
| `emitBoardDeltas` | `true` | Deliver board change events |
| `launch`, `attachPid` | `true`, `null` | Recovery attach only; not operator settings |

Ownership records (process id, creation time, owner token, artifact directory) are written under the deployment's data directory, `pvz/ownership/`, and are never logged.

## Console

One panel, `game`: start and stop, phase, process id and the last error detail. Starting compiles the bridge if needed, hashes the game, launches it suspended, injects, restores the 800 × 600 client and reports `running` once the implant's hello arrives.

## Development

`tsconfig.json` (`paths`) and `vitest.config.ts` (`resolve.alias`) point `cortico/*` at `../BOT/src/`, a framework checkout next to this directory; change both when it lives elsewhere.

```bash
corepack pnpm typecheck
corepack pnpm test       # Native fixtures need the x86 MSVC toolchain
corepack pnpm build      # esbuild → dist/console.js
```

Tests never start the game. The native fixtures compile `implant.cpp` against fake memory laid out at the profile's offsets; see [`src/native/ADAPTING.md`](src/native/ADAPTING.md) §4.

## Process boundary

The Core mounts `PvzWorldProxy` in the main process. The proxy stays idle until the operator starts the game from its console panel, then forks `engine-child.ts`. The 引擎子进程 owns the native named pipe, game launch, injection, 15 Hz observation, state differencing, semantic task queue, and receipt verification. The x86 implant reads coherent state and sends mouse messages only to the PvZ window.

Commands and captures require both the implant hello and the injector's resumed process identity. Requests made while either is pending fail without sending input or disconnecting the pipe.

The console panel owns both directions: `start` launches, `stop` shuts the 引擎子进程 down, closes the owned game, and releases the persistent lease. Automatic restarts cover exactly one failure — the 引擎子进程 died while the game is still alive — and re-attach through the lease without touching the game. If the owned process itself is gone, the module concludes the operator closed the game: it stops at `stopped`, recycles the lease, and never relaunches. Recovery attempts are capped (4 within a rolling 10 minutes) and the module reports when it gives up.

The main process receives events, deferred board summaries, console status, and requested PNG frames. Screenshot replies include the semantic state observed when capture returns, including current menu actions. They do not disclose raw memory, hidden entities, or high-frequency coordinates.

The managed window is pinned to a Per-Monitor V2 client of exactly 800x600, wholly inside one monitor's visible bounds. Both facts ride on every snapshot as `presentation`. Repair runs inline on the window messages that can change geometry and, as the backstop, on every poll tick, so a repair that once failed does not leave the window clipped; it is suppressed while the window is minimized and while a person is dragging it. Drag suppression is held by the mouse button rather than by `WM_EXITSIZEMOVE` alone, so a move that never delivers that message cannot latch repair off for the rest of the session. Off that invariant the implant refuses screenshots and mouse messages — a window DC only reads pixels that are actually on screen — and the module refuses to queue work with the measured size in the receipt instead of letting each step fail without a reason.

The simulated cursor is game-local. The implant draws a Fitts-scaled asymmetric trajectory with smooth bounded motor noise, occasional endpoint correction, a pixel-perfect animated companion, and state-dependent click pacing into the PvZ frame. Remaining-route compression accelerates a backlog within a hard logical speed limit. It never moves, locks, or captures the Windows system cursor, so a user can continue using the physical mouse while queued work runs.

## Supported build

The first profile is deliberately specific; what establishes each value and how to produce a profile for another build is in [`src/native/ADAPTING.md`](src/native/ADAPTING.md).

- profile: `goty-apac-ja-chs-south_sniper`
- executable SHA-256: `9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed`
- PE32 x86, image base `0x400000`, image size `0x450000`, no relocation table
- FileVersion `1.2.0.1073`; bundled installer metadata calls the localized product `1.1.0.1056`
- CodeView source path identifies the PopCap GOTY APAC Japanese localized branch
- `gLawnApp` absolute address `0x7578F8`, established from the unique accessor and constructor stores in this executable
- `main.pak` SHA-256: `89971bafb5bee1d5de9012007b469c65e6147a1b12cf5058be3292ff8c6ba9b8`

The implant verifies the PE fingerprint and critical instruction bytes before enabling actions. A matching version-resource string is insufficient: common English 1.2.0.1073 builds use a different layout, and the widely published `module+0x329670` pointer does not address `gLawnApp` in this localized executable.

## Perception boundary

Dialog buttons use the same callable action names as the menu list, including a repeated
`restart` or `main_menu` when a confirmation dialog offers that action.

The disclosure boundary is enforced inside the implant, before JSON crosses the pipe.

Visible mowers distinguish ready, triggered and squished states. A squished mower has no defensive effect; its loss and nearby enemies request urgent delivery. A ready mower disappearing between observations is reported as unavailable without claiming it cleared the lane.

- Dynamic objects beyond the rendered play area or behind the active fog mask are omitted.
- Fog levels use the rendered fog alpha grid and fog offset. Missing or inconsistent fog samples hide the entity.
- Invisighoul zombies are never disclosed from internal entity state.
- Vase contents appear only after the game's transparency state makes them visible.
- Entity health is reduced to sprite-readable condition bands.
- Every disclosed plant includes its cell, condition, and semantic phase. Arming plants such as Potato Mine expose the phase visible to a player.
- Every disclosed zombie includes its cell, condition, semantic phase, chewing state, and speed band. Chewing is independent of the phase; a walking phase with an active chewing animation renders as eating.
- Card cooldown seconds and percentages report the remaining recharge interval, computed from the total duration minus elapsed recharge ticks.
- The seed-picker may expose the preview roster because the game shows it to the player; the same pre-spawned entities are omitted after play begins.

`pvz_glance` is mounted only when the active model provider accepts images. Its frame is for compatibility diagnosis and does not loosen the semantic filter.

## Task execution

`pvz_do` accepts ordered semantic steps and returns as soon as the task is queued. One native input runs at a time. A later `pvz.task` event reports the terminal state: `done`, `partial`, `blocked`, `unverified`, or `cancelled`.

The queue modes are:

- `replace`: the default; drops waiting and conditionally parked work while allowing the entire running task to reach its terminal result
- `append`: adds the task at the tail
- `now`: interrupts the running task, verifies release of held cards, tools, and the internal cursor, then inserts the task at the head while preserving previously queued work

An accepted `pvz_do` receipt contains the acceptance line and queue status. The triggering wake already delivered a world snapshot (`pvz.board.snapshot` is rendered at dispatch time), and a second queue cannot be submitted in the same turn, so the receipt omits the snapshot. Task completion arrives separately as a `pvz.task` event.

`renderPvzQueue` renders the queue for acceptance receipts, `pvz.task` events, and delivered observations. It omits the label of a task already described step by step in the surrounding text. Card reservations are listed after the queue; armed triggers follow as `待触发`.

A plant step with `when:"ready"` or `when:"ready_and_affordable"` parks the task at that step until its reserved card is ready; steps after it wait. Sun keeps arriving while a task is parked because the module collects it on its own lane.

PvZ queues primarily hold short actions and pending intent. Acceptance receipts and delivery-time observations expose the current step, parked steps, remaining steps, reserved cards, and armed triggers. A receipt also carries 落点现状: for each absolute planting step, what already stands on that cell, or that the cell still wants a carrier the queue never places. It states the cell and withdraws nothing. The same reading is appended to a rejection when the implant only says the cell will not take the plant. `pvz_do({cancel:[taskId],queue:"append",steps:[...]})` withdraws selected old intent and submits its replacement in one call. Parsing and admission complete before cancellation; an invalid replacement leaves the old tasks intact. Cancellation of a finished ID is a no-op. Running input must cross the existing release and execution-exit barrier before new input starts. `pvz_stop({taskId})` withdraws one task without submitting a replacement, `pvz_stop({triggerId})` disarms one trigger; omitting both stops everything, triggers included.

`pvz_arm({when, steps, queue?, expiresInMs?, maxFirings?, waitForCards?})` submits the chosen queue when its condition becomes true (`queue` defaults to `now`). It fires once by default; `maxFirings:1..16` permits a bounded number of submissions. After each submission the condition must be observed false before a later true observation can fire again; unknown observations do not reset this latch. A failed action still uses one firing. Triggers do not block the executor or bind packet slots. Default conveyor admission counts all remaining firings against current card quantities. `expiresInMs` counts from arming and withdraws remaining firings. A trigger is bound to its board run; a terminal screen or another run withdraws it. Every outcome — fired, expired, cancelled, invalidated — is a `pvz.trigger` event, and each submitted queue reports through `pvz.task`. Trigger and task ids share one sequence.

`waitForCards:true` accepts immediate planting steps on a conveyor board and reserves no inventory while waiting. A true condition remains eligible until enough ready packets exist after subtracting queued work and default trigger reservations. Only submission consumes a firing; missing packets do not consume one or latch the condition. Later packets can satisfy the request, including after an empty seed bank. Waiting triggers are checked in arming order, and each submitted queue enters the budget before the next trigger is checked. Execution still checks the selected cells and reports failure normally. A successful or failed submission retains the same false-to-true requirement for its next firing.

Conditions contain four observed predicates: `sun:{min?,max?}`, `card:{plant,ready?,affordable?}`, `cell:{row,column,layer,empty}`, and `zombie:{row,minColumn?,maxColumn?,minCount?}`. Compose them with `all`, `any`, and `not`; empty compositions are invalid. `layer` distinguishes `main`, `base`, and `pumpkin`, so an empty main layer can still have a lily pad. Hidden or unavailable facts remain unknown under negation; only true fires.

The zombie predicate counts visible living hostiles inside its inclusive interval and is true once the count reaches `minCount`, defaulting to one. `row` also accepts an array of rows, whose matches are summed rather than tested separately, which is what an area one-shot is waiting for: a Cherry Bomb covers three rows, a Doom-shroom more, and `any` of several single-row predicates can only ask whether each row is non-empty. Fog, darkness, and Invisighoul keep an unreached count unknown, so a threshold never becomes false on the strength of a hidden interval.

Staleness is the reason these primitives exist: the interval between the module delivering a board snapshot and the resulting `pvz_do` reaching the tool layer is measured per run (`ENV_PROMPT.md` quotes the current figure), and an ordinary zombie keeps walking through it. A trigger moves the decision to the moment the fact holds, and a relative column moves the coordinate to the moment of input. Triggers used to be a per-step `startWhen`; that parked the whole queue behind the waiting step, so the model pushed every conditional step to the tail and cancelled it before it ever fired.

| Game situation | Intent |
| --- | --- |
| A Cherry Bomb is ready, but the approaching group is still too far right. | Arm on `all` of the chosen row's zombie interval, card readiness and affordability; fire with `column:{aheadOf:"nearest_hostile",minGap:0}`. |
| A Cherry Bomb should wait until the wave clumps rather than burn on the first arrival. | Arm on `zombie:{row:[2,3,4],minColumn,maxColumn,minCount:4}` over the rows its blast covers. |
| A blocker on a lily pad is about to disappear. | Arm on that cell's `main` layer becoming empty, then replace the blocker; the `base` layer remains distinct. |
| A committed build can proceed after either lane clears. | Arm on `any` of two negated zombie predicates. Fog that hides either lane remains unknown. |
| An emergency placement has waited beyond its useful window. | Give the trigger `expiresInMs`; expiry withdraws it. |
| A different lane now needs the reserved card. | Submit the old task ID in `cancel` alongside the new steps with `queue:"append"`; admission can reuse the released card without disturbing other intent. |

Zombie predicates optionally filter `immobilized:true` or `false` before counting matches. `hasUsableMower` tests each enemy's own row for a ready or triggered mower; squished mowers are unusable, and an absent mower stays unknown when the home-side cell is hidden. Combining unfrozen enemies in exposed lanes with boss and projectile predicates lets one bounded trigger cover the model's chosen situations. Immobilization describes the observed state, not susceptibility to freezing: ice machines and bouncing pogo zombies can keep this branch true after an Ice-shroom. The predicate must actually become false before another firing; separate triggers can keep unrelated conditions independent.

These conditions specify one finite action; plant choice, lane choice, and repetition remain model decisions.

On a conveyor board the seed bank refills from the belt: consuming one packet shifts the rest one place left. Card quantities include the remaining steps of queued or parked tasks and default armed triggers. Immediate planting steps beyond that quantity are marked skipped at admission; other steps execute in order, and skipped steps never consume later arrivals. Missing cards during immediate execution also skip only that step. Conditional planting, bowling and default trigger admission reject excess demand; a queue mixing immediate and conditional requests for the same overdrawn identity is rejected as a whole. Identity is type plus imitated plant; packets sharing it are interchangeable, so the step names the card without its `#N` ordinal and supplies its own target cell. Conditional planting reserves this quantity and resolves the current slot before each step. A fired trigger reaches the executor without passing through `pvz_do`; default triggers charge the budget at arming, while `waitForCards` checks ready inventory immediately before submission. Collection and shovelling do not touch cards and are never counted. The board kind is inferred from every card reporting a null cost, which is how the implant serializes a conveyor bank. A bowling throw changes neither screen nor special phase, so it is exempt from the rule that a phase-changing step ends its queue.

Conveyor observations, screenshots, handoffs and queue status report the remaining budget per plant identity. The available count subtracts pending steps and every remaining default trigger firing from the current inventory. Waiting triggers are labelled separately and use inventory only after submission. Card readiness is shown separately; it does not release an existing reservation.

Absolute conveyor planting has a one-retry fallback for transient packet selection failures. This includes a native timeout before the expected packet reaches the cursor: that path has not clicked the planting cell. The retry uses a newer snapshot and resolves the same plant identity again within the same board run. A failure after cell input does not use this fallback.

`column:{emptyPot:"nearest_house"}` chooses the lowest-column visible empty flower pot in the model's selected row from the fresh snapshot before each step. Setting `row:{emptyPot:"nearest_house"}` as well extends the scope to every row, choosing the lowest column and then the lowest row. It skips destroyed, occupied, hidden and unusable pots; if none remain, only that step is skipped. It never adds a pot or leaves the selected scope. Native input verifies the selected cell, and the receipt names the committed destination. The boss empty-pot list uses the same selection facts.

`row:{bossProjectile:"iceball"}` or `row:{bossProjectile:"fireball"}` resolves the selected visible projectile's current row before the step. A missing, hidden or differently typed projectile skips the step. Combined with the empty-pot column selector, this lets a model arm same-row planting before the boss reveals a projectile's destination.

Planting also accepts `column:{aheadOf:"nearest_hostile",minGap:0..8}` instead of an integer column, and it is the default for anything whose usefulness depends on where the zombies are — single-use burst and trap plants, and blockers meant to stand in front of the lane. The native input worker selects the nearest disclosed living hostile in the chosen row when input starts, then retains that run and target identity. The cell is `floor((x-40)/80)+1-minGap` using the target's unrounded position, with smaller columns toward the house: the first term is the cell the game itself assigns the zombie — the one whose centre is nearest — so `minGap:0` is the cell the target stands in and `minGap:1` the cell in front of it. A result before the first column is clamped to column 1, the only cell still ahead of a target that has reached the house; a result past column 9 is refused instead, because the target has not walked onto the board yet. `minGap` is a lower bound: the landing cell is the first cell from there toward the house that takes the plant, because a target chewing on a plant stands on that plant's cell and "ahead of this target" still has exactly one nearest answer; when no cell ahead takes it, the attempt ends with that reason. It rechecks the landing at the actual input boundary and permits bounded cursor correction before pressing. Target loss, a changed row, unsupported motion, no usable cell, or a changed run ends the attempt with that reason, and never by retargeting, changing row, or adding a missing lily pad. A rejected relative step is local to that step, like a rejected absolute cell: the queue continues with the next step. Relative placement receipts name the cell actually committed and require the expected plant on it; card consumption alone is insufficient evidence.

Taking the shovel clicks a point measured off a real 800x600 board frame: the centroid of the grey pixels of the shovel icon. Whether that sign shifts with the seed bank width is untested, so a selection that never reaches the shovel cursor reports the point it clicked, the cursor it kept seeing, and the seed bank rect read from memory, which is enough to derive the relation from one attempt.

Outside the shovel tutorial, a native rejection that the selected cell has no visible plant skips that shovel step and preserves subsequent repairs. Other shovel failures retain their blocked or unverified result.

Each native step is validated against the latest coherent snapshot and accepted or rejected by the implant. An implant `executed` result carries the in-game consequence it observed — a consumed packet, a collected drop, a struck target — and that is the receipt. A later snapshot diff is preferred evidence when it arrives inside the budget; when it does not, the observed consequence stands rather than being downgraded. An abort that carries a reason is a definite failure — the implant knows why it stopped — so `unverified` is reserved for the deadline passing with no independent evidence, for an abort that names no reason at all, and for the few implant reasons that state the effect itself could not be established. Every implant reason string maps to one exact Chinese sentence in `native-reasons.ts`, which also carries that failed/unknown distinction; a reason with no mapping is reported verbatim and logged rather than dressed up as an explanation, and `tests/native-reasons.test.ts` extracts the literals from the native sources so a reworded reason fails the suite instead of silently falling back. A Whack batch carries exact requested, attempted, released, confirmed, stale, and scope-transition counts; target loss or a released click without a visible hit remains local to that repeatable skill. A transient `loading` sample waits for the bound run to become coherent again; a stable scope change or terminal screen ends the old queue.

`partial` and `yield` are local to an independent step, so later steps continue and the final task is reported as partial. State that moved between admission and the actual click — a card back on cooldown, sun spent by an earlier step, a menu action that has already advanced — is reported as `yield`, so the rest of the queue still runs. The reason given is the implant's own; the card and cell are re-read only when it supplies none, because by then the state that caused the rejection has usually recovered. A durable prerequisite failure is `blocked`, and an ambiguity whose input release or semantic extent is unknown is `unverified`; both stop the remaining task.

Conditional planting expresses future intent. `when:"ready"` waits for cooldown; `when:"ready_and_affordable"` also waits for sufficient sun. The semantic card is reserved while parked and appears in `pvz_observe`, `pvz_queue`, and receipts. Parked conditions do not occupy the native input channel, so other tasks and the module's own sun sweeps keep running.

Board tasks retain their admitted run identity. Leaving that board expires every queued step: a different run, a changed mode, or a menu screen. A terminal result on a board that is still standing expires only the steps that change the plant layout, because the drops it left behind are still there for collection. Parked steps stay parked during pause and retain their admitted card binding across preceding steps. A hostile crossing the chosen cell does not cancel the model's planting intent.

Collection is a multi-action skill. `until:"visible_clear"` re-scans after every verified batch and continues until the requested visible semantic category is clear, including objects that appeared during execution. `what` covers `coins`, `resources`, `award`, and `usable_seed`; sun belongs to none of them. Visible usable seed packets include the plant's display name and mechanics, including backward fire toward lower columns, arming delay, hypnosis on being eaten, and non-attacking support effects. Pole-vaulting zombies distinguish carrying a usable pole, an active vault, and walking after losing the pole.

## Sun

The module collects sun automatically. `collect` rejects `what:"sun"`, `resources` excludes sun, sun appearances are not published as events, and sweeps produce no receipt.

A sweep is armed from any snapshot that shows sun on a sweepable board, not from the snapshot diff: a sweep that was replaced, preempted, or refused leaves its sun on the board, and arming on arrival alone left that sun for the next drop to pick up — a wait its lifetime does not survive. One sweep is outstanding at a time and issues one native batch for the sun visible when it starts. A verified sweep re-arms immediately if sun remains; a sweep that collected nothing holds off for 400 ms doubled per consecutive failure up to 6 s, so one uncollectable drop cannot take the cursor over and over.

The sweep is an ordinary executor task in the module's own lane: ahead of waiting model tasks because drops expire and queued planting intent does not, behind whatever is already executing, and preemptable by the model's `queue:"now"`. It is invisible in `pvz_queue` and its terminal state never reaches the model.

Between the steps of a model task the module collects sun inline, before every step but the first. A queue can run for half a minute, and an internal task never preempts one that is executing, so sun that lands mid-queue would otherwise expire before the queue ends. The first step is left alone because it carries the decision the model just made.

The internal cursor is exclusive, so a sweep is armed only on a live, unpaused board whose run has not settled and whose cursor is normal or Whack-a-Zombie's hammer. Special actions and sun collection share the executor; offering a special action does not disable collection. A held seed packet and a paused board keep collection pending. The same check runs when a queued sweep starts and on later snapshots, so collection resumes after the cursor is released. Three consecutive collection failures other than vanished drops publish one `pvz.sun.stuck` event.

## Tools

- `pvz_observe`: semantic screen, board map, cards, resources, progression, queued tasks, and reserved cards
- `pvz_do`: queue ordered menu, profile, seed-selection, planting, shoveling, collection, special-level, interaction, or compatibility-click steps
- `pvz_queue`: inspect running, waiting, and parked tasks, armed triggers, and the most recent terminal result
- `pvz_arm`: arm a trigger — a condition and the queue to submit the moment it holds
- `pvz_stop`: withdraw one task or trigger, or clear everything and release all game-local held input

- `pvz_glance`: capture a PNG frame for compatibility diagnosis; available only to image-capable models

Whack prefetch cues leave support, menu transitions, and stopping available. Clearing all tasks also closes the prefetch window; continuing requires another finite queue from the model.

The user-selection dialog exposes each visible profile as `profile:<exact name>`. Use a `menu` step with that action to select its row, followed by `menu` action `confirm` to activate it. Selection is shown as pending confirmation; completion requires the dialog to close and the chosen profile to become active. Native input revalidates the current list, row identity, selection, and button before clicking. Compatibility clicks remain restricted to unknown screens without semantic menus or dialogs.

Restart and main-menu actions can open a confirmation dialog. That transition is verified separately; the next action confirms or cancels it. Shovel input follows the visible button layout for the current seed-bank size, including Slot Machine's separate position.

Receipts, events, and snapshots name rows and columns the way a person would — 第4排第8.6列 — and use plant and zombie display names rather than engine identifiers. The public surface accepts plant names, cells, and semantic selectors. Special steps use `at`, `to`, `card`, or `target:{kind,name?,at?}`. Whack-a-Zombie uses `targets:[{kind:"zombie",scope:"all_visible"}]`; each skill binds at most 32 then-visible zombies when it starts and freezes those identities for one finite batch. Native object identifiers, seed-bank slots, and target identifiers never cross the agent-facing mapping layer.

Each model response may submit one `pvz_do` skill queue. Special actions other than `launch`, `break_vase`, `bowling`, `buy_snorkel`, and `drop_brain` must end that queue, as must confirmed seed selection, award collection, interaction, and visual fallback. Their terminal receipt carries the fresh state used to plan the next queue. A usable seed pickup must end the queue or be followed immediately by `launch`. Multiple pickup/placement pairs can run in one queue; each placement is verified before the next pickup, and a failed placement stops the queue. Consecutive vase breaks target only the cells the model names, verify each break, and stop on a missing or rejected target; the model chooses how many unknown contents to release together.

`launch` accepts an exact `at:{row,column}` or `placement:{row,edge:"nearest_house"|"farthest_house"}`. The placement selector uses the held packet's current legal targets in the chosen row. It does not change rows when none are available; the receipt names the actual cell. A held usable packet retains its mechanics in observations until placed or cancelled.

`placement:{row,aheadOf:"nearest_hostile",minGap:0..8}` selects from the visible snapshot immediately before dispatch. It starts at the nearest living hostile zombie's reported grid column minus `minGap`, clamped to column 1, then scans houseward for a legal packet target. Hypnotized and visibly dying zombies are excluded. Missing visible hostiles or legal cells stop the step; the selector does not switch rows. The plant and row remain the model's choices.

A model can queue one vase break followed by `collect what:"usable_seed"` to hold a revealed packet before deciding where to place it. Vasebreaker packets expire about 15 seconds after landing; holding one preserves it during the next response. The collection step does nothing when no packet is present.

The environment instructions describe vase risk by the current firing direction: a backward shooter covers vases on its left, and a Threepeater covers its own and adjacent lanes toward higher columns.

Wall-nut and ground-spike packet descriptions include their adjacent-cell interaction: a nut on the houseward side can hold a chewing zombie over spikes in the cell to its right. The model chooses the row, placement and vase order.

Vasebreaker start and restart events ask the model to plan plant allocation and vase order before releasing enemies. The cue is absent from ordinary snapshots.

Packet observations also identify Threepeater lane coverage and the contact-only, non-blocking damage of Spikeweed and Spikerock.

## Events and progression

The 引擎子进程 projects lifecycle, screen, seed-picker, level start, visible progress, card readiness, close threats, mower use or loss, victory, defeat, award, and committed profile progress. Victory and defeat come from a persistent, monotonic run result rather than inference from the current screen; award and defeat screens are supporting evidence for the same result. The game-enforced unique visible player name scopes profile commits and mode-record baselines, so changing users cannot be reported as progress.

Event urgency and snapshot freshness are independent. Lifecycle transitions, task outcomes, near threats, mower use or loss, critical plant damage, and new special-action opportunities request `flush`. Ordinary battlefield changes use `debounce` and retain the global batch floor and ceiling. Ordinary currency appearances and regular card cooldown/affordability notifications use `piggyback`; they neither start nor extend a batch timer. Special-level resources and newly arrived conveyor cards retain their urgency. Routine duplicates remain archive-only. A sample containing an urgent event flushes after all its facts have been queued in order. A flush makes input ready for the next delivery boundary; operator pause and delivery gates still apply, and an active model request is not interrupted.

Explicit observation, task admission, each execution step, and deferred board rendering request a new native sample. The read command bypasses the input queue and returns only after its correlated result and a newer snapshot. Read failure never substitutes the cached board. Input receipts also require a post-result sample before an observed native effect can count as verified. Task admission and stopping are serialized; an interrupted step must pass the existing native release barrier before replacement input executes.

Whack target observations also request a fresh native sample at delivery; vanished targets evaporate, and a superseded renderer cannot clear the next ticket.

Deferred board observations carry the `snapshot` tag across IPC. Renderer tickets are consumed once and superseded tickets cannot read a later callback. At handoff the proxy synchronously arms a flush observation for the rebuilt session's first batch; rendering refreshes both board and queue. Task result text labels its queue as the state at receipt time. Module diagnostics record native acknowledgement, result, fresh sample, receipt, task admission, step start, and terminal timing without storing model text.

Board snapshots enumerate disclosed plants by cell and phase and disclosed zombies by cell, speed, and phase. Profile, unlock, and mode-record changes are retained during play and emitted only on the main menu, mode selector, or seed picker, keeping level context focused on actionable state.

Progress combines the current scene, mode, board-level meter, flag state, Challenge stage, award screen, adventure level/completion, and unlock bits. The level script's wave counter is internal and never crosses the disclosure boundary: what a player reads off the progress meter is how many flags have gone by, and that is what the snapshot carries. Survival repicks and same-run stage advances in Survival, Last Stand, Vasebreaker, and I Zombie are milestones rather than terminal victories. Adventure-profile commits are tracked separately.

For Adventure 1-1, 1-2, and 1-3, submit conditional planting as queued intent and append immediate responses as separate runnable tasks. This preserves the intended placement across cooldown and affordability changes without polling or competing clicks.

## Special-level contracts

Zomboss phases and visible ice/fire balls have semantic state and change events. A
`bossProjectile: { kind: "fireball" | "iceball", row?: number }` condition can arm a single
response to an already visible ball. Omit `row` to match any lane. The model chooses the plant
and its empty flower pot; the condition neither selects a tactic nor reveals a future attack.

`boss: { vulnerable?, immobilized? }` matches the visible head state. Vulnerability is true
during aiming, spitting, and recovery; at least one boolean is required. Missing boss observation
support or hidden entities remain unknown, including under negation. Freeze and thaw emit urgent
events. Boss observations list currently empty flower pots; conveyor cards are grouped by identity
with total and usable counts. The environment prompt describes head damage, freeze/thaw, and ball
interactions so the model can choose and arm finite actions.

- Seed selection and removal settle only after the packet's travel animation ends, so replacement can immediately reselect a removed packet.
- Resuming a saved minigame is verified when its menu advances to the same mode's active board, including menus that have no board snapshot yet.
- Board identity remains valid while its frame counter advances during observation. A changed scene, mode, board pointer, level, or counter rollback still invalidates the read.
- Invisighoul reports invisible zombie counts and positions as unknown. Its night pool background is separate from a rendered fog mask.
- Zombiquarium reports the green hunger tint and recovery as events and text state. Swimming across the aquarium does not emit approaching-house threats.
- Wall-nut Bowling uses conveyor packets and lane launch coordinates; it does not pretend a nut was planted on a grid cell.
- Slot Machine waits for the roll state to leave its settled value and return before verification. Reel symbols are omitted from plantable cards; usable seeds are collected from the resulting drops.
- Raining Seeds interacts with the visible usable-packet coin at its real position.
- Collectibles drawn above fog remain in observations and can be collected; fog still hides entities drawn beneath it.
- Slot Machine, Raining Seeds, and Vasebreaker pick up one usable packet at a time, place the held packet, then collect another.
- Text and compact snapshots name the current minigame and held object. Usable-seed pickup and release emit cursor changes; legal placement cells remain in the special targets, so placement does not require interpreting an image.
- `pvz_arm` can use `collectible: { kind: "usable_seed" }` to queue one pickup when a visible packet appears. The trigger fires once; the held packet remains available for a later `launch` decision. Collectible conditions also support `minCount` and preserve unknown visibility under darkness or fog.
- Seed pickup and collectible conditions accept `plant` to select a particular plant's packet. A missing match leaves other packet types untouched; omitting `plant` keeps the any-packet behavior.
- Vasebreaker publishes drawn plant/zombie markings separately from contents. Opaque unmarked vases remain unknown, even when they contain a plant. Text and compact observations include contents only while the game makes them transparent; `pvz.vase.changed` reports changes to this visible information.
- Silver and gold sunflower trophies retain their names in observations and collection events. Awards appearing after victory still emit an urgent collection event. `collect what:"award"` claims them and advances to settlement.
- Vase, roll, gem move, zombie placement, trophy purchase, onslaught transition, garden action, and cannon shot end their skill queue. Bowling and Zombiquarium purchases/feedings may share a finite queue; each step checks current targets and resources and verifies its result before the next step.
- Beghouled waits for the board to settle after a swap or twist before comparing the matrix and score.
- Twist targets contain four occupied cells within the eight-column puzzle. The target is the top-left cell of the clockwise 2×2 rotation.
- Whack-a-Zombie retains the ordinary collect, plant, and shovel surface. A queue that chooses Whack is a dedicated finite six-skill queue: each `all_visible` skill waits for one surfaced batch, freezes up to 32 identities when that skill starts, and issues one native batch; later zombies can only be selected by a later skill. A confirmed hit means the implant observed a body or armor effect, not that the target was defeated. Tactical cues and receipts include resources, cards, playable cells, plants, and the remaining visible targets with their body, armor, and shield condition bands. A support queue may interrupt for expiring sun, or one Whack append queue may be prefetched while the current queue runs; neither the 引擎子进程 nor implant creates additional skills.
- I Zombie places pseudo-seed zombie cards within the per-level boundary and tracks visible brains eaten.
- Last Stand exposes setup and onslaught on the same board run; Survival alone uses the inter-stage seed picker.
- Cob Cannon verifies source readiness, target selection, and the subsequent cooldown state.
- Seeing Stars publishes only its remaining painted cells as semantic objective observations. These cells are completed with a normal `plant` step using `starfruit`; they are never special-action targets.
- Portal Combat reports both pairs, including portals at the visible right boundary outside the planting grid. Portal relocation and visible zombies changing rows emit urgent events.
- Visible ice trails mark blocked cells and prevent planting there. Trail growth and removal emit row-specific terrain events; hidden cells retain their existing visibility rules.

## Research basis

The implementation uses public source as behavioral documentation, not as a binary dependency:

- [PvZ-A11y](https://github.com/game-a11y/PvZ-A11y), MIT: supported-version notes, widget structures, and Windows input behavior
- [re-plants-vs-zombies](https://github.com/Patoke/re-plants-vs-zombies), CC0: class layouts, fog rendering semantics, level modes, and GOTY address annotations
- [Plants-vs.-Zombies-Online-Battle](https://github.com/Zhuagenborn/Plants-vs.-Zombies-Online-Battle), MIT: an independent example of x86 DLL injection and in-process hooks for a different game build

Addresses are accepted only after comparison with the locally installed executable. Sources targeting 1.0.0.1051 or the English GOTY build are never used as address fallbacks.

## License

MIT, see [LICENSE](LICENSE). Third-party notices, including the game itself, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
