cmake_minimum_required(VERSION 3.25)
project({{cident}} VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_library({{cident}}_lib src/greeting.cpp)
target_include_directories({{cident}}_lib PUBLIC src)

add_executable({{cident}} src/main.cpp)
target_link_libraries({{cident}} PRIVATE {{cident}}_lib)

enable_testing()
add_executable({{cident}}_tests tests/test_greeting.cpp)
target_link_libraries({{cident}}_tests PRIVATE {{cident}}_lib)
add_test(NAME {{cident}}_tests COMMAND {{cident}}_tests)
