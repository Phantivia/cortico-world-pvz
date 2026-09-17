#include "../src/native/implant.cpp"
#include <cassert>

int main() {
    BoardView board;
    board.challengeState = 0;
    board.boardFadeOutCounter = -1;
    for (int row = 0; row < 5; ++row) {
        for (int column = 0; column < 8; ++column) {
            PlantView plant{};
            plant.row = row;
            plant.column = column;
            board.plants.push_back(plant);
        }
    }
    const auto full = BuildSpecial(board, 24);
    assert(full.settled && full.targets.size() == 28);
    for (const auto& target : full.targets) {
        assert(std::strcmp(target.action, "twist") == 0 && target.row <= 4 && target.column <= 7);
    }
    board.plants.erase(board.plants.begin() + 2 * 8 + 3);
    const auto hole = BuildSpecial(board, 24);
    assert(hole.targets.size() == 24);
    for (const auto& target : hole.targets) {
        assert(!(target.row >= 2 && target.row <= 3 && target.column >= 3 && target.column <= 4));
    }
    assert(BuildSpecial(board, 20).targets.size() == 39);
}
