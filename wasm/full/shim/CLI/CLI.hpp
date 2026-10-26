// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal CLI11 stand-in for the browser build (wasm/full): only the calls
// apps/d2d/main.cpp makes (add_option / add_flag / ->check / count / parse /
// exit, CLI::Range, CLI::IsMember, CLI::ParseError). Options are "--name value"
// or "--name=value"; flags are "--name".
#pragma once

#include <cstdio>
#include <cstdlib>
#include <functional>
#include <initializer_list>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace CLI {

struct ParseError : std::runtime_error {
    int code;
    ParseError(const std::string& what, int exit_code) : std::runtime_error(what), code(exit_code) {}
};

using Validator = std::function<std::string(const std::string&)>;

inline Validator Range(int lo, int hi) {
    return [lo, hi](const std::string& s) -> std::string {
        char* end = nullptr;
        const long v = std::strtol(s.c_str(), &end, 10);
        if (end == s.c_str() || *end || v < lo || v > hi) return "Value " + s + " not in range [" + std::to_string(lo) + ", " + std::to_string(hi) + "]";
        return {};
    };
}
inline Validator IsMember(std::initializer_list<const char*> items) {
    std::vector<std::string> set(items.begin(), items.end());
    return [set](const std::string& s) -> std::string {
        for (const auto& i : set) if (i == s) return {};
        return "Value " + s + " not in the allowed set";
    };
}

class Option {
public:
    Option* check(Validator v) { validators.push_back(std::move(v)); return this; }
    std::function<void(const std::string&)> assign;
    std::vector<Validator> validators;
    bool flag = false;
    int seen = 0;
};

class App {
public:
    explicit App(std::string description = {}) : description_(std::move(description)) {}

    template <class T>
    Option* add_option(const std::string& name, T& var, const std::string& = {}) {
        auto o = std::make_unique<Option>();
        o->assign = [&var](const std::string& s) { set(var, s); };
        return reg(name, std::move(o));
    }
    Option* add_flag(const std::string& name, bool& var, const std::string& = {}) {
        auto o = std::make_unique<Option>();
        o->flag = true;
        o->assign = [&var](const std::string&) { var = true; };
        return reg(name, std::move(o));
    }
    void parse(int argc, char** argv) {
        for (int i = 1; i < argc; ++i) {
            std::string arg = argv[i], value;
            bool has_value = false;
            if (const auto eq = arg.find('='); arg.rfind("--", 0) == 0 && eq != std::string::npos) {
                value = arg.substr(eq + 1);
                arg.resize(eq);
                has_value = true;
            }
            const auto it = options_.find(arg);
            if (it == options_.end()) throw ParseError("The following argument was not expected: " + arg, 109);
            Option& o = *it->second;
            if (!o.flag) {
                if (!has_value) {
                    if (i + 1 >= argc) throw ParseError(arg + ": 1 required TEXT missing", 105);
                    value = argv[++i];
                }
                for (const auto& v : o.validators)
                    if (const auto err = v(value); !err.empty()) throw ParseError(arg + ": " + err, 104);
            }
            o.assign(value);
            ++o.seen;
        }
    }
    int count(const std::string& name) const {
        const auto it = options_.find(name);
        return it == options_.end() ? 0 : it->second->seen;
    }
    int exit(const ParseError& e) const {
        std::fprintf(stderr, "%s\n", e.what());
        return e.code;
    }

private:
    template <class T> static void set(T& var, const std::string& s) {
        std::istringstream in(s);
        in >> var;
        if (in.fail()) throw ParseError("Could not convert: " + s, 104);
    }
    static void set(std::string& var, const std::string& s) { var = s; }
    Option* reg(const std::string& name, std::unique_ptr<Option> o) {
        Option* p = o.get();
        options_[name] = std::move(o);
        return p;
    }
    std::string description_;
    std::map<std::string, std::unique_ptr<Option>> options_;
};

}  // namespace CLI
