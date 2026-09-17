#include "../src/native/implant.cpp"
#include <cassert>

int main() {
    std::array<uint8_t, 0x5700> board{};
    std::array<uint8_t, 0x400> bank{};
    const uintptr_t boardAddress = reinterpret_cast<uintptr_t>(board.data());
    *reinterpret_cast<uintptr_t*>(board.data() + pvz::board::seedBank) = reinterpret_cast<uintptr_t>(bank.data());
    board[pvz::board::showShovel] = 1;
    const std::array<int, 5> leftEdges{456, 516, 532, 568, 609};
    for (int count = 6; count <= 10; ++count) {
        *reinterpret_cast<int*>(bank.data() + pvz::seedBank::packetCount) = count;
        int x = 0, y = 0;
        assert(ReadShovelButtonPoint(boardAddress, 16, x, y));
        assert(x > leftEdges[count - 6] && x < leftEdges[count - 6] + 70);
        assert(y > 0 && y < 72);
        assert(ReadShovelButtonPoint(boardAddress, 18, x, y));
        assert(x > 600 && x < 670);
    }
    board[pvz::board::showShovel] = 0;
    int x = 0, y = 0;
    assert(!ReadShovelButtonPoint(boardAddress, 17, x, y));
}
