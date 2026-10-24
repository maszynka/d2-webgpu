// SPDX-License-Identifier: GPL-3.0-or-later
// Browser replacement for components/devctl/devctl.cpp (same API, no AF_UNIX socket): command
// lines come from the page through a JS queue (globalThis.__d2web.ctl, FullGame.devctl()) and
// each reply goes back by id. Used by the e2e tests to read game state (`state`, `debug level`,
// `monsters`) and to drive set-ups (`cmd move`, `debug enter`, ...) with the upstream verbs.
#include "devctl.hpp"

#include <emscripten.h>

#include <cstdio>
#include <exception>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

// Returns the id of the next queued command (> 0) and copies its line to `out`, or 0.
EM_JS(int, d2web_ctl_next_js, (char* out, int cap), {
    const c = globalThis.__d2web && globalThis.__d2web.ctl;
    if (!c || c.queue.length === 0) return 0;
    const cmd = c.queue.shift();
    stringToUTF8(cmd.line, out, cap);
    return cmd.id;
});
EM_JS(int, d2web_ctl_present_js, (), { return globalThis.__d2web && globalThis.__d2web.ctl ? 1 : 0; });
EM_JS(void, d2web_ctl_reply_js, (int id, const char* text), {
    const c = globalThis.__d2web && globalThis.__d2web.ctl;
    if (c) c.reply(id, UTF8ToString(text));
});

namespace d2d::devctl {

std::vector<std::string> tokenize(std::string_view line) {
    std::vector<std::string> out;
    std::size_t offset = 0;
    const auto blank = [&](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
    while (offset < line.size()) {
        while (offset < line.size() && blank(line[offset])) ++offset;
        const auto start = offset;
        while (offset < line.size() && !blank(line[offset])) ++offset;
        if (start < offset) out.emplace_back(line.substr(start, offset - start));
    }
    return out;
}

struct Channel::Impl {
    std::unordered_map<std::string, Handler> verbs;
    bool on = false;
};

Channel::Channel() : impl_(new Impl) {}
Channel::~Channel() { delete impl_; }

// Bound whenever the page provides a command queue (the Worker does; the node smoke test does not, so
// `--headless` without a client still ends as upstream intends: "nothing to do").
void Channel::listen(const std::string&) { impl_->on = d2web_ctl_present_js() != 0; }
void Channel::on(std::string verb, Handler handler) { impl_->verbs[std::move(verb)] = std::move(handler); }
bool Channel::active() const noexcept { return impl_->on; }
void Channel::close() { impl_->on = false; }

void Channel::pump() {
    if (!impl_->on) return;
    static char line[4096];
    while (const int id = d2web_ctl_next_js(line, int(sizeof line))) {
        const auto tok = tokenize(line);
        std::string reply;
        if (tok.empty()) {
            reply = "err empty\n";
        } else if (tok[0] == "ping") {
            reply = "ok\n";
        } else if (const auto found = impl_->verbs.find(tok[0]); found == impl_->verbs.end()) {
            reply = "err unknown verb '" + tok[0] + "'\n";
        } else {
            try { reply = found->second(tok); }
            catch (const std::exception& error) { reply = std::string("err ") + error.what() + "\n"; }
            catch (...) { reply = "err unknown exception\n"; }
            if (reply.empty() || reply.back() != '\n') reply += '\n';
        }
        d2web_ctl_reply_js(id, reply.c_str());
    }
}

}  // namespace d2d::devctl
