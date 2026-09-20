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
    Memory<pvz::dataArray::gridItemStride> vase;
    app.put(pvz::app::board, board.address());
    board.put(pvz::board::background, 1);
    board.put(pvz::board::gridItems, ArrayHeader{vase.address(), 1, 1, 0, 1, 1, 0});
    vase.put(pvz::dataArray::gridItemObjectSize, 0x10000U);
    vase.put(0x08, 7);
    vase.put(0x0C, 3);
    vase.put(0x10, 4);
    vase.put(0x14, 0);
    vase.put(0x3C, 23);
    vase.put(0x40, 0);
    vase.put(0x50, 3);
    const auto observe = [&]() {
        BoardView view;
        assert(ReadBoard(app.address(), 51, view));
        std::string json;
        AppendGridItems(json, view);
        return json;
    };
    for (int content : {1, 2, 3}) {
        vase.put(0x44, content);
        const auto json = observe();
        assert(json.find("\"visibleHint\":\"unknown\"") != std::string::npos);
        assert(json.find("revealedContent") == std::string::npos);
        assert(json.find("peashooter") == std::string::npos);
        assert(json.find("gargantuar") == std::string::npos);
    }
    vase.put(0x44, 1);
    vase.put(0x0C, 4);
    assert(observe().find("\"visibleHint\":\"plant\"") != std::string::npos);
    assert(observe().find("revealedContent") == std::string::npos);
    vase.put(0x4C, 1);
    assert(observe().find("\"revealedContent\":{\"kind\":\"plant\",\"type\":0,\"name\":\"peashooter\"}") != std::string::npos);
    vase.put(0x0C, 5);
    vase.put(0x44, 2);
    assert(observe().find("\"visibleHint\":\"zombie\"") != std::string::npos);
    assert(observe().find("\"kind\":\"zombie\",\"type\":23,\"name\":\"gargantuar\"") != std::string::npos);
    vase.put(0x0C, 3);
    vase.put(0x44, 3);
    assert(observe().find("\"kind\":\"sun\",\"count\":3") != std::string::npos);
    vase.put(0x4C, 0);
    assert(observe().find("revealedContent") == std::string::npos);
    vase.put(0x20, uint8_t{1});
    assert(observe() == "[]");
}
