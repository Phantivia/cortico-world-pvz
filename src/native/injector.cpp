#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

#include "profile.h"

#pragma comment(lib, "advapi32.lib")

#if !defined(_M_IX86)
#error cortico-pvz-injector must be compiled for x86
#endif

namespace {

HANDLE g_suspendedProcess = nullptr;
HANDLE g_suspendedThread = nullptr;
std::wstring g_writtenOwnershipFile;

struct Options {
    enum class Mode { Launch, Attach } mode = Mode::Launch;
    std::wstring executable;
    std::wstring dll;
    std::wstring pipe;
    std::wstring arguments;
    std::wstring ownerToken;
    std::wstring ownershipFile;
    std::wstring creationTime;
    DWORD pid = 0;
    DWORD resumeThread = 0;
    DWORD pollHz = 15;
    DWORD cursorMinMs = 120;
    DWORD cursorMaxMs = 420;
};

constexpr wchar_t kOwnerEnvironment[] = L"CORTICO_PVZ_OWNER_TOKEN";

[[noreturn]] void Fail(const std::wstring& message, DWORD error);

bool ValidOwnerToken(const std::wstring& token) {
    if (token.size() != 32) return false;
    return std::all_of(token.begin(), token.end(), [](wchar_t ch) {
        return (ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f');
    });
}

std::wstring GenerateOwnerToken() {
    HCRYPTPROV provider = 0;
    std::array<BYTE, 16> bytes{};
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
        !CryptGenRandom(provider, static_cast<DWORD>(bytes.size()), bytes.data())) {
        const DWORD error = GetLastError();
        if (provider) CryptReleaseContext(provider, 0);
        Fail(L"cannot generate owner token", error);
    }
    CryptReleaseContext(provider, 0);
    static constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring token;
    token.reserve(bytes.size() * 2);
    for (BYTE value : bytes) {
        token.push_back(hex[value >> 4]);
        token.push_back(hex[value & 0x0F]);
    }
    return token;
}

std::wstring Win32Message(DWORD error) {
    wchar_t* raw = nullptr;
    const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                        FORMAT_MESSAGE_IGNORE_INSERTS;
    const DWORD length = FormatMessageW(flags, nullptr, error, 0,
                                        reinterpret_cast<wchar_t*>(&raw), 0, nullptr);
    std::wstring message = length && raw ? std::wstring(raw, length) : L"unknown error";
    if (raw) LocalFree(raw);
    while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n')) {
        message.pop_back();
    }
    return message;
}

[[noreturn]] void Fail(const std::wstring& message, DWORD error = ERROR_SUCCESS) {
    if (g_suspendedProcess) {
        TerminateProcess(g_suspendedProcess, 1);
        if (g_suspendedThread) CloseHandle(g_suspendedThread);
        CloseHandle(g_suspendedProcess);
        g_suspendedThread = nullptr;
        g_suspendedProcess = nullptr;
    }
    if (error == ERROR_SUCCESS) {
        fwprintf(stderr, L"cortico-pvz-injector: %ls\n", message.c_str());
    } else {
        fwprintf(stderr, L"cortico-pvz-injector: %ls: %ls (%lu)\n", message.c_str(),
                 Win32Message(error).c_str(), error);
    }
    ExitProcess(1);
}

std::wstring FullPath(const std::wstring& path) {
    const DWORD required = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (!required) Fail(L"cannot resolve path " + path, GetLastError());
    std::vector<wchar_t> buffer(required + 1);
    if (!GetFullPathNameW(path.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr)) {
        Fail(L"cannot resolve path " + path, GetLastError());
    }
    return buffer.data();
}

std::wstring SiblingDll() {
    std::vector<wchar_t> buffer(32768);
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!length || length == buffer.size()) Fail(L"cannot locate injector", GetLastError());
    std::wstring path(buffer.data(), length);
    const size_t slash = path.find_last_of(L"\\/");
    path.resize(slash == std::wstring::npos ? 0 : slash + 1);
    return path + L"pvz-implant.dll";
}

std::wstring Quote(const std::wstring& value) {
    std::wstring result = L"\"";
    unsigned backslashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') {
            ++backslashes;
            continue;
        }
        if (ch == L'\"') {
            result.append(backslashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            backslashes = 0;
            continue;
        }
        result.append(backslashes, L'\\');
        backslashes = 0;
        result.push_back(ch);
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

DWORD ParsePid(const wchar_t* text) {
    wchar_t* end = nullptr;
    const unsigned long value = wcstoul(text, &end, 10);
    if (!text[0] || !end || *end || value == 0 || value > MAXDWORD) {
        Fail(L"invalid pid");
    }
    return static_cast<DWORD>(value);
}

DWORD ParseUnsigned(const wchar_t* text, DWORD minimum, DWORD maximum, const wchar_t* name) {
    wchar_t* end = nullptr;
    const unsigned long value = wcstoul(text, &end, 10);
    if (!text[0] || !end || *end || value < minimum || value > maximum) {
        Fail(std::wstring(L"invalid ") + name);
    }
    return static_cast<DWORD>(value);
}

bool ValidCreationTime(const std::wstring& value) {
    return value.size() == 16 && std::all_of(value.begin(), value.end(), [](wchar_t ch) {
        return (ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f');
    });
}

constexpr bool ManagedClientSize(LONG width, LONG height) {
    return width == pvz::kManagedClientWidth && height == pvz::kManagedClientHeight;
}

constexpr LONG ManagedWindowOrigin(LONG current, LONG workStart, LONG workEnd,
                                   LONG windowExtent) {
    const LONG last = workEnd - windowExtent;
    if (last < workStart) return workStart;
    return current < workStart ? workStart : current > last ? last : current;
}

static_assert(ManagedClientSize(800, 600) && !ManagedClientSize(531, 387));
static_assert(ManagedWindowOrigin(100, 0, 1920, 806) == 100 &&
              ManagedWindowOrigin(-20, 0, 1920, 806) == 0 &&
              ManagedWindowOrigin(1500, 0, 1920, 806) == 1114);

Options ParseOptions(int argc, wchar_t** argv) {
    Options options;
    options.dll = SiblingDll();
    for (int i = 1; i < argc; ++i) {
        const std::wstring arg = argv[i];
        if (arg == L"--") {
            for (++i; i < argc; ++i) {
                if (!options.arguments.empty()) options.arguments.push_back(L' ');
                options.arguments += Quote(argv[i]);
            }
            break;
        }
        if ((arg == L"--exe" || arg == L"--dll" || arg == L"--pipe" || arg == L"--pid" ||
             arg == L"--owner-token" || arg == L"--ownership-file" ||
             arg == L"--resume-thread" || arg == L"--creation-time" ||
             arg == L"--poll-hz" || arg == L"--cursor-min-ms" || arg == L"--cursor-max-ms") &&
            i + 1 >= argc) {
            Fail(L"missing value for " + arg);
        }
        if (arg == L"--exe") options.executable = argv[++i];
        else if (arg == L"--dll") options.dll = argv[++i];
        else if (arg == L"--pipe") options.pipe = argv[++i];
        else if (arg == L"--owner-token") options.ownerToken = argv[++i];
        else if (arg == L"--ownership-file") options.ownershipFile = argv[++i];
        else if (arg == L"--pid") options.pid = ParsePid(argv[++i]);
        else if (arg == L"--resume-thread") options.resumeThread = ParsePid(argv[++i]);
        else if (arg == L"--creation-time") options.creationTime = argv[++i];
        else if (arg == L"--poll-hz") options.pollHz = ParseUnsigned(argv[++i], 10, 20, L"poll frequency");
        else if (arg == L"--cursor-min-ms") options.cursorMinMs = ParseUnsigned(argv[++i], 0, 2000, L"minimum cursor duration");
        else if (arg == L"--cursor-max-ms") options.cursorMaxMs = ParseUnsigned(argv[++i], 0, 2000, L"maximum cursor duration");
        else Fail(L"unknown option " + arg);
    }

    if (options.pipe.empty()) {
        const DWORD needed = GetEnvironmentVariableW(L"CORTICO_PVZ_PIPE", nullptr, 0);
        if (needed > 1) {
            std::vector<wchar_t> value(needed);
            GetEnvironmentVariableW(L"CORTICO_PVZ_PIPE", value.data(), needed);
            options.pipe = value.data();
        }
    }
    if (options.pipe.empty()) Fail(L"CORTICO_PVZ_PIPE or --pipe is required");
    if (options.executable.empty() == (options.pid == 0)) {
        Fail(L"usage: pvz-injector (--exe PATH | --pid PID) --dll PATH --pipe NAME "
             L"[--owner-token TOKEN] [--ownership-file PATH] [--poll-hz 10..20] "
             L"[--cursor-min-ms N] [--cursor-max-ms N] "
             L"[--creation-time FILETIME] [--resume-thread TID] [-- GAME_ARGS]");
    }
    options.mode = options.pid ? Options::Mode::Attach : Options::Mode::Launch;
    if (options.ownerToken.empty()) {
        const DWORD needed = GetEnvironmentVariableW(kOwnerEnvironment, nullptr, 0);
        if (needed > 1) {
            std::vector<wchar_t> value(needed);
            GetEnvironmentVariableW(kOwnerEnvironment, value.data(), needed);
            options.ownerToken = value.data();
        }
    }
    if (options.mode == Options::Mode::Launch && options.ownerToken.empty()) {
        options.ownerToken = GenerateOwnerToken();
    }
    if (!ValidOwnerToken(options.ownerToken)) {
        Fail(options.mode == Options::Mode::Attach
                 ? L"--owner-token is required for attach and must be 32 lowercase hex characters"
                 : L"owner token must be 32 lowercase hex characters");
    }
    if (options.mode == Options::Mode::Attach &&
        (options.creationTime.empty() || !ValidCreationTime(options.creationTime))) {
        Fail(L"attach requires a 16-character lowercase-hex --creation-time");
    }
    if (options.mode == Options::Mode::Launch &&
        (!options.creationTime.empty() || options.resumeThread)) {
        Fail(L"--creation-time and --resume-thread are valid only for attach");
    }
    if (options.cursorMinMs > options.cursorMaxMs) {
        Fail(L"--cursor-min-ms cannot exceed --cursor-max-ms");
    }

    options.dll = FullPath(options.dll);
    if (!options.ownershipFile.empty()) options.ownershipFile = FullPath(options.ownershipFile);
    if (GetFileAttributesW(options.dll.c_str()) == INVALID_FILE_ATTRIBUTES) {
        Fail(L"DLL does not exist: " + options.dll, GetLastError());
    }
    if (!options.executable.empty()) {
        options.executable = FullPath(options.executable);
        if (GetFileAttributesW(options.executable.c_str()) == INVALID_FILE_ATTRIBUTES) {
            Fail(L"executable does not exist: " + options.executable, GetLastError());
        }
    }
    return options;
}

uintptr_t RemoteModuleBase(DWORD pid, const wchar_t* moduleName) {
    DWORD lastError = ERROR_MOD_NOT_FOUND;
    for (int attempt = 0; attempt < 40; ++attempt) {
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if (snapshot != INVALID_HANDLE_VALUE) {
            MODULEENTRY32W entry = {};
            entry.dwSize = sizeof(entry);
            for (BOOL ok = Module32FirstW(snapshot, &entry); ok; ok = Module32NextW(snapshot, &entry)) {
                if (_wcsicmp(entry.szModule, moduleName) == 0) {
                    const uintptr_t result = reinterpret_cast<uintptr_t>(entry.modBaseAddr);
                    CloseHandle(snapshot);
                    return result;
                }
            }
            lastError = GetLastError();
            CloseHandle(snapshot);
        } else {
            lastError = GetLastError();
        }
        if (lastError != ERROR_BAD_LENGTH && lastError != ERROR_PARTIAL_COPY &&
            lastError != ERROR_NO_MORE_FILES && lastError != ERROR_MOD_NOT_FOUND) break;
        Sleep(50);
    }
    SetLastError(lastError);
    return 0;
}

uintptr_t RemoteModuleByPath(DWORD pid, const std::wstring& path) {
    const std::wstring expected = FullPath(path);
    DWORD lastError = ERROR_MOD_NOT_FOUND;
    for (int attempt = 0; attempt < 40; ++attempt) {
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if (snapshot != INVALID_HANDLE_VALUE) {
            MODULEENTRY32W entry{};
            entry.dwSize = sizeof(entry);
            for (BOOL ok = Module32FirstW(snapshot, &entry); ok; ok = Module32NextW(snapshot, &entry)) {
                const std::wstring actual = FullPath(entry.szExePath);
                if (_wcsicmp(actual.c_str(), expected.c_str()) == 0) {
                    const uintptr_t result = reinterpret_cast<uintptr_t>(entry.modBaseAddr);
                    CloseHandle(snapshot);
                    return result;
                }
            }
            lastError = GetLastError();
            CloseHandle(snapshot);
        } else {
            lastError = GetLastError();
        }
        if (lastError != ERROR_BAD_LENGTH && lastError != ERROR_PARTIAL_COPY &&
            lastError != ERROR_NO_MORE_FILES && lastError != ERROR_MOD_NOT_FOUND) break;
        Sleep(50);
    }
    SetLastError(lastError);
    return 0;
}

constexpr size_t kEarlyGateDpiRoutineOffset = 68;
constexpr size_t kEarlyGateArrivedOffset = 72;
constexpr size_t kEarlyGateDpiRequestOffset = 76;
constexpr size_t kEarlyGateDpiCompleteOffset = 80;
constexpr size_t kEarlyGateDpiResultOffset = 84;
constexpr size_t kEarlyGateReleaseOffset = 88;
constexpr size_t kEarlyGateSize = 92;
constexpr std::array<uint8_t, 6> kPinnedEntryBytes{
    0xE8, 0x97, 0x16, 0x01, 0x00, 0xE9};

template <size_t Size>
constexpr void StoreU32(std::array<uint8_t, Size>& bytes, size_t offset, uint32_t value) {
    bytes[offset] = static_cast<uint8_t>(value);
    bytes[offset + 1] = static_cast<uint8_t>(value >> 8);
    bytes[offset + 2] = static_cast<uint8_t>(value >> 16);
    bytes[offset + 3] = static_cast<uint8_t>(value >> 24);
}

template <size_t Size>
constexpr uint32_t LoadU32(const std::array<uint8_t, Size>& bytes, size_t offset) {
    return static_cast<uint32_t>(bytes[offset]) |
           (static_cast<uint32_t>(bytes[offset + 1]) << 8) |
           (static_cast<uint32_t>(bytes[offset + 2]) << 16) |
           (static_cast<uint32_t>(bytes[offset + 3]) << 24);
}

constexpr std::array<uint8_t, 6> AbsoluteJump(uint32_t destination) {
    std::array<uint8_t, 6> bytes{0x68, 0, 0, 0, 0, 0xC3};
    StoreU32(bytes, 1, destination);
    return bytes;
}

constexpr std::array<uint8_t, kEarlyGateSize> EarlyGateImage(
        uint32_t gateAddress, uint32_t entryPoint, uint32_t dpiContext) {
    std::array<uint8_t, kEarlyGateSize> bytes{};
    bytes[0] = 0x9C;
    bytes[1] = 0x60;
    bytes[2] = 0xC7;
    bytes[3] = 0x05;
    StoreU32(bytes, 4, gateAddress + static_cast<uint32_t>(kEarlyGateArrivedOffset));
    StoreU32(bytes, 8, 1);
    bytes[12] = 0xF3;
    bytes[13] = 0x90;
    bytes[14] = 0x83;
    bytes[15] = 0x3D;
    StoreU32(bytes, 16, gateAddress + static_cast<uint32_t>(kEarlyGateDpiRequestOffset));
    bytes[20] = 0;
    bytes[21] = 0x74;
    bytes[22] = 0xF5;
    bytes[23] = 0x68;
    StoreU32(bytes, 24, dpiContext);
    bytes[28] = 0xFF;
    bytes[29] = 0x15;
    StoreU32(bytes, 30, gateAddress + static_cast<uint32_t>(kEarlyGateDpiRoutineOffset));
    bytes[34] = 0xA3;
    StoreU32(bytes, 35, gateAddress + static_cast<uint32_t>(kEarlyGateDpiResultOffset));
    bytes[39] = 0xC7;
    bytes[40] = 0x05;
    StoreU32(bytes, 41, gateAddress + static_cast<uint32_t>(kEarlyGateDpiCompleteOffset));
    StoreU32(bytes, 45, 1);
    bytes[49] = 0xF3;
    bytes[50] = 0x90;
    bytes[51] = 0x83;
    bytes[52] = 0x3D;
    StoreU32(bytes, 53, gateAddress + static_cast<uint32_t>(kEarlyGateReleaseOffset));
    bytes[57] = 0;
    bytes[58] = 0x74;
    bytes[59] = 0xF5;
    bytes[60] = 0x61;
    bytes[61] = 0x9D;
    bytes[62] = 0x68;
    StoreU32(bytes, 63, entryPoint);
    bytes[67] = 0xC3;
    return bytes;
}

constexpr auto kJumpFixture = AbsoluteJump(0x78563412);
constexpr auto kGateFixture = EarlyGateImage(0x12345000, 0x00401000, 0xFFFFFFFC);
static_assert(kJumpFixture[0] == 0x68 && LoadU32(kJumpFixture, 1) == 0x78563412 &&
              kJumpFixture[5] == 0xC3);
static_assert(kPinnedEntryBytes.size() == kJumpFixture.size());
static_assert(kGateFixture[0] == 0x9C && kGateFixture[1] == 0x60 &&
              kGateFixture[2] == 0xC7 && kGateFixture[3] == 0x05 &&
              LoadU32(kGateFixture, 4) == 0x12345000 + kEarlyGateArrivedOffset &&
              LoadU32(kGateFixture, 8) == 1 &&
              kGateFixture[12] == 0xF3 && kGateFixture[13] == 0x90 &&
              kGateFixture[14] == 0x83 && kGateFixture[15] == 0x3D &&
              LoadU32(kGateFixture, 16) == 0x12345000 + kEarlyGateDpiRequestOffset &&
              kGateFixture[20] == 0 && kGateFixture[21] == 0x74 &&
              kGateFixture[22] == 0xF5 && kGateFixture[23] == 0x68 &&
              LoadU32(kGateFixture, 24) == 0xFFFFFFFC &&
              kGateFixture[28] == 0xFF && kGateFixture[29] == 0x15 &&
              LoadU32(kGateFixture, 30) == 0x12345000 + kEarlyGateDpiRoutineOffset &&
              kGateFixture[34] == 0xA3 &&
              LoadU32(kGateFixture, 35) == 0x12345000 + kEarlyGateDpiResultOffset &&
              kGateFixture[39] == 0xC7 && kGateFixture[40] == 0x05 &&
              LoadU32(kGateFixture, 41) == 0x12345000 + kEarlyGateDpiCompleteOffset &&
              LoadU32(kGateFixture, 45) == 1 &&
              kGateFixture[49] == 0xF3 && kGateFixture[50] == 0x90 &&
              kGateFixture[51] == 0x83 && kGateFixture[52] == 0x3D &&
              LoadU32(kGateFixture, 53) == 0x12345000 + kEarlyGateReleaseOffset &&
              kGateFixture[57] == 0 && kGateFixture[58] == 0x74 &&
              kGateFixture[59] == 0xF5 && kGateFixture[60] == 0x61 &&
              kGateFixture[61] == 0x9D && kGateFixture[62] == 0x68 &&
              LoadU32(kGateFixture, 63) == 0x00401000 && kGateFixture[67] == 0xC3);

void WriteRemoteExact(HANDLE process, uintptr_t address, const void* source,
                      size_t bytes, const wchar_t* operation) {
    SIZE_T written = 0;
    if (!WriteProcessMemory(process, reinterpret_cast<void*>(address), source, bytes, &written) ||
        written != bytes) {
        Fail(std::wstring(L"cannot write remote ") + operation, GetLastError());
    }
}

void PatchRemoteCode(HANDLE process, uintptr_t address, const void* source,
                     size_t bytes, const wchar_t* operation) {
    DWORD originalProtection = 0;
    if (!VirtualProtectEx(process, reinterpret_cast<void*>(address), bytes,
                          PAGE_EXECUTE_READWRITE, &originalProtection)) {
        Fail(std::wstring(L"cannot make remote ") + operation + L" writable", GetLastError());
    }
    SIZE_T written = 0;
    if (!WriteProcessMemory(process, reinterpret_cast<void*>(address), source, bytes, &written) ||
        written != bytes) {
        const DWORD error = GetLastError();
        DWORD ignored = 0;
        VirtualProtectEx(process, reinterpret_cast<void*>(address), bytes,
                         originalProtection, &ignored);
        Fail(std::wstring(L"cannot patch remote ") + operation, error);
    }
    if (!FlushInstructionCache(process, reinterpret_cast<void*>(address), bytes)) {
        const DWORD error = GetLastError();
        DWORD ignored = 0;
        VirtualProtectEx(process, reinterpret_cast<void*>(address), bytes,
                         originalProtection, &ignored);
        Fail(std::wstring(L"cannot flush remote ") + operation, error);
    }
    DWORD ignored = 0;
    if (!VirtualProtectEx(process, reinterpret_cast<void*>(address), bytes,
                          originalProtection, &ignored)) {
        Fail(std::wstring(L"cannot restore remote ") + operation + L" protection",
             GetLastError());
    }
}

FARPROC RemoteSystemProc(DWORD pid, FARPROC localProc) {
    MEMORY_BASIC_INFORMATION memory{};
    if (!localProc || !VirtualQuery(localProc, &memory, sizeof(memory)) || !memory.AllocationBase) {
        Fail(L"cannot identify the module owning an injection export", GetLastError());
    }
    const HMODULE localModule = static_cast<HMODULE>(memory.AllocationBase);
    std::array<wchar_t, MAX_PATH> path{};
    const DWORD length = GetModuleFileNameW(localModule, path.data(), static_cast<DWORD>(path.size()));
    if (!length || length == path.size()) {
        Fail(L"cannot identify the injection export module", GetLastError());
    }
    const wchar_t* baseName = path.data();
    if (const wchar_t* slash = wcsrchr(path.data(), L'\\')) baseName = slash + 1;
    const uintptr_t remoteModule = RemoteModuleBase(pid, baseName);
    if (!remoteModule) Fail(L"target lacks the injection export module", GetLastError());
    const uintptr_t rva = reinterpret_cast<uintptr_t>(localProc) -
                          reinterpret_cast<uintptr_t>(localModule);
    return reinterpret_cast<FARPROC>(remoteModule + rva);
}

std::string Sha256File(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) Fail(L"cannot open target executable for hashing", GetLastError());
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
        !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) {
        const DWORD error = GetLastError();
        if (provider) CryptReleaseContext(provider, 0);
        CloseHandle(file);
        Fail(L"cannot initialize SHA-256", error);
    }
    std::array<BYTE, 64 * 1024> buffer{};
    while (true) {
        DWORD read = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
            const DWORD error = GetLastError();
            CryptDestroyHash(hash);
            CryptReleaseContext(provider, 0);
            CloseHandle(file);
            Fail(L"cannot read target executable for hashing", error);
        }
        if (!read) break;
        if (!CryptHashData(hash, buffer.data(), read, 0)) {
            const DWORD error = GetLastError();
            CryptDestroyHash(hash);
            CryptReleaseContext(provider, 0);
            CloseHandle(file);
            Fail(L"cannot hash target executable", error);
        }
    }
    std::array<BYTE, 32> digest{};
    DWORD digestSize = static_cast<DWORD>(digest.size());
    if (!CryptGetHashParam(hash, HP_HASHVAL, digest.data(), &digestSize, 0) ||
        digestSize != digest.size()) {
        const DWORD error = GetLastError();
        CryptDestroyHash(hash);
        CryptReleaseContext(provider, 0);
        CloseHandle(file);
        Fail(L"cannot finish target SHA-256", error);
    }
    CryptDestroyHash(hash);
    CryptReleaseContext(provider, 0);
    CloseHandle(file);
    static constexpr char hex[] = "0123456789abcdef";
    std::string output;
    output.reserve(64);
    for (BYTE value : digest) {
        output.push_back(hex[value >> 4]);
        output.push_back(hex[value & 0x0F]);
    }
    return output;
}

template <typename T>
bool ReadRemote(HANDLE process, uintptr_t address, T& value) {
    SIZE_T read = 0;
    return ReadProcessMemory(process, reinterpret_cast<const void*>(address), &value,
                             sizeof(value), &read) != FALSE && read == sizeof(value);
}

bool RemoteSignature(HANDLE process, uintptr_t address, const uint8_t* expected, size_t size) {
    std::array<uint8_t, 64> actual{};
    SIZE_T read = 0;
    return size <= actual.size() &&
           ReadProcessMemory(process, reinterpret_cast<const void*>(address), actual.data(), size, &read) &&
           read == size && std::memcmp(actual.data(), expected, size) == 0;
}

bool RemoteFocusLossPolicySignature(HANDLE process) {
    const bool audio =
        RemoteSignature(process, pvz::audio::muteOnLostFocusInitializer,
                        pvz::audio::muteOnLostFocusEnabledSignature,
                        sizeof(pvz::audio::muteOnLostFocusEnabledSignature)) ||
        RemoteSignature(process, pvz::audio::muteOnLostFocusInitializer,
                        pvz::audio::muteOnLostFocusDisabledSignature,
                        sizeof(pvz::audio::muteOnLostFocusDisabledSignature));
    const bool focus =
        RemoteSignature(process, pvz::focus::lostFocus,
                        pvz::focus::lostFocusPauseSignature,
                        sizeof(pvz::focus::lostFocusPauseSignature)) ||
        RemoteSignature(process, pvz::focus::lostFocus,
                        pvz::focus::lostFocusSkipPauseSignature,
                        sizeof(pvz::focus::lostFocusSkipPauseSignature));
    return audio && focus;
}

void ValidateRemoteTarget(HANDLE process, DWORD) {
    std::vector<wchar_t> path(32768);
    DWORD pathLength = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process, 0, path.data(), &pathLength)) {
        Fail(L"cannot resolve target executable", GetLastError());
    }
    path.resize(pathLength);
    if (Sha256File(std::wstring(path.data(), path.size())) != pvz::kExecutableSha256) {
        Fail(L"target executable SHA-256 is not the pinned APAC JA 1073 build");
    }

    const uintptr_t base = pvz::kImageBase;
    IMAGE_DOS_HEADER dos{};
    IMAGE_NT_HEADERS32 nt{};
    if (!ReadRemote(process, base, dos) || dos.e_magic != IMAGE_DOS_SIGNATURE ||
        !ReadRemote(process, base + static_cast<uint32_t>(dos.e_lfanew), nt) ||
        nt.Signature != IMAGE_NT_SIGNATURE || nt.FileHeader.Machine != IMAGE_FILE_MACHINE_I386 ||
        nt.FileHeader.TimeDateStamp != pvz::kPeTimestamp ||
        nt.OptionalHeader.ImageBase != pvz::kImageBase ||
        nt.OptionalHeader.AddressOfEntryPoint != pvz::kPeEntryPoint ||
        nt.OptionalHeader.SizeOfImage != pvz::kPeSizeOfImage ||
        nt.OptionalHeader.CheckSum != pvz::kPeChecksum ||
        nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC].Size != 0 ||
        (nt.OptionalHeader.DllCharacteristics & IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE)) {
        Fail(L"target PE identity mismatch");
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
    if (!RemoteSignature(process, 0x0045DE20, accessor1, sizeof(accessor1)) ||
        !RemoteSignature(process, 0x0045DE40, accessor2, sizeof(accessor2)) ||
        !RemoteSignature(process, 0x0045E05D, constructor, sizeof(constructor)) ||
        !RemoteSignature(process, 0x0045DFCD, virtualAccessor, sizeof(virtualAccessor)) ||
        !RemoteSignature(process, pvz::title::mouseDown,
                         pvz::title::mouseDownSignature,
                         sizeof(pvz::title::mouseDownSignature)) ||
        !RemoteSignature(process, pvz::player::copyConstructor,
                         pvz::player::copyConstructorSignature,
                         sizeof(pvz::player::copyConstructorSignature)) ||
        !RemoteSignature(process, pvz::player::nameStorageAccess,
                         pvz::player::nameStorageAccessSignature,
                         sizeof(pvz::player::nameStorageAccessSignature)) ||
        !RemoteSignature(process, pvz::cutScene::endSeedChooser,
                         pvz::cutScene::endSeedChooserSignature,
                         sizeof(pvz::cutScene::endSeedChooserSignature)) ||
        !RemoteFocusLossPolicySignature(process)) {
        Fail(L"target LawnApp signature mismatch");
    }
}

void EnsureX86(HANDLE process) {
    using IsWow64Process2Fn = BOOL(WINAPI*)(HANDLE, USHORT*, USHORT*);
    auto isWow64Process2 = reinterpret_cast<IsWow64Process2Fn>(
        GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2"));
    if (isWow64Process2) {
        USHORT processMachine = 0;
        USHORT nativeMachine = 0;
        if (!isWow64Process2(process, &processMachine, &nativeMachine)) {
            Fail(L"cannot inspect target architecture", GetLastError());
        }
        const bool x86 = processMachine == IMAGE_FILE_MACHINE_I386 ||
                         (processMachine == IMAGE_FILE_MACHINE_UNKNOWN &&
                          nativeMachine == IMAGE_FILE_MACHINE_I386);
        if (!x86) Fail(L"target process is not x86");
        return;
    }

    BOOL targetWow64 = FALSE;
    BOOL selfWow64 = FALSE;
    if (!IsWow64Process(process, &targetWow64) || !IsWow64Process(GetCurrentProcess(), &selfWow64)) {
        Fail(L"cannot inspect target architecture", GetLastError());
    }
    SYSTEM_INFO info = {};
    GetNativeSystemInfo(&info);
    if (info.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 && !targetWow64) {
        Fail(L"target process is not x86");
    }
}

DWORD RunRemote(HANDLE process, LPTHREAD_START_ROUTINE routine, void* argument,
                const wchar_t* operation) {
    HANDLE thread = CreateRemoteThread(process, nullptr, 0, routine, argument, 0, nullptr);
    if (!thread) Fail(std::wstring(L"cannot start remote ") + operation, GetLastError());
    const DWORD wait = WaitForSingleObject(thread, 15000);
    if (wait != WAIT_OBJECT_0) {
        const DWORD error = wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
        CloseHandle(thread);
        Fail(std::wstring(L"remote ") + operation + L" did not complete", error);
    }
    DWORD result = 0;
    if (!GetExitCodeThread(thread, &result)) {
        const DWORD error = GetLastError();
        CloseHandle(thread);
        Fail(std::wstring(L"cannot read remote ") + operation + L" result", error);
    }
    CloseHandle(thread);
    return result;
}

void PreparePrimaryThreadDpi(HANDLE process, DWORD pid, uintptr_t gateAddress) {
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    const FARPROC localSetThreadDpi =
        user32 ? GetProcAddress(user32, "SetThreadDpiAwarenessContext") : nullptr;
    if (!localSetThreadDpi) Fail(L"cannot resolve SetThreadDpiAwarenessContext");
    const FARPROC remoteSetThreadDpi = RemoteSystemProc(pid, localSetThreadDpi);
    const DWORD routine = static_cast<DWORD>(reinterpret_cast<uintptr_t>(remoteSetThreadDpi));
    WriteRemoteExact(process, gateAddress + kEarlyGateDpiRoutineOffset,
                     &routine, sizeof(routine), L"primary-thread DPI routine");
    const DWORD request = 1;
    WriteRemoteExact(process, gateAddress + kEarlyGateDpiRequestOffset,
                     &request, sizeof(request), L"primary-thread DPI request");

    bool complete = false;
    for (int attempt = 0; attempt < 1500; ++attempt) {
        DWORD state = 0;
        if (!ReadRemote(process, gateAddress + kEarlyGateDpiCompleteOffset, state)) {
            Fail(L"cannot read the primary-thread DPI gate", GetLastError());
        }
        if (state == 1) {
            complete = true;
            break;
        }
        if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
            Fail(L"target exited during primary-thread DPI initialization");
        }
        Sleep(10);
    }
    if (!complete) {
        Fail(L"primary thread did not complete DPI initialization", ERROR_TIMEOUT);
    }
    DWORD previousContext = 0;
    if (!ReadRemote(process, gateAddress + kEarlyGateDpiResultOffset, previousContext)) {
        Fail(L"cannot read the primary-thread DPI result", GetLastError());
    }
    if (!previousContext) {
        Fail(L"primary thread rejected Per-Monitor V2 DPI initialization");
    }
}

void* CopyRemote(HANDLE process, const void* source, size_t bytes) {
    void* remote = VirtualAllocEx(process, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) Fail(L"cannot allocate target memory", GetLastError());
    SIZE_T written = 0;
    if (!WriteProcessMemory(process, remote, source, bytes, &written) || written != bytes) {
        const DWORD error = GetLastError();
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        Fail(L"cannot write target memory", error);
    }
    return remote;
}

std::string ReadRemoteString(HANDLE process, uintptr_t address, size_t maximum) {
    std::string value;
    value.reserve(maximum);
    for (size_t index = 0; index < maximum; ++index) {
        char ch = 0;
        if (!ReadRemote(process, address + index, ch)) return {};
        if (!ch) return value;
        value.push_back(ch);
    }
    return {};
}

LPTHREAD_START_ROUTINE RemoteExport(HANDLE process, uintptr_t module, const char* name) {
    IMAGE_DOS_HEADER dos{};
    IMAGE_NT_HEADERS32 nt{};
    if (!ReadRemote(process, module, dos) || dos.e_magic != IMAGE_DOS_SIGNATURE ||
        !ReadRemote(process, module + static_cast<uint32_t>(dos.e_lfanew), nt) ||
        nt.Signature != IMAGE_NT_SIGNATURE || nt.FileHeader.Machine != IMAGE_FILE_MACHINE_I386) {
        Fail(L"loaded pvz-implant.dll PE headers are invalid");
    }
    const auto directory = nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    IMAGE_EXPORT_DIRECTORY exports{};
    if (!directory.VirtualAddress || !directory.Size ||
        !ReadRemote(process, module + directory.VirtualAddress, exports) ||
        exports.NumberOfNames > 1024 || exports.NumberOfFunctions > 1024) {
        Fail(L"loaded pvz-implant.dll export directory is invalid");
    }
    for (DWORD index = 0; index < exports.NumberOfNames; ++index) {
        DWORD nameRva = 0;
        WORD ordinal = 0;
        if (!ReadRemote(process, module + exports.AddressOfNames + index * sizeof(DWORD), nameRva) ||
            ReadRemoteString(process, module + nameRva, 128) != name ||
            !ReadRemote(process, module + exports.AddressOfNameOrdinals + index * sizeof(WORD), ordinal)) {
            continue;
        }
        if (ordinal >= exports.NumberOfFunctions) break;
        DWORD functionRva = 0;
        if (!ReadRemote(process, module + exports.AddressOfFunctions + ordinal * sizeof(DWORD), functionRva) ||
            !functionRva || (functionRva >= directory.VirtualAddress &&
                             functionRva < directory.VirtualAddress + directory.Size)) break;
        return reinterpret_cast<LPTHREAD_START_ROUTINE>(module + functionRva);
    }
    Fail(L"loaded pvz-implant.dll lacks a required export");
}

void SetRemotePipe(HANDLE process, uintptr_t remoteDll, const std::wstring& pipe) {
    const size_t bytes = (pipe.size() + 1) * sizeof(wchar_t);
    void* remotePipe = CopyRemote(process, pipe.c_str(), bytes);
    const DWORD result = RunRemote(
        process, RemoteExport(process, remoteDll, "CorticoPvzSetPipeW"), remotePipe,
        L"CorticoPvzSetPipeW");
    VirtualFreeEx(process, remotePipe, 0, MEM_RELEASE);
    if (!result) Fail(L"pvz-implant.dll rejected the pipe name");
}

void ConfigureRemote(HANDLE process, uintptr_t remoteDll, const Options& options) {
    const DWORD values[] = {options.pollHz, options.cursorMinMs, options.cursorMaxMs};
    void* remoteValues = CopyRemote(process, values, sizeof(values));
    const DWORD result = RunRemote(
        process, RemoteExport(process, remoteDll, "CorticoPvzConfigure"), remoteValues,
        L"CorticoPvzConfigure");
    VirtualFreeEx(process, remoteValues, 0, MEM_RELEASE);
    if (!result) Fail(L"pvz-implant.dll rejected the initial configuration");
}

void PrepareRemoteManagedWindow(HANDLE process, uintptr_t remoteDll) {
    const DWORD result = RunRemote(
        process, RemoteExport(process, remoteDll, "CorticoPvzPrepareManagedWindow"), nullptr,
        L"CorticoPvzPrepareManagedWindow");
    if (result == 1) return;
    // 只说一句"被拒绝"查不下去:这道门归零通常是这台机器给 PlantsVsZombies.exe 挂了
    // 高 DPI 兼容性设置(进程级档位一旦被外部钉住,线程级就改不动了)。
    if (result & 0x80000000u) {
        Fail(L"Plants vs. Zombies rejected managed window DPI initialization "
             L"(check the executable's high-DPI compatibility override)",
             result & 0x7FFFFFFFu);
    }
    Fail(L"Plants vs. Zombies rejected managed window DPI initialization "
         L"(check the executable's high-DPI compatibility override)");
}

void PrepareRemoteFocusLossPolicy(HANDLE process, uintptr_t remoteDll) {
    const DWORD result = RunRemote(
        process, RemoteExport(process, remoteDll, "CorticoPvzPrepareFocusLossPolicy"), nullptr,
        L"CorticoPvzPrepareFocusLossPolicy");
    if (!result) Fail(L"Plants vs. Zombies rejected focus-loss policy initialization");
}

void VerifyRemoteOwner(HANDLE process, uintptr_t remoteDll, const Options& options) {
    const size_t buildBytes = sizeof(pvz::kImplantBuildId);
    void* remoteBuild = CopyRemote(process, pvz::kImplantBuildId, buildBytes);
    const DWORD buildResult = RunRemote(
        process, RemoteExport(process, remoteDll, "CorticoPvzVerifyBuildW"), remoteBuild,
        L"CorticoPvzVerifyBuildW");
    VirtualFreeEx(process, remoteBuild, 0, MEM_RELEASE);
    if (!buildResult) Fail(L"loaded pvz-implant.dll build identity does not match");
    const size_t bytes = (options.ownerToken.size() + 1) * sizeof(wchar_t);
    void* remoteToken = CopyRemote(process, options.ownerToken.c_str(), bytes);
    const DWORD result = RunRemote(
        process, RemoteExport(process, remoteDll, "CorticoPvzVerifyOwnerW"), remoteToken,
        L"CorticoPvzVerifyOwnerW");
    VirtualFreeEx(process, remoteToken, 0, MEM_RELEASE);
    if (!result) Fail(L"loaded pvz-implant.dll owner token does not match");
}

void ValidateForInjection(HANDLE process, DWORD pid) {
    EnsureX86(process);
    ValidateRemoteTarget(process, pid);
}

uintptr_t AuthenticateAttached(HANDLE process, DWORD pid, const Options& options) {
    ValidateForInjection(process, pid);
    const uintptr_t remoteDll = RemoteModuleByPath(pid, options.dll);
    if (!remoteDll) {
        Fail(L"attach requires the exact pvz-implant.dll from the original launch to be loaded");
    }
    VerifyRemoteOwner(process, remoteDll, options);
    return remoteDll;
}

void ConfigureAttached(HANDLE process, uintptr_t remoteDll, const Options& options) {
    SetRemotePipe(process, remoteDll, options.pipe);
    ConfigureRemote(process, remoteDll, options);
}

void InjectSuspended(HANDLE process, HANDLE primaryThread, DWORD pid, const Options& options) {
    ValidateForInjection(process, pid);
    const size_t bytes = (options.dll.size() + 1) * sizeof(wchar_t);
    void* remotePath = CopyRemote(process, options.dll.c_str(), bytes);
    HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
    const FARPROC localLoadLibrary = kernel ? GetProcAddress(kernel, "LoadLibraryW") : nullptr;
    if (!localLoadLibrary) Fail(L"cannot resolve LoadLibraryW");

    const uintptr_t entryPoint = pvz::kImageBase + pvz::kPeEntryPoint;
    std::array<uint8_t, 6> originalEntry{};
    SIZE_T entryRead = 0;
    if (!ReadProcessMemory(process, reinterpret_cast<const void*>(entryPoint),
                           originalEntry.data(), originalEntry.size(), &entryRead) ||
        entryRead != originalEntry.size()) {
        Fail(L"cannot read the target entry point", GetLastError());
    }
    if (originalEntry != kPinnedEntryBytes) {
        Fail(L"target entry point signature mismatch");
    }
    void* remoteGate = VirtualAllocEx(process, nullptr, kEarlyGateSize,
                                      MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!remoteGate) Fail(L"cannot allocate the early injection gate", GetLastError());
    const uintptr_t gateAddress = reinterpret_cast<uintptr_t>(remoteGate);
    const uint32_t primaryDpiContext = static_cast<uint32_t>(
        reinterpret_cast<uintptr_t>(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2));
    const auto gateImage = EarlyGateImage(static_cast<uint32_t>(gateAddress),
                                          static_cast<uint32_t>(entryPoint),
                                          primaryDpiContext);
    WriteRemoteExact(process, gateAddress, gateImage.data(), gateImage.size(),
                     L"early injection gate");
    if (!FlushInstructionCache(process, remoteGate, gateImage.size())) {
        Fail(L"cannot flush the early injection gate", GetLastError());
    }
    const auto entryJump = AbsoluteJump(static_cast<uint32_t>(gateAddress));
    PatchRemoteCode(process, entryPoint, entryJump.data(), entryJump.size(),
                    L"target entry point");

    const DWORD initialSuspendCount = ResumeThread(primaryThread);
    if (initialSuspendCount == static_cast<DWORD>(-1)) {
        Fail(L"cannot start the target loader", GetLastError());
    }
    if (initialSuspendCount != 1) Fail(L"unexpected initial primary thread suspend count");
    bool loaderComplete = false;
    for (int attempt = 0; attempt < 1500; ++attempt) {
        DWORD arrived = 0;
        if (!ReadRemote(process, gateAddress + kEarlyGateArrivedOffset, arrived)) {
            Fail(L"cannot read the early injection gate", GetLastError());
        }
        if (arrived == 1) {
            loaderComplete = true;
            break;
        }
        if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
            Fail(L"target exited before loader initialization completed");
        }
        Sleep(10);
    }
    if (!loaderComplete) Fail(L"target loader did not reach the injection gate", ERROR_TIMEOUT);
    PreparePrimaryThreadDpi(process, pid, gateAddress);

    const FARPROC loadLibrary = RemoteSystemProc(pid, localLoadLibrary);
    const DWORD loadedModule = RunRemote(
        process, reinterpret_cast<LPTHREAD_START_ROUTINE>(loadLibrary), remotePath,
        L"LoadLibraryW");
    if (!loadedModule) Fail(L"LoadLibraryW did not load pvz-implant.dll");
    const uintptr_t remoteDll = static_cast<uintptr_t>(loadedModule);
    const uintptr_t remoteDllByPath = RemoteModuleByPath(pid, options.dll);
    if (!remoteDllByPath) {
        Fail(L"cannot verify the loaded pvz-implant.dll path", GetLastError());
    }
    if (remoteDllByPath != remoteDll) {
        Fail(L"LoadLibraryW returned a different pvz-implant.dll module");
    }
    VirtualFreeEx(process, remotePath, 0, MEM_RELEASE);
    VerifyRemoteOwner(process, remoteDll, options);
    PrepareRemoteManagedWindow(process, remoteDll);
    PrepareRemoteFocusLossPolicy(process, remoteDll);
    SetRemotePipe(process, remoteDll, options.pipe);
    ConfigureRemote(process, remoteDll, options);

    const DWORD activeSuspendCount = SuspendThread(primaryThread);
    if (activeSuspendCount == static_cast<DWORD>(-1)) {
        Fail(L"cannot park the primary thread after injection", GetLastError());
    }
    if (activeSuspendCount != 0) Fail(L"unexpected primary thread state after injection");
    PatchRemoteCode(process, entryPoint, originalEntry.data(), originalEntry.size(),
                    L"target entry point");
    const DWORD release = 1;
    WriteRemoteExact(process, gateAddress + kEarlyGateReleaseOffset,
                     &release, sizeof(release), L"early injection gate release");
    DWORD oldGateProtection = 0;
    if (!VirtualProtectEx(process, remoteGate, kEarlyGateSize,
                          PAGE_EXECUTE_READ, &oldGateProtection)) {
        Fail(L"cannot seal the early injection gate", GetLastError());
    }
}

struct ManagedWindowSearch {
    DWORD pid;
    HWND result;
    LONG bestArea;
};

BOOL CALLBACK FindManagedWindow(HWND window, LPARAM parameter) {
    auto* search = reinterpret_cast<ManagedWindowSearch*>(parameter);
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid != search->pid || GetWindow(window, GW_OWNER) || !IsWindowVisible(window)) return TRUE;
    RECT client{};
    if (!GetClientRect(window, &client)) return TRUE;
    const LONG width = client.right - client.left;
    const LONG height = client.bottom - client.top;
    const LONG area = width > 0 && height > 0 ? width * height : 0;
    if (area > search->bestArea) {
        search->bestArea = area;
        search->result = window;
    }
    return TRUE;
}

HWND WaitForManagedWindow(HANDLE process, DWORD pid) {
    const ULONGLONG deadline = GetTickCount64() + 15000;
    while (GetTickCount64() < deadline) {
        ManagedWindowSearch search{pid, nullptr, 0};
        EnumWindows(FindManagedWindow, reinterpret_cast<LPARAM>(&search));
        if (search.result) return search.result;
        if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
            Fail(L"Plants vs. Zombies exited before its managed window appeared");
        }
        Sleep(10);
    }
    Fail(L"Plants vs. Zombies did not create its managed window", ERROR_TIMEOUT);
}

bool ManagedWindowState(HWND window, RECT& client, RECT& outer, RECT& work) {
    if (!GetClientRect(window, &client) || !GetWindowRect(window, &outer)) return false;
    const HMONITOR monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (!monitor || !GetMonitorInfoW(monitor, &info)) return false;
    work = info.rcWork;
    return true;
}

bool ManagedWindowVerified(HWND window) {
    RECT client{};
    RECT outer{};
    RECT work{};
    return ManagedWindowState(window, client, outer, work) &&
           AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window),
                                        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) &&
           ManagedClientSize(client.right - client.left, client.bottom - client.top) &&
           outer.left >= work.left && outer.top >= work.top &&
           outer.right <= work.right && outer.bottom <= work.bottom;
}

void EnsureManagedWindow(HANDLE process, DWORD pid) {
    HWND window = WaitForManagedWindow(process, pid);
    const LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
    if ((style & WS_CHILD) || !(style & WS_CAPTION)) {
        Fail(L"Plants vs. Zombies is not in a supported windowed mode");
    }
    for (int attempt = 0; attempt < 4; ++attempt) {
        RECT client{};
        RECT outer{};
        RECT work{};
        if (!ManagedWindowState(window, client, outer, work)) {
            Fail(L"cannot inspect the Plants vs. Zombies window", GetLastError());
        }
        const LONG clientWidth = client.right - client.left;
        const LONG clientHeight = client.bottom - client.top;
        const LONG outerWidth = outer.right - outer.left;
        const LONG outerHeight = outer.bottom - outer.top;
        if (clientWidth <= 0 || clientHeight <= 0 || outerWidth < clientWidth ||
            outerHeight < clientHeight) {
            Fail(L"Plants vs. Zombies reported invalid window geometry");
        }
        const LONG targetWidth = pvz::kManagedClientWidth + outerWidth - clientWidth;
        const LONG targetHeight = pvz::kManagedClientHeight + outerHeight - clientHeight;
        if (targetWidth > work.right - work.left || targetHeight > work.bottom - work.top) {
            Fail(L"the monitor work area cannot contain an 800x600 Plants vs. Zombies client");
        }
        const LONG x = ManagedWindowOrigin(outer.left, work.left, work.right, targetWidth);
        const LONG y = ManagedWindowOrigin(outer.top, work.top, work.bottom, targetHeight);
        if (ManagedWindowVerified(window)) return;
        if (!SetWindowPos(window, nullptr, x, y, targetWidth, targetHeight,
                          SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER)) {
            Fail(L"cannot restore the Plants vs. Zombies client to 800x600", GetLastError());
        }
        for (int sample = 0; sample < 20; ++sample) {
            if (ManagedWindowVerified(window)) return;
            if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
                Fail(L"Plants vs. Zombies exited while its window was being restored");
            }
            Sleep(10);
        }
    }
    Fail(L"Plants vs. Zombies client did not remain at 800x600", ERROR_INVALID_WINDOW_HANDLE);
}

std::wstring ParentDirectory(const std::wstring& path) {
    const size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? L"." : path.substr(0, slash);
}

std::string Utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0,
                                             nullptr, nullptr);
    if (!required) Fail(L"cannot encode ownership record", GetLastError());
    std::string output(static_cast<size_t>(required), '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), output.data(), required,
                            nullptr, nullptr)) {
        Fail(L"cannot encode ownership record", GetLastError());
    }
    return output;
}

std::string JsonQuote(const std::string& value) {
    static constexpr char hex[] = "0123456789abcdef";
    std::string output;
    output.reserve(value.size() + 2);
    output.push_back('"');
    for (const unsigned char ch : value) {
        switch (ch) {
            case '"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\b': output += "\\b"; break;
            case '\f': output += "\\f"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default:
                if (ch < 0x20) {
                    output += "\\u00";
                    output.push_back(hex[ch >> 4]);
                    output.push_back(hex[ch & 0x0F]);
                } else {
                    output.push_back(static_cast<char>(ch));
                }
        }
    }
    output.push_back('"');
    return output;
}

std::string ProcessCreationTime(HANDLE process) {
    FILETIME creation{};
    FILETIME exit{};
    FILETIME kernel{};
    FILETIME user{};
    if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
        Fail(L"cannot read target process creation identity", GetLastError());
    }
    const ULONGLONG value = (static_cast<ULONGLONG>(creation.dwHighDateTime) << 32) |
                            creation.dwLowDateTime;
    char encoded[17]{};
    sprintf_s(encoded, "%016I64x", value);
    return encoded;
}

void WriteOwnershipRecord(const Options& options, HANDLE process, DWORD pid, const char* mode,
                          const char* phase, DWORD primaryThreadId = 0) {
    if (options.ownershipFile.empty()) return;
    const std::string artifactDir = Utf8(ParentDirectory(options.dll));
    std::string record = "{\"ok\":true,\"mode\":";
    record += JsonQuote(mode);
    record += ",\"pid\":" + std::to_string(pid);
    record += ",\"ownerToken\":" + JsonQuote(Utf8(options.ownerToken));
    record += ",\"artifactDir\":" + JsonQuote(artifactDir);
    record += ",\"phase\":" + JsonQuote(phase);
    record += ",\"creationTime\":" + JsonQuote(ProcessCreationTime(process));
    record += ",\"primaryThreadId\":";
    if (primaryThreadId) record += std::to_string(primaryThreadId);
    else record += "null";
    record += "}\n";

    std::wstring temporary;
    HANDLE file = INVALID_HANDLE_VALUE;
    for (unsigned attempt = 0; attempt < 32; ++attempt) {
        temporary = options.ownershipFile + L".tmp-" + std::to_wstring(GetCurrentProcessId()) +
                    L"-" + std::to_wstring(GetTickCount64()) + L"-" +
                    std::to_wstring(attempt);
        file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                           FILE_ATTRIBUTE_TEMPORARY, nullptr);
        if (file != INVALID_HANDLE_VALUE) break;
        if (GetLastError() != ERROR_FILE_EXISTS && GetLastError() != ERROR_ALREADY_EXISTS) {
            Fail(L"cannot create ownership record temporary file", GetLastError());
        }
    }
    if (file == INVALID_HANDLE_VALUE) {
        Fail(L"cannot allocate ownership record temporary file", ERROR_FILE_EXISTS);
    }
    DWORD written = 0;
    const bool writeOk = WriteFile(file, record.data(), static_cast<DWORD>(record.size()),
                                   &written, nullptr) != FALSE && written == record.size();
    const DWORD writeError = writeOk ? ERROR_SUCCESS : GetLastError();
    const bool flushOk = writeOk && FlushFileBuffers(file) != FALSE;
    const DWORD flushError = flushOk ? ERROR_SUCCESS : GetLastError();
    CloseHandle(file);
    if (!writeOk || !flushOk) {
        DeleteFileW(temporary.c_str());
        Fail(L"cannot persist ownership record", writeOk ? flushError : writeError);
    }
    if (!MoveFileExW(temporary.c_str(), options.ownershipFile.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        const DWORD error = GetLastError();
        DeleteFileW(temporary.c_str());
        Fail(L"cannot publish ownership record", error);
    }
    g_writtenOwnershipFile = options.ownershipFile;
}

void PrintOwnershipRecord(const Options& options, HANDLE process, DWORD pid, const char* mode,
                          const char* phase, DWORD primaryThreadId = 0) {
    std::string record = "{\"ok\":true,\"mode\":" + JsonQuote(mode);
    record += ",\"pid\":" + std::to_string(pid);
    record += ",\"ownerToken\":" + JsonQuote(Utf8(options.ownerToken));
    record += ",\"artifactDir\":" + JsonQuote(Utf8(ParentDirectory(options.dll)));
    record += ",\"phase\":" + JsonQuote(phase);
    record += ",\"creationTime\":" + JsonQuote(ProcessCreationTime(process));
    record += ",\"primaryThreadId\":";
    if (primaryThreadId) record += std::to_string(primaryThreadId);
    else record += "null";
    record.push_back('}');
    printf("%s\n", record.c_str());
    fflush(stdout);
}

void ResumeOwnedThread(HANDLE process, const Options& options) {
    if (!options.resumeThread) return;
    if (Utf8(options.creationTime) != ProcessCreationTime(process)) {
        Fail(L"target process creation identity does not match --creation-time");
    }
    HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, FALSE,
                               options.resumeThread);
    if (!thread) Fail(L"cannot open recorded primary thread", GetLastError());
    if (GetProcessIdOfThread(thread) != options.pid) {
        CloseHandle(thread);
        Fail(L"recorded primary thread does not belong to the target process");
    }
    const DWORD previous = ResumeThread(thread);
    const DWORD error = previous == static_cast<DWORD>(-1) ? GetLastError() : ERROR_SUCCESS;
    CloseHandle(thread);
    if (previous == static_cast<DWORD>(-1)) Fail(L"cannot resume recorded primary thread", error);
    if (previous > 1) {
        Fail(L"recorded primary thread has an unexpected nested suspend count");
    }
}

void Launch(const Options& options) {
    const DWORD previousLength = GetEnvironmentVariableW(L"CORTICO_PVZ_PIPE", nullptr, 0);
    std::vector<wchar_t> previous(previousLength ? previousLength : 1);
    const bool hadPrevious = previousLength > 0;
    if (hadPrevious) GetEnvironmentVariableW(L"CORTICO_PVZ_PIPE", previous.data(), previousLength);
    const DWORD previousOwnerLength = GetEnvironmentVariableW(kOwnerEnvironment, nullptr, 0);
    std::vector<wchar_t> previousOwner(previousOwnerLength ? previousOwnerLength : 1);
    const bool hadPreviousOwner = previousOwnerLength > 0;
    if (hadPreviousOwner) {
        GetEnvironmentVariableW(kOwnerEnvironment, previousOwner.data(), previousOwnerLength);
    }
    if (!SetEnvironmentVariableW(L"CORTICO_PVZ_PIPE", options.pipe.c_str())) {
        Fail(L"cannot set child CORTICO_PVZ_PIPE", GetLastError());
    }
    if (!SetEnvironmentVariableW(kOwnerEnvironment, options.ownerToken.c_str())) {
        Fail(L"cannot set child CORTICO_PVZ_OWNER_TOKEN", GetLastError());
    }

    std::wstring commandLine = Quote(options.executable);
    if (!options.arguments.empty()) commandLine += L" " + options.arguments;
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    const std::wstring workingDirectory = ParentDirectory(options.executable);
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child = {};
    const BOOL created = CreateProcessW(
        options.executable.c_str(), mutableCommand.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
        nullptr, workingDirectory.c_str(), &startup, &child);
    const DWORD createError = created ? ERROR_SUCCESS : GetLastError();
    SetEnvironmentVariableW(L"CORTICO_PVZ_PIPE", hadPrevious ? previous.data() : nullptr);
    SetEnvironmentVariableW(kOwnerEnvironment, hadPreviousOwner ? previousOwner.data() : nullptr);
    if (!created) Fail(L"cannot start PlantsVsZombies.exe", createError);
    g_suspendedProcess = child.hProcess;
    g_suspendedThread = child.hThread;
    InjectSuspended(child.hProcess, child.hThread, child.dwProcessId, options);
    WriteOwnershipRecord(options, child.hProcess, child.dwProcessId, "launch", "suspended",
                         child.dwThreadId);
    const DWORD suspendCount = ResumeThread(child.hThread);
    if (suspendCount == static_cast<DWORD>(-1)) {
        Fail(L"cannot resume PlantsVsZombies.exe", GetLastError());
    }
    if (suspendCount != 1) Fail(L"unexpected primary thread suspend count after injection");
    EnsureManagedWindow(child.hProcess, child.dwProcessId);
    WriteOwnershipRecord(options, child.hProcess, child.dwProcessId, "launch", "resumed",
                         child.dwThreadId);
    g_suspendedProcess = nullptr;
    g_suspendedThread = nullptr;
    g_writtenOwnershipFile.clear();
    PrintOwnershipRecord(options, child.hProcess, child.dwProcessId, "launch", "resumed",
                         child.dwThreadId);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
}

void Attach(const Options& options) {
    constexpr DWORD access = PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                             PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ;
    HANDLE process = OpenProcess(access, FALSE, options.pid);
    if (!process) Fail(L"cannot open target process", GetLastError());
    if (Utf8(options.creationTime) != ProcessCreationTime(process)) {
        Fail(L"target process creation identity does not match --creation-time");
    }
    const uintptr_t remoteDll = AuthenticateAttached(process, options.pid, options);
    ResumeOwnedThread(process, options);
    EnsureManagedWindow(process, options.pid);
    ConfigureAttached(process, remoteDll, options);
    WriteOwnershipRecord(options, process, options.pid, "attach", "resumed",
                         options.resumeThread);
    PrintOwnershipRecord(options, process, options.pid, "attach", "resumed",
                         options.resumeThread);
    g_writtenOwnershipFile.clear();
    CloseHandle(process);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) &&
        !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),
                                      DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
        Fail(L"cannot enable per-monitor managed window coordinates", GetLastError());
    }
    const Options options = ParseOptions(argc, argv);
    if (options.mode == Options::Mode::Launch) Launch(options);
    else Attach(options);
    return 0;
}
