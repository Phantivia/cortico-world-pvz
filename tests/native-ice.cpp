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
    Memory<0x5800> memory;
    BoardView board;
    board.address = memory.address();
    board.rows = 6;
    board.background = 2;
    for (int cell = 0; cell < 9 * 6; ++cell) memory.put(pvz::board::gridSquareType + cell * 4, 1);
    memory.put(pvz::board::iceMinX, 400);
    memory.put(pvz::board::iceTimer, 100);
    CardView pea{};
    pea.type = 0;
    assert(!IceAt(board, 0, 3) && IceAt(board, 0, 4) && IceAt(board, 0, 8));
    assert(CanPlantCardAt(board, pea, 0, 3) && !CanPlantCardAt(board, pea, 0, 4));
    std::string output;
    AppendCells(output, board);
    assert(output.find("\"row\":1,\"column\":5,\"terrain\":\"lawn\",\"playable\":false,\"blocker\":\"ice_trail\"") != std::string::npos);
    memory.put(pvz::board::iceTimer, 0);
    assert(!IceAt(board, 0, 4) && CanPlantCardAt(board, pea, 0, 4));
    AppendCells(output = {}, board);
    assert(output.find("ice_trail") == std::string::npos);
    memory.put(pvz::board::iceTimer, 100);
    memory.put(pvz::board::iceMinX, 751);
    assert(!IceAt(board, 0, 8));
    memory.put(pvz::board::iceMinX, 750);
    assert(IceAt(board, 0, 8) && !IceAt(board, 0, 7));
    memory.put(pvz::board::iceMinX, -20);
    assert(IceAt(board, 0, 0));
    board.entitiesVisible = false;
    AppendCells(output = {}, board);
    assert(output.find("ice_trail") == std::string::npos);
    assert(CanPlantCardAt(board, pea, 0, 0));
    board.entitiesVisible = true;
    board.background = 3;
    for (int cell = 0; cell < 9 * 7; ++cell) memory.put(pvz::board::fogGrid + cell * 4, 255);
    AppendCells(output = {}, board);
    assert(output.find("ice_trail") == std::string::npos);
    assert(CanPlantCardAt(board, pea, 0, 0));
}
