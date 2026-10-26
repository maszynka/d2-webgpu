# SPDX-License-Identifier: GPL-3.0-or-later
# Emscripten only: the bzip2 port (-sUSE_BZIP2=1), see FindZLIB.cmake.
if(NOT TARGET BZip2::BZip2)
    add_library(BZip2::BZip2 INTERFACE IMPORTED)
    set_target_properties(BZip2::BZip2 PROPERTIES
        INTERFACE_COMPILE_OPTIONS "-sUSE_BZIP2=1"
        INTERFACE_LINK_OPTIONS "-sUSE_BZIP2=1")
endif()
set(BZIP2_FOUND TRUE)
set(BZIP2_LIBRARIES BZip2::BZip2)
