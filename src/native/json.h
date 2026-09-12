#pragma once

#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

namespace pvz::json {

inline void AppendString(std::string& output, const std::string& value) {
    static constexpr char hex[] = "0123456789abcdef";
    output.push_back('"');
    for (unsigned char ch : value) {
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
                    output.push_back(hex[ch & 0xF]);
                } else {
                    output.push_back(static_cast<char>(ch));
                }
        }
    }
    output.push_back('"');
}

inline void AppendInt(std::string& output, int64_t value) {
    output += std::to_string(value);
}

inline void AppendBool(std::string& output, bool value) {
    output += value ? "true" : "false";
}

inline size_t SkipSpace(const std::string& input, size_t at) {
    while (at < input.size() && std::isspace(static_cast<unsigned char>(input[at]))) ++at;
    return at;
}

inline std::vector<size_t> FindValues(const std::string& input, const char* key) {
    const std::string needle = std::string("\"") + key + "\"";
    std::vector<size_t> values;
    size_t at = 0;
    while ((at = input.find(needle, at)) != std::string::npos) {
        size_t value = SkipSpace(input, at + needle.size());
        if (value < input.size() && input[value] == ':') {
            values.push_back(SkipSpace(input, value + 1));
        }
        at += needle.size();
    }
    return values;
}

inline bool HexDigit(char ch, uint32_t& value) {
    if (ch >= '0' && ch <= '9') value = static_cast<uint32_t>(ch - '0');
    else if (ch >= 'a' && ch <= 'f') value = static_cast<uint32_t>(ch - 'a' + 10);
    else if (ch >= 'A' && ch <= 'F') value = static_cast<uint32_t>(ch - 'A' + 10);
    else return false;
    return true;
}

inline void AppendUtf8(std::string& output, uint32_t codepoint) {
    if (codepoint <= 0x7F) output.push_back(static_cast<char>(codepoint));
    else if (codepoint <= 0x7FF) {
        output.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    } else {
        output.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    }
}

inline bool ParseStringAt(const std::string& input, size_t at, std::string& output) {
    if (at >= input.size() || input[at] != '"') return false;
    output.clear();
    for (++at; at < input.size(); ++at) {
        const char ch = input[at];
        if (ch == '"') return true;
        if (ch != '\\') {
            output.push_back(ch);
            continue;
        }
        if (++at >= input.size()) return false;
        switch (input[at]) {
            case '"': output.push_back('"'); break;
            case '\\': output.push_back('\\'); break;
            case '/': output.push_back('/'); break;
            case 'b': output.push_back('\b'); break;
            case 'f': output.push_back('\f'); break;
            case 'n': output.push_back('\n'); break;
            case 'r': output.push_back('\r'); break;
            case 't': output.push_back('\t'); break;
            case 'u': {
                if (at + 4 >= input.size()) return false;
                uint32_t codepoint = 0;
                for (int i = 0; i < 4; ++i) {
                    uint32_t digit = 0;
                    if (!HexDigit(input[++at], digit)) return false;
                    codepoint = (codepoint << 4) | digit;
                }
                AppendUtf8(output, codepoint);
                break;
            }
            default: return false;
        }
    }
    return false;
}

inline bool String(const std::string& input, const char* key, std::string& output) {
    for (size_t at : FindValues(input, key)) {
        if (at < input.size() && input[at] == '"' && ParseStringAt(input, at, output)) return true;
    }
    return false;
}

inline bool Integer(const std::string& input, const char* key, int& output) {
    for (size_t at : FindValues(input, key)) {
        if (at >= input.size() || (input[at] != '-' && !std::isdigit(static_cast<unsigned char>(input[at])))) {
            continue;
        }
        char* end = nullptr;
        const long value = std::strtol(input.c_str() + at, &end, 10);
        if (end != input.c_str() + at) {
            output = static_cast<int>(value);
            return true;
        }
    }
    return false;
}

inline bool NullOrInteger(const std::string& input, const char* key, int& output) {
    for (size_t at : FindValues(input, key)) {
        if (at + 4 <= input.size() && input.compare(at, 4, "null") == 0) {
            output = -1;
            return true;
        }
        if (at >= input.size() ||
            (input[at] != '-' && !std::isdigit(static_cast<unsigned char>(input[at])))) {
            return false;
        }
        char* end = nullptr;
        const long value = std::strtol(input.c_str() + at, &end, 10);
        if (end == input.c_str() + at) return false;
        output = static_cast<int>(value);
        return true;
    }
    return false;
}

inline bool IntegerArray(const std::string& input, const char* key, std::vector<int>& output) {
    for (size_t at : FindValues(input, key)) {
        if (at >= input.size() || input[at] != '[') continue;
        output.clear();
        ++at;
        while (true) {
            at = SkipSpace(input, at);
            if (at >= input.size()) return false;
            if (input[at] == ']') return true;
            char* end = nullptr;
            const long value = std::strtol(input.c_str() + at, &end, 10);
            if (end == input.c_str() + at) return false;
            if (output.size() >= 128) return false;
            output.push_back(static_cast<int>(value));
            at = SkipSpace(input, static_cast<size_t>(end - input.c_str()));
            if (at >= input.size()) return false;
            if (input[at] == ']') return true;
            if (input[at] != ',') return false;
            ++at;
        }
    }
    return false;
}

}  // namespace pvz::json
