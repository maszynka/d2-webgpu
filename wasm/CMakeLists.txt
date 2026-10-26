# SPDX-License-Identifier: GPL-3.0-or-later
# d2core: the format parsers of third_party/d2decomped behind a thin C API.
#   emcmake cmake -S wasm -B build-wasm  ->  d2core.js + d2core.wasm
#   cmake -S wasm -B build-native        ->  libd2core.a + ctest tests
# (wasm/build.sh and wasm/test.sh do both.)
cmake_minimum_required(VERSION 3.28)
project(d2core VERSION 0.1.0 LANGUAGES C CXX)

# C++26 like upstream where the compiler has it (emcc's clang takes
# -std=c++2c); CMake's AppleClang doesn't know 26 yet, so native uses 23
# (upstream allows it). Override with -DCMAKE_CXX_STANDARD=...
if(EMSCRIPTEN)
    set(CMAKE_CXX_STANDARD 26 CACHE STRING "C++ standard")
else()
    set(CMAKE_CXX_STANDARD 23 CACHE STRING "C++ standard")
endif()
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(D2DECOMPED_DIR "${CMAKE_CURRENT_LIST_DIR}/../third_party/d2decomped" CACHE PATH "d2decomped checkout (read-only)")
set(D2D_COMPONENTS ${D2DECOMPED_DIR}/components)
if(NOT EXISTS ${D2D_COMPONENTS}/dc6/dc6.hpp)
    message(FATAL_ERROR "d2decomped submodule missing: git submodule update --init")
endif()

if(EMSCRIPTEN)
    # zlib/bzip2 come from Emscripten ports.
    list(PREPEND CMAKE_MODULE_PATH ${CMAKE_CURRENT_LIST_DIR}/cmake)
    # Upstream parsers throw: native wasm exceptions (no JS glue, fast).
    add_compile_options(-fwasm-exceptions)
    add_link_options(-fwasm-exceptions)
endif()

# --- StormLib (same tag as upstream's components/mpq) ---------------------
# System zlib/bzip2 natively, ports under Emscripten (never StormLib's copies).
# Archives are opened read-only with the flat stream provider; the mapped
# provider (the only mmap user in StormLib) is never requested.
include(FetchContent)
FetchContent_Declare(
    stormlib
    GIT_REPOSITORY https://github.com/ladislav-zezula/StormLib.git
    GIT_TAG        v9.30
    GIT_SHALLOW    TRUE
)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(STORM_USE_BUNDLED_LIBRARIES OFF CACHE BOOL "" FORCE)
set(STORM_SKIP_INSTALL ON CACHE BOOL "" FORCE)
set(STORM_BUILD_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(stormlib)
target_compile_options(storm PRIVATE -w -fno-strict-aliasing)   # see wasm/full/CMakeLists.txt: ADPCM/Huffman miscompile under strict aliasing
if(EMSCRIPTEN)
    target_compile_options(storm PRIVATE -O3)
endif()

# --- the API ----------------------------------------------------------------
add_library(d2core_obj OBJECT
    api/d2core.cpp
    api/formats.cpp)
target_include_directories(d2core_obj
    PUBLIC  ${CMAKE_CURRENT_LIST_DIR}/api
    PRIVATE
            ${D2D_COMPONENTS}/palette ${D2D_COMPONENTS}/dc6 ${D2D_COMPONENTS}/dt1
            ${D2D_COMPONENTS}/ds1 ${D2D_COMPONENTS}/mpq)
target_link_libraries(d2core_obj PUBLIC storm)
target_compile_options(d2core_obj PRIVATE -Wall -Wextra -Wpedantic)
target_compile_definitions(d2core_obj PRIVATE D2CORE_VERSION="${PROJECT_VERSION}")

if(EMSCRIPTEN)
    add_executable(d2core $<TARGET_OBJECTS:d2core_obj>)
    target_link_libraries(d2core PRIVATE storm)
    set_target_properties(d2core PROPERTIES OUTPUT_NAME d2core SUFFIX ".js")
    target_compile_options(d2core_obj PRIVATE -O3)
    target_link_options(d2core PRIVATE
        -O3
        --no-entry
        -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createD2Core
        -sENVIRONMENT=web,worker,node
        -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sINITIAL_MEMORY=64MB
        -sSTACK_SIZE=1MB
        -sFORCE_FILESYSTEM=1
        -lworkerfs.js -lnodefs.js
        -sEXPORTED_RUNTIME_METHODS=FS,NODEFS,WORKERFS,HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8
        -sUSE_ZLIB=1 -sUSE_BZIP2=1)
else()
    add_library(d2core STATIC $<TARGET_OBJECTS:d2core_obj>)
    target_link_libraries(d2core PUBLIC d2core_obj)
    include(CTest)
    if(BUILD_TESTING)
        add_subdirectory(tests)
    endif()
endif()
