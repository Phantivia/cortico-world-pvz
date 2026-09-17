#include "../src/native/implant.cpp"
#include <cassert>

int main() {
    BoardView board;
    board.sun = 100;
    CardView card{};
    card.type = 0;
    card.imitater = -1;
    card.refreshTime = 750;
    card.refreshing = true;
    board.cards.push_back(card);
    const auto expectCard = [&](int elapsed, const char* seconds, int percent, const char* bucket) {
        board.cards[0].refreshCounter = elapsed;
        std::string json;
        AppendCards(json, board, 0);
        assert(json.find(std::string("\"cooldownRemainingSeconds\":") + seconds) != std::string::npos);
        assert(json.find("\"cooldownRemainingPercent\":" + std::to_string(percent)) != std::string::npos);
        assert(json.find(std::string("\"cooldown\":\"") + bucket + "\"") != std::string::npos);
    };
    expectCard(0, "7.5", 100, "long");
    expectCard(100, "6.5", 87, "long");
    expectCard(500, "2.5", 33, "short");
    expectCard(750, "0.0", 0, "short");
    board.cards[0].refreshing = false;
    board.cards[0].active = true;
    expectCard(0, "0.0", 0, "ready");
    board.paused = true;
    expectCard(0, "0.0", 0, "short");
    board.paused = false;
    board.cards[0].active = false;
    board.cards[0].refreshing = true;
    board.cards[0].refreshTime = 3000;
    expectCard(260, "27.4", 91, "long");
    expectCard(2090, "9.1", 30, "short");
}
