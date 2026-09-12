#pragma once

// Included after the board, card, cursor, and run readers in implant.cpp.
constexpr ULONGLONG kRelativePlantBudgetMs = 20000;
constexpr int kRelativePlantCorrections = 2;

bool PlantIntegerAt(const std::string& line, size_t& at, int minimum, int maximum, int& value) {
    at = pvz::json::SkipSpace(line, at);
    const size_t start = at;
    value = 0;
    while (at < line.size() && line[at] >= '0' && line[at] <= '9') {
        const int digit = line[at++] - '0';
        if (value > (maximum - digit) / 10 || digit > maximum) return false;
        value = value * 10 + digit;
    }
    if (at == start || (at > start + 1 && line[start] == '0') || value < minimum || value > maximum) return false;
    at = pvz::json::SkipSpace(line, at);
    return at < line.size() && (line[at] == ',' || line[at] == '}');
}

bool PlantInteger(const std::string& line, const char* key, int minimum, int maximum, int& value) {
    const auto values = pvz::json::FindValues(line, key);
    if (values.size() != 1) return false;
    size_t at = values.front();
    return PlantIntegerAt(line, at, minimum, maximum, value);
}

bool ParsePlantSelector(const std::string& line, Command& command, std::string& reason) {
    const auto selectors = pvz::json::FindValues(line, "aheadOf");
    if (command.kind != "plant") {
        if (selectors.empty()) return true;
        reason = "aheadOf is only supported for plant actions";
        return false;
    }
    if (!PlantInteger(line, "slot", 0, 9, command.slot) ||
        !PlantInteger(line, "row", 1, 6, command.row)) {
        reason = "plant slot and row must be integers within the board limits";
        return false;
    }
    if (selectors.empty()) {
        if (PlantInteger(line, "column", 1, 9, command.column)) return true;
        reason = "plant requires an integer column or aheadOf";
        return false;
    }
    if (selectors.size() != 1 || !pvz::json::FindValues(line, "column").empty()) {
        reason = "plant column and aheadOf are mutually exclusive";
        return false;
    }
    size_t at = selectors.front();
    const auto gaps = pvz::json::FindValues(line, "minGap");
    if (at >= line.size() || line[at++] != '{') {
        reason = "aheadOf must be an object containing minGap";
        return false;
    }
    at = pvz::json::SkipSpace(line, at);
    constexpr char key[] = "\"minGap\"";
    if (line.compare(at, sizeof(key) - 1, key) != 0) {
        reason = "aheadOf must contain only minGap";
        return false;
    }
    at = pvz::json::SkipSpace(line, at + sizeof(key) - 1);
    if (at >= line.size() || line[at++] != ':' || gaps.size() != 1 ||
        gaps.front() != pvz::json::SkipSpace(line, at) ||
        !PlantIntegerAt(line, at, 0, 8, command.minGap) || line[at++] != '}') {
        reason = "aheadOf.minGap must be an integer from 0 through 8";
        return false;
    }
    at = pvz::json::SkipSpace(line, at);
    if (at >= line.size() || (line[at] != ',' && line[at] != '}')) {
        reason = "malformed aheadOf selector";
        return false;
    }
    command.column = -1;
    return true;
}

void AppendPlantPlacement(std::string& output, const PlantPlacement& placement) {
    output += ",\"placement\":{\"row\":";
    AppendInt(output, placement.row);
    output += ",\"column\":";
    AppendInt(output, placement.column);
    output += ",\"targetId\":";
    AppendInt(output, placement.targetId);
    output += ",\"runId\":";
    AppendInt(output, placement.runId);
    output.push_back('}');
}

enum class RelativePlantDispatch : LRESULT {
    Rejected = -1,
    Committed = 0,
    CorrectCursor = 1,
    Uncertain = 2,
};

// Taking a packet onto the cursor clears its seed-bank `active` flag, so cooldown and sun are
// entry conditions rather than conditions that hold for the whole action. Each stage names the
// card contract that must hold at that point.
enum class RelativePlantStage {
    Selecting,  // the packet must still be pickable out of the seed bank
    Acquiring,  // the seed-bank click is posted and the cursor has not taken the packet yet
    Held,       // the cursor must still be holding the bound packet
};

struct RelativePlantScope {
    Command command;
    uintptr_t lawnApp = 0;
    uintptr_t board = 0;
    int mode = 0;
    int level = 0;
    int background = 0;
    int counter = 0;
    int survivalStage = 0;
    uint64_t runId = 0;
    uint32_t targetId = 0;
    RawCardState packet;
    ULONGLONG deadline = 0;
};

bool RelativeHostileAlive(const ZombieView& zombie) {
    return !zombie.hypnotized && zombie.health > 0 &&
           zombie.phase != 1 && zombie.phase != 2 && zombie.phase != 3;
}

// Ground locomotion and its stationary phases have a known houseward direction.
constexpr bool RelativeHostileGroundPhase(int phase) {
    switch (phase) {
        case 0: case 11: case 13: case 15: case 29: case 30: case 31: case 38:
        case 41: case 42: case 43: case 44: case 45: case 46: case 47: case 48:
        case 49: case 50: case 51: case 55: case 56: case 57: case 59: case 60:
        case 61: case 62: case 67: case 68: case 69: case 70: case 75: case 76:
        case 77: case 91:
            return true;
        default:
            return false;
    }
}

enum class RelativeHostileFault {
    None,
    Airborne,
    MovingAway,
    UnknownDirection,
};

RelativeHostileFault RelativeHostileDirection(const ZombieView& zombie) {
    if (zombie.height != 0 ||
        ZombiePhaseAirborne(zombie.phase, zombie.height, zombie.blowingAway)) {
        return RelativeHostileFault::Airborne;
    }
    if (std::isfinite(zombie.velocityX) && zombie.velocityX < 0) {
        return RelativeHostileFault::MovingAway;
    }
    if (zombie.type < 0 || zombie.type > 32 || !std::isfinite(zombie.actualX) ||
        !std::isfinite(zombie.velocityX) || zombie.phase == 40 ||
        (zombie.type == 17 && (zombie.phase == 33 || zombie.phase == 36 || zombie.phase == 37)) ||
        (zombie.type == 19 && !zombie.hasObject) ||
        !RelativeHostileGroundPhase(zombie.phase)) {
        return RelativeHostileFault::UnknownDirection;
    }
    return RelativeHostileFault::None;
}

bool BindRelativePlant(const Command& command, const BoardView& board, int mode,
                       const RawCardState& packet, ULONGLONG deadline,
                       RelativePlantScope& scope, std::string& reason) {
    const ZombieView* nearest = nullptr;
    for (const auto& zombie : board.zombies) {
        if (zombie.row + 1 != command.row || !RelativeHostileAlive(zombie)) continue;
        if (!std::isfinite(zombie.actualX)) {
            reason = "relative planting could not read a hostile position in the requested row";
            return false;
        }
        if (!nearest || zombie.actualX < nearest->actualX ||
            (zombie.actualX == nearest->actualX && zombie.id < nearest->id)) nearest = &zombie;
    }
    if (!nearest) {
        reason = "relative planting found no visible living hostile in the requested row";
        return false;
    }
    switch (RelativeHostileDirection(*nearest)) {
        case RelativeHostileFault::Airborne:
            reason = "relative planting nearest hostile is off the ground";
            return false;
        case RelativeHostileFault::MovingAway:
            reason = "relative planting nearest hostile is moving away from the house";
            return false;
        case RelativeHostileFault::UnknownDirection:
            reason = "relative planting nearest hostile is in a phase with no known houseward direction";
            return false;
        case RelativeHostileFault::None:
            break;
    }
    const uint64_t runId = TrackedRunId(board, mode);
    if (!runId) {
        reason = "relative planting could not identify the current run";
        return false;
    }
    scope = {command, board.lawnApp, board.address, mode, board.level, board.background,
             board.mainCounter, board.survivalStage, runId, nearest->id, packet, deadline};
    return true;
}

bool RelativePlantCursorHoldsPacket(const RelativePlantScope& scope, const BoardView& board) {
    return board.cursorSeedBankIndex == scope.command.slot &&
           board.cursorHeldType == scope.packet.type &&
           board.cursorImitaterType == scope.packet.imitater;
}

bool ReadRelativePlantBoard(const RelativePlantScope& scope, BoardView& board,
                            std::string& reason) {
    board = {};
    uintptr_t lawnApp = 0;
    uintptr_t address = 0;
    int mode = 0;
    int background = 0;
    int rows = 0;
    if (!LiveBoard(lawnApp, address, mode, background, rows, reason, false, false)) return false;
    if (lawnApp != scope.lawnApp || address != scope.board || mode != scope.mode) {
        reason = "relative planting moved to a different board instance";
        return false;
    }
    if (!ReadBoard(lawnApp, mode, board, scope.board)) {
        reason = "relative planting could not re-read the board";
        return false;
    }
    if (board.level != scope.level || board.background != scope.background ||
        board.survivalStage != scope.survivalStage) {
        reason = "relative planting level changed";
        return false;
    }
    if (!SameBoardCounterRun(board.mainCounter, scope.counter)) {
        reason = "relative planting board counter restarted";
        return false;
    }
    if (board.paused) {
        reason = "relative planting board is paused";
        return false;
    }
    if (board.complete) {
        reason = "relative planting level ended";
        return false;
    }
    if (HasLevelTransition(board)) {
        reason = "relative planting level entered its end-of-level transition";
        return false;
    }
    if (TrackedRunId(board, mode) != scope.runId) {
        reason = "relative planting run changed";
        return false;
    }
    return true;
}

// Identity of the bound packet across both the board snapshot and a fresh packet read.
bool RelativePlantCardIdentity(const RelativePlantScope& scope, const CardView& card,
                               const RawCardState& packet) {
    return CardIdentityMatches(scope.command, card) &&
           card.type == scope.packet.type && card.imitater == scope.packet.imitater &&
           packet.type == scope.packet.type && packet.imitater == scope.packet.imitater;
}

bool ValidateRelativePlant(const RelativePlantScope& scope, ULONGLONG now,
                           RelativePlantStage stage, BoardView& board,
                           PlantPlacement& placement, int& x, int& y, std::string& reason) {
    if (!ActionCurrent(scope.command.epoch)) {
        reason = "relative planting was cancelled";
        return false;
    }
    if (now >= scope.deadline) {
        reason = "relative planting exceeded its time budget";
        return false;
    }
    if (!ReadRelativePlantBoard(scope, board, reason)) return false;
    const auto target = std::find_if(board.zombies.begin(), board.zombies.end(),
        [&](const ZombieView& zombie) { return zombie.id == scope.targetId; });
    if (target == board.zombies.end()) {
        reason = "relative planting target is no longer visible";
        return false;
    }
    if (target->row + 1 != scope.command.row) {
        reason = "relative planting target moved to another row";
        return false;
    }
    if (target->hypnotized) {
        reason = "relative planting target was charmed";
        return false;
    }
    if (!RelativeHostileAlive(*target)) {
        reason = "relative planting target is dying";
        return false;
    }
    switch (RelativeHostileDirection(*target)) {
        case RelativeHostileFault::Airborne:
            reason = "relative planting target left the ground";
            return false;
        case RelativeHostileFault::MovingAway:
            reason = "relative planting target turned away from the house";
            return false;
        case RelativeHostileFault::UnknownDirection:
            reason = "relative planting target entered a phase with no known houseward direction";
            return false;
        case RelativeHostileFault::None:
            break;
    }
    // minGap counts houseward from the cell the game itself puts the target in: the one whose
    // centre is nearest its x, `(x - 40) / 80`. A result before the first column is clamped to
    // that column, the only cell still ahead of a target that has reached the house; a result
    // past the last column is refused, because that target has not walked onto the board yet.
    const double occupied =
        std::floor((static_cast<double>(target->actualX) - 40.0) / 80.0) + 1.0;
    const double column = occupied - scope.command.minGap;
    if (column > 9) {
        reason = "relative planting cell is outside the board";
        return false;
    }
    const int nearest = static_cast<int>(std::max(column, 1.0));
    const auto card = std::find_if(board.cards.begin(), board.cards.end(),
        [&](const CardView& value) { return value.slot == scope.command.slot; });
    if (card == board.cards.end()) {
        reason = "relative planting seed slot left the seed bank";
        return false;
    }
    RawCardState packet;
    if (!ReadRawCardState(board.address, scope.command.slot, packet)) {
        reason = "relative planting seed packet could not be re-read";
        return false;
    }
    if (packet.bank != scope.packet.bank) {
        reason = "relative planting seed bank was rebuilt";
        return false;
    }
    if (!RelativePlantCardIdentity(scope, *card, packet)) {
        reason = "relative planting seed slot no longer holds the bound plant";
        return false;
    }
    if (packet.timesUsed != scope.packet.timesUsed) {
        reason = "relative planting seed packet was already spent";
        return false;
    }
    if (HasConveyorSeedBank(scope.mode, scope.level) && packet.offsetX > scope.packet.offsetX) {
        reason = "relative planting conveyor advanced past the bound seed packet";
        return false;
    }
    if (stage == RelativePlantStage::Selecting) {
        if (!card->active) {
            reason = "relative planting seed packet is not active in the seed bank";
            return false;
        }
        if (card->refreshing || card->refreshCounter > 0) {
            reason = "relative planting seed packet is still on cooldown";
            return false;
        }
        if (!CardAffordable(board, scope.mode, *card)) {
            reason = "relative planting seed packet costs more sun than is available";
            return false;
        }
    } else if (stage == RelativePlantStage::Held) {
        if (board.cursorType != 1) {
            reason = "relative planting cursor is no longer holding a seed packet";
            return false;
        }
        if (!RelativePlantCursorHoldsPacket(scope, board)) {
            reason = "relative planting cursor is holding a different seed packet";
            return false;
        }
    }
    if (!board.entitiesVisible) {
        reason = "relative planting board stopped disclosing entities";
        return false;
    }
    // minGap is a lower bound: the landing cell is the first one from there toward the house
    // that takes this plant. A target chewing on a plant stands on that plant's cell, and the
    // intent "ahead of this target" still has exactly one nearest answer.
    int landing = 0;
    for (int candidate = nearest; candidate >= 1; --candidate) {
        if (CanPlantCardAt(board, *card, scope.command.row - 1, candidate - 1)) {
            landing = candidate;
            break;
        }
    }
    if (!landing) {
        reason = "relative planting found no cell ahead of the target that takes this plant";
        return false;
    }
    placement = {scope.command.row, landing, scope.targetId, scope.runId};
    CellCenter(board.address, board.background, placement.row - 1, placement.column - 1, x, y);
    if (!FogAllowsZombie(board.address, 0, board.background, x, placement.row - 1)) {
        reason = "relative planting cell is behind fog";
        return false;
    }
    return true;
}

struct RelativePlantRequest {
    RelativePlantScope scope;
    int x = 0;
    int y = 0;
    std::atomic<bool> withdrawn{false};
    PlantPlacement placement;
    std::string reason;
};

// Only a completed synchronous dispatch permits reading the request's result fields.
SRWLOCK g_relativePlantLock = SRWLOCK_INIT;
std::shared_ptr<RelativePlantRequest> g_relativePlantRequest;
WPARAM g_relativePlantToken = 0;

template <typename Clock, typename MouseDown>
RelativePlantDispatch CommitRelativePlant(RelativePlantRequest& request, int x, int y,
                                          Clock&& now, MouseDown&& mouseDown) {
    BoardView board;
    PlantPlacement placement;
    int currentX = 0;
    int currentY = 0;
    if (request.withdrawn.load()) {
        request.reason = "relative planting request was withdrawn before the click";
        return RelativePlantDispatch::Rejected;
    }
    if (!ValidateRelativePlant(request.scope, now(), RelativePlantStage::Held, board, placement,
                               currentX, currentY, request.reason)) {
        return RelativePlantDispatch::Rejected;
    }
    if (currentX != x || currentY != y) return RelativePlantDispatch::CorrectCursor;
    if (request.withdrawn.load()) {
        request.reason = "relative planting request was withdrawn before the click";
        return RelativePlantDispatch::Rejected;
    }
    if (!ActionCurrent(request.scope.command.epoch)) {
        request.reason = "relative planting was cancelled";
        return RelativePlantDispatch::Rejected;
    }
    if (now() >= request.scope.deadline) {
        request.reason = "relative planting exceeded its time budget";
        return RelativePlantDispatch::Rejected;
    }
    request.placement = placement;
    if (!mouseDown()) {
        request.reason = "relative planting click was not accepted by the game";
        return RelativePlantDispatch::Uncertain;
    }
    return RelativePlantDispatch::Committed;
}

LRESULT DispatchRelativePlantMessage(WPARAM token) {
    AcquireSRWLockShared(&g_relativePlantLock);
    auto request = token == g_relativePlantToken ? g_relativePlantRequest : nullptr;
    ReleaseSRWLockShared(&g_relativePlantLock);
    if (!request) return static_cast<LRESULT>(RelativePlantDispatch::Rejected);
    if (request->withdrawn.load()) {
        request->reason = "relative planting request was withdrawn before the click";
        return static_cast<LRESULT>(RelativePlantDispatch::Rejected);
    }
    uintptr_t lawnApp = 0;
    uintptr_t manager = 0;
    if (!ReadLawnApp(lawnApp) || lawnApp != request->scope.lawnApp) {
        request->reason = "relative planting lost the game process while dispatching";
        return static_cast<LRESULT>(RelativePlantDispatch::Rejected);
    }
    if (!SafeRead(lawnApp + pvz::app::widgetManager, manager) || !manager) {
        request->reason = "relative planting could not reach the widget manager";
        return static_cast<LRESULT>(RelativePlantDispatch::Rejected);
    }
    int x = request->x;
    int y = request->y;
    using RemapMouseFunction = void (__thiscall*)(void*, int&, int&);
    using MouseMoveFunction = bool (__thiscall*)(void*, int, int);
    using MouseButtonFunction = bool (__thiscall*)(void*, int, int, int);
    reinterpret_cast<RemapMouseFunction>(pvz::widgetManager::remapMouse)(
        reinterpret_cast<void*>(manager), x, y);
    reinterpret_cast<MouseMoveFunction>(pvz::widgetManager::mouseMove)(
        reinterpret_cast<void*>(manager), x, y);
    return static_cast<LRESULT>(CommitRelativePlant(*request, x, y,
        [] { return GetTickCount64(); }, [&] {
            return reinterpret_cast<MouseButtonFunction>(pvz::widgetManager::mouseDown)(
                reinterpret_cast<void*>(manager), x, y, 1);
        }));
}

RelativePlantDispatch PostRelativePlant(HWND window, const RelativePlantScope& scope,
                                       int x, int y, PlantPlacement& placement,
                                       std::string& reason) {
    if (!HasManagedClientSize(window)) {
        reason = "relative planting window is not at its managed client size";
        return RelativePlantDispatch::Rejected;
    }
    if (!ManagedLogicalPoint(x, y)) {
        reason = "relative planting point is outside the managed client area";
        return RelativePlantDispatch::Rejected;
    }
    if (!EnsureInternalMouseDispatch(window)) {
        reason = "relative planting could not install the internal mouse dispatch";
        return RelativePlantDispatch::Rejected;
    }
    auto request = std::make_shared<RelativePlantRequest>();
    request->scope = scope;
    request->x = x;
    request->y = y;
    AcquireSRWLockExclusive(&g_relativePlantLock);
    const WPARAM token = ++g_relativePlantToken;
    g_relativePlantRequest = request;
    ReleaseSRWLockExclusive(&g_relativePlantLock);
    g_inputPosted = true;
    DWORD_PTR result = static_cast<DWORD_PTR>(RelativePlantDispatch::Uncertain);
    const LRESULT delivered = SendMessageTimeoutW(
        window, kRelativePlantWindowMessage, token, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK,
        kInternalMouseDispatchTimeoutMs, &result);
    request->withdrawn.store(true);
    AcquireSRWLockExclusive(&g_relativePlantLock);
    g_relativePlantRequest.reset();
    ReleaseSRWLockExclusive(&g_relativePlantLock);
    if (!delivered) {
        reason = "relative planting click was dispatched without an acknowledged result";
        return RelativePlantDispatch::Uncertain;
    }
    reason = request->reason;
    const auto outcome = static_cast<RelativePlantDispatch>(static_cast<LRESULT>(result));
    if (outcome == RelativePlantDispatch::Committed) placement = request->placement;
    // A rejection that reached the game thread without a reason lost the token race.
    if (outcome == RelativePlantDispatch::Rejected && reason.empty()) {
        reason = "relative planting request was superseded before the game thread handled it";
    }
    return outcome;
}

struct NativeRelativePlantInput {
    HWND window;
    ULONGLONG now() { return GetTickCount64(); }
    bool delay(ULONGLONG epoch, DWORD ms) { return WaitForActionDelay(epoch, ms); }
    bool select(const RelativePlantScope& scope, const CardView& card, std::string& reason) {
        return ClickValidated(window, card.x, card.y, scope.command.epoch, [&] {
            BoardView board;
            PlantPlacement placement;
            int x = 0;
            int y = 0;
            return ValidateRelativePlant(scope, now(), RelativePlantStage::Selecting, board,
                                         placement, x, y, reason);
        }, scope.deadline);
    }
    bool move(const RelativePlantScope& scope, int x, int y) {
        return MoveInternalCursor(window, x, y, scope.command.epoch, false, 24.0, 0.0, scope.deadline) &&
               delay(scope.command.epoch, static_cast<DWORD>(CursorNoiseRange(38, 72)));
    }
    RelativePlantDispatch down(const RelativePlantScope& scope, int x, int y,
                               PlantPlacement& placement, std::string& reason) {
        SetCursorOverlayState(CursorOverlayState::Pressed);
        g_cursorOverlayButtonDown.store(true);
        const auto result = PostRelativePlant(window, scope, x, y, placement, reason);
        if (result != RelativePlantDispatch::Committed) {
            g_cursorOverlayButtonDown.store(false);
            SetCursorOverlayState(CursorOverlayState::Hover);
        }
        return result;
    }
    bool up(const RelativePlantScope& scope, int x, int y) {
        const bool current = delay(scope.command.epoch, static_cast<DWORD>(CursorNoiseRange(26, 46)));
        const bool released = PostLogicalMouse(window, InternalMouseAction::LeftUp, x, y);
        g_cursorOverlayButtonDown.store(false);
        SetCursorOverlayState(CursorOverlayState::Released);
        return released && current;
    }
    void release() {
        g_releaseHeldRequested.store(true);
        ReleaseHeldIfRequested();
    }
};

template <typename Input>
bool ExecuteRelativePlant(const Command& command, const BoardView& initial, int mode,
                          const CardView& card, const RawCardState& packet, Input& input,
                          PlantPlacement& committed, std::string& reason, bool apply = true) {
    if (!apply) return true;
    RelativePlantScope scope;
    if (!BindRelativePlant(command, initial, mode, packet,
            input.now() + kRelativePlantBudgetMs, scope, reason)) return false;
    BoardView board;
    PlantPlacement candidate;
    int x = 0;
    int y = 0;
    if (!ValidateRelativePlant(scope, input.now(), RelativePlantStage::Selecting, board,
                               candidate, x, y, reason)) return false;
    // Every exit after selection crosses the action worker's held-input release barrier.
    struct ReleaseOnFailure {
        Input& input;
        bool completed = false;
        ~ReleaseOnFailure() { if (!completed) input.release(); }
    } release{input};
    if (!input.select(scope, card, reason)) {
        if (reason.empty()) reason = "relative planting seed-bank click could not be posted";
        return false;
    }
    const ULONGLONG selectionDeadline = std::min(scope.deadline, input.now() + 750);
    while (true) {
        if (!ValidateRelativePlant(scope, input.now(), RelativePlantStage::Acquiring, board,
                                   candidate, x, y, reason)) return false;
        if (board.cursorType == 1) {
            if (RelativePlantCursorHoldsPacket(scope, board)) break;
            reason = "relative planting cursor picked up a different seed packet";
            return false;
        }
        if (board.cursorType != 0) {
            reason = "relative planting cursor was taken by another tool";
            return false;
        }
        if (input.now() >= selectionDeadline) {
            reason = "relative planting seed packet did not reach the cursor in time";
            return false;
        }
        if (!input.delay(command.epoch, 10)) {
            reason = "relative planting was cancelled";
            return false;
        }
    }
    for (int corrections = 0; ; ++corrections) {
        if (!ValidateRelativePlant(scope, input.now(), RelativePlantStage::Held, board,
                                   candidate, x, y, reason)) return false;
        if (!input.move(scope, x, y)) {
            reason = "relative planting cursor movement was interrupted";
            return false;
        }
        const auto result = input.down(scope, x, y, committed, reason);
        if (result == RelativePlantDispatch::CorrectCursor) {
            if (corrections < kRelativePlantCorrections) continue;
            reason = "relative planting target crossed cells beyond the cursor correction limit";
            return false;
        }
        if (result != RelativePlantDispatch::Committed) {
            if (reason.empty()) reason = "relative planting click result is unknown";
            return false;
        }
        if (!input.up(scope, x, y)) {
            reason = "relative planting release was not acknowledged";
            return false;
        }
        break;
    }
    const ULONGLONG verifyDeadline = std::min(scope.deadline, input.now() + 1500);
    while (ActionCurrent(command.epoch) && input.now() < verifyDeadline) {
        if (!ReadRelativePlantBoard(scope, board, reason)) return false;
        RawCardState after;
        if (ReadRawCardState(scope.board, command.slot, after) && after.bank == packet.bank &&
            PlantCursorReleased(IsWhackLevel(mode, board.level), board.cursorType) &&
            RawCardConsumed(HasConveyorSeedBank(mode, board.level), packet.type, packet.imitater,
                packet.timesUsed, packet.offsetX, after.present, after.type, after.imitater,
                after.timesUsed, after.offsetX, after.refreshing)) {
            release.completed = true;
            return true;
        }
        if (!input.delay(command.epoch, 10)) break;
    }
    reason = ActionCurrent(command.epoch)
        ? "relative planting seed packet was not observed being consumed"
        : "relative planting was cancelled after the click was delivered";
    return false;
}
