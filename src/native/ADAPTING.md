# `profile.h`: adapting the native bridge to another executable

Every address, offset, byte signature and identity constant the bridge relies on lives in
`profile.h`. The injector and the implant refuse any executable that does not match all of
them, so supporting a second build means producing a second, fully verified profile. This page
records what the current profile covers, how the native code around it is laid out, what has to
be re-established for a new build, and how each piece is tested.

## 1. The adapted build

| Fact | Value | Declared in |
|---|---|---|
| Profile name | `goty-apac-ja-chs-south_sniper` | `pvz::kProfileName` |
| Product | PopCap Plants vs. Zombies, GOTY, APAC Japanese localized branch (Chinese resources) | README "Supported build" |
| FileVersion | `1.2.0.1073` (installer metadata says `1.1.0.1056`) | `pvz::kExecutableVersion` |
| `PlantsVsZombies.exe` | 3 703 808 bytes, SHA-256 `9ba1c9b2…7b7198ed` | `pvz::kExecutableSha256`, `fingerprint.ts` |
| `main.pak` | 50 651 354 bytes, SHA-256 `89971baf…8c6ba9b8` | `fingerprint.ts` |
| PE | x86, image base `0x00400000`, entry `0x002BA65F`, size of image `0x00450000`, checksum `0x0039863F`, timestamp `0x4CC8E5F8`, no relocation table, no ASLR | `pvz::kImageBase`, `pvz::kPe*` |
| `gLawnApp` | `0x007578F8`; vtables `0x00710D80` / `0x00710F30` | `pvz::kGlobalLawnApp`, `pvz::kLawnApp*Vtable` |
| Client area | 800 × 600 physical pixels, enforced by the implant | `pvz::kManagedClient*` |
| Pipe protocol | 2, equal on both sides | `pvz::kProtocol`, `PVZ_NATIVE_PROTOCOL` in `src/protocol.ts` |
| Implant build id | `cortico-io-pvz-native-20260831-36` | `pvz::kImplantBuildId` |

The build is not distributed with this package. The operator points `worlds.pvz.executable` at
their own copy; `fingerprint.ts` hashes the executable and `main.pak` before launch, the
injector hashes the executable again from the process image path, and the implant hashes it a
third time from inside the process. English 1.2.0.1073 builds and the 1.0.0.1051 family have a
different layout and fail the hash before any address is used.

## 2. Layout of the bridge for this build

### Native (`src/native/`)

| File | Role |
|---|---|
| `profile.h` | Everything build-specific: identity constants, absolute code addresses, byte signatures at those addresses, object field offsets, `DataArray` strides, dialog ids and vtables. Static assertions pin relations between constants (adjacent fields, signature lengths, patch byte positions). |
| `injector.cpp` | `pvz-injector.exe`. Creates the game suspended or attaches for recovery, verifies the target (SHA-256, PE identity, accessor signatures, focus-policy signatures), loads the DLL, configures it through the exported `CorticoPvz*` functions, restores the 800 × 600 client, publishes the ownership record. |
| `implant.cpp` | `pvz-implant.dll`. Repeats the verification in-process, detours `DDInterface::Redraw` and the cursor draw, subclasses the game window, reads game state at the poll rate, serializes snapshots as JSON over the named pipe, executes commands on one action thread, draws the managed pointer. |
| `relative_plant.h` | The relative-column planting validator (`ValidateRelativePlant`); included by `implant.cpp` after the board readers so fixtures can exercise it. |
| `json.h` | Minimal JSON writer and scanner used by the implant; no third-party code. |
| `cursor_companion.h` | Generated sprite data, from [cortico-cursor-companion](https://github.com/Phantivia/cortico-cursor-companion). Build-independent. |
| `implant.def` | The six exports the injector calls: `CorticoPvzSetPipeW`, `CorticoPvzPrepareFocusLossPolicy`, `CorticoPvzPrepareManagedWindow`, `CorticoPvzConfigure`, `CorticoPvzVerifyOwnerW`, `CorticoPvzVerifyBuildW`. |
| `build.cmd` | Compiles both binaries with the x86 MSVC toolchain (`/std:c++17 /O2 /MT`). |

### Node side (`src/`)

| File | Role |
|---|---|
| `fingerprint.ts` | `SUPPORTED_PVZ_PROFILE`: executable and `main.pak` sizes and hashes; `verifyPvzInstallation()` runs before every launch. |
| `native-build.ts` | Hashes `src/native/**`, builds into `<nativeBuildDir>/<hash>/`, writes and re-checks `artifacts.json`. |
| `bridge.ts` | Spawns the injector, owns the pipe, correlates `command` / `ack` / `result` / snapshots. |
| `protocol.ts` | TypeScript shape of everything that crosses the pipe. `PVZ_NATIVE_PROTOCOL` must equal `pvz::kProtocol`. |
| `native-reasons.ts` | Every `reason` literal the implant can emit, mapped to one Chinese sentence and a failed/unknown classification. |
| `names.ts` | Seed, zombie and game-mode ids to names. These enums are engine-wide; a build that reorders them needs this table changed too. |

### Tests (`tests/`)

| File | What it pins |
|---|---|
| `native-*.cpp` + `native-*.test.ts` | Ten fixtures. Each `.test.ts` locates Build Tools with `vswhere`, compiles its `.cpp` with the same flags as `build.cmd`, and runs it. A fixture `#include`s `implant.cpp` and lays out fake game objects in local `Memory<N>` blocks at the offsets from `profile.h`, so observation and validation functions run without a game. `native-relative-plant.cpp` additionally redefines `kGlobalLawnApp` and the WidgetManager entry points before the include, so the input dispatch path runs against fixture functions. |
| `native-build.test.ts` | The implant source never calls global input or focus APIs (`SetCursorPos`, `SendInput`, `SetCapture`, `SetForegroundWindow`, …); artifact directories are content-addressed and integrity-checked. |
| `native-reasons.test.ts` | Extracts every reason literal from `native/*.h` and `implant.cpp` and requires a mapping in `native-reasons.ts`. |
| `fingerprint.test.ts` | Size and hash gate. |
| everything else | Node-side semantics against scripted snapshots: protocol parsing, executor, events, triggers, rendering, lifecycle, recovery. Build-independent. |

## 3. What a new build must re-establish

Work through `profile.h` top to bottom. Each item says what the value is used for and what proves
it. "Signature" means the byte sequence in `profile.h` must be read back from the executable at
that address; both binaries check the signatures at startup and refuse the build otherwise.

### Identity

- `kProfileName`, `kExecutableVersion`, `kExecutableSha256`, and `SUPPORTED_PVZ_PROFILE` in
  `fingerprint.ts` (both files, both hashes, both sizes). Take them from the actual files.
- `kImageBase`, `kPeTimestamp`, `kPeEntryPoint`, `kPeSizeOfImage`, `kPeChecksum`: from the PE
  headers. The bridge assumes a fixed image base with no relocations and no ASLR
  (`IMAGE_DIRECTORY_ENTRY_BASERELOC` size 0, no `DYNAMIC_BASE`). A build that relocates needs
  every absolute address below turned into an RVA plus module base, which the current code does
  not do.
- `kImplantBuildId`: change it whenever the DLL's exports or pipe behaviour change. Recovery
  attach compares it against the loaded DLL, so a stale id lets an old DLL be re-attached.
- `kProtocol` and `PVZ_NATIVE_PROTOCOL`: bump together when the JSON changes shape.

### `gLawnApp` and its vtables

- `kGlobalLawnApp`: the global pointer to `LawnApp`. It was established from the accessor and
  constructor code that reads or stores it. Those four code sites are literal in both
  `injector.cpp` (`ValidateRemoteTarget`) and `implant.cpp` (`ValidateExecutableUnlocked`):
  `0x0045DE20`, `0x0045DE40`, `0x0045DFCD` read the global, `0x0045E05D` stores both vtables in
  the constructor. Their signatures embed the global's address and the vtable addresses, so a
  new build needs new addresses, new bytes, and the two copies kept identical.
- `kLawnAppVtable`, `kLawnAppSecondaryVtable`: the implant reads the live object's first two
  pointers on every `ReadLawnApp` and refuses input when they differ.

### Patched and hooked code sites

Each has an address and a signature in `profile.h`; the injector or the implant patches or
detours the bytes after the signature matches.

| Site | Used for | Shape |
|---|---|---|
| `audio::muteOnLostFocusInitializer` | Keep sound while the window is in the background | One immediate byte at index 6 of the signature (`1` → `0`), patched before the entry point runs |
| `focus::lostFocus` | Do not auto-pause on focus loss | Branch byte at index 19 (`0x74` → `0xEB`) |
| `ddInterface::redraw`, `ddInterface::drawCursorTo` | Draw the managed pointer into every presented frame; restore the pointer area | 5-byte detours; the signatures must be longer than the detour |
| `widgetManager::remapMouse/mouseUp/mouseDown/mouseMove` | Internal mouse dispatch on the game UI thread (synthetic `WM_MOUSE*` never reaches the game) | Called by address; `remapMouse` signature is checked |
| `title::mouseDown` | Recognize the title-screen click handler and its `loadingThreadComplete` flag | Signature |
| `player::copyConstructor`, `player::nameStorageAccess` | The UTF-16 profile-name ABI (inline vs. heap storage, capacity, length) | Signatures |
| `cutScene::endSeedChooser` | Seed-picker completion | Signature |

### Object layouts

Field offsets are read with `SafeRead`; a wrong offset does not crash, it produces wrong
observations, which is why the fixtures exist. Groups, in the order they appear:

- `app::*`: `LawnApp` fields (widget manager, DirectDraw interface, board, title screen,
  selector, seed chooser, award and credit screens, challenge screen, Zen garden, game mode,
  scene, player info, board result).
- `widgetManager::*`, `ddInterface::*` (surfaces, critical section, `initialized`).
- `player::*` and `profileManager::userCount`: name ABI, level, coins, completions, unlock
  flags, potted plants (`pottedPlant::*`, stride `0x58`), purchases (`purchase::*` item ids),
  tree height.
- `userDialog::*`, `editWidget::text`, `pauseDialog::*`: dialog ids, vtables, list geometry
  (`listInset + maxUsers * itemHeight == 196` is asserted).
- `gameSelector::*` lock flags.
- `board::*`: entity arrays, seed bank, cursor object, cut scene, challenge, grid square types,
  fog grid and offset, ice, waves, background, level, sun, counters, tutorial state, level
  completion, shovel visibility, award, progress meter, Cob Cannon delay.
- `tutorial::*` shovel-tutorial states, `widget::*` generic widget geometry.
- `cutScene::*`, `chooser::*` (chosen seeds, in-flight count, `chooseState`, 49 visible seeds),
  `seedBank::*` (packet count, stride `0x50`).
- `dataArray::*`: header size and per-type object size and stride for plants, zombies, coins,
  mowers and grid items. `IterateArray` uses these to walk the arrays with a hard element limit.

The `static_assert`s at the end of each group encode relations the code depends on; keep them and
add one for every new relation you rely on.

### Beyond the profile

- Pixel constants inside `implant.cpp` (cell centres by background, the shovel button centroid,
  seed-bank packet rectangles, roof slope) were measured on the 800 × 600 frame of this build.
  A build with different layout art needs them re-measured; `pvz_glance` returns the frame.
- `names.ts` maps seed type, zombie type and game mode ids. Verify against the new build's enums
  only if observations name the wrong plant.
- Every user-visible reason string added to the native code needs an entry in
  `native-reasons.ts`; the reasons test fails otherwise.
- Update README "Supported build", `README.md` in this directory, and the table in section 1.

## 4. Testing

### Without the game

```bash
corepack pnpm typecheck
corepack pnpm test
```

`pnpm test` runs 37 files. The ten `native-*.test.ts` files need Visual Studio Build Tools with
the x86 C++ workload on the machine; each compiles its fixture into `scratch/` and takes a few
seconds. On a machine without the toolchain they fail at the `vswhere` assertion, which is the
intended signal rather than a skip. Everything else runs on any platform.

The C++ `static_assert`s (`profile.h` and `implant.cpp`) run on every compile, including the
fixture compiles, so a profile whose relations are inconsistent never produces a DLL.

For a new profile, write a fixture before running the game: copy `tests/native-shovel.cpp` (the
smallest) or `tests/native-board-context.cpp`, lay out the objects at the new offsets, and assert
the reader functions' output. The fixtures compile `implant.cpp` directly, so any function in it
is reachable.

### Building

```bat
src\native\build.cmd C:\path\to\output
```

The World runs the same script into `<worlds.pvz.nativeBuildDir>/<source hash>/` (default
`<deployment root>/runtimes/pvz/`) and refuses artifacts whose `artifacts.json` hashes do not
match the binaries.

### With the game

1. Point `worlds.pvz.executable` at the new build and start the World from the console panel.
   The launch log carries the injector's `Fail(...)` message when a gate refuses the build:
   `target executable SHA-256 is not the pinned … build`, `target PE identity mismatch`,
   `target LawnApp signature mismatch`. The implant's own `Validation.reason` travels in the pipe
   hello (`supported: false` plus the reason string).
2. Confirm the window is restored to exactly 800 × 600 and `presentation` on the snapshot says so;
   input and capture are refused otherwise.
3. Walk the ordinary loop with `pvz_do` and compare every `pvz_observe` against the screen:
   `title_continue`, main-menu actions, a profile selection, the seed picker (capacity and
   chosen seeds), a board (cells, cards with cost and cooldown, sun, planting on lawn, water and
   roof, shovel, collection), pause and restart dialogs, an award screen and `lastRun`.
4. Exercise the special-level contracts listed in the package README that the new build ships,
   one mechanism at a time; each has a dedicated action and a verification fence.
5. Let a sun sweep run and confirm collection receipts and that the physical mouse stays free.

Nothing above is automated: it needs the operator's own copy of the game and a display.
