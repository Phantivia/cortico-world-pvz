# `src/native/implant.cpp`, `injector.cpp`: native bridge

Collectibles are ordered from the front drawing layer to the back, with later array slots
winning equal-layer hit tests. Each click uses a current point outside higher collectibles'
hit rectangles; a fully covered target receives no input until exposed.

This directory builds the 32-bit Windows injector and in-process observation bridge used by
`cortico-world-pvz`. The DLL communicates through newline-delimited JSON over the named pipe supplied by
`CORTICO_PVZ_PIPE` or `--pipe`. A launch-specific owner token binds later pipe recovery to the
same game process.

## Supported executable

Actions are enabled only for this exact executable:

- profile: `goty-apac-ja-chs-south_sniper`
- product version: `1.2.0.1073`
- SHA-256: `9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed`
- PE family: APAC JA GOTY, preferred base `0x00400000`, relocations stripped
- `gLawnApp`: `0x007578F8`

The injector verifies the target file hash, in-memory PE identity, and critical LawnApp accessors
before loading the DLL. The DLL repeats those checks and validates both live LawnApp vtable
pointers before accepting game input. Unknown executables are rejected before injection.

## Build

Use a Visual Studio Build Tools installation containing the x86 MSVC toolchain:

```bat
src\worlds\pvz\native\build.cmd C:\path\to\output
```

The command uses the static multithreaded runtime (`/MT`) and produces:

- `pvz-injector.exe`
- `pvz-implant.dll`

## Launch and attach

The Node bridge uses these forms:

```bat
pvz-injector.exe --dll pvz-implant.dll --pipe \\.\pipe\cortico-pvz-ID ^
  --poll-hz 15 --cursor-min-ms 80 --cursor-max-ms 280 ^
  --ownership-file C:\private\pvz-ownership.json --exe PlantsVsZombies.exe

pvz-injector.exe --dll pvz-implant.dll --pipe \\.\pipe\cortico-pvz-ID ^
  --poll-hz 15 --cursor-min-ms 80 --cursor-max-ms 280 ^
  --owner-token 0123456789abcdef0123456789abcdef ^
  --ownership-file C:\private\pvz-ownership.json ^
  --creation-time 01daff0011223344 --pid 1234

pvz-injector.exe --dll pvz-implant.dll --pipe \\.\pipe\cortico-pvz-ID ^
  --poll-hz 15 --cursor-min-ms 80 --cursor-max-ms 280 ^
  --owner-token 0123456789abcdef0123456789abcdef ^
  --ownership-file C:\private\pvz-ownership.json ^
  --creation-time 01daff0011223344 --resume-thread 5678 --pid 1234
```

Launch mode creates the game suspended, temporarily gates the pinned executable entry point, and
lets the Windows loader finish before resolving remote system exports. The gated primary thread
establishes its own Per-Monitor V2 context and reports success before the injector loads or
configures the DLL. The primary thread remains at the gate while focus-loss muting and the
focus-loss automatic pause are disabled, the original entry bytes are restored, and the gate is
released; no original game entry-point instruction or window creation runs before this sequence
completes. These
changes alter two version-locked focus-policy code sites before LawnApp exists. Configured music and
sound-effect volumes and explicit pause controls remain independent. This policy covers a restored
window that loses foreground focus. A minimized window remains subject to the original framework's
suspended game updates, so the managed client must remain restored.

After launch or recovery attach, the injector waits for the top-level
game window and restores an exact 800 by 600 physical-pixel client area. The managed window
procedure repeats that repair after a per-monitor DPI transition and recalculates the non-client
frame at the destination monitor's DPI. The smallest position adjustment that keeps the full window
in the monitor work area is used, with activation and z-order unchanged. DirectDraw presentation,
window capture, and semantic input therefore retain one 800 by 600 coordinate space across displays.
The injector rereads both client and outer geometry before publishing the `resumed` identity. A
window that cannot satisfy this contract makes launch or attach fail; launch failure terminates the child.
Launch output includes the generated owner token. Recovery attach
never injects a new DLL: it requires the same absolute DLL
path to remain loaded, verifies process creation time, build identity, and owner token, then
rebinds its pipe and runtime configuration. A suspended recovery additionally supplies its
recorded primary thread to `--resume-thread`; authentication completes before that thread is
resumed. Before writing standard output, `--ownership-file` is atomically replaced with
`mode`, `phase`, process ID, token, creation time, primary thread ID, and the absolute
content-addressed artifact directory. Launch publishes a `suspended` record before `ResumeThread`
and replaces it with `resumed` after success. The token and ownership record are process-private
recovery state and must not be logged or placed in user configuration.

Mouse actions use Fitts-scaled cubic trajectories with asymmetric timing and tapered correlated
motor noise. A remaining-route estimate logarithmically compresses queued movement while a hard
logical speed limit bounds every leg. Long moves occasionally add a two-to-seven-pixel ballistic
overshoot followed by a short correction; button input is delivered only after the pointer settles
at the exact semantic target. A private `WM_APP` message is synchronously confirmed on the PvZ UI
thread with a bounded timeout. Press,
hold, release, and drag states have separate bounded dwell intervals. Logical positions are posted
directly because the managed client is exactly 800 by 600;
mouse input and capture reject any later size drift instead of scaling coordinates. They do not
call `SetCursorPos` and do not move the Windows desktop cursor. The managed window procedure
consumes the private message on the game UI thread and dispatches it directly through the pinned
WidgetManager mouse functions; PvZ's application window handler never receives synthetic
`WM_MOUSE*` input. If the subclass chain changes, the private message is ignored instead of
becoming desktop mouse input. The main executable's `SetCapture`, `ReleaseCapture`, and
`SetCursor` imports are also selectively bypassed during that dispatch, so an automated click
cannot capture the Windows mouse. PvZ cursor-shape updates are forwarded only while the physical
Windows pointer is over a window owned by the PvZ process; background hover state therefore cannot
change the user's pointer in another application. After an internal move, cursor-shape updates stay
suppressed until the next real mouse message, so a stationary physical pointer over PvZ is not
reinterpreted using the internal hover position. Real mouse input over PvZ then restores the game's
original cursor behavior. Commands are executed by one action thread. `cancel`, disconnect, and
input-epoch changes drop queued work and pass through one release fence for button and held-card
state before the next command runs. Clicks
dwell briefly at the destination before button-down and after button-up. The pinned DirectDraw
redraw hook renders a black-edged white and cyan software pointer into every submitted game frame
while the implant is connected. Hover, movement, press, drag, and release each drive a discrete
integer-pixel pose and pulse phase. A 24 by 24 six-color companion sprite is compiled into the DLL
and drawn above the pointer at its lower-right edge. Its idle, movement, press, and release frames use only
integer offsets; the renderer performs no loading, scaling, smoothing, or interpolation. The hook
composes the overlay immediately after PvZ draws its native cursor onto the frame source and before
that source is presented. A separate backing store restores the managed pointer area after each
presentation because the native cursor may follow a different physical position. Hammer and
held-card cursors remain underneath the managed pointer without leaving trails.

An accepted `ack` means that a command passed current-state prevalidation and entered the serial
queue. Every accepted command ends with one `result` carrying `executed`, `rejected`, or
`cancelled`. Snapshots expose `inputControl` with the current epoch, queue depth, and active action
ID. Detach flushes its terminal result and stops the bridge. The redraw detour pins the DLL until
the game process exits, preventing a live hook from targeting an unloaded image. Shutdown posts
`WM_CLOSE`, waits
up to three seconds for the game window to disappear, and returns `cancelled` while keeping the
bridge alive if it remains open. A successful shutdown leaves the DLL loaded until the game process exits; the
Node owner verifies the recorded process-creation identity has disappeared.

`rejected` is reserved for commands that sent no game input. Once any mouse, keyboard, character,
or close message has been posted successfully, an unverified postcondition or timeout returns
`cancelled`. Executed and cancelled results are queued atomically with the immediately following
snapshot; the result carries revision `r` and its state fence carries `r+1`. Causally verified
actions attach effects where the caller requires an explicit fence:
`card_consumed`, `usable_seed_consumed`, `target_changed`, `collectibles_collected`, or
`beghouled_purchase`. Verified shovel removal and Wall-nut Bowling launch use `shovel_applied` and `bowling_launched`. Profile creation and garden actions use `profile_created`,
`zen_care_applied`, `garden_changed`, and `tree_fed`.

## Observation boundary

The 10–20 Hz snapshot includes executable identity, explicit enabled menu actions, dialog state,
the visible active profile name and progress, seed selection, terrain cells, cards, plants, on-screen zombies, grid items,
collectibles, mowers, visible progress, and challenge phase/targets. Rows and columns crossing the
pipe are one-based; card slots are zero-based. DataArray identities are mapped to stable,
nonnegative 31-bit IDs for the duration of a board run. `board.runId` changes between runs without
exposing a process address.

Raw Board and SeedChooser pointers are not public-screen evidence. A board is observed as gameplay
only for scene 3 with a coherent mode, level, pointer, and counter tuple. Scene 2 becomes
`seed_picker` only when the pinned CutScene and SeedChooser objects both link back to that board,
the CutScene is choosing seeds, and the chooser accepts mouse input. Other scene-2 and unsettled
board states publish `loading`, except for Adventure level 5 (1-5)'s pinned shovel tutorial states.
That gate requires the linked CutScene, publishes only the remaining pre-planted Peashooters and
the `shovel` action, and clears cards, zombies, grid items, collectibles, mowers, ordinary menu
actions, and planting targets. The completed tutorial immediately returns to dialog/loading state.
This keeps the original Intro demonstration and unrelated cutscenes private and prevents the
mode-72 board from starting a run or an entity namespace. Survival seed repicks retain their run
identity because the same semantic board and monotonic main counter remain active across the
transition.

Seed-picker capacity and readiness come from the linked SeedBank packet count. The chooser field at
`+0xD30` is not initialized by this executable and is not semantic state.

The APAC PlayerInfo profile name uses the pinned UTF-16 string ABI at offsets `+0x04`, `+0x14`,
and `+0x18`. Heap-backed names dereference the `+0x04` storage pointer; inline storage remains
bounded by the same verified ABI. Decoding requires an in-range capacity, a terminating NUL,
well-formed surrogate pairs, and no control characters before conversion to UTF-8.

`lastRun` latches the most recent attributable win or loss across board destruction. Its
monotonic `resultId` changes once for the owning run and remains stable until another observed run
ends. Adventure runs retain their visible 1–50 level; the original game stores level 0 on every
non-Adventure board, and `lastRun.level` preserves that value. A terminal result seen before the
implant has observed that board in a nonterminal state is left unattributed, so attaching on an
existing award or defeat screen does not invent a run.
Survival, Last Stand, staged Adventure Vasebreaker, and endless Puzzle stage awards are not run
wins. Finite modes require a fresh award or completion edge in their final stage, or an
unambiguous terminal destination; an earlier sustained `BoardResult::WON` cannot satisfy a later
stage.

Visibility filtering happens before JSON serialization. Fog samples the rendered GOTY grid at
Board `+0x4E0` with the live offset at `+0x5E8`. Invisighoul never publishes zombie entities;
off-screen and cutscene/UI zombies are omitted. Dark Stormy Night publishes board entities only
during a conservatively visible lightning phase and marks the snapshot with
`board.disclosure`. During darkness, dynamic board entities and special targets are empty,
playable-terrain cells are `dark_hidden`, and target-dependent actions are rejected. Planting may
still be attempted from visible card state and static terrain; the plant, zombie, grid-item, coin,
and mower arrays are not traversed until lightning makes the board visible. A blind placement is
successful only after the selected raw seed packet is observed leaving its slot and the cursor
returns to normal. Ordinary rendered fog filters dynamic occupancy before serialization: affected cells use
`playable: null`,
`blocker: fog_hidden`, and
`base: unknown`, and planting may still be attempted using only static terrain and card readiness.
Vase contents are emitted only while the pot transparency counter is positive; an opaque
non-plant vase remains `unknown`. Persistent condition bands follow visible damage art: ordinary
zombie body state uses actual arm/head loss, and only plants and zombie types with damage sprites
expose health-derived bands. Plants also expose the visible PlantState phase, including Potato Mine
arming, armed, and triggered states. Zombies expose a visible action phase and one categorical
movement state: `stationary`, `slow`, `normal`, `fast`, `retreating`, or `airborne`. These fields are
computed only after the entity passes fog and darkness disclosure; raw velocity, targets, and
countdowns never cross the pipe. Dying, burned, and mowed zombies remain visible observations while
being excluded from Whack targets and hit resolution. The optional PNG frame is diagnostic and is not required for play.

The pinned profile supports the ordinary main-menu/seed-picker/board/award/defeat loop, profile
creation, planting, shoveling, collection, pause/restart/main-menu interactions, and the following
challenge mechanisms: Slot Machine, usable-seed launch from Slot Machine, Raining Seeds, and
Vasebreaker, Beghouled swap, twist, upgrades, shuffle, and crater clearing,
Whack-a-Zombie, Last Stand start, Wall-nut Bowling, ready Cob Cannon targeting,
Zombiquarium snorkel/trophy purchases and brain placement, and I-Zombie card placement. Special
targets are emitted only while their source entity or mechanism is currently safe to invoke.

Zomboss is published as `board.boss`, outside ordinary row-bound zombies. Its phase and freeze
state describe the visible boss; relative planting excludes it. A projectile is published only
while the boss's reanimation ID resolves to a live, on-screen animation. The pinned layout uses
Zombie offsets `0x140` for that ID, `0x14C` for its row, and `0x150` for fire versus ice. Animation
position comes from the effect system's reanimation array; the ball centre is 75 pixels beyond
its left origin. The next attack's preselected row and type are not disclosed before the animation
exists. Native protocol readers accept an omitted `boss` from older bridges as unavailable.
Adventure 4-5 reports visible vase count, and both Zomboss encounters report the same
0–100 percent progress represented by the on-screen boss meter. Vasebreaker stage numbers follow
the visible board resets, including Adventure 4-5. Seeing Stars counts Starfruit only on the 14
painted objective cells and publishes each unmet cell as an `objective_starfruit` observation;
those observations do not become special actions. Slot Machine and Zombiquarium expose their
visible 2,000- and 1,000-sun goals with bounded values. Whack-a-Zombie follows the visible wave
meter while surfaced zombies remain action targets. Ordinary wave progress is the number of waves
already spawned. Zen Garden and Tree of Wisdom publish no level meter, and completed boards clear
all numeric progress fields. Internal challenge scores, raw boss health, potted-plant state, and
tree height are not published.

`board.runId` and all public entity namespaces change when the board pointer changes or its main
counter rolls back by any amount. Survival stage initialization resets wave progress without
rolling back that counter, so stage changes remain within the same board run.

Card `ready` reports cooldown readiness independently from `affordable`. Conveyor cards, including
Zomboss's Revenge, have a null cost and are always affordable. Pogo Party and other ordinary card
banks use the live mode-specific price and sun checks. Survival
Endless adds 50 sun for every existing copy of the raw upgrade card type, matching the game's
accelerated-pricing routine. An action requires both cooldown readiness and affordability.
Conveyor packets outside the live seed-bank rectangle are omitted. A partly clipped packet's
click point lies inside its visible intersection with that rectangle, preserving its native slot.
Selection rechecks the packet after cursor travel and corrects a point it has moved away from
before pressing; packet removal or identity changes end selection without a click.
Collection re-reads every requested ID immediately before its click and accepts it only after the
same raw Coin enters `mIsBeingCollected`; an ordinary disappearance never satisfies the action.
For the last requested ID, a board transition can replace that observation only when `lastRun`
attributes a win to the same run. Award, mode-selector, next-level seed-picker, main-menu,
credits, and dialog destinations are accepted under that causal fence; the screen alone is never
proof of collection. A dialog over the owning board does not constitute a transition: while the
board address and run generation remain current, the raw Coin must still be observed entering
`mIsBeingCollected`.

Relative planting binds one zombie when execution starts and re-derives its cell from that zombie
until the click lands. Cooldown and sun are entry conditions only: the game clears a seed packet's
seed-bank active flag while the cursor carries it, so from the seed-bank click onward the contract
is packet identity plus a cursor that still holds the same packet. Each failure exit on that path
names one cause; reasons are never combined.

Main-menu Adventure, Mini-games, Puzzle, Survival, Options, Help, Store, Almanac, Zen Garden, and
Change User entries are exposed from their visible widgets. Mini-games, Puzzle, and Survival use
the selector's independent lock flags; a clickable locked entry is published with `enabled=false`
and `state=locked`. Mode selection includes visible locked/available/completed state and only the
numeric records that the original screen draws. The title screen exposes `title_continue` only after its loading-complete flag makes the
full-screen click handler actionable; the action clicks the safe center and verifies that the
title object is removed before reporting success. Store and Almanac expose their pinned navigation controls; store item purchases are not
offered except for the visible fertilizer item on the first Zen page. That item includes its
current uses, price, and available/unaffordable/sold-out state; purchase confirmation is completed
inside one action and verified by both the inventory increase and coin debit. Change User exposes
`profile_create` for the original list's Create New User row and `cancel`; one action selects that
row, enters the pinned name dialog, submits the name, and verifies both roster growth and the exact
active profile. Existing profile rows and raw row indices do not cross the bridge. Zen Garden publishes only live plants whose visible state currently accepts
watering, fertilizer, bug spray, phonograph, or plant chocolate. Next Garden follows the purchased
main/mushroom/aquarium/tree cycle, and Tree of Wisdom feeding waits for the complete food animation
before accepting the private inventory and height postconditions. Potted-plant need values,
timestamps, and tree height are never serialized. Gardening glove, wheelbarrow, selling, and
Stinky chocolate remain unsupported.
Third-party menu layouts are unsupported. Dialog body text is not serialized; the bridge exposes
verified buttons and a changing visible-page identity.
