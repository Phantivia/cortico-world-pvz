#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <ddraw.h>
#include <objidl.h>
#include <gdiplus.h>
#include <wincrypt.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <climits>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <cstring>
#include <cwchar>
#include <deque>
#include <iterator>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "cursor_companion.h"
#include "json.h"
#include "profile.h"

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "version.lib")

#if !defined(_M_IX86)
#error pvz-implant must be compiled for x86
#endif

namespace {

using pvz::json::AppendBool;
using pvz::json::AppendInt;
using pvz::json::AppendString;

void AppendTenth(std::string& output, int tenths) {
    if (tenths < 0) output.push_back('-');
    const int magnitude = std::abs(tenths);
    AppendInt(output, magnitude / 10);
    output.push_back('.');
    output.push_back(static_cast<char>('0' + magnitude % 10));
}

void AppendHundredth(std::string& output, int hundredths) {
    if (hundredths < 0) output.push_back('-');
    const int magnitude = std::abs(hundredths);
    AppendInt(output, magnitude / 100);
    output.push_back('.');
    output.push_back(static_cast<char>('0' + magnitude / 10 % 10));
    output.push_back(static_cast<char>('0' + magnitude % 10));
}

constexpr wchar_t kPipeEnvironment[] = L"CORTICO_PVZ_PIPE";
constexpr wchar_t kOwnerEnvironment[] = L"CORTICO_PVZ_OWNER_TOKEN";
constexpr size_t kMaxPipeName = 512;
constexpr size_t kMaxLine = 1024 * 1024;
constexpr UINT kInternalMouseWindowMessage = WM_APP + 0x37A;
constexpr UINT kRelativePlantWindowMessage = WM_APP + 0x37C;
constexpr UINT kInternalMouseDispatchTimeoutMs = 1000;

enum class InternalMouseAction : WPARAM {
    Move = 1,
    LeftDown = 2,
    LeftUp = 3,
    RightDown = 4,
    RightUp = 5,
};

enum class CursorOverlayState : uint8_t {
    Hover,
    Moving,
    Pressed,
    Dragging,
    Released,
};

HMODULE g_module = nullptr;
HANDLE g_stopEvent = nullptr;
HANDLE g_pipeChangedEvent = nullptr;
HANDLE g_commandEvent = nullptr;
HANDLE g_profileReadyEvent = nullptr;
SRWLOCK g_pipeLock = SRWLOCK_INIT;
SRWLOCK g_ownerLock = SRWLOCK_INIT;
SRWLOCK g_sendLock = SRWLOCK_INIT;
SRWLOCK g_idLock = SRWLOCK_INIT;
SRWLOCK g_semanticSendLock = SRWLOCK_INIT;
SRWLOCK g_menuContextLock = SRWLOCK_INIT;
SRWLOCK g_profilePatchLock = SRWLOCK_INIT;
SRWLOCK g_windowSubclassLock = SRWLOCK_INIT;
SRWLOCK g_whackPresentationLock = SRWLOCK_INIT;
CRITICAL_SECTION g_commandLock;
HANDLE g_pipe = INVALID_HANDLE_VALUE;
wchar_t g_pipeName[kMaxPipeName] = {};
wchar_t g_ownerToken[33] = {};
std::atomic<DWORD> g_pollHz{15};
std::atomic<DWORD> g_cursorMinMs{120};
std::atomic<DWORD> g_cursorMaxMs{420};
std::atomic<LONG> g_cursorX{400};
std::atomic<LONG> g_cursorY{300};
std::atomic<bool> g_cursorOverlayEnabled{false};
std::atomic<bool> g_cursorOverlayButtonDown{false};
std::atomic<CursorOverlayState> g_cursorOverlayState{CursorOverlayState::Hover};
std::atomic<ULONGLONG> g_cursorOverlayStateSince{0};
std::atomic<bool> g_widgetHoverOwnedByInternal{false};
std::atomic<bool> g_redrawHookInstalled{false};
std::atomic<bool> g_cursorDrawHookInstalled{false};
std::atomic<ULONG> g_revision{0};
std::atomic<ULONGLONG> g_actionEpoch{0};
std::atomic<bool> g_pipeConfigured{false};
std::atomic<bool> g_runtimeConfigured{false};
std::atomic<bool> g_pipeHello{false};
std::atomic<bool> g_acceptCommands{true};
std::atomic<bool> g_releaseHeldRequested{false};
std::atomic<int> g_workerReady{0};
thread_local bool g_inputPosted = false;
thread_local bool g_internalMouseDispatch = false;
uint64_t g_boardRunId = 0;
uintptr_t g_previousBoard = 0;
int g_previousBoardCounter = 0;
bool g_boardWasActive = false;

using RedrawFunction = bool (__thiscall*)(void*, void*);
RedrawFunction g_originalRedraw = nullptr;
using DrawCursorToFunction = void (__thiscall*)(void*, LPDIRECTDRAWSURFACE, bool);
DrawCursorToFunction g_originalDrawCursorTo = nullptr;
using SetCaptureFunction = HWND (WINAPI*)(HWND);
using ReleaseCaptureFunction = BOOL (WINAPI*)();
using SetCursorFunction = HCURSOR (WINAPI*)(HCURSOR);
std::atomic<SetCaptureFunction> g_originalSetCapture{nullptr};
std::atomic<ReleaseCaptureFunction> g_originalReleaseCapture{nullptr};
std::atomic<SetCursorFunction> g_originalSetCursor{nullptr};
std::atomic<WNDPROC> g_originalWindowProc{nullptr};
std::atomic<bool> g_captureBypassInstalled{false};
std::atomic<HWND> g_internalMouseWindow{nullptr};
std::atomic<ULONGLONG> g_windowRepairAttemptedAt{0};
/** 人正拖着窗口:这段时间里不许自动修正,否则窗口会从手底下弹回去。 */
std::atomic<bool> g_windowMoveInProgress{false};

struct WhackPresentationState {
    uintptr_t board = 0;
    int mode = -1;
    int level = -1;
    int mainCounter = -1;
    std::unordered_map<uint32_t, uint8_t> visibleFrames;
};

WhackPresentationState g_whackPresentation;

void CapturePresentedWhackTargets();

struct ActiveRunState {
    bool valid = false;
    bool eligible = false;
    bool terminalSeen = false;
    bool awardArmed = false;
    bool awardHigh = false;
    bool completeArmed = false;
    bool completeHigh = false;
    uint64_t runId = 0;
    uintptr_t boardAddress = 0;
    int mode = -1;
    int level = -1;
    int survivalStage = -1;
};

struct LastRunState {
    bool present = false;
    uint64_t resultId = 0;
    uint64_t runId = 0;
    int mode = -1;
    int level = -1;
    int outcome = 0;
};

ActiveRunState g_activeRun;
LastRunState g_lastRun;
uint64_t g_nextResultId = 1;
uint64_t g_dialogRunId = 0;
uintptr_t g_previousDialog = 0;
bool g_dialogWasActive = false;
uint32_t g_menuContext = 0;
std::string g_menuSignature;

struct IdNamespace {
    std::unordered_map<uint32_t, uint32_t> rawToPublic;
    std::unordered_map<uint32_t, uint32_t> publicToRaw;
    uint32_t next = 1;
};

enum class EntityKind : size_t { Plant, Zombie, GridItem, Collectible, Count };

std::array<IdNamespace, static_cast<size_t>(EntityKind::Count)> g_idNamespaces;
uintptr_t g_idBoard = 0;
int g_idBoardCounter = 0;

struct Validation {
    bool supported = false;
    std::string hash = "0000000000000000000000000000000000000000000000000000000000000000";
    std::string version = "unknown";
    std::string reason;
};

Validation g_validation;

struct ActionBatchMetrics {
    bool present = false;
    int requested = 0;
    int attempted = 0;
    int released = 0;
    int verified = 0;
    int stale = 0;
    bool scopeStopped = false;
};

struct PlantPlacement {
    int row = 0;
    int column = 0;
    uint32_t targetId = 0;
    uint64_t runId = 0;
};

struct Command {
    std::string id;
    std::string kind;
    std::string target;
    std::string special;
    std::string name;
    int pollHz = -1;
    int cursorMinMs = -1;
    int cursorMaxMs = -1;
    int seed = -1;
    int imitates = -1;
    int slot = -1;
    int targetId = -1;
    int row = -1;
    int column = -1;
    int minGap = -1;
    int toRow = -1;
    int toColumn = -1;
    int x = -1;
    int y = -1;
    int expectedRevision = -1;
    int expectedInputEpoch = -1;
    int menuContext = -1;
    int expectedLevel = -1;
    int expectedCardType = -1;
    int expectedCardImitates = -2;
    ULONGLONG epoch = 0;
    std::vector<int> ids;
    std::vector<int> targetIds;
};

std::deque<Command> g_commands;
struct OutgoingLine {
    std::string framed;
    uint64_t sequence;
};
std::deque<OutgoingLine> g_outgoingLines;
size_t g_outgoingBytes = 0;
std::atomic<uint64_t> g_nextOutgoingSequence{0};
std::atomic<uint64_t> g_stopAfterSequence{0};
std::unordered_set<std::string> g_commandIds;
std::string g_activeActionId;

bool ValidOwnerToken(const wchar_t* token) {
    if (!token || wcslen(token) != 32) return false;
    for (size_t index = 0; index < 32; ++index) {
        const wchar_t ch = token[index];
        if (!((ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f'))) return false;
    }
    return true;
}

bool LoadOwnerToken() {
    wchar_t token[33]{};
    const DWORD length = GetEnvironmentVariableW(kOwnerEnvironment, token,
                                                  static_cast<DWORD>(std::size(token)));
    if (length != 32 || !ValidOwnerToken(token)) return false;
    AcquireSRWLockExclusive(&g_ownerLock);
    wcscpy_s(g_ownerToken, token);
    ReleaseSRWLockExclusive(&g_ownerLock);
    return true;
}

struct ArrayHeader {
    uintptr_t block;
    uint32_t maxUsedCount;
    uint32_t maxSize;
    uint32_t freeListHead;
    uint32_t size;
    uint32_t nextKey;
    uintptr_t name;
};

static_assert(sizeof(ArrayHeader) == pvz::dataArray::headerSize, "unexpected x86 DataArray layout");

bool SafeCopy(void* destination, uintptr_t source, size_t bytes) {
    __try {
        std::memcpy(destination, reinterpret_cast<const void*>(source), bytes);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

template <typename T>
bool SafeRead(uintptr_t address, T& value) {
    return SafeCopy(&value, address, sizeof(value));
}

template <typename T>
bool SafeWrite(uintptr_t address, const T& value) {
    __try {
        *reinterpret_cast<T*>(address) = value;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

template <typename T, size_t N>
T Field(const std::array<uint8_t, N>& bytes, size_t offset) {
    T value{};
    std::memcpy(&value, bytes.data() + offset, sizeof(value));
    return value;
}

std::wstring ExecutablePathWide() {
    std::vector<wchar_t> path(32768);
    const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    return length && length < path.size() ? std::wstring(path.data(), length) : std::wstring();
}

std::string Sha256File(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE |
                              FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return {};
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
        !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) {
        if (provider) CryptReleaseContext(provider, 0);
        CloseHandle(file);
        return {};
    }
    std::array<BYTE, 64 * 1024> buffer{};
    bool ok = true;
    while (true) {
        DWORD read = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
            ok = false;
            break;
        }
        if (!read) break;
        if (!CryptHashData(hash, buffer.data(), read, 0)) {
            ok = false;
            break;
        }
    }
    std::array<BYTE, 32> digest{};
    DWORD digestSize = static_cast<DWORD>(digest.size());
    if (!ok || !CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &digestSize, 0)) digestSize = 0;
    CryptDestroyHash(hash);
    CryptReleaseContext(provider, 0);
    CloseHandle(file);
    if (digestSize != digest.size()) return {};
    static constexpr char hex[] = "0123456789abcdef";
    std::string output;
    output.reserve(64);
    for (BYTE value : digest) {
        output.push_back(hex[value >> 4]);
        output.push_back(hex[value & 0x0F]);
    }
    return output;
}

std::string FileVersion(const std::wstring& path) {
    DWORD ignored = 0;
    const DWORD size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (!size) return "unknown";
    std::vector<BYTE> data(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return "unknown";
    VS_FIXEDFILEINFO* info = nullptr;
    UINT infoSize = 0;
    if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &infoSize) ||
        !info || infoSize < sizeof(*info)) return "unknown";
    return std::to_string(HIWORD(info->dwFileVersionMS)) + "." +
           std::to_string(LOWORD(info->dwFileVersionMS)) + "." +
           std::to_string(HIWORD(info->dwFileVersionLS)) + "." +
           std::to_string(LOWORD(info->dwFileVersionLS));
}

bool Signature(uintptr_t address, const uint8_t* expected, size_t size) {
    std::array<uint8_t, 64> actual{};
    return size <= actual.size() && SafeCopy(actual.data(), address, size) &&
           std::memcmp(actual.data(), expected, size) == 0;
}

struct CursorOverlayBacking {
    HDC memory = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ previousBitmap = nullptr;
    RECT rect{};
};

struct CursorOverlayFrame {
    void* interfaceObject = nullptr;
    LPDIRECTDRAWSURFACE surface = nullptr;
    int x = 0;
    int y = 0;
    bool buttonDown = false;
    CursorOverlayState state = CursorOverlayState::Hover;
    ULONGLONG stateElapsed = 0;
    bool requested = false;
    bool prepared = false;
    bool backed = false;
    bool composited = false;
    CursorOverlayBacking backing;
};

thread_local CursorOverlayFrame* g_cursorOverlayFrame = nullptr;

struct CursorOverlayPose {
    int xOffset;
    int yOffset;
    int pulse;
};

template <size_t FrameCount>
constexpr pvz::cursorCompanion::AnimationFrame CursorCompanionFrameAt(
    const std::array<pvz::cursorCompanion::AnimationFrame, FrameCount>& frames,
    bool loops, ULONGLONG elapsed) {
    const ULONGLONG duration = pvz::cursorCompanion::AnimationDurationMs(frames);
    ULONGLONG cursor = loops ? elapsed % duration : std::min(elapsed, duration - 1);
    for (const auto& frame : frames) {
        if (cursor < frame.durationMs) return frame;
        cursor -= frame.durationMs;
    }
    return frames.back();
}

constexpr CursorOverlayPose CursorOverlayPoseAt(CursorOverlayState state,
                                                ULONGLONG elapsed) {
    pvz::cursorCompanion::AnimationFrame frame{};
    switch (state) {
        case CursorOverlayState::Hover:
            frame = CursorCompanionFrameAt(
                pvz::cursorCompanion::kIdleFrames,
                pvz::cursorCompanion::kIdleLoops, elapsed);
            return {frame.xOffset, frame.yOffset, 0};
        case CursorOverlayState::Moving:
            frame = CursorCompanionFrameAt(
                pvz::cursorCompanion::kMovingFrames,
                pvz::cursorCompanion::kMovingLoops, elapsed);
            return {frame.xOffset, frame.yOffset, 1};
        case CursorOverlayState::Pressed:
            frame = CursorCompanionFrameAt(
                pvz::cursorCompanion::kPressedFrames,
                pvz::cursorCompanion::kPressedLoops, elapsed);
            return {frame.xOffset, frame.yOffset, 2};
        case CursorOverlayState::Dragging:
            frame = CursorCompanionFrameAt(
                pvz::cursorCompanion::kMovingFrames,
                pvz::cursorCompanion::kMovingLoops, elapsed);
            return {frame.xOffset, frame.yOffset + 1, 2};
        case CursorOverlayState::Released:
            frame = CursorCompanionFrameAt(
                pvz::cursorCompanion::kReleasedFrames,
                pvz::cursorCompanion::kReleasedLoops, elapsed);
            return {frame.xOffset, frame.yOffset, elapsed < 55 ? 2 : 1};
    }
    return {0, 0, 0};
}

static_assert(CursorOverlayPoseAt(CursorOverlayState::Pressed, 120).yOffset == 1 &&
              CursorOverlayPoseAt(CursorOverlayState::Hover, 300).yOffset == -1 &&
              CursorOverlayPoseAt(CursorOverlayState::Released, 0).pulse == 2);

void SetCursorOverlayState(CursorOverlayState state) {
    if (g_cursorOverlayState.load(std::memory_order_acquire) == state) return;
    g_cursorOverlayStateSince.store(GetTickCount64(), std::memory_order_release);
    g_cursorOverlayState.store(state, std::memory_order_release);
}

bool ManagedCursorPoint(int x, int y) {
    return x >= 0 && x < pvz::kManagedClientWidth &&
           y >= 0 && y < pvz::kManagedClientHeight;
}

bool ReadInternalCursorPoint(int& x, int& y) {
    uintptr_t lawnApp = 0;
    uintptr_t manager = 0;
    uint8_t mouseIn = 0;
    int liveX = 0;
    int liveY = 0;
    if (SafeRead(pvz::kGlobalLawnApp, lawnApp) && lawnApp &&
        SafeRead(lawnApp + pvz::app::widgetManager, manager) && manager &&
        SafeRead(manager + pvz::widgetManager::mouseIn, mouseIn) && mouseIn &&
        SafeRead(manager + pvz::widgetManager::lastMouseX, liveX) &&
        SafeRead(manager + pvz::widgetManager::lastMouseY, liveY) &&
        ManagedCursorPoint(liveX, liveY)) {
        x = liveX;
        y = liveY;
        g_cursorX.store(x);
        g_cursorY.store(y);
        return true;
    }
    x = g_cursorX.load();
    y = g_cursorY.load();
    return ManagedCursorPoint(x, y);
}

void ReleaseCursorOverlayBacking(CursorOverlayBacking& backing) {
    if (backing.memory && backing.previousBitmap) {
        SelectObject(backing.memory, backing.previousBitmap);
    }
    if (backing.bitmap) DeleteObject(backing.bitmap);
    if (backing.memory) DeleteDC(backing.memory);
    backing = {};
}

bool SaveCursorOverlayBacking(LPDIRECTDRAWSURFACE surface, int x, int y,
                              CursorOverlayBacking& backing) {
    if (!surface || !ManagedCursorPoint(x, y)) return false;
    constexpr int kOverlayExtent = 44;
    backing.rect.left = std::max(0, x - kOverlayExtent);
    backing.rect.top = std::max(0, y - kOverlayExtent);
    backing.rect.right = std::min(pvz::kManagedClientWidth, x + kOverlayExtent);
    backing.rect.bottom = std::min(pvz::kManagedClientHeight, y + kOverlayExtent);
    const int width = backing.rect.right - backing.rect.left;
    const int height = backing.rect.bottom - backing.rect.top;
    if (width <= 0 || height <= 0) return false;

    HDC surfaceDc = nullptr;
    if (FAILED(surface->GetDC(&surfaceDc)) || !surfaceDc) return false;
    backing.memory = CreateCompatibleDC(surfaceDc);
    if (backing.memory) backing.bitmap = CreateCompatibleBitmap(surfaceDc, width, height);
    if (backing.memory && backing.bitmap) {
        backing.previousBitmap = SelectObject(backing.memory, backing.bitmap);
    }
    const bool saved = backing.memory && backing.bitmap && backing.previousBitmap &&
        BitBlt(backing.memory, 0, 0, width, height, surfaceDc,
               backing.rect.left, backing.rect.top, SRCCOPY) != FALSE;
    surface->ReleaseDC(surfaceDc);
    if (!saved) ReleaseCursorOverlayBacking(backing);
    return saved;
}

bool RestoreCursorOverlayBacking(LPDIRECTDRAWSURFACE surface,
                                 CursorOverlayBacking& backing) {
    if (!surface || !backing.memory || !backing.bitmap) {
        ReleaseCursorOverlayBacking(backing);
        return false;
    }
    HDC surfaceDc = nullptr;
    bool restored = false;
    if (SUCCEEDED(surface->GetDC(&surfaceDc)) && surfaceDc) {
        restored = BitBlt(surfaceDc, backing.rect.left, backing.rect.top,
                          backing.rect.right - backing.rect.left,
                          backing.rect.bottom - backing.rect.top,
                          backing.memory, 0, 0, SRCCOPY) != FALSE;
        surface->ReleaseDC(surfaceDc);
    }
    ReleaseCursorOverlayBacking(backing);
    return restored;
}

void DrawCursorCompanion(HDC dc, int x, int y) {
    for (int row = 0; row < pvz::cursorCompanion::kHeight; ++row) {
        for (int column = 0; column < pvz::cursorCompanion::kWidth; ++column) {
            if (pvz::cursorCompanion::kPixelIndices[row][column]) continue;
            bool bordersSprite = false;
            for (int deltaY = -1; deltaY <= 1 && !bordersSprite; ++deltaY) {
                for (int deltaX = -1; deltaX <= 1; ++deltaX) {
                    const int neighborRow = row + deltaY;
                    const int neighborColumn = column + deltaX;
                    if (neighborRow < 0 || neighborRow >= pvz::cursorCompanion::kHeight ||
                        neighborColumn < 0 || neighborColumn >= pvz::cursorCompanion::kWidth) continue;
                    if (pvz::cursorCompanion::kPixelIndices[neighborRow][neighborColumn]) {
                        bordersSprite = true;
                        break;
                    }
                }
            }
            if (!bordersSprite) continue;
            const int pixelX = x + column;
            const int pixelY = y + row;
            if (ManagedCursorPoint(pixelX, pixelY)) {
                SetPixelV(dc, pixelX, pixelY, RGB(0, 0, 0));
            }
        }
    }
    for (int row = 0; row < pvz::cursorCompanion::kHeight; ++row) {
        for (int column = 0; column < pvz::cursorCompanion::kWidth; ++column) {
            const auto index = pvz::cursorCompanion::kPixelIndices[row][column];
            if (!index) continue;
            const int pixelX = x + column;
            const int pixelY = y + row;
            if (!ManagedCursorPoint(pixelX, pixelY)) continue;
            const auto& color = pvz::cursorCompanion::kPalette[index];
            SetPixelV(dc, pixelX, pixelY, RGB(color.red, color.green, color.blue));
        }
    }
}

void DrawCursorOverlayShape(HDC dc, int x, int y, bool buttonDown,
                            CursorOverlayState state, ULONGLONG stateElapsed) {
    const CursorOverlayPose pose = CursorOverlayPoseAt(state, stateElapsed);
    constexpr int kCompanionRightExtent = pvz::cursorCompanion::kDrawOffsetX +
        pvz::cursorCompanion::kWidth + pvz::cursorCompanion::kMotionExtent;
    constexpr int kCompanionBottomExtent = pvz::cursorCompanion::kDrawOffsetY +
        pvz::cursorCompanion::kHeight + pvz::cursorCompanion::kMotionExtent;
    const int xDirection = x > pvz::kManagedClientWidth - kCompanionRightExtent
        ? -1 : 1;
    const int yDirection = y > pvz::kManagedClientHeight - kCompanionBottomExtent
        ? -1 : 1;
    const int companionX = xDirection > 0
        ? x + pvz::cursorCompanion::kDrawOffsetX
        : x - pvz::cursorCompanion::kDrawOffsetX - pvz::cursorCompanion::kWidth;
    const int companionY = yDirection > 0
        ? y + pvz::cursorCompanion::kDrawOffsetY
        : y - pvz::cursorCompanion::kDrawOffsetY - pvz::cursorCompanion::kHeight;
    POINT arrow[] = {
        {x, y},
        {x, y + yDirection * 21},
        {x + xDirection * 6, y + yDirection * 16},
        {x + xDirection * 11, y + yDirection * 27},
        {x + xDirection * 16, y + yDirection * 24},
        {x + xDirection * 11, y + yDirection * 14},
        {x + xDirection * 19, y + yDirection * 14},
    };

    HBRUSH white = CreateSolidBrush(RGB(255, 255, 255));
    HPEN black = CreatePen(PS_SOLID, 2, RGB(0, 0, 0));
    if (white && black) {
        HGDIOBJ previousBrush = SelectObject(dc, white);
        HGDIOBJ previousPen = SelectObject(dc, black);
        Polygon(dc, arrow, static_cast<int>(std::size(arrow)));
        SelectObject(dc, previousPen);
        SelectObject(dc, previousBrush);
    }

    HPEN cyan = CreatePen(PS_SOLID, 2, RGB(0, 238, 255));
    if (cyan) {
        HGDIOBJ previousPen = SelectObject(dc, cyan);
        MoveToEx(dc, x + xDirection * 2, y + yDirection * 5, nullptr);
        LineTo(dc, x + xDirection * 3, y + yDirection * (15 + pose.pulse));
        if (buttonDown) {
            HGDIOBJ previousBrush = SelectObject(dc, GetStockObject(HOLLOW_BRUSH));
            const int radius = 9 + pose.pulse;
            Ellipse(dc, x - radius, y - radius, x + radius + 1, y + radius + 1);
            SelectObject(dc, previousBrush);
        }
        SelectObject(dc, previousPen);
    }
    if (cyan) DeleteObject(cyan);
    if (black) DeleteObject(black);
    if (white) DeleteObject(white);
    DrawCursorCompanion(
        dc, companionX + pose.xOffset, companionY + pose.yOffset);
}

bool DrawCursorOverlay(LPDIRECTDRAWSURFACE surface, int x, int y,
                       bool buttonDown, CursorOverlayState state,
                       ULONGLONG stateElapsed) {
    if (!surface || !ManagedCursorPoint(x, y)) return false;
    HDC surfaceDc = nullptr;
    if (FAILED(surface->GetDC(&surfaceDc)) || !surfaceDc) return false;
    DrawCursorOverlayShape(surfaceDc, x, y, buttonDown, state, stateElapsed);
    surface->ReleaseDC(surfaceDc);
    return true;
}

void __fastcall CursorOverlayDrawCursorTo(void* interfaceObject, void*,
                                          LPDIRECTDRAWSURFACE surface,
                                          bool adjust) {
    DrawCursorToFunction original = g_originalDrawCursorTo;
    if (!original) return;
    CursorOverlayFrame* frame = g_cursorOverlayFrame;
    LPDIRECTDRAWSURFACE drawSurface = nullptr;
    const bool overlayFrame = frame && frame->requested && !frame->prepared &&
        !adjust && frame->interfaceObject == interfaceObject &&
        SafeRead(reinterpret_cast<uintptr_t>(interfaceObject) +
                     pvz::ddInterface::drawSurface,
                 drawSurface) &&
        surface == drawSurface;
    if (overlayFrame) {
        frame->prepared = true;
        frame->surface = surface;
        frame->backed = SaveCursorOverlayBacking(
            surface, frame->x, frame->y, frame->backing);
    }

    original(interfaceObject, surface, adjust);

    if (overlayFrame && frame->backed) {
        frame->composited = DrawCursorOverlay(
            surface, frame->x, frame->y, frame->buttonDown, frame->state,
            frame->stateElapsed);
    }
}

bool __fastcall CursorOverlayRedraw(void* interfaceObject, void*, void* clipRect) {
    RedrawFunction original = g_originalRedraw;
    if (!original || !interfaceObject) return false;

    uint8_t initialized = 0;
    const bool ready = SafeRead(reinterpret_cast<uintptr_t>(interfaceObject) +
                                    pvz::ddInterface::initialized,
                                initialized) && initialized;
    int x = 0;
    int y = 0;
    const bool requested = ready && g_cursorOverlayEnabled.load() &&
                           ReadInternalCursorPoint(x, y);
    CursorOverlayFrame frame;
    if (requested) {
        const ULONGLONG now = GetTickCount64();
        const ULONGLONG stateSince =
            g_cursorOverlayStateSince.load(std::memory_order_acquire);
        frame.interfaceObject = interfaceObject;
        frame.x = x;
        frame.y = y;
        frame.buttonDown = g_cursorOverlayButtonDown.load();
        frame.state = g_cursorOverlayState.load(std::memory_order_acquire);
        frame.stateElapsed = now >= stateSince ? now - stateSince : 0;
        frame.requested = true;
    }

    CursorOverlayFrame* previousFrame = g_cursorOverlayFrame;
    g_cursorOverlayFrame = requested ? &frame : nullptr;
    const bool result = original(interfaceObject, requested ? nullptr : clipRect);
    g_cursorOverlayFrame = previousFrame;
    if (frame.backed) {
        auto* critical = reinterpret_cast<CRITICAL_SECTION*>(
            reinterpret_cast<uintptr_t>(interfaceObject) +
            pvz::ddInterface::criticalSection);
        EnterCriticalSection(critical);
        RestoreCursorOverlayBacking(frame.surface, frame.backing);
        LeaveCriticalSection(critical);
    }
    if (result) CapturePresentedWhackTargets();
    return result;
}

bool RedrawDetourPointsToOverlay() {
    std::array<uint8_t, pvz::ddInterface::redrawDetourSize> patch{};
    if (!SafeCopy(patch.data(), pvz::ddInterface::redraw, patch.size()) ||
        patch[0] != 0xE9) return false;
    int32_t displacement = 0;
    std::memcpy(&displacement, patch.data() + 1, sizeof(displacement));
    const uintptr_t destination = pvz::ddInterface::redraw + patch.size() + displacement;
    return destination == reinterpret_cast<uintptr_t>(&CursorOverlayRedraw);
}

bool RedrawHookSignature() {
    return Signature(pvz::ddInterface::redraw, pvz::ddInterface::redrawSignature,
                     sizeof(pvz::ddInterface::redrawSignature)) ||
           (g_redrawHookInstalled.load() && RedrawDetourPointsToOverlay());
}

bool CursorDrawDetourPointsToOverlay() {
    std::array<uint8_t, pvz::ddInterface::drawCursorToDetourSize> patch{};
    if (!SafeCopy(patch.data(), pvz::ddInterface::drawCursorTo, patch.size()) ||
        patch[0] != 0xE9) return false;
    int32_t displacement = 0;
    std::memcpy(&displacement, patch.data() + 1, sizeof(displacement));
    const uintptr_t destination =
        pvz::ddInterface::drawCursorTo + patch.size() + displacement;
    return destination == reinterpret_cast<uintptr_t>(&CursorOverlayDrawCursorTo);
}

bool CursorDrawHookSignature() {
    return Signature(pvz::ddInterface::drawCursorTo,
                     pvz::ddInterface::drawCursorToSignature,
                     sizeof(pvz::ddInterface::drawCursorToSignature)) ||
           (g_cursorDrawHookInstalled.load() &&
            CursorDrawDetourPointsToOverlay());
}

bool RelativeJump(uint8_t* output, uintptr_t source, uintptr_t destination) {
    const int64_t displacement = static_cast<int64_t>(destination) -
                                 static_cast<int64_t>(source + 5);
    if (displacement < INT32_MIN || displacement > INT32_MAX) return false;
    output[0] = 0xE9;
    const int32_t relative = static_cast<int32_t>(displacement);
    std::memcpy(output + 1, &relative, sizeof(relative));
    return true;
}

bool PinImplantModule() {
    HMODULE pinned = nullptr;
    return GetModuleHandleExW(
               GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
               reinterpret_cast<LPCWSTR>(reinterpret_cast<const void*>(&CursorOverlayRedraw)),
               &pinned) != FALSE && pinned == g_module;
}

bool InstallCursorOverlayHook() {
    if (g_redrawHookInstalled.load()) return RedrawDetourPointsToOverlay();
    if (!Signature(pvz::ddInterface::redraw, pvz::ddInterface::redrawSignature,
                   sizeof(pvz::ddInterface::redrawSignature)) ||
        !PinImplantModule()) return false;

    constexpr size_t kTrampolineSize = pvz::ddInterface::redrawDetourSize + 5;
    auto* trampoline = static_cast<uint8_t*>(VirtualAlloc(
        nullptr, kTrampolineSize, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE));
    if (!trampoline) return false;
    std::memcpy(trampoline, reinterpret_cast<const void*>(pvz::ddInterface::redraw),
                pvz::ddInterface::redrawDetourSize);
    if (!RelativeJump(trampoline + pvz::ddInterface::redrawDetourSize,
                      reinterpret_cast<uintptr_t>(trampoline) +
                          pvz::ddInterface::redrawDetourSize,
                      pvz::ddInterface::redraw + pvz::ddInterface::redrawDetourSize)) {
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }
    if (!FlushInstructionCache(GetCurrentProcess(), trampoline, kTrampolineSize)) {
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }

    std::array<uint8_t, pvz::ddInterface::redrawDetourSize> patch{};
    if (!RelativeJump(patch.data(), pvz::ddInterface::redraw,
                      reinterpret_cast<uintptr_t>(&CursorOverlayRedraw))) {
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }
    g_originalRedraw = reinterpret_cast<RedrawFunction>(trampoline);
    DWORD originalProtection = 0;
    if (!VirtualProtect(reinterpret_cast<void*>(pvz::ddInterface::redraw), patch.size(),
                        PAGE_EXECUTE_READWRITE, &originalProtection)) {
        g_originalRedraw = nullptr;
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }
    std::memcpy(reinterpret_cast<void*>(pvz::ddInterface::redraw), patch.data(), patch.size());
    const BOOL flushed = FlushInstructionCache(
        GetCurrentProcess(), reinterpret_cast<const void*>(pvz::ddInterface::redraw), patch.size());
    DWORD ignored = 0;
    const BOOL restored = VirtualProtect(reinterpret_cast<void*>(pvz::ddInterface::redraw),
                                         patch.size(), originalProtection, &ignored);
    g_redrawHookInstalled.store(true);
    return flushed && restored && RedrawDetourPointsToOverlay();
}

bool InstallCursorDrawHook() {
    if (g_cursorDrawHookInstalled.load()) return CursorDrawDetourPointsToOverlay();
    if (!Signature(pvz::ddInterface::drawCursorTo,
                   pvz::ddInterface::drawCursorToSignature,
                   sizeof(pvz::ddInterface::drawCursorToSignature)) ||
        !PinImplantModule()) return false;

    constexpr size_t kTrampolineSize =
        pvz::ddInterface::drawCursorToDetourSize + 5;
    auto* trampoline = static_cast<uint8_t*>(VirtualAlloc(
        nullptr, kTrampolineSize, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE));
    if (!trampoline) return false;
    std::memcpy(trampoline,
                reinterpret_cast<const void*>(pvz::ddInterface::drawCursorTo),
                pvz::ddInterface::drawCursorToDetourSize);
    if (!RelativeJump(trampoline + pvz::ddInterface::drawCursorToDetourSize,
                      reinterpret_cast<uintptr_t>(trampoline) +
                          pvz::ddInterface::drawCursorToDetourSize,
                      pvz::ddInterface::drawCursorTo +
                          pvz::ddInterface::drawCursorToDetourSize)) {
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }
    if (!FlushInstructionCache(GetCurrentProcess(), trampoline, kTrampolineSize)) {
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }

    std::array<uint8_t, pvz::ddInterface::drawCursorToDetourSize> patch{};
    if (!RelativeJump(patch.data(), pvz::ddInterface::drawCursorTo,
                      reinterpret_cast<uintptr_t>(&CursorOverlayDrawCursorTo))) {
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }
    g_originalDrawCursorTo = reinterpret_cast<DrawCursorToFunction>(trampoline);
    DWORD originalProtection = 0;
    if (!VirtualProtect(reinterpret_cast<void*>(pvz::ddInterface::drawCursorTo),
                        patch.size(), PAGE_EXECUTE_READWRITE, &originalProtection)) {
        g_originalDrawCursorTo = nullptr;
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return false;
    }
    std::memcpy(reinterpret_cast<void*>(pvz::ddInterface::drawCursorTo),
                patch.data(), patch.size());
    const BOOL flushed = FlushInstructionCache(
        GetCurrentProcess(),
        reinterpret_cast<const void*>(pvz::ddInterface::drawCursorTo), patch.size());
    DWORD ignored = 0;
    const BOOL restored = VirtualProtect(
        reinterpret_cast<void*>(pvz::ddInterface::drawCursorTo), patch.size(),
        originalProtection, &ignored);
    g_cursorDrawHookInstalled.store(true);
    return flushed && restored && CursorDrawDetourPointsToOverlay();
}

bool InstallCursorOverlayHooks() {
    if (!InstallCursorDrawHook() || !InstallCursorOverlayHook()) return false;
    g_cursorOverlayEnabled.store(true);
    return true;
}

struct ImportPatch {
    PVOID volatile* entry = nullptr;
    void* original = nullptr;
};

bool FindMainImport(const char* importedModule, const char* importedFunction,
                    ImportPatch& patch) {
    auto* base = reinterpret_cast<uint8_t*>(GetModuleHandleW(nullptr));
    if (!base) return false;
    auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew <= 0) return false;
    auto* nt = reinterpret_cast<IMAGE_NT_HEADERS32*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR32_MAGIC) return false;
    const IMAGE_DATA_DIRECTORY& directory =
        nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!directory.VirtualAddress || directory.Size < sizeof(IMAGE_IMPORT_DESCRIPTOR)) return false;

    auto* descriptor = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(base + directory.VirtualAddress);
    for (; descriptor->Name; ++descriptor) {
        const char* moduleName = reinterpret_cast<const char*>(base + descriptor->Name);
        if (_stricmp(moduleName, importedModule) != 0) continue;
        const DWORD namesRva = descriptor->OriginalFirstThunk
            ? descriptor->OriginalFirstThunk
            : descriptor->FirstThunk;
        auto* names = reinterpret_cast<IMAGE_THUNK_DATA32*>(base + namesRva);
        auto* slots = reinterpret_cast<IMAGE_THUNK_DATA32*>(base + descriptor->FirstThunk);
        for (; names->u1.AddressOfData; ++names, ++slots) {
            if (IMAGE_SNAP_BY_ORDINAL32(names->u1.Ordinal)) continue;
            auto* import = reinterpret_cast<IMAGE_IMPORT_BY_NAME*>(base + names->u1.AddressOfData);
            if (std::strcmp(reinterpret_cast<const char*>(import->Name), importedFunction) != 0) {
                continue;
            }
            patch.entry = reinterpret_cast<PVOID volatile*>(&slots->u1.Function);
            patch.original = const_cast<void*>(*patch.entry);
            return patch.original != nullptr;
        }
    }
    return false;
}

struct ImportPage {
    void* base = nullptr;
    DWORD protection = 0;
};

HWND WINAPI CaptureSafeSetCapture(HWND window);
BOOL WINAPI CaptureSafeReleaseCapture();
HCURSOR WINAPI CaptureSafeSetCursor(HCURSOR cursor);

bool PhysicalCursorTargetsPvzWindow() {
    POINT point{};
    if (!GetCursorPos(&point)) return false;
    HWND target = WindowFromPoint(point);
    if (!target) return false;
    DWORD processId = 0;
    GetWindowThreadProcessId(target, &processId);
    return processId == GetCurrentProcessId();
}

bool SwapImportGroup(const std::array<ImportPatch, 3>& patches,
                     const std::array<void*, 3>& values) {
    SYSTEM_INFO systemInfo{};
    GetSystemInfo(&systemInfo);
    if (!systemInfo.dwPageSize ||
        std::any_of(patches.begin(), patches.end(),
                    [](const ImportPatch& patch) { return patch.entry == nullptr; })) return false;
    const uintptr_t mask = static_cast<uintptr_t>(systemInfo.dwPageSize - 1);
    std::array<ImportPage, 3> pages{};
    size_t pageCount = 0;
    for (const ImportPatch& patch : patches) {
        void* page = reinterpret_cast<void*>(
            reinterpret_cast<uintptr_t>(patch.entry) & ~mask);
        if (std::any_of(pages.begin(), pages.begin() + pageCount,
                        [page](const ImportPage& existing) { return existing.base == page; })) {
            continue;
        }
        pages[pageCount++].base = page;
    }
    size_t writableCount = 0;
    for (; writableCount < pageCount; ++writableCount) {
        if (!VirtualProtect(pages[writableCount].base, systemInfo.dwPageSize,
                            PAGE_READWRITE, &pages[writableCount].protection)) {
            break;
        }
    }
    if (writableCount != pageCount) {
        while (writableCount) {
            --writableCount;
            DWORD ignored = 0;
            VirtualProtect(pages[writableCount].base, systemInfo.dwPageSize,
                           pages[writableCount].protection, &ignored);
        }
        return false;
    }

    for (size_t index = 0; index < patches.size(); ++index) {
        InterlockedExchangePointer(patches[index].entry, values[index]);
    }
    bool restored = true;
    while (writableCount) {
        --writableCount;
        DWORD ignored = 0;
        restored = VirtualProtect(pages[writableCount].base, systemInfo.dwPageSize,
                                  pages[writableCount].protection, &ignored) != FALSE && restored;
    }
    return restored && std::equal(
        patches.begin(), patches.end(), values.begin(),
        [](const ImportPatch& patch, void* value) { return *patch.entry == value; });
}

bool InstallInternalMouseCaptureBypass() {
    if (g_captureBypassInstalled.load(std::memory_order_acquire)) return true;
    ImportPatch setCapture{};
    ImportPatch releaseCapture{};
    ImportPatch setCursor{};
    if (!FindMainImport("USER32.dll", "SetCapture", setCapture) ||
        !FindMainImport("USER32.dll", "ReleaseCapture", releaseCapture) ||
        !FindMainImport("USER32.dll", "SetCursor", setCursor) ||
        setCapture.original == reinterpret_cast<void*>(&CaptureSafeSetCapture) ||
        releaseCapture.original == reinterpret_cast<void*>(&CaptureSafeReleaseCapture) ||
        setCursor.original == reinterpret_cast<void*>(&CaptureSafeSetCursor)) {
        return false;
    }
    g_originalSetCapture.store(
        reinterpret_cast<SetCaptureFunction>(setCapture.original), std::memory_order_release);
    g_originalReleaseCapture.store(
        reinterpret_cast<ReleaseCaptureFunction>(releaseCapture.original),
        std::memory_order_release);
    g_originalSetCursor.store(
        reinterpret_cast<SetCursorFunction>(setCursor.original), std::memory_order_release);
    const std::array patches{setCapture, releaseCapture, setCursor};
    const std::array replacements{
        reinterpret_cast<void*>(&CaptureSafeSetCapture),
        reinterpret_cast<void*>(&CaptureSafeReleaseCapture),
        reinterpret_cast<void*>(&CaptureSafeSetCursor),
    };
    if (!SwapImportGroup(patches, replacements)) {
        SwapImportGroup(patches, std::array<void*, 3>{
            setCapture.original, releaseCapture.original, setCursor.original,
        });
        return false;
    }
    g_captureBypassInstalled.store(true, std::memory_order_release);
    return true;
}

HWND WINAPI CaptureSafeSetCapture(HWND window) {
    if (g_internalMouseDispatch) return nullptr;
    SetCaptureFunction original = g_originalSetCapture.load(std::memory_order_acquire);
    return original ? original(window) : nullptr;
}

BOOL WINAPI CaptureSafeReleaseCapture() {
    if (g_internalMouseDispatch) return TRUE;
    ReleaseCaptureFunction original = g_originalReleaseCapture.load(std::memory_order_acquire);
    return original ? original() : FALSE;
}

HCURSOR WINAPI CaptureSafeSetCursor(HCURSOR cursor) {
    if (g_internalMouseDispatch || g_widgetHoverOwnedByInternal.load(std::memory_order_acquire)
        || !PhysicalCursorTargetsPvzWindow()) return GetCursor();
    SetCursorFunction original = g_originalSetCursor.load(std::memory_order_acquire);
    return original ? original(cursor) : nullptr;
}

bool InternalMouseDispatchSignature() {
    return Signature(pvz::widgetManager::remapMouse,
                     pvz::widgetManager::remapMouseSignature,
                     sizeof(pvz::widgetManager::remapMouseSignature)) &&
           Signature(pvz::widgetManager::mouseMove,
                     pvz::widgetManager::mouseMoveSignature,
                     sizeof(pvz::widgetManager::mouseMoveSignature)) &&
           Signature(pvz::widgetManager::mouseDown,
                     pvz::widgetManager::mouseDownSignature,
                     sizeof(pvz::widgetManager::mouseDownSignature)) &&
           Signature(pvz::widgetManager::mouseUp,
                     pvz::widgetManager::mouseUpSignature,
                     sizeof(pvz::widgetManager::mouseUpSignature));
}

bool DispatchInternalMouse(WPARAM rawAction, LPARAM lParam) {
    const auto action = static_cast<InternalMouseAction>(rawAction);
    if (action != InternalMouseAction::Move &&
        action != InternalMouseAction::LeftDown &&
        action != InternalMouseAction::LeftUp &&
        action != InternalMouseAction::RightDown &&
        action != InternalMouseAction::RightUp) return false;
    uintptr_t lawnApp = 0;
    uintptr_t manager = 0;
    if (!SafeRead(pvz::kGlobalLawnApp, lawnApp) || !lawnApp ||
        !SafeRead(lawnApp + pvz::app::widgetManager, manager) || !manager) return false;
    int x = static_cast<short>(LOWORD(lParam));
    int y = static_cast<short>(HIWORD(lParam));
    using RemapMouseFunction = void (__thiscall*)(void*, int&, int&);
    using MouseMoveFunction = bool (__thiscall*)(void*, int, int);
    using MouseButtonFunction = bool (__thiscall*)(void*, int, int, int);
    reinterpret_cast<RemapMouseFunction>(pvz::widgetManager::remapMouse)(
        reinterpret_cast<void*>(manager), x, y);
    reinterpret_cast<MouseMoveFunction>(pvz::widgetManager::mouseMove)(
        reinterpret_cast<void*>(manager), x, y);
    if (action == InternalMouseAction::Move) return true;
    const int clickCount = action == InternalMouseAction::RightDown ||
                           action == InternalMouseAction::RightUp ? -1 : 1;
    const uintptr_t buttonFunction = action == InternalMouseAction::LeftDown ||
                                     action == InternalMouseAction::RightDown
        ? pvz::widgetManager::mouseDown
        : pvz::widgetManager::mouseUp;
    return reinterpret_cast<MouseButtonFunction>(buttonFunction)(
        reinterpret_cast<void*>(manager), x, y, clickCount);
}

bool PhysicalMouseMessage(UINT message) {
    return message == WM_MOUSEMOVE || message == WM_LBUTTONDOWN ||
           message == WM_LBUTTONUP || message == WM_RBUTTONDOWN ||
           message == WM_RBUTTONUP || message == WM_MBUTTONDOWN ||
           message == WM_MBUTTONUP;
}

constexpr LONG ManagedWindowOrigin(LONG requested, LONG workStart, LONG workEnd,
                                   LONG windowExtent) {
    const LONG last = workEnd - windowExtent;
    if (last < workStart) return workStart;
    return requested < workStart ? workStart : requested > last ? last : requested;
}

static_assert(ManagedWindowOrigin(-40, 0, 1920, 812) == 0 &&
              ManagedWindowOrigin(2500, 2560, 5120, 812) == 2560 &&
              ManagedWindowOrigin(4700, 2560, 5120, 812) == 4308);

bool ManagedWindowExtent(HWND window, UINT dpi, SIZE& extent) {
    if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window),
                                      DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return false;
    RECT frame{0, 0, pvz::kManagedClientWidth, pvz::kManagedClientHeight};
    const DWORD style = static_cast<DWORD>(GetWindowLongPtrW(window, GWL_STYLE));
    const DWORD exStyle = static_cast<DWORD>(GetWindowLongPtrW(window, GWL_EXSTYLE));
    if (!dpi || !AdjustWindowRectExForDpi(&frame, style, GetMenu(window) != nullptr,
                                           exStyle, dpi)) return false;
    extent.cx = frame.right - frame.left;
    extent.cy = frame.bottom - frame.top;
    return extent.cx > 0 && extent.cy > 0;
}

constexpr bool ManagedWindowFits(LONG start, LONG end, LONG extent) {
    return end - start >= extent;
}

static_assert(ManagedWindowFits(0, 812, 812) && ManagedWindowFits(2560, 5120, 812) &&
              !ManagedWindowFits(0, 640, 812));

/**
 * 一块屏幕上可以摆窗口的范围。
 *
 * 先要工作区;工作区放不下就退回整块屏幕——窗口宁可压住任务栏,也不该有一部分落在
 * 屏幕外面:屏幕外那部分既截不出画面(窗口 DC 只读得到屏上的像素),鼠标消息落进去
 * 也验不了真。两个都放不下才算这块屏幕摆不了。
 */
bool ManagedWindowBounds(HMONITOR monitor, const SIZE& extent, RECT& bounds) {
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (!monitor || !GetMonitorInfoW(monitor, &info)) return false;
    if (ManagedWindowFits(info.rcWork.left, info.rcWork.right, extent.cx) &&
        ManagedWindowFits(info.rcWork.top, info.rcWork.bottom, extent.cy)) {
        bounds = info.rcWork;
        return true;
    }
    if (ManagedWindowFits(info.rcMonitor.left, info.rcMonitor.right, extent.cx) &&
        ManagedWindowFits(info.rcMonitor.top, info.rcMonitor.bottom, extent.cy)) {
        bounds = info.rcMonitor;
        return true;
    }
    return false;
}

/**
 * 优先将窗口放在就近且容纳得下的屏幕；该屏幕空间不足时回落主屏，保持窗口可完整捕获和点击。
 */
bool ManagedWindowTarget(HWND window, UINT dpi, const RECT* preferred, RECT& target) {
    SIZE extent{};
    if (!ManagedWindowExtent(window, dpi, extent)) return false;
    RECT anchor{};
    if (preferred) anchor = *preferred;
    else if (!GetWindowRect(window, &anchor)) return false;
    RECT bounds{};
    if (!ManagedWindowBounds(MonitorFromRect(&anchor, MONITOR_DEFAULTTONEAREST), extent, bounds) &&
        !ManagedWindowBounds(MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY), extent, bounds)) {
        return false;
    }
    target.left = ManagedWindowOrigin(anchor.left, bounds.left, bounds.right, extent.cx);
    target.top = ManagedWindowOrigin(anchor.top, bounds.top, bounds.bottom, extent.cy);
    target.right = target.left + extent.cx;
    target.bottom = target.top + extent.cy;
    return true;
}

bool RepairManagedWindow(HWND window, UINT dpi = 0, const RECT* preferred = nullptr) {
    static thread_local bool repairing = false;
    if (repairing || !window) return false;
    if (!dpi) dpi = GetDpiForWindow(window);
    RECT target{};
    RECT outer{};
    RECT client{};
    if (!ManagedWindowTarget(window, dpi, preferred, target) ||
        !GetWindowRect(window, &outer) || !GetClientRect(window, &client)) return false;
    const bool exactClient = client.right - client.left == pvz::kManagedClientWidth &&
                             client.bottom - client.top == pvz::kManagedClientHeight;
    if (exactClient && EqualRect(&outer, &target)) return true;
    repairing = true;
    const bool positioned = SetWindowPos(
        window, nullptr, target.left, target.top,
        target.right - target.left, target.bottom - target.top,
        SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER) != FALSE;
    repairing = false;
    return positioned && GetClientRect(window, &client) &&
           client.right - client.left == pvz::kManagedClientWidth &&
           client.bottom - client.top == pvz::kManagedClientHeight;
}

constexpr ULONGLONG kWindowRepairRetryMs = 500;

/**
 * 现在该不该自动把窗口摆回去。
 *
 * 人正拖着它的时候不能动——那会把窗口从手底下弹走;最小化了也不动——那是人的操作,
 * 强行还原比裁剪更过分。这两种情况都只是"此刻不能操作",照旧如实报出去。
 */
bool ManagedWindowMoveInProgress() {
    if (!g_windowMoveInProgress.load(std::memory_order_acquire)) return false;
    if (GetAsyncKeyState(VK_LBUTTON) < 0) return true;
    g_windowMoveInProgress.store(false, std::memory_order_release);
    return false;
}

bool ManagedWindowRepairAllowed(HWND window) {
    return window && !ManagedWindowMoveInProgress() && !IsIconic(window);
}

LRESULT DispatchRelativePlantMessage(WPARAM token);

LRESULT CALLBACK InternalMouseWindowProc(HWND window, UINT message,
                                         WPARAM wParam, LPARAM lParam) {
    WNDPROC original = g_originalWindowProc.load(std::memory_order_acquire);
    if (!original) return DefWindowProcW(window, message, wParam, lParam);
    if (message == WM_GETDPISCALEDSIZE) {
        SIZE extent{};
        return lParam && ManagedWindowExtent(window, static_cast<UINT>(wParam), extent) &&
               SafeWrite(static_cast<uintptr_t>(lParam), extent) ? TRUE : FALSE;
    }
    if (message == WM_ENTERSIZEMOVE) {
        g_windowMoveInProgress.store(true, std::memory_order_release);
    } else if (message == WM_EXITSIZEMOVE) {
        g_windowMoveInProgress.store(false, std::memory_order_release);
    }
    if (message == WM_DPICHANGED) {
        RECT suggested{};
        const bool validSuggestion = lParam &&
            SafeCopy(&suggested, static_cast<uintptr_t>(lParam), sizeof(suggested));
        if (!validSuggestion) return CallWindowProcW(original, window, message, wParam, lParam);
        CallWindowProcW(original, window, message, wParam, lParam);
        RepairManagedWindow(window, LOWORD(wParam), &suggested);
        return 0;
    }
    const bool previous = g_internalMouseDispatch;
    const bool relative = message == kRelativePlantWindowMessage;
    const bool internal = message == kInternalMouseWindowMessage || relative;
    if (internal) {
        g_widgetHoverOwnedByInternal.store(true, std::memory_order_release);
    } else if (PhysicalMouseMessage(message)) {
        // 内部光标按住时独占 widget 悬停，屏蔽物理鼠标消息。
        // 物理鼠标移动会被 WidgetManager 当作 MouseDrag，
        // 清除当前控件的 mIsOver；随后 MouseUp 即使被控件接收，
        // 也不会触发该按钮。
        if (g_cursorOverlayButtonDown.load()) return 0;
        g_widgetHoverOwnedByInternal.store(false, std::memory_order_release);
    }
    g_internalMouseDispatch = internal;
    const LRESULT result = relative ? DispatchRelativePlantMessage(wParam) : internal
        ? (DispatchInternalMouse(wParam, lParam) ? 0 : -1)
        : CallWindowProcW(original, window, message, wParam, lParam);
    g_internalMouseDispatch = previous;
    // WINDOWPOSCHANGED 覆盖"没有人拖、窗口却被挪了或改了大小"的全部来路:显示器拓扑
    // 变化、别的程序摆的、游戏自己在换屏后重建表面时摆的。拖动期间由上面那个标志挡住。
    if (message == WM_EXITSIZEMOVE || message == WM_DISPLAYCHANGE
        || message == WM_WINDOWPOSCHANGED) {
        if (ManagedWindowRepairAllowed(window)) RepairManagedWindow(window);
    }
    return result;
}

bool EnsureInternalMouseDispatch(HWND window) {
    if (!window || !g_captureBypassInstalled.load(std::memory_order_acquire)) return false;
    AcquireSRWLockExclusive(&g_windowSubclassLock);
    if (g_internalMouseWindow.load(std::memory_order_acquire) == window &&
        reinterpret_cast<WNDPROC>(GetWindowLongPtrW(window, GWLP_WNDPROC)) ==
            &InternalMouseWindowProc) {
        ReleaseSRWLockExclusive(&g_windowSubclassLock);
        return true;
    }
    if (g_internalMouseWindow.load(std::memory_order_acquire) ||
        g_originalWindowProc.load(std::memory_order_acquire)) {
        ReleaseSRWLockExclusive(&g_windowSubclassLock);
        return false;
    }

    WNDPROC original = reinterpret_cast<WNDPROC>(GetWindowLongPtrW(window, GWLP_WNDPROC));
    if (!original || original == &InternalMouseWindowProc) {
        ReleaseSRWLockExclusive(&g_windowSubclassLock);
        return false;
    }
    g_originalWindowProc.store(original, std::memory_order_release);
    SetLastError(ERROR_SUCCESS);
    const LONG_PTR previous = SetWindowLongPtrW(
        window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&InternalMouseWindowProc));
    if (!previous && GetLastError() != ERROR_SUCCESS) {
        g_originalWindowProc.store(nullptr, std::memory_order_release);
        ReleaseSRWLockExclusive(&g_windowSubclassLock);
        return false;
    }
    WNDPROC installedOver = reinterpret_cast<WNDPROC>(previous);
    if (installedOver) g_originalWindowProc.store(installedOver, std::memory_order_release);
    if (reinterpret_cast<WNDPROC>(GetWindowLongPtrW(window, GWLP_WNDPROC)) !=
        &InternalMouseWindowProc) {
        ReleaseSRWLockExclusive(&g_windowSubclassLock);
        return false;
    }
    g_internalMouseWindow.store(window, std::memory_order_release);
    ReleaseSRWLockExclusive(&g_windowSubclassLock);
    return true;
}

bool FocusLossPolicySignature() {
    const bool audio =
        Signature(pvz::audio::muteOnLostFocusInitializer,
                  pvz::audio::muteOnLostFocusEnabledSignature,
                  sizeof(pvz::audio::muteOnLostFocusEnabledSignature)) ||
        Signature(pvz::audio::muteOnLostFocusInitializer,
                  pvz::audio::muteOnLostFocusDisabledSignature,
                  sizeof(pvz::audio::muteOnLostFocusDisabledSignature));
    const bool focus =
        Signature(pvz::focus::lostFocus,
                  pvz::focus::lostFocusPauseSignature,
                  sizeof(pvz::focus::lostFocusPauseSignature)) ||
        Signature(pvz::focus::lostFocus,
                  pvz::focus::lostFocusSkipPauseSignature,
                  sizeof(pvz::focus::lostFocusSkipPauseSignature));
    return audio && focus;
}

bool PatchVerifiedByte(uintptr_t address, const uint8_t* original, const uint8_t* patched,
                       size_t signatureSize, size_t byteOffset) {
    if (Signature(address, patched, signatureSize)) return true;
    if (!Signature(address, original, signatureSize)) return false;
    const uintptr_t target = address + byteOffset;
    DWORD originalProtection = 0;
    if (!VirtualProtect(reinterpret_cast<void*>(target), sizeof(uint8_t),
                        PAGE_EXECUTE_READWRITE, &originalProtection)) return false;
    *reinterpret_cast<volatile uint8_t*>(target) = patched[byteOffset];
    const BOOL flushed = FlushInstructionCache(GetCurrentProcess(),
                                               reinterpret_cast<const void*>(target),
                                               sizeof(uint8_t));
    DWORD ignored = 0;
    const BOOL restored = VirtualProtect(reinterpret_cast<void*>(target), sizeof(uint8_t),
                                         originalProtection, &ignored);
    return flushed && restored && Signature(address, patched, signatureSize);
}

bool PrepareFocusLossPolicy() {
    return PatchVerifiedByte(
               pvz::audio::muteOnLostFocusInitializer,
               pvz::audio::muteOnLostFocusEnabledSignature,
               pvz::audio::muteOnLostFocusDisabledSignature,
               sizeof(pvz::audio::muteOnLostFocusEnabledSignature),
               pvz::audio::muteOnLostFocusImmediate) &&
           PatchVerifiedByte(
               pvz::focus::lostFocus,
               pvz::focus::lostFocusPauseSignature,
               pvz::focus::lostFocusSkipPauseSignature,
               sizeof(pvz::focus::lostFocusPauseSignature),
               pvz::focus::lostFocusPauseBranch);
}

Validation ValidateExecutableUnlocked() {
    Validation result;
    const std::wstring path = ExecutablePathWide();
    const std::string hash = Sha256File(path);
    if (hash.size() != 64) {
        result.reason = "cannot hash the executable";
        return result;
    }
    result.hash = hash;
    result.version = FileVersion(path);
    if (result.hash != pvz::kExecutableSha256) {
        result.reason = "executable SHA-256 is not the pinned APAC JA 1073 build";
        return result;
    }
    if (reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr)) != pvz::kImageBase) {
        result.reason = "image base is not 0x00400000";
        return result;
    }

    IMAGE_DOS_HEADER dos{};
    if (!SafeRead(pvz::kImageBase, dos) || dos.e_magic != IMAGE_DOS_SIGNATURE) {
        result.reason = "invalid DOS header";
        return result;
    }
    IMAGE_NT_HEADERS32 nt{};
    if (!SafeRead(pvz::kImageBase + static_cast<uint32_t>(dos.e_lfanew), nt) ||
        nt.Signature != IMAGE_NT_SIGNATURE || nt.FileHeader.Machine != IMAGE_FILE_MACHINE_I386 ||
        nt.FileHeader.TimeDateStamp != pvz::kPeTimestamp ||
        nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR32_MAGIC ||
        nt.OptionalHeader.ImageBase != pvz::kImageBase ||
        nt.OptionalHeader.AddressOfEntryPoint != pvz::kPeEntryPoint ||
        nt.OptionalHeader.SizeOfImage != pvz::kPeSizeOfImage ||
        nt.OptionalHeader.CheckSum != pvz::kPeChecksum ||
        nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC].Size != 0 ||
        (nt.OptionalHeader.DllCharacteristics & IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE)) {
        result.reason = "PE identity or relocation policy mismatch";
        return result;
    }

    static constexpr uint8_t accessor1[] = {
        0xA1, 0xF8, 0x78, 0x75, 0x00, 0x85, 0xC0, 0x75, 0x03, 0x32,
        0xC0, 0xC3, 0x8A, 0x80, 0x54, 0x09, 0x00, 0x00, 0xC3};
    static constexpr uint8_t accessor2[] = {
        0xA1, 0xF8, 0x78, 0x75, 0x00, 0x85, 0xC0, 0x74, 0x18, 0x8B, 0x80, 0x4C,
        0x09, 0x00, 0x00, 0x85, 0xC0, 0x74, 0x0E, 0x33, 0xC9, 0x39, 0x88, 0x30,
        0x03, 0x00, 0x00, 0x0F, 0x95, 0xC1, 0x8A, 0xC1, 0xC3, 0x32, 0xC0, 0xC3};
    static constexpr uint8_t constructor[] = {
        0xC7, 0x45, 0x00, 0x80, 0x0D, 0x71, 0x00,
        0xC7, 0x45, 0x04, 0x30, 0x0F, 0x71, 0x00};
    static constexpr uint8_t virtualAccessor[] = {
        0x8B, 0x0D, 0xF8, 0x78, 0x75, 0x00, 0x8B, 0x11,
        0x8B, 0x82, 0xC4, 0x00, 0x00, 0x00, 0xFF, 0xD0};
    if (!Signature(0x0045DE20, accessor1, sizeof(accessor1)) ||
        !Signature(0x0045DE40, accessor2, sizeof(accessor2)) ||
        !Signature(0x0045E05D, constructor, sizeof(constructor)) ||
        !Signature(0x0045DFCD, virtualAccessor, sizeof(virtualAccessor)) ||
        !Signature(pvz::title::mouseDown, pvz::title::mouseDownSignature,
                   sizeof(pvz::title::mouseDownSignature)) ||
        !Signature(pvz::player::copyConstructor,
                   pvz::player::copyConstructorSignature,
                   sizeof(pvz::player::copyConstructorSignature)) ||
        !Signature(pvz::player::nameStorageAccess,
                   pvz::player::nameStorageAccessSignature,
                   sizeof(pvz::player::nameStorageAccessSignature)) ||
        !Signature(pvz::cutScene::endSeedChooser,
                   pvz::cutScene::endSeedChooserSignature,
                   sizeof(pvz::cutScene::endSeedChooserSignature)) ||
        !FocusLossPolicySignature() || !RedrawHookSignature() ||
        !CursorDrawHookSignature() ||
        !InternalMouseDispatchSignature()) {
        result.reason = "critical LawnApp accessor signature mismatch";
        return result;
    }
    result.supported = true;
    result.version = pvz::kExecutableVersion;
    return result;
}

Validation ValidateExecutable() {
    AcquireSRWLockShared(&g_profilePatchLock);
    Validation result = ValidateExecutableUnlocked();
    ReleaseSRWLockShared(&g_profilePatchLock);
    return result;
}

bool ReadLawnApp(uintptr_t& lawnApp, std::string* reason = nullptr) {
    lawnApp = 0;
    if (!g_validation.supported) {
        if (reason) *reason = g_validation.reason;
        return false;
    }
    if (!SafeRead(pvz::kGlobalLawnApp, lawnApp) || !lawnApp) {
        if (reason) *reason = "LawnApp is not initialized";
        return false;
    }
    uintptr_t primary = 0;
    uintptr_t secondary = 0;
    if (!SafeRead(lawnApp, primary) || !SafeRead(lawnApp + 4, secondary) ||
        primary != pvz::kLawnAppVtable || secondary != pvz::kLawnAppSecondaryVtable) {
        if (reason) *reason = "live LawnApp vtable mismatch";
        return false;
    }
    return true;
}

template <typename Callback>
void IterateArray(uintptr_t owner, size_t offset, size_t objectSize, size_t stride,
                  uint32_t hardLimit, Callback callback) {
    ArrayHeader header{};
    if (!SafeRead(owner + offset, header) || !header.block || header.maxSize > hardLimit ||
        header.maxUsedCount > header.maxSize || header.size > header.maxSize) return;
    std::array<uint8_t, 0x200> item{};
    if (stride > item.size() || objectSize + sizeof(uint32_t) > stride) return;
    for (uint32_t index = 0; index < header.maxUsedCount; ++index) {
        const uintptr_t address = header.block + static_cast<uintptr_t>(index) * stride;
        if (!SafeCopy(item.data(), address, stride)) continue;
        const uint32_t id = Field<uint32_t>(item, objectSize);
        if ((id & 0xFFFF0000U) == 0 || (id & 0xFFFFU) != index) continue;
        callback(item, id);
    }
}

const char* const kPlantNames[] = {
    "peashooter", "sunflower", "cherry_bomb", "wall_nut", "potato_mine", "snow_pea",
    "chomper", "repeater", "puff_shroom", "sun_shroom", "fume_shroom", "grave_buster",
    "hypno_shroom", "scaredy_shroom", "ice_shroom", "doom_shroom", "lily_pad", "squash",
    "threepeater", "tangle_kelp", "jalapeno", "spikeweed", "torchwood", "tall_nut",
    "sea_shroom", "plantern", "cactus", "blover", "split_pea", "starfruit", "pumpkin",
    "magnet_shroom", "cabbage_pult", "flower_pot", "kernel_pult", "coffee_bean", "garlic",
    "umbrella_leaf", "marigold", "melon_pult", "gatling_pea", "twin_sunflower",
    "gloom_shroom", "cattail", "winter_melon", "gold_magnet", "spikerock", "cob_cannon",
    "imitater", "explod_o_nut", "giant_wall_nut", "sprout", "leftpeater"};

const char* const kZombieNames[] = {
    "zombie", "flag_zombie", "conehead", "pole_vaulting", "buckethead", "newspaper",
    "screen_door", "football", "dancing", "backup_dancer", "ducky_tube", "snorkel",
    "zomboni", "bobsled", "dolphin_rider", "jack_in_the_box", "balloon", "digger",
    "pogo", "yeti", "bungee", "ladder", "catapult", "gargantuar", "imp", "dr_zomboss",
    "pea_head", "wall_nut_head", "jalapeno_head", "gatling_head", "squash_head",
    "tall_nut_head", "giga_gargantuar"};

const char* const kModeNames[] = {
    "adventure", "survival_day", "survival_night", "survival_pool", "survival_fog",
    "survival_roof", "survival_hard_day", "survival_hard_night", "survival_hard_pool",
    "survival_hard_fog", "survival_hard_roof", "survival_endless_day",
    "survival_endless_night", "survival_endless_pool", "survival_endless_fog",
    "survival_endless_roof", "zom_botany", "wall_nut_bowling", "slot_machine",
    "its_raining_seeds", "beghouled", "invisighoul", "seeing_stars", "zombiquarium",
    "beghouled_twist", "big_trouble_little_zombie", "portal_combat",
    "column_like_you_see_em", "bobsled_bonanza", "zombie_nimble_zombie_quick",
    "whack_a_zombie", "last_stand", "zom_botany_2", "wall_nut_bowling_2", "pogo_party",
    "dr_zomboss_revenge", "limbo_wall_nut_art", "limbo_sunny_day", "limbo_unsodded",
    "limbo_big_time", "limbo_sunflower_art", "limbo_air_raid", "limbo_ice", "zen_garden",
    "limbo_high_gravity", "limbo_grave_danger", "limbo_can_you_dig_it",
    "limbo_dark_stormy_night", "limbo_bungee_blitz", "limbo_intro", "tree_of_wisdom",
    "vasebreaker_1", "vasebreaker_2", "vasebreaker_3", "vasebreaker_4", "vasebreaker_5",
    "vasebreaker_6", "vasebreaker_7", "vasebreaker_8", "vasebreaker_9",
    "vasebreaker_endless", "i_zombie_1", "i_zombie_2", "i_zombie_3", "i_zombie_4",
    "i_zombie_5", "i_zombie_6", "i_zombie_7", "i_zombie_8", "i_zombie_9",
    "i_zombie_endless", "upsell_test", "intro"};

constexpr int kPlantCosts[] = {
    100, 50, 150, 50, 25, 175, 150, 200, 0, 25, 75, 75, 75, 25, 75, 125, 25, 50,
    325, 25, 125, 100, 175, 125, 0, 25, 125, 100, 125, 125, 125, 100, 100, 25,
    100, 75, 50, 100, 50, 300, 250, 150, 150, 225, 200, 50, 125, 500, 0};

std::string PlantName(int type) {
    if (type >= 0 && type < static_cast<int>(std::size(kPlantNames))) return kPlantNames[type];
    return "plant_" + std::to_string(type);
}

std::string ZombieName(int type) {
    if (type >= 0 && type < static_cast<int>(std::size(kZombieNames))) return kZombieNames[type];
    return "zombie_" + std::to_string(type);
}

std::string CardName(int type) {
    if (type >= 0 && type < 53) return PlantName(type);
    switch (type) {
        case 54: return "shuffle";
        case 55: return "remove_crater";
        case 56: return "slot_sun";
        case 57: return "slot_diamond";
        case 58: return "zombiquarium_snorkel";
        case 59: return "zombiquarium_trophy";
        case 60: return "zombie";
        case 61: return "conehead";
        case 62: return "pole_vaulting";
        case 63: return "buckethead";
        case 64: return "ladder";
        case 65: return "digger";
        case 66: return "bungee";
        case 67: return "football";
        case 68: return "balloon";
        case 69: return "screen_door";
        case 70: return "zomboni";
        case 71: return "pogo";
        case 72: return "dancing";
        case 73: return "gargantuar";
        case 74: return "imp";
        default: return "card_" + std::to_string(type);
    }
}

constexpr int CardCost(int type, int imitater) {
    if (type == 48 && imitater >= 0 && imitater < static_cast<int>(std::size(kPlantCosts))) {
        return kPlantCosts[imitater];
    }
    if (type >= 0 && type < static_cast<int>(std::size(kPlantCosts))) return kPlantCosts[type];
    switch (type) {
        case 54: return 100;
        case 55: return 200;
        case 56:
        case 57: return 0;
        case 58: return 100;
        case 59: return 1000;
        case 60: return 50;
        case 61:
        case 62: return 75;
        case 63: return 125;
        case 64: return 150;
        case 65:
        case 66: return 125;
        case 67: return 175;
        case 68: return 150;
        case 69: return 100;
        case 70: return 175;
        case 71: return 200;
        case 72: return 350;
        case 73: return 300;
        case 74: return 50;
        default: return -1;
    }
}

constexpr int ModeCardCost(int mode, int type, int imitater) {
    if ((mode == 20 || mode == 24) && type == 7) return 1000;
    if ((mode == 20 || mode == 24) && type == 10) return 500;
    if ((mode == 20 || mode == 24) && type == 23) return 250;
    return CardCost(type, imitater);
}

constexpr int PacketPlantType(int type, int imitater) {
    return type == 48 && imitater >= 0 && imitater < 53 ? imitater : type;
}

static_assert(ModeCardCost(20, 7, -1) == 1000 &&
              ModeCardCost(24, 10, -1) == 500 &&
              ModeCardCost(20, 23, -1) == 250 &&
              ModeCardCost(0, 7, -1) == 200 &&
              ModeCardCost(15, 48, 47) == 500 &&
              PacketPlantType(48, 47) == 47);

constexpr bool IsIZombieCard(int type) {
    return type >= 60 && type <= 74;
}

int IZombieZombieType(int cardType) {
    switch (cardType) {
        case 60: return 0;
        case 61: return 2;
        case 62: return 3;
        case 63: return 4;
        case 64: return 21;
        case 65: return 17;
        case 66: return 20;
        case 67: return 7;
        case 68: return 16;
        case 69: return 6;
        case 70: return 12;
        case 71: return 18;
        case 72: return 8;
        case 73: return 23;
        case 74: return 24;
        default: return -1;
    }
}

constexpr int IZombiePlacementLimit(int mode) {
    if (mode >= 61 && mode <= 65) return 4;
    if (mode >= 66 && mode <= 68) return 5;
    if (mode == 70) return 5;
    return 6;
}

constexpr bool IZombieCellAllowed(int mode, int cardType, int row, int column) {
    if (mode < 61 || mode > 70 || !IsIZombieCard(cardType) || row < 1 || row > 5 ||
        column < 1 || column > 9) return false;
    const int zeroBasedColumn = column - 1;
    const int limit = IZombiePlacementLimit(mode);
    return cardType == 66 ? zeroBasedColumn < limit : zeroBasedColumn >= limit;
}

static_assert(IZombieCellAllowed(61, 66, 1, 4) &&
              !IZombieCellAllowed(61, 66, 1, 5) &&
              IZombieCellAllowed(61, 60, 1, 5) &&
              !IZombieCellAllowed(61, 60, 1, 4) &&
              !IZombieCellAllowed(61, 66, 6, 1));

std::string ModeName(int mode) {
    if (mode >= 0 && mode < static_cast<int>(std::size(kModeNames))) return kModeNames[mode];
    return "mode_" + std::to_string(mode);
}

const char* ModeKind(int mode) {
    if (mode == 0) return "adventure";
    if (mode >= 1 && mode <= 15) return "survival";
    if (mode >= 16 && mode <= 35) return "minigame";
    if (mode == 43) return "zen_garden";
    if (mode == 50) return "tree_of_wisdom";
    if (mode >= 51 && mode <= 60) return "vasebreaker";
    if (mode >= 61 && mode <= 70) return "i_zombie";
    return "other";
}

const char* ThirdsDamageCondition(int health, int maximum) {
    if (maximum <= 0 || health * 3 >= maximum * 2) return "intact";
    if (health * 3 >= maximum) return "worn";
    return "critical";
}

const char* PlantVisibleCondition(int type, int health, int maximum) {
    if (type == 46) {  // Spikerock loses one visible spike at 300 and 150 health.
        if (maximum <= 0 || health > 300) return "intact";
        return health > 150 ? "worn" : "critical";
    }
    switch (type) {
        case 3:   // Wall-nut
        case 23:  // Tall-nut
        case 30:  // Pumpkin
        case 36:  // Garlic
            return ThirdsDamageCondition(health, maximum);
        default:
            return "intact";
    }
}

const char* PlantPhaseName(int type, int state) {
    if (state == 0) return type == 4 ? "potato_mine_arming" : "active";
    static constexpr const char* names[] = {
        "active", "ready", "doing_special",
        "squash_watching", "squash_launching", "squash_rising", "squash_falling",
        "squash_landed", "grave_buster_landing", "grave_buster_eating",
        "chomper_biting", "chomper_bite_hit", "chomper_bite_missed",
        "chomper_digesting", "chomper_swallowing",
        "potato_mine_rising", "potato_mine_armed", "potato_mine_triggered",
        "spikeweed_attacking", "spikeweed_recovering",
        "scaredy_shroom_lowering", "scaredy_shroom_hiding", "scaredy_shroom_rising",
        "sun_shroom_small", "sun_shroom_growing", "sun_shroom_large",
        "magnet_shroom_attracting", "magnet_shroom_recharging",
        "bowling_up", "bowling_down",
        "cactus_low", "cactus_rising", "cactus_high", "cactus_lowering",
        "tangle_kelp_grabbing",
        "cob_cannon_arming", "cob_cannon_loading", "cob_cannon_ready",
        "cob_cannon_firing", "kernel_pult_butter_shot",
        "umbrella_leaf_triggered", "umbrella_leaf_reflecting", "imitater_morphing",
        "zen_watered", "zen_needy", "zen_happy", "marigold_finishing",
        "flower_pot_invulnerable", "lily_pad_invulnerable",
    };
    static_assert(std::size(names) == 49);
    return state >= 0 && state < static_cast<int>(std::size(names))
        ? names[state] : "unknown";
}

const char* ZombiePhaseName(int phase) {
    static constexpr const char* names[] = {
        "walking", "dying", "burned", "mowed",
        "bungee_diving", "bungee_diving_screaming", "bungee_at_bottom",
        "bungee_grabbing", "bungee_rising", "bungee_stunned", "bungee_cutscene",
        "pole_vault_ready", "pole_vaulting", "pole_vault_spent", "rising_from_grave",
        "jack_running", "jack_popping", "bobsled_sliding", "bobsled_boarding",
        "bobsled_crashing", "pogo_bouncing", "pogo_high_bounce_1",
        "pogo_high_bounce_2", "pogo_high_bounce_3", "pogo_high_bounce_4",
        "pogo_high_bounce_5", "pogo_high_bounce_6", "pogo_forward_bounce_2",
        "pogo_forward_bounce_7", "newspaper_reading", "newspaper_enraging",
        "newspaper_enraged", "digger_tunneling", "digger_rising",
        "digger_paused_without_axe", "digger_rising_without_axe", "digger_stunned",
        "digger_retreating", "digger_walking_without_axe", "digger_cutscene",
        "dancer_arriving", "dancer_snapping", "dancer_snapping_lit",
        "dancer_snapping_hold", "dancer_dancing", "dancer_moving_to_summon",
        "dancer_summoning_left_1", "dancer_summoning_right_1",
        "dancer_summoning_left_2", "dancer_summoning_right_2", "dancer_rising",
        "dolphin_walking", "dolphin_entering_pool", "dolphin_riding",
        "dolphin_jumping", "dolphin_swimming", "dolphin_walking_without_dolphin",
        "snorkel_walking", "snorkel_entering_pool", "snorkel_submerged",
        "snorkel_rising_to_eat", "snorkel_eating", "snorkel_submerging",
        "zombiquarium_accelerating", "zombiquarium_drifting",
        "zombiquarium_turning", "zombiquarium_biting",
        "catapult_launching", "catapult_reloading", "gargantuar_throwing",
        "gargantuar_smashing", "imp_thrown", "imp_landing", "balloon_flying",
        "balloon_popping", "balloon_walking", "ladder_carrying", "ladder_placing",
        "boss_entering", "boss_idle", "boss_spawning", "boss_stomping",
        "boss_bungees_entering", "boss_bungees_dropping", "boss_bungees_leaving",
        "boss_dropping_rv", "boss_head_entering", "boss_aiming",
        "boss_recovering", "boss_spitting", "boss_head_leaving", "yeti_running",
        "squash_launching", "squash_rising", "squash_falling", "squash_landed",
    };
    static_assert(std::size(names) == 96);
    return phase >= 0 && phase < static_cast<int>(std::size(names))
        ? names[phase] : "unknown";
}

constexpr bool ZombiePhaseAirborne(int phase, int height, bool blowingAway) {
    return blowingAway || height == 7 || height == 9 ||
           (phase >= 4 && phase <= 10) || phase == 12 ||
           (phase >= 20 && phase <= 28) || phase == 52 || phase == 54 ||
           (phase >= 71 && phase <= 74);
}

constexpr bool ZombiePhaseStationary(int phase) {
    switch (phase) {
        case 1: case 2: case 3: case 14: case 16: case 18: case 19:
        case 30: case 33: case 34: case 35: case 36:
        case 41: case 42: case 43: case 46: case 47: case 48: case 49: case 50:
        case 58: case 60: case 61: case 62: case 66:
        case 67: case 68: case 69: case 70: case 77:
        case 78: case 79: case 80: case 81: case 82: case 83: case 84:
        case 85: case 86: case 87: case 88: case 89: case 90:
            return true;
        default:
            return false;
    }
}

constexpr bool ZombiePhaseAcceptsWhack(int phase) {
    return phase != 1 && phase != 2 && phase != 3;
}

static_assert(ZombiePhaseAirborne(12, 0, false) &&
              ZombiePhaseAirborne(0, 0, true) &&
              !ZombiePhaseAirborne(0, 0, false) &&
              ZombiePhaseStationary(16) && ZombiePhaseStationary(89) &&
              !ZombiePhaseStationary(0) &&
              ZombiePhaseAcceptsWhack(0) &&
              !ZombiePhaseAcceptsWhack(1) &&
              !ZombiePhaseAcceptsWhack(2) &&
              !ZombiePhaseAcceptsWhack(3));

// 走路时的位移不是"每逻辑帧加一次速度值":游戏取身体动画 _ground 轨道的位移推进僵尸,
// 而动画速率被定成 速度值 × 动画帧数 ÷ 轨道总位移 × 47,两者相乘,每秒地面位移正好是
// 速度值 × 47 像素。只有载具与腾空这几种相位才回到每逻辑帧直接加速度值(逻辑帧 100 帧/秒)。
// 冰冻把行走动画速率砍半,几种载具相位不吃这一刀。一格 80 像素。
constexpr double kZombieCellPixels = 80.0;
constexpr double kZombieGroundPixelsPerSecond = 47.0;
constexpr double kZombieLogicFramesPerSecond = 100.0;
constexpr double kZombieChilledFactor = 0.5;

// 相位号见 ZombiePhaseName 的表;类型 12 是冰车、22 是投石车。
constexpr bool ZombieVelocityIsPerFrame(int type, int phase) {
    return type == 12 || type == 22 ||
           (phase >= 20 && phase <= 28) ||  // 弹簧高跷弹跳
           phase == 12 ||                   // 撑杆腾空
           phase == 17 ||                   // 雪橇滑行
           phase == 32 ||                   // 矿工地下掘进
           phase == 53 || phase == 54 ||    // 海豚骑行、跃起
           phase == 58 || phase == 59 ||    // 潜水入水、水下推进
           phase == 73;                     // 气球飞行
}

constexpr bool ZombieChillSlowsMovement(int type, int phase) {
    return !(type == 12 || phase == 12 || phase == 17 ||
             phase == 32 || phase == 54 || phase == 58);
}

static_assert(!ZombieVelocityIsPerFrame(0, 0) && !ZombieVelocityIsPerFrame(4, 55) &&
              ZombieVelocityIsPerFrame(0, 59) && ZombieVelocityIsPerFrame(0, 24) &&
              ZombieVelocityIsPerFrame(12, 0) && ZombieVelocityIsPerFrame(22, 0) &&
              ZombieChillSlowsMovement(0, 0) && ZombieChillSlowsMovement(22, 0) &&
              ZombieChillSlowsMovement(0, 59) &&
              !ZombieChillSlowsMovement(12, 0) && !ZombieChillSlowsMovement(0, 32));

double ZombieCellsPerSecond(int type, int phase, float velocity, bool slowed) {
    if (!std::isfinite(velocity)) return 0.0;
    const double perSecond = std::fabs(static_cast<double>(velocity)) *
        (ZombieVelocityIsPerFrame(type, phase) ? kZombieLogicFramesPerSecond
                                               : kZombieGroundPixelsPerSecond);
    const double chilled = slowed && ZombieChillSlowsMovement(type, phase)
        ? kZombieChilledFactor : 1.0;
    return perSecond * chilled / kZombieCellPixels;
}

const char* ZombieSpeedName(int type, int phase, int height, float velocity,
                            bool eating, bool hypnotized, bool slowed,
                            bool immobilized, bool blowingAway, bool hasObject) {
    if (ZombiePhaseAirborne(phase, height, blowingAway)) return "airborne";
    if (eating || immobilized || ZombiePhaseStationary(phase) ||
        !std::isfinite(velocity) || std::fabs(velocity) <= 0.01f) return "stationary";
    const bool retreating = hypnotized || phase == 40 ||
        (type == 17 && (phase == 33 || phase == 36 || phase == 37)) ||
        (type == 19 && !hasObject);
    if (retreating) return "retreating";
    // 档位与数字同一把尺:0.12 与 0.35 格/秒就是原来 0.20 与 0.60 速度值的换算值。
    const double cells = ZombieCellsPerSecond(type, phase, velocity, slowed);
    if (slowed || cells < 0.12) return "slow";
    return cells < 0.35 ? "normal" : "fast";
}

int ZombieColumnTenths(int x) {
    return static_cast<int>(std::lround(x / 8.0));
}

int ZombieSpeedHundredths(const char* speed, int type, int phase, float velocity,
                          bool slowed) {
    if (std::strcmp(speed, "stationary") == 0) return 0;
    return std::max(0, static_cast<int>(std::lround(
        ZombieCellsPerSecond(type, phase, velocity, slowed) * 100.0)));
}

const char* ZombieVisibleCondition(int type, int height, int health, int maximum,
                                   bool hasHead, bool hasArm) {
    if (height == 10) return health < 100 ? "worn" : "intact";
    if (type == 25) {
        if (maximum <= 0 || health * 5 >= maximum * 4) return "intact";
        return health * 2 >= maximum ? "worn" : "critical";
    }
    if (type == 12 || type == 22 || type == 23 || type == 32) {
        return ThirdsDamageCondition(health, maximum);
    }
    if (!hasHead) return "critical";
    if (!hasArm) return "worn";
    return "intact";
}

const char* ArmorVisibleCondition(int zombieType, int type, int health, int maximum,
                                  bool shield) {
    if (maximum <= 0) return "none";
    if (health <= 0) {
        if (!shield && (zombieType == 27 || zombieType == 31)) return "critical";
        return "lost";
    }
    const bool hasVisibleDamage = shield ? type >= 1 && type <= 3
                                         : (type >= 1 && type <= 4) ||
                                           type == 7 || type == 8 || type == 9;
    return hasVisibleDamage ? ThirdsDamageCondition(health, maximum) : "intact";
}

const char* CursorName(int type) {
    static const char* const names[] = {
        "normal", "plant", "usable_seed", "glove_plant", "duplicator", "wheelbarrow_plant",
        "shovel", "hammer", "cob_cannon_target", "watering_can", "fertilizer", "bug_spray",
        "phonograph", "chocolate", "glove", "money_sign", "wheelbarrow", "tree_food"};
    return type >= 0 && type < static_cast<int>(std::size(names)) ? names[type] : "unknown";
}

const char* CoinName(int type) {
    static const char* const names[] = {
        "none", "silver_coin", "gold_coin", "diamond", "sun", "small_sun", "large_sun",
        "seed_packet", "trophy", "shovel", "almanac", "car_keys", "vase", "watering_can",
        "taco", "note", "usable_seed", "potted_plant", "money_bag", "present",
        "diamond_bag", "silver_sunflower", "gold_sunflower", "chocolate",
        "award_chocolate", "minigames_present", "puzzle_present", "survival_present"};
    return type >= 0 && type < static_cast<int>(std::size(names)) ? names[type] : "collectible";
}

const char* GridItemName(int type) {
    static const char* const names[] = {
        "none", "gravestone", "crater", "ladder", "round_portal", "square_portal", "i_zombie_brain",
        "vase", "unused", "zen_tool", "stinky", "rake", "i_zombie_brain"};
    return type >= 0 && type < static_cast<int>(std::size(names)) ? names[type] : "grid_item";
}

const char* MowerName(int type) {
    static const char* const names[] = {"lawn_mower", "pool_cleaner", "roof_cleaner", "super_mower"};
    return type >= 0 && type < static_cast<int>(std::size(names)) ? names[type] : "mower";
}

constexpr bool MowerTriggeredState(int state) {
    return state == 2 || state == 3;
}

constexpr bool MowerPublishable(bool disclosure, int state, bool dead, bool visible,
                                int row, int type) {
    return disclosure && state >= 0 && state <= 3 && !dead && visible &&
           row >= 0 && row < 6 && type >= 0 && type < 4;
}

static_assert(!MowerTriggeredState(0) && !MowerTriggeredState(1) &&
              MowerTriggeredState(2) && MowerTriggeredState(3));
static_assert(!MowerPublishable(false, 1, false, true, 0, 0) &&
              MowerPublishable(true, 1, false, true, 0, 0) &&
              !MowerPublishable(true, 1, true, true, 0, 0));

}  // namespace

namespace {

struct PlantView {
    uint32_t id;
    int type;
    int row;
    int column;
    int state;
    int health;
    int maxHealth;
    int x;
    int y;
    int width;
    int height;
    int pottedIndex;
    bool sleeping;
    bool squished;
};

struct ZombieView {
    uint32_t id;
    int type;
    int phase;
    int row;
    int column;
    int targetColumn;
    int height;
    int x;
    float velocityX;
    int hitX;
    int hitY;
    int hitLeft;
    int hitTop;
    int hitWidth;
    int hitHeight;
    int renderOrder;
    int health;
    int maxHealth;
    int armorHealth;
    int armorMax;
    int armorType;
    int shieldHealth;
    int shieldMax;
    int shieldType;
    bool hasHead;
    bool hasArm;
    bool hypnotized;
    bool slowed;
    bool immobilized;
    bool eating;
    bool blowingAway;
    bool hasObject;
    bool whackPresented;
    float actualX;
};

struct GridItemView {
    uint32_t id;
    int type;
    int row;
    int column;
    int potContentType;
    int seedType;
    int zombieType;
    int transparentCounter;
    int sunCount;
};

struct CollectibleView {
    uint32_t id;
    uint32_t rawId;
    int type;
    int containedType;
    int x;
    int y;
    int hitLeft;
    int hitTop;
    int hitRight;
    int hitBottom;
};

struct MowerView {
    int row;
    int type;
    bool triggered;
};

struct CardView {
    int slot;
    int type;
    int imitater;
    int refreshCounter;
    int refreshTime;
    int timesUsed;
    bool active;
    bool refreshing;
    int x;
    int y;
};

struct BoardView {
    uintptr_t lawnApp = 0;
    uintptr_t address = 0;
    int rows = 5;
    int level = 0;
    int background = 0;
    int sun = 0;
    int sunBeingCollected = 0;
    int numWaves = 0;
    int currentWave = 0;
    int mainCounter = 0;
    int progressMeterWidth = -1;
    int tutorialState = 0;
    int boardFadeOutCounter = 0;
    int nextSurvivalStageCounter = 0;
    bool paused = false;
    bool complete = false;
    bool levelAwardSpawned = false;
    bool entitiesVisible = true;
    int challengeState = -1;
    int challengeCounter = 0;
    int challengeScore = 0;
    int survivalStage = 0;
    int slotCounter = 0;
    int challengeMouseCapture = 0;
    std::array<bool, 3> beghouledUpgrades{};
    int beghouledCraterCount = 0;
    int cursorType = 0;
    int cursorHeldType = -1;
    int cursorImitaterType = -1;
    int cursorSeedBankIndex = -1;
    uint32_t cursorCoinRawId = 0;
    std::array<int, 53> plantCounts{};
    std::vector<CardView> cards;
    std::vector<PlantView> plants;
    std::vector<ZombieView> zombies;
    std::vector<GridItemView> gridItems;
    std::vector<CollectibleView> collectibles;
    std::vector<MowerView> mowers;
};

constexpr int RisingZombieVisibleHeight(int height, int altitude, int phaseCounter) {
    const int clipHeight = -altitude + std::min(phaseCounter, 40);
    return clipHeight > -100 ? height - clipHeight : height;
}

static_assert(RisingZombieVisibleHeight(115, -200, 150) < 0 &&
              RisingZombieVisibleHeight(115, -40, 10) == 65 &&
              RisingZombieVisibleHeight(115, 0, 0) == 115);

bool ZombieVisibleRect(const std::array<uint8_t, 0x200>& item,
                       int& left, int& top, int& width, int& height) {
    left = static_cast<int>(std::floor(Field<float>(item, 0x2C))) + Field<int>(item, 0x8C);
    top = static_cast<int>(std::floor(Field<float>(item, 0x30))) + Field<int>(item, 0x90);
    width = Field<int>(item, 0x94);
    height = Field<int>(item, 0x98);
    if (Field<int>(item, 0x28) == 14) {
        const int altitude = static_cast<int>(Field<float>(item, 0x84));
        top -= altitude;
        height = RisingZombieVisibleHeight(height, altitude, Field<int>(item, 0x68));
    }
    return width > 0 && height > 0 && left < 800 && top < 600 &&
           left + width > 0 && top + height > 0;
}

constexpr int kWhackHitRadius = 45;
constexpr uint8_t kWhackPresentedFrames = 2;

constexpr bool WhackPerceptibleRect(int width, int height) {
    return width > 0 && height >= kWhackHitRadius;
}

static_assert(!WhackPerceptibleRect(80, kWhackHitRadius - 1) &&
              WhackPerceptibleRect(80, kWhackHitRadius));

bool WhackTargetWasPresented(uintptr_t board, int mode, int level,
                             uint32_t publicId) {
    AcquireSRWLockShared(&g_whackPresentationLock);
    const auto found = g_whackPresentation.visibleFrames.find(publicId);
    const bool presented = g_whackPresentation.board == board &&
                           g_whackPresentation.mode == mode &&
                           g_whackPresentation.level == level &&
                           found != g_whackPresentation.visibleFrames.end() &&
                           found->second >= kWhackPresentedFrames;
    ReleaseSRWLockShared(&g_whackPresentationLock);
    return presented;
}

bool FogAllowsZombie(uintptr_t board, int mode, int background, int x, int row) {
    if (mode == 21) return false;
    if (background != 3) return true;
    float fogOffset = 0.0f;
    if (!SafeRead(board + pvz::board::fogOffset, fogOffset)) return false;
    const int fogColumn = static_cast<int>(std::floor((x - fogOffset + 15.0f) / 80.0f));
    if (fogColumn < 0) return true;
    if (fogColumn >= 10 || row < 0 || row >= 6) return false;
    for (int column : {fogColumn, fogColumn - 1}) {
        if (column < 0 || column >= 9) continue;
        for (int sampleRow : {row, row + 1}) {
            if (sampleRow < 0 || sampleRow >= 7) continue;
            int opacity = 255;
            const uintptr_t cell = board + pvz::board::fogGrid +
                static_cast<uintptr_t>((column * 7 + sampleRow) * sizeof(int));
            if (!SafeRead(cell, opacity)) return false;
            if (opacity <= 48) return true;
        }
    }
    return false;
}

constexpr int IZombieBungeeRow(int background, int x, int y) {
    int bestRow = 0;
    int bestDistance = INT_MAX;
    for (int row = 0; row < 5; ++row) {
        int expectedY = 0;
        if (background == 4 || background == 5) {
            const int slope = x + 40 < 440 ? (440 - (x + 40)) / 4 : 0;
            expectedY = row * 85 + slope + 40;
        } else if (background == 2 || background == 3) {
            expectedY = row * 85 + 50;
        } else {
            expectedY = row * 100 + 50;
        }
        const int delta = y - expectedY;
        const int distance = delta < 0 ? -delta : delta;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestRow = row;
        }
    }
    return bestRow;
}


static_assert(IZombieBungeeRow(0, 80, 250) == 2 &&
              IZombieBungeeRow(2, 80, 305) == 3 &&
              IZombieBungeeRow(4, 80, 460) == 4);

bool StormAllowsBoardDisclosure(int mode, int level, int state, int counter) {
    const bool stormLevel = mode == 48 || (mode == 0 && level == 40);
    if (!stormLevel) return true;
    int time = 0;
    int maximum = 0;
    if (state == 5 && counter < 300) {
        time = counter > 150 ? counter - 150 : counter;
        maximum = counter > 150 ? 255 : 92;
    } else if (state == 6 && counter < 300) {
        time = counter / 2;
        maximum = 255;
    } else if (state == 7 && counter < 150) {
        time = counter;
        maximum = 255;
    } else {
        return false;
    }
    return time > 0 && maximum * time / 150 >= 33;
}

bool HasConveyorSeedBank(int mode, int level) {
    if (mode == 0 && (level == 5 || level == 10 || level == 20 || level == 25 ||
                      level == 30 || level == 40 || level == 45 || level == 50)) return true;
    return mode == 17 || mode == 21 || mode == 25 || mode == 26 || mode == 27 ||
           mode == 33 || mode == 34 || mode == 46 || mode == 48 || mode == 49;
}

constexpr bool IsUpgradePlant(int type) {
    return type == 40 || type == 41 || type == 42 || type == 43 ||
           type == 44 || type == 45 || type == 46 || type == 47;
}

static_assert(IsUpgradePlant(40) && IsUpgradePlant(47) && !IsUpgradePlant(39) &&
              !IsUpgradePlant(48));

constexpr int SurvivalEndlessCardCost(int mode, int rawType, int baseCost, int planted) {
    return baseCost >= 0 && mode >= 11 && mode <= 15 && IsUpgradePlant(rawType)
        ? baseCost + planted * 50 : baseCost;
}

static_assert(SurvivalEndlessCardCost(13, 47, 500, 2) == 600 &&
              SurvivalEndlessCardCost(10, 47, 500, 2) == 500 &&
              SurvivalEndlessCardCost(13, 48, 500, 2) == 500);

int CurrentCardCost(const BoardView& board, int mode, const CardView& card) {
    int cost = ModeCardCost(mode, card.type, card.imitater);
    const int planted = card.type >= 0 &&
        card.type < static_cast<int>(board.plantCounts.size())
        ? board.plantCounts[static_cast<size_t>(card.type)] : 0;
    return SurvivalEndlessCardCost(mode, card.type, cost, planted);
}

constexpr bool PacketCooldownReady(bool paused, bool active, bool refreshing, int counter) {
    return !paused && active && !refreshing && counter <= 0;
}

constexpr bool SunCanAfford(bool conveyor, int cost, int sun, int incomingSun) {
    return conveyor || (cost >= 0 && sun + incomingSun >= cost);
}

static_assert(PacketCooldownReady(false, true, false, 0) &&
              !PacketCooldownReady(true, true, false, 0) &&
              !PacketCooldownReady(false, true, true, 0) &&
              !SunCanAfford(false, 100, 99, 0) &&
              SunCanAfford(false, 100, 75, 25) &&
              SunCanAfford(true, -1, 0, 0));

bool CardCooldownReady(const BoardView& board, const CardView& card) {
    return PacketCooldownReady(
        board.paused, card.active, card.refreshing, card.refreshCounter);
}

bool CardAffordable(const BoardView& board, int mode, const CardView& card) {
    const int cost = CurrentCardCost(board, mode, card);
    return SunCanAfford(HasConveyorSeedBank(mode, board.level), cost,
                        board.sun, board.sunBeingCollected);
}

bool CardUsable(const BoardView& board, int mode, const CardView& card) {
    return CardCooldownReady(board, card) && CardAffordable(board, mode, card);
}

constexpr int CooldownBucket(bool ready, int remaining, int total) {
    if (ready) return 0;
    if (total <= 0 || static_cast<int64_t>(remaining) * 3 <= total) return 1;
    if (static_cast<int64_t>(remaining) * 3 <= static_cast<int64_t>(total) * 2) return 2;
    return 3;
}

int CooldownRemainingPercent(bool ready, int remaining, int total) {
    if (ready || remaining <= 0) return 0;
    return total <= 0 ? 100 : std::clamp(
        static_cast<int>(std::lround(remaining * 100.0 / total)), 0, 100);
}

int CooldownRemainingTenthsSeconds(bool ready, int remaining) {
    return ready ? 0 : std::max(0, static_cast<int>(std::lround(remaining / 10.0)));
}

static_assert(CooldownBucket(true, 100, 100) == 0 &&
              CooldownBucket(false, 0, 100) == 1 &&
              CooldownBucket(false, 33, 100) == 1 &&
              CooldownBucket(false, 34, 100) == 2 &&
              CooldownBucket(false, 66, 100) == 2 &&
              CooldownBucket(false, 67, 100) == 3 &&
              CooldownBucket(false, 100, 100) == 3);

bool HasLevelTransition(const BoardView& board) {
    return board.levelAwardSpawned || board.nextSurvivalStageCounter > 0 ||
           board.boardFadeOutCounter >= 0;
}

bool CardIdentityMatches(const Command& command, const CardView& card) {
    const int imitates = card.imitater >= 0 && card.imitater < 53 ? card.imitater : -1;
    return command.expectedCardType >= 0 && command.expectedCardImitates >= -1 &&
           card.type == command.expectedCardType && imitates == command.expectedCardImitates;
}

bool IsBowlingLevel(int mode, int level) {
    return mode == 17 || mode == 33 || (mode == 0 && level == 5);
}

constexpr bool IsWhackLevel(int mode, int level) {
    return mode == 30 || (mode == 0 && level == 15);
}

constexpr bool IsVaseLevel(int mode, int level) {
    return (mode >= 51 && mode <= 60) || (mode == 0 && level == 35);
}

constexpr bool SameBoardCounterRun(int current, int initial) {
    return current >= initial;
}

constexpr bool KnownBoardResult(int value) {
    return value >= pvz::result::none && value <= pvz::result::cheat;
}

constexpr bool ValidRunIdentity(int mode, int level) {
    if (mode == 0) return level >= 1 && level <= 50;
    return mode >= 1 && mode <= 70 && level == 0;
}

constexpr bool PublicSeedPickerGate(int scene, bool validIdentity,
                                    bool boardPresent, bool cutScenePresent,
                                    bool cutSceneBoardMatches, bool seedChoosing,
                                    bool chooserPresent, bool chooserBoardMatches,
                                    bool chooserMouseVisible, bool stableTuple) {
    return scene == 2 && validIdentity && boardPresent && cutScenePresent &&
           cutSceneBoardMatches && seedChoosing && chooserPresent &&
           chooserBoardMatches && chooserMouseVisible && stableTuple;
}

constexpr bool ValidSeedPickerCapacity(int packetCount) {
    return packetCount > 0 && packetCount <= 10;
}

constexpr bool SeedPickerReady(int packetCount, int inBank, int inFlight) {
    return ValidSeedPickerCapacity(packetCount) && inBank == packetCount && inFlight == 0;
}

constexpr int AdventureSeedCount(int level) {
    if (level < 1) return 0;
    const int area = (level - 1) / 10 + 1;
    const int stage = (level - 1) % 10 + 1;
    int count = (area - 1) * 8 + stage;
    if (stage >= 10) count -= 2;
    else if (stage >= 5) count -= 1;
    return std::clamp(count, 0, 40);
}

struct SeedAvailabilityView {
    uintptr_t player = 0;
    int level = 0;
    int adventureCompletions = 0;
    std::array<int, pvz::purchase::plantUpgradeCount> plantUpgrades{};
};

constexpr bool SeedAvailableFromProfile(const SeedAvailabilityView& profile, int seed) {
    if (seed < 0 || seed >= pvz::chooser::visibleSeedCount) return false;
    if (seed >= 40) {
        return profile.plantUpgrades[static_cast<size_t>(
            seed - 40 + pvz::purchase::firstPlantUpgrade)] > 0;
    }
    const int count = profile.adventureCompletions > 0 || profile.level > 50
        ? 40 : AdventureSeedCount(profile.level);
    return seed < count;
}

constexpr bool SeedAllowedInChooserMode(int mode, int seed) {
    if (mode != 31) return true;
    return seed != 1 && seed != 8 && seed != 9 && seed != 24 && seed != 41;
}

bool ReadSeedAvailability(uintptr_t lawnApp, SeedAvailabilityView& view) {
    view = {};
    if (!SafeRead(lawnApp + pvz::app::playerInfo, view.player) || !view.player ||
        !SafeRead(view.player + pvz::player::level, view.level) ||
        !SafeRead(view.player + pvz::player::adventureCompletions,
                  view.adventureCompletions) ||
        !SafeCopy(view.plantUpgrades.data(),
                  view.player + pvz::player::purchases +
                      pvz::purchase::firstPlantUpgrade * sizeof(int),
                  sizeof(view.plantUpgrades))) return false;
    if (view.level < 1 || view.level > 1000 ||
        view.adventureCompletions < 0 || view.adventureCompletions > 1000) return false;
    return std::all_of(view.plantUpgrades.begin(), view.plantUpgrades.end(),
                       [](int purchase) { return purchase >= 0; });
}

bool SameSeedAvailability(const SeedAvailabilityView& left,
                          const SeedAvailabilityView& right) {
    return left.player == right.player && left.level == right.level &&
           left.adventureCompletions == right.adventureCompletions &&
           left.plantUpgrades == right.plantUpgrades;
}

constexpr SeedAvailabilityView kLevelEightSeedAvailability{
    1, 8, 0, {0, 0, 0, 0, 0, 0, 0, 0, 0}};
constexpr SeedAvailabilityView kCompletedSeedAvailability{
    1, 1, 1, {0, 0, 0, 0, 0, 0, 0, 0, 0}};
constexpr SeedAvailabilityView kPurchasedUpgradeSeedAvailability{
    1, 1, 1, {1, 0, 0, 0, 0, 0, 0, 0, 1}};
static_assert(AdventureSeedCount(1) == 1 && AdventureSeedCount(5) == 4 &&
              AdventureSeedCount(8) == 7 && AdventureSeedCount(10) == 8 &&
              AdventureSeedCount(50) == 40 &&
              SeedAvailableFromProfile(kLevelEightSeedAvailability, 6) &&
              !SeedAvailableFromProfile(kLevelEightSeedAvailability, 7) &&
              SeedAvailableFromProfile(kCompletedSeedAvailability, 39) &&
              !SeedAvailableFromProfile(kCompletedSeedAvailability, 40) &&
              SeedAvailableFromProfile(kPurchasedUpgradeSeedAvailability, 40) &&
              SeedAvailableFromProfile(kPurchasedUpgradeSeedAvailability, 48) &&
              SeedAllowedInChooserMode(0, 1) &&
              !SeedAllowedInChooserMode(31, 1) &&
              !SeedAllowedInChooserMode(31, 8) &&
              !SeedAllowedInChooserMode(31, 9) &&
              !SeedAllowedInChooserMode(31, 24) &&
              !SeedAllowedInChooserMode(31, 41) &&
              SeedAllowedInChooserMode(31, 0));

constexpr bool PublicBoardGate(int scene, bool validIdentity,
                               bool boardPresent, bool stableTuple) {
    return scene == 3 && validIdentity && boardPresent && stableTuple;
}

constexpr bool ShovelTutorialState(int tutorialState) {
    return tutorialState == pvz::tutorial::shovelPickup ||
           tutorialState == pvz::tutorial::shovelDig ||
           tutorialState == pvz::tutorial::shovelKeepDigging;
}

constexpr bool PublicShovelTutorialGate(int scene, int mode, int level,
                                        int tutorialState, bool boardPresent,
                                        bool cutScenePresent,
                                        bool cutSceneBoardMatches,
                                        bool stableTuple) {
    return scene == 2 && mode == 0 && level == 5 &&
           ShovelTutorialState(tutorialState) && boardPresent &&
           cutScenePresent && cutSceneBoardMatches && stableTuple;
}

constexpr bool SemanticBoardStartsRun(bool wasActive, uintptr_t previousBoard,
                                      int previousCounter, uintptr_t currentBoard,
                                      int currentCounter) {
    return currentBoard != 0 &&
           (!wasActive || previousBoard != currentBoard ||
            !SameBoardCounterRun(currentCounter, previousCounter));
}

constexpr bool ClearSemanticBoardHistory(uintptr_t rawBoard,
                                         uintptr_t semanticBoard) {
    return rawBoard == 0 && semanticBoard == 0;
}

constexpr bool SuppressTransientLoadingMenu(int scene, bool loading) {
    return scene == 2 && loading;
}

constexpr bool FinalWinForRun(int mode, int level, int survivalStage) {
    if (mode == 0) return level != 35 || survivalStage >= 2;
    if (mode >= 1 && mode <= 5) return survivalStage >= 4;
    if (mode >= 6 && mode <= 10) return survivalStage >= 4;
    if (mode >= 11 && mode <= 15) return false;
    if (mode == 31) return survivalStage >= 4;
    if (mode >= 16 && mode <= 49) return mode != 43;
    if (mode == 50 || mode == 60 || mode == 70) return false;
    if ((mode >= 51 && mode <= 59) || (mode >= 61 && mode <= 69)) return true;
    return false;
}

constexpr bool AdventureNextLevel(int previous, int current) {
    return (previous >= 1 && previous < 50 && current == previous + 1) ||
           (previous == 50 && current == 1);
}

constexpr int TerminalBoardResultDecision(int current, bool eligible,
                                          bool terminalSeen, bool winConfirmed) {
    if (!eligible || terminalSeen) return pvz::result::none;
    if (current == pvz::result::lost) return pvz::result::lost;
    return current == pvz::result::won && winConfirmed
        ? pvz::result::won : pvz::result::none;
}

static_assert(IsWhackLevel(30, 0) && IsWhackLevel(0, 15) &&
              !IsWhackLevel(0, 14));
static_assert(IsVaseLevel(51, 0) && IsVaseLevel(60, 0) &&
              IsVaseLevel(0, 35) && !IsVaseLevel(0, 34));
static_assert(SameBoardCounterRun(10, 10) && SameBoardCounterRun(11, 10) &&
              !SameBoardCounterRun(9, 10));
static_assert(KnownBoardResult(pvz::result::none) &&
              KnownBoardResult(pvz::result::cheat) && !KnownBoardResult(-1) &&
              !KnownBoardResult(pvz::result::cheat + 1));
static_assert(ValidRunIdentity(0, 1) && ValidRunIdentity(0, 50) &&
              !ValidRunIdentity(0, 0) && !ValidRunIdentity(0, 51) &&
              ValidRunIdentity(1, 0) && ValidRunIdentity(22, 0) &&
              ValidRunIdentity(51, 0) && !ValidRunIdentity(71, 0) &&
              !ValidRunIdentity(72, 0) &&
              !ValidRunIdentity(22, -1) && !ValidRunIdentity(22, 1));
static_assert(PublicSeedPickerGate(2, true, true, true, true, true,
                                   true, true, true, true));
static_assert(!PublicSeedPickerGate(3, true, true, true, true, true,
                                    true, true, true, true) &&
              !PublicSeedPickerGate(2, false, true, true, true, true,
                                    true, true, true, true) &&
              !PublicSeedPickerGate(2, true, true, false, true, true,
                                    true, true, true, true) &&
              !PublicSeedPickerGate(2, true, true, true, false, true,
                                    true, true, true, true) &&
              !PublicSeedPickerGate(2, true, true, true, true, false,
                                    true, true, true, true) &&
              !PublicSeedPickerGate(2, true, true, true, true, true,
                                    false, true, true, true) &&
              !PublicSeedPickerGate(2, true, true, true, true, true,
                                    true, false, true, true) &&
              !PublicSeedPickerGate(2, true, true, true, true, true,
                                    true, true, false, true) &&
              !PublicSeedPickerGate(2, true, true, true, true, true,
                                    true, true, true, false));
static_assert(ValidSeedPickerCapacity(1) && ValidSeedPickerCapacity(10) &&
              !ValidSeedPickerCapacity(0) && !ValidSeedPickerCapacity(11) &&
              SeedPickerReady(10, 10, 0) && !SeedPickerReady(10, 9, 0) &&
              !SeedPickerReady(10, 10, 1));
static_assert(PublicBoardGate(3, true, true, true) &&
              !PublicBoardGate(2, true, true, true) &&
              !PublicBoardGate(3, false, true, true) &&
              !PublicBoardGate(3, true, true, false));
static_assert(PublicShovelTutorialGate(
                  2, 0, 5, pvz::tutorial::shovelPickup,
                  true, true, true, true) &&
              PublicShovelTutorialGate(
                  2, 0, 5, pvz::tutorial::shovelDig,
                  true, true, true, true) &&
              PublicShovelTutorialGate(
                  2, 0, 5, pvz::tutorial::shovelKeepDigging,
                  true, true, true, true) &&
              !PublicShovelTutorialGate(
                  3, 0, 5, pvz::tutorial::shovelPickup,
                  true, true, true, true) &&
              !PublicShovelTutorialGate(
                  2, 17, 0, pvz::tutorial::shovelPickup,
                  true, true, true, true) &&
              !PublicShovelTutorialGate(
                  2, 0, 5, pvz::tutorial::shovelCompleted,
                  true, true, true, true) &&
              !PublicShovelTutorialGate(
                  2, 0, 5, pvz::tutorial::shovelPickup,
                  true, false, false, true) &&
              !PublicShovelTutorialGate(
                  2, 0, 5, pvz::tutorial::shovelPickup,
                  true, true, true, false));
static_assert(SemanticBoardStartsRun(false, 0, 0, 0x1000, 0) &&
              !SemanticBoardStartsRun(true, 0x1000, 100, 0x1000, 101) &&
              SemanticBoardStartsRun(true, 0x1000, 100, 0x1000, 99) &&
              SemanticBoardStartsRun(true, 0x1000, 100, 0x2000, 0));
static_assert(!ClearSemanticBoardHistory(0x1000, 0) &&
              !ClearSemanticBoardHistory(0x1000, 0x1000) &&
              ClearSemanticBoardHistory(0, 0));
static_assert(SuppressTransientLoadingMenu(2, true) &&
              !SuppressTransientLoadingMenu(2, false) &&
              !SuppressTransientLoadingMenu(0, true));
static_assert(!FinalWinForRun(1, 0, 0) && FinalWinForRun(1, 0, 4) &&
              !FinalWinForRun(6, 0, 3) && FinalWinForRun(6, 0, 4) &&
              !FinalWinForRun(31, 0, 3) && FinalWinForRun(31, 0, 4) &&
              !FinalWinForRun(0, 35, 1) && FinalWinForRun(0, 35, 2) &&
              !FinalWinForRun(11, 0, 99) && !FinalWinForRun(60, 0, 99) &&
              !FinalWinForRun(70, 0, 99) && FinalWinForRun(22, 0, 0) &&
              FinalWinForRun(51, 0, 0) && FinalWinForRun(61, 0, 0) &&
              !FinalWinForRun(43, 0, 0) &&
              !FinalWinForRun(50, 0, 0));
static_assert(AdventureNextLevel(1, 2) && AdventureNextLevel(49, 50) &&
              AdventureNextLevel(50, 1) && !AdventureNextLevel(10, 10));
static_assert(TerminalBoardResultDecision(
                  pvz::result::won, true, false, true) == pvz::result::won &&
              TerminalBoardResultDecision(
                  pvz::result::won, true, false, false) == pvz::result::none &&
              TerminalBoardResultDecision(
                  pvz::result::lost, true, false, false) == pvz::result::lost &&
              TerminalBoardResultDecision(
                  pvz::result::won, false, false, true) == pvz::result::none &&
              TerminalBoardResultDecision(
                  pvz::result::won, true, true, true) == pvz::result::none);

void CellCenter(uintptr_t board, int background, int row, int column, int& x, int& y) {
    x = column * 80 + 80;
    if (background == 4 || background == 5) {
        const int slope = column < 5 ? (5 - column) * 20 : 0;
        y = row * 85 + slope + 112;
    } else if (background == 2 || background == 3) {
        y = row * 85 + 122;
    } else {
        y = row * 100 + 130;
    }
    int square = 0;
    const uintptr_t cell = board + pvz::board::gridSquareType +
        static_cast<uintptr_t>((column * 6 + row) * sizeof(int));
    if (SafeRead(cell, square) && square == 4) y -= 30;
}

uint32_t PublicObjectId(uintptr_t board, int mainCounter, EntityKind kind, uint32_t raw) {
    AcquireSRWLockExclusive(&g_idLock);
    if (g_idBoard != board || !SameBoardCounterRun(mainCounter, g_idBoardCounter)) {
        for (auto& nameSpace : g_idNamespaces) {
            nameSpace.rawToPublic.clear();
            nameSpace.publicToRaw.clear();
            nameSpace.next = 1;
        }
        g_idBoard = board;
        g_idBoardCounter = mainCounter;
    } else {
        g_idBoardCounter = std::max(g_idBoardCounter, mainCounter);
    }
    auto& nameSpace = g_idNamespaces[static_cast<size_t>(kind)];
    const auto existing = nameSpace.rawToPublic.find(raw);
    if (existing != nameSpace.rawToPublic.end()) {
        const uint32_t result = existing->second;
        ReleaseSRWLockExclusive(&g_idLock);
        return result;
    }
    uint32_t candidate = raw & 0x7FFFFFFFu;
    const auto collision = nameSpace.publicToRaw.find(candidate);
    if (!candidate || (collision != nameSpace.publicToRaw.end() && collision->second != raw)) {
        do {
            candidate = nameSpace.next++ & 0x7FFFFFFFu;
        } while (!candidate || nameSpace.publicToRaw.find(candidate) != nameSpace.publicToRaw.end());
    }
    nameSpace.rawToPublic.emplace(raw, candidate);
    nameSpace.publicToRaw.emplace(candidate, raw);
    ReleaseSRWLockExclusive(&g_idLock);
    return candidate;
}

bool ReadBoard(uintptr_t lawnApp, int mode, BoardView& view,
               uintptr_t expectedAddress = 0,
               bool requirePresentedWhack = true) {
    view.lawnApp = lawnApp;
    if (!SafeRead(lawnApp + pvz::app::board, view.address) || !view.address ||
        (expectedAddress && view.address != expectedAddress)) return false;
    SafeRead(view.address + pvz::board::background, view.background);
    SafeRead(view.address + pvz::board::level, view.level);
    SafeRead(view.address + pvz::board::sun, view.sun);
    SafeRead(view.address + pvz::board::numWaves, view.numWaves);
    SafeRead(view.address + pvz::board::currentWave, view.currentWave);
    SafeRead(view.address + pvz::board::mainCounter, view.mainCounter);
    SafeRead(view.address + pvz::board::progressMeterWidth, view.progressMeterWidth);
    SafeRead(view.address + pvz::board::tutorialState, view.tutorialState);
    SafeRead(view.address + 0x5618, view.boardFadeOutCounter);
    SafeRead(view.address + 0x561C, view.nextSurvivalStageCounter);
    SafeRead(view.address + pvz::board::paused, view.paused);
    SafeRead(view.address + pvz::board::levelComplete, view.complete);
    SafeRead(view.address + pvz::board::levelAwardSpawned, view.levelAwardSpawned);
    view.rows = (view.background == 2 || view.background == 3) ? 6 : 5;

    uintptr_t challenge = 0;
    if (SafeRead(view.address + pvz::board::challenge, challenge) && challenge) {
        SafeRead(challenge + 0x08, view.challengeMouseCapture);
        SafeRead(challenge + 0x54, view.challengeState);
        SafeRead(challenge + 0x58, view.challengeCounter);
        SafeRead(challenge + 0x60, view.challengeScore);
        SafeRead(challenge + 0x6C, view.survivalStage);
        SafeRead(challenge + 0x70, view.slotCounter);
        if (mode == 20 || mode == 24) {
            for (size_t index = 0; index < view.beghouledUpgrades.size(); ++index) {
                uint8_t purchased = 0;
                if (SafeRead(challenge + 0x4A + index, purchased)) {
                    view.beghouledUpgrades[index] = purchased != 0;
                }
            }
            for (size_t index = 0; index < 9U * 6U; ++index) {
                uint8_t crater = 0;
                if (SafeRead(challenge + 0x14 + index, crater) && crater) {
                    ++view.beghouledCraterCount;
                }
            }
        }
    }

    const bool discloseBoardEntities = StormAllowsBoardDisclosure(
        mode, view.level, view.challengeState, view.challengeCounter);
    view.entitiesVisible = discloseBoardEntities;

    uintptr_t cursor = 0;
    if (SafeRead(view.address + pvz::board::cursorObject, cursor) && cursor) {
        SafeRead(cursor + 0x30, view.cursorType);
        SafeRead(cursor + 0x28, view.cursorHeldType);
        SafeRead(cursor + 0x2C, view.cursorImitaterType);
        SafeRead(cursor + 0x24, view.cursorSeedBankIndex);
        SafeRead(cursor + 0x34, view.cursorCoinRawId);
    }

    uintptr_t bank = 0;
    int packetCount = 0;
    int bankX = 0;
    int bankY = 0;
    if (SafeRead(view.address + pvz::board::seedBank, bank) && bank &&
        SafeRead(bank + 0x08, bankX) && SafeRead(bank + 0x0C, bankY) &&
        SafeRead(bank + pvz::seedBank::packetCount, packetCount) &&
        packetCount >= 0 && packetCount <= 10) {
        for (int slot = 0; slot < packetCount; ++slot) {
            std::array<uint8_t, pvz::seedBank::packetStride> packet{};
            const uintptr_t address = bank + pvz::seedBank::packets +
                                      static_cast<uintptr_t>(slot) * packet.size();
            if (!SafeCopy(packet.data(), address, packet.size())) continue;
            const int type = Field<int>(packet, 0x34);
            const int packetWidth = Field<int>(packet, 0x10);
            const int packetHeight = Field<int>(packet, 0x14);
            if (type < 0 || type > 255 || packetWidth <= 0 || packetWidth > 200 ||
                packetHeight <= 0 || packetHeight > 200) continue;
            const int centerX = bankX + Field<int>(packet, 0x08) + Field<int>(packet, 0x30) +
                                packetWidth / 2;
            const int centerY = bankY + Field<int>(packet, 0x0C) + packetHeight / 2;
            view.cards.push_back({
                slot, type, Field<int>(packet, 0x38), Field<int>(packet, 0x24),
                Field<int>(packet, 0x28), Field<int>(packet, 0x4C),
                Field<uint8_t>(packet, 0x48) != 0, Field<uint8_t>(packet, 0x49) != 0,
                centerX, centerY});
        }
    }

    if (!discloseBoardEntities) return true;

    IterateArray(view.address, pvz::board::plants, pvz::dataArray::plantObjectSize,
                 pvz::dataArray::plantStride, 1024,
                 [&](const std::array<uint8_t, 0x200>& item, uint32_t id) {
        const int type = Field<int>(item, 0x24);
        const int column = Field<int>(item, 0x28);
        const int row = Field<int>(item, 0x1C);
        const int x = Field<int>(item, 0x08) + std::max(Field<int>(item, 0x10), 1) / 2;
        if (type >= 0 && type < static_cast<int>(view.plantCounts.size())) {
            ++view.plantCounts[static_cast<size_t>(type)];
        }
        if (!discloseBoardEntities || !Field<uint8_t>(item, 0x18) || Field<uint8_t>(item, 0x141) ||
            !Field<uint8_t>(item, 0x144) || type < 0 || type > 255 ||
            column < 0 || column >= 9 || row < 0 || row >= 6 ||
            !FogAllowsZombie(view.address, 0, view.background, x, row)) return;
        const uint32_t publicId = PublicObjectId(
            view.address, view.mainCounter, EntityKind::Plant, id);
        view.plants.push_back({publicId, type, row, column, Field<int>(item, 0x3C), Field<int>(item, 0x40),
                              Field<int>(item, 0x44), Field<int>(item, 0x08), Field<int>(item, 0x0C),
                              Field<int>(item, 0x10), Field<int>(item, 0x14), Field<int>(item, 0x13C),
                              Field<uint8_t>(item, 0x143) != 0,
                              Field<uint8_t>(item, 0x142) != 0});
    });

    if (mode != 21 && discloseBoardEntities) {
        IterateArray(view.address, pvz::board::zombies, pvz::dataArray::zombieObjectSize,
                     pvz::dataArray::zombieStride, 1024,
                     [&](const std::array<uint8_t, 0x200>& item, uint32_t id) {
            const int type = Field<int>(item, 0x24);
            const int storedRow = Field<int>(item, 0x1C);
            const int x = static_cast<int>(Field<float>(item, 0x2C));
            const int y = static_cast<int>(Field<float>(item, 0x30));
            int hitLeft = 0;
            int hitTop = 0;
            int hitWidth = 0;
            int hitHeight = 0;
            const int fromWave = Field<int>(item, 0x6C);
            const bool iZombieBungee = mode >= 61 && mode <= 70 && type == 20;
            if (!Field<uint8_t>(item, 0x18) || Field<uint8_t>(item, 0xEC) ||
                 fromWave == -2 || fromWave == -3 || type < 0 || type > 255 ||
                 (!iZombieBungee && (storedRow < 0 || storedRow >= 6)) ||
                 !ZombieVisibleRect(item, hitLeft, hitTop, hitWidth, hitHeight)) return;
            const int hitX = hitLeft + hitWidth / 2;
            const int hitY = hitTop + hitHeight / 2 + 20;
            int row = storedRow;
            int column = std::clamp((x - 40) / 80, 0, 8);
            if (mode == 23) {
                row = std::clamp(static_cast<int>(std::floor((y - 40.0) / 100.0)), 0, 3);
                column = std::clamp(static_cast<int>(std::floor((x + 10.0) / 80.0)), 0, 8);
            } else if (mode >= 61 && mode <= 70) {
                if (iZombieBungee) {
                    const int targetColumn = Field<int>(item, 0x80);
                    if (targetColumn < 0 || targetColumn >= 9) return;
                    column = targetColumn;
                    row = IZombieBungeeRow(view.background, x, y);
                } else {
                    column = std::clamp(
                        static_cast<int>(std::lround((x - 10.0) / 80.0)), 0, 8);
                }
            }
            if (!FogAllowsZombie(view.address, mode, view.background, x, row)) return;
            const uint32_t publicId = PublicObjectId(
                view.address, view.mainCounter, EntityKind::Zombie, id);
            const bool whackPresented = !IsWhackLevel(mode, view.level) ||
                !requirePresentedWhack || WhackTargetWasPresented(
                    view.address, mode, view.level, publicId);
            view.zombies.push_back({
                publicId, type, Field<int>(item, 0x28), row, column,
                Field<int>(item, 0x80), Field<int>(item, 0x64),
                x, Field<float>(item, 0x34), hitX, hitY,
                hitLeft, hitTop, hitWidth, hitHeight, Field<int>(item, 0x20),
                Field<int>(item, 0xC8), Field<int>(item, 0xCC),
                Field<int>(item, 0xD0), Field<int>(item, 0xD4), Field<int>(item, 0xC4),
                Field<int>(item, 0xDC), Field<int>(item, 0xE0), Field<int>(item, 0xD8),
                Field<uint8_t>(item, 0xBA) != 0, Field<uint8_t>(item, 0xBB) != 0,
                Field<uint8_t>(item, 0xB8) != 0,
                Field<int>(item, 0xAC) > 0,
                Field<int>(item, 0xB0) > 0 || Field<int>(item, 0xB4) > 0,
                Field<uint8_t>(item, 0x51) != 0, Field<uint8_t>(item, 0xB9) != 0,
                Field<uint8_t>(item, 0xBC) != 0, whackPresented,
                Field<float>(item, 0x2C)});
        });
    }

    IterateArray(view.address, pvz::board::gridItems, pvz::dataArray::gridItemObjectSize,
                 pvz::dataArray::gridItemStride, 128,
                 [&](const std::array<uint8_t, 0x200>& item, uint32_t id) {
        const int type = Field<int>(item, 0x08);
        int column = Field<int>(item, 0x10);
        int row = Field<int>(item, 0x14);
        const float posX = Field<float>(item, 0x24);
        const float posY = Field<float>(item, 0x28);
        const int x = static_cast<int>(posX);
        if (mode == 23 && type == 6) {
            const int clickX = static_cast<int>(std::lround(posX + 15.0f));
            const int clickY = static_cast<int>(std::lround(posY + 15.0f));
            column = std::clamp((clickX - 40) / 80, 0, 8);
            row = std::clamp((clickY - 80) / 100, 0, 4);
        }
        if (!discloseBoardEntities || Field<uint8_t>(item, 0x20) || type <= 0 || type > 64 ||
            column < 0 || column >= 9 || row < 0 || row >= 6 ||
            !FogAllowsZombie(view.address, 0, view.background, x, row)) return;
        const uint32_t publicId = PublicObjectId(
            view.address, view.mainCounter, EntityKind::GridItem, id);
        view.gridItems.push_back({publicId, type, row, column, Field<int>(item, 0x44),
                                  Field<int>(item, 0x40), Field<int>(item, 0x3C),
                                  Field<int>(item, 0x4C), Field<int>(item, 0x50)});
    });

    IterateArray(view.address, pvz::board::coins, pvz::dataArray::coinObjectSize,
                 pvz::dataArray::coinStride, 1024,
                 [&](const std::array<uint8_t, 0x200>& item, uint32_t id) {
        const int type = Field<int>(item, 0x58);
        if (!Field<uint8_t>(item, 0x18) || Field<uint8_t>(item, 0x38) ||
            type <= 0 || type > 64) return;
        if (Field<uint8_t>(item, 0x50)) {
            if (type == 4) view.sunBeingCollected += 25;
            else if (type == 5) view.sunBeingCollected += 15;
            else if (type == 6) view.sunBeingCollected += 50;
            return;
        }
        if (!discloseBoardEntities) return;
        const int width = std::max(Field<int>(item, 0x10), 1);
        const int height = std::max(Field<int>(item, 0x14), 1);
        const int left = static_cast<int>(Field<float>(item, 0x24));
        const int top = static_cast<int>(Field<float>(item, 0x28));
        const int x = left + width / 2;
        const int y = top + height / 2;
        const int row = std::clamp((y - 80) / 85, 0, 5);
        if (x < 0 || x >= 800 || y < 0 || y >= 600 ||
            !FogAllowsZombie(view.address, 0, view.background, x, row)) return;
        const int hitExtra = type == 4 ? 15 : 0;
        const uint32_t publicId = PublicObjectId(
            view.address, view.mainCounter, EntityKind::Collectible, id);
        view.collectibles.push_back({publicId, id, type, Field<int>(item, 0x68), x, y,
                                     left - hitExtra, top - hitExtra,
                                     left + width + hitExtra, top + height + hitExtra});
    });

    IterateArray(view.address, pvz::board::mowers, pvz::dataArray::mowerObjectSize,
                 pvz::dataArray::mowerStride, 32,
                 [&](const std::array<uint8_t, 0x200>& item, uint32_t) {
        const int row = Field<int>(item, 0x14);
        const int type = Field<int>(item, 0x34);
        const int state = Field<int>(item, 0x2C);
        const int x = static_cast<int>(Field<float>(item, 0x08));
        if (MowerPublishable(discloseBoardEntities, state,
                             Field<uint8_t>(item, 0x30) != 0,
                             Field<uint8_t>(item, 0x31) != 0, row, type) &&
            FogAllowsZombie(view.address, 0, view.background, x, row)) {
            view.mowers.push_back({row, type, MowerTriggeredState(state)});
        }
    });

    return true;
}

constexpr int WhackPointRectDistanceSquared(int x, int y,
                                             int left, int top,
                                             int width, int height) {
    const int right = left + width;
    const int bottom = top + height;
    const int dx = x < left ? left - x : x > right ? x - right : 0;
    const int dy = y < top ? top - y : y > bottom ? y - bottom : 0;
    return dx * dx + dy * dy;
}

constexpr bool WhackCircleOverlapsRect(int clickX, int clickY,
                                        int left, int top,
                                        int width, int height) {
    return WhackPointRectDistanceSquared(
        clickX, clickY - 20, left, top, width, height) <=
        kWhackHitRadius * kWhackHitRadius;
}

static_assert(WhackCircleOverlapsRect(100, 120, 100, 100, 80, 115) &&
              WhackCircleOverlapsRect(55, 120, 100, 100, 80, 115) &&
              !WhackCircleOverlapsRect(54, 120, 100, 100, 80, 115));

constexpr bool WhackPointInsideCollectibleHitRect(int x, int y,
                                                   int left, int top,
                                                   int right, int bottom) {
    return x >= left && x < right && y >= top && y < bottom;
}

static_assert(WhackPointInsideCollectibleHitRect(100, 120, 100, 120, 140, 160) &&
              WhackPointInsideCollectibleHitRect(139, 159, 100, 120, 140, 160) &&
              !WhackPointInsideCollectibleHitRect(140, 159, 100, 120, 140, 160) &&
              !WhackPointInsideCollectibleHitRect(139, 160, 100, 120, 140, 160));

bool WhackPointCoveredByCollectible(const BoardView& board, int x, int y) {
    return std::any_of(board.collectibles.begin(), board.collectibles.end(),
        [&](const CollectibleView& collectible) {
            return WhackPointInsideCollectibleHitRect(
                x, y, collectible.hitLeft, collectible.hitTop,
                collectible.hitRight, collectible.hitBottom);
        });
}

const ZombieView* WhackTargetAt(const BoardView& board, int clickX, int clickY) {
    const ZombieView* top = nullptr;
    for (const auto& zombie : board.zombies) {
        if (!ZombiePhaseAcceptsWhack(zombie.phase) || !WhackCircleOverlapsRect(
                clickX, clickY, zombie.hitLeft, zombie.hitTop,
                zombie.hitWidth, zombie.hitHeight)) continue;
        if (!top || zombie.renderOrder >= top->renderOrder) top = &zombie;
    }
    return top;
}

enum class WhackTargetResolution { Found, Missing, Blocked };

WhackTargetResolution ResolveWhackTargetStatus(const BoardView& board,
                                                uint32_t publicId,
                                                ZombieView& target) {
    const auto found = std::find_if(board.zombies.begin(), board.zombies.end(),
        [&](const ZombieView& zombie) { return zombie.id == publicId; });
    if (found == board.zombies.end() || !ZombiePhaseAcceptsWhack(found->phase) ||
        !found->whackPresented ||
        !WhackPerceptibleRect(found->hitWidth, found->hitHeight)) {
        return WhackTargetResolution::Missing;
    }

    const int left = std::clamp(found->hitLeft, 0, pvz::kManagedClientWidth - 1);
    const int right = std::clamp(
        found->hitLeft + found->hitWidth, 0, pvz::kManagedClientWidth - 1);
    const int top = std::clamp(found->hitTop, -20, pvz::kManagedClientHeight - 21);
    const int bottom = std::clamp(
        found->hitTop + found->hitHeight, -20, pvz::kManagedClientHeight - 21);
    if (left > right || top > bottom) return WhackTargetResolution::Missing;

    const int centerX = std::clamp(found->hitLeft + found->hitWidth / 2, left, right);
    const int centerY = std::clamp(found->hitTop + found->hitHeight / 2, top, bottom);
    int bestX = 0;
    int bestY = 0;
    int bestClearance = INT_MIN;
    int bestCenterDistance = INT_MAX;
    bool collectibleBlocked = false;
    const auto consider = [&](int candidateX, int centerCandidateY) {
        const int clickY = centerCandidateY + 20;
        const ZombieView* resolved = WhackTargetAt(
            board, candidateX, clickY);
        if (!resolved || resolved->id != publicId) return;
        if (WhackPointCoveredByCollectible(board, candidateX, clickY)) {
            collectibleBlocked = true;
            return;
        }
        int clearance = INT_MAX;
        for (auto other = board.zombies.begin(); other != board.zombies.end(); ++other) {
            if (other->id == publicId || !ZombiePhaseAcceptsWhack(other->phase)) continue;
            const bool winsTie = other->renderOrder == found->renderOrder && other > found;
            if (other->renderOrder < found->renderOrder ||
                (other->renderOrder == found->renderOrder && !winsTie)) continue;
            clearance = std::min(clearance, WhackPointRectDistanceSquared(
                candidateX, centerCandidateY, other->hitLeft, other->hitTop,
                other->hitWidth, other->hitHeight) -
                kWhackHitRadius * kWhackHitRadius);
        }
        const int centerDistance =
            (candidateX - centerX) * (candidateX - centerX) +
            (centerCandidateY - centerY) * (centerCandidateY - centerY);
        if (clearance > bestClearance ||
            (clearance == bestClearance && centerDistance < bestCenterDistance)) {
            bestClearance = clearance;
            bestCenterDistance = centerDistance;
            bestX = candidateX;
            bestY = clickY;
        }
    };
    constexpr int kWhackSafePointGrid = 4;
    consider(centerX, centerY);
    for (int centerCandidateY = top; centerCandidateY <= bottom;
         centerCandidateY += kWhackSafePointGrid) {
        for (int candidateX = left; candidateX <= right;
             candidateX += kWhackSafePointGrid) {
            consider(candidateX, centerCandidateY);
        }
        consider(right, centerCandidateY);
    }
    for (int candidateX = left; candidateX <= right;
         candidateX += kWhackSafePointGrid) {
        consider(candidateX, bottom);
    }
    consider(right, bottom);
    if (bestClearance == INT_MIN) {
        return collectibleBlocked
            ? WhackTargetResolution::Blocked
            : WhackTargetResolution::Missing;
    }
    const int coarseX = bestX;
    const int coarseCenterY = bestY - 20;
    for (int centerCandidateY = std::max(top, coarseCenterY - kWhackSafePointGrid);
         centerCandidateY <= std::min(bottom, coarseCenterY + kWhackSafePointGrid);
         ++centerCandidateY) {
        for (int candidateX = std::max(left, coarseX - kWhackSafePointGrid);
             candidateX <= std::min(right, coarseX + kWhackSafePointGrid);
             ++candidateX) {
            consider(candidateX, centerCandidateY);
        }
    }
    target = *found;
    target.hitX = bestX;
    target.hitY = bestY;
    return WhackTargetResolution::Found;
}

bool ResolveWhackTarget(const BoardView& board, uint32_t publicId,
                        ZombieView& target) {
    return ResolveWhackTargetStatus(board, publicId, target) ==
           WhackTargetResolution::Found;
}

void CapturePresentedWhackTargets() {
    uintptr_t lawnApp = 0;
    int scene = -1;
    int mode = -1;
    BoardView board;
    const bool currentWhack = SafeRead(pvz::kGlobalLawnApp, lawnApp) && lawnApp &&
        SafeRead(lawnApp + pvz::app::gameScene, scene) && scene == 3 &&
        SafeRead(lawnApp + pvz::app::gameMode, mode) &&
        ReadBoard(lawnApp, mode, board, 0, false) &&
        IsWhackLevel(mode, board.level) && board.entitiesVisible && !board.paused;

    AcquireSRWLockExclusive(&g_whackPresentationLock);
    if (!currentWhack) {
        g_whackPresentation = {};
        ReleaseSRWLockExclusive(&g_whackPresentationLock);
        return;
    }
    const bool sameScope = g_whackPresentation.board == board.address &&
                           g_whackPresentation.mode == mode &&
                           g_whackPresentation.level == board.level;
    const bool advanced = sameScope && board.mainCounter > g_whackPresentation.mainCounter;
    std::unordered_map<uint32_t, uint8_t> next;
    for (const auto& zombie : board.zombies) {
        if (!WhackPerceptibleRect(zombie.hitWidth, zombie.hitHeight)) continue;
        uint8_t frames = 1;
        if (sameScope) {
            const auto previous = g_whackPresentation.visibleFrames.find(zombie.id);
            if (previous != g_whackPresentation.visibleFrames.end()) {
                frames = advanced
                    ? static_cast<uint8_t>(std::min<int>(previous->second + 1, 255))
                    : previous->second;
            }
        }
        next.emplace(zombie.id, frames);
    }
    g_whackPresentation.board = board.address;
    g_whackPresentation.mode = mode;
    g_whackPresentation.level = board.level;
    g_whackPresentation.mainCounter = board.mainCounter;
    g_whackPresentation.visibleFrames = std::move(next);
    ReleaseSRWLockExclusive(&g_whackPresentationLock);
}

constexpr bool ProfileNameShape(int length, int capacity) {
    return length > 0 && length <= pvz::player::nameMaximumLength && capacity >= length &&
           (capacity == pvz::player::nameInlineCapacity ||
            capacity == pvz::player::nameHeapCapacity);
}

constexpr bool ValidProfileUtf16(const wchar_t* units, size_t length) {
    if (!units || units[length] != L'\0') return false;
    for (size_t index = 0; index < length; ++index) {
        const uint16_t unit = static_cast<uint16_t>(units[index]);
        if (unit == 0 || unit < 0x20 || (unit >= 0x7F && unit <= 0x9F)) return false;
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (++index >= length) return false;
            const uint16_t low = static_cast<uint16_t>(units[index]);
            if (low < 0xDC00 || low > 0xDFFF) return false;
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            return false;
        }
    }
    return true;
}

constexpr std::array<wchar_t, 11> kProfileUtf16Ascii{
    L'C', L'o', L'r', L't', L'i', L'V', L'T', L'e', L's', L't', L'\0'};
constexpr std::array<wchar_t, 3> kProfileUtf16Pair{
    static_cast<wchar_t>(0xD83C), static_cast<wchar_t>(0xDF3B), L'\0'};
constexpr std::array<wchar_t, 2> kProfileUtf16HighOnly{
    static_cast<wchar_t>(0xD83C), L'\0'};
constexpr std::array<wchar_t, 2> kProfileUtf16LowOnly{
    static_cast<wchar_t>(0xDF3B), L'\0'};
constexpr std::array<wchar_t, 3> kProfileUtf16Control{L'A', L'\x001F', L'\0'};

static_assert(sizeof(wchar_t) == sizeof(uint16_t));
static_assert(ProfileNameShape(10, 15) && ProfileNameShape(7, 7) &&
              !ProfileNameShape(0, 7) && !ProfileNameShape(8, 7) &&
              !ProfileNameShape(13, 15) && !ProfileNameShape(10, 31));
static_assert(ValidProfileUtf16(kProfileUtf16Ascii.data(), 10) &&
              ValidProfileUtf16(kProfileUtf16Pair.data(), 2) &&
              !ValidProfileUtf16(kProfileUtf16HighOnly.data(), 1) &&
              !ValidProfileUtf16(kProfileUtf16LowOnly.data(), 1) &&
              !ValidProfileUtf16(kProfileUtf16Control.data(), 2));

bool ReadProfileName(uintptr_t player, std::string& name) {
    int length = -1;
    int capacity = -1;
    if (!SafeRead(player + pvz::player::nameLength, length) ||
        !SafeRead(player + pvz::player::nameCapacity, capacity) ||
        !ProfileNameShape(length, capacity)) return false;
    uintptr_t data = player + pvz::player::nameStorage;
    if (capacity > pvz::player::nameInlineCapacity &&
        (!SafeRead(player + pvz::player::nameStorage, data) || !data)) return false;
    if (data % alignof(wchar_t) != 0) return false;
    std::array<wchar_t, pvz::player::nameMaximumLength + 1> units{};
    const size_t unitCount = static_cast<size_t>(length) + 1;
    if (!SafeCopy(units.data(), data, unitCount * sizeof(wchar_t)) ||
        !ValidProfileUtf16(units.data(), static_cast<size_t>(length))) return false;
    const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, units.data(), length,
                                          nullptr, 0, nullptr, nullptr);
    if (bytes <= 0) return false;
    name.assign(static_cast<size_t>(bytes), '\0');
    return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, units.data(), length,
                               name.data(), bytes, nullptr, nullptr) == bytes;
}

void AppendProfile(std::string& output, uintptr_t lawnApp) {
    uintptr_t player = 0;
    if (!SafeRead(lawnApp + pvz::app::playerInfo, player) || !player) {
        output += "null";
        return;
    }
    int level = 0;
    int completions = 0;
    int coins = 0;
    int minigames = 0;
    int puzzles = 0;
    int survival = 0;
    std::string name;
    if (!ReadProfileName(player, name) ||
        !SafeRead(player + pvz::player::level, level) ||
        !SafeRead(player + pvz::player::coins, coins) ||
        !SafeRead(player + pvz::player::adventureCompletions, completions) ||
        !SafeRead(player + pvz::player::minigamesUnlocked, minigames) ||
        !SafeRead(player + pvz::player::puzzleUnlocked, puzzles) ||
        !SafeRead(player + pvz::player::survivalUnlocked, survival)) {
        output += "null";
        return;
    }
    output += "{\"name\":";
    AppendString(output, name);
    output += ",\"adventureLevel\":";
    AppendInt(output, std::max(level, 0));
    output += ",\"adventureCompletions\":";
    AppendInt(output, std::max(completions, 0));
    output += ",\"coins\":";
    AppendInt(output, static_cast<int64_t>(std::max(coins, 0)) * 10LL);
    output += ",\"minigamesUnlocked\":";
    AppendBool(output, minigames != 0);
    output += ",\"puzzleUnlocked\":";
    AppendBool(output, puzzles != 0);
    output += ",\"survivalUnlocked\":";
    AppendBool(output, survival != 0);
    output += '}';
}

struct ProfileState {
    uintptr_t manager = 0;
    uintptr_t activePlayer = 0;
    uint32_t activeId = 0;
    int userCount = 0;
};

bool ReadProfileState(uintptr_t lawnApp, ProfileState& state) {
    state = {};
    if (!SafeRead(lawnApp + pvz::app::profileManager, state.manager) || !state.manager ||
        !SafeRead(state.manager + pvz::profileManager::userCount, state.userCount) ||
        state.userCount < 0 || state.userCount > 200 ||
        !SafeRead(lawnApp + pvz::app::playerInfo, state.activePlayer)) return false;
    return !state.activePlayer ||
           SafeRead(state.activePlayer + pvz::player::id, state.activeId);
}

void AppendMenuItem(std::string& output, bool& first, const char* id, const char* label,
                    bool enabled, int x, int y, const std::string& state, int record) {
    if (!first) output.push_back(',');
    first = false;
    output += "{\"id\":";
    AppendString(output, id);
    output += ",\"label\":";
    AppendString(output, label);
    output += ",\"enabled\":";
    AppendBool(output, enabled);
    output += ",\"x\":";
    AppendInt(output, x);
    output += ",\"y\":";
    AppendInt(output, y);
    output += ",\"state\":";
    if (state.empty()) output += "null"; else AppendString(output, state);
    output += ",\"record\":";
    if (record < 0) output += "null"; else AppendInt(output, record);
    output.push_back('}');
}

struct MenuControl {
    std::string id;
    std::string label;
    bool enabled;
    int x;
    int y;
    std::string state;
    int record = -1;
};

constexpr bool TitleContinueOffered(bool loadingScreen, bool titlePresent, int ready) {
    return loadingScreen && titlePresent && ready == 1;
}

static_assert(TitleContinueOffered(true, true, 1) &&
              !TitleContinueOffered(false, true, 1) &&
              !TitleContinueOffered(true, false, 1) &&
              !TitleContinueOffered(true, true, 0) &&
              !TitleContinueOffered(true, true, 2));

bool ReadTitleContinueReady(uintptr_t lawnApp, uintptr_t& title) {
    title = 0;
    uint8_t ready = 0;
    return SafeRead(lawnApp + pvz::app::titleScreen, title) && title &&
           SafeRead(title + pvz::title::loadingThreadComplete, ready) &&
           TitleContinueOffered(true, true, ready);
}

bool ModeShowsNumericRecord(int mode) {
    return (mode >= 11 && mode <= 15) || mode == 60 || mode == 70;
}

bool ModeCompleted(int mode, int record) {
    if (mode >= 1 && mode <= 5) return record >= 5;
    if (mode >= 6 && mode <= 10) return record >= 10;
    if (ModeShowsNumericRecord(mode)) return false;
    return record > 0;
}

constexpr size_t ChallengeButtonOffset(int mode) {
    return 0xB8 + static_cast<size_t>(mode - 1) * sizeof(uintptr_t);
}

static_assert(ChallengeButtonOffset(1) == 0xB8, "mode 1 must use challengeButtons[0]");
static_assert(ChallengeButtonOffset(70) == 0x1CC, "mode 70 must use challengeButtons[69]");

struct DialogView {
    uintptr_t address = 0;
    uintptr_t vtable = 0;
    int id = -1;
    uintptr_t primary = 0;
    uintptr_t secondary = 0;
};

struct SemanticBoardGate {
    uintptr_t address = 0;
    uintptr_t chooser = 0;
    int level = 0;
    int mainCounter = 0;
    int tutorialState = 0;
    bool gameplay = false;
    bool seedPicker = false;
    bool shovelTutorial = false;
};

bool StableAppBoardTuple(uintptr_t lawnApp, int scene, int mode,
                         uintptr_t board, int level, int mainCounter) {
    int currentScene = -1;
    int currentMode = -1;
    int currentLevel = 0;
    int currentCounter = 0;
    uintptr_t currentBoard = 0;
    return SafeRead(lawnApp + pvz::app::gameScene, currentScene) &&
           SafeRead(lawnApp + pvz::app::gameMode, currentMode) &&
           SafeRead(lawnApp + pvz::app::board, currentBoard) &&
           SafeRead(board + pvz::board::level, currentLevel) &&
           SafeRead(board + pvz::board::mainCounter, currentCounter) &&
           currentScene == scene && currentMode == mode && currentBoard == board &&
           currentLevel == level && currentCounter == mainCounter;
}

SemanticBoardGate ReadSemanticBoardGate(uintptr_t lawnApp, int scene, int mode,
                                        uintptr_t rawBoard) {
    SemanticBoardGate gate;
    if (!rawBoard ||
        !SafeRead(rawBoard + pvz::board::level, gate.level) ||
        !SafeRead(rawBoard + pvz::board::mainCounter, gate.mainCounter)) return gate;
    const bool validIdentity = ValidRunIdentity(mode, gate.level);
    if (scene == 3) {
        const bool stable = StableAppBoardTuple(
            lawnApp, scene, mode, rawBoard, gate.level, gate.mainCounter);
        if (PublicBoardGate(scene, validIdentity, true, stable)) {
            gate.address = rawBoard;
            gate.gameplay = true;
        }
        return gate;
    }
    if (scene != 2 || !validIdentity) return gate;

    uintptr_t cutScene = 0;
    uintptr_t cutSceneBoard = 0;
    uintptr_t chooser = 0;
    uintptr_t chooserBoard = 0;
    uint8_t seedChoosing = 0;
    uint8_t mouseVisible = 0;
    const bool cutScenePresent =
        SafeRead(rawBoard + pvz::board::cutScene, cutScene) && cutScene;
    const bool cutSceneBoardMatches = cutScenePresent &&
        SafeRead(cutScene + pvz::cutScene::board, cutSceneBoard) &&
        cutSceneBoard == rawBoard;
    int tutorialState = 0;
    uintptr_t stableTutorialCutScene = 0;
    uintptr_t stableTutorialBoard = 0;
    int stableTutorialState = 0;
    const bool tutorialStateReady =
        SafeRead(rawBoard + pvz::board::tutorialState, tutorialState);
    const bool stableTutorial = tutorialStateReady &&
        cutScenePresent && cutSceneBoardMatches &&
        StableAppBoardTuple(
            lawnApp, scene, mode, rawBoard, gate.level, gate.mainCounter) &&
        SafeRead(rawBoard + pvz::board::cutScene, stableTutorialCutScene) &&
        stableTutorialCutScene == cutScene &&
        SafeRead(stableTutorialCutScene + pvz::cutScene::board,
                 stableTutorialBoard) &&
        stableTutorialBoard == rawBoard &&
        SafeRead(rawBoard + pvz::board::tutorialState, stableTutorialState) &&
        stableTutorialState == tutorialState;
    if (PublicShovelTutorialGate(
            scene, mode, gate.level, tutorialState, true,
            cutScenePresent, cutSceneBoardMatches, stableTutorial)) {
        gate.address = rawBoard;
        gate.tutorialState = tutorialState;
        gate.shovelTutorial = true;
        return gate;
    }
    const bool seedChoosingReady = cutScenePresent &&
        SafeRead(cutScene + pvz::cutScene::seedChoosing, seedChoosing) &&
        seedChoosing == 1;
    const bool chooserPresent =
        SafeRead(lawnApp + pvz::app::seedChooser, chooser) && chooser;
    const bool chooserBoardMatches = chooserPresent &&
        SafeRead(chooser + pvz::chooser::board, chooserBoard) &&
        chooserBoard == rawBoard;
    const bool chooserVisible = chooserPresent &&
        SafeRead(chooser + pvz::widget::mouseVisible, mouseVisible) &&
        mouseVisible == 1;
    uintptr_t stableCutScene = 0;
    uintptr_t stableCutSceneBoard = 0;
    uintptr_t stableChooser = 0;
    uintptr_t stableChooserBoard = 0;
    uint8_t stableSeedChoosing = 0;
    uint8_t stableMouseVisible = 0;
    const bool stable = StableAppBoardTuple(
        lawnApp, scene, mode, rawBoard, gate.level, gate.mainCounter) &&
        SafeRead(rawBoard + pvz::board::cutScene, stableCutScene) &&
        stableCutScene == cutScene &&
        SafeRead(stableCutScene + pvz::cutScene::board, stableCutSceneBoard) &&
        stableCutSceneBoard == rawBoard &&
        SafeRead(stableCutScene + pvz::cutScene::seedChoosing,
                 stableSeedChoosing) && stableSeedChoosing == 1 &&
        SafeRead(lawnApp + pvz::app::seedChooser, stableChooser) &&
        stableChooser == chooser &&
        SafeRead(stableChooser + pvz::chooser::board, stableChooserBoard) &&
        stableChooserBoard == rawBoard &&
        SafeRead(stableChooser + pvz::widget::mouseVisible,
                 stableMouseVisible) && stableMouseVisible == 1;
    if (PublicSeedPickerGate(scene, validIdentity, true, cutScenePresent,
                             cutSceneBoardMatches, seedChoosingReady,
                             chooserPresent, chooserBoardMatches,
                             chooserVisible, stable)) {
        gate.address = rawBoard;
        gate.chooser = chooser;
        gate.seedPicker = true;
    }
    return gate;
}

const char* DetermineScreen(uintptr_t lawnApp, int scene,
                            const SemanticBoardGate& gate);
const char* DetermineScreen(uintptr_t lawnApp, int scene, uintptr_t board);

bool WidgetControl(uintptr_t owner, size_t pointerOffset, const char* id, const char* label,
                   MenuControl& control, bool requireDraw = true) {
    uintptr_t button = 0;
    uint8_t visible = 0;
    uint8_t mouseVisible = 0;
    uint8_t disabled = 1;
    uint8_t noDraw = 1;
    int ownerX = 0;
    int ownerY = 0;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    if (!SafeRead(owner + pointerOffset, button) || !button ||
        !SafeRead(button + 0x64, visible) || !SafeRead(button + 0x65, mouseVisible) ||
        !SafeRead(button + 0x66, disabled) ||
        !SafeRead(button + 0x119, noDraw) ||
        !SafeRead(button + pvz::widget::x, x) || !SafeRead(button + pvz::widget::y, y) ||
        !SafeRead(button + pvz::widget::width, width) || !SafeRead(button + pvz::widget::height, height) ||
        width <= 0 || height <= 0 || width > 800 || height > 600) return false;
    SafeRead(owner + pvz::widget::x, ownerX);
    SafeRead(owner + pvz::widget::y, ownerY);
    const bool drawn = !requireDraw || noDraw == 0;
    control = {id, label, visible != 0 && mouseVisible != 0 && disabled == 0 && drawn,
               ownerX + x + width / 2, ownerY + y + height / 2};
    return visible != 0 && mouseVisible != 0 && drawn;
}

bool GameButtonControl(uintptr_t owner, size_t pointerOffset, const char* id, const char* label,
                       MenuControl& control) {
    uintptr_t button = 0;
    uint8_t disabled = 1;
    uint8_t noDraw = 1;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    if (!SafeRead(owner + pointerOffset, button) || !button ||
        !SafeRead(button + pvz::widget::disabled, disabled) ||
        !SafeRead(button + pvz::widget::noDraw, noDraw) ||
        !SafeRead(button + pvz::widget::gameButtonX, x) ||
        !SafeRead(button + pvz::widget::gameButtonY, y) ||
        !SafeRead(button + pvz::widget::gameButtonWidth, width) ||
        !SafeRead(button + pvz::widget::gameButtonHeight, height) ||
        width <= 0 || height <= 0 || width > 800 || height > 600) return false;
    control = {id, label, !disabled && !noDraw, x + width / 2, y + height / 2};
    return !noDraw;
}

bool ActiveDialog(uintptr_t lawnApp, DialogView& dialog) {
    uintptr_t manager = 0;
    uintptr_t widget = 0;
    if (!SafeRead(lawnApp + pvz::app::widgetManager, manager) || !manager) return false;
    const bool modal = SafeRead(manager + 0xAC, widget) && widget;
    if (!modal) SafeRead(manager + 0xA0, widget);
    uintptr_t vtable = 0;
    int id = -1;
    uintptr_t primary = 0;
    if (!widget || !SafeRead(widget, vtable) || !SafeRead(widget + 0x154, id) ||
        !SafeRead(widget + 0x178, primary)) return false;
    const bool lawnDialog = vtable == 0x00711148 || vtable == 0x00711398 ||
                            vtable == 0x00711A88;
    const bool specialDialog = (id == 3 && vtable == 0x007067D8) ||
                               (id == 4 && vtable == 0x0071A290) ||
                               (id == 29 && vtable == 0x0071B840) ||
                               pvz::pauseDialog::Matches(id, vtable) ||
                               ((id == 30 || id == 32) && vtable == 0x00711C38) ||
                               (id == 49 && vtable == 0x007198C0);
    if ((!lawnDialog && !specialDialog) || (!primary && lawnDialog) || id < 0 || id > 57) {
        return false;
    }
    dialog.address = widget;
    dialog.vtable = vtable;
    dialog.id = id;
    dialog.primary = primary;
    SafeRead(widget + (id == 17 ? 0x184 : 0x17C), dialog.secondary);
    return true;
}

bool DaveReady(uintptr_t lawnApp, int& messageId, int* messageLength = nullptr) {
    int length = 0;
    const bool ready = SafeRead(lawnApp + 0x970, messageId) &&
                       SafeRead(lawnApp + 0x988, length) &&
                       messageId > 0 && length > 0 && length <= 4096;
    if (ready && messageLength) *messageLength = length;
    return ready;
}

bool CurrentSeedPickerGate(uintptr_t lawnApp, SemanticBoardGate& gate) {
    int scene = -1;
    int mode = -1;
    uintptr_t rawBoard = 0;
    if (!SafeRead(lawnApp + pvz::app::gameScene, scene) ||
        !SafeRead(lawnApp + pvz::app::gameMode, mode) ||
        !SafeRead(lawnApp + pvz::app::board, rawBoard)) return false;
    gate = ReadSemanticBoardGate(lawnApp, scene, mode, rawBoard);
    return gate.seedPicker &&
           std::strcmp(DetermineScreen(lawnApp, scene, gate), "seed_picker") == 0;
}

const char* PrimaryDialogAction(int id) {
    if (id == 17 || id == 23 || id == 39) return "restart";
    if (id == 19) return "resume";
    if (id == 22) return "main_menu";
    if (id == 37 || id == 38 || id == 42 || id == 48) return "advance";
    return "confirm";
}

const char* SecondaryDialogAction(int id) {
    return id == 17 ? "main_menu" : "cancel";
}

bool DialogButtonControl(const DialogView& dialog, uintptr_t button, const char* id,
                         const char* label, MenuControl& control) {
    uint8_t visible = 0;
    uint8_t mouseVisible = 0;
    uint8_t disabled = 1;
    uint8_t noDraw = 1;
    int dialogX = 0;
    int dialogY = 0;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    return button && SafeRead(button + 0x64, visible) && SafeRead(button + 0x65, mouseVisible) &&
        SafeRead(button + 0x66, disabled) && SafeRead(button + 0x119, noDraw) &&
        SafeRead(dialog.address + pvz::widget::x, dialogX) &&
        SafeRead(dialog.address + pvz::widget::y, dialogY) &&
        SafeRead(button + pvz::widget::x, x) && SafeRead(button + pvz::widget::y, y) &&
        SafeRead(button + pvz::widget::width, width) && SafeRead(button + pvz::widget::height, height) &&
        width > 0 && height > 0 &&
        (control = {id, label, visible != 0 && mouseVisible != 0 && disabled == 0 && noDraw == 0,
                    dialogX + x + width / 2, dialogY + y + height / 2},
         visible != 0 && mouseVisible != 0 && noDraw == 0);
}

bool DialogEditControl(const DialogView& dialog, uintptr_t& edit, int& centerX, int& centerY) {
    uint8_t visible = 0;
    uint8_t mouseVisible = 0;
    uint8_t disabled = 1;
    int dialogX = 0;
    int dialogY = 0;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    if (!SafeRead(dialog.address + 0x18C, edit) || !edit ||
        !SafeRead(edit + 0x64, visible) || !SafeRead(edit + 0x65, mouseVisible) ||
        !SafeRead(edit + 0x66, disabled) ||
        !SafeRead(dialog.address + pvz::widget::x, dialogX) ||
        !SafeRead(dialog.address + pvz::widget::y, dialogY) ||
        !SafeRead(edit + pvz::widget::x, x) || !SafeRead(edit + pvz::widget::y, y) ||
        !SafeRead(edit + pvz::widget::width, width) || !SafeRead(edit + pvz::widget::height, height) ||
        !visible || !mouseVisible || disabled || width <= 0 || height <= 0 || width > 600 || height > 100) {
        return false;
    }
    centerX = dialogX + x + width / 2;
    centerY = dialogY + y + height / 2;
    return true;
}

bool ReadEditText(uintptr_t edit, std::wstring& text) {
    const uintptr_t value = edit + pvz::editWidget::text;
    int length = -1;
    int capacity = -1;
    if (!SafeRead(value + pvz::player::nameLength, length) ||
        !SafeRead(value + pvz::player::nameCapacity, capacity) ||
        !ProfileNameShape(length, capacity)) return false;
    uintptr_t data = value + pvz::player::nameStorage;
    if (capacity > pvz::player::nameInlineCapacity &&
        (!SafeRead(value + pvz::player::nameStorage, data) || !data)) return false;
    std::array<wchar_t, pvz::player::nameMaximumLength + 1> units{};
    if (!SafeCopy(units.data(), data, (static_cast<size_t>(length) + 1) * sizeof(wchar_t)) ||
        !ValidProfileUtf16(units.data(), static_cast<size_t>(length))) return false;
    text.assign(units.data(), static_cast<size_t>(length));
    return true;
}

struct UserDialogList {
    uintptr_t address = 0;
    int numUsers = 0;
    int selected = -1;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    double position = 0;
    bool visible = false;
    bool enabled = false;
    std::vector<std::string> names;
};

bool ReadUserDialogList(uintptr_t lawnApp, const DialogView& dialog, UserDialogList& view) {
    uintptr_t list = 0;
    uintptr_t listVtable = 0;
    uintptr_t dialogManager = 0;
    uintptr_t listManager = 0;
    uintptr_t parent = 0;
    uintptr_t linesBegin = 0;
    uintptr_t linesEnd = 0;
    uint8_t visible = 0;
    uint8_t mouseVisible = 0;
    uint8_t disabled = 1;
    int dialogX = 0;
    int dialogY = 0;
    int listX = 0;
    int listY = 0;
    int width = 0;
    int height = 0;
    int numUsers = -1;
    int itemHeight = -1;
    int selected = -1;
    double position = -1.0;
    ProfileState profile;
    if (dialog.id != pvz::userDialog::dialogId ||
        dialog.vtable != pvz::userDialog::vtable ||
        !ReadProfileState(lawnApp, profile) ||
        !SafeRead(dialog.address + pvz::userDialog::userList, list) || !list ||
        !SafeRead(list, listVtable) || listVtable != pvz::userDialog::listVtable ||
        !SafeRead(dialog.address + pvz::userDialog::listManager, dialogManager) ||
        !SafeRead(list + pvz::userDialog::listManager, listManager) ||
        !dialogManager || listManager != dialogManager ||
        !SafeRead(list + pvz::userDialog::listParent, parent) || parent != dialog.address ||
        !SafeRead(dialog.address + pvz::userDialog::numUsers, numUsers) ||
        numUsers < 0 || numUsers > pvz::userDialog::maxUsers ||
        numUsers != profile.userCount ||
        !SafeRead(list + pvz::userDialog::listLinesBegin, linesBegin) ||
        !SafeRead(list + pvz::userDialog::listLinesEnd, linesEnd) ||
        !linesBegin || linesEnd < linesBegin ||
        linesEnd - linesBegin !=
            static_cast<uintptr_t>(numUsers + (numUsers < pvz::userDialog::maxUsers ? 1 : 0)) *
                pvz::userDialog::listLineStride ||
        !SafeRead(list + pvz::userDialog::listSelectedIndex, selected) ||
        selected < -1 || selected > numUsers ||
        (numUsers == pvz::userDialog::maxUsers && selected == numUsers) ||
        !SafeRead(list + pvz::userDialog::listPosition, position) ||
        !std::isfinite(position) || position < 0.0 || position > numUsers ||
        !SafeRead(list + pvz::userDialog::listItemHeight, itemHeight) ||
        itemHeight != pvz::userDialog::itemHeight ||
        !SafeRead(list + pvz::userDialog::listVisible, visible) ||
        !SafeRead(list + pvz::userDialog::listMouseVisible, mouseVisible) ||
        !SafeRead(list + pvz::userDialog::listDisabled, disabled) ||
        !SafeRead(dialog.address + pvz::widget::x, dialogX) ||
        !SafeRead(dialog.address + pvz::widget::y, dialogY) ||
        !SafeRead(list + pvz::widget::x, listX) ||
        !SafeRead(list + pvz::widget::y, listY) ||
        !SafeRead(list + pvz::widget::width, width) ||
        !SafeRead(list + pvz::widget::height, height) ||
        width <= 0 || height <= 0 || width > 600 || height > 400) {
        return false;
    }
    view = {};
    for (int index = 0; index < numUsers; ++index) {
        std::string name;
        if (!ReadProfileName(linesBegin + static_cast<uintptr_t>(index) *
                            pvz::userDialog::listLineStride, name)) return false;
        view.names.push_back(std::move(name));
    }
    view.address = list;
    view.numUsers = numUsers;
    view.selected = selected;
    view.x = dialogX + listX;
    view.y = dialogY + listY;
    view.width = width;
    view.height = height;
    view.position = position;
    view.visible = visible != 0 && mouseVisible != 0;
    view.enabled = view.visible && disabled == 0;
    return true;
}

bool UserDialogRowControl(const UserDialogList& view, int index, MenuControl& control) {
    if (index < 0 || index > view.numUsers ||
        (index == view.numUsers && view.numUsers == pvz::userDialog::maxUsers)) return false;
    const double rowCenter = pvz::userDialog::listInset +
        (index - view.position + 0.5) * pvz::userDialog::itemHeight;
    const int localY = static_cast<int>(std::lround(rowCenter));
    const int hitIndex = static_cast<int>(std::floor(
        static_cast<double>(localY - pvz::userDialog::listInset) /
            pvz::userDialog::itemHeight + view.position));
    if (localY < pvz::userDialog::listInset ||
        localY >= view.height - pvz::userDialog::listInset || hitIndex != index) {
        return false;
    }
    const bool create = index == view.numUsers;
    control = {
        create ? "profile_create" : "profile:" + view.names[index],
        create ? "Create profile" : view.names[index],
        view.enabled,
        view.x + view.width / 2,
        view.y + localY,
        !create && index == view.selected ? "selected" : "",
    };
    return view.visible;
}

bool UserDialogCreateControl(uintptr_t lawnApp, const DialogView& dialog, MenuControl& control) {
    UserDialogList view;
    return ReadUserDialogList(lawnApp, dialog, view) &&
           UserDialogRowControl(view, view.numUsers, control);
}

std::vector<MenuControl> CollectMenuControls(const char* screen, uintptr_t lawnApp,
                                             uintptr_t board) {
    std::vector<MenuControl> controls;
    DialogView dialog;
    if (ActiveDialog(lawnApp, dialog)) {
        if (dialog.id == pvz::userDialog::dialogId) {
            MenuControl control;
            UserDialogList view;
            if (ReadUserDialogList(lawnApp, dialog, view)) {
                for (int index = 0; index <= view.numUsers; ++index) {
                    if (UserDialogRowControl(view, index, control)) controls.push_back(control);
                }
                if (view.enabled && view.selected >= 0 && view.selected < view.numUsers &&
                    UserDialogRowControl(view, view.selected, control) &&
                    DialogButtonControl(dialog, dialog.primary, "confirm", "Confirm profile", control)) {
                    controls.push_back(control);
                }
            }
            if (DialogButtonControl(dialog, dialog.secondary, "cancel", "cancel", control)) {
                controls.push_back(control);
            }
            return controls;
        }
        if (dialog.id == pvz::userDialog::createDialogId) {
            uintptr_t edit = 0;
            int editX = 0;
            int editY = 0;
            MenuControl control;
            if (DialogEditControl(dialog, edit, editX, editY) &&
                DialogButtonControl(dialog, dialog.primary, "profile_create", "Create profile",
                                    control)) {
                controls.push_back(control);
            }
            if (DialogButtonControl(dialog, dialog.secondary, "cancel", "Cancel", control)) {
                controls.push_back(control);
            }
            return controls;
        }
        if (dialog.id == 3) {
            MenuControl control;
            if (GameButtonControl(dialog.address, 0x18C, "advance", "Close Almanac", control)) {
                controls.push_back(control);
            }
            return controls;
        }
        if (dialog.id == 4) {
            uint8_t bubble = 0;
            int storeTime = 0;
            int hatchTimer = 0;
            uint8_t waitForDialog = 1;
            SafeRead(dialog.address + 0x1A0, bubble);
            SafeRead(dialog.address + 0x17C, storeTime);
            SafeRead(dialog.address + 0x1B4, hatchTimer);
            SafeRead(dialog.address + 0x1C9, waitForDialog);
            if (bubble) {
                controls.push_back({"advance", "Continue Dave dialogue", true, 400, 300});
                return controls;
            }
            if (storeTime >= 120 && hatchTimer <= 0 && !waitForDialog) {
                MenuControl control;
                if (WidgetControl(dialog.address, 0x16C, "advance", "Leave store", control)) {
                    controls.push_back(control);
                }
                if (WidgetControl(dialog.address, 0x170, "page_previous", "Previous store page", control)) {
                    controls.push_back(control);
                }
                if (WidgetControl(dialog.address, 0x174, "page_next", "Next store page", control)) {
                    controls.push_back(control);
                }
                int page = -1;
                uintptr_t player = 0;
                int coins = 0;
                int fertilizer = 0;
                int dialogX = 0;
                int dialogY = 0;
                if (SafeRead(dialog.address + 0x1AC, page) && page == 2 &&
                    SafeRead(lawnApp + pvz::app::playerInfo, player) && player &&
                    SafeRead(player + pvz::player::coins, coins) &&
                    SafeRead(player + pvz::player::purchases + 14U * sizeof(int), fertilizer) &&
                    SafeRead(dialog.address + pvz::widget::x, dialogX) &&
                    SafeRead(dialog.address + pvz::widget::y, dialogY) &&
                    coins >= 0 && coins <= 99999 && fertilizer >= 0 && fertilizer <= 2000) {
                    const int uses = fertilizer >= 1000 ? fertilizer - 1000 : 0;
                    const bool soldOut = uses > 15;
                    const bool affordable = coins >= 75;
                    const std::string state = soldOut ? "sold_out" :
                                              affordable ? "available" : "unaffordable";
                    controls.push_back({
                        "store_buy_fertilizer",
                        "Fertilizer (" + std::to_string(uses) + " uses)",
                        !soldOut && affordable,
                        dialogX + 397,
                        dialogY + 353,
                        state,
                        750});
                }
            }
            return controls;
        }
        if (pvz::pauseDialog::Matches(dialog.id, dialog.vtable)) {
            MenuControl control;
            if (WidgetControl(dialog.address, pvz::pauseDialog::resumeButton,
                              "resume", "Resume", control)) {
                controls.push_back(control);
            }
            if (WidgetControl(dialog.address, pvz::pauseDialog::restartButton,
                              "restart", "Restart", control)) {
                controls.push_back(control);
            }
            if (WidgetControl(dialog.address, pvz::pauseDialog::mainMenuButton,
                              "main_menu", "Main menu", control)) {
                controls.push_back(control);
            }
            return controls;
        }
        if (dialog.id == 2) {
            MenuControl control;
            if (WidgetControl(dialog.address, 0x190, board ? "resume" : "advance",
                              board ? "Resume" : "OK", control)) controls.push_back(control);
            if (board && WidgetControl(dialog.address, 0x18C, "restart", "Restart", control)) {
                controls.push_back(control);
            }
            if (board && WidgetControl(dialog.address, 0x188, "main_menu", "Main menu", control)) {
                controls.push_back(control);
            }
            return controls;
        }
        MenuControl control;
        const char* primary = PrimaryDialogAction(dialog.id);
        if (DialogButtonControl(dialog, dialog.primary, primary, primary, control)) controls.push_back(control);
        const char* secondary = SecondaryDialogAction(dialog.id);
        if (DialogButtonControl(dialog, dialog.secondary, secondary, secondary, control)) controls.push_back(control);
        return controls;
    }
    int daveMessage = -1;
    if (DaveReady(lawnApp, daveMessage)) {
        controls.push_back({"advance", "Continue Dave dialogue", true, 400, 300});
        return controls;
    }
    auto appendUnique = [&](MenuControl&& control) {
        const auto existing = std::find_if(controls.begin(), controls.end(),
            [&](const MenuControl& value) { return value.id == control.id; });
        if (existing == controls.end()) {
            controls.push_back(std::move(control));
        } else if (!existing->enabled && control.enabled) {
            *existing = std::move(control);
        }
    };
    auto widget = [&](uintptr_t owner, size_t offset, const char* id, const char* label) {
        MenuControl control;
        if (WidgetControl(owner, offset, id, label, control)) appendUnique(std::move(control));
    };
    auto gameButton = [&](uintptr_t owner, size_t offset, const char* id, const char* label) {
        MenuControl control;
        if (GameButtonControl(owner, offset, id, label, control)) appendUnique(std::move(control));
    };
    if (std::strcmp(screen, "main_menu") == 0) {
        uintptr_t selector = 0;
        if (SafeRead(lawnApp + pvz::app::gameSelector, selector) && selector) {
            int selectorState = -1;
            SafeRead(selector + 0x140, selectorState);
            if (selectorState == 3) {
                widget(selector, 0xA8, "adventure", "Adventure");
                widget(selector, 0xAC, "minigame", "Mini-games");
                widget(selector, 0xB0, "puzzle", "Puzzle");
                widget(selector, 0xB4, "options", "Options");
                widget(selector, 0xBC, "help", "Help");
                widget(selector, 0xCC, "store", "Store");
                widget(selector, 0xD0, "almanac", "Almanac");
                widget(selector, 0xD4, "zen_garden", "Zen Garden");
                widget(selector, 0xD8, "survival", "Survival");
                MenuControl changeUser;
                if (WidgetControl(selector, 0xDC, "change_user", "Change user", changeUser,
                                  false)) controls.push_back(std::move(changeUser));
                auto applyModeLock = [&](const char* id, size_t offset) {
                    const auto control = std::find_if(
                        controls.begin(), controls.end(),
                        [&](const MenuControl& value) { return value.id == id; });
                    if (control == controls.end()) return;
                    uint8_t locked = 0;
                    if (!SafeRead(selector + offset, locked) || locked > 1) {
                        controls.erase(control);
                        return;
                    }
                    if (locked) {
                        control->enabled = false;
                        control->state = "locked";
                    } else if (!control->enabled) {
                        controls.erase(control);
                    }
                };
                applyModeLock("minigame", pvz::gameSelector::minigamesLocked);
                applyModeLock("puzzle", pvz::gameSelector::puzzleLocked);
                applyModeLock("survival", pvz::gameSelector::survivalLocked);
            }
        }
    } else if (std::strcmp(screen, "seed_picker") == 0) {
        uintptr_t chooser = 0;
        if (SafeRead(lawnApp + pvz::app::seedChooser, chooser) && chooser) {
            gameButton(chooser, 0xA0, "ready", "Ready");
            gameButton(chooser, 0xB4, "main_menu", "Main menu");
        }
    } else if (std::strcmp(screen, "mode_selector") == 0) {
        uintptr_t selector = 0;
        if (SafeRead(lawnApp + pvz::app::challengeScreen, selector) && selector) {
            widget(selector, 0xA4, "back", "Back");
            for (int page = 0; page < 4; ++page) {
                const std::string id = "page_" + std::to_string(page);
                widget(selector, 0xA8 + page * sizeof(uintptr_t), id.c_str(), id.c_str());
            }
            for (int mode = 1; mode <= 70; ++mode) {
                const std::string id = "mode_" + std::to_string(mode);
                const std::string label = ModeName(mode);
                MenuControl control;
                if (!WidgetControl(selector, ChallengeButtonOffset(mode), id.c_str(), label.c_str(),
                                   control)) continue;
                int record = 0;
                uintptr_t player = 0;
                if (!SafeRead(lawnApp + pvz::app::playerInfo, player) || !player ||
                    !SafeRead(player + 0x58 + static_cast<uintptr_t>(mode - 1) * sizeof(int), record) ||
                    record < 0) record = 0;
                if (!control.enabled) {
                    control.label = "locked";
                    control.state = "locked";
                } else {
                    control.state = ModeCompleted(mode, record) ? "completed" : "available";
                    if (ModeShowsNumericRecord(mode) && record > 0) control.record = record;
                }
                controls.push_back(std::move(control));
            }
        }
    } else if (std::strcmp(screen, "award") == 0) {
        uintptr_t award = 0;
        if (SafeRead(lawnApp + pvz::app::awardScreen, award) && award) {
            gameButton(award, 0xA8, "advance", "Continue");
            gameButton(award, 0xA0, "advance", "Continue");
            gameButton(award, 0xA4, "main_menu", "Main menu");
        }
    } else if (std::strcmp(screen, "credits") == 0) {
        uintptr_t credits = 0;
        if (SafeRead(lawnApp + pvz::app::creditScreen, credits) && credits) {
            gameButton(credits, 0xA4, "main_menu", "Close");
            widget(credits, 0xC0, "main_menu", "Main menu");
            widget(credits, 0xC4, "replay", "Replay");
        }
    } else if (std::strcmp(screen, "board") == 0 && board) {
        int mode = 0;
        int tutorialState = 0;
        SafeRead(lawnApp + pvz::app::gameMode, mode);
        SafeRead(board + pvz::board::tutorialState, tutorialState);
        if (mode == 43 && tutorialState == 25) {
            gameButton(board, pvz::board::storeButton, "store", "Visit store");
        } else if (mode == 43 && tutorialState == 27) {
            gameButton(board, pvz::board::menuButton, "advance", "Continue adventure");
        } else {
            gameButton(board, pvz::board::menuButton, "pause", "Pause");
        }
    } else if (std::strcmp(screen, "loading") == 0) {
        uintptr_t title = 0;
        if (ReadTitleContinueReady(lawnApp, title)) {
            controls.push_back({"title_continue", "Continue past title screen",
                                true, 400, 300});
        }
    }
    return controls;
}

void AppendContextValue(std::string& signature, uint64_t value) {
    signature.push_back('|');
    signature += std::to_string(value);
}

std::string BuildMenuSignature(const char* screen, uintptr_t lawnApp, uintptr_t board,
                               int scene, int mode) {
    std::string signature = screen;
    signature.reserve(2048);
    AppendContextValue(signature, lawnApp);
    AppendContextValue(signature, board);
    AppendContextValue(signature, static_cast<uint32_t>(scene));
    AppendContextValue(signature, static_cast<uint32_t>(mode));

    uintptr_t player = 0;
    SafeRead(lawnApp + pvz::app::playerInfo, player);
    AppendContextValue(signature, player);

    DialogView dialog;
    if (ActiveDialog(lawnApp, dialog)) {
        AppendContextValue(signature, dialog.address);
        AppendContextValue(signature, static_cast<uint32_t>(dialog.id));
        if (dialog.id == 3) {
            int page = -1;
            SafeRead(dialog.address + 0x1A0, page);
            AppendContextValue(signature, static_cast<uint32_t>(page));
        } else if (dialog.id == 4) {
            int page = -1;
            uint8_t bubble = 0;
            SafeRead(dialog.address + 0x1AC, page);
            SafeRead(dialog.address + 0x1A0, bubble);
            AppendContextValue(signature, static_cast<uint32_t>(page));
            AppendContextValue(signature, bubble);
        }
    } else {
        AppendContextValue(signature, 0);
    }

    int daveMessage = -1;
    int daveLength = 0;
    if (DaveReady(lawnApp, daveMessage, &daveLength)) {
        AppendContextValue(signature, static_cast<uint32_t>(daveMessage));
        AppendContextValue(signature, static_cast<uint32_t>(daveLength));
    } else {
        AppendContextValue(signature, 0);
        AppendContextValue(signature, 0);
    }

    uintptr_t chooser = 0;
    if (std::strcmp(screen, "seed_picker") == 0 &&
        SafeRead(lawnApp + pvz::app::seedChooser, chooser) && chooser) {
        AppendContextValue(signature, chooser);
        SeedAvailabilityView availability;
        if (ReadSeedAvailability(lawnApp, availability)) {
            AppendContextValue(signature, availability.player);
            AppendContextValue(signature, static_cast<uint32_t>(availability.level));
            AppendContextValue(
                signature, static_cast<uint32_t>(availability.adventureCompletions));
            for (const int purchase : availability.plantUpgrades) {
                AppendContextValue(signature, static_cast<uint32_t>(purchase));
            }
        } else {
            AppendContextValue(signature, UINT32_MAX);
        }
        int chooseState = -1;
        int inFlight = -1;
        int inBank = -1;
        SafeRead(chooser + pvz::chooser::chooseState, chooseState);
        SafeRead(chooser + pvz::chooser::seedsInFlight, inFlight);
        SafeRead(chooser + pvz::chooser::seedsInBank, inBank);
        AppendContextValue(signature, static_cast<uint32_t>(chooseState));
        AppendContextValue(signature, static_cast<uint32_t>(inFlight));
        AppendContextValue(signature, static_cast<uint32_t>(inBank));
        for (int seedIndex = 0; seedIndex < pvz::chooser::visibleSeedCount; ++seedIndex) {
            std::array<uint8_t, pvz::chooser::chosenSeedStride> seed{};
            const uintptr_t address = chooser + pvz::chooser::chosenSeeds +
                static_cast<uintptr_t>(seedIndex) * seed.size();
            if (!SafeCopy(seed.data(), address, seed.size())) {
                AppendContextValue(signature, UINT32_MAX);
                continue;
            }
            AppendContextValue(signature, static_cast<uint32_t>(Field<int>(seed, 0x24)));
            AppendContextValue(signature, static_cast<uint32_t>(Field<int>(seed, 0x28)));
            AppendContextValue(signature, static_cast<uint32_t>(Field<int>(seed, 0x34)));
            AppendContextValue(
                signature,
                Field<uint8_t>(seed, pvz::chooser::chosenSeedCrazyDavePicked));
        }
    } else {
        AppendContextValue(signature, 0);
    }

    if (board) {
        int level = 0;
        uint8_t paused = 0;
        SafeRead(board + pvz::board::level, level);
        SafeRead(board + pvz::board::paused, paused);
        AppendContextValue(signature, static_cast<uint32_t>(level));
        AppendContextValue(signature, paused);
    }
    if (!(scene == 2 && std::strcmp(screen, "board") == 0) &&
        !SuppressTransientLoadingMenu(
            scene, std::strcmp(screen, "loading") == 0)) {
        for (const auto& control : CollectMenuControls(screen, lawnApp, board)) {
            signature.push_back('|');
            signature += control.id;
            signature.push_back(control.enabled ? '+' : '-');
            signature += control.label;
            signature.push_back(':');
            signature += control.state;
            AppendContextValue(signature, static_cast<uint32_t>(control.record + 1));
        }
    }
    return signature;
}

uint32_t ResolveMenuContext(const std::string& signature) {
    AcquireSRWLockExclusive(&g_menuContextLock);
    if (g_menuSignature != signature || !g_menuContext) {
        g_menuSignature = signature;
        g_menuContext = g_menuContext == 0x7FFFFFFFu ? 1u : g_menuContext + 1u;
    }
    const uint32_t result = g_menuContext;
    ReleaseSRWLockExclusive(&g_menuContextLock);
    return result;
}

bool MenuContextMatches(int expected, uintptr_t lawnApp) {
    if (expected < 0) return false;
    int scene = 0;
    int mode = 0;
    uintptr_t rawBoard = 0;
    SafeRead(lawnApp + pvz::app::gameScene, scene);
    SafeRead(lawnApp + pvz::app::gameMode, mode);
    SafeRead(lawnApp + pvz::app::board, rawBoard);
    const SemanticBoardGate gate = ReadSemanticBoardGate(
        lawnApp, scene, mode, rawBoard);
    const char* screen = DetermineScreen(lawnApp, scene, gate);
    const std::string signature = BuildMenuSignature(
        screen, lawnApp, gate.address, scene, mode);
    AcquireSRWLockShared(&g_menuContextLock);
    const bool matches = static_cast<uint32_t>(expected) == g_menuContext &&
                         signature == g_menuSignature;
    ReleaseSRWLockShared(&g_menuContextLock);
    return matches;
}

void AppendMenu(std::string& output, const char* screen, uintptr_t lawnApp,
                uintptr_t board, int scene) {
    output.push_back('[');
    bool first = true;
    if (!SuppressTransientLoadingMenu(
            scene, std::strcmp(screen, "loading") == 0)) {
        for (const auto& control : CollectMenuControls(screen, lawnApp, board)) {
            AppendMenuItem(output, first, control.id.c_str(), control.label.c_str(),
                           control.enabled, control.x, control.y, control.state, control.record);
        }
    }
    output.push_back(']');
}

void AppendDialog(std::string& output, uintptr_t lawnApp) {
    DialogView dialog;
    if (!ActiveDialog(lawnApp, dialog)) {
        g_dialogWasActive = false;
        g_previousDialog = 0;
        int daveMessage = -1;
        int messageLength = 0;
        if (DaveReady(lawnApp, daveMessage, &messageLength)) {
            const uint32_t pageIdentity =
                (static_cast<uint32_t>(daveMessage) * 1315423911u) ^
                static_cast<uint32_t>(messageLength);
            output += "{\"id\":";
            AppendInt(output, 1000000000LL + (pageIdentity & 0x3FFFFFFF));
            output += ",\"hasPrimary\":true,\"hasSecondary\":false,";
            output += "\"primaryLabel\":\"advance\",\"secondaryLabel\":null}";
        } else {
            output += "null";
        }
        return;
    }
    if (pvz::pauseDialog::Matches(dialog.id, dialog.vtable)) {
        output += "null";
        return;
    }
    if (!g_dialogWasActive || g_previousDialog != dialog.address) {
        ++g_dialogRunId;
        g_previousDialog = dialog.address;
    }
    g_dialogWasActive = true;
    MenuControl primary;
    MenuControl secondary;
    bool hasPrimary = false;
    bool hasSecondary = false;
    if (dialog.id == pvz::userDialog::dialogId) {
        const auto controls = CollectMenuControls("dialog", lawnApp, 0);
        const auto confirm = std::find_if(controls.begin(), controls.end(),
            [](const MenuControl& control) { return control.id == "confirm"; });
        if (confirm != controls.end()) {
            primary = *confirm;
            hasPrimary = true;
        }
        const auto cancel = std::find_if(controls.begin(), controls.end(),
            [](const MenuControl& control) { return control.id == "cancel"; });
        if (cancel != controls.end()) {
            secondary = *cancel;
            hasSecondary = true;
        }
    } else if (dialog.id == 3 || dialog.id == 4 ||
               dialog.id == pvz::userDialog::createDialogId) {
        const auto controls = CollectMenuControls("dialog", lawnApp, 0);
        const auto offered = std::find_if(controls.begin(), controls.end(),
            [&](const MenuControl& control) {
                return control.id ==
                    (dialog.id == pvz::userDialog::createDialogId ? "profile_create" : "advance");
            });
        if (offered != controls.end()) {
            primary = *offered;
            hasPrimary = true;
        }
    } else {
        hasPrimary = DialogButtonControl(dialog, dialog.primary, PrimaryDialogAction(dialog.id),
                                         PrimaryDialogAction(dialog.id), primary);
        hasSecondary = DialogButtonControl(dialog, dialog.secondary, SecondaryDialogAction(dialog.id),
                                           SecondaryDialogAction(dialog.id), secondary);
    }
    uint32_t pageIdentity = 0;
    int daveMessage = -1;
    int messageLength = 0;
    if (DaveReady(lawnApp, daveMessage, &messageLength)) {
        pageIdentity = (static_cast<uint32_t>(daveMessage) * 1315423911u) ^
                       static_cast<uint32_t>(messageLength);
    }
    if (dialog.id == 3) {
        int page = -1;
        SafeRead(dialog.address + 0x1A0, page);
        pageIdentity ^= static_cast<uint32_t>(page + 1) * 2654435761u;
    } else if (dialog.id == 4) {
        int page = -1;
        uint8_t bubble = 0;
        SafeRead(dialog.address + 0x1AC, page);
        SafeRead(dialog.address + 0x1A0, bubble);
        pageIdentity ^= static_cast<uint32_t>(page + 1) * 2654435761u;
        pageIdentity ^= static_cast<uint32_t>(bubble) << 30;
    }
    output += "{\"id\":";
    const uint32_t semanticDialogId =
        (static_cast<uint32_t>(dialog.id + 1) * 1103515245u ^
         static_cast<uint32_t>(g_dialogRunId) * 12345u ^ pageIdentity) & 0x7FFFFFFFu;
    AppendInt(output, semanticDialogId);
    output += ",\"hasPrimary\":";
    AppendBool(output, hasPrimary);
    output += ",\"hasSecondary\":";
    AppendBool(output, hasSecondary);
    output += ",\"primaryLabel\":";
    if (hasPrimary) AppendString(output, primary.label); else output += "null";
    output += ",\"secondaryLabel\":";
    if (hasSecondary) AppendString(output, secondary.label); else output += "null";
    output.push_back('}');
}

bool AppendSeedPicker(std::string& output, uintptr_t lawnApp, int expectedMode,
                      const SemanticBoardGate& expected) {
    SemanticBoardGate current;
    int mode = -1;
    if (!CurrentSeedPickerGate(lawnApp, current) ||
        !SafeRead(lawnApp + pvz::app::gameMode, mode) || mode != expectedMode ||
        current.address != expected.address || current.chooser != expected.chooser) {
        return false;
    }
    const uintptr_t chooser = current.chooser;
    const uintptr_t board = current.address;
    int inFlight = 0;
    int inBank = 0;
    uintptr_t seedBank = 0;
    int capacity = 0;
    SeedAvailabilityView availability;
    if (!SafeRead(board + pvz::board::seedBank, seedBank) || !seedBank ||
        !SafeRead(seedBank + pvz::seedBank::packetCount, capacity) ||
        !SafeRead(chooser + pvz::chooser::seedsInFlight, inFlight) ||
        !SafeRead(chooser + pvz::chooser::seedsInBank, inBank) ||
        !ReadSeedAvailability(lawnApp, availability) ||
        !ValidSeedPickerCapacity(capacity) ||
        inFlight < 0 || inFlight > capacity || inBank < 0 || inBank > capacity) {
        return false;
    }

    struct Choice {
        int id;
        int state;
        int bank;
        int imitater;
        int x;
        int y;
        bool fixed;
    };
    struct Selected { int bank; int id; };
    using SeedBytes = std::array<uint8_t, pvz::chooser::chosenSeedStride>;
    using SeedTable = std::array<SeedBytes, pvz::chooser::visibleSeedCount>;
    const auto readSeeds = [chooser](SeedTable& table) {
        for (int index = 0; index < pvz::chooser::visibleSeedCount; ++index) {
            const uintptr_t address = chooser + pvz::chooser::chosenSeeds +
                                      static_cast<uintptr_t>(index) *
                                          pvz::chooser::chosenSeedStride;
            if (!SafeCopy(table[index].data(), address, table[index].size())) return false;
        }
        return true;
    };
    SeedTable seeds{};
    if (!readSeeds(seeds)) return false;
    const bool imitaterAvailable = SeedAvailableFromProfile(availability, 48) &&
                                   SeedAllowedInChooserMode(mode, 48);
    const bool imitaterNeedsButton = imitaterAvailable &&
                                     Field<int>(seeds[48], 0x20) == 48 &&
                                     Field<int>(seeds[48], 0x24) == 4;
    MenuControl imitaterButton;
    if (imitaterNeedsButton &&
        !GameButtonControl(chooser, pvz::chooser::imitaterButton,
                           "imitater", "Imitater", imitaterButton)) return false;
    std::vector<Choice> choices;
    std::vector<Selected> selected;
    std::array<bool, 10> bankSlots{};
    for (int index = 0; index < pvz::chooser::visibleSeedCount; ++index) {
        const auto& seed = seeds[index];
        const int type = Field<int>(seed, 0x20);
        const int rawState = Field<int>(seed, 0x24);
        const uint8_t fixed = Field<uint8_t>(
            seed, pvz::chooser::chosenSeedCrazyDavePicked);
        if (type != index || rawState < 0 || rawState > 4) continue;
        if (fixed > 1) return false;
        const bool available = SeedAvailableFromProfile(availability, index) &&
                               SeedAllowedInChooserMode(mode, index);
        if (rawState == 1 && !available) return false;
        if (!available) continue;
        const int bank = Field<int>(seed, 0x28);
        const bool imitaterInChooser = index == 48 && rawState == 4;
        if (imitaterInChooser && !imitaterButton.enabled) return false;
        const int publicState = imitaterInChooser ? 3 : rawState;
        choices.push_back({
            index, publicState, bank, Field<int>(seed, 0x34),
            imitaterInChooser ? imitaterButton.x : Field<int>(seed, 0x00) + 25,
            imitaterInChooser ? imitaterButton.y : Field<int>(seed, 0x04) + 35,
            fixed != 0,
        });
        if (rawState == 1) {
            if (bank < 0 || bank >= capacity || bankSlots[bank]) return false;
            bankSlots[bank] = true;
            selected.push_back({bank, index});
        }
    }
    std::sort(selected.begin(), selected.end(),
              [](const Selected& left, const Selected& right) { return left.bank < right.bank; });
    const bool ready = SeedPickerReady(capacity, inBank, inFlight);
    if (selected.size() > static_cast<size_t>(capacity) ||
        (ready && selected.size() != static_cast<size_t>(capacity))) return false;

    std::vector<int> previewZombies;
    for (int type = 0; type < 33; ++type) {
        uint8_t allowed = 0;
        if (!SafeRead(board + pvz::board::zombieAllowed + type, allowed)) return false;
        if (allowed) previewZombies.push_back(type);
    }

    SemanticBoardGate confirmed;
    uintptr_t confirmedSeedBank = 0;
    int confirmedCapacity = 0;
    int confirmedInFlight = 0;
    int confirmedInBank = 0;
    int confirmedMode = -1;
    SeedTable confirmedSeeds{};
    SeedAvailabilityView confirmedAvailability;
    MenuControl confirmedImitaterButton;
    if (!CurrentSeedPickerGate(lawnApp, confirmed) ||
        confirmed.address != current.address || confirmed.chooser != current.chooser ||
        !SafeRead(lawnApp + pvz::app::gameMode, confirmedMode) || confirmedMode != mode ||
        !SafeRead(board + pvz::board::seedBank, confirmedSeedBank) ||
        confirmedSeedBank != seedBank ||
        !SafeRead(seedBank + pvz::seedBank::packetCount, confirmedCapacity) ||
        !SafeRead(chooser + pvz::chooser::seedsInFlight, confirmedInFlight) ||
        !SafeRead(chooser + pvz::chooser::seedsInBank, confirmedInBank) ||
        !readSeeds(confirmedSeeds) ||
        !ReadSeedAvailability(lawnApp, confirmedAvailability) ||
        !SameSeedAvailability(availability, confirmedAvailability) ||
        (imitaterNeedsButton &&
         (!GameButtonControl(chooser, pvz::chooser::imitaterButton,
                             "imitater", "Imitater", confirmedImitaterButton) ||
          confirmedImitaterButton.enabled != imitaterButton.enabled ||
          confirmedImitaterButton.x != imitaterButton.x ||
          confirmedImitaterButton.y != imitaterButton.y)) ||
        confirmedCapacity != capacity ||
        confirmedInFlight != inFlight || confirmedInBank != inBank ||
        confirmedSeeds != seeds) return false;

    output += "{\"capacity\":";
    AppendInt(output, capacity);
    output += ",\"selected\":[";
    for (size_t i = 0; i < selected.size(); ++i) {
        if (i) output.push_back(',');
        AppendInt(output, selected[i].id);
    }
    output += "],\"choices\":[";
    for (size_t i = 0; i < choices.size(); ++i) {
        const auto& choice = choices[i];
        if (i) output.push_back(',');
        output += "{\"id\":";
        AppendInt(output, choice.id);
        output += ",\"name\":";
        AppendString(output, PlantName(choice.id));
        output += ",\"state\":";
        static const char* const states[] = {"moving", "selected", "moving", "chooser", "hidden"};
        AppendString(output, states[choice.state]);
        output += ",\"bankSlot\":";
        if (choice.state == 1) AppendInt(output, choice.bank); else output += "null";
        output += ",\"imitates\":";
        if (choice.imitater >= 0 && choice.imitater < 53) AppendInt(output, choice.imitater);
        else output += "null";
        output += ",\"recommended\":false,\"fixed\":";
        AppendBool(output, choice.fixed);
        output += ",\"x\":";
        AppendInt(output, choice.x);
        output += ",\"y\":";
        AppendInt(output, choice.y);
        output.push_back('}');
    }
    output += "],\"previewZombies\":[";
    for (size_t i = 0; i < previewZombies.size(); ++i) {
        if (i) output.push_back(',');
        output += "{\"type\":";
        AppendInt(output, previewZombies[i]);
        output += ",\"name\":";
        AppendString(output, ZombieName(previewZombies[i]));
        output.push_back('}');
    }
    output += "],\"ready\":";
    AppendBool(output, ready);
    output.push_back('}');
    return true;
}

// 铲子按钮的落点,从真机帧量出来:解一张 800x600 的棋盘截图,取铲子铁头那片灰色像素的
// 质心,该点本身就是铲子图案。同一帧上七张卡的卡槽右端在 448。
// 卡槽随卡位数变宽,铲子牌是否跟着右移还没有实测;拿不到铲子时连卡槽矩形一起报出来。
constexpr int kShovelButtonX = 537;
constexpr int kShovelButtonY = 53;

/** 卡槽控件的实测矩形,只用于失败时把数报出来。卡包与卡槽同一套布局:0x08/0x0C 左上角,0x10/0x14 宽高。 */
struct SeedBankRect {
    bool read = false;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

SeedBankRect ReadSeedBankRect(uintptr_t boardAddress) {
    SeedBankRect rect;
    uintptr_t bank = 0;
    if (!SafeRead(boardAddress + pvz::board::seedBank, bank) || !bank) return rect;
    if (!SafeRead(bank + 0x08, rect.x) || !SafeRead(bank + 0x0C, rect.y) ||
        !SafeRead(bank + 0x10, rect.width) || !SafeRead(bank + 0x14, rect.height)) {
        return rect;
    }
    rect.read = true;
    return rect;
}

void AppendCards(std::string& output, const BoardView& board, int mode) {
    output.push_back('[');
    for (size_t i = 0; i < board.cards.size(); ++i) {
        const auto& card = board.cards[i];
        if (i) output.push_back(',');
        const bool packetCooldownReady = CardCooldownReady(board, card);
        const int cost = CurrentCardCost(board, mode, card);
        const bool conveyor = HasConveyorSeedBank(mode, board.level);
        const bool affordable = CardAffordable(board, mode, card);
        static constexpr const char* kCooldownNames[] = {"ready", "short", "medium", "long"};
        const char* cooldown = kCooldownNames[
            CooldownBucket(packetCooldownReady, card.refreshCounter, card.refreshTime)];
        const int remainingPercent = CooldownRemainingPercent(
            packetCooldownReady, card.refreshCounter, card.refreshTime);
        const int remainingTenthsSeconds = CooldownRemainingTenthsSeconds(
            packetCooldownReady, card.refreshCounter);
        output += "{\"slot\":";
        AppendInt(output, card.slot);
        output += ",\"type\":";
        AppendInt(output, card.type);
        output += ",\"name\":";
        AppendString(output, CardName(card.type));
        output += ",\"imitates\":";
        if (card.imitater >= 0 && card.imitater < 53) AppendInt(output, card.imitater);
        else output += "null";
        output += ",\"cost\":";
        if (!conveyor && cost >= 0) AppendInt(output, cost); else output += "null";
        output += ",\"ready\":";
        AppendBool(output, CardCooldownReady(board, card));
        output += ",\"affordable\":";
        AppendBool(output, affordable);
        output += ",\"cooldown\":";
        AppendString(output, cooldown);
        output += ",\"cooldownRemainingPercent\":";
        AppendInt(output, remainingPercent);
        output += ",\"cooldownRemainingSeconds\":";
        AppendTenth(output, remainingTenthsSeconds);
        output += ",\"x\":";
        AppendInt(output, card.x);
        output += ",\"y\":";
        AppendInt(output, card.y);
        output.push_back('}');
    }
    output.push_back(']');
}

void AppendPlants(std::string& output, const BoardView& board) {
    output.push_back('[');
    for (size_t i = 0; i < board.plants.size(); ++i) {
        const auto& plant = board.plants[i];
        if (i) output.push_back(',');
        output += "{\"id\":";
        AppendInt(output, plant.id);
        output += ",\"type\":";
        AppendInt(output, plant.type);
        output += ",\"name\":";
        AppendString(output, PlantName(plant.type));
        output += ",\"row\":";
        AppendInt(output, plant.row + 1);
        output += ",\"column\":";
        AppendInt(output, plant.column + 1);
        output += ",\"condition\":";
        AppendString(output, PlantVisibleCondition(plant.type, plant.health, plant.maxHealth));
        output += ",\"phase\":";
        AppendString(output, PlantPhaseName(plant.type, plant.state));
        output += ",\"sleeping\":";
        AppendBool(output, plant.sleeping);
        output += ",\"squished\":";
        AppendBool(output, plant.squished);
        output += ",\"layers\":[";
        if (plant.type == 16) AppendString(output, "lily_pad");
        else if (plant.type == 30) AppendString(output, "pumpkin");
        else if (plant.type == 33) AppendString(output, "flower_pot");
        else AppendString(output, "main");
        output += "]}";
    }
    output.push_back(']');
}

void AppendZombies(std::string& output, const BoardView& board) {
    output.push_back('[');
    bool first = true;
    for (const auto& zombie : board.zombies) {
        if (!zombie.whackPresented) continue;
        if (!first) output.push_back(',');
        first = false;
        const char* band = zombie.x < 240 ? "lawn" : zombie.x < 430 ? "near" :
                           zombie.x < 620 ? "mid" : "far";
        const char* speed = ZombieSpeedName(
            zombie.type, zombie.phase, zombie.height, zombie.velocityX,
            zombie.eating, zombie.hypnotized, zombie.slowed, zombie.immobilized,
            zombie.blowingAway, zombie.hasObject);
        output += "{\"id\":";
        AppendInt(output, zombie.id);
        output += ",\"type\":";
        AppendInt(output, zombie.type);
        output += ",\"name\":";
        AppendString(output, ZombieName(zombie.type));
        output += ",\"row\":";
        AppendInt(output, zombie.row + 1);
        output += ",\"column\":";
        AppendInt(output, zombie.column + 1);
        output += ",\"columnPosition\":";
        AppendTenth(output, ZombieColumnTenths(zombie.x));
        output += ",\"xBand\":";
        AppendString(output, band);
        output += ",\"phase\":";
        AppendString(output, ZombiePhaseName(zombie.phase));
        output += ",\"speed\":";
        AppendString(output, speed);
        output += ",\"speedCellsPerSecond\":";
        AppendHundredth(output, ZombieSpeedHundredths(
            speed, zombie.type, zombie.phase, zombie.velocityX, zombie.slowed));
        output += ",\"condition\":";
        AppendString(output, ZombieVisibleCondition(
            zombie.type, zombie.height, zombie.health, zombie.maxHealth,
            zombie.hasHead, zombie.hasArm));
        output += ",\"armor\":";
        AppendString(output, ArmorVisibleCondition(
            zombie.type, zombie.armorType, zombie.armorHealth, zombie.armorMax, false));
        output += ",\"shield\":";
        AppendString(output, ArmorVisibleCondition(
            zombie.type, zombie.shieldType, zombie.shieldHealth, zombie.shieldMax, true));
        output += ",\"hypnotized\":";
        AppendBool(output, zombie.hypnotized);
        output += ",\"slowed\":";
        AppendBool(output, zombie.slowed);
        output += ",\"immobilized\":";
        AppendBool(output, zombie.immobilized);
        output.push_back('}');
    }
    output.push_back(']');
}

void AppendGridItems(std::string& output, const BoardView& board) {
    output.push_back('[');
    for (size_t i = 0; i < board.gridItems.size(); ++i) {
        const auto& item = board.gridItems[i];
        if (i) output.push_back(',');
        output += "{\"id\":";
        AppendInt(output, item.id);
        output += ",\"kind\":";
        AppendString(output, GridItemName(item.type));
        output += ",\"row\":";
        AppendInt(output, item.row + 1);
        output += ",\"column\":";
        AppendInt(output, item.column + 1);
        if (item.type == 7) {
            output += ",\"visibleHint\":";
            AppendString(output, item.potContentType == 1 ? "plant" : "unknown");
        }
        if (item.type == 7 && item.transparentCounter > 0) {
            if (item.potContentType == 1 && item.seedType >= 0 && item.seedType < 53) {
                output += ",\"revealedContent\":{\"kind\":\"plant\",\"type\":";
                AppendInt(output, item.seedType);
                output += ",\"name\":";
                AppendString(output, PlantName(item.seedType));
                output.push_back('}');
            } else if (item.potContentType == 2 && item.zombieType >= 0 && item.zombieType < 33) {
                output += ",\"revealedContent\":{\"kind\":\"zombie\",\"type\":";
                AppendInt(output, item.zombieType);
                output += ",\"name\":";
                AppendString(output, ZombieName(item.zombieType));
                output.push_back('}');
            } else if (item.potContentType == 3 && item.sunCount > 0) {
                output += ",\"revealedContent\":{\"kind\":\"sun\",\"count\":";
                AppendInt(output, item.sunCount);
                output.push_back('}');
            }
        }
        output.push_back('}');
    }
    output.push_back(']');
}

void AppendCollectibles(std::string& output, const BoardView& board) {
    output.push_back('[');
    for (size_t i = 0; i < board.collectibles.size(); ++i) {
        const auto& item = board.collectibles[i];
        if (i) output.push_back(',');
        output += "{\"id\":";
        AppendInt(output, item.id);
        output += ",\"kind\":";
        AppendString(output, CoinName(item.type));
        if (item.type == 16 && item.containedType >= 0 && item.containedType < 53) {
            output += ",\"containedType\":";
            AppendInt(output, item.containedType);
            output += ",\"containedName\":";
            AppendString(output, PlantName(item.containedType));
        }
        output += ",\"x\":";
        AppendInt(output, item.x);
        output += ",\"y\":";
        AppendInt(output, item.y);
        output += ",\"row\":null,\"column\":null}";
    }
    output.push_back(']');
}

void AppendMowers(std::string& output, const BoardView& board) {
    output.push_back('[');
    for (size_t i = 0; i < board.mowers.size(); ++i) {
        if (i) output.push_back(',');
        output += "{\"row\":";
        AppendInt(output, board.mowers[i].row + 1);
        output += ",\"kind\":";
        AppendString(output, MowerName(board.mowers[i].type));
        output += ",\"state\":";
        AppendString(output, board.mowers[i].triggered ? "triggered" : "ready");
        output.push_back('}');
    }
    output.push_back(']');
}

int GridSquare(uintptr_t board, int row, int column) {
    int square = 0;
    SafeRead(board + pvz::board::gridSquareType +
             static_cast<uintptr_t>((column * 6 + row) * sizeof(int)), square);
    return square;
}

const PlantView* BasePlantAt(const BoardView& board, int row, int column) {
    const auto base = std::find_if(board.plants.begin(), board.plants.end(),
        [&](const PlantView& plant) {
            return plant.row == row && plant.column == column &&
                   (plant.type == 16 || plant.type == 33);
        });
    return base == board.plants.end() ? nullptr : &*base;
}

const PlantView* PlantOfTypeAt(const BoardView& board, int row, int column, int type) {
    const auto plant = std::find_if(board.plants.begin(), board.plants.end(),
        [&](const PlantView& value) {
            const bool occupies = value.type == 47
                ? value.row == row && (value.column == column || value.column + 1 == column)
                : value.row == row && value.column == column;
            return occupies && value.type == type;
        });
    return plant == board.plants.end() ? nullptr : &*plant;
}

const PlantView* NormalPlantAt(const BoardView& board, int row, int column) {
    const auto plant = std::find_if(board.plants.begin(), board.plants.end(),
        [&](const PlantView& value) {
            const bool occupies = value.type == 47
                ? value.row == row && (value.column == column || value.column + 1 == column)
                : value.row == row && value.column == column;
            return occupies && value.type != 16 && value.type != 30 && value.type != 33;
        });
    return plant == board.plants.end() ? nullptr : &*plant;
}

const GridItemView* BlockingGridItemAt(const BoardView& board, int row, int column) {
    const auto item = std::find_if(board.gridItems.begin(), board.gridItems.end(),
        [&](const GridItemView& value) {
            return value.row == row && value.column == column &&
                   (value.type == 1 || value.type == 2 || value.type == 7);
        });
    return item == board.gridItems.end() ? nullptr : &*item;
}

void AppendCells(std::string& output, const BoardView& board) {
    output.push_back('[');
    bool first = true;
    for (int row = 0; row < board.rows; ++row) {
        for (int column = 0; column < 9; ++column) {
            if (!first) output.push_back(',');
            first = false;
            const int square = GridSquare(board.address, row, column);
            int centerX = 0;
            int centerY = 0;
            CellCenter(board.address, board.background, row, column, centerX, centerY);
            const bool cellRendered = FogAllowsZombie(
                board.address, 0, board.background, centerX, row);
            const bool dynamicVisible = board.entitiesVisible && cellRendered;
            const bool staticPlayable = square == 1 || square == 3 || square == 4;
            const bool occupancyUnknown = staticPlayable && !dynamicVisible;
            const PlantView* base = dynamicVisible ? BasePlantAt(board, row, column) : nullptr;
            const PlantView* normal = dynamicVisible ? NormalPlantAt(board, row, column) : nullptr;
            const GridItemView* gridBlocker = dynamicVisible
                ? BlockingGridItemAt(board, row, column) : nullptr;
            const char* terrain = square == 1 ? "lawn" : square == 3 ? "water" :
                                  square == 4 ? "roof" : "unavailable";
            const char* blocker = occupancyUnknown
                                      ? (board.entitiesVisible ? "fog_hidden" : "dark_hidden")
                                      :
                                  gridBlocker ? GridItemName(gridBlocker->type) :
                                  normal ? "occupied" :
                                  square == 3 && (!base || base->type != 16)
                                       ? "requires_lily_pad" :
                                  square == 4 && (!base || base->type != 33)
                                      ? "requires_flower_pot" : nullptr;
            output += "{\"row\":";
            AppendInt(output, row + 1);
            output += ",\"column\":";
            AppendInt(output, column + 1);
            output += ",\"terrain\":";
            AppendString(output, terrain);
            output += ",\"playable\":";
            if (!staticPlayable || !board.entitiesVisible) AppendBool(output, false);
            else if (!cellRendered) output += "null";
            else AppendBool(output, true);
            output += ",\"blocker\":";
            if (blocker) AppendString(output, blocker); else output += "null";
            output += ",\"base\":";
            AppendString(output, occupancyUnknown ? "unknown" :
                         !base ? "none" : base->type == 16 ? "lily_pad" : "flower_pot");
            output.push_back('}');
        }
    }
    output.push_back(']');
}

bool CanPlantCardAt(const BoardView& board, const CardView& card, int row, int column) {
    int centerX = 0;
    int centerY = 0;
    CellCenter(board.address, board.background, row, column, centerX, centerY);
    const int square = GridSquare(board.address, row, column);
    const int type = card.type == 48 ? card.imitater : card.type;
    if (square != 1 && square != 3 && square != 4) return false;
    if (!board.entitiesVisible ||
        !FogAllowsZombie(board.address, 0, board.background, centerX, row)) {
        if (type == 16 || type == 19 || type == 24) return square == 3;
        if (type == 33) return square == 4;
        if (type == 11 || type == 21) return square == 1;
        return true;
    }
    const PlantView* base = BasePlantAt(board, row, column);
    const PlantView* normal = NormalPlantAt(board, row, column);
    const PlantView* pumpkin = PlantOfTypeAt(board, row, column, 30);
    const GridItemView* gridBlocker = BlockingGridItemAt(board, row, column);
    if (gridBlocker) {
        if (type == 11 && gridBlocker->type == 1 && !normal) return true;
        return false;
    }
    if (type == 11) return false;
    if (type == 16 || type == 19 || type == 24) {
        return square == 3 && !base && !normal;
    }
    if (type == 33) return square == 4 && !base && !normal && !pumpkin;
    if (type == 21) return square == 1 && !base && !normal;
    if (type == 35) return normal && normal->sleeping;
    if (type == 30) return !pumpkin && (!normal || normal->type != 47) &&
                              (square != 3 || (base && base->type == 16)) &&
                              (square != 4 || (base && base->type == 33));
    static constexpr std::array<std::pair<int, int>, 7> upgrades{{
        {40, 7}, {41, 1}, {42, 10}, {44, 39}, {45, 31}, {46, 21}, {43, 16}}};
    const auto upgrade = std::find_if(upgrades.begin(), upgrades.end(),
        [&](const auto& value) { return value.first == type; });
    if (upgrade != upgrades.end()) {
        if (type == 43) return square == 3 && base && base->type == 16 && !normal;
        return normal && normal->type == upgrade->second;
    }
    if (type == 47) {
        if (column >= 8 || !PlantOfTypeAt(board, row, column, 34) ||
            !PlantOfTypeAt(board, row, column + 1, 34)) return false;
        return true;
    }
    if (normal) return false;
    if (square == 3 && (!base || base->type != 16)) return false;
    if (square == 4 && (!base || base->type != 33)) return false;
    return true;
}

constexpr std::array<std::pair<int, int>, 14> kSeeingStarsCells{{
    {0, 3},
    {1, 3}, {1, 4},
    {2, 1}, {2, 2}, {2, 3}, {2, 4}, {2, 5}, {2, 6},
    {3, 3}, {3, 4}, {3, 5},
    {4, 3}, {4, 6},
}};

constexpr bool SeeingStarsObjectiveCell(int row, int column) {
    for (const auto& cell : kSeeingStarsCells) {
        if (cell.first == row && cell.second == column) return true;
    }
    return false;
}

constexpr int BoundedProgress(int value, int target) {
    return value < 0 ? 0 : value > target ? target : value;
}

constexpr int BossMeterPercent(int width) {
    return width < 0 ? -1 : BoundedProgress(width, 150) * 100 / 150;
}

static_assert(kSeeingStarsCells.size() == 14 &&
              SeeingStarsObjectiveCell(0, 3) && SeeingStarsObjectiveCell(2, 1) &&
              SeeingStarsObjectiveCell(2, 6) && SeeingStarsObjectiveCell(4, 6) &&
              !SeeingStarsObjectiveCell(0, 2) && !SeeingStarsObjectiveCell(5, 3));
static_assert(BoundedProgress(-1, 14) == 0 && BoundedProgress(7, 14) == 7 &&
              BoundedProgress(15, 14) == 14);
static_assert(BossMeterPercent(-1) == -1 && BossMeterPercent(0) == 0 &&
              BossMeterPercent(75) == 50 && BossMeterPercent(150) == 100 &&
              BossMeterPercent(151) == 100);

bool SeeingStarsCellFilled(const BoardView& board, int row, int column) {
    return std::any_of(board.plants.begin(), board.plants.end(),
        [&](const PlantView& plant) {
            return plant.type == 29 && plant.row == row && plant.column == column;
        });
}

int SeeingStarsCompleted(const BoardView& board) {
    return static_cast<int>(std::count_if(
        kSeeingStarsCells.begin(), kSeeingStarsCells.end(),
        [&](const auto& cell) {
            return SeeingStarsCellFilled(board, cell.first, cell.second);
        }));
}

/**
 * 旗子:关卡进度条上人唯一看得见的那一格刻度。
 *
 * 波次是关卡脚本的内部计数,屏幕上没有一处写着它。每十波一面旗,旗子波本身还在场上
 * 时那面旗不算过。对外只报旗子,波次不越过植入件这一层。
 */
constexpr int FlagTotal(int numWaves) {
    return numWaves > 0 ? (numWaves + 9) / 10 : -1;
}

int FlagsPassed(const BoardView& board) {
    int wave = std::max(board.currentWave, 0);
    if (wave > 0 && wave % 10 == 0 && board.boardFadeOutCounter < 0 &&
        board.nextSurvivalStageCounter == 0) --wave;
    return wave / 10;
}

void AppendProgress(std::string& output, const BoardView& board, int mode) {
    int vaseCount = 0;
    for (const auto& item : board.gridItems) {
        if (item.type == 7) ++vaseCount;
    }
    const char* kind = "flags";
    int target = FlagTotal(board.numWaves);
    int current = target > 0 ? BoundedProgress(FlagsPassed(board), target) : FlagsPassed(board);
    int stage = -1;
    std::string label = target > 0
        ? "Flag " + std::to_string(current) + "/" + std::to_string(target)
        : "Flag " + std::to_string(current);
    if (board.complete) {
        kind = "complete";
        current = -1;
        target = -1;
        stage = -1;
        label = "Complete";
    } else if (mode == 35 || (mode == 0 && board.level == 50)) {
        kind = "boss";
        current = BossMeterPercent(board.progressMeterWidth);
        target = 100;
        label = current < 0 ? "Boss progress unavailable"
                            : "Boss " + std::to_string(current) + "%";
    } else if (IsVaseLevel(mode, board.level)) {
        kind = "vases";
        current = vaseCount;
        target = -1;
        stage = std::max(board.survivalStage, 0) + 1;
        label = "Vase stage " + std::to_string(stage) + ": " +
                std::to_string(vaseCount) + " vases remain";
    } else if (mode == 43 || mode == 50) {
        kind = "unknown";
        current = -1;
        target = -1;
        stage = -1;
        label = "No level progress";
    } else if (mode >= 1 && mode <= 15) {
        kind = "flags";
        target = mode <= 5 ? 5 : mode <= 10 ? 10 : -1;
        const int wavesPerStage = mode <= 5 ? 10 : 20;
        const int flags =
            std::max(board.survivalStage, 0) * wavesPerStage / 10 + FlagsPassed(board);
        current = target > 0 ? BoundedProgress(flags, target) : std::max(flags, 0);
        stage = std::max(board.survivalStage, 0) + 1;
        label = target > 0 ? "Survival stage " + std::to_string(stage) +
                             ", flag " + std::to_string(current) + "/" +
                             std::to_string(target)
                           : "Survival endless stage " + std::to_string(stage) +
                             ", flag " + std::to_string(current);
    } else if (mode == 18) {
        kind = "sun_goal";
        current = BoundedProgress(board.sun, 2000);
        target = 2000;
        label = board.challengeState == 4 ? "Slot machine rolling" :
                std::to_string(current) + "/2000 sun";
    } else if (mode == 20 || mode == 24) {
        kind = "score";
        current = BoundedProgress(board.challengeScore, 75);
        target = 75;
        label = "Matches " + std::to_string(current) + "/75";
    } else if (mode == 22) {
        kind = "stars";
        current = SeeingStarsCompleted(board);
        target = 14;
        label = "Stars " + std::to_string(current) + "/14";
    } else if (mode == 23) {
        kind = "sun_goal";
        current = BoundedProgress(board.sun, 1000);
        target = 1000;
        label = std::to_string(current) + "/1000 sun";
    } else if (mode == 31) {
        target = 5;
        stage = std::max(board.survivalStage, 0) + 1;
        if (board.challengeState == 10) {
            kind = "flags";
            current = BoundedProgress(board.survivalStage, 5);
            label = "Last Stand stage " + std::to_string(stage) +
                    ", onslaught " + std::to_string(current) + "/5";
        } else {
            kind = "setup";
            current = -1;
            label = "Last Stand stage " + std::to_string(stage) + " setup";
        }
    } else if (mode >= 61 && mode <= 70) {
        kind = "brains";
        current = BoundedProgress(board.challengeScore, 5);
        target = 5;
        if (mode == 70) stage = std::max(board.survivalStage, 0) + 1;
        label = mode == 70
            ? "I-Zombie stage " + std::to_string(stage) + ": " +
              std::to_string(current) + "/5 brains"
            : std::to_string(current) + "/5 brains";
    }
    output += "{\"kind\":";
    AppendString(output, kind);
    output += ",\"current\":";
    if (current >= 0) AppendInt(output, current); else output += "null";
    output += ",\"target\":";
    if (target >= 0) AppendInt(output, target); else output += "null";
    output += ",\"stage\":";
    if (stage >= 0) AppendInt(output, stage); else output += "null";
    output += ",\"label\":";
    AppendString(output, label);
    output.push_back('}');
}

bool SlotPacketsSettled(uintptr_t board, uintptr_t& bank, int& packetCount);
bool LastStandButtonReady(uintptr_t board, uintptr_t& button);

struct SpecialTargetView {
    const char* action;
    const char* kind;
    int64_t id;
    int slot;
    int row;
    int column;
    bool actionable = true;
};

struct SpecialView {
    bool present = false;
    std::string phase;
    bool settled = false;
    std::vector<SpecialTargetView> targets;
};

struct PottedPlantView {
    int index = -1;
    int seedType = -1;
    int garden = -1;
    int x = -1;
    int y = -1;
    int age = -1;
    int timesFed = -1;
    int feedingsPerGrow = -1;
    int storedNeed = -1;
    int64_t lastWatered = 0;
    int64_t lastNeedFulfilled = 0;
    int64_t lastFertilized = 0;
    int64_t lastChocolate = 0;
};

struct ZenProfileView {
    uintptr_t player = 0;
    uintptr_t garden = 0;
    int gardenType = -1;
    int adventureCompletions = 0;
    int treeHeight = -1;
    std::array<int, pvz::purchase::itemCount> purchases{};
};

enum class ZenCareTool : int { Water, Fertilize, BugSpray, Phonograph, Chocolate };

constexpr int ZenCharges(int purchase) {
    return purchase > pvz::purchase::countOffset
        ? purchase - pvz::purchase::countOffset : 0;
}

constexpr std::array<bool, 9> ZenToolbarVisibility(
    int mode, const std::array<int, pvz::purchase::itemCount>& purchases,
    bool adventureComplete) {
    std::array<bool, 9> visible{};
    if (mode == 50) {
        visible[8] = true;
        return visible;
    }
    if (mode != 43) return visible;
    visible[0] = true;
    visible[1] = purchases[pvz::purchase::fertilizer] > 0;
    visible[2] = purchases[pvz::purchase::bugSpray] > 0;
    visible[3] = purchases[pvz::purchase::phonograph] > 0;
    visible[4] = purchases[pvz::purchase::chocolate] > 0;
    visible[5] = purchases[pvz::purchase::gardeningGlove] > 0;
    visible[6] = adventureComplete;
    visible[7] = purchases[pvz::purchase::wheelbarrow] > 0;
    return visible;
}

constexpr int ZenToolbarCenterX(int tool,
                                const std::array<bool, 9>& visible) {
    if (tool < 0 || tool >= static_cast<int>(visible.size()) ||
        !visible[static_cast<size_t>(tool)]) return -1;
    int preceding = 0;
    for (int index = 0; index < tool; ++index) {
        if (visible[static_cast<size_t>(index)]) ++preceding;
    }
    return 65 + 70 * preceding;
}

constexpr bool ZenCareVisible(ZenCareTool tool, int plantState, bool sleeping,
                              int age, int storedNeed, int purchase,
                              int64_t now, int64_t lastChocolate) {
    switch (tool) {
        case ZenCareTool::Water:
            return !sleeping && plantState == 0;
        case ZenCareTool::Fertilize:
            return plantState == 44 && age < 3 && ZenCharges(purchase) > 0;
        case ZenCareTool::BugSpray:
            return plantState == 44 && age == 3 && storedNeed == 3 &&
                   ZenCharges(purchase) > 0;
        case ZenCareTool::Phonograph:
            return plantState == 44 && age == 3 && storedNeed == 4 && purchase > 0;
        case ZenCareTool::Chocolate:
            return plantState == 45 && age == 3 && ZenCharges(purchase) > 0 &&
                   now >= 300 && lastChocolate <= now - 300;
    }
    return false;
}

constexpr int NextGardenDestination(int mode, int garden, bool mushroom,
                                    bool aquarium, bool tree) {
    if (mode == 50) return 0;
    if (mode != 43) return -1;
    if (garden == 0) {
        if (mushroom) return 1;
        if (aquarium) return 3;
        return tree ? 50 : -1;
    }
    if (garden == 1) {
        if (aquarium) return 3;
        return tree ? 50 : 0;
    }
    if (garden == 3) return tree ? 50 : 0;
    return -1;
}

constexpr auto kZenFullPurchases = [] {
    std::array<int, pvz::purchase::itemCount> purchases{};
    purchases[pvz::purchase::fertilizer] = pvz::purchase::countOffset;
    purchases[pvz::purchase::bugSpray] = pvz::purchase::countOffset;
    purchases[pvz::purchase::phonograph] = 1;
    purchases[pvz::purchase::chocolate] = pvz::purchase::countOffset;
    purchases[pvz::purchase::gardeningGlove] = 1;
    purchases[pvz::purchase::wheelbarrow] = 1;
    return purchases;
}();
constexpr auto kZenFullToolbar = ZenToolbarVisibility(43, kZenFullPurchases, true);
constexpr auto kTreeToolbar = ZenToolbarVisibility(50, kZenFullPurchases, true);
static_assert(ZenToolbarCenterX(0, kZenFullToolbar) == 65 &&
              ZenToolbarCenterX(1, kZenFullToolbar) == 135 &&
              ZenToolbarCenterX(4, kZenFullToolbar) == 345 &&
              ZenToolbarCenterX(8, kTreeToolbar) == 65);
static_assert(ZenCareVisible(ZenCareTool::Water, 0, false, 0, 0, 0, 0, 0) &&
              !ZenCareVisible(ZenCareTool::Water, 0, true, 0, 0, 0, 0, 0) &&
              ZenCareVisible(ZenCareTool::Fertilize, 44, false, 2, 2, 1001, 0, 0) &&
              !ZenCareVisible(ZenCareTool::Fertilize, 44, false, 2, 2, 1000, 0, 0) &&
              ZenCareVisible(ZenCareTool::BugSpray, 44, false, 3, 3, 1001, 0, 0) &&
              ZenCareVisible(ZenCareTool::Phonograph, 44, false, 3, 4, 1, 0, 0) &&
              ZenCareVisible(ZenCareTool::Chocolate, 45, false, 3, 0, 1001, 600, 200) &&
              !ZenCareVisible(ZenCareTool::Chocolate, 45, false, 3, 0, 1001, 600, 301));
static_assert(NextGardenDestination(43, 0, true, true, true) == 1 &&
              NextGardenDestination(43, 0, false, true, true) == 3 &&
              NextGardenDestination(43, 1, false, false, true) == 50 &&
              NextGardenDestination(43, 3, false, false, false) == 0 &&
              NextGardenDestination(50, -1, false, false, false) == 0);

bool ReadZenProfile(uintptr_t lawnApp, bool requireGarden, bool requireTreeHeight,
                    ZenProfileView& profile) {
    profile = {};
    if (!SafeRead(lawnApp + pvz::app::playerInfo, profile.player) || !profile.player ||
        !SafeRead(profile.player + pvz::player::adventureCompletions,
                  profile.adventureCompletions) ||
        !SafeCopy(profile.purchases.data(), profile.player + pvz::player::purchases,
                  sizeof(profile.purchases))) return false;
    if (requireGarden) {
        if (!SafeRead(lawnApp + pvz::app::zenGarden, profile.garden) || !profile.garden ||
            !SafeRead(profile.garden + 0x08, profile.gardenType) ||
            (profile.gardenType != 0 && profile.gardenType != 1 &&
             profile.gardenType != 3)) return false;
    }
    if (requireTreeHeight &&
        (!SafeRead(profile.player + pvz::player::treeHeight, profile.treeHeight) ||
         profile.treeHeight < 0)) return false;
    return true;
}

bool ReadPottedPlantAt(uintptr_t lawnApp, int index, PottedPlantView& potted) {
    uintptr_t player = 0;
    int count = 0;
    if (index < 0 || !SafeRead(lawnApp + pvz::app::playerInfo, player) || !player ||
        !SafeRead(player + pvz::player::numPottedPlants, count) || count < 0 || count > 200 ||
        index >= count) return false;
    const uintptr_t address = player + pvz::player::pottedPlants +
        static_cast<uintptr_t>(index) * pvz::player::pottedPlantStride;
    potted = {};
    potted.index = index;
    return SafeRead(address + pvz::pottedPlant::seedType, potted.seedType) &&
           SafeRead(address + pvz::pottedPlant::garden, potted.garden) &&
           SafeRead(address + pvz::pottedPlant::x, potted.x) &&
           SafeRead(address + pvz::pottedPlant::y, potted.y) &&
           SafeRead(address + pvz::pottedPlant::lastWatered, potted.lastWatered) &&
           SafeRead(address + pvz::pottedPlant::age, potted.age) &&
           SafeRead(address + pvz::pottedPlant::timesFed, potted.timesFed) &&
           SafeRead(address + pvz::pottedPlant::feedingsPerGrow, potted.feedingsPerGrow) &&
           SafeRead(address + pvz::pottedPlant::storedNeed, potted.storedNeed) &&
           SafeRead(address + pvz::pottedPlant::lastNeedFulfilled,
                    potted.lastNeedFulfilled) &&
           SafeRead(address + pvz::pottedPlant::lastFertilized, potted.lastFertilized) &&
           SafeRead(address + pvz::pottedPlant::lastChocolate, potted.lastChocolate) &&
           potted.seedType >= 0 && potted.seedType < 53 &&
           potted.garden >= 0 && potted.garden <= 3 &&
           potted.x >= 0 && potted.x < 9 && potted.y >= 0 && potted.y < 6 &&
           potted.age >= 0 && potted.age <= 3 && potted.timesFed >= 0 &&
           potted.feedingsPerGrow >= 0 && potted.feedingsPerGrow <= 16 &&
           potted.storedNeed >= 0 && potted.storedNeed <= 4;
}

bool ReadPottedPlant(const BoardView& board, const PlantView& plant,
                     PottedPlantView& potted) {
    return ReadPottedPlantAt(board.lawnApp, plant.pottedIndex, potted);
}

bool PottedMatchesPlant(const PottedPlantView& potted, const PlantView& plant,
                        int gardenType) {
    return potted.index == plant.pottedIndex && potted.garden == gardenType &&
           potted.x == plant.column && potted.y == plant.row;
}

bool HasActiveZenTool(const BoardView& board) {
    return std::any_of(board.gridItems.begin(), board.gridItems.end(),
        [](const GridItemView& item) { return item.type == 9; });
}

bool ParseZenCareTool(const std::string& action, ZenCareTool& tool) {
    if (action == "zen_water") tool = ZenCareTool::Water;
    else if (action == "zen_fertilize") tool = ZenCareTool::Fertilize;
    else if (action == "zen_bug_spray") tool = ZenCareTool::BugSpray;
    else if (action == "zen_phonograph") tool = ZenCareTool::Phonograph;
    else if (action == "zen_chocolate") tool = ZenCareTool::Chocolate;
    else return false;
    return true;
}

int ZenCarePurchase(const ZenProfileView& profile, ZenCareTool tool) {
    switch (tool) {
        case ZenCareTool::Water: return 0;
        case ZenCareTool::Fertilize:
            return profile.purchases[pvz::purchase::fertilizer];
        case ZenCareTool::BugSpray:
            return profile.purchases[pvz::purchase::bugSpray];
        case ZenCareTool::Phonograph:
            return profile.purchases[pvz::purchase::phonograph];
        case ZenCareTool::Chocolate:
            return profile.purchases[pvz::purchase::chocolate];
    }
    return 0;
}

int ZenCareToolbarIndex(ZenCareTool tool) {
    return static_cast<int>(tool);
}

int ZenCareCursorType(ZenCareTool tool) {
    return 9 + static_cast<int>(tool);
}

bool CurrentZenCareTarget(const BoardView& board, const ZenProfileView& profile,
                          ZenCareTool tool, uint32_t targetId,
                          PlantView& plant, PottedPlantView& potted) {
    const auto found = std::find_if(board.plants.begin(), board.plants.end(),
        [&](const PlantView& value) { return value.id == targetId; });
    if (found == board.plants.end() || !ReadPottedPlant(board, *found, potted) ||
        !PottedMatchesPlant(potted, *found, profile.gardenType)) return false;
    const int64_t now = static_cast<int64_t>(std::time(nullptr));
    if (!ZenCareVisible(tool, found->state, found->sleeping, potted.age,
                        potted.storedNeed, ZenCarePurchase(profile, tool), now,
                        potted.lastChocolate)) return false;
    plant = *found;
    return true;
}

void AppendSpecialTarget(std::string& output, bool& first, const SpecialTargetView& target) {
    if (!first) output.push_back(',');
    first = false;
    output += "{\"action\":";
    AppendString(output, target.action);
    output += ",\"kind\":";
    AppendString(output, target.kind);
    output += ",\"id\":";
    if (target.id >= 0) AppendInt(output, target.id); else output += "null";
    output += ",\"slot\":";
    if (target.slot >= 0) AppendInt(output, target.slot); else output += "null";
    output += ",\"row\":";
    if (target.row >= 0) AppendInt(output, target.row); else output += "null";
    output += ",\"column\":";
    if (target.column >= 0) AppendInt(output, target.column); else output += "null";
    output.push_back('}');
}

SpecialView BuildSpecial(const BoardView& board, int mode) {
    SpecialView special;
    const bool challengeMode = IsBowlingLevel(mode, board.level) || IsWhackLevel(mode, board.level) ||
                               IsVaseLevel(mode, board.level) || mode == 18 || mode == 19 || mode == 20 ||
                               mode == 22 || mode == 23 || mode == 24 || mode == 30 || mode == 31 || mode == 33 ||
                               mode == 43 || mode == 50 || (mode >= 51 && mode <= 70);
    const bool readyCob = std::any_of(board.plants.begin(), board.plants.end(),
        [](const PlantView& plant) { return plant.type == 47 && plant.state == 37; });
    const bool heldUsableSeed = board.cursorType == 2 &&
                                board.cursorHeldType >= 0 && board.cursorHeldType < 53;
    const bool cobAllowedMode = mode != 23 && mode != 43 && mode != 50 &&
                                !(mode >= 61 && mode <= 70);
    if (!challengeMode && !(readyCob && cobAllowedMode) && !heldUsableSeed) return special;

    special.present = true;
    special.phase = "playing";
    special.settled = true;
    ZenProfileView zenProfile;
    bool zenProfileReady = false;
    if (board.paused) {
        special.phase = "paused";
        special.settled = false;
        return special;
    }
    if (!board.entitiesVisible) {
        special.phase = "hidden";
        special.settled = false;
        return special;
    }
    if (board.complete || HasLevelTransition(board)) {
        special.phase = "transition";
        special.settled = false;
        return special;
    }
    if (mode == 18) {
        uintptr_t bank = 0;
        int packets = 0;
        special.settled = board.challengeState == 0 && SlotPacketsSettled(board.address, bank, packets);
        special.phase = board.challengeState == 4 ? "rolling" : special.settled ? "ready" : "blocked";
    } else if (mode == 19) {
        special.settled = board.cursorType == 2;
        special.phase = special.settled ? "held_seed" : "waiting_for_packet";
    } else if (mode == 20 || mode == 24) {
        special.settled = board.challengeState == 0 && board.challengeMouseCapture == 0;
        special.phase = special.settled ? "settled" : "moving";
    } else if (mode == 22) {
        special.phase = "objectives";
    } else if (mode == 31) {
        uintptr_t button = 0;
        special.settled = board.challengeState == 0 && LastStandButtonReady(board.address, button);
        special.phase = special.settled ? "setup_ready" :
                        board.challengeState == 10 ? "onslaught" : "setup";
    } else if (IsVaseLevel(mode, board.level)) {
        special.settled = board.challengeState == 0;
        special.phase = special.settled ? "ready" : "animating";
    } else if (mode == 43) {
        if (board.tutorialState >= 22 && board.tutorialState <= 24) {
            special.phase = board.tutorialState == 22 ? "pickup_water" : "watering";
            special.settled = true;
        } else if (board.tutorialState == 25) {
            special.phase = "visit_store";
            special.settled = false;
        } else if (board.tutorialState == 26) {
            special.phase = "fertilizing";
            special.settled = true;
        } else if (board.tutorialState == 27) {
            special.phase = "complete";
            special.settled = false;
        } else if (board.tutorialState == 0) {
            zenProfileReady = ReadZenProfile(board.lawnApp, true, false, zenProfile);
            const bool activeTool = HasActiveZenTool(board);
            special.settled = zenProfileReady && !activeTool && board.cursorType == 0;
            special.phase = !zenProfileReady ? "unavailable" :
                            activeTool ? "care_animating" :
                            board.cursorType != 0 ? "tool_held" :
                            board.challengeState == 8 ? "toolbar_hidden" : "garden_ready";
        } else {
            special.phase = "dialogue";
            special.settled = false;
        }
    } else if (mode == 50) {
        zenProfileReady = ReadZenProfile(board.lawnApp, false, false, zenProfile);
        const bool activeTool = HasActiveZenTool(board);
        special.settled = zenProfileReady && !activeTool &&
                          board.challengeState != 11 && board.cursorType == 0;
        special.phase = !zenProfileReady ? "unavailable" :
                        activeTool ? "feeding" :
                        board.challengeState == 11 ? "growing" :
                        board.cursorType != 0 ? "tool_held" : "tree_ready";
    } else if (mode == 23) {
        special.settled = board.challengeState == 0 && !board.complete;
        special.phase = !special.settled ? "complete" :
                        board.tutorialState == 21 ? "trophy_ready" :
                        board.tutorialState == 19 ? "buy_snorkel" : "feeding";
    } else if (mode >= 61 && mode <= 70) {
        special.settled = board.challengeState == 0 && !board.complete && board.challengeScore < 5;
        special.phase = special.settled ? "placing_zombies" : "complete";
    }
    auto add = [&](const char* action, const char* kind, int64_t id, int slot,
                   int row, int column, bool actionable = true) {
        special.targets.push_back({action, kind, id, slot, row, column, actionable});
    };
    const auto cardUsable = [&](const CardView& card) {
        return CardUsable(board, mode, card);
    };
    if (IsBowlingLevel(mode, board.level) && special.settled) {
        bool hasReadyCard = false;
        for (const auto& card : board.cards) {
            if (cardUsable(card)) {
                hasReadyCard = true;
                add("bowling", "card", -1, card.slot, -1, -1);
            }
        }
        if (hasReadyCard) {
            for (int row = 1; row <= board.rows; ++row) {
                for (int column = 1; column <= 3; ++column) {
                    const int square = GridSquare(board.address, row - 1, column - 1);
                    if (square == 1 || square == 3 || square == 4) {
                        add("bowling", "cell", -1, -1, row, column);
                    }
                }
            }
        }
    }
    if (mode == 18 && special.settled) add("spin", "cell", -1, -1, -1, -1);
    if (heldUsableSeed) {
        const CardView held{-1, board.cursorHeldType, -1, 0, 0, 0, true, false, 0, 0};
        for (int row = 1; row <= board.rows; ++row) {
            for (int column = 1; column <= 9; ++column) {
                if (CanPlantCardAt(board, held, row - 1, column - 1)) {
                    add("launch", "cell", -1, -1, row, column);
                }
            }
        }
    }
    if ((mode == 20 || mode == 24) && special.settled) {
        const char* action = mode == 20 ? "swap" : "twist";
        for (const auto& plant : board.plants) {
            if (mode == 24 && (plant.row + 1 >= board.rows || plant.column + 1 >= 9)) continue;
            add(action, "cell", -1, -1, plant.row + 1, plant.column + 1);
        }
        for (const auto& card : board.cards) {
            int upgrade = -1;
            if (card.type == 7) upgrade = 0;
            else if (card.type == 10) upgrade = 1;
            else if (card.type == 23) upgrade = 2;
            const bool semanticReady =
                (upgrade >= 0 && !board.beghouledUpgrades[static_cast<size_t>(upgrade)]) ||
                card.type == 54 || (card.type == 55 && board.beghouledCraterCount > 0);
            if (semanticReady && cardUsable(card)) {
                add("beghouled_buy", "card", -1, card.slot, -1, -1);
            }
        }
    }
    if (IsWhackLevel(mode, board.level) && special.settled) {
        for (const auto& zombie : board.zombies) {
            ZombieView target{};
            if (!ResolveWhackTarget(board, zombie.id, target)) continue;
            add("whack", "zombie", target.id, -1, target.row + 1, target.column + 1);
        }
    }
    if (mode == 22 && special.settled) {
        for (const auto& cell : kSeeingStarsCells) {
            if (!SeeingStarsCellFilled(board, cell.first, cell.second)) {
                add("objective_starfruit", "cell", -1, -1,
                    cell.first + 1, cell.second + 1, false);
            }
        }
    }
    if (mode == 31 && special.settled) add("start_onslaught", "cell", -1, -1, -1, -1);
    if (IsVaseLevel(mode, board.level) && special.settled) {
        for (const auto& item : board.gridItems) {
            if (item.type == 7) {
                add("break_vase", "grid_item", item.id, -1, item.row + 1, item.column + 1);
            }
        }
    }
    if (mode == 43 && special.settled) {
        if (board.tutorialState == 0 && zenProfileReady) {
            const int64_t now = static_cast<int64_t>(std::time(nullptr));
            for (const auto& plant : board.plants) {
                PottedPlantView potted;
                if (!ReadPottedPlant(board, plant, potted) ||
                    !PottedMatchesPlant(potted, plant, zenProfile.gardenType)) continue;
                for (int value = static_cast<int>(ZenCareTool::Water);
                     value <= static_cast<int>(ZenCareTool::Chocolate); ++value) {
                    const auto tool = static_cast<ZenCareTool>(value);
                    if (!ZenCareVisible(tool, plant.state, plant.sleeping, potted.age,
                                        potted.storedNeed, ZenCarePurchase(zenProfile, tool),
                                        now, potted.lastChocolate)) continue;
                    static constexpr const char* actions[] = {
                        "zen_water", "zen_fertilize", "zen_bug_spray",
                        "zen_phonograph", "zen_chocolate"};
                    add(actions[value], "plant", plant.id, -1,
                        plant.row + 1, plant.column + 1);
                }
            }
        } else {
            for (const auto& plant : board.plants) {
                PottedPlantView potted;
                if (!ReadPottedPlant(board, plant, potted)) continue;
                if (board.tutorialState >= 22 && board.tutorialState <= 24 &&
                    potted.timesFed < potted.feedingsPerGrow) {
                    add("zen_water", "plant", plant.id, -1, plant.row + 1, plant.column + 1);
                } else if (board.tutorialState == 26 && potted.age == 0) {
                    add("zen_fertilize", "plant", plant.id, -1, plant.row + 1, plant.column + 1);
                }
            }
        }
    }
    if (mode == 43 && board.tutorialState == 0 && zenProfileReady &&
        board.cursorType == 0 &&
        NextGardenDestination(
            mode, zenProfile.gardenType,
            zenProfile.purchases[pvz::purchase::mushroomGarden] > 0,
            zenProfile.purchases[pvz::purchase::aquariumGarden] > 0,
            zenProfile.purchases[pvz::purchase::treeOfWisdom] > 0) >= 0) {
        add("zen_next_garden", "cell", -1, -1, -1, -1);
    }
    if (mode == 50 && zenProfileReady && board.cursorType == 0 &&
        board.challengeState != 8) {
        if (!HasActiveZenTool(board) && board.challengeState != 11 &&
            ZenCharges(zenProfile.purchases[pvz::purchase::treeFood]) > 0) {
            add("tree_feed", "cell", -1, -1, -1, -1);
        }
        add("zen_next_garden", "cell", -1, -1, -1, -1);
    }
    if (mode == 23 && special.settled) {
        const int brainCount = static_cast<int>(std::count_if(
            board.gridItems.begin(), board.gridItems.end(),
            [](const GridItemView& item) { return item.type == 6; }));
        for (const auto& card : board.cards) {
            if (!cardUsable(card)) continue;
            if (card.type == 58 && board.zombies.size() <= 100) {
                add("buy_snorkel", "cell", -1, -1, -1, -1);
            } else if (card.type == 59) {
                add("buy_trophy", "cell", -1, -1, -1, -1);
            }
        }
        if (board.sun + board.sunBeingCollected >= 5 && brainCount < 3) {
            for (int row = 1; row <= 4; ++row) {
                for (int column = 1; column <= 9; ++column) {
                    const int x = column * 80;
                    const int y = (row - 1) * 100 + 130;
                    const bool coinBlocks = std::any_of(
                        board.collectibles.begin(), board.collectibles.end(),
                        [&](const CollectibleView& coin) {
                            return x >= coin.hitLeft && x < coin.hitRight &&
                                   y >= coin.hitTop && y < coin.hitBottom;
                        });
                    if (!coinBlocks) add("drop_brain", "cell", -1, -1, row, column);
                }
            }
        }
    }
    if (mode >= 61 && mode <= 70 && special.settled) {
        for (const auto& card : board.cards) {
            if (!IsIZombieCard(card.type) || !cardUsable(card)) continue;
            add("place_zombie", "card", -1, card.slot, -1, -1);
            for (int row = 1; row <= std::min(board.rows, 5); ++row) {
                for (int column = 1; column <= 9; ++column) {
                    if (IZombieCellAllowed(mode, card.type, row, column)) {
                        add("place_zombie", "cell", -1, card.slot, row, column);
                    }
                }
            }
        }
    }
    for (const auto& plant : board.plants) {
        if (cobAllowedMode && plant.type == 47 && plant.state == 37) {
            add("cob_fire", "plant", plant.id, -1, plant.row + 1, plant.column + 1);
        }
    }
    return special;
}

void AppendSpecial(std::string& output, const SpecialView& special) {
    if (!special.present) {
        output += "null";
        return;
    }
    output += "{\"phase\":";
    AppendString(output, special.phase);
    output += ",\"settled\":";
    AppendBool(output, special.settled);
    output += ",\"targets\":[";
    bool first = true;
    for (const auto& target : special.targets) AppendSpecialTarget(output, first, target);
    output += "]}";
}

bool SpecialCommandOffered(const SpecialView& special, const Command& command) {
    if (!special.present) return false;
    if (std::none_of(special.targets.begin(), special.targets.end(),
        [&](const SpecialTargetView& target) {
            return target.actionable && target.action == command.special;
        })) return false;
    const auto matchesEntity = [&](const SpecialTargetView& target) {
        return target.actionable && target.action == command.special &&
               target.id == command.targetId &&
               target.row == command.row && target.column == command.column;
    };
    const auto matchesCell = [&](const SpecialTargetView& target) {
        return target.actionable && target.action == command.special &&
               std::strcmp(target.kind, "cell") == 0 &&
               target.row == command.row && target.column == command.column;
    };
    if (command.special == "whack") {
        return std::any_of(command.targetIds.begin(), command.targetIds.end(),
            [&](int id) {
                return std::any_of(special.targets.begin(), special.targets.end(),
                    [&](const SpecialTargetView& target) {
                        return target.actionable && target.action == command.special &&
                               std::strcmp(target.kind, "zombie") == 0 &&
                               target.id == id;
                    });
            });
    }
    if (command.special == "beghouled_buy") {
        return std::any_of(special.targets.begin(), special.targets.end(),
            [&](const SpecialTargetView& target) {
                return target.actionable && target.action == command.special &&
                       std::strcmp(target.kind, "card") == 0 &&
                       target.slot == command.slot;
            });
    }
    if (command.special == "bowling" || command.special == "place_zombie") {
        const bool card = std::any_of(special.targets.begin(), special.targets.end(),
            [&](const SpecialTargetView& target) {
                return target.actionable && target.action == command.special &&
                       std::strcmp(target.kind, "card") == 0 &&
                       target.slot == command.slot;
            });
        const bool cell = std::any_of(special.targets.begin(), special.targets.end(),
            [&](const SpecialTargetView& target) {
                return matchesCell(target) &&
                       (command.special != "place_zombie" || target.slot == command.slot);
            });
        return card && cell;
    }
    if (command.special == "break_vase" ||
        command.special == "cob_fire" || command.special == "zen_water" ||
        command.special == "zen_fertilize" || command.special == "zen_bug_spray" ||
        command.special == "zen_phonograph" || command.special == "zen_chocolate") {
        return std::any_of(special.targets.begin(), special.targets.end(), matchesEntity);
    }
    if (command.special == "spin" || command.special == "start_onslaught" ||
        command.special == "buy_snorkel" || command.special == "buy_trophy") {
        return std::any_of(special.targets.begin(), special.targets.end(),
            [&](const SpecialTargetView& target) {
                return target.actionable && target.action == command.special;
            });
    }
    return std::any_of(special.targets.begin(), special.targets.end(), matchesCell);
}

void AppendBoard(std::string& output, const BoardView& board, int mode) {
    const SpecialView special = BuildSpecial(board, mode);
    const bool storm = mode == 48 || (mode == 0 && board.level == 40);
    const bool entitiesVisible = board.entitiesVisible;
    output += "{\"runId\":";
    AppendInt(output, g_boardRunId);
    output += ",\"rows\":";
    AppendInt(output, board.rows);
    output += ",\"columns\":9,\"level\":";
    AppendInt(output, std::max(board.level, 0));
    output += ",\"background\":";
    AppendInt(output, std::max(board.background, 0));
    output += ",\"paused\":";
    AppendBool(output, board.paused);
    output += ",\"sun\":";
    AppendInt(output, std::max(board.sun, 0));
    output += ",\"cursor\":{\"kind\":";
    AppendString(output, CursorName(board.cursorType));
    output += ",\"heldType\":";
    if (board.cursorHeldType >= 0 && board.cursorHeldType < 256) AppendInt(output, board.cursorHeldType);
    else output += "null";
    output += ",\"logicalX\":";
    AppendInt(output, g_cursorX.load());
    output += ",\"logicalY\":";
    AppendInt(output, g_cursorY.load());
    output += "},\"fog\":{\"active\":";
    AppendBool(output, board.background == 3 || mode == 21 || storm);
    output += ",\"visibilityRule\":";
    AppendString(output, mode == 21 ? "invisighoul" :
                         board.background == 3 || storm ? "rendered_fog" : "none");
    output += "},\"disclosure\":{\"entitiesVisible\":";
    AppendBool(output, entitiesVisible);
    output += ",\"phase\":";
    AppendString(output, entitiesVisible ? "visible" : "dark");
    output += "},\"cards\":";
    AppendCards(output, board, mode);
    output += ",\"cells\":";
    AppendCells(output, board);
    output += ",\"plants\":";
    AppendPlants(output, board);
    output += ",\"zombies\":";
    AppendZombies(output, board);
    output += ",\"gridItems\":";
    AppendGridItems(output, board);
    output += ",\"collectibles\":";
    AppendCollectibles(output, board);
    output += ",\"mowers\":";
    AppendMowers(output, board);
    output += ",\"progress\":";
    AppendProgress(output, board, mode);
    output += ",\"tutorial\":null,\"special\":";
    AppendSpecial(output, special);
    output += ",\"allowedSpecialActions\":[";
    bool first = true;
    std::unordered_set<std::string> actions;
    for (const auto& target : special.targets) {
        if (!target.actionable) continue;
        if (!actions.insert(target.action).second) continue;
        if (!first) output.push_back(',');
        first = false;
        AppendString(output, target.action);
    }
    output += "]}";
}

int ShovelTutorialPeashooterCount(const BoardView& board) {
    return static_cast<int>(std::count_if(
        board.plants.begin(), board.plants.end(),
        [](const PlantView& plant) { return plant.type == 0; }));
}

const char* ShovelTutorialPhaseName(int tutorialState) {
    if (tutorialState == pvz::tutorial::shovelPickup) return "pickup";
    if (tutorialState == pvz::tutorial::shovelDig) return "dig";
    return "keep_digging";
}

void AppendShovelTutorialCells(std::string& output, const BoardView& board) {
    output.push_back('[');
    bool first = true;
    for (int row = 0; row < 5; ++row) {
        for (int column = 0; column < 9; ++column) {
            if (!first) output.push_back(',');
            first = false;
            const bool target = std::any_of(
                board.plants.begin(), board.plants.end(),
                [&](const PlantView& plant) {
                    return plant.type == 0 && plant.row == row && plant.column == column;
                });
            output += "{\"row\":";
            AppendInt(output, row + 1);
            output += ",\"column\":";
            AppendInt(output, column + 1);
            output += ",\"terrain\":\"lawn\",\"playable\":false,\"blocker\":";
            AppendString(output, target
                ? "shovel_tutorial_target" : "shovel_tutorial_locked");
            output += ",\"base\":\"none\"}";
        }
    }
    output.push_back(']');
}

void AppendShovelTutorialBoard(std::string& output, const BoardView& board,
                               int tutorialState) {
    BoardView restricted = board;
    restricted.cards.clear();
    restricted.plants.erase(
        std::remove_if(restricted.plants.begin(), restricted.plants.end(),
            [](const PlantView& plant) { return plant.type != 0; }),
        restricted.plants.end());
    restricted.zombies.clear();
    restricted.gridItems.clear();
    restricted.collectibles.clear();
    restricted.mowers.clear();
    const int remaining = ShovelTutorialPeashooterCount(restricted);

    output += "{\"runId\":";
    AppendInt(output, g_boardRunId);
    output += ",\"rows\":5,\"columns\":9,\"level\":5,\"background\":0,\"paused\":";
    AppendBool(output, board.paused);
    output += ",\"sun\":0,\"cursor\":{\"kind\":";
    AppendString(output, board.cursorType == 6 ? "shovel" : "normal");
    output += ",\"heldType\":null,\"logicalX\":";
    AppendInt(output, g_cursorX.load());
    output += ",\"logicalY\":";
    AppendInt(output, g_cursorY.load());
    output += "},\"fog\":{\"active\":false,\"visibilityRule\":\"none\"},"
              "\"disclosure\":{\"entitiesVisible\":true,\"phase\":\"visible\"},"
              "\"cards\":[],\"cells\":";
    AppendShovelTutorialCells(output, restricted);
    output += ",\"plants\":";
    AppendPlants(output, restricted);
    output += ",\"zombies\":[],\"gridItems\":[],\"collectibles\":[],\"mowers\":[],"
              "\"progress\":{\"kind\":\"targets\",\"current\":";
    AppendInt(output, remaining);
    output += ",\"target\":null,\"stage\":null,\"label\":";
    AppendString(output, "Shovel tutorial: " + std::to_string(remaining) +
                         " Peashooters remain");
    output += "},\"tutorial\":{\"kind\":\"shovel\",\"phase\":";
    AppendString(output, ShovelTutorialPhaseName(tutorialState));
    output += ",\"remainingPlants\":";
    AppendInt(output, remaining);
    output += ",\"allowedActions\":[\"shovel\"]},"
              "\"special\":null,\"allowedSpecialActions\":[]}";
}

const char* DetermineScreen(uintptr_t lawnApp, int scene,
                            const SemanticBoardGate& gate) {
    DialogView dialog;
    if (ActiveDialog(lawnApp, dialog)) return dialog.id == 17 ? "defeat" : "dialog";
    int daveMessage = -1;
    if (DaveReady(lawnApp, daveMessage)) return "dialog";
    if (scene == 2) {
        if (gate.seedPicker) return "seed_picker";
        return gate.shovelTutorial ? "board" : "loading";
    }
    if (scene == 3) return gate.gameplay ? "board" : "loading";
    uintptr_t pointer = 0;
    if (SafeRead(lawnApp + pvz::app::awardScreen, pointer) && pointer) return "award";
    if (SafeRead(lawnApp + pvz::app::creditScreen, pointer) && pointer) return "credits";
    if (SafeRead(lawnApp + pvz::app::challengeScreen, pointer) && pointer) return "mode_selector";
    if (SafeRead(lawnApp + pvz::app::gameSelector, pointer) && pointer) return "main_menu";
    if (scene == 4) return "defeat";
    if (scene == 0) return "loading";
    if (scene == 1) return "main_menu";
    if (scene == 5) return "award";
    if (scene == 6) return "credits";
    if (scene == 7) return "mode_selector";
    return "unknown";
}

const char* DetermineScreen(uintptr_t lawnApp, int scene, uintptr_t board) {
    int mode = -1;
    SafeRead(lawnApp + pvz::app::gameMode, mode);
    const SemanticBoardGate gate = ReadSemanticBoardGate(
        lawnApp, scene, mode, board);
    return DetermineScreen(lawnApp, scene, gate);
}

bool ActiveRunCanWin() {
    return g_activeRun.valid && g_activeRun.eligible && !g_activeRun.terminalSeen &&
           FinalWinForRun(g_activeRun.mode, g_activeRun.level,
                          g_activeRun.survivalStage);
}

bool LatchActiveRun(int terminal) {
    if (!g_activeRun.valid || !g_activeRun.eligible || g_activeRun.terminalSeen ||
        (terminal != pvz::result::won && terminal != pvz::result::lost)) return false;
    if (terminal == pvz::result::won && !ActiveRunCanWin()) return false;
    g_lastRun.present = true;
    g_lastRun.resultId = g_nextResultId++;
    g_lastRun.runId = g_activeRun.runId;
    g_lastRun.mode = g_activeRun.mode;
    g_lastRun.level = g_activeRun.level;
    g_lastRun.outcome = terminal;
    g_activeRun.terminalSeen = true;
    return true;
}

bool UpdateActiveRunSignals(const BoardView& board) {
    if (!g_activeRun.valid || g_activeRun.runId != g_boardRunId) return false;
    const int stage = std::max(board.survivalStage, 0);
    if (g_activeRun.survivalStage != stage) {
        g_activeRun.survivalStage = stage;
        g_activeRun.awardArmed = !board.levelAwardSpawned;
        g_activeRun.awardHigh = board.levelAwardSpawned;
        g_activeRun.completeArmed = !board.complete;
        g_activeRun.completeHigh = board.complete;
        return false;
    }
    if (!board.levelAwardSpawned) g_activeRun.awardArmed = true;
    if (!board.complete) g_activeRun.completeArmed = true;
    const bool freshAward = board.levelAwardSpawned && g_activeRun.awardArmed &&
                            !g_activeRun.awardHigh;
    const bool freshComplete = board.complete && g_activeRun.completeArmed &&
                               !g_activeRun.completeHigh;
    g_activeRun.awardHigh = board.levelAwardSpawned;
    g_activeRun.completeHigh = board.complete;
    return freshAward || freshComplete;
}

void ObserveBoardResult(int boardResult, bool currentRunVisible,
                        bool freshWinEvidence) {
    if (!KnownBoardResult(boardResult) || !g_activeRun.valid) return;
    if (currentRunVisible && boardResult == pvz::result::none) {
        g_activeRun.eligible = true;
    }
    const int terminal = TerminalBoardResultDecision(
        boardResult, g_activeRun.eligible, g_activeRun.terminalSeen,
        freshWinEvidence && ActiveRunCanWin());
    if (terminal != pvz::result::none) {
        LatchActiveRun(terminal);
    }
}

bool TerminalWinDestination(const char* screen) {
    return std::strcmp(screen, "award") == 0 ||
           std::strcmp(screen, "mode_selector") == 0 ||
           std::strcmp(screen, "main_menu") == 0 ||
           std::strcmp(screen, "credits") == 0;
}

void AppendLastRun(std::string& output) {
    if (!g_lastRun.present) {
        output += "null";
        return;
    }
    output += "{\"resultId\":";
    AppendInt(output, static_cast<int64_t>(g_lastRun.resultId));
    output += ",\"runId\":";
    AppendInt(output, static_cast<int64_t>(g_lastRun.runId));
    output += ",\"mode\":";
    AppendInt(output, g_lastRun.mode);
    output += ",\"level\":";
    AppendInt(output, g_lastRun.level);
    output += ",\"outcome\":";
    AppendString(output, g_lastRun.outcome == pvz::result::won ? "won" : "lost");
    output.push_back('}');
}

HWND GameWindow();
bool HasManagedClientSize(HWND window);

/**
 * 窗口此刻能不能被操作,以及量出来的实况。
 *
 * `managed` = Per-Monitor V2 且 client 恰好 800×600(原生输入与截图的硬前提);
 * `onScreen` = 整个 client 矩形落在同一块显示器的可见范围内。两者任一为假,
 * 截图会截到黑边、鼠标消息会被拒——这两条事实随每一帧快照如实报上去,不再让
 * 上面只看到"动作失败"却说不出为什么。
 */
struct ManagedWindowPresentation {
    bool managed = false;
    bool onScreen = false;
    bool minimized = false;
    int clientWidth = 0;
    int clientHeight = 0;
};

constexpr bool ManagedWindowContains(const RECT& bounds, const RECT& client) {
    return client.left >= bounds.left && client.top >= bounds.top &&
           client.right <= bounds.right && client.bottom <= bounds.bottom;
}

static_assert(ManagedWindowContains(RECT{0, 0, 1920, 1080}, RECT{100, 100, 900, 700}) &&
              !ManagedWindowContains(RECT{0, 0, 1920, 1080}, RECT{1200, 100, 2000, 700}) &&
              !ManagedWindowContains(RECT{0, 0, 1920, 1080}, RECT{-40, 100, 760, 700}));

bool ClientScreenRect(HWND window, RECT& rect) {
    POINT origin{0, 0};
    if (!GetClientRect(window, &rect) || !ClientToScreen(window, &origin)) return false;
    OffsetRect(&rect, origin.x, origin.y);
    return true;
}

ManagedWindowPresentation ReadManagedWindowPresentation(HWND window) {
    ManagedWindowPresentation view;
    RECT client{};
    if (!window || !GetClientRect(window, &client)) return view;
    view.clientWidth = std::max<LONG>(client.right - client.left, 0);
    view.clientHeight = std::max<LONG>(client.bottom - client.top, 0);
    view.managed = HasManagedClientSize(window);
    view.minimized = IsIconic(window) != FALSE;
    RECT screenRect{};
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    const HMONITOR monitor = ClientScreenRect(window, screenRect)
        ? MonitorFromRect(&screenRect, MONITOR_DEFAULTTONULL) : nullptr;
    view.onScreen = !view.minimized && monitor && GetMonitorInfoW(monitor, &info) &&
                    ManagedWindowContains(info.rcMonitor, screenRect);
    return view;
}

/**
 * 逐帧检查窗口位置；需要修正时在本线程调用 SetWindowPos。
 * 跨线程 SetWindowPos 使用 sent message，窗口线程取消息时会处理，不受 PvZ 带过滤的 PeekMessage 限制。
 * 修正失败后按 kWindowRepairRetryMs 限制重试频率。
 */
ManagedWindowPresentation MaintainManagedWindow() {
    HWND window = GameWindow();
    const ManagedWindowPresentation view = ReadManagedWindowPresentation(window);
    if ((view.managed && view.onScreen) || !ManagedWindowRepairAllowed(window)) {
        g_windowRepairAttemptedAt.store(0, std::memory_order_release);
        return view;
    }
    const ULONGLONG now = GetTickCount64();
    const ULONGLONG last = g_windowRepairAttemptedAt.load(std::memory_order_acquire);
    if (last && now - last < kWindowRepairRetryMs) return view;
    g_windowRepairAttemptedAt.store(now, std::memory_order_release);
    RepairManagedWindow(window);
    return view;
}

std::string BuildSnapshot() {
    const ManagedWindowPresentation presentation = MaintainManagedWindow();
    uintptr_t lawnApp = 0;
    const bool live = ReadLawnApp(lawnApp);
    int scene = 0;
    int mode = 0;
    int boardResult = -1;
    bool boardResultAvailable = false;
    uintptr_t rawBoardAddress = 0;
    SemanticBoardGate gate;
    BoardView board;
    if (live) {
        SafeRead(lawnApp + pvz::app::gameScene, scene);
        SafeRead(lawnApp + pvz::app::gameMode, mode);
        boardResultAvailable = SafeRead(
            lawnApp + pvz::app::boardResult, boardResult) && KnownBoardResult(boardResult);
        SafeRead(lawnApp + pvz::app::board, rawBoardAddress);
        gate = ReadSemanticBoardGate(lawnApp, scene, mode, rawBoardAddress);
        if (gate.gameplay || gate.shovelTutorial) {
            if (!ReadBoard(lawnApp, mode, board, gate.address) ||
                !StableAppBoardTuple(lawnApp, scene, mode, gate.address,
                                     board.level, board.mainCounter) ||
                (gate.shovelTutorial &&
                 (ShovelTutorialPeashooterCount(board) == 0 ||
                  ShovelTutorialPeashooterCount(board) > 3))) {
                gate = {};
                board = {};
            }
        } else if (gate.seedPicker) {
            board.lawnApp = lawnApp;
            board.address = gate.address;
            board.level = gate.level;
            board.mainCounter = gate.mainCounter;
        }
    }
    const char* screen = live ? DetermineScreen(lawnApp, scene, gate) :
                         g_validation.supported ? "loading" : "unknown";
    std::string seedPicker;
    if (std::strcmp(screen, "seed_picker") == 0 &&
        (!gate.seedPicker || !AppendSeedPicker(seedPicker, lawnApp, mode, gate))) {
        // Screen identity and its payload form one sample. A chooser transition is loading.
        screen = "loading";
    }
    const bool newRun = SemanticBoardStartsRun(
        g_boardWasActive, g_previousBoard, g_previousBoardCounter,
        gate.address, gate.mainCounter);
    if (g_activeRun.valid && !g_activeRun.terminalSeen) {
        if (boardResultAvailable && boardResult == pvz::result::won &&
            TerminalWinDestination(screen)) {
            LatchActiveRun(pvz::result::won);
        } else if (newRun && gate.address && g_activeRun.mode == 0 && mode == 0 &&
                   AdventureNextLevel(g_activeRun.level, gate.level)) {
            LatchActiveRun(pvz::result::won);
        }
    }
    if (gate.address) {
        if (newRun) {
            ++g_boardRunId;
            g_activeRun = {};
        }
        g_boardWasActive = true;
        g_previousBoard = gate.address;
        g_previousBoardCounter = gate.mainCounter;
        if (!g_activeRun.valid && ValidRunIdentity(mode, gate.level)) {
            g_activeRun.valid = true;
            g_activeRun.runId = g_boardRunId;
            g_activeRun.boardAddress = gate.address;
            g_activeRun.mode = mode;
            g_activeRun.level = gate.level;
        }
    } else if (ClearSemanticBoardHistory(rawBoardAddress, gate.address)) {
        g_boardWasActive = false;
        g_previousBoard = 0;
        g_previousBoardCounter = 0;
    }
    const bool freshWinEvidence = gate.gameplay && UpdateActiveRunSignals(board);
    const bool currentRunVisible = gate.address && g_activeRun.valid &&
                                   g_activeRun.runId == g_boardRunId &&
                                   g_activeRun.boardAddress == gate.address &&
                                   g_activeRun.mode == mode &&
                                   g_activeRun.level == gate.level;
    if (boardResultAvailable &&
        (currentRunVisible || std::strcmp(screen, "defeat") == 0)) {
        ObserveBoardResult(boardResult, currentRunVisible, freshWinEvidence);
    }
    const uint32_t menuContext = live
        ? ResolveMenuContext(BuildMenuSignature(screen, lawnApp, gate.address, scene, mode))
        : ResolveMenuContext(std::string(screen) + "|offline");

    LARGE_INTEGER frequency{};
    LARGE_INTEGER counter{};
    QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&counter);
    const uint64_t monotonicMs = frequency.QuadPart
        ? static_cast<uint64_t>(counter.QuadPart * 1000 / frequency.QuadPart) : GetTickCount64();

    std::string output;
    output.reserve(16384);
    output += "{\"type\":\"snapshot\",\"protocol\":2,\"snapshot\":{\"protocol\":2,\"revision\":";
    AppendInt(output, ++g_revision);
    output += ",\"monotonicMs\":";
    AppendInt(output, monotonicMs);
    std::string activeAction;
    size_t queueDepth = 0;
    EnterCriticalSection(&g_commandLock);
    activeAction = g_activeActionId;
    queueDepth = g_commands.size();
    LeaveCriticalSection(&g_commandLock);
    output += ",\"inputControl\":{\"epoch\":";
    AppendInt(output, g_actionEpoch.load());
    output += ",\"queueDepth\":";
    AppendInt(output, queueDepth);
    output += ",\"menuContext\":";
    AppendInt(output, menuContext);
    output += ",\"activeActionId\":";
    if (activeAction.empty()) output += "null"; else AppendString(output, activeAction);
    output.push_back('}');
    output += ",\"executable\":{\"sha256\":";
    AppendString(output, g_validation.hash);
    output += ",\"version\":";
    AppendString(output, g_validation.version);
    output += ",\"profile\":";
    AppendString(output, pvz::kProfileName);
    output += ",\"supported\":";
    AppendBool(output, g_validation.supported);
    output += "},\"presentation\":{\"managed\":";
    AppendBool(output, presentation.managed);
    output += ",\"onScreen\":";
    AppendBool(output, presentation.onScreen);
    output += ",\"minimized\":";
    AppendBool(output, presentation.minimized);
    output += ",\"clientWidth\":";
    AppendInt(output, presentation.clientWidth);
    output += ",\"clientHeight\":";
    AppendInt(output, presentation.clientHeight);
    output += "},\"screen\":";
    AppendString(output, screen);
    output += ",\"scene\":";
    AppendInt(output, std::max(scene, 0));
    output += ",\"mode\":";
    AppendInt(output, std::max(mode, 0));
    output += ",\"modeName\":";
    AppendString(output, ModeName(mode));
    output += ",\"modeKind\":";
    AppendString(output, ModeKind(mode));
    output += ",\"profile\":";
    if (live) AppendProfile(output, lawnApp); else output += "null";
    output += ",\"lastRun\":";
    AppendLastRun(output);
    output += ",\"menu\":";
    if (live && !gate.shovelTutorial) {
        AppendMenu(output, screen, lawnApp, gate.address, scene);
    } else {
        output += "[]";
    }
    output += ",\"dialog\":";
    if (live) AppendDialog(output, lawnApp); else output += "null";
    output += ",\"seedPicker\":";
    if (std::strcmp(screen, "seed_picker") == 0) output += seedPicker;
    else output += "null";
    output += ",\"board\":";
    if (gate.gameplay && board.address) AppendBoard(output, board, mode);
    else if (gate.shovelTutorial && board.address &&
             std::strcmp(screen, "board") == 0) {
        AppendShovelTutorialBoard(output, board, gate.tutorialState);
    }
    else output += "null";
    output += "}}";
    return output;
}

}  // namespace

namespace {

struct WindowSearch {
    DWORD pid;
    HWND result;
    LONG bestArea;
};

BOOL CALLBACK FindWindowCallback(HWND window, LPARAM parameter) {
    auto* search = reinterpret_cast<WindowSearch*>(parameter);
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid != search->pid || GetWindow(window, GW_OWNER) || !IsWindowVisible(window)) return TRUE;
    RECT rect{};
    if (!GetClientRect(window, &rect)) return TRUE;
    const LONG area = (rect.right - rect.left) * (rect.bottom - rect.top);
    if (area > search->bestArea) {
        search->bestArea = area;
        search->result = window;
    }
    return TRUE;
}

HWND GameWindow() {
    static HWND cached = nullptr;
    DWORD pid = 0;
    if (cached && IsWindow(cached)) {
        GetWindowThreadProcessId(cached, &pid);
        if (pid == GetCurrentProcessId()) return cached;
    }
    WindowSearch search{GetCurrentProcessId(), nullptr, 0};
    EnumWindows(FindWindowCallback, reinterpret_cast<LPARAM>(&search));
    cached = search.result;
    return cached;
}

constexpr bool ManagedClientSize(int width, int height) {
    return width == pvz::kManagedClientWidth && height == pvz::kManagedClientHeight;
}

constexpr bool ManagedLogicalPoint(int x, int y) {
    return x >= 0 && x < pvz::kManagedClientWidth &&
           y >= 0 && y < pvz::kManagedClientHeight;
}

static_assert(ManagedClientSize(800, 600) &&
              !ManagedClientSize(531, 387) &&
              !ManagedClientSize(800, 599) &&
              !ManagedClientSize(801, 600));
static_assert(ManagedLogicalPoint(0, 0) && ManagedLogicalPoint(799, 599) &&
              !ManagedLogicalPoint(-1, 0) && !ManagedLogicalPoint(800, 599) &&
              !ManagedLogicalPoint(799, 600));

bool HasManagedClientSize(HWND window) {
    RECT client{};
    return AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window),
                                        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) &&
           GetClientRect(window, &client) &&
           ManagedClientSize(client.right - client.left, client.bottom - client.top);
}

bool PostGameMessage(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    const bool posted = PostMessageW(window, message, wParam, lParam) != FALSE;
    if (posted) g_inputPosted = true;
    return posted;
}

bool PostKey(HWND window, WPARAM key) {
    return PostGameMessage(window, WM_KEYDOWN, key, 1) &&
           PostGameMessage(window, WM_KEYUP, key, 0xC0000001);
}

bool Utf8ToWide(const std::string& value, std::wstring& output) {
    if (value.empty()) return false;
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0) return false;
    output.assign(static_cast<size_t>(required), L'\0');
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                               static_cast<int>(value.size()), output.data(), required) == required;
}

bool PostLogicalMouse(HWND window, InternalMouseAction action, int logicalX, int logicalY) {
    if (!HasManagedClientSize(window) || !ManagedLogicalPoint(logicalX, logicalY)) return false;
    if (!EnsureInternalMouseDispatch(window)) return false;
    g_inputPosted = true;
    DWORD_PTR dispatchResult = static_cast<DWORD_PTR>(-1);
    const LRESULT delivered = SendMessageTimeoutW(
        window, kInternalMouseWindowMessage, static_cast<WPARAM>(action),
        MAKELPARAM(logicalX, logicalY), SMTO_ABORTIFHUNG | SMTO_BLOCK,
        kInternalMouseDispatchTimeoutMs, &dispatchResult);
    return delivered != 0 && dispatchResult == 0;
}

bool ActionCurrent(ULONGLONG epoch) {
    return g_actionEpoch.load() == epoch &&
           (!g_stopEvent || WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0);
}

bool WaitForActionDelay(ULONGLONG epoch, DWORD milliseconds) {
    if (!ActionCurrent(epoch)) return false;
    if (milliseconds) {
        if (g_stopEvent) {
            if (WaitForSingleObject(g_stopEvent, milliseconds) == WAIT_OBJECT_0) return false;
        } else {
            Sleep(milliseconds);
        }
    }
    return ActionCurrent(epoch);
}

uint32_t NextCursorNoise() {
    thread_local uint32_t state = 0;
    if (!state) {
        const ULONGLONG tick = GetTickCount64();
        state = static_cast<uint32_t>(tick ^ (tick >> 32) ^ GetCurrentThreadId() ^ 0x9E3779B9U);
    }
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}

int CursorNoiseRange(int minimum, int maximum) {
    const uint32_t span = static_cast<uint32_t>(maximum - minimum + 1);
    return minimum + static_cast<int>(NextCursorNoise() % span);
}

constexpr double MinimumJerk(double t) {
    return t * t * t * (10.0 + t * (-15.0 + 6.0 * t));
}

static_assert(MinimumJerk(0.0) == 0.0 && MinimumJerk(0.5) == 0.5 &&
              MinimumJerk(1.0) == 1.0);

constexpr double AsymmetricMotorProgress(double t, double skew) {
    const double base = MinimumJerk(t);
    return base + skew * base * (1.0 - base);
}

static_assert(AsymmetricMotorProgress(0.0, 0.2) == 0.0 &&
              AsymmetricMotorProgress(0.5, 0.2) > 0.5 &&
              AsymmetricMotorProgress(1.0, 0.2) == 1.0);

constexpr double kCursorMaximumLogicalPixelsPerMs = 2.0;
constexpr DWORD kCursorMinimumMotorMs = 36;
constexpr double kCursorPi = 3.14159265358979323846;

DWORD CursorMovementDuration(double distance, double targetWidth,
                             double remainingRoute) {
    if (distance < 0.5) return 0;
    const DWORD minimum = g_cursorMinMs.load();
    const DWORD maximum = std::max(g_cursorMaxMs.load(), minimum);
    const double effectiveWidth = std::clamp(targetWidth, 8.0, 160.0);
    const double indexOfDifficulty = std::log2(1.0 + distance / effectiveWidth);
    const double maximumIndex = std::log2(1.0 + 1000.0 / 8.0);
    const double difficultyWeight = std::clamp(indexOfDifficulty / maximumIndex, 0.0, 1.0);
    const int span = static_cast<int>(maximum - minimum);
    const int nominal = static_cast<int>(minimum) +
        static_cast<int>(std::lround(span * (0.18 + difficultyWeight * 0.82)));
    const int jitter = std::max(1, span / 14);
    const double fittsDuration = std::clamp(
        nominal + CursorNoiseRange(-jitter, jitter),
        static_cast<int>(minimum), static_cast<int>(maximum));

    const double route = std::max(remainingRoute, distance);
    const double tail = std::max(0.0, route - distance);
    const double logarithmicShare =
        (std::log1p(route) - std::log1p(tail)) / std::log1p(distance);
    const double compressedDuration = fittsDuration * logarithmicShare;
    const double speedFloor = std::ceil(distance / kCursorMaximumLogicalPixelsPerMs);
    return static_cast<DWORD>(std::ceil(std::max({
        static_cast<double>(kCursorMinimumMotorMs), speedFloor, compressedDuration})));
}

constexpr ULONGLONG kWhackEffectVerifyMs = 120;
constexpr DWORD kWhackReactionMinMs = 105;
constexpr DWORD kWhackReactionMaxMs = 160;

bool MoveCursorLeg(HWND window, int startX, int startY, int endX, int endY,
                   double bend, double perturbation, double perturbationPhase,
                   double timeSkew, int steps, DWORD duration, ULONGLONG epoch,
                   CursorOverlayState state, ULONGLONG deadline = 0) {
    const double dx = static_cast<double>(endX - startX);
    const double dy = static_cast<double>(endY - startY);
    const double distance = std::sqrt(dx * dx + dy * dy);
    const double perpendicularX = distance > 0.0 ? -dy / distance : 0.0;
    const double perpendicularY = distance > 0.0 ? dx / distance : 0.0;
    const double control1X = startX + dx * 0.31 + perpendicularX * bend * 0.72;
    const double control1Y = startY + dy * 0.31 + perpendicularY * bend * 0.72;
    const double control2X = startX + dx * 0.74 + perpendicularX * bend;
    const double control2Y = startY + dy * 0.74 + perpendicularY * bend;
    SetCursorOverlayState(state);
    DWORD elapsed = 0;
    int previousX = startX;
    int previousY = startY;
    for (int step = 1; step <= steps; ++step) {
        if (!ActionCurrent(epoch) || (deadline && GetTickCount64() >= deadline)) return false;
        const double u = static_cast<double>(step) / steps;
        const double t = AsymmetricMotorProgress(u, timeSkew);
        const double oneMinus = 1.0 - t;
        double xPosition =
            oneMinus * oneMinus * oneMinus * startX +
            3.0 * oneMinus * oneMinus * t * control1X +
            3.0 * oneMinus * t * t * control2X + t * t * t * endX;
        double yPosition =
            oneMinus * oneMinus * oneMinus * startY +
            3.0 * oneMinus * oneMinus * t * control1Y +
            3.0 * oneMinus * t * t * control2Y + t * t * t * endY;
        const double taper = std::sin(kCursorPi * u);
        const double correlated =
            std::sin(2.0 * kCursorPi * u + perturbationPhase) +
            0.35 * std::sin(4.0 * kCursorPi * u + perturbationPhase * 0.63);
        const double offset = perturbation * taper * correlated / 1.35;
        xPosition += perpendicularX * offset;
        yPosition += perpendicularY * offset;
        int x = static_cast<int>(std::lround(xPosition));
        int y = static_cast<int>(std::lround(yPosition));
        if (step == steps) {
            x = endX;
            y = endY;
        }
        x = std::clamp(x, 0, pvz::kManagedClientWidth - 1);
        y = std::clamp(y, 0, pvz::kManagedClientHeight - 1);
        const DWORD nextElapsed = duration * static_cast<DWORD>(step) /
                                  static_cast<DWORD>(steps);
        const DWORD delay = nextElapsed - elapsed;
        elapsed = nextElapsed;
        if ((x != previousX || y != previousY || step == steps) &&
            !PostLogicalMouse(window, InternalMouseAction::Move, x, y)) return false;
        previousX = x;
        previousY = y;
        g_cursorX.store(x);
        g_cursorY.store(y);
        if (!WaitForActionDelay(epoch, delay)) return false;
    }
    return true;
}

bool MoveInternalCursor(HWND window, int targetX, int targetY, ULONGLONG epoch,
                        bool buttonHeld = false, double targetWidth = 24.0,
                        double remainingRoute = 0.0, ULONGLONG deadline = 0) {
    targetX = std::clamp(targetX, 0, pvz::kManagedClientWidth - 1);
    targetY = std::clamp(targetY, 0, pvz::kManagedClientHeight - 1);
    int startX = g_cursorX.load();
    int startY = g_cursorY.load();
    if (!buttonHeld) ReadInternalCursorPoint(startX, startY);
    const double dx = static_cast<double>(targetX - startX);
    const double dy = static_cast<double>(targetY - startY);
    const double distance = std::sqrt(dx * dx + dy * dy);
    const double perpendicularX = distance > 0 ? -dy / distance : 0.0;
    const double perpendicularY = distance > 0 ? dx / distance : 0.0;
    const double bendScale = CursorNoiseRange(65, 115) / 100.0;
    const double bend = std::min(distance * 0.07, 26.0) * bendScale *
                        (CursorNoiseRange(0, 1) ? 1.0 : -1.0);
    int approachX = targetX;
    int approachY = targetY;
    if (distance >= 72.0 && CursorNoiseRange(0, 99) < 22) {
        const int overshoot = CursorNoiseRange(
            2, std::clamp(static_cast<int>(distance / 80.0) + 2, 2, 7));
        const int lateral = CursorNoiseRange(-2, 2);
        approachX = std::clamp(static_cast<int>(std::lround(
            targetX + dx / distance * overshoot + perpendicularX * lateral)),
            0, pvz::kManagedClientWidth - 1);
        approachY = std::clamp(static_cast<int>(std::lround(
            targetY + dy / distance * overshoot + perpendicularY * lateral)),
            0, pvz::kManagedClientHeight - 1);
    }
    const bool correction = approachX != targetX || approachY != targetY;
    const double approachDx = static_cast<double>(approachX - startX);
    const double approachDy = static_cast<double>(approachY - startY);
    const double correctionDx = static_cast<double>(targetX - approachX);
    const double correctionDy = static_cast<double>(targetY - approachY);
    const double approachDistance = std::sqrt(
        approachDx * approachDx + approachDy * approachDy);
    const double correctionDistance = std::sqrt(
        correctionDx * correctionDx + correctionDy * correctionDy);
    const double plannedDistance = approachDistance + correctionDistance;
    const DWORD duration = CursorMovementDuration(
        plannedDistance, targetWidth,
        remainingRoute > 0.0 ? remainingRoute + plannedDistance - distance : 0.0);
    const DWORD approachDuration = correction
        ? duration * static_cast<DWORD>(CursorNoiseRange(80, 88)) / 100
        : duration;
    const int approachSteps = std::clamp(
        static_cast<int>(approachDuration / 9) + 5, 5, 60);
    const CursorOverlayState movingState = buttonHeld
        ? CursorOverlayState::Dragging : CursorOverlayState::Moving;
    const double perturbation = std::min(6.0, 1.0 + plannedDistance * 0.012) *
        CursorNoiseRange(60, 115) / 100.0;
    const double phase = CursorNoiseRange(0, 628) / 100.0;
    const double timeSkew = CursorNoiseRange(12, 26) / 100.0;
    if (!MoveCursorLeg(window, startX, startY, approachX, approachY, bend,
                       perturbation, phase, timeSkew, approachSteps,
                       approachDuration, epoch, movingState, deadline)) return false;
    if (correction) {
        const int correctionSteps = std::clamp(
            static_cast<int>(std::ceil(correctionDistance)) + 2, 3, 8);
        if (!MoveCursorLeg(window, approachX, approachY, targetX, targetY,
                           -bend * 0.08, std::min(1.5, perturbation * 0.25),
                           phase + 1.7, timeSkew * 0.45, correctionSteps,
                           duration - approachDuration, epoch, movingState, deadline)) return false;
    }
    SetCursorOverlayState(buttonHeld ? CursorOverlayState::Dragging
                                     : CursorOverlayState::Hover);
    return ActionCurrent(epoch) && g_cursorX.load() == targetX && g_cursorY.load() == targetY;
}

template <typename Validator>
bool ClickValidated(HWND window, int x, int y, ULONGLONG epoch, Validator&& validate,
                     ULONGLONG deadline = 0) {
    if (!MoveInternalCursor(window, x, y, epoch, false, 24.0, 0.0, deadline) ||
        !ActionCurrent(epoch)) return false;
    if (!WaitForActionDelay(epoch, static_cast<DWORD>(CursorNoiseRange(38, 72))) ||
        !std::forward<Validator>(validate)()) return false;
    SetCursorOverlayState(CursorOverlayState::Pressed);
    g_cursorOverlayButtonDown.store(true);
    if (!PostLogicalMouse(window, InternalMouseAction::LeftDown, x, y)) {
        g_cursorOverlayButtonDown.store(false);
        SetCursorOverlayState(CursorOverlayState::Hover);
        return false;
    }
    if (!WaitForActionDelay(epoch, static_cast<DWORD>(CursorNoiseRange(26, 46)))) {
        PostLogicalMouse(window, InternalMouseAction::LeftUp, x, y);
        g_cursorOverlayButtonDown.store(false);
        SetCursorOverlayState(CursorOverlayState::Released);
        return false;
    }
    const bool released = PostLogicalMouse(window, InternalMouseAction::LeftUp, x, y);
    g_cursorOverlayButtonDown.store(false);
    SetCursorOverlayState(CursorOverlayState::Released);
    return released && WaitForActionDelay(
        epoch, static_cast<DWORD>(CursorNoiseRange(55, 90)));
}

bool Click(HWND window, int x, int y, ULONGLONG epoch) {
    return ClickValidated(window, x, y, epoch, [] { return true; });
}

bool Drag(HWND window, int fromX, int fromY, int toX, int toY, ULONGLONG epoch) {
    if (!MoveInternalCursor(window, fromX, fromY, epoch) || !ActionCurrent(epoch)) return false;
    if (!WaitForActionDelay(epoch, static_cast<DWORD>(CursorNoiseRange(38, 68)))) return false;
    SetCursorOverlayState(CursorOverlayState::Pressed);
    g_cursorOverlayButtonDown.store(true);
    if (!PostLogicalMouse(window, InternalMouseAction::LeftDown, fromX, fromY)) {
        g_cursorOverlayButtonDown.store(false);
        SetCursorOverlayState(CursorOverlayState::Hover);
        return false;
    }
    const bool gripSettled = WaitForActionDelay(
        epoch, static_cast<DWORD>(CursorNoiseRange(22, 40)));
    const bool ok = gripSettled && MoveInternalCursor(window, toX, toY, epoch, true);
    const int lastX = g_cursorX.load();
    const int lastY = g_cursorY.load();
    const bool released = PostLogicalMouse(window, InternalMouseAction::LeftUp,
                                           lastX, lastY) != FALSE;
    g_cursorOverlayButtonDown.store(false);
    SetCursorOverlayState(CursorOverlayState::Released);
    return released && ok && WaitForActionDelay(
        epoch, static_cast<DWORD>(CursorNoiseRange(55, 90)));
}

bool RightClick(HWND window) {
    const int x = g_cursorX.load();
    const int y = g_cursorY.load();
    SetCursorOverlayState(CursorOverlayState::Pressed);
    const bool pressed = PostLogicalMouse(window, InternalMouseAction::RightDown, x, y);
    const bool released = PostLogicalMouse(window, InternalMouseAction::RightUp, x, y);
    SetCursorOverlayState(CursorOverlayState::Released);
    return pressed && released;
}

bool ReleaseHeldState() {
    HWND window = GameWindow();
    if (!window) return false;
    const int x = g_cursorX.load();
    const int y = g_cursorY.load();
    PostLogicalMouse(window, InternalMouseAction::LeftUp, x, y);
    g_cursorOverlayButtonDown.store(false);
    SetCursorOverlayState(CursorOverlayState::Released);
    return RightClick(window);
}

void ReleaseHeldIfRequested() {
    if (!g_releaseHeldRequested.exchange(false)) return;
    if (!ReleaseHeldState()) g_releaseHeldRequested.store(true);
}

bool LiveBoard(uintptr_t& lawnApp, uintptr_t& board, int& mode, int& background,
               int& rows, std::string& reason, bool allowDark,
               bool allowShovelTutorial) {
    if (!ReadLawnApp(lawnApp, &reason)) return false;
    if (!SafeRead(lawnApp + pvz::app::board, board) || !board) {
        reason = "board is not active";
        return false;
    }

    int scene = 0;
    mode = 0;
    SafeRead(lawnApp + pvz::app::gameScene, scene);
    SafeRead(lawnApp + pvz::app::gameMode, mode);
    const SemanticBoardGate gate = ReadSemanticBoardGate(
        lawnApp, scene, mode, board);
    const bool visibleBoard = std::strcmp(
        DetermineScreen(lawnApp, scene, gate), "board") == 0;
    const bool gameplay = scene == 3 && gate.gameplay && gate.address == board;
    const bool shovelTutorial = allowShovelTutorial && scene == 2 &&
                                gate.shovelTutorial && gate.address == board;
    if (!visibleBoard || (!gameplay && !shovelTutorial)) {
        reason = "board input is unavailable while another screen is active";
        return false;
    }
    background = 0;
    SafeRead(board + pvz::board::background, background);
    int level = 0;
    int challengeState = -1;
    int challengeCounter = 0;
    uintptr_t challenge = 0;
    SafeRead(board + pvz::board::level, level);
    if (SafeRead(board + pvz::board::challenge, challenge) && challenge) {
        SafeRead(challenge + 0x54, challengeState);
        SafeRead(challenge + 0x58, challengeCounter);
    }
    if (!allowDark && !StormAllowsBoardDisclosure(mode, level, challengeState, challengeCounter)) {
        reason = "board input is unavailable during the dark storm phase";
        return false;
    }
    rows = (background == 2 || background == 3) ? 6 : 5;
    return true;
}

bool ValidCell(const Command& command, int rows, bool destination = false) {
    const int row = destination ? command.toRow : command.row;
    const int column = destination ? command.toColumn : command.column;
    return row >= 1 && row <= rows && column >= 1 && column <= 9;
}

bool SlotPacketsSettled(uintptr_t board, uintptr_t& bank, int& packetCount) {
    if (!SafeRead(board + pvz::board::seedBank, bank) || !bank ||
        !SafeRead(bank + pvz::seedBank::packetCount, packetCount) ||
        packetCount < 3 || packetCount > 10) return false;
    for (int slot = 0; slot < 3; ++slot) {
        int countdown = -1;
        const uintptr_t packet = bank + pvz::seedBank::packets +
            static_cast<uintptr_t>(slot) * pvz::seedBank::packetStride;
        if (!SafeRead(packet + 0x3C, countdown) || countdown != 0) return false;
    }
    return true;
}

bool LastStandButtonReady(uintptr_t board, uintptr_t& button) {
    uint8_t disabled = 1;
    uint8_t noDraw = 1;
    int width = 0;
    int height = 0;
    return SafeRead(board + pvz::board::storeButton, button) && button &&
           SafeRead(button + pvz::widget::disabled, disabled) &&
           SafeRead(button + pvz::widget::noDraw, noDraw) &&
           SafeRead(button + pvz::widget::gameButtonWidth, width) &&
           SafeRead(button + pvz::widget::gameButtonHeight, height) &&
           width > 0 && height > 0 && width <= 800 && height <= 600 && !disabled && !noDraw;
}

struct RawCardState {
    bool present = false;
    uintptr_t bank = 0;
    int packetCount = 0;
    int slot = -1;
    int offsetX = 0;
    int type = -1;
    int imitater = -1;
    int timesUsed = 0;
    bool active = false;
    bool refreshing = false;
};

bool ReadRawCardState(uintptr_t board, int slot, RawCardState& state) {
    state = {};
    state.slot = slot;
    if (!SafeRead(board + pvz::board::seedBank, state.bank) || !state.bank ||
        !SafeRead(state.bank + pvz::seedBank::packetCount, state.packetCount) ||
        state.packetCount < 0 || state.packetCount > 10 || slot < 0 ||
        slot >= state.packetCount) return false;
    const uintptr_t packet = state.bank + pvz::seedBank::packets +
        static_cast<uintptr_t>(slot) * pvz::seedBank::packetStride;
    uint8_t active = 0;
    uint8_t refreshing = 0;
    if (!SafeRead(packet + 0x30, state.offsetX) ||
        !SafeRead(packet + 0x34, state.type) ||
        !SafeRead(packet + 0x38, state.imitater) ||
        !SafeRead(packet + 0x4C, state.timesUsed) ||
        !SafeRead(packet + 0x48, active) ||
        !SafeRead(packet + 0x49, refreshing)) return false;
    state.active = active != 0;
    state.refreshing = refreshing != 0;
    state.present = state.type >= 0;
    return true;
}

constexpr bool RawCardConsumed(bool conveyor, int beforeType, int beforeImitater,
                               int beforeTimesUsed, int beforeOffset,
                               bool afterPresent, int afterType, int afterImitater,
                               int afterTimesUsed, int afterOffset, bool afterRefreshing) {
    if (!afterPresent) return true;
    if (conveyor) {
        return afterType != beforeType || afterImitater != beforeImitater ||
               afterOffset > beforeOffset;
    }
    return afterTimesUsed > beforeTimesUsed || afterRefreshing;
}

constexpr bool PlantCursorReleased(bool whackLevel, int cursorType) {
    return cursorType == 0 || (whackLevel && cursorType == 7);
}

static_assert(RawCardConsumed(false, 0, -1, 2, 0, true, 0, -1, 3, 0, false) &&
              RawCardConsumed(false, 0, -1, 2, 0, true, 0, -1, 2, 0, true) &&
              !RawCardConsumed(false, 0, -1, 2, 0, true, 0, -1, 2, 0, false) &&
              RawCardConsumed(true, 0, -1, 0, 0, true, 0, -1, 0, 51, false) &&
              RawCardConsumed(true, 0, -1, 0, 0, true, 1, -1, 0, 0, false) &&
              !RawCardConsumed(true, 0, -1, 0, 10, true, 0, -1, 0, 9, false));
static_assert(PlantCursorReleased(false, 0) &&
              PlantCursorReleased(true, 7) &&
              !PlantCursorReleased(false, 7) &&
              !PlantCursorReleased(true, 1));

bool BeghouledSettled(uintptr_t lawnApp, int mode, BoardView& board) {
    if (!ReadBoard(lawnApp, mode, board) || board.challengeState != 0 ||
        board.challengeMouseCapture != 0) return false;
    if (g_stopEvent && WaitForSingleObject(g_stopEvent, 50) == WAIT_OBJECT_0) return false;
    BoardView second;
    if (!ReadBoard(lawnApp, mode, second) || second.challengeState != 0 ||
        second.challengeMouseCapture != 0 || second.address != board.address) return false;
    board = std::move(second);
    return true;
}

enum class CollectibleLookup { Found, Missing, BoardChanged, Unavailable };

CollectibleLookup CurrentCollectible(uintptr_t lawnApp, uintptr_t expectedBoard,
                                     int expectedMode, int initialCounter, uint32_t publicId,
                                     BoardView& current, CollectibleView& target) {
    int scene = -1;
    int mode = -1;
    uintptr_t board = 0;
    if (!SafeRead(lawnApp + pvz::app::gameScene, scene) ||
        !SafeRead(lawnApp + pvz::app::gameMode, mode) ||
        !SafeRead(lawnApp + pvz::app::board, board) || !board) {
        return CollectibleLookup::Unavailable;
    }
    if (scene != 3 || mode != expectedMode || board != expectedBoard ||
        std::strcmp(DetermineScreen(lawnApp, scene, board), "board") != 0) {
        return CollectibleLookup::BoardChanged;
    }
    if (!ReadBoard(lawnApp, mode, current) || current.address != expectedBoard ||
        !SameBoardCounterRun(current.mainCounter, initialCounter) || current.paused ||
        !current.entitiesVisible) {
        return CollectibleLookup::BoardChanged;
    }
    const auto found = std::find_if(current.collectibles.begin(), current.collectibles.end(),
        [&](const CollectibleView& value) { return value.id == publicId; });
    if (found == current.collectibles.end()) return CollectibleLookup::Missing;
    target = *found;
    return CollectibleLookup::Found;
}

struct RawCollectibleState {
    bool present = false;
    bool dead = false;
    bool beingCollected = false;
    int type = -1;
    int containedType = -1;
};

enum class CollectBoardRelation { Unreadable, SameRun, Departed };

constexpr CollectBoardRelation ClassifyCollectBoard(
        bool boardReadable, uintptr_t currentBoard, uintptr_t expectedBoard,
        bool counterReadable, int currentCounter, int initialCounter,
        bool generationChanged) {
    if (!boardReadable) return CollectBoardRelation::Unreadable;
    if (currentBoard != expectedBoard || generationChanged) {
        return CollectBoardRelation::Departed;
    }
    if (!counterReadable) return CollectBoardRelation::Unreadable;
    return SameBoardCounterRun(currentCounter, initialCounter)
        ? CollectBoardRelation::SameRun : CollectBoardRelation::Departed;
}

constexpr bool MayUseTerminalCollectEvidence(CollectBoardRelation relation,
                                             bool lastItem, bool screenAllowed) {
    return relation == CollectBoardRelation::Departed && lastItem && screenAllowed;
}

static_assert(ClassifyCollectBoard(true, 0x1000, 0x1000, true, 10, 10, false) ==
                  CollectBoardRelation::SameRun &&
              ClassifyCollectBoard(true, 0x1000, 0x1000, true, 11, 10, false) ==
                  CollectBoardRelation::SameRun &&
              ClassifyCollectBoard(true, 0, 0x1000, false, 0, 10, false) ==
                  CollectBoardRelation::Departed &&
              ClassifyCollectBoard(true, 0x2000, 0x1000, false, 0, 10, false) ==
                  CollectBoardRelation::Departed &&
              ClassifyCollectBoard(true, 0x1000, 0x1000, true, 9, 10, false) ==
                  CollectBoardRelation::Departed &&
              ClassifyCollectBoard(true, 0x1000, 0x1000, true, 10, 10, true) ==
                  CollectBoardRelation::Departed &&
              ClassifyCollectBoard(false, 0, 0x1000, false, 0, 10, false) ==
                  CollectBoardRelation::Unreadable &&
              ClassifyCollectBoard(true, 0x1000, 0x1000, false, 0, 10, false) ==
                  CollectBoardRelation::Unreadable);
static_assert(!MayUseTerminalCollectEvidence(
                  CollectBoardRelation::SameRun, true, true) &&
              MayUseTerminalCollectEvidence(
                  CollectBoardRelation::Departed, true, true) &&
              !MayUseTerminalCollectEvidence(
                  CollectBoardRelation::Departed, false, true) &&
              !MayUseTerminalCollectEvidence(
                  CollectBoardRelation::Departed, true, false));

bool ReadRawCollectibleState(uintptr_t board, uint32_t rawId, RawCollectibleState& state) {
    state = {};
    ArrayHeader header{};
    if (!SafeRead(board + pvz::board::coins, header) || !header.block ||
        header.maxSize > 1024 || header.maxUsedCount > header.maxSize ||
        header.size > header.maxSize) return false;
    const uint32_t index = rawId & 0xFFFFU;
    if (index >= header.maxUsedCount) return true;
    std::array<uint8_t, 0x200> item{};
    const uintptr_t address = header.block +
        static_cast<uintptr_t>(index) * pvz::dataArray::coinStride;
    if (!SafeCopy(item.data(), address, pvz::dataArray::coinStride)) return false;
    if (Field<uint32_t>(item, pvz::dataArray::coinObjectSize) != rawId) return true;
    state.present = true;
    state.dead = Field<uint8_t>(item, 0x38) != 0;
    state.beingCollected = Field<uint8_t>(item, 0x50) != 0;
    state.type = Field<int>(item, 0x58);
    state.containedType = Field<int>(item, 0x68);
    return true;
}

bool CollectTransitionScreen(const char* screen) {
    return std::strcmp(screen, "award") == 0 ||
           std::strcmp(screen, "mode_selector") == 0 ||
           std::strcmp(screen, "seed_picker") == 0 ||
           std::strcmp(screen, "main_menu") == 0 ||
           std::strcmp(screen, "credits") == 0 ||
           std::strcmp(screen, "dialog") == 0;
}

uint64_t TrackedRunId(const BoardView& board, int mode) {
    uint64_t runId = 0;
    AcquireSRWLockShared(&g_semanticSendLock);
    if (ValidRunIdentity(mode, board.level) && g_activeRun.valid &&
        g_activeRun.boardAddress == board.address &&
        g_activeRun.mode == mode &&
        g_activeRun.level == board.level) {
        runId = g_activeRun.runId;
    }
    ReleaseSRWLockShared(&g_semanticSendLock);
    return runId;
}

#include "relative_plant.h"

bool CollectRunGenerationChanged(uint64_t expectedRunId, uintptr_t currentBoard) {
    bool changed = false;
    AcquireSRWLockShared(&g_semanticSendLock);
    if (expectedRunId && g_activeRun.valid &&
        g_activeRun.boardAddress == currentBoard &&
        g_activeRun.runId != expectedRunId) {
        changed = true;
    }
    ReleaseSRWLockShared(&g_semanticSendLock);
    return changed;
}

bool LegalCollectTransition(uintptr_t lawnApp, uint64_t expectedRunId,
                            uintptr_t expectedBoard, int initialCounter) {
    int scene = -1;
    uintptr_t board = 0;
    if (!SafeRead(lawnApp + pvz::app::gameScene, scene) ||
        !SafeRead(lawnApp + pvz::app::board, board)) return false;
    int counter = 0;
    const bool counterReadable = board == expectedBoard &&
        SafeRead(board + pvz::board::mainCounter, counter);
    const bool generationChanged = board == expectedBoard &&
        CollectRunGenerationChanged(expectedRunId, board);
    if (ClassifyCollectBoard(true, board, expectedBoard, counterReadable, counter,
                             initialCounter, generationChanged) !=
            CollectBoardRelation::Departed) return false;
    const char* screen = DetermineScreen(lawnApp, scene, board);
    if (!expectedRunId || !CollectTransitionScreen(screen)) return false;
    AcquireSRWLockShared(&g_semanticSendLock);
    const bool won = g_lastRun.present && g_lastRun.runId == expectedRunId &&
                     g_lastRun.outcome == pvz::result::won;
    ReleaseSRWLockShared(&g_semanticSendLock);
    return won;
}

bool PressCurrentCollectible(HWND window, uintptr_t lawnApp, uintptr_t expectedBoard,
                             int expectedMode, int initialCounter, uint32_t publicId,
                             ULONGLONG epoch, CollectibleView& clicked,
                             CollectibleLookup& failure, bool& clickStarted,
                             bool& observedDuringPress) {
    clickStarted = false;
    observedDuringPress = false;
    for (int attempt = 0; attempt < 4; ++attempt) {
        BoardView current;
        CollectibleView target{};
        failure = CurrentCollectible(lawnApp, expectedBoard, expectedMode, initialCounter,
                                     publicId, current, target);
        if (failure != CollectibleLookup::Found) return false;
        if (!MoveInternalCursor(window, target.x, target.y, epoch)) {
            failure = CollectibleLookup::Unavailable;
            return false;
        }

        BoardView verified;
        CollectibleView fresh{};
        failure = CurrentCollectible(lawnApp, expectedBoard, expectedMode, initialCounter,
                                     publicId, verified, fresh);
        if (failure != CollectibleLookup::Found) return false;
        const int drift = std::abs(fresh.x - target.x) + std::abs(fresh.y - target.y);
        if (drift > 12 && attempt < 3) continue;
        SetCursorOverlayState(CursorOverlayState::Moving);
        if (!ActionCurrent(epoch) ||
            !PostLogicalMouse(window, InternalMouseAction::Move, fresh.x, fresh.y)) {
            failure = CollectibleLookup::Unavailable;
            return false;
        }
        g_cursorX.store(fresh.x);
        g_cursorY.store(fresh.y);
        SetCursorOverlayState(CursorOverlayState::Hover);

        BoardView finalBoard;
        CollectibleView finalTarget{};
        failure = CurrentCollectible(lawnApp, expectedBoard, expectedMode, initialCounter,
                                     publicId, finalBoard, finalTarget);
        if (failure != CollectibleLookup::Found) return false;
        SetCursorOverlayState(CursorOverlayState::Moving);
        if (!PostLogicalMouse(window, InternalMouseAction::Move,
                              finalTarget.x, finalTarget.y)) {
            failure = CollectibleLookup::Unavailable;
            return false;
        }
        g_cursorX.store(finalTarget.x);
        g_cursorY.store(finalTarget.y);
        SetCursorOverlayState(CursorOverlayState::Pressed);
        g_cursorOverlayButtonDown.store(true);
        if (!PostLogicalMouse(window, InternalMouseAction::LeftDown,
                              finalTarget.x, finalTarget.y)) {
            g_cursorOverlayButtonDown.store(false);
            SetCursorOverlayState(CursorOverlayState::Hover);
            failure = CollectibleLookup::Unavailable;
            return false;
        }
        clickStarted = true;
        RawCollectibleState pressedState;
        observedDuringPress = ReadRawCollectibleState(
            finalBoard.address, finalTarget.rawId, pressedState) &&
            pressedState.present && !pressedState.dead && pressedState.beingCollected;
        if (!WaitForActionDelay(epoch, static_cast<DWORD>(CursorNoiseRange(26, 46)))) {
            PostLogicalMouse(window, InternalMouseAction::LeftUp,
                             finalTarget.x, finalTarget.y);
            g_cursorOverlayButtonDown.store(false);
            SetCursorOverlayState(CursorOverlayState::Released);
            failure = CollectibleLookup::Unavailable;
            return false;
        }
        if (!PostLogicalMouse(window, InternalMouseAction::LeftUp,
                              finalTarget.x, finalTarget.y)) {
            g_cursorOverlayButtonDown.store(false);
            SetCursorOverlayState(CursorOverlayState::Released);
            failure = CollectibleLookup::Unavailable;
            return false;
        }
        g_cursorOverlayButtonDown.store(false);
        SetCursorOverlayState(CursorOverlayState::Released);
        clicked = finalTarget;
        return true;
    }
    failure = CollectibleLookup::Unavailable;
    return false;
}

bool ReadSameBoard(uintptr_t lawnApp, uintptr_t expectedBoard, int expectedMode,
                   int initialCounter, BoardView& board) {
    int scene = -1;
    int mode = -1;
    uintptr_t address = 0;
    if (!SafeRead(lawnApp + pvz::app::gameScene, scene) ||
        !SafeRead(lawnApp + pvz::app::gameMode, mode) ||
        !SafeRead(lawnApp + pvz::app::board, address) || scene != 3 ||
        mode != expectedMode || address != expectedBoard ||
        std::strcmp(DetermineScreen(lawnApp, scene, address), "board") != 0 ||
        !ReadBoard(lawnApp, mode, board) || board.address != expectedBoard ||
        !SameBoardCounterRun(board.mainCounter, initialCounter) || board.paused) return false;
    return true;
}

enum class WhackTargetLookup {
    Found, Missing, Blocked, ScopeChanged, BoardChanged, Unavailable
};

WhackTargetLookup CurrentWhackTarget(uintptr_t lawnApp, uintptr_t expectedBoard,
                                     int expectedMode, int expectedLevel, int initialCounter,
                                     uint32_t publicId, BoardView& current,
                                     ZombieView& target) {
    if (!ReadSameBoard(lawnApp, expectedBoard, expectedMode, initialCounter, current)) {
        return WhackTargetLookup::BoardChanged;
    }
    if (current.level != expectedLevel) {
        return WhackTargetLookup::ScopeChanged;
    }
    if (!current.entitiesVisible || !IsWhackLevel(expectedMode, current.level)) {
        return WhackTargetLookup::BoardChanged;
    }
    const WhackTargetResolution resolution =
        ResolveWhackTargetStatus(current, publicId, target);
    if (resolution == WhackTargetResolution::Blocked) {
        return WhackTargetLookup::Blocked;
    }
    if (resolution != WhackTargetResolution::Found) {
        return WhackTargetLookup::Missing;
    }
    return WhackTargetLookup::Found;
}

double EstimateWhackRemainingRoute(const BoardView& board,
                                   const std::vector<int>& targetIds,
                                   size_t begin) {
    int x = g_cursorX.load();
    int y = g_cursorY.load();
    ReadInternalCursorPoint(x, y);
    double route = 0.0;
    for (size_t index = begin; index < targetIds.size(); ++index) {
        const auto target = std::find_if(board.zombies.begin(), board.zombies.end(),
            [&](const ZombieView& zombie) {
                return zombie.id == static_cast<uint32_t>(targetIds[index]) &&
                       zombie.whackPresented && ZombiePhaseAcceptsWhack(zombie.phase);
            });
        if (target == board.zombies.end()) continue;
        const double dx = static_cast<double>(target->hitX - x);
        const double dy = static_cast<double>(target->hitY - y);
        route += std::sqrt(dx * dx + dy * dy);
        x = target->hitX;
        y = target->hitY;
    }
    return route;
}

bool PressCurrentWhackTarget(HWND window, uintptr_t lawnApp, uintptr_t expectedBoard,
                             int expectedMode, int expectedLevel, int initialCounter,
                             uint32_t publicId,
                             double remainingRoute, ULONGLONG epoch, ZombieView& clicked,
                             WhackTargetLookup& failure, bool* attempted = nullptr,
                             bool* released = nullptr) {
    if (attempted) *attempted = false;
    if (released) *released = false;
    BoardView perceived;
    ZombieView perceivedTarget{};
    failure = CurrentWhackTarget(
        lawnApp, expectedBoard, expectedMode, expectedLevel, initialCounter,
        publicId, perceived, perceivedTarget);
    if (failure != WhackTargetLookup::Found) return false;
    if (!WaitForActionDelay(
            epoch, static_cast<DWORD>(CursorNoiseRange(
                kWhackReactionMinMs, kWhackReactionMaxMs)))) {
        failure = WhackTargetLookup::Unavailable;
        return false;
    }
    for (int attempt = 0; attempt < 4; ++attempt) {
        BoardView current;
        ZombieView target{};
        failure = CurrentWhackTarget(
            lawnApp, expectedBoard, expectedMode, expectedLevel, initialCounter,
            publicId, current, target);
        if (failure != WhackTargetLookup::Found) return false;
        const double targetWidth = std::max(
            1, std::min(target.hitWidth, target.hitHeight));
        if (!MoveInternalCursor(window, target.hitX, target.hitY, epoch, false,
                                targetWidth, remainingRoute) ||
            !WaitForActionDelay(epoch, static_cast<DWORD>(CursorNoiseRange(12, 24)))) {
            failure = WhackTargetLookup::Unavailable;
            return false;
        }

        BoardView verified;
        ZombieView fresh{};
        failure = CurrentWhackTarget(
            lawnApp, expectedBoard, expectedMode, expectedLevel, initialCounter,
            publicId, verified, fresh);
        if (failure != WhackTargetLookup::Found) return false;
        const int drift = std::abs(fresh.hitX - target.hitX) +
                          std::abs(fresh.hitY - target.hitY);
        if (drift > 24) continue;

        BoardView finalBoard;
        ZombieView finalTarget{};
        failure = CurrentWhackTarget(
            lawnApp, expectedBoard, expectedMode, expectedLevel, initialCounter,
            publicId, finalBoard, finalTarget);
        if (failure != WhackTargetLookup::Found) return false;
        SetCursorOverlayState(CursorOverlayState::Moving);
        if (!PostLogicalMouse(window, InternalMouseAction::Move,
                              finalTarget.hitX, finalTarget.hitY)) {
            failure = WhackTargetLookup::Unavailable;
            return false;
        }
        g_cursorX.store(finalTarget.hitX);
        g_cursorY.store(finalTarget.hitY);
        SetCursorOverlayState(CursorOverlayState::Pressed);
        g_cursorOverlayButtonDown.store(true);
        if (attempted) *attempted = true;
        if (!PostLogicalMouse(window, InternalMouseAction::LeftDown,
                              finalTarget.hitX, finalTarget.hitY)) {
            const bool recovered = PostLogicalMouse(
                window, InternalMouseAction::LeftUp,
                finalTarget.hitX, finalTarget.hitY) != FALSE;
            if (released) *released = recovered;
            g_cursorOverlayButtonDown.store(false);
            SetCursorOverlayState(CursorOverlayState::Hover);
            failure = WhackTargetLookup::Unavailable;
            return false;
        }
        if (!WaitForActionDelay(epoch, static_cast<DWORD>(CursorNoiseRange(24, 38)))) {
            const bool recovered = PostLogicalMouse(
                window, InternalMouseAction::LeftUp,
                finalTarget.hitX, finalTarget.hitY) != FALSE;
            if (released) *released = recovered;
            g_cursorOverlayButtonDown.store(false);
            SetCursorOverlayState(CursorOverlayState::Released);
            failure = WhackTargetLookup::Unavailable;
            return false;
        }
        const bool releaseConfirmed = PostLogicalMouse(
            window, InternalMouseAction::LeftUp,
            finalTarget.hitX, finalTarget.hitY) != FALSE;
        if (released) *released = releaseConfirmed;
        g_cursorOverlayButtonDown.store(false);
        SetCursorOverlayState(CursorOverlayState::Released);
        if (!releaseConfirmed || !WaitForActionDelay(
                epoch, static_cast<DWORD>(CursorNoiseRange(16, 30)))) {
            failure = WhackTargetLookup::Unavailable;
            return false;
        }
        clicked = finalTarget;
        return true;
    }
    failure = WhackTargetLookup::Unavailable;
    return false;
}

bool WakeZenToolbar(HWND window, uintptr_t lawnApp, uintptr_t board, int mode,
                    int initialCounter, ULONGLONG epoch, std::string& reason) {
    BoardView current;
    if (!ReadSameBoard(lawnApp, board, mode, initialCounter, current)) {
        reason = "Zen Garden board state became unavailable";
        return false;
    }
    if (current.challengeState != 8) return true;
    if (!MoveInternalCursor(window, 400, 560, epoch)) {
        reason = "failed to post the Zen toolbar wake input";
        return false;
    }
    const ULONGLONG deadline = GetTickCount64() + 1000;
    while (ActionCurrent(epoch) && GetTickCount64() < deadline) {
        if (ReadSameBoard(lawnApp, board, mode, initialCounter, current) &&
            current.challengeState != 8) return true;
        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
    }
    reason = "Zen toolbar did not become selectable after wake input";
    return false;
}

const PlantView* PlantForPottedIndex(const BoardView& board, int pottedIndex) {
    const auto found = std::find_if(board.plants.begin(), board.plants.end(),
        [&](const PlantView& plant) { return plant.pottedIndex == pottedIndex; });
    return found == board.plants.end() ? nullptr : &*found;
}

struct WateredPottedBaseline {
    int index;
    int seedType;
    int garden;
    int x;
    int y;
    int timesFed;
};

std::vector<WateredPottedBaseline> GoldWateringBaselines(
    const BoardView& board, const ZenProfileView& profile, int x, int y) {
    std::vector<WateredPottedBaseline> result;
    for (const auto& plant : board.plants) {
        const int centerX = plant.x + 40;
        const int centerY = plant.y + 40;
        if (centerX < x - 70 || centerX >= x + 90 ||
            centerY < y - 80 || centerY >= y + 80) continue;
        PottedPlantView potted;
        if (!ReadPottedPlant(board, plant, potted) ||
            !PottedMatchesPlant(potted, plant, profile.gardenType) ||
            !ZenCareVisible(ZenCareTool::Water, plant.state, plant.sleeping,
                            potted.age, potted.storedNeed, 0, 0, 0)) continue;
        result.push_back({potted.index, potted.seedType, potted.garden,
                          potted.x, potted.y, potted.timesFed});
    }
    return result;
}

bool ExecuteZenCareAction(const Command& command, HWND window, uintptr_t lawnApp,
                          const BoardView& initialBoard, int mode,
                          std::string& reason, bool apply) {
    ZenCareTool tool;
    if (mode != 43 || initialBoard.tutorialState != 0 || command.targetId < 0 ||
        !ParseZenCareTool(command.special, tool) || initialBoard.cursorType != 0 ||
        HasActiveZenTool(initialBoard)) {
        reason = "Zen care action is unavailable in the current garden state";
        return false;
    }
    ZenProfileView profile;
    PlantView plant{};
    PottedPlantView potted;
    if (!ReadZenProfile(lawnApp, true, false, profile) ||
        !CurrentZenCareTarget(initialBoard, profile, tool,
                              static_cast<uint32_t>(command.targetId), plant, potted)) {
        reason = "Zen care target no longer shows the requested need";
        return false;
    }
    if (!apply) return true;
    if (!WakeZenToolbar(window, lawnApp, initialBoard.address, mode,
                        initialBoard.mainCounter, command.epoch, reason)) return false;

    BoardView beforeSelection;
    if (!ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                       beforeSelection) || beforeSelection.cursorType != 0 ||
        HasActiveZenTool(beforeSelection) ||
        !ReadZenProfile(lawnApp, true, false, profile) ||
        !CurrentZenCareTarget(beforeSelection, profile, tool,
                              static_cast<uint32_t>(command.targetId), plant, potted)) {
        reason = "Zen care target changed before tool selection";
        return false;
    }
    const auto toolbar = ZenToolbarVisibility(
        mode, profile.purchases, profile.adventureCompletions > 0);
    const int toolX = ZenToolbarCenterX(ZenCareToolbarIndex(tool), toolbar);
    if (toolX < 0 || !Click(window, toolX, 36, command.epoch)) {
        reason = "failed to select the current Zen care tool";
        return false;
    }

    bool holdingTool = false;
    const int cursorType = ZenCareCursorType(tool);
    const ULONGLONG cursorDeadline = GetTickCount64() + 1000;
    while (ActionCurrent(command.epoch) && GetTickCount64() < cursorDeadline) {
        BoardView current;
        if (ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                          current) && current.cursorType == cursorType) {
            holdingTool = true;
            break;
        }
        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
    }
    if (!holdingTool) {
        reason = "selected Zen care tool did not enter the expected cursor state";
        return false;
    }

    BoardView beforeUse;
    ZenProfileView beforeProfile;
    PlantView livePlant{};
    PottedPlantView beforePotted;
    if (!ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                       beforeUse) || beforeUse.cursorType != cursorType ||
        HasActiveZenTool(beforeUse) ||
        !ReadZenProfile(lawnApp, true, false, beforeProfile) ||
        !CurrentZenCareTarget(beforeUse, beforeProfile, tool,
                              static_cast<uint32_t>(command.targetId),
                              livePlant, beforePotted)) {
        reason = "Zen care target changed after tool selection";
        return false;
    }
    const int purchaseBefore = ZenCarePurchase(beforeProfile, tool);
    const int targetX = livePlant.x + 40;
    const int targetY = livePlant.y + 40;
    const bool goldWatering = tool == ZenCareTool::Water &&
        beforeProfile.purchases[pvz::purchase::goldWateringCan] > 0;
    std::vector<WateredPottedBaseline> watered;
    if (goldWatering) watered = GoldWateringBaselines(beforeUse, beforeProfile, targetX, targetY);
    if (goldWatering && watered.empty()) {
        reason = "gold watering can has no current visible watering targets";
        return false;
    }
    if (!Click(window, targetX, targetY, command.epoch)) {
        reason = "failed to apply the Zen care tool to the current plant";
        return false;
    }

    const ULONGLONG effectDeadline = GetTickCount64() + 12000;
    while (ActionCurrent(command.epoch) && GetTickCount64() < effectDeadline) {
        BoardView current;
        ZenProfileView currentProfile;
        PottedPlantView currentPotted;
        if (ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                          current) && current.cursorType == 0 &&
            ReadZenProfile(lawnApp, true, false, currentProfile) &&
            currentProfile.gardenType == beforeProfile.gardenType &&
            ReadPottedPlantAt(lawnApp, beforePotted.index, currentPotted) &&
            currentPotted.seedType == beforePotted.seedType &&
            currentPotted.garden == beforePotted.garden &&
            currentPotted.x == beforePotted.x && currentPotted.y == beforePotted.y) {
            bool verified = false;
            if (tool == ZenCareTool::Water) {
                if (!goldWatering) {
                    verified = currentPotted.timesFed > beforePotted.timesFed;
                } else {
                    verified = std::all_of(watered.begin(), watered.end(),
                        [&](const WateredPottedBaseline& baseline) {
                            PottedPlantView updated;
                            return ReadPottedPlantAt(lawnApp, baseline.index, updated) &&
                                   updated.seedType == baseline.seedType &&
                                   updated.garden == baseline.garden &&
                                   updated.x == baseline.x && updated.y == baseline.y &&
                                   updated.timesFed > baseline.timesFed;
                        });
                }
            } else if (tool == ZenCareTool::Fertilize) {
                verified = currentProfile.purchases[pvz::purchase::fertilizer] ==
                               purchaseBefore - 1 &&
                           currentPotted.age == beforePotted.age + 1 &&
                           currentPotted.lastFertilized > beforePotted.lastFertilized;
            } else if (tool == ZenCareTool::BugSpray ||
                       tool == ZenCareTool::Phonograph) {
                const int currentPurchase = ZenCarePurchase(currentProfile, tool);
                const bool inventoryVerified = tool == ZenCareTool::BugSpray
                    ? currentPurchase == purchaseBefore - 1
                    : currentPurchase == purchaseBefore;
                const PlantView* currentPlant = PlantForPottedIndex(current, beforePotted.index);
                verified = inventoryVerified && currentPotted.storedNeed == 0 &&
                           currentPotted.lastNeedFulfilled >
                               beforePotted.lastNeedFulfilled &&
                           currentPlant && currentPlant->state == 45 &&
                           PottedMatchesPlant(currentPotted, *currentPlant,
                                              currentProfile.gardenType);
            } else if (tool == ZenCareTool::Chocolate) {
                verified = currentProfile.purchases[pvz::purchase::chocolate] ==
                               purchaseBefore - 1 &&
                           currentPotted.lastChocolate > beforePotted.lastChocolate;
            }
            if (verified) return true;
        }
        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
    }
    reason = "Zen care effect was not causally verified before timeout";
    return false;
}

bool ExecuteZenNextGarden(const Command& command, HWND window, uintptr_t lawnApp,
                          const BoardView& initialBoard, int mode,
                          std::string& reason, bool apply) {
    if ((mode != 43 && mode != 50) || initialBoard.cursorType != 0 ||
        (mode == 43 && initialBoard.tutorialState != 0) ||
        (mode == 50 && initialBoard.challengeState == 8)) {
        reason = "next garden is unavailable in the current state";
        return false;
    }
    ZenProfileView profile;
    if (!ReadZenProfile(lawnApp, mode == 43, false, profile)) {
        reason = "garden profile state is unavailable";
        return false;
    }
    int destination = NextGardenDestination(
        mode, profile.gardenType,
        profile.purchases[pvz::purchase::mushroomGarden] > 0,
        profile.purchases[pvz::purchase::aquariumGarden] > 0,
        profile.purchases[pvz::purchase::treeOfWisdom] > 0);
    if (destination < 0) {
        reason = "no purchased destination garden is available";
        return false;
    }
    if (!apply) return true;
    if (mode == 43 && !WakeZenToolbar(window, lawnApp, initialBoard.address, mode,
                                      initialBoard.mainCounter, command.epoch, reason)) {
        return false;
    }

    BoardView before;
    if (!ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter, before) ||
        before.cursorType != 0 || (mode == 50 && before.challengeState == 8) ||
        !ReadZenProfile(lawnApp, mode == 43, false, profile)) {
        reason = "garden state changed before navigation input";
        return false;
    }
    destination = NextGardenDestination(
        mode, profile.gardenType,
        profile.purchases[pvz::purchase::mushroomGarden] > 0,
        profile.purchases[pvz::purchase::aquariumGarden] > 0,
        profile.purchases[pvz::purchase::treeOfWisdom] > 0);
    if (destination < 0 || !Click(window, 599, 36, command.epoch)) {
        reason = destination < 0 ? "destination garden changed before input" :
                                  "failed to post next-garden input";
        return false;
    }

    const ULONGLONG deadline = GetTickCount64() + 6000;
    while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
        int scene = -1;
        int currentMode = -1;
        uintptr_t currentAddress = 0;
        if (SafeRead(lawnApp + pvz::app::gameScene, scene) &&
            SafeRead(lawnApp + pvz::app::gameMode, currentMode) &&
            SafeRead(lawnApp + pvz::app::board, currentAddress) && scene == 3 &&
            currentAddress &&
            std::strcmp(DetermineScreen(lawnApp, scene, currentAddress), "board") == 0) {
            BoardView current;
            ZenProfileView currentProfile;
            const bool expectedMode = destination == 50 ? currentMode == 50 : currentMode == 43;
            const bool expectedGarden = destination == 50 ||
                (ReadZenProfile(lawnApp, true, false, currentProfile) &&
                 currentProfile.gardenType == destination);
            if (expectedMode && expectedGarden && ReadBoard(lawnApp, currentMode, current) &&
                (currentMode != mode || current.address != before.address ||
                 current.background != before.background)) return true;
        }
        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 20) == WAIT_OBJECT_0) break;
    }
    reason = "next-garden input did not reach the expected public garden state";
    return false;
}

bool ExecuteTreeFeed(const Command& command, HWND window, uintptr_t lawnApp,
                     const BoardView& initialBoard, int mode,
                     std::string& reason, bool apply) {
    ZenProfileView profile;
    if (mode != 50 || initialBoard.cursorType != 0 || initialBoard.challengeState == 8 ||
        initialBoard.challengeState == 11 ||
        HasActiveZenTool(initialBoard) ||
        !ReadZenProfile(lawnApp, false, true, profile) ||
        ZenCharges(profile.purchases[pvz::purchase::treeFood]) <= 0) {
        reason = "Tree of Wisdom cannot currently accept tree food";
        return false;
    }
    if (!apply) return true;

    BoardView beforeSelection;
    if (!ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                       beforeSelection) || beforeSelection.cursorType != 0 ||
        beforeSelection.challengeState == 8 || beforeSelection.challengeState == 11 ||
        HasActiveZenTool(beforeSelection) ||
        !ReadZenProfile(lawnApp, false, true, profile) ||
        ZenCharges(profile.purchases[pvz::purchase::treeFood]) <= 0 ||
        !Click(window, 65, 36, command.epoch)) {
        reason = "failed to select currently available tree food";
        return false;
    }

    bool holdingFood = false;
    const ULONGLONG cursorDeadline = GetTickCount64() + 1000;
    while (ActionCurrent(command.epoch) && GetTickCount64() < cursorDeadline) {
        BoardView current;
        if (ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                          current) && current.cursorType == 17) {
            holdingFood = true;
            break;
        }
        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
    }
    if (!holdingFood) {
        reason = "tree food did not enter the expected cursor state";
        return false;
    }

    BoardView beforeUse;
    ZenProfileView beforeProfile;
    if (!ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                       beforeUse) || beforeUse.cursorType != 17 ||
        beforeUse.challengeState == 11 || HasActiveZenTool(beforeUse) ||
        !ReadZenProfile(lawnApp, false, true, beforeProfile) ||
        ZenCharges(beforeProfile.purchases[pvz::purchase::treeFood]) <= 0) {
        reason = "Tree of Wisdom state changed after selecting tree food";
        return false;
    }
    if (!Click(window, 400, 300, command.epoch)) {
        reason = "failed to apply tree food to the visible tree";
        return false;
    }

    bool sawTool = false;
    uint32_t toolId = 0;
    const int purchaseBefore = beforeProfile.purchases[pvz::purchase::treeFood];
    const int heightBefore = beforeProfile.treeHeight;
    const ULONGLONG deadline = GetTickCount64() + 12000;
    while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
        BoardView current;
        ZenProfileView currentProfile;
        if (ReadSameBoard(lawnApp, initialBoard.address, mode, initialBoard.mainCounter,
                          current) && ReadZenProfile(lawnApp, false, true, currentProfile)) {
            if (!sawTool) {
                const auto tool = std::find_if(current.gridItems.begin(), current.gridItems.end(),
                    [](const GridItemView& item) { return item.type == 9; });
                if (tool != current.gridItems.end() && current.cursorType == 0 &&
                    currentProfile.purchases[pvz::purchase::treeFood] == purchaseBefore - 1) {
                    sawTool = true;
                    toolId = tool->id;
                }
            } else {
                const bool sameToolPresent = std::any_of(
                    current.gridItems.begin(), current.gridItems.end(),
                    [&](const GridItemView& item) { return item.id == toolId && item.type == 9; });
                if (!sameToolPresent && !HasActiveZenTool(current) && current.cursorType == 0 &&
                    currentProfile.purchases[pvz::purchase::treeFood] == purchaseBefore - 1 &&
                    currentProfile.treeHeight == heightBefore + 1) return true;
            }
        }
        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
    }
    reason = "tree-food animation and height increase were not both verified";
    return false;
}

bool ExecuteAction(const Command& command, std::string& reason, bool apply,
                   PlantPlacement* placement = nullptr, bool* cancelled = nullptr,
                   ActionBatchMetrics* batchMetrics = nullptr) {
    if (cancelled) *cancelled = false;
    if (batchMetrics) {
        *batchMetrics = {};
        if (apply && command.kind == "collect" && !command.ids.empty()) {
            batchMetrics->present = true;
            batchMetrics->requested = static_cast<int>(command.ids.size());
        } else if (apply && command.kind == "special" && command.special == "whack" &&
                   !command.targetIds.empty()) {
            batchMetrics->present = true;
            batchMetrics->requested = static_cast<int>(command.targetIds.size());
        }
    }
    if (command.kind == "configure") {
        if (command.pollHz < 10 || command.pollHz > 20 || command.cursorMinMs < 0 ||
            command.cursorMaxMs < command.cursorMinMs || command.cursorMaxMs > 2000) {
            reason = "configure values are outside the supported range";
            return false;
        }
        if (apply) {
            g_pollHz.store(static_cast<DWORD>(command.pollHz));
            g_cursorMinMs.store(static_cast<DWORD>(command.cursorMinMs));
            g_cursorMaxMs.store(static_cast<DWORD>(command.cursorMaxMs));
        }
        return true;
    }
    if (command.kind == "detach" || command.kind == "shutdown") return true;
    if (command.kind == "cancel") return true;

    uintptr_t lawnApp = 0;
    if (!ReadLawnApp(lawnApp, &reason)) return false;
    if (command.kind != "capture" && !MenuContextMatches(command.menuContext, lawnApp)) {
        reason = "semantic menu context is stale";
        return false;
    }
    HWND window = GameWindow();
    if (!window) {
        reason = "Plants vs. Zombies window is not ready";
        return false;
    }

    if (command.kind == "profile_create") {
        DialogView dialog;
        uintptr_t edit = 0;
        int editX = 0;
        int editY = 0;
        std::wstring name;
        ProfileState beforeProfile;
        if (!ReadProfileState(lawnApp, beforeProfile) ||
            beforeProfile.userCount >= pvz::userDialog::maxUsers ||
            !ActiveDialog(lawnApp, dialog) || !Utf8ToWide(command.name, name) ||
            name.empty() || name.size() > 12 ||
            std::any_of(name.begin(), name.end(), [](wchar_t ch) { return ch < 0x20; })) {
            reason = "profile creation is unavailable or the name is invalid";
            return false;
        }

        if (dialog.id == pvz::userDialog::dialogId) {
            MenuControl createEntry;
            int dialogUserCount = -1;
            if (!UserDialogCreateControl(lawnApp, dialog, createEntry) || !createEntry.enabled ||
                !SafeRead(dialog.address + pvz::userDialog::numUsers, dialogUserCount) ||
                dialogUserCount != beforeProfile.userCount) {
                reason = "the profile list does not offer a new-profile entry";
                return false;
            }
            if (!apply) return true;
            const uintptr_t rosterAddress = dialog.address;
            if (!ClickValidated(window, createEntry.x, createEntry.y, command.epoch, [&] {
                    DialogView freshDialog;
                    MenuControl freshEntry;
                    return ActiveDialog(lawnApp, freshDialog) &&
                           freshDialog.address == rosterAddress &&
                           UserDialogCreateControl(lawnApp, freshDialog, freshEntry) &&
                           freshEntry.enabled && freshEntry.x == createEntry.x &&
                           freshEntry.y == createEntry.y;
                })) {
                reason = "failed to open the profile name dialog";
                return false;
            }
            bool editReady = false;
            const ULONGLONG dialogDeadline = GetTickCount64() + 2000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < dialogDeadline) {
                ProfileState transitionProfile;
                if (!ReadProfileState(lawnApp, transitionProfile) ||
                    transitionProfile.manager != beforeProfile.manager ||
                    transitionProfile.userCount != beforeProfile.userCount ||
                    transitionProfile.activePlayer != beforeProfile.activePlayer ||
                    transitionProfile.activeId != beforeProfile.activeId) {
                    reason = "profile state changed while opening the name dialog";
                    return false;
                }
                DialogView current;
                if (ActiveDialog(lawnApp, current) &&
                    current.address != dialog.address &&
                    current.id == pvz::userDialog::createDialogId &&
                    DialogEditControl(current, edit, editX, editY)) {
                    dialog = current;
                    editReady = true;
                    break;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            if (!editReady) {
                reason = "profile name dialog did not open from the profile list";
                return false;
            }
        } else if (dialog.id == pvz::userDialog::createDialogId) {
            if (!DialogEditControl(dialog, edit, editX, editY)) {
                reason = "profile name field is not ready";
                return false;
            }
        } else {
            reason = "profile creation is not available in the active dialog";
            return false;
        }

        const auto controls = CollectMenuControls("dialog", lawnApp, 0);
        const auto create = std::find_if(controls.begin(), controls.end(),
            [](const MenuControl& control) {
                return control.id == "profile_create" && control.enabled;
            });
        if (create == controls.end()) {
            reason = "profile creation is not currently offered and enabled";
            return false;
        }
        if (!apply) return true;
        if (!Click(window, editX, editY, command.epoch) || !PostKey(window, VK_END)) {
            reason = "failed to focus the profile name field";
            return false;
        }
        for (int index = 0; index < 12; ++index) {
            if (!PostKey(window, VK_BACK)) {
                reason = "failed to clear the profile name field";
                return false;
            }
        }
        for (wchar_t ch : name) {
            if (!PostGameMessage(window, WM_CHAR, ch, 1)) {
                reason = "failed to enter the profile name";
                return false;
            }
        }
        bool textAccepted = false;
        const ULONGLONG deadline = GetTickCount64() + 1000;
        while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
            std::wstring currentText;
            if (ReadEditText(edit, currentText) && currentText == name) {
                textAccepted = true;
                break;
            }
            if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
        }
        if (!textAccepted) {
            reason = "profile name field did not accept the supplied text";
            return false;
        }
        const auto updatedControls = CollectMenuControls("dialog", lawnApp, 0);
        const auto updatedCreate = std::find_if(updatedControls.begin(), updatedControls.end(),
            [](const MenuControl& control) {
                return control.id == "profile_create" && control.enabled;
            });
        if (updatedCreate == updatedControls.end() ||
            !Click(window, updatedCreate->x, updatedCreate->y, command.epoch)) {
            reason = "profile creation confirmation did not accept input";
            return false;
        }
        const ULONGLONG resultDeadline = GetTickCount64() + 5000;
        while (ActionCurrent(command.epoch) && GetTickCount64() < resultDeadline) {
            ProfileState currentProfile;
            std::string currentName;
            int scene = -1;
            uintptr_t board = 0;
            if (ReadProfileState(lawnApp, currentProfile) &&
                currentProfile.manager == beforeProfile.manager &&
                currentProfile.userCount == beforeProfile.userCount + 1 &&
                currentProfile.activePlayer && currentProfile.activeId &&
                currentProfile.activePlayer != beforeProfile.activePlayer &&
                currentProfile.activeId != beforeProfile.activeId &&
                ReadProfileName(currentProfile.activePlayer, currentName) &&
                currentName == command.name &&
                SafeRead(lawnApp + pvz::app::gameScene, scene) &&
                SafeRead(lawnApp + pvz::app::board, board) &&
                std::strcmp(DetermineScreen(lawnApp, scene, board), "main_menu") == 0) {
                return true;
            }
            if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
        }
        reason = "new active profile and roster growth were not both verified";
        return false;
    }

    if (command.kind == "visual_click") {
        int scene = 0;
        uintptr_t board = 0;
        SafeRead(lawnApp + pvz::app::gameScene, scene);
        SafeRead(lawnApp + pvz::app::board, board);
        const char* screen = DetermineScreen(lawnApp, scene, board);
        if (command.x < 0 || command.x >= 800 || command.y < 0 || command.y >= 600 ||
            std::strcmp(screen, "board") == 0 ||
            std::strcmp(screen, "seed_picker") == 0 ||
            std::strcmp(screen, "loading") == 0) {
            reason = "visual compatibility clicks are unavailable on unsettled or gameplay screens";
            return false;
        }
        if (apply && !Click(window, command.x, command.y, command.epoch)) {
            reason = "failed to post visual compatibility input";
        }
        return reason.empty();
    }

    if (command.kind == "menu") {
        int scene = 0;
        int mode = 0;
        uintptr_t rawBoard = 0;
        SafeRead(lawnApp + pvz::app::gameScene, scene);
        SafeRead(lawnApp + pvz::app::gameMode, mode);
        SafeRead(lawnApp + pvz::app::board, rawBoard);
        const SemanticBoardGate gate = ReadSemanticBoardGate(
            lawnApp, scene, mode, rawBoard);
        const char* screen = DetermineScreen(lawnApp, scene, gate);
        std::vector<MenuControl> controls;
        if (!gate.shovelTutorial &&
            !SuppressTransientLoadingMenu(
                scene, std::strcmp(screen, "loading") == 0)) {
            controls = CollectMenuControls(screen, lawnApp, gate.address);
        }
        const auto offered = std::find_if(controls.begin(), controls.end(),
            [&](const MenuControl& control) { return control.id == command.target && control.enabled; });
        if (offered == controls.end()) {
            reason = "menu target is not currently offered and enabled";
            return false;
        }
        DialogView profileDialog;
        const bool profileRow = command.target.rfind("profile:", 0) == 0;
        const bool profileConfirm = command.target == "confirm" &&
            ActiveDialog(lawnApp, profileDialog) && profileDialog.id == pvz::userDialog::dialogId;
        if (profileRow || profileConfirm) {
            UserDialogList roster;
            if (!ActiveDialog(lawnApp, profileDialog) ||
                !ReadUserDialogList(lawnApp, profileDialog, roster) || !roster.enabled ||
                (profileConfirm && (roster.selected < 0 || roster.selected >= roster.numUsers))) {
                reason = "the visible profile selection is unavailable";
                return false;
            }
            const std::string expectedName = profileRow ? offered->label : roster.names[roster.selected];
            const uintptr_t dialogAddress = profileDialog.address;
            const int x = offered->x;
            const int y = offered->y;
            if (!apply) return true;
            if (!ClickValidated(window, x, y, command.epoch, [&] {
                    DialogView freshDialog;
                    UserDialogList freshRoster;
                    if (!ActiveDialog(lawnApp, freshDialog) || freshDialog.address != dialogAddress ||
                        !ReadUserDialogList(lawnApp, freshDialog, freshRoster) || !freshRoster.enabled) return false;
                    MenuControl freshControl;
                    if (profileConfirm) {
                        return freshRoster.selected >= 0 && freshRoster.selected < freshRoster.numUsers &&
                            freshRoster.names[freshRoster.selected] == expectedName &&
                            UserDialogRowControl(freshRoster, freshRoster.selected, freshControl) &&
                            DialogButtonControl(freshDialog, freshDialog.primary, "confirm", "Confirm profile", freshControl) &&
                            freshControl.enabled && freshControl.x == x && freshControl.y == y;
                    }
                    const auto name = std::find(freshRoster.names.begin(), freshRoster.names.end(), expectedName);
                    return name != freshRoster.names.end() &&
                        UserDialogRowControl(freshRoster, static_cast<int>(name - freshRoster.names.begin()), freshControl) &&
                        freshControl.enabled && freshControl.id == command.target &&
                        freshControl.x == x && freshControl.y == y;
                })) {
                reason = "profile row or confirmation changed before the click";
                return false;
            }
            const ULONGLONG deadline = GetTickCount64() + 3000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                DialogView currentDialog;
                const bool dialogPresent = ActiveDialog(lawnApp, currentDialog);
                if (profileRow) {
                    UserDialogList currentRoster;
                    if (dialogPresent && currentDialog.address == dialogAddress &&
                        ReadUserDialogList(lawnApp, currentDialog, currentRoster) &&
                        currentRoster.selected >= 0 && currentRoster.selected < currentRoster.numUsers &&
                        currentRoster.names[currentRoster.selected] == expectedName) return true;
                } else if (!dialogPresent || currentDialog.address != dialogAddress ||
                           currentDialog.id != pvz::userDialog::dialogId) {
                    ProfileState profile;
                    std::string currentName;
                    if (ReadProfileState(lawnApp, profile) && profile.activePlayer &&
                        ReadProfileName(profile.activePlayer, currentName) && currentName == expectedName) return true;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            reason = profileRow ? "profile row selection was not verified" :
                                  "selected profile did not become the active profile";
            return false;
        }
        uintptr_t initialTitle = 0;
        const bool titleContinue = command.target == "title_continue";
        if (titleContinue &&
            (std::strcmp(screen, "loading") != 0 ||
             !ReadTitleContinueReady(lawnApp, initialTitle))) {
            reason = "title screen is no longer ready to continue";
            return false;
        }
        if (!apply) return true;
        if (!Click(window, offered->x, offered->y, command.epoch)) {
            reason = "failed to post menu mouse input";
            return false;
        }
        if (!titleContinue) return true;
        const ULONGLONG deadline = GetTickCount64() + 3000;
        while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
            int currentScene = 0;
            uintptr_t currentBoard = 0;
            uintptr_t currentTitle = initialTitle;
            if (SafeRead(lawnApp + pvz::app::gameScene, currentScene) &&
                SafeRead(lawnApp + pvz::app::board, currentBoard) &&
                SafeRead(lawnApp + pvz::app::titleScreen, currentTitle) &&
                currentTitle != initialTitle &&
                std::strcmp(DetermineScreen(lawnApp, currentScene, currentBoard),
                            "loading") != 0) {
                return true;
            }
            if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
        }
        reason = "title screen did not advance after input";
        return false;
    }
    if (command.kind == "choose_seed") {
        SemanticBoardGate picker;
        SeedAvailabilityView availability;
        int chooserMode = -1;
        if (command.seed < 0 || command.seed >= pvz::chooser::visibleSeedCount ||
            !CurrentSeedPickerGate(lawnApp, picker) ||
            !SafeRead(lawnApp + pvz::app::gameMode, chooserMode) ||
            !ReadSeedAvailability(lawnApp, availability)) {
            reason = "seed chooser is not active or seed is invalid";
            return false;
        }
        if (!SeedAvailableFromProfile(availability, command.seed)) {
            reason = "seed is not unlocked by the active profile";
            return false;
        }
        if (!SeedAllowedInChooserMode(chooserMode, command.seed)) {
            reason = "seed is not selectable in the current game mode";
            return false;
        }
        const uintptr_t chooser = picker.chooser;
        std::array<uint8_t, pvz::chooser::chosenSeedStride> seed{};
        const uintptr_t address = chooser + pvz::chooser::chosenSeeds +
                                  static_cast<uintptr_t>(command.seed) * seed.size();
        const int state = SafeCopy(seed.data(), address, seed.size()) ? Field<int>(seed, 0x24) : -1;
        const uint8_t fixed = Field<uint8_t>(
            seed, pvz::chooser::chosenSeedCrazyDavePicked);
        const bool imitaterInChooser = command.seed == 48 && state == 4;
        const bool ordinaryInChooser = command.seed != 48 && state == 3;
        if (Field<int>(seed, 0x20) != command.seed || fixed > 1 ||
            (state != 1 && !ordinaryInChooser && !imitaterInChooser)) {
            reason = "seed is not currently selectable";
            return false;
        }
        if (state == 1 && fixed) {
            reason = "seed is fixed by Crazy Dave and cannot be removed";
            return false;
        }
        if (imitaterInChooser) {
            if (command.imitates < 0 || command.imitates >= 40 ||
                !SeedAvailableFromProfile(availability, command.imitates) ||
                !SeedAllowedInChooserMode(chooserMode, command.imitates)) {
                reason = "selecting Imitater requires an imitated seed from 0 through 39";
                return false;
            }
            MenuControl imitaterButton;
            if (!GameButtonControl(chooser, pvz::chooser::imitaterButton,
                                   "imitater", "Imitater", imitaterButton) ||
                !imitaterButton.enabled) {
                reason = "Imitater button is not currently enabled";
                return false;
            }
            if (!apply) return true;
            if (!Click(window, imitaterButton.x, imitaterButton.y, command.epoch)) {
                reason = "failed to open the Imitater chooser";
                return false;
            }
            DialogView imitater;
            bool opened = false;
            const ULONGLONG deadline = GetTickCount64() + 1500;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                if (ActiveDialog(lawnApp, imitater) && imitater.id == 49 &&
                    imitater.vtable == 0x007198C0) {
                    opened = true;
                    break;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            int dialogX = 0;
            int dialogY = 0;
            int dialogWidth = 0;
            uint8_t visible = 0;
            if (!opened || !SafeRead(imitater.address + pvz::widget::x, dialogX) ||
                !SafeRead(imitater.address + pvz::widget::y, dialogY) ||
                !SafeRead(imitater.address + pvz::widget::width, dialogWidth) ||
                !SafeRead(imitater.address + 0x64, visible) || !visible ||
                dialogWidth < 420 || dialogWidth > 800) {
                PostKey(window, VK_ESCAPE);
                reason = "Imitater chooser did not open in a verified state";
                return false;
            }
            const int x = dialogX + (command.imitates % 8) * 51 + dialogWidth / 2 - 210 + 25;
            const int y = dialogY + (command.imitates / 8) * 71 + 114 + 35;
            if (!Click(window, x, y, command.epoch)) {
                PostKey(window, VK_ESCAPE);
                reason = "failed to post Imitater selection input";
                return false;
            }
            return true;
        }
        if (command.imitates >= 0) {
            reason = "imitates is valid only while selecting an unbanked Imitater";
            return false;
        }
        if (apply && !Click(window, Field<int>(seed, 0x00) + 25, Field<int>(seed, 0x04) + 35,
                   command.epoch)) {
            reason = "failed to post seed chooser input";
        }
        return reason.empty();
    }
    if (command.kind == "ready") {
        SemanticBoardGate picker;
        uintptr_t seedBank = 0;
        int packetCount = 0;
        int inFlight = 0;
        int inBank = 0;
        if (!CurrentSeedPickerGate(lawnApp, picker) ||
            !picker.chooser || !picker.address ||
            !SafeRead(picker.address + pvz::board::seedBank, seedBank) || !seedBank ||
            !SafeRead(seedBank + pvz::seedBank::packetCount, packetCount) ||
            !SafeRead(picker.chooser + pvz::chooser::seedsInFlight, inFlight) ||
            !SafeRead(picker.chooser + pvz::chooser::seedsInBank, inBank) ||
            !SeedPickerReady(packetCount, inBank, inFlight)) {
            reason = "seed chooser is not ready";
            return false;
        }
        const auto controls = CollectMenuControls(
            "seed_picker", lawnApp, picker.address);
        const auto ready = std::find_if(controls.begin(), controls.end(),
            [](const MenuControl& control) { return control.id == "ready" && control.enabled; });
        if (ready == controls.end()) {
            reason = "seed chooser start button is not enabled";
            return false;
        }
        if (apply && !Click(window, ready->x, ready->y, command.epoch)) {
            reason = "failed to post ready input";
        }
        return reason.empty();
    }
    if (command.kind == "interact") {
        int scene = 0;
        int initialMode = 0;
        uintptr_t rawBoard = 0;
        SafeRead(lawnApp + pvz::app::gameScene, scene);
        SafeRead(lawnApp + pvz::app::gameMode, initialMode);
        SafeRead(lawnApp + pvz::app::board, rawBoard);
        const SemanticBoardGate initialGate = ReadSemanticBoardGate(
            lawnApp, scene, initialMode, rawBoard);
        const uintptr_t board = initialGate.address;
        const char* screen = DetermineScreen(lawnApp, scene, initialGate);
        std::vector<MenuControl> controls;
        if (!initialGate.shovelTutorial &&
            !SuppressTransientLoadingMenu(
                scene, std::strcmp(screen, "loading") == 0)) {
            controls = CollectMenuControls(screen, lawnApp, board);
        }
        const auto offered = std::find_if(controls.begin(), controls.end(),
            [&](const MenuControl& control) { return control.id == command.target && control.enabled; });
        if (offered == controls.end()) {
            reason = "interaction target is not currently offered and enabled";
            return false;
        }
        if (!apply) return true;
        if (command.target == "store_buy_fertilizer") {
            DialogView store;
            uintptr_t player = 0;
            int beforeCoins = 0;
            int beforeFertilizer = 0;
            if (!ActiveDialog(lawnApp, store) || store.id != 4 ||
                !SafeRead(lawnApp + pvz::app::playerInfo, player) || !player ||
                !SafeRead(player + pvz::player::coins, beforeCoins) ||
                !SafeRead(player + pvz::player::purchases + 14U * sizeof(int),
                          beforeFertilizer) ||
                beforeCoins < 75 || beforeFertilizer < 0 || beforeFertilizer > 2000) {
                reason = "fertilizer purchase state could not be verified";
                return false;
            }
            if (!Click(window, offered->x, offered->y, command.epoch)) {
                reason = "failed to post fertilizer item input";
                return false;
            }
            DialogView confirmation;
            MenuControl confirm;
            bool confirmationReady = false;
            const ULONGLONG dialogDeadline = GetTickCount64() + 1500;
            while (ActionCurrent(command.epoch) && GetTickCount64() < dialogDeadline) {
                if (ActiveDialog(lawnApp, confirmation) && confirmation.id == 46 &&
                    DialogButtonControl(confirmation, confirmation.primary,
                                        "confirm", "confirm", confirm) &&
                    confirm.enabled) {
                    confirmationReady = true;
                    break;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            if (!confirmationReady ||
                !Click(window, confirm.x, confirm.y, command.epoch)) {
                reason = "fertilizer purchase confirmation was not available";
                return false;
            }
            const int expectedFertilizer = beforeFertilizer < 1000
                ? 1005 : beforeFertilizer + 5;
            const ULONGLONG purchaseDeadline = GetTickCount64() + 2000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < purchaseDeadline) {
                int currentCoins = 0;
                int currentFertilizer = 0;
                if (SafeRead(player + pvz::player::coins, currentCoins) &&
                    SafeRead(player + pvz::player::purchases + 14U * sizeof(int),
                             currentFertilizer) &&
                    currentCoins == beforeCoins - 75 &&
                    currentFertilizer == expectedFertilizer) return true;
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            reason = "fertilizer inventory and coin debit were not observed";
            return false;
        }
        int initialTutorial = -1;
        if (board) SafeRead(board + pvz::board::tutorialState, initialTutorial);
        const std::string initialSignature = BuildMenuSignature(
            screen, lawnApp, board, scene, initialMode);
        DialogView initialDialog;
        uint8_t storeBubble = 1;
        const bool storeBackButton = ActiveDialog(lawnApp, initialDialog) &&
            initialDialog.id == 4 &&
            SafeRead(initialDialog.address + 0x1A0, storeBubble) && !storeBubble;
        const bool leavingTutorialStore = command.target == "advance" &&
            initialMode == 43 && initialTutorial == 25 && storeBackButton;
        if (!Click(window, offered->x, offered->y, command.epoch)) {
            reason = "failed to post interaction input";
            return false;
        }
        const ULONGLONG deadline = GetTickCount64() + 3000;
        while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
            int currentScene = 0;
            int currentMode = 0;
            uintptr_t currentBoard = 0;
            if (SafeRead(lawnApp + pvz::app::gameScene, currentScene) &&
                SafeRead(lawnApp + pvz::app::gameMode, currentMode) &&
                SafeRead(lawnApp + pvz::app::board, currentBoard)) {
                const SemanticBoardGate currentGate = ReadSemanticBoardGate(
                    lawnApp, currentScene, currentMode, currentBoard);
                const char* currentScreen = DetermineScreen(
                    lawnApp, currentScene, currentGate);
                if (leavingTutorialStore) {
                    int tutorial = -1;
                    if (currentGate.address == board &&
                        SafeRead(currentGate.address + pvz::board::tutorialState, tutorial) &&
                        tutorial == 26 && std::strcmp(currentScreen, "board") == 0) return true;
                } else if (BuildMenuSignature(currentScreen, lawnApp, currentGate.address,
                                              currentScene, currentMode) != initialSignature) {
                    return true;
                }
            }
            if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
        }
        reason = leavingTutorialStore
            ? "Zen Garden store exit did not enter the fertilizer tutorial"
            : "interaction did not produce a visible menu-state change";
        return false;
    }
    if (command.kind == "collect") {
        if (command.ids.empty()) {
            reason = "no collectible ids were supplied";
            return false;
        }
        int collectMode = 0;
        int collectBackground = 0;
        int collectRows = 0;
        uintptr_t collectBoardAddress = 0;
        BoardView collectBoard;
        if (!LiveBoard(lawnApp, collectBoardAddress, collectMode, collectBackground,
                       collectRows, reason, false, false) ||
            !ReadBoard(lawnApp, collectMode, collectBoard) || collectBoard.paused) {
            if (reason.empty()) {
                reason = "collectibles are unavailable while the board is inactive or paused";
            }
            return false;
        }
        for (int id : command.ids) {
            const auto it = std::find_if(collectBoard.collectibles.begin(), collectBoard.collectibles.end(),
                [&](const CollectibleView& target) { return target.id == static_cast<uint32_t>(id); });
            if (it == collectBoard.collectibles.end()) {
                reason = "one or more collectibles are no longer visible";
                return false;
            }
        }
        if (!apply) return true;
        const uint64_t collectRunId = TrackedRunId(collectBoard, collectMode);
        ActionBatchMetrics localBatch;
        ActionBatchMetrics& batch = batchMetrics ? *batchMetrics : localBatch;
        batch.present = true;
        batch.requested = static_cast<int>(command.ids.size());
        for (size_t index = 0; index < command.ids.size(); ++index) {
            const uint32_t publicId = static_cast<uint32_t>(command.ids[index]);
            CollectibleView clicked{};
            CollectibleLookup lookup = CollectibleLookup::Unavailable;
            bool clickStarted = false;
            bool observedDuringPress = false;
            if (!PressCurrentCollectible(window, lawnApp, collectBoardAddress, collectMode,
                                         collectBoard.mainCounter, publicId, command.epoch,
                                         clicked, lookup, clickStarted,
                                         observedDuringPress)) {
                if (clickStarted) ++batch.attempted;
                if (!clickStarted && lookup == CollectibleLookup::Missing &&
                    ActionCurrent(command.epoch)) {
                    ++batch.stale;
                    if (batch.verified == 0) g_inputPosted = false;
                    continue;
                }
                if (!clickStarted && batch.verified == 0 &&
                    lookup != CollectibleLookup::BoardChanged &&
                    ActionCurrent(command.epoch)) {
                    g_inputPosted = false;
                }
                if (cancelled && (clickStarted || lookup == CollectibleLookup::BoardChanged ||
                                  batch.verified > 0)) {
                    *cancelled = true;
                }
                if (lookup == CollectibleLookup::BoardChanged) batch.scopeStopped = true;
                reason = lookup == CollectibleLookup::BoardChanged
                    ? "collectible input stopped because the board screen changed"
                    : lookup == CollectibleLookup::Missing
                        ? "a requested collectible disappeared before it could be clicked"
                        : "failed to post collectible input from a current target";
                return false;
            }
            ++batch.attempted;
            ++batch.released;

            bool observed = observedDuringPress;
            bool transitionPending = false;
            const ULONGLONG deadline = GetTickCount64() + 1500;
            while (!observed && ActionCurrent(command.epoch) &&
                   GetTickCount64() < deadline) {
                int currentScene = -1;
                uintptr_t currentBoard = 0;
                SafeRead(lawnApp + pvz::app::gameScene, currentScene);
                const bool boardReadable = SafeRead(
                    lawnApp + pvz::app::board, currentBoard);
                int currentCounter = 0;
                const bool counterReadable = boardReadable &&
                    currentBoard == collectBoardAddress &&
                    SafeRead(currentBoard + pvz::board::mainCounter, currentCounter);
                const bool generationChanged = boardReadable &&
                    currentBoard == collectBoardAddress &&
                    CollectRunGenerationChanged(collectRunId, currentBoard);
                const CollectBoardRelation relation = ClassifyCollectBoard(
                    boardReadable, currentBoard, collectBoardAddress, counterReadable,
                    currentCounter, collectBoard.mainCounter, generationChanged);
                if (relation == CollectBoardRelation::Unreadable) {
                    reason = "collectible state could not be verified after input";
                    if (cancelled) *cancelled = true;
                    return false;
                }
                if (relation == CollectBoardRelation::Departed) {
                    const char* currentScreen = DetermineScreen(
                        lawnApp, currentScene, currentBoard);
                    if (MayUseTerminalCollectEvidence(
                            relation, index + 1 == command.ids.size(),
                            collectRunId && CollectTransitionScreen(currentScreen))) {
                        transitionPending = true;
                        if (LegalCollectTransition(
                                lawnApp, collectRunId, collectBoardAddress,
                                collectBoard.mainCounter)) {
                            observed = true;
                            break;
                        }
                        if (g_stopEvent &&
                            WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
                        continue;
                    }
                    if (cancelled) *cancelled = true;
                    batch.scopeStopped = true;
                    reason = currentBoard == collectBoardAddress
                        ? "collectible input stopped because the board run changed"
                        : "collectible input stopped because the board screen changed";
                    return false;
                }
                RawCollectibleState state;
                if (!ReadRawCollectibleState(currentBoard, clicked.rawId, state)) {
                    reason = "collectible state could not be verified after input";
                    if (cancelled) *cancelled = true;
                    return false;
                }
                if (state.present && !state.dead && state.beingCollected) {
                    observed = true;
                    break;
                }
                if (!state.present || state.dead) {
                    reason = "collectible disappeared without an observed collection state";
                    if (cancelled) *cancelled = true;
                    return false;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            if (!observed) {
                reason = !ActionCurrent(command.epoch)
                    ? "collectible input was cancelled before collection was observed"
                    : transitionPending
                        ? "terminal board transition was not attributed to the collection run"
                        : "collectible did not enter the collection state before timeout";
                if (cancelled) *cancelled = true;
                return false;
            }
            ++batch.verified;
        }
        if (batch.verified > 0) {
            reason = "collect_batch requested=" +
                     std::to_string(batch.requested) +
                     " attempted=" + std::to_string(batch.attempted) +
                     " released=" + std::to_string(batch.released) +
                     " verified=" + std::to_string(batch.verified) +
                     " stale=" + std::to_string(batch.stale);
            return true;
        }
        reason = "a requested collectible disappeared before it could be clicked";
        return false;
    }

    uintptr_t board = 0;
    int mode = 0;
    int background = 0;
    int rows = 0;
    if (!LiveBoard(lawnApp, board, mode, background, rows, reason,
                   command.kind == "plant", command.kind == "shovel")) return false;

    if (command.kind == "plant") {
        const bool relative = command.minGap >= 0;
        const bool validCell = relative
            ? command.minGap <= 8 && command.column == -1 && command.row >= 1 && command.row <= rows
            : ValidCell(command, rows);
        if (command.slot < 0 || command.slot >= 10) {
            reason = relative ? "relative planting slot is outside the seed bank"
                              : "planting slot is outside the seed bank";
            return false;
        }
        if (!validCell) {
            reason = relative ? "relative planting row is outside this board"
                              : "planting cell is outside this board";
            return false;
        }
        uintptr_t bank = 0;
        int packetCount = 0;
        BoardView semanticBoard;
        if (!ReadBoard(lawnApp, mode, semanticBoard)) {
            reason = "board state could not be verified";
            return false;
        }
        const auto card = std::find_if(semanticBoard.cards.begin(), semanticBoard.cards.end(),
            [&](const CardView& value) { return value.slot == command.slot; });
        const bool cardPresent = card != semanticBoard.cards.end();
        const bool bankSlotRead = SafeRead(board + pvz::board::seedBank, bank) && bank &&
                                  SafeRead(bank + pvz::seedBank::packetCount, packetCount) &&
                                  command.slot < packetCount;
        if (!bankSlotRead) {
            reason = relative ? "relative planting slot is not present in the seed bank"
                              : "planting slot is not present in the seed bank";
            return false;
        }
        if (!cardPresent || !CardIdentityMatches(command, *card)) {
            reason = relative ? "relative planting slot does not hold the plant the action asked for"
                              : "planting slot does not hold the plant the action asked for";
            return false;
        }
        if (semanticBoard.paused) {
            reason = relative ? "relative planting board is paused" : "planting board is paused";
            return false;
        }
        if (!card->active) {
            reason = relative ? "relative planting seed packet is not active in the seed bank"
                              : "planting seed packet is not active in the seed bank";
            return false;
        }
        if (card->refreshing || card->refreshCounter > 0) {
            reason = relative ? "relative planting seed packet is still on cooldown"
                              : "planting seed packet is still on cooldown";
            return false;
        }
        if (!CardAffordable(semanticBoard, mode, *card)) {
            reason = relative ? "relative planting seed packet costs more sun than is available"
                              : "planting seed packet costs more sun than is available";
            return false;
        }
        // The relative path resolves its cell only once input starts, and checks it there.
        if (!relative &&
            !CanPlantCardAt(semanticBoard, *card, command.row - 1, command.column - 1)) {
            reason = "planting cell will not take this plant";
            return false;
        }
        RawCardState beforePacket;
        if (!ReadRawCardState(board, command.slot, beforePacket) ||
            beforePacket.bank != bank || !beforePacket.present ||
            beforePacket.type != card->type || beforePacket.imitater != card->imitater) {
            reason = relative ? "relative planting could not verify the seed packet identity"
                              : "seed bank packet identity could not be verified";
            return false;
        }
        if (relative) {
            NativeRelativePlantInput input{window};
            PlantPlacement committed;
            const bool executed = ExecuteRelativePlant(
                command, semanticBoard, mode, *card, beforePacket, input, committed, reason, apply);
            if (executed && placement) *placement = committed;
            return executed;
        }
        if (!apply) return true;
        int x = 0;
        int y = 0;
        CellCenter(board, background, command.row - 1, command.column - 1, x, y);
        if (!Click(window, card->x, card->y, command.epoch)) {
            reason = "failed to post seed-bank selection input";
            return false;
        }
        bool selected = false;
        const ULONGLONG selectionDeadline = GetTickCount64() + 750;
        while (ActionCurrent(command.epoch) && GetTickCount64() < selectionDeadline) {
            BoardView current;
            if (ReadBoard(lawnApp, mode, current) && current.address == semanticBoard.address &&
                SameBoardCounterRun(current.mainCounter, semanticBoard.mainCounter) &&
                current.cursorType == 1 && current.cursorSeedBankIndex == command.slot &&
                current.cursorHeldType == card->type &&
                current.cursorImitaterType == card->imitater) {
                selected = true;
                break;
            }
            if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
        }
        if (!selected) {
            reason = "selected seed packet did not enter the planting cursor";
            return false;
        }
        if (!Click(window, x, y, command.epoch)) {
            reason = "failed to post planting-cell input";
            return false;
        }
        const bool conveyor = HasConveyorSeedBank(mode, semanticBoard.level);
        const ULONGLONG placementDeadline = GetTickCount64() + 1500;
        while (ActionCurrent(command.epoch) && GetTickCount64() < placementDeadline) {
            int currentScene = -1;
            int currentMode = -1;
            uintptr_t currentBoardAddress = 0;
            if (!SafeRead(lawnApp + pvz::app::gameScene, currentScene) ||
                !SafeRead(lawnApp + pvz::app::gameMode, currentMode) ||
                !SafeRead(lawnApp + pvz::app::board, currentBoardAddress) ||
                currentScene != 3 || currentMode != mode ||
                currentBoardAddress != semanticBoard.address ||
                std::strcmp(DetermineScreen(lawnApp, currentScene, currentBoardAddress), "board") != 0) {
                reason = "planting result could not be verified after the board screen changed";
                return false;
            }
            BoardView current;
            RawCardState afterPacket;
            if (ReadBoard(lawnApp, mode, current) &&
                SameBoardCounterRun(current.mainCounter, semanticBoard.mainCounter) &&
                ReadRawCardState(current.address, command.slot, afterPacket) &&
                afterPacket.bank == beforePacket.bank &&
                PlantCursorReleased(IsWhackLevel(mode, current.level), current.cursorType) &&
                RawCardConsumed(conveyor, beforePacket.type, beforePacket.imitater,
                                beforePacket.timesUsed, beforePacket.offsetX,
                                afterPacket.present, afterPacket.type, afterPacket.imitater,
                                afterPacket.timesUsed, afterPacket.offsetX,
                                afterPacket.refreshing)) return true;
            if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
        }
        reason = "seed packet was not observed being consumed by the requested planting input";
        return false;
    }
    if (command.kind == "shovel") {
        if (!ValidCell(command, rows)) {
            reason = "shovel cell is invalid";
            return false;
        }
        int shovelScene = 0;
        SafeRead(lawnApp + pvz::app::gameScene, shovelScene);
        const SemanticBoardGate shovelGate = ReadSemanticBoardGate(
            lawnApp, shovelScene, mode, board);
        const bool shovelTutorial = shovelScene == 2 &&
                                    shovelGate.shovelTutorial &&
                                    shovelGate.address == board;
        BoardView semanticBoard;
        if (!ReadBoard(lawnApp, mode, semanticBoard) || semanticBoard.paused ||
            (shovelTutorial &&
             (!ShovelTutorialState(semanticBoard.tutorialState) ||
              semanticBoard.level != 5 ||
              ShovelTutorialPeashooterCount(semanticBoard) == 0 ||
              ShovelTutorialPeashooterCount(semanticBoard) > 3))) {
            reason = "shovel target state is unavailable";
            return false;
        }
        if (semanticBoard.cursorType != 0 && semanticBoard.cursorType != 6) {
            reason = "shovel is blocked while another cursor tool is held";
            return false;
        }
        const auto targetMatches = [&](const PlantView& plant) {
            return plant.row + 1 == command.row &&
                   plant.column + 1 == command.column &&
                   (!shovelTutorial || plant.type == 0);
        };
        const int beforeCount = static_cast<int>(std::count_if(
            semanticBoard.plants.begin(), semanticBoard.plants.end(), targetMatches));
        if (beforeCount == 0) {
            reason = "no visible plant exists at the requested cell";
            return false;
        }
        int x = 0;
        int y = 0;
        CellCenter(board, background, command.row - 1, command.column - 1, x, y);
        if (!apply) return true;
        if (semanticBoard.cursorType == 0) {
            if (!Click(window, kShovelButtonX, kShovelButtonY, command.epoch)) {
                reason = "failed to post shovel selection input";
                return false;
            }
            bool selected = false;
            int lastCursorType = semanticBoard.cursorType;
            const ULONGLONG selectionDeadline = GetTickCount64() + 750;
            while (ActionCurrent(command.epoch) &&
                   GetTickCount64() < selectionDeadline) {
                int currentMode = -1;
                uintptr_t currentBoardAddress = 0;
                BoardView current;
                if (!SafeRead(lawnApp + pvz::app::gameMode, currentMode) ||
                    !SafeRead(lawnApp + pvz::app::board, currentBoardAddress) ||
                    currentMode != mode || currentBoardAddress != semanticBoard.address) {
                    reason = "shovel selection could not be verified after the board changed";
                    return false;
                }
                if (ReadBoard(lawnApp, mode, current, semanticBoard.address) &&
                    SameBoardCounterRun(current.mainCounter, semanticBoard.mainCounter)) {
                    if (current.cursorType == 6) {
                        selected = true;
                        break;
                    }
                    lastCursorType = current.cursorType;
                    if (current.cursorType != 0) {
                        reason = "shovel selection is blocked by another cursor tool";
                        return false;
                    }
                }
                if (g_stopEvent &&
                    WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            if (!selected) {
                const SeedBankRect bank = ReadSeedBankRect(board);
                std::string measured = "点了铲子，光标没变成铲子；点的是 (";
                AppendInt(measured, kShovelButtonX);
                measured += ",";
                AppendInt(measured, kShovelButtonY);
                measured += ")，这段时间光标一直是 ";
                measured += CursorName(lastCursorType);
                if (bank.read) {
                    measured += "；卡槽矩形 (";
                    AppendInt(measured, bank.x);
                    measured += ",";
                    AppendInt(measured, bank.y);
                    measured += " ";
                    AppendInt(measured, bank.width);
                    measured += "x";
                    AppendInt(measured, bank.height);
                    measured += ")";
                } else {
                    measured += "；卡槽矩形读不到";
                }
                reason = measured;
                return false;
            }
        }
        if (!Click(window, x, y, command.epoch)) {
            reason = "failed to post shovel-cell input";
            return false;
        }
        const ULONGLONG deadline = GetTickCount64() + 1500;
        while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
            int currentMode = -1;
            uintptr_t currentBoardAddress = 0;
            BoardView current;
            if (!SafeRead(lawnApp + pvz::app::gameMode, currentMode) ||
                !SafeRead(lawnApp + pvz::app::board, currentBoardAddress) ||
                currentMode != mode || currentBoardAddress != semanticBoard.address ||
                !ReadBoard(lawnApp, mode, current, semanticBoard.address) ||
                !SameBoardCounterRun(current.mainCounter, semanticBoard.mainCounter)) {
                reason = "shovel result could not be verified after the board changed";
                return false;
            }
            const int afterCount = static_cast<int>(std::count_if(
                current.plants.begin(), current.plants.end(), targetMatches));
            if (afterCount < beforeCount) return true;
            if (g_stopEvent &&
                WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
        }
        reason = "the requested plant was not observed leaving the cell after shovel input";
        return false;
    }
    if (command.kind == "special") {
        BoardView semanticBoard;
        if (!ReadBoard(lawnApp, mode, semanticBoard)) {
            reason = "board state could not be verified";
            return false;
        }
        const bool whack = command.special == "whack";
        if (whack && batchMetrics) {
            batchMetrics->present = true;
            batchMetrics->requested = static_cast<int>(command.targetIds.size());
        }
        if (whack && semanticBoard.level != command.expectedLevel) {
            if (batchMetrics) batchMetrics->scopeStopped = true;
            reason = "whack batch level scope is stale";
            return false;
        }
        const SpecialView liveSpecial = BuildSpecial(semanticBoard, mode);
        if (!SpecialCommandOffered(liveSpecial, command) && !(apply && whack)) {
            reason = "special action is not currently offered for this target";
            return false;
        }
        ZenCareTool zenCareTool;
        if (semanticBoard.tutorialState == 0 &&
            ParseZenCareTool(command.special, zenCareTool)) {
            return ExecuteZenCareAction(
                command, window, lawnApp, semanticBoard, mode, reason, apply);
        }
        if (command.special == "zen_next_garden") {
            return ExecuteZenNextGarden(
                command, window, lawnApp, semanticBoard, mode, reason, apply);
        }
        if (command.special == "tree_feed") {
            return ExecuteTreeFeed(
                command, window, lawnApp, semanticBoard, mode, reason, apply);
        }
        auto clickCell = [&](int row, int column) {
            int x = 0;
            int y = 0;
            CellCenter(board, background, row - 1, column - 1, x, y);
            return Click(window, x, y, command.epoch);
        };
        if (command.special == "buy_snorkel" || command.special == "buy_trophy") {
            const int cardType = command.special == "buy_snorkel" ? 58 : 59;
            const auto card = std::find_if(semanticBoard.cards.begin(), semanticBoard.cards.end(),
                [&](const CardView& value) {
                    return value.type == cardType && CardUsable(semanticBoard, mode, value);
                });
            if (mode != 23 || card == semanticBoard.cards.end() ||
                HasLevelTransition(semanticBoard) ||
                (cardType == 58 && semanticBoard.zombies.size() > 100)) {
                reason = "Zombiquarium purchase is no longer available";
                return false;
            }
            uintptr_t bank = 0;
            int packetCount = 0;
            if (!SafeRead(board + pvz::board::seedBank, bank) || !bank ||
                !SafeRead(bank + pvz::seedBank::packetCount, packetCount) ||
                card->slot < 0 || card->slot >= packetCount) {
                reason = "Zombiquarium seed bank is unavailable";
                return false;
            }
            if (!apply) return true;
            const int initialSun = semanticBoard.sun;
            const int initialTimesUsed = card->timesUsed;
            std::unordered_set<uint32_t> initialZombies;
            for (const auto& zombie : semanticBoard.zombies) initialZombies.insert(zombie.id);
            if (!Click(window, card->x, card->y, command.epoch)) {
                reason = "failed to post Zombiquarium purchase input";
                return false;
            }
            const ULONGLONG deadline = GetTickCount64() + 2000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                int currentScene = 0;
                SafeRead(lawnApp + pvz::app::gameScene, currentScene);
                BoardView current;
                if (currentScene != 3 && cardType == 59) return true;
                if (ReadBoard(lawnApp, mode, current)) {
                    const auto currentCard = std::find_if(current.cards.begin(), current.cards.end(),
                        [&](const CardView& value) { return value.slot == card->slot; });
                    const bool packetUsed = currentCard != current.cards.end() &&
                                            currentCard->timesUsed > initialTimesUsed;
                    const bool sunSpent = current.sun < initialSun;
                    if (cardType == 59 &&
                        (current.levelAwardSpawned || packetUsed || sunSpent)) return true;
                    if (cardType == 58 && (packetUsed || sunSpent) &&
                        std::any_of(current.zombies.begin(), current.zombies.end(),
                            [&](const ZombieView& zombie) {
                                return zombie.type == 11 && zombie.height == 10 &&
                                       initialZombies.find(zombie.id) == initialZombies.end();
                            })) return true;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            reason = cardType == 59
                ? "Zombiquarium trophy purchase was not observed"
                : "Zombiquarium snorkel purchase was not observed";
            return false;
        }
        if (command.special == "drop_brain") {
            const int brainCount = static_cast<int>(std::count_if(
                semanticBoard.gridItems.begin(), semanticBoard.gridItems.end(),
                [](const GridItemView& item) { return item.type == 6; }));
            if (mode != 23 || command.row < 1 || command.row > 4 ||
                command.column < 1 || command.column > 9 ||
                semanticBoard.sun + semanticBoard.sunBeingCollected < 5 || brainCount >= 3 ||
                HasLevelTransition(semanticBoard)) {
                reason = "Zombiquarium cannot accept a brain at that target";
                return false;
            }
            if (!apply) return true;
            std::unordered_set<uint32_t> initialBrains;
            for (const auto& item : semanticBoard.gridItems) {
                if (item.type == 6) initialBrains.insert(item.id);
            }
            if (!clickCell(command.row, command.column)) {
                reason = "failed to post Zombiquarium feeding input";
                return false;
            }
            const ULONGLONG deadline = GetTickCount64() + 1500;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                BoardView current;
                if (ReadBoard(lawnApp, mode, current) &&
                    std::any_of(current.gridItems.begin(), current.gridItems.end(),
                        [&](const GridItemView& item) {
                            return item.type == 6 && item.row + 1 == command.row &&
                                   item.column + 1 == command.column &&
                                   initialBrains.find(item.id) == initialBrains.end();
                        })) return true;
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            reason = "Zombiquarium brain placement was not observed";
            return false;
        }
        if (command.special == "zen_water" || command.special == "zen_fertilize") {
            const bool watering = command.special == "zen_water";
            const bool correctPhase = mode == 43 &&
                (watering ? semanticBoard.tutorialState >= 22 && semanticBoard.tutorialState <= 24
                          : semanticBoard.tutorialState == 26);
            const auto target = std::find_if(semanticBoard.plants.begin(), semanticBoard.plants.end(),
                [&](const PlantView& plant) {
                    return command.targetId >= 0 && plant.id == static_cast<uint32_t>(command.targetId) &&
                           plant.row + 1 == command.row && plant.column + 1 == command.column;
                });
            PottedPlantView potted;
            const bool needsTool = target != semanticBoard.plants.end() &&
                ReadPottedPlant(semanticBoard, *target, potted) &&
                (watering ? potted.timesFed < potted.feedingsPerGrow : potted.age == 0);
            if (!correctPhase || !needsTool) {
                reason = "Zen tutorial target no longer needs the requested tool";
                return false;
            }
            if (!apply) return true;
            {
                BoardView current;
                if (!ReadBoard(lawnApp, mode, current)) {
                    reason = "Zen tutorial board state became unavailable";
                    return false;
                }
                const auto livePlant = std::find_if(current.plants.begin(), current.plants.end(),
                    [&](const PlantView& plant) {
                        return plant.id == static_cast<uint32_t>(command.targetId) &&
                               plant.row + 1 == command.row && plant.column + 1 == command.column;
                    });
                PottedPlantView livePotted;
                if (livePlant == current.plants.end() ||
                    !ReadPottedPlant(current, *livePlant, livePotted)) {
                    reason = "Zen tutorial target became unavailable";
                    return false;
                }
                const bool stillNeeds = watering
                    ? livePotted.timesFed < livePotted.feedingsPerGrow : livePotted.age == 0;
                if (!stillNeeds) return true;
                if (!ActionCurrent(command.epoch)) {
                    reason = "Zen tutorial input was cancelled";
                    return false;
                }
                const int toolX = watering ? 65 : 135;
                const int cursorType = watering ? 9 : 10;
                if (!Click(window, toolX, 36, command.epoch)) {
                    reason = "failed to select the Zen tutorial tool";
                    return false;
                }
                bool holdingTool = false;
                const ULONGLONG cursorDeadline = GetTickCount64() + 750;
                while (ActionCurrent(command.epoch) && GetTickCount64() < cursorDeadline) {
                    uintptr_t cursor = 0;
                    int currentType = -1;
                    if (SafeRead(current.address + pvz::board::cursorObject, cursor) && cursor &&
                        SafeRead(cursor + 0x30, currentType) && currentType == cursorType) {
                        holdingTool = true;
                        break;
                    }
                    if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
                }
                if (!holdingTool) {
                    reason = "Zen tutorial tool cursor was not observed";
                    return false;
                }
                if (!Click(window, livePlant->x + 40, livePlant->y + 40, command.epoch)) {
                    reason = "failed to apply the Zen tutorial tool";
                    return false;
                }
                const int previousTimesFed = livePotted.timesFed;
                const int previousAge = livePotted.age;
                bool effectObserved = false;
                const ULONGLONG feedDeadline = GetTickCount64() + 1500;
                while (ActionCurrent(command.epoch) && GetTickCount64() < feedDeadline) {
                    BoardView updated;
                    if (ReadBoard(lawnApp, mode, updated)) {
                        const auto updatedPlant = std::find_if(updated.plants.begin(), updated.plants.end(),
                            [&](const PlantView& plant) {
                                return plant.id == static_cast<uint32_t>(command.targetId);
                            });
                        PottedPlantView updatedPotted;
                        if (updatedPlant == updated.plants.end() ||
                            (ReadPottedPlant(updated, *updatedPlant, updatedPotted) &&
                             (updatedPotted.timesFed > previousTimesFed ||
                              updatedPotted.age > previousAge))) {
                            effectObserved = true;
                            break;
                        }
                    }
                    if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
                }
                if (!effectObserved) {
                    reason = "Zen tutorial tool effect was not observed";
                    return false;
                }
                return true;
            }
        }
        if (command.special == "spin") {
            uintptr_t bank = 0;
            int packetCount = 0;
            if (mode != 18 || semanticBoard.challengeState != 0 ||
                !SlotPacketsSettled(board, bank, packetCount)) {
                reason = "slot machine is not ready to spin";
                return false;
            }
            int bankX = 0;
            int bankY = 0;
            if (!SafeRead(bank + 0x08, bankX) || !SafeRead(bank + 0x0C, bankY)) {
                reason = "slot-machine handle position is unavailable";
                return false;
            }
            if (!apply) return true;
            const int initialRollCount = semanticBoard.slotCounter;
            if (!Click(window, bankX + 500, bankY + 40, command.epoch)) {
                reason = "failed to post slot-machine input";
                return false;
            }
            bool sawRolling = false;
            const ULONGLONG deadline = GetTickCount64() + 6000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                BoardView current;
                if (ReadBoard(lawnApp, mode, current)) {
                    sawRolling = sawRolling || current.challengeState == 4;
                    uintptr_t currentBank = 0;
                    int currentPackets = 0;
                    if (sawRolling && current.challengeState == 0 &&
                        current.slotCounter == initialRollCount + 1 &&
                        SlotPacketsSettled(board, currentBank, currentPackets)) return true;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 20) == WAIT_OBJECT_0) break;
            }
            reason = "slot-machine spin did not complete the 0-4-0 transition";
            return false;
        }
        if (command.special == "launch") {
            const CardView held{-1, semanticBoard.cursorHeldType, -1, 0, 0, 0,
                                true, false, 0, 0};
            RawCollectibleState heldCoin;
            if (semanticBoard.cursorType != 2 || semanticBoard.cursorHeldType < 0 ||
                semanticBoard.cursorHeldType >= 53 || !semanticBoard.cursorCoinRawId ||
                !ReadRawCollectibleState(semanticBoard.address,
                                         semanticBoard.cursorCoinRawId, heldCoin) ||
                !heldCoin.present || heldCoin.dead || !heldCoin.beingCollected ||
                heldCoin.type != 16 ||
                heldCoin.containedType != semanticBoard.cursorHeldType ||
                !ValidCell(command, rows) ||
                !CanPlantCardAt(semanticBoard, held, command.row - 1, command.column - 1)) {
                reason = "no verified usable-seed packet is ready to launch";
                return false;
            }
            if (!apply) return true;
            if (!clickCell(command.row, command.column)) {
                reason = "failed to post usable-seed input";
                return false;
            }
            const ULONGLONG deadline = GetTickCount64() + 1500;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                BoardView current;
                if (ReadBoard(lawnApp, mode, current) && current.address == semanticBoard.address &&
                    SameBoardCounterRun(current.mainCounter, semanticBoard.mainCounter) &&
                    current.cursorType == 0) {
                    RawCollectibleState usedCoin;
                    if (!ReadRawCollectibleState(current.address,
                                                 semanticBoard.cursorCoinRawId, usedCoin) ||
                        (usedCoin.present && !usedCoin.dead)) {
                        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
                        continue;
                    }
                    int centerX = 0;
                    int centerY = 0;
                    CellCenter(current.address, current.background, command.row - 1,
                               command.column - 1, centerX, centerY);
                    const bool cellVisible = current.entitiesVisible && FogAllowsZombie(
                        current.address, 0, current.background, centerX, command.row - 1);
                    const bool plantVisible = std::any_of(
                        current.plants.begin(), current.plants.end(),
                        [&](const PlantView& plant) {
                            return plant.type == semanticBoard.cursorHeldType &&
                                   plant.row + 1 == command.row &&
                                   (plant.column + 1 == command.column ||
                                    (plant.type == 47 && plant.column + 2 == command.column));
                        });
                    if (!cellVisible || plantVisible) return true;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            reason = "usable seed was not observed being consumed at the requested cell";
            return false;
        }
        if (command.special == "start_onslaught") {
            uintptr_t button = 0;
            if (mode != 31 || semanticBoard.challengeState != 0 ||
                !LastStandButtonReady(board, button)) {
                reason = "Last Stand is not waiting to start an onslaught";
                return false;
            }
            if (!apply) return true;
            int buttonX = 0;
            int buttonY = 0;
            int buttonWidth = 0;
            int buttonHeight = 0;
            if (!SafeRead(button + pvz::widget::gameButtonX, buttonX) ||
                !SafeRead(button + pvz::widget::gameButtonY, buttonY) ||
                !SafeRead(button + pvz::widget::gameButtonWidth, buttonWidth) ||
                !SafeRead(button + pvz::widget::gameButtonHeight, buttonHeight) ||
                !Click(window, buttonX + buttonWidth / 2, buttonY + buttonHeight / 2,
                       command.epoch)) {
                reason = "failed to post Last Stand input";
                return false;
            }
            const ULONGLONG deadline = GetTickCount64() + 3000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                BoardView current;
                uintptr_t currentButton = 0;
                if (ReadBoard(lawnApp, mode, current) && current.challengeState == 10 &&
                    !LastStandButtonReady(board, currentButton)) return true;
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 20) == WAIT_OBJECT_0) break;
            }
            reason = "Last Stand did not enter the onslaught state";
            return false;
        }
        if (command.special == "whack" || command.special == "break_vase") {
            const bool correctMode = whack
                ? IsWhackLevel(mode, semanticBoard.level)
                : IsVaseLevel(mode, semanticBoard.level);
            if (!correctMode || (!whack && !ValidCell(command, rows))) {
                reason = "special cell action is unavailable or invalid";
                return false;
            }
            if (whack) {
                if (!apply) return true;
                const int expectedLevel = command.expectedLevel;
                ActionBatchMetrics localBatch;
                ActionBatchMetrics& batch = batchMetrics ? *batchMetrics : localBatch;
                int blockedTargets = 0;
                const auto hitTarget = [&](uint32_t targetId,
                                           double remainingRoute,
                                           WhackTargetLookup& lookup,
                                           bool& attempted,
                                           bool& released) {
                    ZombieView before{};
                    if (!PressCurrentWhackTarget(
                        window, lawnApp, semanticBoard.address, mode,
                        expectedLevel, semanticBoard.mainCounter,
                        targetId, remainingRoute, command.epoch,
                        before, lookup, &attempted, &released)) {
                        return false;
                    }
                    const ULONGLONG deadline = GetTickCount64() + kWhackEffectVerifyMs;
                    while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                        BoardView current;
                        if (!ReadSameBoard(
                                lawnApp, semanticBoard.address, mode,
                                semanticBoard.mainCounter, current)) {
                            lookup = WhackTargetLookup::BoardChanged;
                            return false;
                        }
                        if (current.level != expectedLevel) {
                            lookup = WhackTargetLookup::ScopeChanged;
                            return false;
                        }
                        if (!current.entitiesVisible || !IsWhackLevel(mode, current.level)) {
                            lookup = WhackTargetLookup::BoardChanged;
                            return false;
                        }
                        const auto updated = std::find_if(
                            current.zombies.begin(), current.zombies.end(),
                            [&](const ZombieView& zombie) { return zombie.id == before.id; });
                        if (updated == current.zombies.end() ||
                            updated->health != before.health ||
                            updated->armorHealth != before.armorHealth ||
                            updated->armorType != before.armorType ||
                            updated->hasHead != before.hasHead ||
                            updated->hasArm != before.hasArm) return true;
                        if (g_stopEvent &&
                            WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
                    }
                    lookup = WhackTargetLookup::Unavailable;
                    return false;
                };
                WhackTargetLookup lastLookup = WhackTargetLookup::Missing;
                for (size_t targetIndex = 0;
                     targetIndex < command.targetIds.size(); ++targetIndex) {
                    if (!ActionCurrent(command.epoch)) {
                        reason = "whack batch was cancelled during execution";
                        return false;
                    }
                    BoardView routeBoard;
                    const double remainingRoute = ReadSameBoard(
                        lawnApp, semanticBoard.address, mode,
                        semanticBoard.mainCounter, routeBoard)
                        ? EstimateWhackRemainingRoute(
                            routeBoard, command.targetIds, targetIndex)
                        : 0.0;
                    WhackTargetLookup lookup = WhackTargetLookup::Unavailable;
                    bool attempted = false;
                    bool released = false;
                    if (hitTarget(
                            static_cast<uint32_t>(command.targetIds[targetIndex]),
                            remainingRoute, lookup, attempted, released)) {
                        if (attempted) ++batch.attempted;
                        if (released) ++batch.released;
                        ++batch.verified;
                        continue;
                    }
                    if (attempted) ++batch.attempted;
                    if (released) ++batch.released;
                    lastLookup = lookup;
                    if (lookup == WhackTargetLookup::ScopeChanged ||
                        lookup == WhackTargetLookup::BoardChanged) {
                        batch.scopeStopped = true;
                        break;
                    }
                    if (lookup == WhackTargetLookup::Blocked) {
                        ++blockedTargets;
                        ++batch.stale;
                        continue;
                    }
                    if (lookup == WhackTargetLookup::Missing) ++batch.stale;
                }
                if (!ActionCurrent(command.epoch)) {
                    reason = "whack batch was cancelled during execution";
                    return false;
                }
                if (batch.released < batch.attempted) {
                    reason = "whack batch input release was not confirmed";
                    return false;
                }
                if (batch.verified > 0) {
                    reason = "whack_batch requested=" +
                             std::to_string(batch.requested) +
                             " attempted=" + std::to_string(batch.attempted) +
                             " released=" + std::to_string(batch.released) +
                             " verified=" + std::to_string(batch.verified) +
                             " stale=" + std::to_string(batch.stale) +
                             " blocked=" + std::to_string(blockedTargets) +
                             " scope_stopped=" + (batch.scopeStopped ? "1" : "0");
                    return true;
                }
                reason = lastLookup == WhackTargetLookup::ScopeChanged
                    ? "whack batch stopped because the bound level changed"
                    : lastLookup == WhackTargetLookup::BoardChanged
                        ? "whack batch stopped because the board scope changed"
                        : blockedTargets > 0 && batch.attempted == 0
                            ? "selected Whack-a-Zombie targets are blocked by collectible hit regions"
                        : batch.attempted > 0
                            ? "selected Whack-a-Zombie targets did not show a hit effect"
                            : "no selected surfaced whack target is currently visible";
                return false;
            }
            const bool targetVisible = std::any_of(
                semanticBoard.gridItems.begin(), semanticBoard.gridItems.end(),
                [&](const GridItemView& item) {
                    return command.targetId >= 0 && item.id == static_cast<uint32_t>(command.targetId) &&
                           item.type == 7 && item.row + 1 == command.row &&
                           item.column + 1 == command.column;
                });
            if (!targetVisible) {
                reason = "no vase exists at the requested cell";
                return false;
            }
            if (apply && !clickCell(command.row, command.column)) reason = "failed to post vase input";
            return reason.empty();
        }
        if (command.special == "beghouled_buy") {
            BoardView settledBoard;
            if ((mode != 20 && mode != 24) ||
                !BeghouledSettled(lawnApp, mode, settledBoard)) {
                reason = "Beghouled purchase is unavailable while the board is moving";
                return false;
            }
            const auto card = std::find_if(settledBoard.cards.begin(), settledBoard.cards.end(),
                [&](const CardView& value) { return value.slot == command.slot; });
            int upgrade = -1;
            if (card != settledBoard.cards.end()) {
                if (card->type == 7) upgrade = 0;
                else if (card->type == 10) upgrade = 1;
                else if (card->type == 23) upgrade = 2;
            }
            const bool supported = card != settledBoard.cards.end() &&
                (upgrade >= 0 || card->type == 54 || card->type == 55);
            const bool semanticReady = supported &&
                ((upgrade >= 0 &&
                  !settledBoard.beghouledUpgrades[static_cast<size_t>(upgrade)]) ||
                 card->type == 54 ||
                 (card->type == 55 && settledBoard.beghouledCraterCount > 0));
            const int cost = supported ? CurrentCardCost(settledBoard, mode, *card) : -1;
            if (!semanticReady || !CardUsable(settledBoard, mode, *card) || cost <= 0) {
                reason = "Beghouled purchase card is no longer usable";
                return false;
            }
            if (!apply) return true;
            auto layout = [](const BoardView& current) {
                std::array<int, 9 * 6> result{};
                result.fill(-1);
                for (const auto& plant : current.plants) {
                    if (plant.row >= 0 && plant.row < 6 &&
                        plant.column >= 0 && plant.column < 9) {
                        result[static_cast<size_t>(plant.row * 9 + plant.column)] = plant.type;
                    }
                }
                return result;
            };
            const auto initialLayout = layout(settledBoard);
            const int initialSun = settledBoard.sun;
            const int initialCraters = settledBoard.beghouledCraterCount;
            if (!Click(window, card->x, card->y, command.epoch)) {
                reason = "failed to post Beghouled purchase input";
                return false;
            }
            const ULONGLONG deadline = GetTickCount64() + 2000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                BoardView current;
                if (ReadBoard(lawnApp, mode, current) &&
                    current.address == settledBoard.address &&
                    SameBoardCounterRun(current.mainCounter, settledBoard.mainCounter) &&
                    current.sun == initialSun - cost) {
                    if (upgrade >= 0 &&
                        current.beghouledUpgrades[static_cast<size_t>(upgrade)]) return true;
                    if (card->type == 54 && current.challengeState != 0 &&
                        layout(current) != initialLayout) return true;
                    if (card->type == 55 && current.challengeState != 0 &&
                        current.beghouledCraterCount < initialCraters) return true;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            reason = "Beghouled purchase effect was not observed";
            return false;
        }
        if (command.special == "swap" || command.special == "twist") {
            const bool correctMode = command.special == "swap" ? mode == 20 : mode == 24;
            if (!correctMode || !ValidCell(command, rows) ||
                !BeghouledSettled(lawnApp, mode, semanticBoard)) {
                reason = "Beghouled action is unavailable or invalid";
                return false;
            }
            const auto hasPlant = [&](int row, int column) {
                return std::any_of(semanticBoard.plants.begin(), semanticBoard.plants.end(),
                    [&](const PlantView& plant) {
                        return plant.row + 1 == row && plant.column + 1 == column;
                    });
            };
            const bool swap = command.special == "swap";
            const bool destinationValid = !swap ||
                (ValidCell(command, rows, true) &&
                 std::abs(command.row - command.toRow) + std::abs(command.column - command.toColumn) == 1 &&
                 hasPlant(command.toRow, command.toColumn));
            const bool twistAreaValid = swap ||
                (command.row < rows && command.column < 9 &&
                 hasPlant(command.row, command.column + 1) &&
                 hasPlant(command.row + 1, command.column) &&
                 hasPlant(command.row + 1, command.column + 1));
            if (!hasPlant(command.row, command.column) || !destinationValid || !twistAreaValid) {
                reason = "Beghouled source has no visible plant";
                return false;
            }
            if (!apply) return true;
            if (swap) {
                int fromX = 0;
                int fromY = 0;
                int toX = 0;
                int toY = 0;
                CellCenter(board, background, command.row - 1, command.column - 1, fromX, fromY);
                CellCenter(board, background, command.toRow - 1, command.toColumn - 1, toX, toY);
                if (!Drag(window, fromX, fromY, toX, toY, command.epoch)) {
                    reason = "failed to post Beghouled drag input";
                    return false;
                }
            } else if (!clickCell(command.row, command.column)) {
                reason = "failed to post Beghouled twist input";
                return false;
            }
            return true;
        }
        if (command.special == "bowling" || command.special == "place_zombie") {
            const bool correctMode = command.special == "bowling" ?
                                     IsBowlingLevel(mode, semanticBoard.level) :
                                     (mode >= 61 && mode <= 70);
            if (!correctMode || command.slot < 0 || command.slot >= 10 || !ValidCell(command, rows) ||
                (command.special == "bowling" && command.column > 3)) {
                reason = "card-based special action is unavailable or invalid";
                return false;
            }
            uintptr_t bank = 0;
            int packetCount = 0;
            const auto card = std::find_if(semanticBoard.cards.begin(), semanticBoard.cards.end(),
                [&](const CardView& value) { return value.slot == command.slot; });
            const bool cardUsable = card != semanticBoard.cards.end() &&
                                    CardIdentityMatches(command, *card) &&
                                    CardUsable(semanticBoard, mode, *card);
            if (!SafeRead(board + pvz::board::seedBank, bank) || !bank ||
                !SafeRead(bank + pvz::seedBank::packetCount, packetCount) || command.slot >= packetCount ||
                !cardUsable) {
                reason = "card-based special action is unavailable";
                return false;
            }
            if (command.special == "place_zombie" &&
                (!IZombieCellAllowed(mode, card->type, command.row, command.column) ||
                 HasLevelTransition(semanticBoard))) {
                reason = "I-Zombie card is not legal on that side of the placement line";
                return false;
            }
            if (!apply) return true;
            RawCardState beforePacket;
            if (command.special == "bowling" &&
                (!ReadRawCardState(board, command.slot, beforePacket) ||
                 beforePacket.bank != bank || !beforePacket.present ||
                 beforePacket.type != card->type || beforePacket.imitater != card->imitater)) {
                reason = "card-based special packet identity could not be verified";
                return false;
            }
            const int initialTimesUsed = card->timesUsed;
            std::unordered_set<uint32_t> initialPlants;
            std::unordered_set<uint32_t> initialZombies;
            if (command.special == "bowling") {
                for (const auto& plant : semanticBoard.plants) initialPlants.insert(plant.id);
            } else {
                for (const auto& zombie : semanticBoard.zombies) initialZombies.insert(zombie.id);
            }
            if (!Click(window, card->x, card->y, command.epoch) ||
                !clickCell(command.row, command.column)) {
                reason = "failed to post card-based special input";
                return false;
            }
            if (command.special == "place_zombie") {
                const int zombieType = IZombieZombieType(card->type);
                const ULONGLONG deadline = GetTickCount64() + 2000;
                while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                    BoardView current;
                    if (ReadBoard(lawnApp, mode, current)) {
                        const auto currentCard = std::find_if(current.cards.begin(), current.cards.end(),
                            [&](const CardView& value) { return value.slot == card->slot; });
                        const bool packetUsed = currentCard != current.cards.end() &&
                                                currentCard->timesUsed > initialTimesUsed;
                        const bool zombiePlaced = std::any_of(
                            current.zombies.begin(), current.zombies.end(),
                            [&](const ZombieView& zombie) {
                                if (zombie.type != zombieType || zombie.row + 1 != command.row ||
                                    initialZombies.find(zombie.id) != initialZombies.end()) return false;
                                return zombieType == 20
                                    ? zombie.targetColumn >= 0 && zombie.targetColumn < 9 &&
                                      zombie.targetColumn + 1 == command.column
                                    : zombie.column + 1 == command.column;
                            });
                        if (packetUsed && zombiePlaced && current.cursorType == 0) return true;
                    }
                    if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
                }
                reason = "I-Zombie placement was not observed";
                return false;
            }
            const ULONGLONG deadline = GetTickCount64() + 2000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < deadline) {
                int currentScene = -1;
                int currentMode = -1;
                uintptr_t currentBoardAddress = 0;
                if (!SafeRead(lawnApp + pvz::app::gameScene, currentScene) ||
                    !SafeRead(lawnApp + pvz::app::gameMode, currentMode) ||
                    !SafeRead(lawnApp + pvz::app::board, currentBoardAddress) ||
                    currentScene != 3 || currentMode != mode ||
                    currentBoardAddress != semanticBoard.address ||
                    std::strcmp(DetermineScreen(lawnApp, currentScene, currentBoardAddress),
                                "board") != 0) {
                    reason = "bowling result could not be verified after the board screen changed";
                    return false;
                }
                BoardView current;
                RawCardState afterPacket;
                if (ReadBoard(lawnApp, mode, current) &&
                    SameBoardCounterRun(current.mainCounter, semanticBoard.mainCounter) &&
                    ReadRawCardState(current.address, command.slot, afterPacket) &&
                    afterPacket.bank == beforePacket.bank && current.cursorType == 0) {
                    const bool packetUsed = RawCardConsumed(
                        true, beforePacket.type, beforePacket.imitater,
                        beforePacket.timesUsed, beforePacket.offsetX,
                        afterPacket.present, afterPacket.type, afterPacket.imitater,
                        afterPacket.timesUsed, afterPacket.offsetX, afterPacket.refreshing);
                    const bool rollingPlant = std::any_of(
                        current.plants.begin(), current.plants.end(),
                        [&](const PlantView& plant) {
                            return initialPlants.find(plant.id) == initialPlants.end() &&
                                   plant.type == card->type && plant.row + 1 == command.row;
                        });
                    if (packetUsed && rollingPlant) return true;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 10) == WAIT_OBJECT_0) break;
            }
            reason = "bowling packet consumption and rolling plant were not both observed";
            return false;
        }
        if (command.special == "cob_fire") {
            if (!ValidCell(command, rows) || !ValidCell(command, rows, true)) {
                reason = "cob cannon source or destination is invalid";
                return false;
            }
            const bool readySource = std::any_of(semanticBoard.plants.begin(), semanticBoard.plants.end(),
                [&](const PlantView& plant) {
                    return plant.type == 47 && plant.state == 37 && plant.row + 1 == command.row &&
                           plant.column + 1 == command.column;
                });
            if (!readySource) {
                reason = "cob cannon source is absent or reloading";
                return false;
            }
            const auto source = std::find_if(semanticBoard.plants.begin(), semanticBoard.plants.end(),
                [&](const PlantView& plant) {
                    return plant.id == static_cast<uint32_t>(command.targetId) && plant.type == 47 &&
                           plant.state == 37 && plant.row + 1 == command.row &&
                           plant.column + 1 == command.column;
                });
            if (command.targetId < 0 || source == semanticBoard.plants.end()) {
                reason = "cob cannon target id is absent or reloading";
                return false;
            }
            if (!apply) return true;
            if (!clickCell(command.row, command.column)) {
                reason = "failed to select cob cannon";
                return false;
            }
            const ULONGLONG aimDeadline = GetTickCount64() + 3000;
            bool readyToAim = false;
            while (ActionCurrent(command.epoch) && GetTickCount64() < aimDeadline) {
                int delay = -1;
                uintptr_t cursor = 0;
                int cursorType = -1;
                SafeRead(board + pvz::board::cobCannonCursorDelay, delay);
                if (SafeRead(board + pvz::board::cursorObject, cursor) && cursor) {
                    SafeRead(cursor + 0x30, cursorType);
                }
                if (delay <= 0 && cursorType == 8) {
                    readyToAim = true;
                    break;
                }
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 20) == WAIT_OBJECT_0) break;
            }
            if (!readyToAim || !clickCell(command.toRow, command.toColumn)) {
                reason = "cob cannon did not become ready to aim";
                return false;
            }
            const ULONGLONG firedDeadline = GetTickCount64() + 2000;
            while (ActionCurrent(command.epoch) && GetTickCount64() < firedDeadline) {
                BoardView current;
                if (ReadBoard(lawnApp, mode, current) &&
                    std::none_of(current.plants.begin(), current.plants.end(),
                        [&](const PlantView& plant) {
                            return plant.id == static_cast<uint32_t>(command.targetId) && plant.state == 37;
                        })) return true;
                if (g_stopEvent && WaitForSingleObject(g_stopEvent, 20) == WAIT_OBJECT_0) break;
            }
            reason = "cob cannon source remained ready after target input";
            return false;
        }
        reason = "unknown special action";
        return false;
    }
    reason = "unknown action kind";
    return false;
}

int PngEncoderClsid(CLSID& clsid) {
    UINT count = 0;
    UINT bytes = 0;
    if (Gdiplus::GetImageEncodersSize(&count, &bytes) != Gdiplus::Ok || !bytes) return -1;
    std::vector<BYTE> storage(bytes);
    auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(storage.data());
    if (Gdiplus::GetImageEncoders(count, bytes, encoders) != Gdiplus::Ok) return -1;
    for (UINT index = 0; index < count; ++index) {
        if (wcscmp(encoders[index].MimeType, L"image/png") == 0) {
            clsid = encoders[index].Clsid;
            return 0;
        }
    }
    return -1;
}

bool CaptureWindow(std::vector<BYTE>& png, int& width, int& height, std::string& reason) {
    HWND window = GameWindow();
    RECT rect{};
    if (!window || !GetClientRect(window, &rect)) {
        reason = "Plants vs. Zombies window is not available";
        return false;
    }
    width = rect.right - rect.left;
    height = rect.bottom - rect.top;
    // 窗口 DC 只读得到屏幕上的那部分像素:有一角在屏幕外就会截出黑边。半张假画面
    // 比没有画面更坏,所以这里说清楚量到了什么,由上层等自动修正把窗口摆回来再来。
    const ManagedWindowPresentation presentation = ReadManagedWindowPresentation(window);
    if (!presentation.managed || !ManagedClientSize(width, height) || !presentation.onScreen) {
        reason = presentation.minimized
            ? std::string("Plants vs. Zombies window is minimized")
            : "Plants vs. Zombies window is not presentable: client " +
              std::to_string(presentation.clientWidth) + "x" +
              std::to_string(presentation.clientHeight) +
              (presentation.managed ? "" : " (needs Per-Monitor V2 at exactly 800x600)") +
              (presentation.onScreen ? "" : ", not fully inside one monitor");
        return false;
    }
    HDC windowDc = GetDC(window);
    HDC memoryDc = CreateCompatibleDC(windowDc);
    HBITMAP bitmap = CreateCompatibleBitmap(windowDc, width, height);
    HGDIOBJ old = bitmap && memoryDc ? SelectObject(memoryDc, bitmap) : nullptr;
    bool copied = old && PrintWindow(window, memoryDc, PW_CLIENTONLY) != FALSE;
    if (!copied && old) copied = BitBlt(memoryDc, 0, 0, width, height, windowDc, 0, 0, SRCCOPY) != FALSE;
    if (windowDc) ReleaseDC(window, windowDc);
    if (!copied) {
        if (old) SelectObject(memoryDc, old);
        if (bitmap) DeleteObject(bitmap);
        if (memoryDc) DeleteDC(memoryDc);
        reason = "window capture failed";
        return false;
    }

    Gdiplus::Bitmap image(bitmap, nullptr);
    CLSID encoder{};
    IStream* stream = nullptr;
    bool encoded = PngEncoderClsid(encoder) == 0 &&
                   SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) &&
                   image.Save(stream, &encoder, nullptr) == Gdiplus::Ok;
    if (encoded) {
        HGLOBAL global = nullptr;
        encoded = SUCCEEDED(GetHGlobalFromStream(stream, &global));
        if (encoded) {
            const SIZE_T size = GlobalSize(global);
            const void* data = GlobalLock(global);
            encoded = data && size > 0;
            if (encoded) png.assign(static_cast<const BYTE*>(data), static_cast<const BYTE*>(data) + size);
            if (data) GlobalUnlock(global);
        }
    }
    if (stream) stream->Release();
    SelectObject(memoryDc, old);
    DeleteObject(bitmap);
    DeleteDC(memoryDc);
    if (!encoded) reason = "PNG encoding failed";
    return encoded;
}

std::string Base64(const std::vector<BYTE>& bytes) {
    DWORD size = 0;
    if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()),
                              CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &size)) return {};
    std::string output(size, '\0');
    if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()),
                              CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, output.data(), &size)) return {};
    if (size && output[size - 1] == '\0') --size;
    output.resize(size);
    return output;
}

void ClearOutgoing();

void DisconnectPipe(HANDLE pipe) {
    AcquireSRWLockExclusive(&g_pipeLock);
    if (g_pipe == pipe) {
        g_pipe = INVALID_HANDLE_VALUE;
        g_pipeHello.store(false);
        CloseHandle(pipe);
    }
    ReleaseSRWLockExclusive(&g_pipeLock);
    ClearOutgoing();
}

void ClearOutgoing() {
    AcquireSRWLockExclusive(&g_sendLock);
    g_outgoingLines.clear();
    g_outgoingBytes = 0;
    const bool abandonedStop = g_stopAfterSequence.exchange(0) != 0;
    ReleaseSRWLockExclusive(&g_sendLock);
    if (abandonedStop && (!g_stopEvent || WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0)) {
        g_acceptCommands.store(true);
    }
}

uint64_t QueueLineTracked(const std::string& line, bool beforeHello, bool stopAfter = false) {
    std::string framed = line;
    framed.push_back('\n');
    AcquireSRWLockShared(&g_pipeLock);
    const bool connected = g_pipe != INVALID_HANDLE_VALUE && (beforeHello || g_pipeHello.load());
    ReleaseSRWLockShared(&g_pipeLock);
    if (!connected) return 0;
    constexpr size_t maxQueuedBytes = 12 * 1024 * 1024;
    uint64_t sequence = 0;
    AcquireSRWLockExclusive(&g_sendLock);
    const bool room = framed.size() <= maxQueuedBytes - std::min(g_outgoingBytes, maxQueuedBytes);
    if (room) {
        sequence = ++g_nextOutgoingSequence;
        g_outgoingBytes += framed.size();
        if (stopAfter) g_stopAfterSequence.store(sequence);
        g_outgoingLines.push_back({std::move(framed), sequence});
    }
    ReleaseSRWLockExclusive(&g_sendLock);
    return sequence;
}

bool QueueLine(const std::string& line, bool beforeHello) {
    return QueueLineTracked(line, beforeHello) != 0;
}

uint64_t QueueResultFencePair(const std::string& result, const std::string& snapshot,
                              bool stopAfter) {
    std::string framedResult = result;
    std::string framedSnapshot = snapshot;
    framedResult.push_back('\n');
    framedSnapshot.push_back('\n');
    AcquireSRWLockShared(&g_pipeLock);
    const bool connected = g_pipe != INVALID_HANDLE_VALUE && g_pipeHello.load();
    ReleaseSRWLockShared(&g_pipeLock);
    if (!connected) return 0;
    constexpr size_t maxQueuedBytes = 12 * 1024 * 1024;
    const size_t added = framedResult.size() + framedSnapshot.size();
    uint64_t fenceSequence = 0;
    AcquireSRWLockExclusive(&g_sendLock);
    const bool room = added <= maxQueuedBytes - std::min(g_outgoingBytes, maxQueuedBytes);
    if (room) {
        const uint64_t resultSequence = ++g_nextOutgoingSequence;
        fenceSequence = ++g_nextOutgoingSequence;
        g_outgoingBytes += added;
        g_outgoingLines.push_back({std::move(framedResult), resultSequence});
        g_outgoingLines.push_back({std::move(framedSnapshot), fenceSequence});
        if (stopAfter) g_stopAfterSequence.store(fenceSequence);
    }
    ReleaseSRWLockExclusive(&g_sendLock);
    return fenceSequence;
}

bool SendLine(const std::string& line) {
    return QueueLine(line, false);
}

bool FlushOutgoing(HANDLE pipe) {
    while (true) {
        OutgoingLine outgoing;
        AcquireSRWLockExclusive(&g_sendLock);
        if (!g_outgoingLines.empty()) {
            outgoing = std::move(g_outgoingLines.front());
            g_outgoingLines.pop_front();
            g_outgoingBytes -= outgoing.framed.size();
        }
        ReleaseSRWLockExclusive(&g_sendLock);
        if (outgoing.framed.empty()) return true;
        size_t offset = 0;
        while (offset < outgoing.framed.size()) {
            if (g_stopEvent && WaitForSingleObject(g_stopEvent, 0) == WAIT_OBJECT_0) return false;
            AcquireSRWLockShared(&g_pipeLock);
            const bool current = g_pipe == pipe;
            ReleaseSRWLockShared(&g_pipeLock);
            if (!current) return false;
            DWORD written = 0;
            if (!WriteFile(pipe, outgoing.framed.data() + offset,
                           static_cast<DWORD>(outgoing.framed.size() - offset), &written, nullptr) ||
                !written) {
                if (g_stopAfterSequence.load() == outgoing.sequence) {
                    g_stopAfterSequence.store(0);
                }
                return false;
            }
            offset += written;
        }
        if (g_stopAfterSequence.load() == outgoing.sequence) SetEvent(g_stopEvent);
    }
}

void SendAck(const std::string& id, bool accepted, const std::string& reason = {}) {
    std::string line = "{\"type\":\"ack\",\"protocol\":2,\"id\":";
    AppendString(line, id);
    line += ",\"accepted\":";
    AppendBool(line, accepted);
    if (!reason.empty()) {
        line += ",\"reason\":";
        AppendString(line, reason);
    }
    line.push_back('}');
    SendLine(line);
}

uint64_t SendResult(const std::string& id, const char* outcome, const std::string& reason = {},
                    const char* effect = nullptr, bool stopAfter = false,
                    const ActionBatchMetrics* batch = nullptr,
                    const PlantPlacement* placement = nullptr) {
    AcquireSRWLockExclusive(&g_semanticSendLock);
    const ULONG revision = g_revision.load();
    std::string line = "{\"type\":\"result\",\"protocol\":2,\"id\":";
    AppendString(line, id);
    line += ",\"outcome\":";
    AppendString(line, outcome);
    line += ",\"revision\":";
    AppendInt(line, revision);
    if (!reason.empty()) {
        line += ",\"reason\":";
        AppendString(line, reason);
    }
    if (effect) {
        line += ",\"effect\":";
        AppendString(line, effect);
    }
    if (placement && std::strcmp(outcome, "executed") == 0) {
        AppendPlantPlacement(line, *placement);
    }
    if (batch && batch->present) {
        line += ",\"batch\":{\"requested\":";
        AppendInt(line, batch->requested);
        line += ",\"attempted\":";
        AppendInt(line, batch->attempted);
        line += ",\"released\":";
        AppendInt(line, batch->released);
        line += ",\"verified\":";
        AppendInt(line, batch->verified);
        line += ",\"stale\":";
        AppendInt(line, batch->stale);
        line += ",\"scopeStopped\":";
        AppendBool(line, batch->scopeStopped);
        line.push_back('}');
    }
    line.push_back('}');
    uint64_t fenceSequence = 0;
    const bool executed = std::strcmp(outcome, "executed") == 0;
    const bool cancelled = std::strcmp(outcome, "cancelled") == 0;
    if (executed || cancelled) {
        const std::string snapshot = BuildSnapshot();
        fenceSequence = QueueResultFencePair(line, snapshot, executed && stopAfter);
    } else {
        fenceSequence = QueueLineTracked(line, false);
    }
    ReleaseSRWLockExclusive(&g_semanticSendLock);
    return fenceSequence;
}

bool SendSnapshot() {
    AcquireSRWLockExclusive(&g_semanticSendLock);
    const bool queued = SendLine(BuildSnapshot());
    ReleaseSRWLockExclusive(&g_semanticSendLock);
    return queued;
}

void SendLog(const char* level, const std::string& message) {
    std::string line = "{\"type\":\"log\",\"protocol\":2,\"level\":";
    AppendString(line, level);
    line += ",\"message\":";
    AppendString(line, message);
    line.push_back('}');
    SendLine(line);
}

bool SendHello() {
    std::wstring ownerWide;
    AcquireSRWLockShared(&g_ownerLock);
    ownerWide = g_ownerToken;
    ReleaseSRWLockShared(&g_ownerLock);
    std::string owner;
    owner.reserve(ownerWide.size());
    for (wchar_t ch : ownerWide) owner.push_back(static_cast<char>(ch));
    std::string line = "{\"type\":\"hello\",\"protocol\":2,\"pid\":";
    AppendInt(line, GetCurrentProcessId());
    line += ",\"architecture\":\"x86\",\"profile\":";
    AppendString(line, pvz::kProfileName);
    line += ",\"executableSha256\":";
    AppendString(line, g_validation.hash);
    line += ",\"executableVersion\":";
    AppendString(line, g_validation.version);
    line += ",\"supported\":";
    AppendBool(line, g_validation.supported);
    line += ",\"ownerToken\":";
    AppendString(line, owner);
    if (!g_validation.supported) {
        line += ",\"reason\":";
        AppendString(line, g_validation.reason);
    }
    line.push_back('}');
    return QueueLine(line, true);
}

bool ParseCommand(const std::string& line, Command& command, std::string& reason) {
    std::string type;
    int protocol = 0;
    if (!pvz::json::String(line, "type", type) || type != "command" ||
        !pvz::json::Integer(line, "protocol", protocol) || protocol != pvz::kProtocol ||
        !pvz::json::String(line, "id", command.id) || command.id.empty() || command.id.size() > 128 ||
        !pvz::json::String(line, "kind", command.kind)) {
        reason = "malformed command envelope";
        return false;
    }
    pvz::json::String(line, "target", command.target);
    pvz::json::String(line, "action", command.special);
    pvz::json::String(line, "name", command.name);
    if (command.kind.empty() || command.kind.size() > 128 || command.target.size() > 128 ||
        command.special.size() > 128 || command.name.size() > 128) {
        reason = "command strings exceed the 128-character limit";
        return false;
    }
    pvz::json::Integer(line, "pollHz", command.pollHz);
    pvz::json::Integer(line, "cursorMinMs", command.cursorMinMs);
    pvz::json::Integer(line, "cursorMaxMs", command.cursorMaxMs);
    pvz::json::Integer(line, "seed", command.seed);
    pvz::json::Integer(line, "imitates", command.imitates);
    pvz::json::Integer(line, "slot", command.slot);
    pvz::json::Integer(line, "targetId", command.targetId);
    pvz::json::Integer(line, "row", command.row);
    pvz::json::Integer(line, "column", command.column);
    if (!ParsePlantSelector(line, command, reason)) return false;
    pvz::json::Integer(line, "toRow", command.toRow);
    pvz::json::Integer(line, "toColumn", command.toColumn);
    pvz::json::Integer(line, "x", command.x);
    pvz::json::Integer(line, "y", command.y);
    pvz::json::Integer(line, "expectedRevision", command.expectedRevision);
    pvz::json::Integer(line, "inputEpoch", command.expectedInputEpoch);
    pvz::json::Integer(line, "menuContext", command.menuContext);
    const bool expectedLevelProvided = line.find("\"expectedLevel\"") != std::string::npos;
    if (expectedLevelProvided &&
        (!pvz::json::Integer(line, "expectedLevel", command.expectedLevel) ||
         command.expectedLevel < 0)) {
        reason = "expectedLevel must be a nonnegative integer";
        return false;
    }
    pvz::json::Integer(line, "expectedCardType", command.expectedCardType);
    if (line.find("\"expectedCardImitates\"") != std::string::npos &&
        !pvz::json::NullOrInteger(line, "expectedCardImitates", command.expectedCardImitates)) {
        reason = "expectedCardImitates must be an integer or null";
        return false;
    }
    if (line.find("\"ids\"") != std::string::npos &&
        !pvz::json::IntegerArray(line, "ids", command.ids)) {
        reason = "collectible ids must be an array of at most 128 integers";
        return false;
    }
    if (command.ids.size() > 128 ||
        std::any_of(command.ids.begin(), command.ids.end(), [](int id) { return id < 0; })) {
        reason = "collectible ids are outside the supported range";
        return false;
    }
    std::unordered_set<int> uniqueIds(command.ids.begin(), command.ids.end());
    if (uniqueIds.size() != command.ids.size()) {
        reason = "collectible ids must be unique";
        return false;
    }
    const bool targetIdsProvided = line.find("\"targetIds\"") != std::string::npos;
    if (targetIdsProvided &&
        !pvz::json::IntegerArray(line, "targetIds", command.targetIds)) {
        reason = "whack targetIds must be an integer array";
        return false;
    }
    if (targetIdsProvided && (command.targetIds.empty() || command.targetIds.size() > 32 ||
        std::any_of(command.targetIds.begin(), command.targetIds.end(),
            [](int id) { return id < 0; }))) {
        reason = "whack targetIds must contain 1 to 32 nonnegative integers";
        return false;
    }
    if (targetIdsProvided && !expectedLevelProvided) {
        reason = "whack targetIds require expectedLevel";
        return false;
    }
    std::unordered_set<int> uniqueTargetIds(
        command.targetIds.begin(), command.targetIds.end());
    if (uniqueTargetIds.size() != command.targetIds.size()) {
        reason = "whack targetIds must be unique";
        return false;
    }
    return true;
}

void QueueCommand(Command&& command) {
    const std::string id = command.id;
    // Read requests fence a new sample without joining or cancelling the input queue.
    if (command.kind == "snapshot") {
        SendAck(id, true);
        SendResult(id, "executed");
        return;
    }
    const bool control = command.kind == "cancel" || command.kind == "detach" ||
                         command.kind == "shutdown";
    std::string reason;
    if (!control && command.expectedInputEpoch >= 0 &&
        static_cast<ULONGLONG>(command.expectedInputEpoch) != g_actionEpoch.load()) {
        SendAck(id, false, "input epoch is stale");
        return;
    }
    if (command.kind == "capture") {
        uintptr_t lawnApp = 0;
        if (!ReadLawnApp(lawnApp, &reason) || !GameWindow()) {
            if (reason.empty()) reason = "Plants vs. Zombies window is not ready";
            SendAck(id, false, reason);
            return;
        }
    } else if (!ExecuteAction(command, reason, false)) {
        SendAck(id, false, reason);
        return;
    }

    std::vector<std::string> cancelled;
    bool queued = false;
    EnterCriticalSection(&g_commandLock);
    if (!g_acceptCommands.load()) {
        LeaveCriticalSection(&g_commandLock);
        SendAck(id, false, "native bridge is stopping");
        return;
    }
    if (g_commandIds.find(id) != g_commandIds.end()) {
        LeaveCriticalSection(&g_commandLock);
        SendAck(id, false, "duplicate command id");
        return;
    }
    if (control) {
        command.epoch = ++g_actionEpoch;
        g_releaseHeldRequested.store(true);
        cancelled.reserve(g_commands.size());
        for (const auto& pending : g_commands) {
            cancelled.push_back(pending.id);
            g_commandIds.erase(pending.id);
        }
        g_commands.clear();
        if (command.kind == "detach" || command.kind == "shutdown") g_acceptCommands.store(false);
    } else {
        command.epoch = g_actionEpoch.load();
    }
    if (g_commands.size() < 256) {
        g_commandIds.insert(id);
        g_commands.push_back(std::move(command));
        queued = true;
    }
    LeaveCriticalSection(&g_commandLock);
    for (const auto& cancelledId : cancelled) SendResult(cancelledId, "cancelled", "cancelled before execution");
    if (!queued) {
        SendAck(id, false, "native action queue is full");
        return;
    }
    SendAck(id, true);
    if (g_commandEvent) SetEvent(g_commandEvent);
}

bool PopCommand(Command& command) {
    EnterCriticalSection(&g_commandLock);
    const bool present = !g_commands.empty();
    if (present) {
        command = std::move(g_commands.front());
        g_commands.pop_front();
        g_activeActionId = command.id;
    }
    LeaveCriticalSection(&g_commandLock);
    return present;
}

void FinishCommand(const std::string& id) {
    EnterCriticalSection(&g_commandLock);
    if (g_activeActionId == id) g_activeActionId.clear();
    g_commandIds.erase(id);
    LeaveCriticalSection(&g_commandLock);
}

void CancelActionsForDisconnect() {
    ++g_actionEpoch;
    g_releaseHeldRequested.store(true);
    EnterCriticalSection(&g_commandLock);
    for (const auto& pending : g_commands) g_commandIds.erase(pending.id);
    g_commands.clear();
    LeaveCriticalSection(&g_commandLock);
    if (g_commandEvent) SetEvent(g_commandEvent);
}

std::wstring CurrentPipeName() {
    AcquireSRWLockShared(&g_pipeLock);
    std::wstring name = g_pipeName;
    ReleaseSRWLockShared(&g_pipeLock);
    if (!name.empty() && name.rfind(L"\\\\.\\pipe\\", 0) != 0) name = L"\\\\.\\pipe\\" + name;
    return name;
}

bool PrepareManagedWorker() {
    if (SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) &&
        AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),
                                     DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return true;
    if (g_stopEvent) SetEvent(g_stopEvent);
    return false;
}

DWORD WINAPI PipeThread(void*) {
    ++g_workerReady;
    if (!PrepareManagedWorker()) return 1;
    while (g_workerReady.load() < 2 && WaitForSingleObject(g_stopEvent, 10) != WAIT_OBJECT_0) {}
    g_validation = ValidateExecutable();
    SetEvent(g_profileReadyEvent);
    while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
        if (!g_internalMouseWindow.load(std::memory_order_acquire)) {
            HWND window = GameWindow();
            if (window) EnsureInternalMouseDispatch(window);
        }
        if (!g_pipeConfigured.load() || !g_runtimeConfigured.load()) {
            HANDLE events[] = {g_stopEvent, g_pipeChangedEvent};
            if (WaitForMultipleObjects(2, events, FALSE, 100) == WAIT_OBJECT_0) break;
            continue;
        }
        const std::wstring name = CurrentPipeName();
        if (name.empty()) {
            HANDLE events[] = {g_stopEvent, g_pipeChangedEvent};
            if (WaitForMultipleObjects(2, events, FALSE, 1000) == WAIT_OBJECT_0) break;
            continue;
        }
        if (!WaitNamedPipeW(name.c_str(), 500)) continue;
        HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) continue;
        AcquireSRWLockExclusive(&g_pipeLock);
        if (g_pipe != INVALID_HANDLE_VALUE) CloseHandle(g_pipe);
        g_pipe = pipe;
        g_pipeHello.store(false);
        ReleaseSRWLockExclusive(&g_pipeLock);
        ClearOutgoing();
        if (!SendHello() || !FlushOutgoing(pipe)) {
            DisconnectPipe(pipe);
            continue;
        }
        g_pipeHello.store(true);

        std::string pending;
        std::array<char, 4096> buffer{};
        ULONGLONG nextSnapshot = 0;
        while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
            if (!FlushOutgoing(pipe)) break;
            const ULONGLONG now = GetTickCount64();
            if (g_pipeHello.load() && now >= nextSnapshot) {
                if (!SendSnapshot()) break;
                const DWORD hz = std::clamp<DWORD>(g_pollHz.load(), 10, 20);
                nextSnapshot = now + std::max<DWORD>(1, 1000 / hz);
            }
            DWORD available = 0;
            if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) break;
            if (!available) {
                if (WaitForSingleObject(g_stopEvent, 5) == WAIT_OBJECT_0) break;
                continue;
            }
            DWORD read = 0;
            const DWORD requested = std::min<DWORD>(available, static_cast<DWORD>(buffer.size()));
            if (!ReadFile(pipe, buffer.data(), requested, &read, nullptr) || !read) break;
            pending.append(buffer.data(), read);
            if (pending.size() > kMaxLine) {
                SendLog("error", "native command line exceeded 1 MiB");
                break;
            }
            size_t newline = 0;
            while ((newline = pending.find('\n')) != std::string::npos) {
                std::string line = pending.substr(0, newline);
                pending.erase(0, newline + 1);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                if (line.empty()) continue;
                Command command;
                std::string reason;
                if (!ParseCommand(line, command, reason)) {
                    if (!command.id.empty()) SendAck(command.id, false, reason);
                    else SendLog("warn", reason);
                    continue;
                }
                QueueCommand(std::move(command));
            }
        }
        if (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) CancelActionsForDisconnect();
        ClearOutgoing();
        DisconnectPipe(pipe);
    }
    return 0;
}

DWORD WINAPI ActionThread(void*) {
    ++g_workerReady;
    if (!PrepareManagedWorker()) return 1;
    HANDLE events[] = {g_stopEvent, g_commandEvent};
    while (WaitForSingleObject(g_stopEvent, 0) != WAIT_OBJECT_0) {
        if (WaitForMultipleObjects(2, events, FALSE, INFINITE) == WAIT_OBJECT_0) break;
        ReleaseHeldIfRequested();
        Command command;
        while (PopCommand(command)) {
            g_inputPosted = false;
            std::string reason;
            const bool control = command.kind == "cancel" || command.kind == "detach" ||
                                 command.kind == "shutdown";
            if (!control && command.epoch != g_actionEpoch.load()) {
                ReleaseHeldIfRequested();
                SendResult(command.id, "cancelled", "input epoch changed before execution");
                FinishCommand(command.id);
                continue;
            }
            if (command.kind == "capture") {
                Gdiplus::GdiplusStartupInput startupInput;
                ULONG_PTR gdiplusToken = 0;
                const bool gdiplusReady = Gdiplus::GdiplusStartup(
                    &gdiplusToken, &startupInput, nullptr) == Gdiplus::Ok;
                uintptr_t lawnApp = 0;
                bool accepted = gdiplusReady && ReadLawnApp(lawnApp, &reason);
                if (!gdiplusReady) reason = "GDI+ initialization failed";
                std::vector<BYTE> png;
                int width = 0;
                int height = 0;
                if (accepted) accepted = CaptureWindow(png, width, height, reason);
                std::string base64;
                if (accepted) {
                    base64 = Base64(png);
                    if (base64.empty()) {
                        accepted = false;
                        reason = "base64 encoding failed";
                    }
                }
                if (accepted) {
                    std::string frame = "{\"type\":\"frame\",\"protocol\":2,\"id\":";
                    AppendString(frame, command.id);
                    frame += ",\"mime\":\"image/png\",\"base64\":";
                    AppendString(frame, base64);
                    frame += ",\"width\":";
                    AppendInt(frame, width);
                    frame += ",\"height\":";
                    AppendInt(frame, height);
                    frame.push_back('}');
                    SendLine(frame);
                }
                SendResult(command.id, accepted ? "executed" : "rejected", reason);
                if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
                FinishCommand(command.id);
                continue;
            }
            bool cancelledByAction = false;
            ActionBatchMetrics batchMetrics;
            PlantPlacement placement;
            bool accepted = ExecuteAction(
                command, reason, true, &placement, &cancelledByAction, &batchMetrics);
            if (command.epoch != g_actionEpoch.load()) ReleaseHeldIfRequested();
            const bool terminal = command.kind == "detach";
            if (accepted && command.kind == "shutdown") {
                HWND window = GameWindow();
                if (!window || !PostGameMessage(window, WM_CLOSE, 0, 0)) {
                    accepted = false;
                    reason = "failed to post the game close request";
                } else {
                    const ULONGLONG deadline = GetTickCount64() + 3000;
                    while (IsWindow(window) && GetTickCount64() < deadline) {
                        if (g_stopEvent && WaitForSingleObject(g_stopEvent, 20) == WAIT_OBJECT_0) break;
                    }
                    if (IsWindow(window)) {
                        accepted = false;
                        reason = "game window remained open after the close request";
                    }
                }
            }
            if (command.kind == "shutdown") g_acceptCommands.store(true);
            const bool stopAfter = accepted && terminal;
            const char* effect = nullptr;
            if (accepted && command.kind == "plant") {
                effect = "card_consumed";
            } else if (accepted && command.kind == "shovel") {
                effect = "shovel_applied";
            } else if (accepted && command.kind == "profile_create") {
                effect = "profile_created";
            } else if (accepted && command.kind == "collect") {
                effect = "collectibles_collected";
            } else if (accepted && command.kind == "special") {
                if (command.special == "whack") effect = "target_changed";
                else if (command.special == "bowling") effect = "bowling_launched";
                else if (command.special == "launch") effect = "usable_seed_consumed";
                else if (command.special == "beghouled_buy") effect = "beghouled_purchase";
                else if (command.special == "zen_water" ||
                         command.special == "zen_fertilize" ||
                         command.special == "zen_bug_spray" ||
                         command.special == "zen_phonograph" ||
                         command.special == "zen_chocolate") effect = "zen_care_applied";
                else if (command.special == "zen_next_garden") effect = "garden_changed";
                else if (command.special == "tree_feed") effect = "tree_fed";
            }
            const uint64_t resultSequence = SendResult(
                command.id, accepted ? "executed" :
                cancelledByAction || g_inputPosted || command.epoch != g_actionEpoch.load()
                    ? "cancelled" : "rejected",
                reason, effect, stopAfter, batchMetrics.present ? &batchMetrics : nullptr,
                accepted && placement.targetId ? &placement : nullptr);
            FinishCommand(command.id);
            if (stopAfter) {
                if (!resultSequence) {
                    g_stopAfterSequence.store(0);
                    g_acceptCommands.store(true);
                }
                break;
            }
        }
    }
    return 0;
}

void ClosePipeForStop() {
    AcquireSRWLockExclusive(&g_pipeLock);
    HANDLE pipe = g_pipe;
    g_pipe = INVALID_HANDLE_VALUE;
    g_pipeHello.store(false);
    ReleaseSRWLockExclusive(&g_pipeLock);
    if (pipe != INVALID_HANDLE_VALUE) {
        CancelIoEx(pipe, nullptr);
        CloseHandle(pipe);
    }
    ClearOutgoing();
}

DWORD WINAPI BootstrapThread(void*) {
    InitializeCriticalSection(&g_commandLock);
    g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    g_pipeChangedEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    g_commandEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    g_profileReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (g_stopEvent && g_pipeChangedEvent && g_commandEvent && g_profileReadyEvent) {
        if (!LoadOwnerToken()) {
            SetEvent(g_stopEvent);
        }
        if (!g_pipeConfigured.load()) {
            wchar_t inherited[kMaxPipeName]{};
            if (GetEnvironmentVariableW(kPipeEnvironment, inherited,
                                        static_cast<DWORD>(std::size(inherited))) > 0) {
                AcquireSRWLockExclusive(&g_pipeLock);
                wcscpy_s(g_pipeName, inherited);
                ReleaseSRWLockExclusive(&g_pipeLock);
                g_pipeConfigured.store(true);
            }
        }
    }

    HANDLE workers[2] = {};
    if (g_stopEvent && g_pipeChangedEvent && g_commandEvent && g_profileReadyEvent) {
        workers[0] = CreateThread(nullptr, 0, ActionThread, nullptr, 0, nullptr);
        workers[1] = CreateThread(nullptr, 0, PipeThread, nullptr, 0, nullptr);
    }
    const bool started = workers[0] && workers[1];
    if (started) {
        WaitForSingleObject(g_stopEvent, INFINITE);
    } else if (g_stopEvent) {
        SetEvent(g_stopEvent);
    }

    g_acceptCommands.store(false);
    g_cursorOverlayEnabled.store(false);
    g_cursorOverlayButtonDown.store(false);
    ++g_actionEpoch;
    if (g_profileReadyEvent) SetEvent(g_profileReadyEvent);
    if (g_pipeChangedEvent) SetEvent(g_pipeChangedEvent);
    if (g_commandEvent) SetEvent(g_commandEvent);
    for (HANDLE worker : workers) {
        if (worker) CancelSynchronousIo(worker);
    }
    ClosePipeForStop();
    for (HANDLE worker : workers) {
        if (!worker) continue;
        WaitForSingleObject(worker, INFINITE);
        CloseHandle(worker);
    }
    if (g_profileReadyEvent) CloseHandle(g_profileReadyEvent);
    if (g_commandEvent) CloseHandle(g_commandEvent);
    if (g_pipeChangedEvent) CloseHandle(g_pipeChangedEvent);
    if (g_stopEvent) CloseHandle(g_stopEvent);
    g_profileReadyEvent = nullptr;
    g_commandEvent = nullptr;
    g_pipeChangedEvent = nullptr;
    g_stopEvent = nullptr;
    DeleteCriticalSection(&g_commandLock);
    FreeLibraryAndExitThread(g_module, started ? 0 : 1);
}

}  // namespace

extern "C" __declspec(dllexport) DWORD WINAPI CorticoPvzSetPipeW(const wchar_t* pipeName) {
    wchar_t copy[kMaxPipeName]{};
    __try {
        if (!pipeName || !pipeName[0]) return 0;
        wcsncpy_s(copy, pipeName, _TRUNCATE);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
    AcquireSRWLockExclusive(&g_pipeLock);
    wcscpy_s(g_pipeName, copy);
    HANDLE previous = g_pipe;
    g_pipe = INVALID_HANDLE_VALUE;
    g_pipeHello.store(false);
    ReleaseSRWLockExclusive(&g_pipeLock);
    if (previous != INVALID_HANDLE_VALUE) {
        CancelIoEx(previous, nullptr);
        CloseHandle(previous);
    }
    ClearOutgoing();
    g_pipeConfigured.store(true);
    if (g_pipeChangedEvent) SetEvent(g_pipeChangedEvent);
    return 1;
}

extern "C" __declspec(dllexport) DWORD WINAPI CorticoPvzPrepareManagedWindow(void*) {
    SetLastError(0);
    if (!SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
        const DWORD error = GetLastError();
        return error ? 0x80000000u | error : 0;
    }
    return AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),
                                        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) ? 1 : 0;
}

extern "C" __declspec(dllexport) DWORD WINAPI CorticoPvzPrepareFocusLossPolicy(void*) {
    AcquireSRWLockExclusive(&g_profilePatchLock);
    const Validation validation = ValidateExecutableUnlocked();
    const bool prepared = validation.supported && PrepareFocusLossPolicy() &&
                          InstallCursorOverlayHooks() &&
                          InstallInternalMouseCaptureBypass();
    ReleaseSRWLockExclusive(&g_profilePatchLock);
    return prepared ? 1 : 0;
}

extern "C" __declspec(dllexport) DWORD WINAPI CorticoPvzConfigure(const DWORD* values) {
    DWORD pollHz = 0;
    DWORD cursorMinMs = 0;
    DWORD cursorMaxMs = 0;
    __try {
        pollHz = values[0];
        cursorMinMs = values[1];
        cursorMaxMs = values[2];
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
    if (pollHz < 10 || pollHz > 20 || cursorMinMs > cursorMaxMs || cursorMaxMs > 2000) return 0;
    g_pollHz.store(pollHz);
    g_cursorMinMs.store(cursorMinMs);
    g_cursorMaxMs.store(cursorMaxMs);
    g_runtimeConfigured.store(true);
    if (g_pipeChangedEvent) SetEvent(g_pipeChangedEvent);
    return 1;
}

extern "C" __declspec(dllexport) DWORD WINAPI CorticoPvzVerifyOwnerW(const wchar_t* token) {
    wchar_t candidate[33]{};
    __try {
        if (!token || wcsnlen_s(token, std::size(candidate)) != 32) return 0;
        wcscpy_s(candidate, token);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
    if (!ValidOwnerToken(candidate)) return 0;
    wchar_t expected[33]{};
    AcquireSRWLockShared(&g_ownerLock);
    wcscpy_s(expected, g_ownerToken);
    ReleaseSRWLockShared(&g_ownerLock);
    if (!expected[0] && !LoadOwnerToken()) return 0;
    if (!expected[0]) {
        AcquireSRWLockShared(&g_ownerLock);
        wcscpy_s(expected, g_ownerToken);
        ReleaseSRWLockShared(&g_ownerLock);
    }
    return wcscmp(candidate, expected) == 0 ? 1 : 0;
}

extern "C" __declspec(dllexport) DWORD WINAPI CorticoPvzVerifyBuildW(const wchar_t* buildId) {
    wchar_t candidate[64]{};
    __try {
        if (!buildId || wcsnlen_s(buildId, std::size(candidate)) !=
                            std::size(pvz::kImplantBuildId) - 1) return 0;
        wcscpy_s(candidate, buildId);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
    return wcscmp(candidate, pvz::kImplantBuildId) == 0 ? 1 : 0;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void*) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    g_module = instance;
    DisableThreadLibraryCalls(instance);
    HANDLE bootstrap = CreateThread(nullptr, 0, BootstrapThread, nullptr, 0, nullptr);
    if (!bootstrap) return FALSE;
    CloseHandle(bootstrap);
    return TRUE;
}
