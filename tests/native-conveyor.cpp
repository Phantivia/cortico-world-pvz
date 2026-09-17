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
    Memory<0x400> bank;
    app.put(pvz::app::board, board.address());
    app.put(pvz::app::gameMode, 35);
    board.put(pvz::board::seedBank, bank.address());
    board.put(pvz::board::background, 5);
    bank.put(8, 10);
    bank.put(0x10, 599);
    bank.put(0x14, 87);
    bank.put(pvz::seedBank::packetCount, 3);
    for (int slot = 0; slot < 3; ++slot) {
        const size_t packet = pvz::seedBank::packets + slot * pvz::seedBank::packetStride;
        bank.put(packet + 8, 91 + slot * 50);
        bank.put(packet + 12, 8);
        bank.put(packet + 16, 50);
        bank.put(packet + 20, 70);
        bank.put(packet + 0x34, 32);
        bank.put(packet + 0x38, -1);
        bank.put(packet + 0x48, uint8_t{1});
    }
    const size_t p1 = pvz::seedBank::packets + pvz::seedBank::packetStride;
    const size_t p2 = p1 + pvz::seedBank::packetStride;
    bank.put(p1 + 0x30, 449); // Partly visible at x=600..609.
    bank.put(p2 + 0x30, 420); // Fully outside at x=621..671, over the shovel.
    BoardView view;
    assert(ReadBoard(app.address(), 35, view));
    assert(view.cards.size() == 2);
    assert(view.cards[0].slot == 0 && view.cards[0].x == 126);
    assert(view.cards[1].slot == 1 && view.cards[1].x >= 600 && view.cards[1].x < 609);
    bank.put(p2 + 0x30, 395); // Moving into view retains its native slot identity.
    assert(ReadBoard(app.address(), 35, view = {}));
    assert(view.cards.size() == 3 && view.cards[2].slot == 2 && view.cards[2].x < 609);
    bank.put(p1 + 0x30, 458); // No pixels remain inside the bank.
    assert(ReadBoard(app.address(), 35, view = {}));
    assert(view.cards.size() == 2 && view.cards[1].slot == 2);
    const CardView moving = view.cards[1];
    int approaches = 0;
    int presses = 0;
    assert(SelectConveyorPacket(view, 35, moving, [&](int x, int, auto&& validate) {
        ++approaches;
        if (approaches == 1) bank.put(p2 + 0x30, 315);
        if (!validate()) return false;
        ++presses;
        assert(x >= 516 && x < 566);
        return true;
    }));
    assert(approaches == 2 && presses == 1);
    assert(!SelectConveyorPacket(view, 35, moving, [&](int, int, auto&& validate) {
        bank.put(p2 + 0x34, 14);
        if (validate()) ++presses;
        return false;
    }));
    assert(presses == 1);
    bank.put(0x10, 0); // Ordinary banks retain their fixed packet centres.
    assert(ReadBoard(app.address(), 34, view = {}));
    assert(view.cards.size() == 3);
}
