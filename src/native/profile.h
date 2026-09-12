#pragma once

#include <cstddef>
#include <cstdint>

namespace pvz {

constexpr int kProtocol = 2;
constexpr char kProfileName[] = "goty-apac-ja-chs-south_sniper";
constexpr char kExecutableVersion[] = "1.2.0.1073";
constexpr char kExecutableSha256[] =
    "9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed";
constexpr wchar_t kImplantBuildId[] = L"cortico-io-pvz-native-20260831-36";

constexpr int kManagedClientWidth = 800;
constexpr int kManagedClientHeight = 600;

constexpr uintptr_t kImageBase = 0x00400000;
constexpr uintptr_t kGlobalLawnApp = 0x007578F8;
constexpr uintptr_t kLawnAppVtable = 0x00710D80;
constexpr uintptr_t kLawnAppSecondaryVtable = 0x00710F30;

constexpr uint32_t kPeTimestamp = 0x4CC8E5F8;
constexpr uint32_t kPeEntryPoint = 0x002BA65F;
constexpr uint32_t kPeSizeOfImage = 0x00450000;
constexpr uint32_t kPeChecksum = 0x0039863F;

namespace app {
constexpr size_t widgetManager = 0x320;
constexpr size_t ddInterface = 0x3A0;
constexpr size_t profileManager = 0x948;
constexpr size_t board = 0x868;
constexpr size_t titleScreen = 0x86C;
constexpr size_t gameSelector = 0x870;
constexpr size_t seedChooser = 0x874;
constexpr size_t awardScreen = 0x878;
constexpr size_t creditScreen = 0x87C;
constexpr size_t challengeScreen = 0x880;
constexpr size_t zenGarden = 0x93C;
constexpr size_t gameMode = 0x918;
constexpr size_t gameScene = 0x91C;
constexpr size_t playerInfo = 0x94C;
constexpr size_t boardResult = 0x9A8;
}  // namespace app

namespace widgetManager {
constexpr size_t mouseIn = 0x104;
constexpr size_t lastMouseX = 0x108;
constexpr size_t lastMouseY = 0x10C;
constexpr uintptr_t remapMouse = 0x0055E2A0;
constexpr uintptr_t mouseUp = 0x0055F090;
constexpr uintptr_t mouseDown = 0x0055F1A0;
constexpr uintptr_t mouseMove = 0x0055F360;
constexpr uint8_t remapMouseSignature[] = {
    0x55, 0x8B, 0xEC, 0x51, 0x56, 0x89, 0x4D, 0xFC,
    0x8B, 0x45, 0xFC, 0x83, 0xB8, 0xFC, 0x00, 0x00};
constexpr uint8_t mouseUpSignature[] = {
    0x55, 0x8B, 0xEC, 0x83, 0xEC, 0x0C, 0x89, 0x4D,
    0xF4, 0x8B, 0x45, 0xF4, 0x8B, 0x4D, 0xF4, 0x8B};
constexpr uint8_t mouseDownSignature[] = {
    0x55, 0x8B, 0xEC, 0x83, 0xEC, 0x10, 0x89, 0x4D,
    0xF0, 0x8B, 0x45, 0xF0, 0x8B, 0x4D, 0xF0, 0x8B};
constexpr uint8_t mouseMoveSignature[] = {
    0x55, 0x8B, 0xEC, 0x51, 0x89, 0x4D, 0xFC, 0x8B,
    0x45, 0xFC, 0x8B, 0x4D, 0xFC, 0x8B, 0x51, 0x38,
    0x89, 0x90, 0x18, 0x01, 0x00, 0x00, 0x8B, 0x45,
    0xFC, 0x83, 0xB8, 0x10, 0x01, 0x00, 0x00, 0x00};
}  // namespace widgetManager

namespace ddInterface {
constexpr uintptr_t redraw = 0x005B31C0;
constexpr size_t redrawDetourSize = 5;
constexpr uintptr_t drawCursorTo = 0x005B4530;
constexpr size_t drawCursorToDetourSize = 5;
constexpr size_t criticalSection = 0x3C;
constexpr size_t primarySurface = 0x60;
constexpr size_t secondarySurface = 0x64;
constexpr size_t drawSurface = 0x68;
constexpr size_t initialized = 0xCDC;
constexpr uint8_t redrawSignature[] = {
    0x55, 0x8B, 0xEC, 0x6A, 0xFF, 0x68, 0x3B, 0x62, 0x6E,
    0x00, 0x64, 0xA1, 0x00, 0x00, 0x00, 0x00, 0x50};
constexpr uint8_t drawCursorToSignature[] = {
    0x55, 0x8B, 0xEC, 0x6A, 0xFF, 0x68, 0x56, 0xC8, 0x6D,
    0x00, 0x64, 0xA1, 0x00, 0x00, 0x00, 0x00, 0x50};

static_assert(redrawDetourSize == 5 && sizeof(redrawSignature) > redrawDetourSize &&
              drawCursorToDetourSize == 5 &&
              sizeof(drawCursorToSignature) > drawCursorToDetourSize);
}  // namespace ddInterface

namespace audio {
constexpr size_t muteOnLostFocus = 0x469;
constexpr uintptr_t muteOnLostFocusInitializer = 0x006162B3;
constexpr size_t muteOnLostFocusImmediate = 6;
constexpr uint8_t muteOnLostFocusEnabledSignature[] = {
    0xC6, 0x82, 0x69, 0x04, 0x00, 0x00, 0x01};
constexpr uint8_t muteOnLostFocusDisabledSignature[] = {
    0xC6, 0x82, 0x69, 0x04, 0x00, 0x00, 0x00};

static_assert(sizeof(muteOnLostFocusEnabledSignature) ==
                  sizeof(muteOnLostFocusDisabledSignature) &&
              muteOnLostFocusEnabledSignature[muteOnLostFocusImmediate] == 1 &&
              muteOnLostFocusDisabledSignature[muteOnLostFocusImmediate] == 0);
}  // namespace audio

namespace focus {
constexpr uintptr_t lostFocus = 0x0045FF30;
constexpr size_t lostFocusPauseBranch = 19;
constexpr uint8_t lostFocusPauseSignature[] = {
    0x56, 0x8B, 0xF1, 0x80, 0xBE, 0x15, 0x09, 0x00, 0x00, 0x00,
    0x75, 0x0F, 0xE8, 0x9F, 0xFF, 0xFF, 0xFF, 0x84, 0xC0, 0x74,
    0x06, 0x56, 0xE8, 0x25, 0x10, 0x00, 0x00, 0x5E, 0xC3};
constexpr uint8_t lostFocusSkipPauseSignature[] = {
    0x56, 0x8B, 0xF1, 0x80, 0xBE, 0x15, 0x09, 0x00, 0x00, 0x00,
    0x75, 0x0F, 0xE8, 0x9F, 0xFF, 0xFF, 0xFF, 0x84, 0xC0, 0xEB,
    0x06, 0x56, 0xE8, 0x25, 0x10, 0x00, 0x00, 0x5E, 0xC3};

static_assert(sizeof(lostFocusPauseSignature) == sizeof(lostFocusSkipPauseSignature) &&
              lostFocusPauseSignature[lostFocusPauseBranch] == 0x74 &&
              lostFocusSkipPauseSignature[lostFocusPauseBranch] == 0xEB);
}  // namespace focus

namespace title {
constexpr size_t loadingThreadComplete = 0xB9;
constexpr uintptr_t mouseDown = 0x004A96A0;
constexpr uint8_t mouseDownSignature[] = {
    0x56, 0x8B, 0xF1, 0x80, 0xBE, 0xB9, 0x00, 0x00, 0x00,
    0x00, 0x74, 0x27, 0x8B, 0x8E, 0xDC, 0x00, 0x00, 0x00};
}  // namespace title

static_assert(app::titleScreen == 0x86C && title::loadingThreadComplete == 0xB9);

namespace result {
constexpr int none = 0;
constexpr int won = 1;
constexpr int lost = 2;
constexpr int restart = 3;
constexpr int quit = 4;
constexpr int quitApp = 5;
constexpr int cheat = 6;
}  // namespace result

namespace player {
constexpr size_t nameStorage = 0x04;
constexpr size_t nameLength = 0x14;
constexpr size_t nameCapacity = 0x18;
constexpr int nameInlineCapacity = 7;
constexpr int nameHeapCapacity = 15;
constexpr int nameMaximumLength = 12;
constexpr uintptr_t copyConstructor = 0x0047E1A0;
constexpr uint8_t copyConstructorSignature[] = {
    0x55, 0x8B, 0x6C, 0x24, 0x08, 0x56, 0x57, 0x6A, 0xFF, 0x6A, 0x00,
    0x55, 0x8B, 0xCB, 0xE8, 0xFD, 0x7C, 0xF8, 0xFF, 0x8B, 0x45, 0x1C,
    0x89, 0x43, 0x1C, 0x8B, 0x4D, 0x20, 0x8B, 0xC5, 0x89, 0x4B, 0x20};
constexpr uintptr_t nameStorageAccess = 0x00405F57;
constexpr uint8_t nameStorageAccessSignature[] = {
    0x8D, 0x4D, 0x04, 0x83, 0x7E, 0x18, 0x08, 0x8D, 0x6E, 0x04, 0x72,
    0x05, 0x8B, 0x45, 0x00, 0xEB, 0x02, 0x8B, 0xC5, 0x8B, 0x54, 0x24,
    0x18, 0x8D, 0x0C, 0x51, 0x8D, 0x1C, 0x3F};
constexpr size_t id = 0x20;
constexpr size_t level = 0x4C;
constexpr size_t coins = 0x50;
constexpr size_t adventureCompletions = 0x54;
constexpr size_t minigamesUnlocked = 0x348;
constexpr size_t puzzleUnlocked = 0x34C;
constexpr size_t survivalUnlocked = 0x360;
constexpr size_t numPottedPlants = 0x378;
constexpr size_t pottedPlants = 0x380;
constexpr size_t pottedPlantStride = 0x58;
constexpr size_t purchases = 0x1E8;
constexpr size_t treeHeight = 0x11C;
}  // namespace player

static_assert(player::nameStorage == 0x04 && player::nameLength == 0x14 &&
              player::nameCapacity == 0x18 && player::id == 0x20);

namespace profileManager {
constexpr size_t userCount = 0x20;
}  // namespace profileManager

namespace userDialog {
constexpr int dialogId = 29;
constexpr int createDialogId = 30;
constexpr int maxUsers = 8;
constexpr int listInset = 4;
constexpr int itemHeight = 24;
constexpr uintptr_t vtable = 0x0071B840;
constexpr uintptr_t listVtable = 0x0071FF6C;
constexpr size_t userList = 0x18C;
constexpr size_t renameButton = 0x190;
constexpr size_t deleteButton = 0x194;
constexpr size_t numUsers = 0x198;
constexpr size_t listManager = 0x20;
constexpr size_t listParent = 0x24;
constexpr size_t listVisible = 0x64;
constexpr size_t listMouseVisible = 0x65;
constexpr size_t listDisabled = 0x66;
constexpr size_t listLinesBegin = 0xC0;
constexpr size_t listLinesEnd = 0xC4;
constexpr size_t listLineStride = 0x1C;
constexpr size_t listPosition = 0xE8;
constexpr size_t listSelectedIndex = 0xFC;
constexpr size_t listItemHeight = 0x114;
}  // namespace userDialog

namespace editWidget {
constexpr size_t text = 0xA4;
}  // namespace editWidget

static_assert(userDialog::userList + 3U * sizeof(uintptr_t) == userDialog::numUsers &&
              userDialog::listInset + userDialog::maxUsers * userDialog::itemHeight == 196 &&
              userDialog::listLinesEnd == userDialog::listLinesBegin + sizeof(uintptr_t));

namespace gameSelector {
constexpr size_t minigamesLocked = 0xEC;
constexpr size_t puzzleLocked = 0xED;
constexpr size_t survivalLocked = 0xEE;
}  // namespace gameSelector

namespace purchase {
constexpr int countOffset = 1000;
constexpr int firstPlantUpgrade = 0;
constexpr int plantUpgradeCount = 9;
constexpr int goldWateringCan = 13;
constexpr int fertilizer = 14;
constexpr int bugSpray = 15;
constexpr int phonograph = 16;
constexpr int gardeningGlove = 17;
constexpr int mushroomGarden = 18;
constexpr int wheelbarrow = 19;
constexpr int chocolate = 26;
constexpr int aquariumGarden = 25;
constexpr int treeOfWisdom = 27;
constexpr int treeFood = 28;
constexpr int itemCount = 29;
}  // namespace purchase

namespace pottedPlant {
constexpr size_t seedType = 0x00;
constexpr size_t garden = 0x04;
constexpr size_t x = 0x08;
constexpr size_t y = 0x0C;
constexpr size_t lastWatered = 0x18;
constexpr size_t age = 0x24;
constexpr size_t timesFed = 0x28;
constexpr size_t feedingsPerGrow = 0x2C;
constexpr size_t storedNeed = 0x30;
constexpr size_t lastNeedFulfilled = 0x38;
constexpr size_t lastFertilized = 0x40;
constexpr size_t lastChocolate = 0x48;

static_assert(lastChocolate + sizeof(int64_t) <= player::pottedPlantStride);
}  // namespace pottedPlant

namespace board {
constexpr size_t zombies = 0xA8;
constexpr size_t plants = 0xC4;
constexpr size_t projectiles = 0xE0;
constexpr size_t coins = 0xFC;
constexpr size_t mowers = 0x118;
constexpr size_t gridItems = 0x134;
constexpr size_t cursorObject = 0x150;
constexpr size_t seedBank = 0x15C;
constexpr size_t menuButton = 0x160;
constexpr size_t storeButton = 0x164;
constexpr size_t cutScene = 0x174;
constexpr size_t challenge = 0x178;
constexpr size_t paused = 0x17C;
constexpr size_t gridSquareType = 0x180;
constexpr size_t fogGrid = 0x4E0;
constexpr size_t fogOffset = 0x5E8;
constexpr size_t plantRows = 0x5F0;
constexpr size_t zombieWaves = 0x6CC;
constexpr size_t zombieAllowed = 0x54EC;
constexpr size_t background = 0x5564;
constexpr size_t level = 0x5568;
constexpr size_t sun = 0x5578;
constexpr size_t numWaves = 0x557C;
constexpr size_t mainCounter = 0x5580;
constexpr size_t tutorialState = 0x559C;
constexpr size_t currentWave = 0x5594;
constexpr size_t levelComplete = 0x5614;
constexpr size_t levelAwardSpawned = 0x5624;
constexpr size_t progressMeterWidth = 0x5628;
constexpr size_t cobCannonCursorDelay = 0x576C;
}  // namespace board

namespace tutorial {
constexpr int shovelPickup = 15;
constexpr int shovelDig = 16;
constexpr int shovelKeepDigging = 17;
constexpr int shovelCompleted = 18;
}  // namespace tutorial

namespace widget {
constexpr size_t gameButtonX = 0x10;
constexpr size_t gameButtonY = 0x14;
constexpr size_t gameButtonWidth = 0x18;
constexpr size_t gameButtonHeight = 0x1C;
constexpr size_t disabled = 0x22;
constexpr size_t mouseVisible = 0x65;
constexpr size_t noDraw = 0x105;
constexpr size_t x = 0x40;
constexpr size_t y = 0x44;
constexpr size_t width = 0x48;
constexpr size_t height = 0x4C;
}  // namespace widget

namespace pauseDialog {
constexpr int dialogId = 37;
constexpr uintptr_t vtable = 0x0070B998;
constexpr size_t mainMenuButton = 0x178;
constexpr size_t resumeButton = 0x184;
constexpr size_t restartButton = 0x188;

constexpr bool Matches(int id, uintptr_t candidateVtable) {
    return id == dialogId && candidateVtable == vtable;
}

static_assert(Matches(dialogId, vtable) && !Matches(dialogId, 0x00711148));
}  // namespace pauseDialog

namespace cutScene {
constexpr size_t board = 0x04;
constexpr size_t seedChoosing = 0x2C;
constexpr uintptr_t endSeedChooser = 0x004A11BA;
constexpr uint8_t endSeedChooserSignature[] = {
    0x8B, 0x85, 0x2C, 0x0D, 0x00, 0x00, 0x8B, 0x80, 0x74, 0x01, 0x00, 0x00,
    0x8B, 0x10, 0x8B, 0x92, 0x74, 0x08, 0x00, 0x00, 0x88, 0x4A, 0x65, 0x8B,
    0x15, 0x48, 0xBE, 0x75, 0x00, 0x88, 0x48, 0x2C, 0x8B, 0x48, 0x20, 0x8D,
    0x4C, 0x11, 0x0A, 0x8B, 0x10, 0x89, 0x48, 0x08, 0x8B, 0x8A, 0x20, 0x03,
    0x00, 0x00, 0x8B, 0x11, 0x8B, 0x40, 0x04};
static_assert(sizeof(endSeedChooserSignature) <= 64);
}  // namespace cutScene

namespace chooser {
constexpr size_t imitaterButton = 0xB8;
constexpr size_t board = 0xD2C;
constexpr size_t chosenSeeds = 0xBC;
constexpr size_t chosenSeedStride = 0x3C;
constexpr size_t chosenSeedCrazyDavePicked = 0x38;
constexpr size_t seedChooserAge = 0xD34;
constexpr size_t seedsInFlight = 0xD38;
constexpr size_t seedsInBank = 0xD3C;
constexpr size_t chooseState = 0xD50;
constexpr int visibleSeedCount = 49;
}  // namespace chooser

static_assert(board::cutScene == 0x174 && cutScene::board == 0x04 &&
              cutScene::seedChoosing == 0x2C && chooser::board == 0xD2C &&
              chooser::imitaterButton + sizeof(uintptr_t) == chooser::chosenSeeds &&
              chooser::chosenSeedCrazyDavePicked + sizeof(uint8_t) <=
                  chooser::chosenSeedStride &&
              widget::mouseVisible == 0x65);

namespace seedBank {
constexpr size_t packetCount = 0x24;
constexpr size_t packets = 0x28;
constexpr size_t packetStride = 0x50;
}  // namespace seedBank

namespace dataArray {
constexpr size_t headerSize = 0x1C;
constexpr size_t plantObjectSize = 0x148;
constexpr size_t plantStride = 0x14C;
constexpr size_t zombieObjectSize = 0x164;
constexpr size_t zombieStride = 0x168;
constexpr size_t coinObjectSize = 0xD0;
constexpr size_t coinStride = 0xD8;
constexpr size_t mowerObjectSize = 0x44;
constexpr size_t mowerStride = 0x48;
constexpr size_t gridItemObjectSize = 0xE8;
constexpr size_t gridItemStride = 0xEC;

static_assert(coinObjectSize == 0xD0 && coinStride == 0xD8);
static_assert(coinObjectSize + sizeof(uint32_t) <= coinStride);
}  // namespace dataArray

}  // namespace pvz
