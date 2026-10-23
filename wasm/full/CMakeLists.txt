# SPDX-License-Identifier: GPL-3.0-or-later
# d2full: the whole of third_party/d2decomped apps/d2d (the game) built with
# Emscripten, from the patched copy in build-full/src (wasm/full/apply-patches.sh).
#   wasm/full/build.sh  ->  d2full.js + d2full.wasm
# SDL3 (Emscripten port) runs on the "dummy" video driver in a Worker; frames
# leave through d2web_present() (wasm/full/d2web.cpp) to our WebGPU blit.
cmake_minimum_required(VERSION 3.28)
project(d2full LANGUAGES C CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "d2full is an Emscripten-only target: use wasm/full/build.sh")
endif()

set(CMAKE_CXX_STANDARD 26)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
set(D2FULL_OPT "-O2" CACHE STRING "optimisation level for the game")
set(D2FULL_ASYNC "jspi" CACHE STRING "how the blocking frame loop yields to the browser: jspi (Chromium 137+) or asyncify (all browsers, larger and slower)")
set(D2FULL_LINK_EXTRA "" CACHE STRING "extra link flags, e.g. --profiling-funcs for readable profiles")

set(SRC "${D2FULL_SRC_DIR}" CACHE PATH "patched upstream tree (apply-patches.sh)")
if(NOT EXISTS "${SRC}/apps/d2d/main.cpp")
    message(FATAL_ERROR "run wasm/full/apply-patches.sh first (no ${SRC}/apps/d2d/main.cpp)")
endif()
set(SHIM "${CMAKE_CURRENT_LIST_DIR}/shim")

list(PREPEND CMAKE_MODULE_PATH ${CMAKE_CURRENT_LIST_DIR}/../cmake)
add_compile_options(-fwasm-exceptions)
add_link_options(-fwasm-exceptions)

# --- StormLib (same tag/options as wasm/CMakeLists.txt) ---------------------
include(FetchContent)
FetchContent_Declare(stormlib
    GIT_REPOSITORY https://github.com/ladislav-zezula/StormLib.git
    GIT_TAG        v9.30
    GIT_SHALLOW    TRUE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(STORM_USE_BUNDLED_LIBRARIES OFF CACHE BOOL "" FORCE)
set(STORM_SKIP_INSTALL ON CACHE BOOL "" FORCE)
set(STORM_BUILD_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(stormlib)
target_compile_options(storm PRIVATE -w -O3)

# --- generated headers (upstream's apps/d2d/CMakeLists.txt makes these) -----
set(GEN "${CMAKE_BINARY_DIR}/gen")
set(icon_bmp "${CMAKE_CURRENT_LIST_DIR}/../../third_party/d2decomped/assets/icon/d2d.bmp")
file(READ "${icon_bmp}" icon_hex HEX)
string(REGEX REPLACE "(..)" "0x\\1," icon_bytes "${icon_hex}")
file(CONFIGURE OUTPUT "${GEN}/d2d_icon.hpp" CONTENT
    "#pragma once\ninline constexpr unsigned char kIconBmp[] = {${icon_bytes}};\n")
file(CONFIGURE OUTPUT "${GEN}/build_info.hpp" CONTENT
    "#pragma once\nnamespace d2d::build {\ninline constexpr auto kVersion = \"web\";\ninline constexpr auto kGitHash = \"web\";\ninline constexpr auto kGitBranch = \"web\";\ninline constexpr auto kGitTag = \"null\";\ninline constexpr auto kDate = \"web\";\n}\n")

# --- sources ----------------------------------------------------------------
file(GLOB D2D_APP_SRC "${SRC}/apps/d2d/*.cpp")
file(GLOB GAME_SRC "${SRC}/components/game/*.cpp")
set(COMP_SRC
    ${SRC}/components/devctl/devctl.cpp
    ${SRC}/components/install/install.cpp
    ${SRC}/components/screenshot/screenshot.cpp
    ${SRC}/components/net/join.cpp ${SRC}/components/net/tcp.cpp ${SRC}/components/net/net_log.cpp
    ${SRC}/components/net/d2gs/exe_tables.cpp ${SRC}/components/net/d2gs/frame.cpp
    ${SRC}/components/net/d2gs/huffman.cpp ${SRC}/components/net/d2gs/split.cpp)

add_executable(d2full ${D2D_APP_SRC} ${GAME_SRC} ${COMP_SRC} d2web.cpp)
set_target_properties(d2full PROPERTIES OUTPUT_NAME d2full SUFFIX ".js")

file(GLOB COMP_DIRS LIST_DIRECTORIES true "${SRC}/components/*")
set(INCS "")
foreach(d IN LISTS COMP_DIRS)
    if(IS_DIRECTORY "${d}")
        list(APPEND INCS "${d}")
    endif()
endforeach()
target_include_directories(d2full PRIVATE
    ${SHIM} ${GEN} ${SRC}/apps/d2d ${INCS}
    ${stormlib_SOURCE_DIR}/src)
target_compile_definitions(d2full PRIVATE "D2D_APP_VERSION=\"web\"" D2WEB=1)
# Upstream builds with -Wall -Wextra -Werror on its own compiler; here the
# sources are fixed, so warnings stay quiet.
target_compile_options(d2full PRIVATE ${D2FULL_OPT} -w
    "SHELL:-include ${SRC}/cmake/no_near_far.hpp")
target_compile_options(d2full PRIVATE --use-port=sdl3 -sUSE_ZLIB=1 -sUSE_BZIP2=1)

target_link_libraries(d2full PRIVATE storm)
target_link_options(d2full PRIVATE
    ${D2FULL_OPT}
    --use-port=sdl3 -sUSE_ZLIB=1 -sUSE_BZIP2=1
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createD2Full
    -sENVIRONMENT=worker,node
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=2GB
    -sSTACK_SIZE=5MB
    -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=1
    -lworkerfs.js -lnodefs.js -lidbfs.js
    -sEXPORTED_FUNCTIONS=_main,_d2web_heap_bytes
    -sEXPORTED_RUNTIME_METHODS=ENV,FS,NODEFS,WORKERFS,IDBFS,HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8,ccall,callMain
    -sINVOKE_RUN=0
    $<IF:$<STREQUAL:${D2FULL_ASYNC},jspi>,-sJSPI=1,-sASYNCIFY=1>
    -sASSERTIONS=1
    ${D2FULL_LINK_EXTRA})
