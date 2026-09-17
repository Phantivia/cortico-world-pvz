#include "../src/native/implant.cpp"
#include <cassert>

int main() {
    std::array<uint8_t, 0xA00> app{};
    std::array<uint8_t, 0x5800> board{};
    const auto appAddress = reinterpret_cast<uintptr_t>(app.data());
    const auto boardAddress = reinterpret_cast<uintptr_t>(board.data());
    *reinterpret_cast<int*>(app.data() + pvz::app::gameScene) = 3;
    *reinterpret_cast<int*>(app.data() + pvz::app::gameMode) = 25;
    *reinterpret_cast<uintptr_t*>(app.data() + pvz::app::board) = boardAddress;
    *reinterpret_cast<int*>(board.data() + pvz::board::level) = 0;
    auto& counter = *reinterpret_cast<int*>(board.data() + pvz::board::mainCounter);
    counter = 500;
    assert(StableAppBoardTuple(appAddress, 3, 25, boardAddress, 0, 500));
    counter = 501;
    assert(StableAppBoardTuple(appAddress, 3, 25, boardAddress, 0, 500));
    counter = 499;
    assert(!StableAppBoardTuple(appAddress, 3, 25, boardAddress, 0, 500));
    counter = 501;
    assert(!StableAppBoardTuple(appAddress, 3, 26, boardAddress, 0, 500));
    assert(!StableAppBoardTuple(appAddress, 2, 25, boardAddress, 0, 500));
    assert(!StableAppBoardTuple(appAddress, 3, 25, boardAddress, 1, 500));
    *reinterpret_cast<uintptr_t*>(app.data() + pvz::app::board) = 0;
    assert(!StableAppBoardTuple(appAddress, 3, 25, boardAddress, 0, 500));
}
