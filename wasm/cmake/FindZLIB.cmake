# SPDX-License-Identifier: GPL-3.0-or-later
# Emscripten only (CMakeLists.txt puts this directory on CMAKE_MODULE_PATH
# for it): zlib is a port (-sUSE_ZLIB=1), not a library find_package can see
# before the first build. Provides the ZLIB::ZLIB target StormLib links.
if(NOT TARGET ZLIB::ZLIB)
    add_library(ZLIB::ZLIB INTERFACE IMPORTED)
    set_target_properties(ZLIB::ZLIB PROPERTIES
        INTERFACE_COMPILE_OPTIONS "-sUSE_ZLIB=1"
        INTERFACE_LINK_OPTIONS "-sUSE_ZLIB=1")
endif()
set(ZLIB_FOUND TRUE)
set(ZLIB_LIBRARIES ZLIB::ZLIB)
