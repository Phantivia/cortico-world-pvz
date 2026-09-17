#include "../src/native/implant.cpp"
#include <cassert>

template <size_t Size> struct Memory {
    std::array<uint8_t, Size> bytes{};
    uintptr_t address() { return reinterpret_cast<uintptr_t>(bytes.data()); }
    template <typename T> void put(size_t offset, T value) {
        assert(offset + sizeof(value) <= Size);
        std::memcpy(bytes.data() + offset, &value, sizeof(value));
    }
};

int main() {
    Memory<0x1000> app;
    Memory<0x5800> board;
    Memory<4 * pvz::dataArray::coinStride> coins;
    app.put(pvz::app::board, board.address());
    board.put(pvz::board::background, 3);
    board.put(pvz::board::coins, ArrayHeader{coins.address(), 4, 4, 0, 4, 1, 0});
    for (int cell = 0; cell < 9 * 7; ++cell) {
        board.put(pvz::board::fogGrid + cell * sizeof(int), 255);
    }
    const auto coin = [&](int index, int type, int order, float left) {
        const size_t at = index * pvz::dataArray::coinStride;
        coins.put(at + pvz::dataArray::coinObjectSize, 0x10000U + index);
        coins.put(at + 0x10, 50);
        coins.put(at + 0x14, 70);
        coins.put(at + 0x18, uint8_t{1});
        coins.put(at + 0x20, order);
        coins.put(at + 0x24, left);
        coins.put(at + 0x28, 300.0f);
        coins.put(at + 0x58, type);
        coins.put(at + 0x68, 16);
    };
    coin(0, 16, 500002, 600.0f);
    coin(1, 4, 600001, 650.0f);
    coin(2, 16, 400000, 600.0f);
    coin(3, 16, 500002, 900.0f);
    BoardView view;
    assert(ReadBoard(app.address(), 19, view));
    assert(view.collectibles.size() == 2);
    assert(view.collectibles[0].type == 16);
    assert(view.collectibles[1].type == 4);
    coins.put(0x50, uint8_t{1});
    assert(ReadBoard(app.address(), 19, view = {}));
    assert(view.collectibles.size() == 1 && view.collectibles[0].type == 4);
}
