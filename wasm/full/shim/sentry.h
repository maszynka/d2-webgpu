// SPDX-License-Identifier: GPL-3.0-or-later
// Inert Sentry stand-in for the browser build (wasm/full): no crash reporting.
// sentry_is_enabled() is always 0, so the frame-capture thread is never made.
#pragma once
#include <cstddef>
#include <cstdint>

struct sentry_value_t { int unused = 0; };
struct sentry_options_t { int unused = 0; };
struct sentry_uuid_t { std::uint8_t bytes[16] = {}; };

inline sentry_value_t sentry_value_new_breadcrumb(const char*, const char*) { return {}; }
inline sentry_value_t sentry_value_new_string(const char*) { return {}; }
inline sentry_value_t sentry_value_new_string_n(const char*, std::size_t) { return {}; }
inline sentry_value_t sentry_value_new_object() { return {}; }
inline sentry_value_t sentry_value_new_int32(std::int32_t) { return {}; }
inline int sentry_value_set_by_key(sentry_value_t, const char*, sentry_value_t) { return 0; }
inline bool sentry_value_is_null(sentry_value_t) { return true; }
inline void sentry_add_breadcrumb(sentry_value_t) {}
inline sentry_options_t* sentry_options_new() { return nullptr; }
inline void sentry_options_set_dsn(sentry_options_t*, const char*) {}
inline void sentry_options_set_release(sentry_options_t*, const char*) {}
inline void sentry_options_set_auto_session_tracking(sentry_options_t*, int) {}
inline void sentry_options_set_database_path(sentry_options_t*, const char*) {}
inline void sentry_options_set_handler_path(sentry_options_t*, const char*) {}
inline void sentry_options_set_debug(sentry_options_t*, int) {}
inline int sentry_init(sentry_options_t*) { return 1; }
inline void sentry_close() {}
inline int sentry_is_enabled() { return 0; }
inline void sentry_set_context(const char*, sentry_value_t) {}
inline void sentry_set_extra(const char*, sentry_value_t) {}
inline void sentry_set_tag(const char*, const char*) {}
inline void sentry_crash() {}
inline bool sentry_uuid_is_nil(const sentry_uuid_t*) { return true; }
inline void sentry_remove_attachment(sentry_uuid_t) {}
inline sentry_value_t sentry_attachment_from_bytes(const char*, std::size_t, const char*) { return {}; }
inline void sentry_attachment_set_content_type(sentry_value_t, const char*) {}
inline sentry_uuid_t sentry_add_attachment(sentry_value_t) { return {}; }
