# SPDX-License-Identifier: GPL-3.0-or-later
# Native tests of the same C API the wasm build exports.
set(FIXTURES_DIR ${CMAKE_CURRENT_BINARY_DIR}/fixtures)

foreach(t gen_fixtures test_api test_real)
    add_executable(${t} ${t}.cpp)
    target_link_libraries(${t} PRIVATE d2core)
    target_include_directories(${t} PRIVATE ${CMAKE_CURRENT_LIST_DIR})
    target_compile_options(${t} PRIVATE -Wall -Wextra)
endforeach()

add_test(NAME gen_fixtures COMMAND gen_fixtures ${FIXTURES_DIR})
set_tests_properties(gen_fixtures PROPERTIES FIXTURES_SETUP d2core_fixtures)

add_test(NAME api COMMAND test_api ${FIXTURES_DIR})
set_tests_properties(api PROPERTIES FIXTURES_REQUIRED d2core_fixtures)

add_test(NAME real_data COMMAND test_real)
set_tests_properties(real_data PROPERTIES SKIP_RETURN_CODE 77)
