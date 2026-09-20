#include "../src/native/implant.cpp"
#include <cassert>

int main() {
    std::array<uint8_t, 0x120> manager{};
    const uintptr_t address = reinterpret_cast<uintptr_t>(manager.data());
    for (uint8_t focused : {uint8_t{0}, uint8_t{1}}) {
        for (bool accepted : {false, true}) {
            manager[pvz::widgetManager::hasFocus] = focused;
            assert(DispatchWithWidgetFocus(address, [&]() {
                assert(manager[pvz::widgetManager::hasFocus] == 1);
                return accepted;
            }) == accepted);
            assert(manager[pvz::widgetManager::hasFocus] == focused);
        }
    }
    assert(!DispatchWithWidgetFocus(0, []() {
        assert(false);
        return true;
    }));
}
