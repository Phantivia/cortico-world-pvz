#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <functional>
#include "../src/native/profile.h"
void __fastcall FixtureRemapMouse(void*, void*, int&, int&);
bool __fastcall FixtureMouseMove(void*, void*, int, int);
bool __fastcall FixtureMouseDown(void*, void*, int, int, int);
LRESULT WINAPI FixtureSendMessageTimeoutW(HWND, UINT, WPARAM, LPARAM, UINT, UINT, PDWORD_PTR);
namespace pvz {
uintptr_t fixtureLawnAppSlot = 0;
const uintptr_t fixtureGlobalLawnApp = reinterpret_cast<uintptr_t>(&fixtureLawnAppSlot);
namespace widgetManager {
const uintptr_t fixtureRemapMouse = reinterpret_cast<uintptr_t>(&FixtureRemapMouse);
const uintptr_t fixtureMouseMove = reinterpret_cast<uintptr_t>(&FixtureMouseMove);
const uintptr_t fixtureMouseDown = reinterpret_cast<uintptr_t>(&FixtureMouseDown);
}
namespace title {
constexpr uintptr_t fixtureMouseDown = mouseDown;
}
}
#define kGlobalLawnApp fixtureGlobalLawnApp
#define remapMouse fixtureRemapMouse
#define mouseMove fixtureMouseMove
#define mouseDown fixtureMouseDown
#define SendMessageTimeoutW FixtureSendMessageTimeoutW
#include "../src/native/implant.cpp"
#undef kGlobalLawnApp
#undef remapMouse
#undef mouseMove
#undef mouseDown
#undef SendMessageTimeoutW
#include <cassert>
#include <cstdio>
#include <limits>

std::function<void()> fixtureGameMove;
std::function<void()> fixtureGameDown;
bool fixtureDropMessage = false;
bool fixtureDropAcknowledgement = false;
WPARAM fixtureLastToken = 0;

void __fastcall FixtureRemapMouse(void*, void*, int&, int&) {}
bool __fastcall FixtureMouseMove(void*, void*, int, int) {
    if (fixtureGameMove) fixtureGameMove();
    return true;
}
bool __fastcall FixtureMouseDown(void*, void*, int, int, int) {
    if (fixtureGameDown) fixtureGameDown();
    return true;
}
LRESULT WINAPI FixtureSendMessageTimeoutW(HWND window, UINT message, WPARAM wParam,
                                         LPARAM lParam, UINT flags, UINT timeout,
                                         PDWORD_PTR result) {
    fixtureLastToken = wParam;
    if (fixtureDropMessage) return 0;
    const LRESULT delivered = SendMessageTimeoutW(window, message, wParam, lParam, flags, timeout, result);
    return fixtureDropAcknowledgement ? 0 : delivered;
}

namespace {
template <size_t Size>
struct Memory {
    std::array<uint8_t, Size> bytes{};
    uintptr_t address() { return reinterpret_cast<uintptr_t>(bytes.data()); }
    template <typename T> void put(size_t offset, T value) {
        assert(offset + sizeof(value) <= Size);
        std::memcpy(bytes.data() + offset, &value, sizeof(value));
    }
};

struct Fixture {
    Memory<0x1000> app;
    Memory<0x5800> board;
    Memory<0x200> manager;
    Memory<0x100> bank;
    Memory<0x100> cursor;
    Memory<0x100> challenge;
    Memory<8 * pvz::dataArray::zombieStride> zombies;
    Memory<4 * pvz::dataArray::plantStride> plants;
    Command command;
    int mode = 0;

    Fixture() {
        g_validation.supported = true;
        g_actionEpoch.store(0);
        g_inputPosted = false;
        g_idBoard = 0;
        g_activeRun = {};
        g_activeRun.valid = true;
        g_activeRun.runId = 42;
        g_activeRun.boardAddress = board.address();
        g_activeRun.mode = mode;
        g_activeRun.level = 1;
        pvz::fixtureLawnAppSlot = app.address();
        app.put(0, pvz::kLawnAppVtable);
        app.put(4, pvz::kLawnAppSecondaryVtable);
        app.put(pvz::app::board, board.address());
        app.put(pvz::app::gameMode, mode);
        app.put(pvz::app::gameScene, 3);
        app.put(pvz::app::widgetManager, manager.address());
        board.put(pvz::board::level, 1);
        board.put(pvz::board::mainCounter, 100);
        board.put(pvz::board::sun, 1000);
        board.put(0x5618, -1);
        board.put(pvz::board::seedBank, bank.address());
        board.put(pvz::board::cursorObject, cursor.address());
        board.put(pvz::board::challenge, challenge.address());
        board.put(pvz::board::zombies, ArrayHeader{zombies.address(), 8, 8, 0, 8, 1, 0});
        board.put(pvz::board::plants, ArrayHeader{plants.address(), 4, 4, 0, 4, 1, 0});
        bank.put(pvz::seedBank::packetCount, 1);
        const size_t packet = pvz::seedBank::packets;
        bank.put(packet + 0x10, 50);
        bank.put(packet + 0x14, 70);
        bank.put(packet + 0x34, 3);
        bank.put(packet + 0x38, -1);
        bank.put(packet + 0x48, uint8_t{1});
        for (int column = 0; column < 9; ++column) {
            for (int row = 0; row < 6; ++row) square(row, column, 1);
        }
        command.kind = "plant";
        command.slot = 0;
        command.row = 3;
        command.minGap = 2;
        command.expectedCardType = 3;
        command.expectedCardImitates = -1;
        zombie(0, 608.0f);
    }

    template <typename T> void zput(int index, size_t offset, T value) {
        zombies.put(static_cast<size_t>(index) * pvz::dataArray::zombieStride + offset, value);
    }
    void zombie(int index, float x, int row = 2, uint32_t generation = 1) {
        zput(index, pvz::dataArray::zombieObjectSize, generation * 0x10000U + index);
        zput(index, 0x18, uint8_t{1});
        zput(index, 0x1C, row);
        zput(index, 0x24, 0);
        zput(index, 0x28, 0);
        zput(index, 0x2C, x);
        zput(index, 0x30, 230.0f);
        zput(index, 0x34, 0.25f);
        zput(index, 0x94, 80);
        zput(index, 0x98, 100);
        zput(index, 0xC8, 270);
        zput(index, 0xCC, 270);
        zput(index, 0xBC, uint8_t{1});
    }
    void plant(int index, int type, int row, int column) {
        const size_t at = static_cast<size_t>(index) * pvz::dataArray::plantStride;
        plants.put(at + pvz::dataArray::plantObjectSize, 0x10000U + index);
        plants.put(at + 0x18, uint8_t{1});
        plants.put(at + 0x144, uint8_t{1});
        plants.put(at + 0x24, type);
        plants.put(at + 0x1C, row);
        plants.put(at + 0x28, column);
        plants.put(at + 0x08, column * 80 + 40);
        plants.put(at + 0x10, 80);
    }
    void square(int row, int column, int type) {
        board.put(pvz::board::gridSquareType + (column * 6 + row) * sizeof(int), type);
    }
    // Taking a packet onto the cursor clears its seed-bank active flag; the seed bank hands it
    // back when the cursor is cleared. Everything after the seed-bank click depends on this.
    void hold() {
        cursor.put(0x30, 1);
        cursor.put(0x24, command.slot);
        cursor.put(0x28, command.expectedCardType);
        cursor.put(0x2C, command.expectedCardImitates);
        bank.put(pvz::seedBank::packets + 0x48, uint8_t{0});
    }
    void drop() {
        cursor.put(0x30, 0);
        bank.put(pvz::seedBank::packets + 0x48, uint8_t{1});
    }
    void consume(const PlantPlacement& placement) {
        cursor.put(0x30, 0);
        bank.put(pvz::seedBank::packets + 0x4C, 1);
        bank.put(pvz::seedBank::packets + 0x49, uint8_t{1});
        plant(0, 3, placement.row - 1, placement.column - 1);
    }
    BoardView read() {
        BoardView result;
        assert(ReadBoard(app.address(), mode, result));
        return result;
    }
    RawCardState packet() {
        RawCardState result;
        assert(ReadRawCardState(board.address(), 0, result));
        return result;
    }
    RelativePlantScope bind() {
        RelativePlantScope result;
        std::string reason;
        assert(BindRelativePlant(command, read(), mode, packet(), 20001, result, reason));
        return result;
    }
};

struct ControlledInput {
    Fixture& fixture;
    ULONGLONG tick = 1;
    int selections = 0;
    int movements = 0;
    int dispatches = 0;
    int presses = 0;
    int releases = 0;
    int barriers = 0;
    bool uncertainDown = false;
    bool uncertainUp = false;
    bool missingSelection = false;
    bool selectionFailed = false;
    bool consumeCard = true;
    int lastUpX = 0;
    int lastUpY = 0;
    std::function<void()> onSelect;
    std::function<void()> onMove;
    std::function<void()> beforeDown;
    std::function<void()> afterDown;

    ULONGLONG now() { return tick; }
    bool delay(ULONGLONG epoch, DWORD ms) { tick += ms; return ActionCurrent(epoch); }
    bool select(const RelativePlantScope&, const CardView&, std::string&) {
        ++selections;
        if (!missingSelection) fixture.hold();
        if (onSelect) onSelect();
        return !selectionFailed;
    }
    bool move(const RelativePlantScope&, int, int) {
        ++movements;
        tick += 100;
        if (onMove) onMove();
        return true;
    }
    RelativePlantDispatch down(const RelativePlantScope& scope, int x, int y,
                               PlantPlacement& committed, std::string& reason) {
        ++dispatches;
        if (beforeDown) beforeDown();
        RelativePlantRequest request;
        request.scope = scope;
        const auto result = CommitRelativePlant(request, x, y, [&] { return tick; }, [&] {
            ++presses;
            if (consumeCard) fixture.consume(request.placement);
            if (afterDown) afterDown();
            return true;
        });
        reason = request.reason;
        if (result == RelativePlantDispatch::Committed) {
            if (uncertainDown) return RelativePlantDispatch::Uncertain;
            committed = request.placement;
        }
        return result;
    }
    bool up(const RelativePlantScope&, int x, int y) {
        ++releases;
        lastUpX = x;
        lastUpY = y;
        return !uncertainUp;
    }
    void release() {
        ++barriers;
        fixture.drop();
    }
    bool execute(PlantPlacement& placement, std::string& reason, bool apply = true) {
        const auto board = fixture.read();
        return ExecuteRelativePlant(fixture.command, board, fixture.mode, board.cards.front(),
                                    fixture.packet(), *this, placement, reason, apply);
    }
};

void parsing() {
    const auto parse = [](const std::string& fields, Command& command) {
        std::string reason;
        return ParseCommand("{\"type\":\"command\",\"protocol\":2,\"id\":\"fixture\","
                            "\"kind\":\"plant\",\"slot\":0,\"row\":3," + fields + "}", command, reason);
    };
    for (int gap : {0, 2, 8}) {
        Command command;
        assert(parse("\"aheadOf\":{\"minGap\":" + std::to_string(gap) + "}", command));
        assert(command.minGap == gap && command.column == -1);
    }
    Command fixed;
    assert(parse("\"column\":5", fixed) && fixed.column == 5 && fixed.minGap == -1);
    for (const char* invalid : {
            "\"column\":0", "\"column\":2.5", "\"column\":1e0", "\"column\":true",
            "\"aheadOf\":null", "\"aheadOf\":[]", "\"aheadOf\":{}",
            "\"aheadOf\":{\"minGap\":-1}", "\"aheadOf\":{\"minGap\":9}",
            "\"aheadOf\":{\"minGap\":1.5}", "\"aheadOf\":{\"minGap\":1e0}",
            "\"aheadOf\":{\"minGap\":true}", "\"aheadOf\":{\"minGap\":\"2\"}",
            "\"aheadOf\":{\"minGap\":999999999999999999999}",
            "\"aheadOf\":{\"minGap\":2,\"minGap\":3}",
            "\"aheadOf\":{\"minGap\":2,\"other\":0}",
            "\"aheadOf\":{\"minGap\":2},\"column\":5",
            "\"aheadOf\":{\"minGap\":2},\"column\":null",
            "\"aheadOf\":{\"minGap\":2},\"aheadOf\":{\"minGap\":1}",
            "\"aheadOf\":{\"minGap\":2},\"row\":2.1"}) {
        Command command;
        assert(!parse(invalid, command));
    }
    std::puts("PASS parsing");
}

void selection() {
    Fixture f;
    f.zombie(1, 100.0f, 1);
    f.zombie(2, 540.0f);
    f.zombie(3, 540.0f);
    f.zombie(4, 160.0f);
    f.zput(4, 0xB8, uint8_t{1});
    f.zombie(5, 240.0f);
    f.zput(5, 0x28, 1);
    f.zombie(6, 320.0f);
    f.zput(6, 0x18, uint8_t{0});
    f.zombie(7, 400.0f);
    f.zput(7, 0xC8, 0);
    assert(f.bind().targetId == 0x10002);
    RelativePlantScope scope;
    std::string reason;
    const auto bindFails = [&] {
        return !BindRelativePlant(f.command, f.read(), f.mode, f.packet(), 1000, scope, reason);
    };
    f.zput(2, 0x34, -0.25f);
    assert(bindFails() && reason.find("moving away from the house") != std::string::npos);
    f.zput(2, 0x34, 0.25f);
    f.zput(2, 0xB9, uint8_t{1});
    assert(bindFails() && reason.find("off the ground") != std::string::npos);
    f.zput(2, 0xB9, uint8_t{0});
    f.zput(2, 0x28, 40);
    f.zput(2, 0x51, uint8_t{1});
    f.zput(2, 0xB0, 20);
    assert(bindFails() && reason.find("no known houseward direction") != std::string::npos);
    for (int phase : {12, 16, 17, 20, 32, 33, 36, 37, 40, 52, 54, 63, 71, 73, 78, 92, 96}) {
        f.zput(2, 0x28, phase);
        assert(!BindRelativePlant(f.command, f.read(), f.mode, f.packet(), 1000, scope, reason));
    }
    f.zput(2, 0x28, 0);
    f.zput(2, 0x24, 19);
    f.zput(2, 0xBC, uint8_t{0});
    assert(!BindRelativePlant(f.command, f.read(), f.mode, f.packet(), 1000, scope, reason));
    std::puts("PASS nearest-hostile selection and unsupported phases");
}

void coordinatesAndCells() {
    Fixture f;
    f.hold();
    auto scope = f.bind();
    auto validate = [&](PlantPlacement& cell, std::string& reason) {
        BoardView board;
        int x = 0;
        int y = 0;
        return ValidateRelativePlant(scope, 1, RelativePlantStage::Held, board, cell, x, y, reason);
    };
    PlantPlacement cell;
    std::string reason;
    // The cell changes at the half-cell boundary the game uses to assign a zombie its column,
    // not half a cell behind it.
    for (const auto& example : {std::pair<float, int>{608.0f, 6}, {600.0f, 6},
                                {599.99f, 5}, {560.0f, 5}}) {
        f.zput(0, 0x2C, example.first);
        assert(validate(cell, reason) && cell.column == example.second && cell.row == 3);
    }
    scope.command.minGap = 0;
    for (float position : {40.0f, 199.99f, 200.0f, 560.0f, 608.0f, 759.99f}) {
        f.zput(0, 0x2C, position);
        assert(validate(cell, reason) && cell.column == f.read().zombies.front().column + 1);
    }
    // Nothing is clamped past the last cell: that target has not walked onto the board yet.
    f.zput(0, 0x2C, 760.0f);
    assert(!validate(cell, reason) && reason.find("outside the board") != std::string::npos);
    // A target at the house resolves before the first column and lands on it instead, and that
    // cell still has to pass the cell checks.
    f.zput(0, 0x2C, 16.0f);
    assert(validate(cell, reason) && cell.column == 1);
    scope.command.minGap = 8;
    f.zput(0, 0x2C, 560.0f);
    assert(validate(cell, reason) && cell.column == 1);
    // The first column is the only cell left ahead of that target; when it refuses the plant
    // there is nothing to fall back to.
    f.square(2, 0, 2);
    assert(!validate(cell, reason) && reason.find("no cell ahead of the target") != std::string::npos);
    f.square(2, 0, 1);
    // minGap is a lower bound: a cell that refuses the plant hands the landing to the next one
    // toward the house, and a carrier or a cleared cell hands it back.
    scope.command.minGap = 2;
    f.square(2, 4, 3);
    assert(validate(cell, reason) && cell.column == 4);
    f.plant(0, 16, 2, 4);
    assert(validate(cell, reason) && cell.column == 5);
    f.plant(1, 0, 2, 4);
    assert(validate(cell, reason) && cell.column == 4);
    f.plants.bytes.fill(0);
    f.square(2, 4, 4);
    assert(validate(cell, reason) && cell.column == 4);
    f.plant(0, 33, 2, 4);
    assert(validate(cell, reason) && cell.column == 5);
    for (int column = 0; column < 5; ++column) f.square(2, column, 2);
    assert(!validate(cell, reason) && reason.find("no cell ahead of the target") != std::string::npos);
    for (int column = 0; column < 5; ++column) f.square(2, column, 1);
    assert(validate(cell, reason) && cell.column == 5);
    f.bank.put(pvz::seedBank::packets + 0x34, 0);
    assert(!validate(cell, reason) &&
           reason.find("no longer holds the bound plant") != std::string::npos);
    f.bank.put(pvz::seedBank::packets + 0x34, 3);
    f.bank.put(pvz::seedBank::packets + 0x4C, 1);
    assert(!validate(cell, reason) && reason.find("already spent") != std::string::npos);
    std::puts("PASS float coordinates, bounds, layers, bases and cards");
}

void cardContractAcrossStages() {
    Fixture f;
    auto scope = f.bind();
    PlantPlacement cell;
    std::string reason;
    const auto validate = [&](RelativePlantStage stage) {
        BoardView board;
        int x = 0;
        int y = 0;
        return ValidateRelativePlant(scope, 1, stage, board, cell, x, y, reason);
    };
    const size_t packet = pvz::seedBank::packets;
    assert(validate(RelativePlantStage::Selecting));
    f.bank.put(packet + 0x49, uint8_t{1});
    assert(!validate(RelativePlantStage::Selecting) &&
           reason.find("still on cooldown") != std::string::npos);
    f.bank.put(packet + 0x49, uint8_t{0});
    f.bank.put(packet + 0x24, 100);
    assert(!validate(RelativePlantStage::Selecting) &&
           reason.find("still on cooldown") != std::string::npos);
    f.bank.put(packet + 0x24, 0);
    f.board.put(pvz::board::sun, 0);
    assert(!validate(RelativePlantStage::Selecting) &&
           reason.find("more sun than is available") != std::string::npos);
    f.board.put(pvz::board::sun, 1000);
    f.bank.put(packet + 0x48, uint8_t{0});
    assert(!validate(RelativePlantStage::Selecting) &&
           reason.find("not active in the seed bank") != std::string::npos);
    assert(!validate(RelativePlantStage::Held) &&
           reason.find("no longer holding a seed packet") != std::string::npos);

    // From the seed-bank click onward the packet is on the cursor, so the seed bank reports it
    // inactive and its cooldown and cost no longer describe anything this action can act on.
    f.hold();
    f.bank.put(packet + 0x49, uint8_t{1});
    f.bank.put(packet + 0x24, 100);
    f.board.put(pvz::board::sun, 0);
    assert(validate(RelativePlantStage::Acquiring));
    assert(validate(RelativePlantStage::Held));
    f.bank.put(packet + 0x49, uint8_t{0});
    f.bank.put(packet + 0x24, 0);
    f.board.put(pvz::board::sun, 1000);
    f.cursor.put(0x24, 1);
    assert(!validate(RelativePlantStage::Held) &&
           reason.find("holding a different seed packet") != std::string::npos);
    assert(validate(RelativePlantStage::Acquiring));
    f.cursor.put(0x24, 0);
    f.cursor.put(0x28, 0);
    assert(!validate(RelativePlantStage::Held) &&
           reason.find("holding a different seed packet") != std::string::npos);
    std::puts("PASS seed packet contract turns from pickable into still held at selection");
}

void noAdmissionBinding() {
    Fixture f;
    f.zombies.bytes.fill(0);
    ControlledInput input{f};
    PlantPlacement committed;
    std::string reason;
    assert(input.execute(committed, reason, false));
    assert(input.selections == 0 && input.dispatches == 0 && committed.targetId == 0);
    f.zombie(1, 500.0f);
    assert(input.execute(committed, reason));
    assert(committed.targetId == 0x10001 && committed.column == 4);
    std::puts("PASS admission leaves target unbound until execution");
}

void correctionAndCommit() {
    Fixture f;
    ControlledInput input{f};
    // Selection empties the sun bar and takes the packet out of the seed bank; neither ends the
    // action, because the plant is already on the cursor.
    input.onSelect = [&] {
        f.zput(0, 0x2C, 559.99f);
        f.zombie(1, 300.0f);
        f.board.put(pvz::board::sun, 0);
    };
    input.beforeDown = [&] { if (input.dispatches == 1) f.zput(0, 0x2C, 479.99f); };
    input.afterDown = [&] { f.zput(0, 0x2C, 100.0f); };
    PlantPlacement committed;
    std::string reason;
    const bool executed = input.execute(committed, reason);
    if (!executed) std::fprintf(stderr, "commit fixture: %s\n", reason.c_str());
    assert(executed);
    assert(input.selections == 1 && input.movements == 2 && input.dispatches == 2);
    assert(input.presses == 1 && input.releases == 1 && input.barriers == 0);
    assert(committed.targetId == 0x10000 && committed.runId == 42);
    assert(committed.row == 3 && committed.column == 4 && input.lastUpX == 320 && input.lastUpY == 330);
    const auto current = f.read();
    assert(current.plants.size() == 1 && current.plants.front().column + 1 == committed.column);
    std::string output = "{";
    AppendPlantPlacement(output, committed);
    int column = 0;
    assert(pvz::json::Integer(output, "column", column) && column == 4);
    std::puts("PASS selection-time and game-thread correction with committed-cell evidence");
}

void invalidation() {
    const std::vector<std::function<void(Fixture&)>> invalidate{
        [](Fixture& f) { f.zput(0, 0xC8, 0); },
        [](Fixture& f) { f.zput(0, 0x28, 2); },
        [](Fixture& f) { f.zput(0, 0xEC, uint8_t{1}); },
        [](Fixture& f) { f.zput(0, 0x18, uint8_t{0}); },
        [](Fixture& f) { f.zput(0, 0xB8, uint8_t{1}); },
        [](Fixture& f) { f.zput(0, 0x1C, 1); },
        [](Fixture& f) { f.zombie(0, 608.0f, 2, 2); },
        [](Fixture& f) { f.zput(0, 0x28, 40); f.zput(0, 0x51, uint8_t{1}); },
        [](Fixture& f) { f.zput(0, 0x34, -0.5f); },
        [](Fixture& f) { f.zput(0, 0x2C, std::numeric_limits<float>::quiet_NaN()); },
        [](Fixture& f) { f.cursor.put(0x28, 0); },
        [](Fixture& f) { f.bank.put(pvz::seedBank::packets + 0x4C, 1); },
        [](Fixture& f) { f.board.put(pvz::board::mainCounter, 99); },
        [](Fixture& f) { f.board.put(pvz::board::paused, uint8_t{1}); },
        [](Fixture& f) { f.board.put(pvz::board::levelComplete, uint8_t{1}); },
        [](Fixture& f) { f.app.put(pvz::app::board, uintptr_t{0}); },
        [](Fixture& f) { f.app.put(pvz::app::gameScene, 2); },
        [](Fixture& f) { f.app.put(pvz::app::gameMode, 1); },
        [](Fixture& f) { f.challenge.put(0x6C, 1); },
        [](Fixture&) { ++g_activeRun.runId; },
        [](Fixture&) { g_activeRun.valid = false; },
        [](Fixture&) { g_actionEpoch.fetch_add(1); },
    };
    for (bool duringSelection : {false, true}) {
        for (const auto& change : invalidate) {
            Fixture f;
            f.zombie(1, 700.0f);
            ControlledInput input{f};
            if (duringSelection) input.onSelect = [&] { change(f); };
            else input.beforeDown = [&] { change(f); };
            PlantPlacement committed;
            std::string reason;
            assert(!input.execute(committed, reason));
            assert(input.presses == 0 && input.barriers == 1 && committed.targetId == 0);
            assert(!reason.empty() && Field<int>(f.cursor.bytes, 0x30) == 0);
        }
        // A plant appearing on the landing cell mid-input moves the landing one cell toward
        // the house instead of ending the action: minGap is a lower bound.
        Fixture f;
        f.zombie(1, 700.0f);
        ControlledInput input{f};
        const auto occupy = [&] { f.plant(1, 0, 2, 5); };
        if (duringSelection) input.onSelect = occupy;
        else input.beforeDown = occupy;
        PlantPlacement committed;
        std::string reason;
        assert(input.execute(committed, reason));
        assert(input.presses == 1 && committed.column == 5);
    }
    std::puts("PASS identity, row, death, phase, run, epoch, visibility and cell invalidation");
}

void visibility() {
    {
        Fixture f;
        f.board.put(pvz::board::background, 3);
        ControlledInput input{f};
        input.beforeDown = [&] {
            // Both adjacent fog columns become opaque while the cursor is moving.
            for (int column : {6, 7}) for (int row : {2, 3}) {
                f.board.put(pvz::board::fogGrid + (column * 7 + row) * sizeof(int), 255);
            }
        };
        PlantPlacement committed;
        std::string reason;
        assert(!input.execute(committed, reason) && input.presses == 0 && input.barriers == 1);
    }
    {
        Fixture f;
        f.board.put(pvz::board::level, 40);
        g_activeRun.level = 40;
        f.challenge.put(0x54, 5);
        f.challenge.put(0x58, 100);
        ControlledInput input{f};
        input.beforeDown = [&] { f.challenge.put(0x54, 0); };
        PlantPlacement committed;
        std::string reason;
        assert(!input.execute(committed, reason) && input.presses == 0 && input.barriers == 1);
    }
    std::puts("PASS fog and storm disclosure at commit");
}

void boundedAndUncertain() {
    {
        Fixture f;
        ControlledInput input{f};
        input.beforeDown = [&] { f.zput(0, 0x2C, 608.0f - input.dispatches * 80.0f); };
        PlantPlacement committed;
        std::string reason;
        assert(!input.execute(committed, reason));
        assert(input.movements == 3 && input.dispatches == 3 && input.presses == 0 && input.barriers == 1);
    }
    {
        Fixture f;
        ControlledInput input{f};
        input.onMove = [&] { input.tick += kRelativePlantBudgetMs; };
        PlantPlacement committed;
        std::string reason;
        assert(!input.execute(committed, reason) && input.presses == 0 && input.barriers == 1);
    }
    for (int uncertainty = 0; uncertainty < 5; ++uncertainty) {
        Fixture f;
        ControlledInput input{f};
        input.uncertainDown = uncertainty == 0;
        input.uncertainUp = uncertainty == 1;
        input.missingSelection = uncertainty == 2;
        input.selectionFailed = uncertainty == 3;
        input.consumeCard = uncertainty != 4;
        PlantPlacement committed;
        std::string reason;
        assert(!input.execute(committed, reason));
        assert(input.selections == 1 && input.presses <= 1 && input.barriers == 1);
        assert(f.read().cursorType == 0);
    }
    {
        Fixture f;
        f.hold();
        RelativePlantRequest request;
        request.scope = f.bind();
        request.withdrawn.store(true);
        int presses = 0;
        const auto outcome = CommitRelativePlant(request, 400, 330, [] { return 1ULL; }, [&] {
            ++presses;
            return true;
        });
        assert(outcome == RelativePlantDispatch::Rejected && presses == 0);
        g_relativePlantToken = 10;
        g_relativePlantRequest = std::make_shared<RelativePlantRequest>();
        assert(DispatchRelativePlantMessage(9) == static_cast<LRESULT>(RelativePlantDispatch::Rejected));
        g_relativePlantRequest.reset();
    }
    std::puts("PASS correction and deadline bounds, release barrier, uncertain dispatch without retry");
}

void windowDispatch() {
    const auto oldDpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    assert(oldDpi);
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = DefWindowProcW;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.lpszClassName = L"RelativePlantFixture";
    assert(RegisterClassW(&windowClass));
    HWND window = CreateWindowExW(0, windowClass.lpszClassName, L"", WS_POPUP,
                                  0, 0, 800, 600, nullptr, nullptr, windowClass.hInstance, nullptr);
    assert(window && !IsWindowVisible(window) && HasManagedClientSize(window));
    g_captureBypassInstalled.store(true);
    g_internalMouseWindow.store(window);
    g_originalWindowProc.store(DefWindowProcW);
    assert(SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&InternalMouseWindowProc)));
    Fixture f;
    f.hold();
    auto scope = f.bind();
    scope.deadline = GetTickCount64() + kRelativePlantBudgetMs;
    int presses = 0;
    fixtureGameDown = [&] { ++presses; };
    fixtureGameMove = [&] { f.zput(0, 0x2C, 559.99f); };
    PlantPlacement committed;
    std::string reason;
    assert(PostRelativePlant(window, scope, 480, 330, committed, reason) == RelativePlantDispatch::CorrectCursor);
    assert(presses == 0 && committed.targetId == 0);
    assert(PostRelativePlant(window, scope, 400, 330, committed, reason) == RelativePlantDispatch::Committed);
    assert(presses == 1 && committed.column == 5 && committed.targetId == scope.targetId);
    committed = {};
    fixtureGameMove = [&] { g_actionEpoch.fetch_add(1); };
    assert(PostRelativePlant(window, scope, 400, 330, committed, reason) == RelativePlantDispatch::Rejected);
    assert(presses == 1 && committed.targetId == 0);
    fixtureGameMove = {};
    g_actionEpoch.store(0);
    fixtureDropMessage = true;
    assert(PostRelativePlant(window, scope, 400, 330, committed, reason) == RelativePlantDispatch::Uncertain);
    fixtureDropMessage = false;
    assert(SendMessageW(window, kRelativePlantWindowMessage, fixtureLastToken, 0) ==
           static_cast<LRESULT>(RelativePlantDispatch::Rejected));
    assert(presses == 1 && committed.targetId == 0);
    fixtureDropAcknowledgement = true;
    assert(PostRelativePlant(window, scope, 400, 330, committed, reason) == RelativePlantDispatch::Uncertain);
    fixtureDropAcknowledgement = false;
    assert(presses == 2 && committed.targetId == 0);
    fixtureGameDown = {};
    SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(DefWindowProcW));
    g_originalWindowProc.store(nullptr);
    g_internalMouseWindow.store(nullptr);
    assert(DestroyWindow(window));
    assert(UnregisterClassW(windowClass.lpszClassName, windowClass.hInstance));
    SetThreadDpiAwarenessContext(oldDpi);
    std::puts("PASS window-procedure commit and delayed or unacknowledged dispatch");
}
struct RosterFixture {
    Memory<0x1000> app;
    Memory<0x100> manager;
    Memory<0x40> profiles;
    Memory<0x200> dialog;
    Memory<0x130> list;
    Memory<0x130> confirm;
    Memory<0x130> cancel;
    Memory<9 * pvz::userDialog::listLineStride> lines;
    std::array<std::array<wchar_t, 16>, 8> names{};

    explicit RosterFixture(int count = 4) {
        app.put(pvz::app::widgetManager, manager.address());
        app.put(pvz::app::profileManager, profiles.address());
        profiles.put(pvz::profileManager::userCount, count);
        manager.put(0xAC, dialog.address());
        dialog.put(0, pvz::userDialog::vtable);
        dialog.put(0x154, pvz::userDialog::dialogId);
        dialog.put(0x178, confirm.address());
        dialog.put(0x17C, cancel.address());
        dialog.put(pvz::userDialog::userList, list.address());
        dialog.put(pvz::userDialog::numUsers, count);
        dialog.put(pvz::userDialog::listManager, manager.address());
        dialog.put(pvz::widget::x, 100);
        dialog.put(pvz::widget::y, 50);
        list.put(0, pvz::userDialog::listVtable);
        list.put(pvz::userDialog::listParent, dialog.address());
        list.put(pvz::userDialog::listManager, manager.address());
        list.put(pvz::userDialog::listVisible, uint8_t{1});
        list.put(pvz::userDialog::listMouseVisible, uint8_t{1});
        list.put(pvz::userDialog::listLinesBegin, lines.address());
        list.put(pvz::userDialog::listLinesEnd, lines.address() +
            static_cast<uintptr_t>(count + (count < 8 ? 1 : 0)) * pvz::userDialog::listLineStride);
        list.put(pvz::userDialog::listPosition, 0.0);
        list.put(pvz::userDialog::listSelectedIndex, 0);
        list.put(pvz::userDialog::listItemHeight, 24);
        list.put(pvz::widget::x, 30);
        list.put(pvz::widget::y, 70);
        list.put(pvz::widget::width, 270);
        list.put(pvz::widget::height, 200);
        for (int index = 0; index < count; ++index) {
            const std::wstring name = L"Player" + std::to_wstring(index);
            nameAt(index, name);
        }
        for (auto* button : { &confirm, &cancel }) {
            button->put(pvz::widget::width, 100);
            button->put(pvz::widget::height, 40);
            button->put(pvz::widget::y, 300);
            button->put(0x64, uint8_t{1});
            button->put(0x65, uint8_t{1});
        }
        cancel.put(pvz::widget::x, 150);
    }

    void nameAt(int index, const std::wstring& value) {
        assert(value.size() <= 12);
        const size_t offset = index * pvz::userDialog::listLineStride;
        std::memcpy(names[index].data(), value.c_str(), (value.size() + 1) * sizeof(wchar_t));
        lines.put(offset + pvz::player::nameLength, static_cast<int>(value.size()));
        lines.put(offset + pvz::player::nameCapacity, value.size() <= 7 ? 7 : 15);
        if (value.size() > 7) {
            lines.put(offset + pvz::player::nameStorage, reinterpret_cast<uintptr_t>(names[index].data()));
        } else {
            std::memcpy(lines.bytes.data() + offset + pvz::player::nameStorage,
                        value.c_str(), (value.size() + 1) * sizeof(wchar_t));
        }
    }

    std::vector<MenuControl> controls() { return CollectMenuControls("dialog", app.address(), 0); }
};

const MenuControl* find(const std::vector<MenuControl>& controls, const char* id) {
    const auto value = std::find_if(controls.begin(), controls.end(),
        [&](const MenuControl& item) { return item.id == id; });
    return value == controls.end() ? nullptr : &*value;
}

void userDialog() {
    RosterFixture fixture;
    fixture.nameAt(0, L"Birch");
    fixture.nameAt(1, L"LongerName");
    fixture.nameAt(2, L"\u6625\u6749");
    auto controls = fixture.controls();
    assert(controls.size() == 7);
    assert(find(controls, "profile:Birch")->state == "selected");
    assert(find(controls, "profile:LongerName")->x == 265);
    assert(find(controls, "profile:LongerName")->y == 160);
    assert(find(controls, "profile:\xe6\x98\xa5\xe6\x9d\x89"));
    assert(find(controls, "profile_create") && find(controls, "confirm") && find(controls, "cancel"));

    fixture.list.put(pvz::userDialog::listSelectedIndex, 1);
    controls = fixture.controls();
    assert(find(controls, "profile:LongerName")->state == "selected");
    assert(find(controls, "profile:Birch")->state.empty());
    std::string dialogJson;
    AppendDialog(dialogJson, fixture.app.address());
    assert(dialogJson.find("\"hasPrimary\":true") != std::string::npos);

    fixture.list.put(pvz::userDialog::listPosition, 1.25);
    controls = fixture.controls();
    assert(!find(controls, "profile:Birch"));
    assert(find(controls, "profile:LongerName")->y == 130);
    fixture.confirm.put(0x66, uint8_t{1});
    controls = fixture.controls();
    assert(find(controls, "confirm") && !find(controls, "confirm")->enabled);
    fixture.list.put(pvz::userDialog::listDisabled, uint8_t{1});
    controls = fixture.controls();
    assert(!find(controls, "profile:LongerName")->enabled && !find(controls, "confirm"));
    fixture.list.put(pvz::userDialog::listVisible, uint8_t{0});
    controls = fixture.controls();
    assert(controls.size() == 1 && controls[0].id == "cancel");

    RosterFixture full(8);
    controls = full.controls();
    assert(controls.size() == 10 && !find(controls, "profile_create"));
    assert(find(controls, "profile:Player7"));
    full.list.put(pvz::userDialog::listLinesEnd, full.lines.address() + 7 * pvz::userDialog::listLineStride);
    controls = full.controls();
    assert(controls.size() == 1 && controls[0].id == "cancel");

    RosterFixture empty(0);
    controls = empty.controls();
    assert(controls.size() == 2 && find(controls, "profile_create") && !find(controls, "confirm"));
    std::puts("native user-dialog memory fixtures passed");
}

}

int main() {
    parsing();
    selection();
    coordinatesAndCells();
    cardContractAcrossStages();
    noAdmissionBinding();
    correctionAndCommit();
    invalidation();
    visibility();
    boundedAndUncertain();
    windowDispatch();
    userDialog();
    std::puts("native relative planting fixtures passed");
}
