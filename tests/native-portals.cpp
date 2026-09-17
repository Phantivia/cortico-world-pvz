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
    Memory<6 * pvz::dataArray::gridItemStride> items;
    app.put(pvz::app::board, board.address());
    board.put(pvz::board::background, 1);
    board.put(pvz::board::gridItems, ArrayHeader{items.address(), 6, 6, 0, 6, 1, 0});
    const auto item = [&](int index, int type, int row, int column) {
        const size_t at = index * pvz::dataArray::gridItemStride;
        items.put(at + pvz::dataArray::gridItemObjectSize, 0x10000U + index);
        items.put(at + 0x08, type);
        items.put(at + 0x10, column);
        items.put(at + 0x14, row);
    };
    item(0, 5, 0, 2);
    item(1, 5, 1, 9);
    item(2, 4, 3, 9);
    item(3, 4, 4, 2);
    item(4, 1, 1, 9);
    item(5, 5, 1, 10);
    BoardView view;
    assert(ReadBoard(app.address(), 26, view));
    assert(view.gridItems.size() == 4);
    assert(view.gridItems[1].column == 9 && view.gridItems[2].column == 9);
    items.put(pvz::dataArray::gridItemStride + 0x20, uint8_t{1});
    assert(ReadBoard(app.address(), 26, view = {}));
    assert(view.gridItems.size() == 3);
    assert(ReadBoard(app.address(), 0, view = {}));
    assert(view.gridItems.size() == 2);
}
