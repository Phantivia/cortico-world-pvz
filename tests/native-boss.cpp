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
    Memory<pvz::dataArray::zombieStride> zombie;
    Memory<0x20> effects;
    Memory<0x20> holder;
    Memory<0xA0> animation;
    app.put(pvz::app::board, board.address());
    app.put(0x940, effects.address());
    effects.put(8, holder.address());
    holder.put(0, ArrayHeader{animation.address(), 1, 1, 0, 1, 1, 0});
    board.put(pvz::board::background, 5);
    board.put(pvz::board::zombies, ArrayHeader{zombie.address(), 1, 1, 0, 1, 1, 0});
    zombie.put(pvz::dataArray::zombieObjectSize, 0x10000U);
    zombie.put(0x18, uint8_t{1});
    zombie.put(0x24, 25);
    zombie.put(0x28, 89);
    zombie.put(0x8C, 700);
    zombie.put(0x90, 80);
    zombie.put(0x94, 90);
    zombie.put(0x98, 430);
    zombie.put(0xC8, 1000);
    zombie.put(0xCC, 1000);
    zombie.put(0x14C, 4);
    zombie.put(0x150, uint8_t{1});
    animation.put(0, 82);
    animation.put(0x9C, 0x10000U);
    animation.put(0x2C, 455.0f);
    animation.put(0x38, 320.0f);
    const auto observe = [&]() {
        BoardView view;
        assert(ReadBoard(app.address(), 35, view));
        assert(view.zombies.size() == 1);
        assert(!RelativeHostileAlive(view.zombies[0]));
        std::string ordinary;
        AppendZombies(ordinary, view);
        assert(ordinary == "[]");
        std::string json;
        AppendBoss(json, view);
        return json;
    };
    assert(observe().find("\"projectile\":null") != std::string::npos);
    zombie.put(0x140, 0x10000U);
    assert(observe().find("\"kind\":\"fireball\",\"row\":5,\"columnPosition\":6.6") != std::string::npos);
    zombie.put(0x150, uint8_t{0});
    assert(observe().find("\"kind\":\"iceball\"") != std::string::npos);
    animation.put(0x9C, 0x20000U);
    assert(observe().find("\"projectile\":null") != std::string::npos);
    animation.put(0x9C, 0x10000U);
    animation.put(0x14, uint8_t{1});
    assert(observe().find("\"projectile\":null") != std::string::npos);
    animation.put(0x14, uint8_t{0});
    animation.put(0x2C, -151.0f);
    assert(observe().find("\"projectile\":null") != std::string::npos);
}
