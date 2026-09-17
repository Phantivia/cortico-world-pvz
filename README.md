# cortico-world-pvz

Owner: `src/definition.ts`

`cortico-world-pvz` exposes the original PopCap Plants vs. Zombies as a semantic, event-driven World. The model can operate menus, choose seeds, play ordinary and special levels, and confirm progression without deriving state from pixels.

## Process boundary

The Core mounts `PvzWorldProxy` in the main process. The proxy stays idle until the operator starts the game from its console panel, then forks `engine-child.ts`. The 引擎子进程 owns the native named pipe, game launch, injection, 15 Hz observation, state differencing, semantic task queue, and receipt verification. The x86 implant reads coherent state and sends mouse messages only to the PvZ window.

Commands and captures require both the implant hello and the injector's resumed process identity. Requests made while either is pending fail without sending input or disconnecting the pipe.

The console panel owns both directions: `start` launches, `stop` shuts the 引擎子进程 down, closes the owned game, and releases the persistent lease. Automatic restarts cover exactly one failure — the 引擎子进程 died while the game is still alive — and re-attach through the lease without touching the game. If the owned process itself is gone, the module concludes the operator closed the game: it stops at `stopped`, recycles the lease, and never relaunches. Recovery attempts are capped (4 within a rolling 10 minutes) and the module reports when it gives up.

The main process receives events, deferred board summaries, console status, and requested PNG frames. It does not receive raw memory, hidden entities, or high-frequency coordinates.

The managed window is pinned to a Per-Monitor V2 client of exactly 800x600, wholly inside one monitor's visible bounds. Both facts ride on every snapshot as `presentation`. Repair runs inline on the window messages that can change geometry and, as the backstop, on every poll tick, so a repair that once failed does not leave the window clipped; it is suppressed while the window is minimized and while a person is dragging it. Drag suppression is held by the mouse button rather than by `WM_EXITSIZEMOVE` alone, so a move that never delivers that message cannot latch repair off for the rest of the session. Off that invariant the implant refuses screenshots and mouse messages — a window DC only reads pixels that are actually on screen — and the module refuses to queue work with the measured size in the receipt instead of letting each step fail without a reason.

The simulated cursor is game-local. The implant draws a Fitts-scaled asymmetric trajectory with smooth bounded motor noise, occasional endpoint correction, a pixel-perfect animated companion, and state-dependent click pacing into the PvZ frame. Remaining-route compression accelerates a backlog within a hard logical speed limit. It never moves, locks, or captures the Windows system cursor, so a user can continue using the physical mouse while queued work runs.

## Supported build

The first profile is deliberately specific:

- profile: `goty-apac-ja-chs-south_sniper`
- executable SHA-256: `9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed`
- PE32 x86, image base `0x400000`, image size `0x450000`, no relocation table
- FileVersion `1.2.0.1073`; bundled installer metadata calls the localized product `1.1.0.1056`
- CodeView source path identifies the PopCap GOTY APAC Japanese localized branch
- `gLawnApp` absolute address `0x7578F8`, established from the unique accessor and constructor stores in this executable
- `main.pak` SHA-256: `89971bafb5bee1d5de9012007b469c65e6147a1b12cf5058be3292ff8c6ba9b8`

The implant verifies the PE fingerprint and critical instruction bytes before enabling actions. A matching version-resource string is insufficient: common English 1.2.0.1073 builds use a different layout, and the widely published `module+0x329670` pointer does not address `gLawnApp` in this localized executable.

## Perception boundary

The disclosure boundary is enforced inside the implant, before JSON crosses the pipe.

- Dynamic objects beyond the rendered play area or behind the active fog mask are omitted.
- Fog levels use the rendered fog alpha grid and fog offset. Missing or inconsistent fog samples hide the entity.
- Invisighoul zombies are never disclosed from internal entity state.
- Vase contents appear only after the game's transparency state makes them visible.
- Entity health is reduced to sprite-readable condition bands.
- Every disclosed plant includes its cell, condition, and semantic phase. Arming plants such as Potato Mine expose the phase visible to a player.
- Every disclosed zombie includes its cell, condition, semantic phase, and speed band.
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

Waiting for a fact is not a queue step. `pvz_arm({when, steps, queue?, expiresInMs?})` arms a trigger: `when` is re-evaluated on every fresh snapshot and, the moment it is true, `steps` are submitted as an ordinary `pvz_do` queue (`queue` defaults to `now`); the trigger fires once. It reserves no card and blocks nothing; if the card is not ready when it fires, the submitted queue's own `when` decides. `expiresInMs` counts from arming and withdraws an unfired trigger. A trigger is bound to the board run it was armed on; a terminal screen or another run withdraws it. Every outcome — fired, expired, cancelled, invalidated — is a `pvz.trigger` event, and a fired trigger's queue reports through `pvz.task` like any other. Trigger and task ids share one sequence.

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

These conditions specify one finite action; plant choice, lane choice, and repetition remain model decisions.

On a conveyor board the seed bank refills from the belt: consuming one packet shifts the rest one place left. How many steps may ask for a given card is how many of that identity the belt holds right now, counted across everything the model has in flight: the remaining steps of every queued or parked task plus the steps carried by every armed trigger. Identity is type plus imitated plant; packets sharing it are interchangeable, so the step names the card without its `#N` ordinal and supplies its own target cell. A fired trigger reaches the executor without passing through `pvz_do`, so the budget is charged at arm time. Collection and shovelling do not touch cards and are never counted. The board kind is inferred from every card reporting a null cost, which is how the implant serializes a conveyor bank. A bowling throw changes neither screen nor special phase, so it is exempt from the rule that a phase-changing step ends its queue.

Planting also accepts `column:{aheadOf:"nearest_hostile",minGap:0..8}` instead of an integer column, and it is the default for anything whose usefulness depends on where the zombies are — single-use burst and trap plants, and blockers meant to stand in front of the lane. The native input worker selects the nearest disclosed living hostile in the chosen row when input starts, then retains that run and target identity. The cell is `floor((x-40)/80)+1-minGap` using the target's unrounded position, with smaller columns toward the house: the first term is the cell the game itself assigns the zombie — the one whose centre is nearest — so `minGap:0` is the cell the target stands in and `minGap:1` the cell in front of it. A result before the first column is clamped to column 1, the only cell still ahead of a target that has reached the house; a result past column 9 is refused instead, because the target has not walked onto the board yet. `minGap` is a lower bound: the landing cell is the first cell from there toward the house that takes the plant, because a target chewing on a plant stands on that plant's cell and "ahead of this target" still has exactly one nearest answer; when no cell ahead takes it, the attempt ends with that reason. It rechecks the landing at the actual input boundary and permits bounded cursor correction before pressing. Target loss, a changed row, unsupported motion, no usable cell, or a changed run ends the attempt with that reason, and never by retargeting, changing row, or adding a missing lily pad. A rejected relative step is local to that step, like a rejected absolute cell: the queue continues with the next step. Relative placement receipts name the cell actually committed and require the expected plant on it; card consumption alone is insufficient evidence.

Taking the shovel clicks a point measured off a real 800x600 board frame: the centroid of the grey pixels of the shovel icon. Whether that sign shifts with the seed bank width is untested, so a selection that never reaches the shovel cursor reports the point it clicked, the cursor it kept seeing, and the seed bank rect read from memory, which is enough to derive the relation from one attempt.

Each native step is validated against the latest coherent snapshot and accepted or rejected by the implant. An implant `executed` result carries the in-game consequence it observed — a consumed packet, a collected drop, a struck target — and that is the receipt. A later snapshot diff is preferred evidence when it arrives inside the budget; when it does not, the observed consequence stands rather than being downgraded. An abort that carries a reason is a definite failure — the implant knows why it stopped — so `unverified` is reserved for the deadline passing with no independent evidence, for an abort that names no reason at all, and for the few implant reasons that state the effect itself could not be established. Every implant reason string maps to one exact Chinese sentence in `native-reasons.ts`, which also carries that failed/unknown distinction; a reason with no mapping is reported verbatim and logged rather than dressed up as an explanation, and `tests/native-reasons.test.ts` extracts the literals from the native sources so a reworded reason fails the suite instead of silently falling back. A Whack batch carries exact requested, attempted, released, confirmed, stale, and scope-transition counts; target loss or a released click without a visible hit remains local to that repeatable skill. A transient `loading` sample waits for the bound run to become coherent again; a stable scope change or terminal screen ends the old queue.

`partial` and `yield` are local to an independent step, so later steps continue and the final task is reported as partial. State that moved between admission and the actual click — a card back on cooldown, sun spent by an earlier step, a menu action that has already advanced — is reported as `yield`, so the rest of the queue still runs. The reason given is the implant's own; the card and cell are re-read only when it supplies none, because by then the state that caused the rejection has usually recovered. A durable prerequisite failure is `blocked`, and an ambiguity whose input release or semantic extent is unknown is `unverified`; both stop the remaining task.

Conditional planting expresses future intent. `when:"ready"` waits for cooldown; `when:"ready_and_affordable"` also waits for sufficient sun. The semantic card is reserved while parked and appears in `pvz_observe`, `pvz_queue`, and receipts. Parked conditions do not occupy the native input channel, so other tasks and the module's own sun sweeps keep running.

Board tasks retain their admitted run identity. Leaving that board expires every queued step: a different run, a changed mode, or a menu screen. A terminal result on a board that is still standing expires only the steps that change the plant layout, because the drops it left behind are still there for collection. Parked steps stay parked during pause and retain their admitted card binding across preceding steps. A hostile crossing the chosen cell does not cancel the model's planting intent.

Collection is a multi-action skill. `until:"visible_clear"` re-scans after every verified batch and continues until the requested visible semantic category is clear, including objects that appeared during execution. `what` covers `coins`, `resources`, `award`, and `usable_seed`; sun belongs to none of them.

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

The user-selection dialog exposes each visible profile as `profile:<exact name>`. Use a `menu` step with that action to select its row, followed by `menu` action `confirm` to activate it. Selection is shown as pending confirmation; completion requires the dialog to close and the chosen profile to become active. Native input revalidates the current list, row identity, selection, and button before clicking. Compatibility clicks remain restricted to unknown screens without semantic menus or dialogs.

Restart and main-menu actions can open a confirmation dialog. That transition is verified separately; the next action confirms or cancels it. Shovel input follows the visible button layout for the current seed-bank size, including Slot Machine's separate position.

Receipts, events, and snapshots name rows and columns the way a person would — 第4排第8.6列 — and use plant and zombie display names rather than engine identifiers. The public surface accepts plant names, cells, and semantic selectors. Special steps use `at`, `to`, `card`, or `target:{kind,name?,at?}`. Whack-a-Zombie uses `targets:[{kind:"zombie",scope:"all_visible"}]`; each skill binds at most 32 then-visible zombies when it starts and freezes those identities for one finite batch. Native object identifiers, seed-bank slots, and target identifiers never cross the agent-facing mapping layer.

Each model response may submit one `pvz_do` skill queue. A special action, confirmed seed selection, award collection, interaction, or visual fallback is a decision barrier and must end that queue; its terminal receipt carries the fresh state used to plan the next queue. A usable seed packet may be paired only with one immediately following, queue-final `launch`.

## Events and progression

The 引擎子进程 projects lifecycle, screen, seed-picker, level start, visible progress, card readiness, close threats, mower use, victory, defeat, award, and committed profile progress. Victory and defeat come from a persistent, monotonic run result rather than inference from the current screen; award and defeat screens are supporting evidence for the same result. The game-enforced unique visible player name scopes profile commits and mode-record baselines, so changing users cannot be reported as progress.

Event urgency and snapshot freshness are independent. Lifecycle transitions, task outcomes, near threats, mower use, critical plant damage, and new special-action opportunities request `flush`. Ordinary battlefield changes use `debounce` and retain the global batch floor and ceiling. Ordinary currency appearances and regular card cooldown/affordability notifications use `piggyback`; they neither start nor extend a batch timer. Special-level resources and newly arrived conveyor cards retain their urgency. Routine duplicates remain archive-only. A sample containing an urgent event flushes after all its facts have been queued in order. A flush makes input ready for the next delivery boundary; operator pause and delivery gates still apply, and an active model request is not interrupted.

Explicit observation, task admission, each execution step, and deferred board rendering request a new native sample. The read command bypasses the input queue and returns only after its correlated result and a newer snapshot. Read failure never substitutes the cached board. Input receipts also require a post-result sample before an observed native effect can count as verified. Task admission and stopping are serialized; an interrupted step must pass the existing native release barrier before replacement input executes.

Whack target observations also request a fresh native sample at delivery; vanished targets evaporate, and a superseded renderer cannot clear the next ticket.

Deferred board observations carry the `snapshot` tag across IPC. Renderer tickets are consumed once and superseded tickets cannot read a later callback. At handoff the proxy synchronously arms a flush observation for the rebuilt session's first batch; rendering refreshes both board and queue. Task result text labels its queue as the state at receipt time. Module diagnostics record native acknowledgement, result, fresh sample, receipt, task admission, step start, and terminal timing without storing model text.

Board snapshots enumerate disclosed plants by cell and phase and disclosed zombies by cell, speed, and phase. Profile, unlock, and mode-record changes are retained during play and emitted only on the main menu, mode selector, or seed picker, keeping level context focused on actionable state.

Progress combines the current scene, mode, board-level meter, flag state, Challenge stage, award screen, adventure level/completion, and unlock bits. The level script's wave counter is internal and never crosses the disclosure boundary: what a player reads off the progress meter is how many flags have gone by, and that is what the snapshot carries. Survival repicks and same-run stage advances in Survival, Last Stand, Vasebreaker, and I Zombie are milestones rather than terminal victories. Adventure-profile commits are tracked separately.

For Adventure 1-1, 1-2, and 1-3, submit conditional planting as queued intent and append immediate responses as separate runnable tasks. This preserves the intended placement across cooldown and affordability changes without polling or competing clicks.

## Special-level contracts

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
- Vasebreaker never transmits opaque vase contents.
- Vase, roll, gem move, zombie placement, trophy purchase, onslaught transition, garden action, and cannon shot end their skill queue. Bowling and Zombiquarium purchases/feedings may share a finite queue; each step checks current targets and resources and verifies its result before the next step.
- Beghouled waits for the board to settle after a swap or twist before comparing the matrix and score.
- Twist targets contain four occupied cells within the eight-column puzzle. The target is the top-left cell of the clockwise 2×2 rotation.
- Whack-a-Zombie retains the ordinary collect, plant, and shovel surface. A queue that chooses Whack is a dedicated finite six-skill queue: each `all_visible` skill waits for one surfaced batch, freezes up to 32 identities when that skill starts, and issues one native batch; later zombies can only be selected by a later skill. A confirmed hit means the implant observed a body or armor effect, not that the target was defeated. Tactical cues and receipts include resources, cards, playable cells, plants, and the remaining visible targets with their body, armor, and shield condition bands. A support queue may interrupt for expiring sun, or one Whack append queue may be prefetched while the current queue runs; neither the 引擎子进程 nor implant creates additional skills.
- I Zombie places pseudo-seed zombie cards within the per-level boundary and tracks visible brains eaten.
- Last Stand exposes setup and onslaught on the same board run; Survival alone uses the inter-stage seed picker.
- Cob Cannon verifies source readiness, target selection, and the subsequent cooldown state.
- Seeing Stars publishes only its remaining painted cells as semantic objective observations. These cells are completed with a normal `plant` step using `starfruit`; they are never special-action targets.
- Portal Combat reports both pairs, including portals at the visible right boundary outside the planting grid. Portal relocation and visible zombies changing rows emit urgent events.

## Research basis

The implementation uses public source as behavioral documentation, not as a binary dependency:

- [PvZ-A11y](https://github.com/game-a11y/PvZ-A11y), MIT: supported-version notes, widget structures, and Windows input behavior
- [re-plants-vs-zombies](https://github.com/Patoke/re-plants-vs-zombies), CC0: class layouts, fog rendering semantics, level modes, and GOTY address annotations
- [Plants-vs.-Zombies-Online-Battle](https://github.com/Zhuagenborn/Plants-vs.-Zombies-Online-Battle), MIT: an independent example of x86 DLL injection and in-process hooks for a different game build

Addresses are accepted only after comparison with the locally installed executable. Sources targeting 1.0.0.1051 or the English GOTY build are never used as address fallbacks.
